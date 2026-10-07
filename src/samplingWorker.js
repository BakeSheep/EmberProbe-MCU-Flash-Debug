"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { ManagedOpenOcdSession } = require("./liveWatch");
const { serializeError } = require("./services/errorEnvelope");

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
                        (s.runtimeTree ? Buffer.byteLength(JSON.stringify(s.runtimeTree)) : 0) +
                        (s.diagnostic ? Buffer.byteLength(JSON.stringify(s.diagnostic)) : 0),
                    0
                );
                queued.push({
                    samples,
                    t,
                    generation,
                    consumers: consumers && { graphNames: consumers.graphNames, sidebarNames: consumers.sidebarNames }
                });
                if (queuedBytes > 16 * 1024 * 1024 || queued.length > 4096) {
                    session.setSamplingEnabled(false);
                    event("onError", [
                        "Sampling paused: extension host is not consuming samples; restart sampling after the busy operation."
                    ]);
                }
                flush();
            },
            onStatus: (...args) => event("onStatus", args),
            onCpuLoad: (result) => {
                cpuLatest = result;
                session.cpuDeliveryBlocked = cpuWaiting && Date.now() - cpuSentAt > 2000;
                flushCpu();
            },
            onConnectionConfirmed: () => event("onConnectionConfirmed", []),
            onError: (...args) => event("onError", args),
            onDegraded: (...args) => event("onDegraded", args),
            onDisconnect: (...args) => event("onDisconnect", args)
        }
    );
    function flush() {
        if (waiting || !queued.length) return;
        waiting = true;
        port.postMessage({ event: "samples", batch: queued, state: state() });
        queued = [];
        queuedBytes = 0;
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
                    "readOnce",
                    "writeOnce",
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
            const result = await session[method](...args);
            port.postMessage({ id, result, state: state() });
        } catch (error) {
            port.postMessage({
                id,
                error: serializeError(error),
                state: state()
            });
        }
    });
    port.on("close", () => session.stop());
}
if (!isMainThread && require.main === module) run(parentPort, workerData);
module.exports = { run };
