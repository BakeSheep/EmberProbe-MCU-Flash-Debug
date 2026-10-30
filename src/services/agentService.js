"use strict";
const { BRIDGE_PROTOCOL, MIN_CLIENT_PROTOCOL } = require("../../skills/_emberprobe/bridge-locator");

const CHIP_GROUPS = Object.freeze({
    identity: [
        "core",
        "coreRevision",
        "coreMismatch",
        "cpuid",
        "chip",
        "series",
        "designer",
        "romDesigner",
        "designerCode",
        "romPart",
        "authenticity",
        "compatVendor",
        "compatBrand",
        "deviceId",
        "revId",
        "flashSize",
        "uid",
        "endian"
    ],
    debug: [
        "probeName",
        "probeVersion",
        "probeHardwareVersion",
        "probeFirmware",
        "probe",
        "transport",
        "clock",
        "voltage",
        "targetName"
    ],
    runtime: ["targetState", "haltReason", "pc", "sp", "lr"]
});

class AgentService {
    constructor(options) {
        this.Bridge = options.Bridge;
        this.workspaceProvider = options.workspaceProvider;
        this.storageDirProvider = options.storageDirProvider || null;
        this.onCall = options.onCall || null;
        this.onAudit = options.onAudit || null;
        this.isTrusted = options.isTrusted || (() => true);
        this.handlers = { ...options.handlers };
        // Instance registry (optional): a running Bridge registers port/token; otherwise a token-free disabled marker
        // is registered.
        this.registry = options.registry || null;
        this.workspaceFoldersProvider =
            options.workspaceFoldersProvider ||
            (() => {
                const workspace = this.workspaceProvider();
                return workspace ? [workspace] : [];
            });
        this.legacyPointer = true;
        this.accessState = "disabled";
        this.descriptor = null;
        this.bridge = null;
        this.lifecycleEpoch = 0;
        this.startPromise = null;
        this.stopPromise = null;
        this.closed = false;
    }

    // Extension shutdown: refuse calls already in transit and any later restart of the Bridge.
    close() {
        this.closed = true;
    }

    assertOpen() {
        if (this.closed)
            throw Object.assign(new Error("The extension is shutting down"), { code: "EXTENSION_SHUTTING_DOWN" });
    }

    methods() {
        return Object.keys(this.handlers);
    }

    isStarted() {
        return !!this.bridge;
    }

    instanceId() {
        return this.registry?.instanceId || "";
    }

    // Call auditing records only channel, client, method and result code, never parameter values.
    async call(method, params = {}, meta) {
        try {
            const result = await this.dispatch(method, params, meta);
            this.onAudit?.({ channel: meta?.channel || "", client: meta?.client || "", method, code: "OK" });
            return result;
        } catch (error) {
            this.onAudit?.({
                channel: meta?.channel || "",
                client: meta?.client || "",
                method,
                code: error?.code || "ERROR"
            });
            throw error;
        }
    }

    async dispatch(method, params, meta) {
        if (!this.isTrusted())
            throw Object.assign(new Error("Agent Bridge requires a trusted workspace"), {
                code: "WORKSPACE_UNTRUSTED"
            });
        if (method === "capabilities") {
            return {
                protocol: BRIDGE_PROTOCOL,
                minClientProtocol: MIN_CLIENT_PROTOCOL,
                instanceId: this.instanceId(),
                methods: this.methods()
            };
        }
        const handler = Object.hasOwn(this.handlers, method) ? this.handlers[method] : null;
        if (!handler) {
            throw Object.assign(new Error(`Unsupported Agent Bridge method: ${method}`), {
                code: "METHOD_NOT_FOUND"
            });
        }
        this.assertOpen();
        if (this.onCall) await this.onCall(method, params, meta);
        this.assertOpen();
        const result = await handler(params);
        return method === "chip.read" ? this.selectChipFields(result, params) : result;
    }

    selectChipFields(info, params = {}) {
        const requested = new Set((params.fields || []).map(String));
        for (const section of params.sections || ["identity"]) {
            for (const field of CHIP_GROUPS[section] || []) requested.add(field);
        }
        return Object.fromEntries(
            Array.from(requested)
                .filter((field) => Object.hasOwn(info, field))
                .map((field) => [field, info[field]])
        );
    }

    // options.legacyPointer: whether to write the workspace pointer for older scripts (true while workspace skills are
    // installed).
    start(options = {}) {
        if (this.closed)
            return Promise.reject(
                Object.assign(new Error("The extension is shutting down"), { code: "EXTENSION_SHUTTING_DOWN" })
            );
        if (!this.isTrusted())
            return Promise.reject(
                Object.assign(new Error("Agent Bridge requires a trusted workspace"), { code: "WORKSPACE_UNTRUSTED" })
            );
        if (options.legacyPointer !== undefined) this.legacyPointer = !!options.legacyPointer;
        if (this.stopPromise) return this.stopPromise.then(() => this.start());
        if (this.startPromise) return this.startPromise;
        if (this.bridge) return Promise.resolve(this.bridge.setLegacyPointer?.(this.legacyPointer)).then(() => null);
        const workspace = this.workspaceProvider();
        if (!workspace) return Promise.resolve(null);
        const epoch = this.lifecycleEpoch;
        const bridge = new this.Bridge(
            workspace,
            (method, params, meta) => this.call(method, params, meta),
            this.storageDirProvider?.(),
            { legacyPointer: this.legacyPointer }
        );
        this.startPromise = (async () => {
            await Promise.resolve();
            try {
                const result = await bridge.start();
                if (epoch !== this.lifecycleEpoch) {
                    await bridge.stop();
                    return null;
                }
                if (this.registry) {
                    await this.registry.publish({ bridge: result, workspaceFolders: this.folders() });
                    // If stop() arrives during registration, its disabled marker is written after this registration.
                    if (epoch !== this.lifecycleEpoch) {
                        await bridge.stop();
                        return null;
                    }
                }
                this.bridge = bridge;
                this.descriptor = result;
                return result;
            } catch (error) {
                try {
                    await bridge.stop();
                } catch (cleanupError) {
                    error.cleanupError = cleanupError;
                }
                throw error;
            } finally {
                this.startPromise = null;
            }
        })();
        return this.startPromise;
    }

    stop() {
        if (this.stopPromise) return this.stopPromise;
        this.lifecycleEpoch++;
        const bridge = this.bridge;
        this.bridge = null;
        const starting = this.startPromise;
        this.descriptor = null;
        this.stopPromise = (async () => {
            await Promise.resolve();
            try {
                if (starting) await starting.catch(() => {}); // start owns failure cleanup
                if (bridge) await bridge.stop();
                await this.publishMarker();
            } finally {
                this.stopPromise = null;
            }
        })();
        return this.stopPromise;
    }

    folders() {
        return this.workspaceFoldersProvider() || [];
    }

    async publishMarker() {
        if (!this.registry || this.bridge) return;
        try {
            if (!this.folders().length) await this.registry.remove();
            else await this.registry.publish({ workspaceFolders: this.folders(), agentAccess: this.accessState });
        } catch (error) {
            // The marker only serves diagnostics; a failed write does not affect the rest of the extension.
            console.warn("Unable to update the Agent Bridge registry:", error?.message || error);
        }
    }

    async dispose() {
        await this.stop();
        await this.registry?.remove();
    }
}

module.exports = { AgentService, CHIP_GROUPS };
