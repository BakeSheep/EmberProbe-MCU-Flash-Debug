"use strict";

const { SYSTEM_CLOCK } = require("../samplingClock");
const { connectionIdentity, normalizeAdapterSpeed } = require("../../skills/_emberprobe/probe-connection");

// ELF, CubeMX discovery and display/sampling frequency do not change SVD register addressing.
function peripheralConfigurationKey(config, workspace, selected) {
    return [
        workspace,
        {
            ...connectionIdentity({ ...config, probeSerial: "" }),
            // Status stays inspectable for invalid settings; connection preflight validates the serial.
            probeSerial: String(config.probeSerial || ""),
            svd: config.svd || "",
            samplingAdapterSpeedKhz: normalizeAdapterSpeed(config.samplingAdapterSpeedKhz),
            tclPort: config.tclPort
        },
        selected?.source === "user"
            ? {
                  probe: selected.probe,
                  probeSerial: selected.probeSerial,
                  deviceId: selected.deviceId,
                  profile: selected.profile
              }
            : null
    ];
}

function failure(code, message) {
    return Object.assign(new Error(message), { code, retryable: false });
}

// Owns a complete SVD transaction, including the final original-value check and readback.
// Connection creation/cleanup remains with the existing probe owner.
class PeripheralAccessService {
    constructor(options) {
        this.clock = { ...SYSTEM_CLOCK, ...options.clock };
        this.debugBridge = options.debugBridge;
        this.configurationKey = options.configurationKey;
        this.supportsRunning = options.supportsRunning;
        this.assertCurrent = options.assertCurrent;
        this.connectionIdentity = options.connectionIdentity;
        this.withProbe = options.withProbe;
        this.quiescePaused = options.quiescePaused || (async () => {});
        this.generation = 0;
        this.pending = 0;
    }

    status() {
        const debug = this.debugBridge.agentStatus();
        const key = JSON.stringify([this.configurationKey(), debug.state, debug.epoch, debug.session?.id]);
        if (key !== this.key) {
            this.key = key;
            this.generation++;
        }
        const paused = debug.state === "paused";
        const standalone = debug.state === "none";
        const supported = paused || standalone || (debug.state === "running" && this.supportsRunning());
        const busy =
            this.debugBridge.replBusy ||
            this.debugBridge.transitionKind ||
            this.debugBridge.controlInFlight ||
            this.debugBridge.writing;
        return {
            state: debug.state,
            epoch: debug.epoch,
            mode: standalone ? "standalone" : paused ? "debug-paused" : "debug-running",
            generation: this.generation,
            canRead: !!(supported && !busy && (!paused || debug.capabilities?.read)),
            canWrite: !!(supported && !busy && (!paused || debug.capabilities?.write)),
            reason: busy ? "DEBUG_CONTROL_BUSY" : supported ? "" : "PERIPHERAL_ACCESS_UNSUPPORTED"
        };
    }

    withAccess(handler, write = false, expectedGeneration = this.status().generation) {
        if (this.pending >= 64)
            return Promise.reject(failure("PERIPHERAL_ACCESS_BUSY", "Too many pending peripheral operations"));
        const initial = this.status();
        if (initial.generation !== expectedGeneration)
            return Promise.reject(failure("DEBUG_STATE_CHANGED", "Peripheral request target changed"));
        this.pending++;
        const result = (this.queue || Promise.resolve()).then(async () => {
            const bridge = this.debugBridge;
            const guard = () => {
                const current = this.status();
                if (initial.generation !== current.generation)
                    throw failure("DEBUG_STATE_CHANGED", "Peripheral access target or state changed");
                if (!(write ? current.canWrite : current.canRead))
                    throw failure(
                        current.reason || "PERIPHERAL_ACCESS_UNSUPPORTED",
                        "Peripheral access is unavailable for the current target"
                    );
            };
            guard();
            if (bridge.peripheralBusy) throw failure("DEBUG_CONTROL_BUSY", "Peripheral access is already in progress");
            bridge.peripheralBusy = true;
            let completed;
            try {
                const deadline = this.clock.now() + 2000;
                while (bridge.polling && this.clock.now() < deadline)
                    await new Promise((resolve) => this.clock.schedule(resolve, 5));
                guard();
                if (bridge.polling) throw failure("DEBUG_CONTROL_BUSY", "A debug snapshot is still in progress");
                const invoke = async (physical, source) => {
                    const check = () => {
                        guard();
                        this.assertCurrent(physical, write);
                    };
                    check();
                    const connection = write ? this.connectionIdentity(physical) : null;
                    const access = { mode: initial.mode, generation: initial.generation, source };
                    const transport = {
                        access,
                        connection,
                        live: initial.mode !== "debug-paused",
                        guard: check,
                        read: async (address, count, width, endian) => {
                            check();
                            let bytes;
                            if (!transport.live) bytes = await bridge.readPausedMemory(address, count);
                            else {
                                if (![1, 2, 4].includes(width) || count % width !== 0)
                                    throw failure(
                                        "PERIPHERAL_ACCESS_UNSUPPORTED",
                                        "Running peripheral access requires aligned 8/16/32-bit registers"
                                    );
                                const reads = Array.from({ length: count / width }, (_, index) => ({
                                    address: address + index * width,
                                    size: width
                                }));
                                const result = await physical.peripheralTransaction({ reads, endian });
                                bytes = Uint8Array.from(result.reads.flat());
                            }
                            check();
                            return bytes;
                        },
                        write: async (address, bytes, expected, endian) => {
                            check();
                            let result;
                            let acknowledged = false;
                            try {
                                if (!transport.live) {
                                    const before = await bridge.readPausedMemory(address, bytes.length);
                                    check();
                                    if (Buffer.compare(Buffer.from(before), Buffer.from(expected)) !== 0)
                                        throw failure(
                                            "PERIPHERAL_VALUE_CHANGED",
                                            "Peripheral register changed before writing"
                                        );
                                    await bridge.writePausedMemory(address, bytes);
                                    acknowledged = true;
                                    check();
                                    result = {
                                        readBack: Array.from(await bridge.readPausedMemory(address, bytes.length))
                                    };
                                } else {
                                    const response = await physical.peripheralTransaction({
                                        writes: [
                                            {
                                                address,
                                                size: bytes.length,
                                                bytes: Array.from(bytes),
                                                expected: Array.from(expected)
                                            }
                                        ],
                                        endian
                                    });
                                    acknowledged = true;
                                    result = response.writes[0];
                                }
                                check();
                                return result;
                            } catch (error) {
                                if (acknowledged)
                                    error.details = { ...error.details, writeAcknowledged: true, resultUnknown: false };
                                throw error;
                            }
                        }
                    };
                    const result = await handler(transport);
                    completed = result;
                    check();
                    return { ...result, access };
                };
                if (initial.mode === "debug-paused") {
                    await this.quiescePaused();
                    guard();
                    return await invoke(bridge, "dap");
                }
                return await this.withProbe(({ session, source }) => invoke(session, source));
            } catch (error) {
                if (write && completed?.results)
                    error.details = {
                        ...error.details,
                        completed: completed.results,
                        writeAcknowledged: true,
                        resultUnknown: false
                    };
                throw error;
            } finally {
                bridge.peripheralBusy = false;
                if (bridge.snapshotPending || bridge.refreshAfterWrite) bridge.refreshSnapshot?.();
            }
        });
        this.queue = result.catch(() => {});
        return result.finally(() => {
            this.pending--;
        });
    }
}

module.exports = { PeripheralAccessService, peripheralConfigurationKey };
