"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { performance } = require("perf_hooks");
const { ManagedOpenOcdSession } = require("./liveWatch");
const { serializeError } = require("./services/errorEnvelope");
const { MAX_COMPOSITE_DEPTH, MAX_COMPOSITE_NODES, MAX_COMPOSITE_BYTES } = require("./dwarf/layoutLimits");

// Undelivered samples are bounded by bytes, batch count and age; beyond any of them the oldest are dropped.
const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;
const MAX_BACKLOG_BATCHES = 4096;
const MAX_BACKLOG_AGE_MS = 30000;
// Unlimited sampling follows the host: new reads wait once the backlog is this large or this old.
const SOFT_BACKLOG_BYTES = 1024 * 1024;
const SOFT_BACKLOG_BATCHES = 1024;
const HOST_HOLD_AGE_MS = 100;
// One host message carries a bounded chunk, so draining a long backlog never blocks the host for long.
const CHUNK_BATCHES = 256;
const CHUNK_BYTES = 256 * 1024;

function estimateRuntimeBytes(value) {
    let bytes = 0;
    let visits = 0;
    const visit = (entry, depth) => {
        if (bytes > MAX_COMPOSITE_BYTES) return;
        // Member/element arrays add one container edge per runtime tree level.
        if (++visits > MAX_COMPOSITE_NODES || depth > MAX_COMPOSITE_DEPTH * 2 + 4) {
            bytes = MAX_BACKLOG_BYTES + 1;
            return;
        }
        if (typeof entry === "string") bytes += 16 + entry.length * 2;
        else if (!entry || typeof entry !== "object") bytes += 8;
        else if (Array.isArray(entry)) {
            bytes += 32 + entry.length * 8;
            for (const child of entry) {
                visit(child, depth + 1);
                if (bytes > MAX_COMPOSITE_BYTES) break;
            }
        } else {
            bytes += 32;
            for (const key in entry) {
                if (!Object.hasOwn(entry, key)) continue;
                bytes += 16 + key.length * 2;
                visit(entry[key], depth + 1);
                if (bytes > MAX_COMPOSITE_BYTES) break;
            }
        }
    };
    visit(value, 0);
    return bytes > MAX_COMPOSITE_BYTES ? MAX_BACKLOG_BYTES + 1 : bytes;
}

const sampleBytes = (sample) =>
    (sample.bytes?.length || 0) +
    sample.name.length * 2 +
    64 +
    (sample.runtimeTree ? estimateRuntimeBytes(sample.runtimeTree) : 0) +
    (sample.diagnostic ? estimateRuntimeBytes(sample.diagnostic) : 0);

// The socket, command queue, sampling clock and write exclusion all have one owner.
// Samples are acquired here and queued until the extension host acknowledges a chunk, so a busy host
// delays delivery instead of slowing the clock. Past the backlog budget the oldest batches are dropped and
// the host receives one ordered gap marker, so waveforms break instead of bridging the missing interval.
function run(
    port,
    options,
    makeSession = (config, handlers) => new ManagedOpenOcdSession(null, config, handlers),
    now = () => performance.now()
) {
    let generation = 0,
        waiting = false,
        deliveryHold = false,
        queued = [],
        queuedBytes = 0,
        gap = null,
        dropNotified = false,
        droppedBatches = 0;
    const backlogStats = () => ({
        backlogBatches: queued.length,
        backlogBytes: queuedBytes,
        backlogAgeMs: queued.length ? Math.round(now() - queued[0].queuedAt) : 0,
        droppedBatches,
        deliveryHold
    });
    const stats = () => (typeof session.stats === "function" ? { ...session.stats(), ...backlogStats() } : null);
    const state = () => ({
        generation,
        samplingEnabled: session.samplingEnabled,
        pollingFailed: !!session._pollFailureLocked,
        stopped: session.stopped,
        childPid: session.child?.pid,
        stats: stats()
    });
    const event = (name, args) =>
        port.postMessage({
            event: name,
            args: args.map((value) => (value instanceof Error ? serializeError(value) : value)),
            state: state()
        });
    const session = makeSession(
        { ...options, isolated: false },
        {
            onSample(samples, t, consumers) {
                const entry = {
                    samples,
                    t,
                    generation,
                    consumers: consumers && { graphNames: consumers.graphNames, sidebarNames: consumers.sidebarNames },
                    bytes: samples.reduce((n, sample) => n + sampleBytes(sample), 0),
                    queuedAt: now()
                };
                coalesceSidebar(entry);
                queued.push(entry);
                queuedBytes += entry.bytes;
                enforceBudget();
                flush();
                updateHostHold();
            },
            onStatus: (...args) => event("onStatus", args),
            onConnectionConfirmed: () => event("onConnectionConfirmed", []),
            onTargetIdentity: (...args) => event("onTargetIdentity", args),
            onError: (...args) => event("onError", args),
            onDegraded: (...args) => event("onDegraded", args),
            onDisconnect: (...args) => event("onDisconnect", args)
        }
    );
    const sidebarOnly = (entry) => !!entry.consumers && !entry.consumers.graphNames?.length;
    // The sidebar shows only the latest value of each variable, so a queued sidebar-only tick is replaced
    // by the next one instead of accumulating. Graph ticks are never merged: each one is a waveform point.
    function coalesceSidebar(entry) {
        if (!sidebarOnly(entry)) return;
        for (let index = queued.length - 1; index >= 0; index--) {
            const previous = queued[index];
            if (!sidebarOnly(previous) || previous.generation !== entry.generation) continue;
            queued.splice(index, 1);
            queuedBytes -= previous.bytes;
            const names = new Set(entry.samples.map((sample) => sample.name));
            const kept = previous.samples.filter((sample) => !names.has(sample.name));
            if (kept.length) {
                entry.samples = kept.concat(entry.samples);
                entry.bytes += kept.reduce((n, sample) => n + sampleBytes(sample), 0);
            }
            entry.queuedAt = previous.queuedAt;
            return;
        }
    }
    function enforceBudget() {
        const time = now();
        let dropped = 0;
        while (
            queued.length &&
            (queuedBytes > MAX_BACKLOG_BYTES ||
                queued.length > MAX_BACKLOG_BATCHES ||
                time - queued[0].queuedAt > MAX_BACKLOG_AGE_MS)
        ) {
            const oldest = queued.shift();
            queuedBytes -= oldest.bytes;
            dropped++;
            if (sidebarOnly(oldest)) continue;
            // Consecutive drops of one generation form one interval; a newer plan replaces an older marker.
            if (gap?.generation === oldest.generation) {
                gap.gap.endT = oldest.t;
                gap.gap.batches++;
            } else gap = { generation: oldest.generation, gap: { startT: oldest.t, endT: oldest.t, batches: 1 } };
        }
        if (!dropped) return;
        droppedBatches += dropped;
        if (dropNotified) return;
        dropNotified = true;
        event("onError", [
            Object.assign(
                new Error(
                    "Extension host is not consuming samples; the oldest queued samples were dropped and sampling continues."
                ),
                { code: "SAMPLING_HOST_BACKLOG" }
            )
        ]);
    }
    function updateHostHold() {
        session.setHostHold?.(
            session.unlimitedActive &&
                queued.length > 0 &&
                (queuedBytes >= SOFT_BACKLOG_BYTES ||
                    queued.length >= SOFT_BACKLOG_BATCHES ||
                    now() - queued[0].queuedAt >= HOST_HOLD_AGE_MS)
        );
    }
    function flush() {
        if (waiting || deliveryHold || (!queued.length && !gap)) return;
        const batch = [];
        if (gap) batch.push(gap);
        gap = null;
        let bytes = 0;
        while (queued.length && batch.length < CHUNK_BATCHES && (bytes < CHUNK_BYTES || !bytes)) {
            const entry = queued.shift();
            queuedBytes -= entry.bytes;
            bytes += entry.bytes;
            batch.push({
                samples: entry.samples,
                t: entry.t,
                generation: entry.generation,
                consumers: entry.consumers
            });
        }
        waiting = true;
        port.postMessage({ event: "samples", batch, state: state() });
    }
    function clearBacklog() {
        queued = [];
        queuedBytes = 0;
        gap = null;
    }
    port.on("message", async (message) => {
        if (message.ack) {
            waiting = false;
            // A drained backlog ends the busy episode; the next overflow is reported again.
            if (!queued.length) dropNotified = false;
            flush();
            updateHostHold();
            return;
        }
        const { id, method, args } = message;
        try {
            if (
                ![
                    "start",
                    "stop",
                    "setWatch",
                    "setSamplingPlan",
                    "setIntervalMs",
                    "setPauseReason",
                    "setSamplingEnabled",
                    "setDeliveryHold",
                    "invalidateTarget",
                    "readOnce",
                    "writeAndVerify",
                    "waitForIdle",
                    "waitForExit",
                    "stats"
                ].includes(method)
            )
                throw new Error("Unknown sampling operation");
            if (["setSamplingEnabled", "setSamplingPlan"].includes(method)) generation = message.generation;
            // setSamplingPlan changes the host generation, so its queued old-generation batches are stale.
            // setWatch keeps the generation: retain its queued batches until the host acknowledges them.
            if (session.unlimitedActive && ["stop", "setSamplingPlan"].includes(method)) clearBacklog();
            let result;
            if (method === "setDeliveryHold") {
                // The host pauses delivery (for example while its archive drains) without pausing acquisition.
                deliveryHold = args[0] === true;
                flush();
            } else if (method === "stats") result = stats();
            else result = await session[method](...args);
            updateHostHold();
            port.postMessage({ id, result, state: state() });
        } catch (error) {
            port.postMessage({
                id,
                error: serializeError(error),
                state: state()
            });
        }
    });
    port.on("close", () => {
        clearBacklog();
        session.setHostHold?.(false);
        session.stop();
    });
}
if (!isMainThread && require.main === module) run(parentPort, workerData);
module.exports = { run, estimateRuntimeBytes };
