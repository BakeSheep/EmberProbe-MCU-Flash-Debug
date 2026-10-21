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
        this.isTrusted = options.isTrusted || (() => true);
        this.handlers = { ...options.handlers };
        // 实例注册表（可选）：Bridge 运行时登记 port/token，未运行时登记不含 token 的未启用标记。
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

    async call(method, params = {}, meta) {
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
        if (this.onCall) await this.onCall(method, params, meta);
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

    // options.legacyPointer：是否为旧版脚本写工作区指针（工作区装了 skills 时为真）。
    start(options = {}) {
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
                    // stop() 在登记期间到来时，它的未启用标记排在本次登记之后写入。
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

    // 记录未运行原因（disabled/untrusted），并在不运行时登记为不含 token 的标记。
    setAccessState(state) {
        this.accessState = state || "disabled";
        return this.bridge ? Promise.resolve() : this.publishMarker();
    }

    // 工作区文件夹变化后重写登记内容；运行中的 Bridge 保留原 port/token。
    refreshRegistration() {
        if (!this.registry) return Promise.resolve();
        if (this.bridge && this.descriptor)
            return this.registry.publish({ bridge: this.descriptor, workspaceFolders: this.folders() });
        return this.publishMarker();
    }

    async publishMarker() {
        if (!this.registry || this.bridge) return;
        try {
            if (!this.folders().length) await this.registry.remove();
            else await this.registry.publish({ workspaceFolders: this.folders(), agentAccess: this.accessState });
        } catch (error) {
            // 标记只服务于诊断，写入失败不影响扩展其余功能。
            console.warn("Unable to update the Agent Bridge registry:", error?.message || error);
        }
    }

    async dispose() {
        await this.stop();
        await this.registry?.remove();
    }
}

module.exports = { AgentService, CHIP_GROUPS };
