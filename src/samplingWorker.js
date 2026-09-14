"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { ManagedOpenOcdSession } = require("./liveWatch");

// The socket, command queue, sampling clock and write exclusion all have one owner.
function run(port, options, makeSession = (config, handlers) => new ManagedOpenOcdSession(null, config, handlers)) {
    let generation = 0,
        waiting = false,
        queued = [],
        queuedBytes = 0;
    const state = () => ({
        generation,
        samplingEnabled: session.samplingEnabled,
        stopped: session.stopped,
        childPid: session.child?.pid
    });
    const event = (name, args) => port.postMessage({ event: name, args, state: state() });
    const session = makeSession(
        { ...options, isolated: false },
        {
            onSample(samples, t) {
                queuedBytes += samples.reduce((n, s) => n + (s.bytes?.length || 0) + s.name.length * 2 + 64, 0);
                queued.push({ samples, t, generation });
                if (queuedBytes > 16 * 1024 * 1024 || queued.length > 4096) {
                    session.setSamplingEnabled(false);
                    event("onError", [
                        "Sampling paused: extension host is not consuming samples; restart sampling after the busy operation."
                    ]);
                }
                flush();
            },
            onStatus: (...args) => event("onStatus", args),
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
    port.on("message", async (message) => {
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
                    "setIntervalMs",
                    "setSamplingEnabled",
                    "readOnce",
                    "writeOnce",
                    "writeAndVerify",
                    "waitForIdle",
                    "waitForExit"
                ].includes(method)
            )
                throw new Error("Unknown sampling operation");
            if (method === "setSamplingEnabled") generation = message.generation;
            const result = await session[method](...args);
            port.postMessage({ id, result, state: state() });
        } catch (error) {
            port.postMessage({
                id,
                error: { message: error.message, code: error.code, details: error.details },
                state: state()
            });
        }
    });
    port.on("close", () => session.stop());
}
if (!isMainThread && require.main === module) run(parentPort, workerData);
module.exports = { run };
