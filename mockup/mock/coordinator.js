/* Shared, hardware-free probe and debug state for every demo entry point. */
(function (root) {
    "use strict";

    function create(options) {
        var simulator = options.simulator;
        var listeners = new Set();
        var intents = new Set();
        var operation = null;
        var debug = "none";
        var target = "running";
        var epoch = 1;
        var line = 103;
        var lastTick = -Infinity;

        function snapshot() {
            return { operation: operation, debug: debug, target: target, epoch: epoch, line: line };
        }

        function publish() {
            listeners.forEach(function (listener) {
                listener(snapshot());
            });
        }

        function allowed(name) {
            if (operation || debug !== "none") return false;
            if (name === "cpuLoad" && target !== "running") return false;
            return ["download", "debugStart"].includes(name) || !intents.size;
        }

        function blockedKey(name) {
            if (operation === "cpuLoad") return "cpu.busy";
            if (operation === "download") return "live.downloadRunning";
            if (operation === "chipInfo") return "live.chipReading";
            if (name === "cpuLoad" && target !== "running") return "cpu.state.paused";
            if (debug !== "none") return name === "download" ? "msg.debugBusyForDownload" : "chip.busyDebug";
            return intents.size ? "chip.busyLive" : "cpu.probeBusy";
        }

        function acquire(name) {
            if (!allowed(name)) return false;
            operation = name;
            if (name === "debugStart") debug = "starting";
            epoch += 1;
            publish();
            return true;
        }

        function release(name) {
            if (operation !== name) return;
            operation = null;
            if (debug === "starting") debug = "none";
            epoch += 1;
            publish();
        }

        function liveStatus(consumer, hz) {
            var intent = intents.has(consumer);
            var readable = intent && !operation;
            var paused = debug === "paused";
            var source = paused ? "dap" : readable ? "openocd" : "none";
            var key = operation
                ? blockedKey("sampling")
                : readable
                  ? paused
                      ? "live.dapReady"
                      : debug === "running"
                        ? "live.debugRuntimeSampling"
                        : "sb.sampling"
                  : "sb.stopped";
            return {
                type: "liveStatus",
                running: intent,
                intentEnabled: intent,
                canRead: readable,
                canWrite: readable && debug !== "running",
                snapshotReady: readable,
                source: source,
                mode: operation
                    ? "standalone-pending"
                    : paused
                      ? "debug-paused-ready"
                      : debug === "running"
                        ? "debug-running-sampling"
                        : readable
                          ? "standalone-sampling"
                          : "stopped",
                key: key,
                actualHz: readable ? hz : 0,
                frequencyHz: hz,
                effectiveIntervalMs: Math.round(1000 / hz)
            };
        }

        function setTarget(next, settings) {
            if (!["running", "halted"].includes(next) || operation) return false;
            settings = settings || {};
            target = next;
            if (settings.reset && typeof simulator.reset === "function") simulator.reset();
            if (debug === "paused" || debug === "running") debug = next === "halted" ? "paused" : "running";
            if (Number.isInteger(settings.line)) line = settings.line;
            epoch += 1;
            publish();
            return true;
        }

        return {
            snapshot: snapshot,
            allowed: allowed,
            blockedKey: blockedKey,
            acquire: acquire,
            release: release,
            liveStatus: liveStatus,
            subscribe: function (listener) {
                listeners.add(listener);
                return function () {
                    listeners.delete(listener);
                };
            },
            setIntent: function (consumer, enabled) {
                if (enabled && operation && !intents.has(consumer)) return false;
                if (enabled) intents.add(consumer);
                else intents.delete(consumer);
                publish();
                return true;
            },
            intent: function (consumer) {
                return intents.has(consumer);
            },
            setTarget: setTarget,
            setOperationTarget: function (owner, next) {
                if (operation !== owner || !["running", "halted"].includes(next) || target === next) return false;
                target = next;
                epoch += 1;
                publish();
                return true;
            },
            completeDebug: function () {
                if (operation !== "debugStart") return false;
                operation = null;
                debug = "paused";
                target = "halted";
                epoch += 1;
                publish();
                return true;
            },
            completeDownload: function () {
                if (operation !== "download") return false;
                if (typeof simulator.reset === "function") simulator.reset();
                target = "running";
                operation = null;
                epoch += 1;
                publish();
                return true;
            },
            stopDebug: function () {
                if (debug === "none") return;
                if (operation === "debugStart") operation = null;
                debug = "none";
                target = "running";
                epoch += 1;
                publish();
            },
            tick: function () {
                var now = Date.now();
                if (!operation && target === "running" && now - lastTick >= 16) {
                    simulator.tick();
                    lastTick = now;
                }
            }
        };
    }

    root.EmberProbeMockCoordinator = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
