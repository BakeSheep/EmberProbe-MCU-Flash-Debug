"use strict";

const net = require("net");
const crypto = require("crypto");

const HOLD_KEY = "emberprobe.externalGdbPendingRelease";
const SETTING = "experimental.externalGdb.";
function externalError(message, code = "EXTERNAL_GDB_INVALID") {
    return Object.assign(new Error(message), { code });
}

function normalizeExternalTarget(value) {
    if (typeof value !== "string" || value.length > 300 || /[\s\x00-\x1f\x7f]/.test(value))
        throw externalError("External GDB target must be a TCP host:port without whitespace");
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
    const host = match?.[1] || match?.[2];
    const port = Number(match?.[3]);
    const validDns =
        host &&
        host.length <= 253 &&
        host.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
    const validHost = match?.[1] ? net.isIP(host) === 6 : net.isIP(host || "") === 4 || validDns;
    if (!validHost || port < 1 || port > 65535)
        throw externalError("External GDB target requires an IPv4/hostname or [IPv6] and port 1..65535");
    return `${match[1] ? `[${host}]` : host}:${port}`;
}

function normalizeExternalConfiguration(config, internal = false) {
    if (config.request !== "attach") throw externalError("External GDB supports attach only");
    const forbidden = ["serverpath", "serverGroup", "numberOfProcessors", "targetProcessor", "targetName"];
    if (!internal) forbidden.push("gdbTarget", "__emberprobeExternalMode");
    if (forbidden.some((key) => Object.hasOwn(config, key)))
        throw externalError(
            "External GDB connection settings belong in VS Code settings; OpenOCD options are unsupported"
        );
    return { servertype: "external" };
}

function resolveExternalSettings(settings) {
    if (settings.get(`${SETTING}enabled`, false) !== true)
        throw externalError(
            "Enable emberprobe.experimental.externalGdb.enabled in VS Code settings",
            "EXTERNAL_GDB_DISABLED"
        );
    const mode = settings.get(`${SETTING}connectionMode`, "extended-remote");
    if (!["remote", "extended-remote"].includes(mode)) throw externalError("Invalid external GDB connection mode");
    return Object.freeze({ gdbTarget: normalizeExternalTarget(settings.get(`${SETTING}target`, "")), mode });
}

// A connection is short-lived; the physical ownership hold survives it and extension reloads.
// Only the native setting can acknowledge that the user has stopped the external server.
class ExternalDebugService {
    constructor({
        state,
        coordinator,
        settings,
        isProcessAlive = (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                return error.code !== "ESRCH";
            }
        }
    }) {
        this.state = state;
        this.coordinator = coordinator;
        this.settings = settings;
        this.isProcessAlive = isProcessAlive;
        this.marker = state.get(HOLD_KEY) || null;
        this.lease = this.marker ? coordinator.acquire("externalDebug") : null;
        this.active = false;
        this.launchSent = false;
        this.releasing = false;
        this.sessionId = "";
        this.queue = Promise.resolve();
    }
    get held() {
        return !!this.marker;
    }
    assertPhysicalAvailable() {
        if (this.held)
            throw externalError(
                "Stop the external GDB server and disable emberprobe.experimental.externalGdb.enabled before using the probe",
                "EXTERNAL_GDB_PROBE_HELD"
            );
    }
    save(marker) {
        this.marker = marker;
        const operation = this.queue.then(() => this.state.update(HOLD_KEY, marker || undefined));
        this.queue = operation.catch(() => {});
        return operation;
    }
    async reserve(folder, connection) {
        await this.queue;
        if (this.active || this.releasing)
            throw externalError("An external debug connection is active or releasing", "EXTERNAL_GDB_BUSY");
        if (this.marker && this.marker.folder !== folder)
            throw externalError("Release the previous workspace's external GDB hold first", "EXTERNAL_GDB_BUSY");
        if (this.marker && !this.marker.cleanupConfirmed)
            throw externalError("Local GDB exit has not been confirmed", "EXTERNAL_GDB_CLEANUP_PENDING");
        const previous = this.marker;
        const hadLease = !!this.lease;
        this.lease ||= this.coordinator.acquire("externalDebug");
        this.active = true;
        this.launchSent = false;
        const token = crypto.randomUUID();
        try {
            // Persist uncertainty before GDB can start; lost process events must fail closed on reload.
            await this.save({ folder, token, cleanupConfirmed: false, pid: null });
        } catch (error) {
            this.active = false;
            // A failed persistent write must not leave an unrecorded connection possible.
            this.marker = previous;
            if (!hadLease) {
                this.lease.release();
                this.lease = null;
            }
            throw error;
        }
        return { ...connection, token };
    }
    matches(session) {
        return !!(this.active && this.marker && session?.configuration?.__emberprobeManagedToken === this.marker.token);
    }
    bind(session) {
        if (!this.matches(session)) return false;
        if (this.sessionId === session.id) return true;
        this.sessionId = session.id;
        return true;
    }
    request(session, message) {
        if (this.matches(session) && message.command === "attach") this.launchSent = true;
        return Promise.resolve();
    }
    async message(session, message) {
        if (!this.matches(session) || message.type !== "event") return;
        if (message.event === "emberprobe.externalGdbProcess") {
            const { pid, exited } = message.body || {};
            if (exited === true) await this.save({ ...this.marker, cleanupConfirmed: true, pid: null });
            else if (Number.isInteger(pid) && pid > 0)
                await this.save({ ...this.marker, cleanupConfirmed: false, pid });
        }
    }
    async finish(session) {
        if (session && !this.matches(session)) return;
        if (this.active && !this.launchSent && this.marker && !this.marker.pid)
            await this.save({ ...this.marker, cleanupConfirmed: true });
        this.active = false;
        this.sessionId = "";
        await this.releaseIfDisabled();
    }
    async releaseIfDisabled() {
        await this.queue;
        if (
            !this.marker ||
            this.active ||
            this.releasing ||
            this.settings(this.marker.folder).get(`${SETTING}enabled`, false)
        )
            return false;
        if (!this.marker.cleanupConfirmed) {
            if (!this.marker.pid || this.isProcessAlive(this.marker.pid)) return false;
        }
        this.releasing = true;
        try {
            // Keep both the in-memory hold and lease until the persistent clear succeeds.
            const operation = this.queue.then(() => this.state.update(HOLD_KEY, undefined));
            this.queue = operation.catch(() => {});
            await operation;
            this.marker = null;
            this.lease?.release();
            this.lease = null;
            return true;
        } finally {
            this.releasing = false;
        }
    }
}

module.exports = {
    ExternalDebugService,
    normalizeExternalTarget,
    normalizeExternalConfiguration,
    resolveExternalSettings,
    HOLD_KEY
};
