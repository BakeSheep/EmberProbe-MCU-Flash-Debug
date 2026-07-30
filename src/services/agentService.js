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
        this.handlers = { ...options.handlers };
        this.bridge = null;
    }

    methods() {
        return Object.keys(this.handlers);
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

    async start() {
        const workspace = this.workspaceProvider();
        if (!workspace || this.bridge) return null;
        this.bridge = new this.Bridge(workspace, (method, params) => this.call(method, params));
        return await this.bridge.start();
    }

    async stop() {
        const bridge = this.bridge;
        this.bridge = null;
        if (bridge) await bridge.stop();
    }
}

module.exports = { AgentService, CHIP_GROUPS };
