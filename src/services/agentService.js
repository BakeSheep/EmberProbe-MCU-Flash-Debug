"use strict";

const CHIP_GROUPS = Object.freeze({
    identity: [
        "core",
        "coreRevision",
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
    debug: ["probeName", "probeVersion", "probe", "transport", "clock", "voltage", "targetName"],
    runtime: ["targetState", "haltReason", "pc", "sp", "lr"]
});

class AgentService {
    constructor(options) {
        this.Bridge = options.Bridge;
        this.workspaceProvider = options.workspaceProvider;
        this.storageDirProvider = options.storageDirProvider || null;
        this.onCall = options.onCall || null;
        this.handlers = { ...options.handlers };
        this.bridge = null;
        this.lifecycleEpoch = 0;
        this.startPromise = null;
        this.stopPromise = null;
    }

    methods() {
        return Object.keys(this.handlers);
    }

    isStarted() {
        return !!this.bridge;
    }

    async call(method, params = {}) {
        if (method === "capabilities") {
            return { protocol: 1, methods: this.methods() };
        }
        const handler = this.handlers[method];
        if (!handler) {
            throw Object.assign(new Error(`Unsupported Agent Bridge method: ${method}`), {
                code: "METHOD_NOT_FOUND"
            });
        }
        if (this.onCall) await this.onCall(method, params);
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

    start() {
        if (this.stopPromise) return this.stopPromise.then(() => this.start());
        if (this.startPromise) return this.startPromise;
        const workspace = this.workspaceProvider();
        if (!workspace || this.bridge) return Promise.resolve(null);
        const epoch = this.lifecycleEpoch;
        const bridge = new this.Bridge(
            workspace,
            (method, params) => this.call(method, params),
            this.storageDirProvider?.()
        );
        this.startPromise = (async () => {
            await Promise.resolve();
            try {
                const result = await bridge.start();
                if (epoch !== this.lifecycleEpoch) {
                    await bridge.stop();
                    return null;
                }
                this.bridge = bridge;
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
        this.stopPromise = (async () => {
            await Promise.resolve();
            try {
                if (starting) await starting.catch(() => {}); // start owns failure cleanup
                if (bridge) await bridge.stop();
            } finally {
                this.stopPromise = null;
            }
        })();
        return this.stopPromise;
    }
}

module.exports = { AgentService, CHIP_GROUPS };
