"use strict";

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");
const { connectionError } = require("../../skills/_emberprobe/probe-connection");
const { classifyJlinkDriver, requireJlinkWinUsb, JLINK_PIDS } = require("../../skills/_emberprobe/jlink-driver");

function driverError(code, message, details = {}) {
    return connectionError(code, message, details);
}

function notifyObserver(observer, value) {
    try {
        Promise.resolve(observer(value)).catch(() => {});
    } catch {
        // Diagnostics and UI notifications must not change the driver operation's result.
    }
}

function runHelper(executable, action, instanceId) {
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            [action, instanceId],
            { windowsHide: true, timeout: 330000, maxBuffer: 64 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    const exitCode = Number(error.code);
                    const cancelled = exitCode === 10;
                    const rollbackFailed = exitCode === 26;
                    const resultUnknown = exitCode === 27 || error.killed || error.code === "ETIMEDOUT";
                    const explanations = {
                        4: "Windows administrator authorization is required",
                        5: "The selected J-Link is no longer connected",
                        6: "The protected driver backup directory is unavailable",
                        7: "The selected interface no longer uses the verified SEGGER driver",
                        8: "The selected J-Link no longer uses WinUSB",
                        9: "Windows could not restore the original J-Link driver",
                        11: "A debugger process may be using the J-Link; close it before changing the USB driver",
                        20: "Windows could not start the administrator authorization request",
                        21: "The original SEGGER driver could not be backed up safely",
                        22: "The bundled libwdi library is missing or failed integrity verification",
                        23: "Windows could not enumerate the selected J-Link interface",
                        24: "libwdi did not identify the exact selected J-Link interface",
                        25: "Windows rejected the WinUSB driver installation"
                    };
                    const helperMessage = String(stderr || "")
                        .trim()
                        .slice(0, 500);
                    reject(
                        driverError(
                            cancelled
                                ? "PROBE_DRIVER_AUTH_CANCELLED"
                                : exitCode === 11
                                  ? "PROBE_DRIVER_BUSY"
                                  : resultUnknown
                                    ? "PROBE_DRIVER_RESULT_UNKNOWN"
                                    : rollbackFailed
                                      ? "PROBE_DRIVER_ROLLBACK_FAILED"
                                      : action === "restore"
                                        ? "PROBE_DRIVER_RESTORE_FAILED"
                                        : "PROBE_DRIVER_INSTALL_FAILED",
                            cancelled
                                ? "Windows administrator authorization was cancelled"
                                : resultUnknown
                                  ? "Driver helper timed out; check the current USB driver before trying again"
                                  : `${explanations[exitCode] || "Driver helper failed"}${helperMessage ? `: ${helperMessage}` : ""}`,
                            { action, exitCode: error.code }
                        )
                    );
                } else resolve(String(stdout || "").trim());
            }
        );
    });
}

class ProbeDriverService {
    constructor(options = {}) {
        this.platform = options.platform || process.platform;
        this.arch = options.arch || process.arch;
        this.extensionPath = options.extensionPath || path.resolve(__dirname, "../..");
        this.inventory = options.inventory || listProbes;
        this.run = options.run || runHelper;
        this.wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now || Date.now;
        this.onStatus = options.onStatus || (() => {});
        this.onTiming = options.onTiming || (() => {});
        this.log = options.log || ((message) => console.log(message));
        this.verifyReady = options.verifyReady || (async () => {});
        this.inFlight = new Map();
        this.restoring = new Set();
        this.recentDrivers = new Map();
        this.lastTimings = null;
    }

    get helperPath() {
        return path.join(this.extensionPath, "resources", "driver-helper", "win32-x64", "emberprobe-driver-helper.exe");
    }

    async measureStage(timings, key, operation) {
        const startedAt = this.now();
        try {
            return await operation();
        } finally {
            timings[key] = this.now() - startedAt;
        }
    }

    reportTiming(timing, message) {
        this.lastTimings = timing;
        notifyObserver(this.onTiming, timing);
        notifyObserver(this.log, message);
    }

    reportStatus(status) {
        notifyObserver(this.onStatus, status);
    }

    async invoke(action, instanceId) {
        try {
            await fs.access(this.helperPath);
            if (action === "install") await fs.access(path.join(path.dirname(this.helperPath), "libwdi.dll"));
        } catch {
            throw driverError("PROBE_DRIVER_HELPER_MISSING", "The signed Windows driver helper is not installed");
        }
        return this.run(this.helperPath, action, instanceId);
    }

    async waitFor(instanceId, expected) {
        // Query only the selected devnode through SetupAPI. A full PowerShell USB inventory on every
        // poll can add many seconds and can briefly report the driver from before re-enumeration.
        for (let attempt = 0; attempt < 60; attempt++) {
            try {
                const status = await this.invoke("status", instanceId);
                if (expected.test(status)) return status;
            } catch (error) {
                if (error.code !== "PROBE_DRIVER_INSTALL_FAILED") throw error;
            }
            await this.wait(200);
        }
        throw driverError("PROBE_DRIVER_VERIFY_FAILED", "Windows did not bind the expected USB driver", { instanceId });
    }

    updatedInventory(connection, instanceId, service, status = "") {
        const driverInf = /^jlink\s+(oem\d+\.inf)$/i.exec(status)?.[1];
        return {
            ...connection.inventory,
            devices: connection.inventory.devices.map((device) => ({
                ...device,
                interfaces: (device.interfaces || []).map((item) =>
                    item.instanceId.toUpperCase() === instanceId.toUpperCase()
                        ? {
                              ...item,
                              service,
                              ...(service === "jlink" ? { driverProvider: "SEGGER", driverInf } : {})
                          }
                        : item
                )
            }))
        };
    }

    async reconcileInventory(inventory) {
        if (this.platform !== "win32" || !inventory.available || !this.recentDrivers.size) return inventory;
        let result = inventory;
        for (const [instanceId, service] of this.recentDrivers) {
            const selected = result.devices
                .flatMap((device) => device.interfaces || [])
                .find((item) => item.instanceId.toUpperCase() === instanceId.toUpperCase());
            const converged =
                selected?.service?.toLowerCase() === service.toLowerCase() &&
                (service !== "jlink" ||
                    (/^segger\b/i.test(selected.driverProvider || "") &&
                        /^oem\d+\.inf$/i.test(selected.driverInf || "")));
            if (!selected || converged) {
                this.recentDrivers.delete(instanceId);
                continue;
            }
            let status;
            for (let attempt = 0; attempt < 60; attempt++) {
                try {
                    status = await this.invoke("status", instanceId);
                    break;
                } catch (error) {
                    if (error.code !== "PROBE_DRIVER_INSTALL_FAILED") throw error;
                    if (attempt < 59) await this.wait(200);
                }
            }
            // Keep the last confirmed driver for a later inventory pass if re-enumeration is still in progress.
            if (!status) continue;
            if (status.toLowerCase().startsWith(`${service.toLowerCase()} `))
                result = this.updatedInventory({ inventory: result }, instanceId, service, status);
            else this.recentDrivers.delete(instanceId);
        }
        return result;
    }

    async rollbackAfterFailure(instanceId, originalError) {
        let status;
        try {
            status = await this.invoke("status", instanceId);
        } catch {
            return originalError;
        }
        if (originalError.code === "PROBE_DRIVER_RESULT_UNKNOWN") {
            originalError.details = { ...originalError.details, currentDriver: status };
            return originalError;
        }
        if (!/^winusb(?:\s|$)/i.test(status)) return originalError;
        try {
            await this.invoke("restore", instanceId);
            await this.waitFor(instanceId, /^jlink(?:\s|$)/i);
            originalError.details = { ...originalError.details, rollback: "restored" };
            return originalError;
        } catch (rollbackError) {
            return driverError(
                "PROBE_DRIVER_ROLLBACK_FAILED",
                "WinUSB setup failed and the original driver could not be restored",
                {
                    instanceId,
                    initialError: originalError.message,
                    rollbackError: rollbackError.message
                }
            );
        }
    }

    requireWinUsb(connection) {
        return requireJlinkWinUsb(connection, this.platform, this.arch);
    }

    async ensure(connection) {
        const state = classifyJlinkDriver(connection, this.platform, this.arch);
        if (
            state.kind === "not-applicable" ||
            state.kind === "ready" ||
            state.kind === "unsupported" ||
            state.kind === "unknown"
        )
            return connection;
        if (this.restoring.has(state.instanceId))
            throw driverError("PROBE_DRIVER_BUSY", "The original J-Link driver is being restored");
        const pending = this.inFlight.get(state.instanceId);
        if (pending) return { ...connection, inventory: await pending };
        const work = (async () => {
            this.reportStatus({ state: "installing", instanceId: state.instanceId });
            const startedAt = this.now();
            const durations = { helperMs: 0, pollMs: 0, readyMs: 0 };
            try {
                // The elevated helper re-reads the devnode and its driver before changing anything.
                await this.measureStage(durations, "helperMs", () => this.invoke("install", state.instanceId));
                await this.measureStage(durations, "pollMs", () => this.waitFor(state.instanceId, /^winusb(?:\s|$)/i));
                await this.measureStage(durations, "readyMs", () => this.verifyReady(connection));

                const totalMs = this.now() - startedAt;
                const timings = { ...durations, totalMs };
                this.reportTiming(
                    { action: "install", instanceId: state.instanceId, ...timings },
                    `[EmberProbe] J-Link driver switch timings (install): ` +
                        `helper=${durations.helperMs}ms, statusPoll=${durations.pollMs}ms, ` +
                        `openocdReady=${durations.readyMs}ms, total=${totalMs}ms`
                );

                this.recentDrivers.set(state.instanceId, "WinUSB");
                const inventory = this.updatedInventory(connection, state.instanceId, "WinUSB");
                this.reportStatus({ state: "ready", instanceId: state.instanceId, timings });
                return inventory;
            } catch (error) {
                const totalMs = this.now() - startedAt;
                this.reportTiming(
                    {
                        action: "install",
                        instanceId: state.instanceId,
                        ...durations,
                        totalMs,
                        failed: true,
                        error: error.message
                    },
                    `[EmberProbe] J-Link driver switch failed (install): ` +
                        `helper=${durations.helperMs}ms, statusPoll=${durations.pollMs}ms, ` +
                        `openocdReady=${durations.readyMs}ms, error=${error.message}`
                );
                const failure = await this.rollbackAfterFailure(state.instanceId, error);
                this.reportStatus({ state: "error", instanceId: state.instanceId, message: failure.message });
                throw failure;
            } finally {
                this.inFlight.delete(state.instanceId);
            }
        })();
        this.inFlight.set(state.instanceId, work);
        return { ...connection, inventory: await work };
    }

    async restore(connection) {
        if (this.platform !== "win32" || this.arch !== "x64" || connection.adapterFamily !== "jlink")
            throw driverError(
                "PROBE_DRIVER_RESTORE_UNAVAILABLE",
                "Driver restore is available only for Windows x64 J-Link"
            );
        const state = classifyJlinkDriver(connection, this.platform, this.arch);
        if (state.kind !== "ready")
            throw driverError("PROBE_DRIVER_RESTORE_UNAVAILABLE", "Select a J-Link currently using WinUSB");
        if (this.inFlight.has(state.instanceId) || this.restoring.has(state.instanceId))
            throw driverError("PROBE_DRIVER_BUSY", "A driver change is already running");
        this.restoring.add(state.instanceId);
        this.reportStatus({ state: "restoring", instanceId: state.instanceId });
        const startedAt = this.now();
        const durations = { helperMs: 0, pollMs: 0, readyMs: 0 };
        try {
            await this.measureStage(durations, "helperMs", () => this.invoke("restore", state.instanceId));
            const status = await this.measureStage(durations, "pollMs", () =>
                this.waitFor(state.instanceId, /^jlink\s+oem\d+\.inf$/i)
            );

            const totalMs = this.now() - startedAt;
            const timings = { ...durations, totalMs };
            this.reportTiming(
                { action: "restore", instanceId: state.instanceId, ...timings },
                `[EmberProbe] J-Link driver switch timings (restore): ` +
                    `helper=${durations.helperMs}ms, statusPoll=${durations.pollMs}ms, total=${totalMs}ms`
            );

            this.recentDrivers.set(state.instanceId, "jlink");
            const inventory = this.updatedInventory(connection, state.instanceId, "jlink", status);
            this.reportStatus({ state: "restored", instanceId: state.instanceId, timings });
            return inventory;
        } catch (error) {
            const totalMs = this.now() - startedAt;
            this.reportTiming(
                {
                    action: "restore",
                    instanceId: state.instanceId,
                    ...durations,
                    totalMs,
                    failed: true,
                    error: error.message
                },
                `[EmberProbe] J-Link driver switch failed (restore): ` +
                    `helper=${durations.helperMs}ms, statusPoll=${durations.pollMs}ms, error=${error.message}`
            );
            this.reportStatus({ state: "error", instanceId: state.instanceId, message: error.message });
            throw error;
        } finally {
            this.restoring.delete(state.instanceId);
        }
    }
}

module.exports = { ProbeDriverService, classifyJlinkDriver, JLINK_PIDS };
