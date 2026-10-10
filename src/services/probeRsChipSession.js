"use strict";

const { ProbeRsDebugAdapter } = require("./probeRsDebugAdapter");

// A borrowed chipInfo lease covers the entire operation, including CLI reads.
// DAP is used only on an already halted core or for an explicit execution action.
async function withProbeRsChipSession(settings, options, operation) {
    const lease = options.lease;
    if (!lease || lease.released || lease.operation !== "chipInfo")
        throw Object.assign(new Error("A chip information probe lease is required"), { code: "STALE_PROBE_LEASE" });
    const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? 15000);
    const pending = new Map();
    let sequence = 0;
    let cleanupFailed = false;
    let failure = null;
    let operationError = null;
    let closing = false;
    let result;
    const fail = (error) => {
        failure = error;
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    const adapter = new ProbeRsDebugAdapter({
        coordinator: { acquire: () => ({ operation: "chipInfo", release() {} }) },
        executable: settings.executable,
        cwd: settings.cwd,
        spawnProcess: options.spawnProcess,
        startupTimeoutMs: Math.max(1, deadline - Date.now()),
        exitTimeoutMs: options.exitTimeoutMs ?? 2000,
        emitter: {
            event() {},
            dispose() {},
            fire(message) {
                if (message.type !== "response") return;
                const request = pending.get(message.request_seq);
                if (!request) return;
                pending.delete(message.request_seq);
                if (message.success) request.resolve(message.body || {});
                else request.reject(new Error(message.message || `probe-rs ${message.command} failed`));
            }
        },
        onError: fail,
        onExit() {
            if (!closing || pending.size) fail(new Error("probe-rs chip session exited"));
            if (cleanupFailed) lease.release();
        }
    });
    const session = {
        async customRequest(command, args) {
            options.assertCurrent?.();
            if (lease.released)
                throw Object.assign(new Error("Chip information lease expired"), { code: "STALE_PROBE_LEASE" });
            if (failure) throw failure;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw Object.assign(new Error("Chip information read timed out"), { code: "CHIP_READ_TIMEOUT" });
            const seq = ++sequence;
            let timer;
            try {
                const response = await new Promise((resolve, reject) => {
                    pending.set(seq, { resolve, reject });
                    timer = setTimeout(
                        () =>
                            reject(
                                Object.assign(new Error(`probe-rs ${command} timed out`), { code: "CHIP_READ_TIMEOUT" })
                            ),
                        remaining
                    );
                    adapter.handleMessage({ type: "request", seq, command, arguments: args });
                });
                options.assertCurrent?.();
                return response;
            } finally {
                clearTimeout(timer);
                pending.delete(seq);
            }
        }
    };
    try {
        adapter.start();
        await session.customRequest("initialize", {
            clientID: "emberprobe-chip-info",
            adapterID: "probe-rs",
            pathFormat: "path",
            linesStartAt1: true,
            columnsStartAt1: true,
            supportsMemoryReferences: true
        });
        await session.customRequest("attach", {
            chip: settings.chip,
            probe: settings.probe || undefined,
            speed: settings.speed || undefined,
            wireProtocol: String(settings.protocol || "SWD").toLowerCase() === "jtag" ? "Jtag" : "Swd",
            flashingConfig: { flashingEnabled: false },
            coreConfigs: [{ coreIndex: 0, rttEnabled: false, catchReset: false, catchHardfault: false }]
        });
        result = await operation(session);
    } catch (error) {
        operationError = error;
    } finally {
        closing = true;
        if (!adapter.exited && !failure) {
            try {
                await session.customRequest("disconnect", { suspendDebuggee: false, terminateDebuggee: false });
            } catch (error) {
                failure = error;
            }
        }
        cleanupFailed = !(await adapter.stop(true));
        if (cleanupFailed)
            operationError = Object.assign(
                new Error("probe-rs process exit has not been confirmed; probe lease retained"),
                {
                    code: "PROBE_EXIT_UNCONFIRMED"
                }
            );
        if (failure && !operationError) operationError = failure;
    }
    if (operationError) throw operationError;
    return result;
}

module.exports = { withProbeRsChipSession };
