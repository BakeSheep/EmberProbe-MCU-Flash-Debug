"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { ManagedOpenOcdSession } = require("./liveWatch");
const { serializeError } = require("./services/errorEnvelope");
const { MAX_COMPOSITE_DEPTH, MAX_COMPOSITE_NODES, MAX_COMPOSITE_BYTES } = require("./dwarf/layoutLimits");

const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;
const SOFT_BACKLOG_BYTES = 1024 * 1024;
const SOFT_BACKLOG_BATCHES = 8;

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

// The socket, command queue, sampling clock and write exclusion all have one owner.
function run(port, options, makeSession = (config, handlers) => new ManagedOpenOcdSession(null, config, handlers)) {
    let generation = 0,
        waiting = false,
        queued = [],
        queuedBytes = 0;
    let cpuWaiting = false,
        cpuLatest = null,
        cpuSentAt = 0;
    const state = () => ({
        generation,
        samplingEnabled: session.samplingEnabled,
        cpuLoadEnabled: !!session.cpuLoad?.plan,
        pollingFailed: !!session._pollFailureLocked,
        stopped: session.stopped,
        childPid: session.child?.pid,
        stats: typeof session.stats === "function" ? session.stats() : null
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
                queuedBytes += samples.reduce(
                    (n, s) =>
                        n +
                        (s.bytes?.length || 0) +
                        s.name.length * 2 +
                        64 +
                        (s.runtimeTree ? estimateRuntimeBytes(s.runtimeTree) : 0) +
                        (s.diagnostic ? estimateRuntimeBytes(s.diagnostic) : 0),
                    0
                );
                queued.push({
                    samples,
                    t,
                    generation,
                    consumers: consumers && { graphNames: consumers.graphNames, sidebarNames: consumers.sidebarNames }
                });
                if (queuedBytes > MAX_BACKLOG_BYTES || queued.length > 4096) {
                    session.setSamplingEnabled(false);
                    event("onError", [
                        "Sampling paused: extension host is not consuming samples; restart sampling after the busy operation."
                    ]);
                }
                updateHostHold();
                flush();
            },
            onStatus: (...args) => event("onStatus", args),
            onCpuLoad: (result) => {
                cpuLatest = result;
                session.cpuDeliveryBlocked = cpuWaiting && Date.now() - cpuSentAt > 2000;
                flushCpu();
            },
            onConnectionConfirmed: () => event("onConnectionConfirmed", []),
            onTargetIdentity: (...args) => event("onTargetIdentity", args),
            onError: (...args) => event("onError", args),
            onDegraded: (...args) => event("onDegraded", args),
            onDisconnect: (...args) => event("onDisconnect", args)
        }
    );
    function updateHostHold() {
        session.setHostHold?.(
            session.unlimitedActive && (queued.length >= SOFT_BACKLOG_BATCHES || queuedBytes >= SOFT_BACKLOG_BYTES)
        );
    }
    function flush() {
        if (waiting || !queued.length) return;
        waiting = true;
        port.postMessage({ event: "samples", batch: queued, state: state() });
        queued = [];
        queuedBytes = 0;
        updateHostHold();
    }
    function flushCpu() {
        if (cpuWaiting || !cpuLatest) return;
        cpuWaiting = true;
        cpuSentAt = Date.now();
        event("onCpuLoad", [cpuLatest]);
        cpuLatest = null;
    }
    port.on("message", async (message) => {
        if (message.cpuAck) {
            cpuWaiting = false;
            session.cpuDeliveryBlocked = false;
            flushCpu();
            return;
        }
        if (message.ack) {
            waiting = false;
            flush();
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
                    "invalidateTarget",
                    "readOnce",
                    "writeAndVerify",
                    "waitForIdle",
                    "waitForExit",
                    "stats",
                    "setCpuLoadPlan",
                    "setCpuLoadPaused",
                    "selectCpuIdleTask"
                ].includes(method)
            )
                throw new Error("Unknown sampling operation");
            if (["setSamplingEnabled", "setSamplingPlan"].includes(method)) generation = message.generation;
            // setSamplingPlan changes the host generation, so its queued old-generation batches are stale.
            // setWatch keeps the generation: retain its queued batches until the host acknowledges them.
            if (session.unlimitedActive && ["stop", "setSamplingPlan"].includes(method)) {
                queued = [];
                queuedBytes = 0;
                session.setHostHold?.(false);
            }
            const result = await session[method](...args);
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
        queued = [];
        queuedBytes = 0;
        session.setHostHold?.(false);
        session.stop();
    });
}
if (!isMainThread && require.main === module) run(parentPort, workerData);
module.exports = { run, estimateRuntimeBytes };
