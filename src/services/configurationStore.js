"use strict";
const fs = require("fs");
const path = require("path");

const ALLOWED_KEYS = new Set([
    "elf",
    "debugger",
    "mcu",
    "svd",
    "openocdPath",
    "sampleIntervalMs",
    "tclPort",
    "maxSamples"
]);

const NUMBER_RANGES = Object.freeze({
    sampleIntervalMs: [20, 10000],
    tclPort: [1, 65535],
    maxSamples: [100, 100000]
});

// Agent Bridge 禁止修改的配置键：openocdPath 可把探针调用引向任意可执行文件（token → 本地执行链），
// 修改必须由用户在 VS Code 设置或侧边栏中完成；UI 路径不经过 store.update，不受此断言影响。
const AGENT_FORBIDDEN_KEYS = Object.freeze(["openocdPath"]);

function assertAgentSettable(values) {
    for (const key of Object.keys(values || {})) {
        if (AGENT_FORBIDDEN_KEYS.includes(key)) {
            throw Object.assign(new Error(`Configuration key cannot be modified through the Agent Bridge: ${key}`), {
                code: "CONFIG_KEY_FORBIDDEN",
                retryable: false
            });
        }
    }
}

class ConfigurationStore {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.cacheKeys = options.cacheKeys;
        this.cleanPath = options.cleanPath;
        this.isSafeCfg = options.isSafeCfg;
        this.onChanged = options.onChanged || (() => {});
    }

    snapshot() {
        const cfg = this.vscode.workspace.getConfiguration("emberprobe");
        return {
            elf: this.context.workspaceState.get(this.cacheKeys.elfPath) || "",
            debugger: this.context.workspaceState.get(this.cacheKeys.debugger) || "",
            mcu: this.context.workspaceState.get(this.cacheKeys.mcuCore) || "",
            svd: this.context.workspaceState.get(this.cacheKeys.svdPath) || "",
            openocdPath: cfg.get("openocdPath", "openocd"),
            sampleIntervalMs: cfg.get("sampleIntervalMs", 100),
            tclPort: cfg.get("tclPort", 6666),
            maxSamples: cfg.get("maxSamples", 2000)
        };
    }

    workspacePath(value, extension) {
        if (value === "") return "";
        const workspace = this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspace) {
            throw Object.assign(new Error("Open a workspace first"), { code: "NO_WORKSPACE" });
        }
        const resolved = path.resolve(workspace, String(value));
        if (!fs.existsSync(resolved)) {
            throw Object.assign(new Error(`File does not exist: ${resolved}`), { code: "FILE_NOT_FOUND" });
        }
        const workspaceReal = fs.realpathSync(workspace);
        const resolvedReal = fs.realpathSync(resolved);
        const relative = path.relative(workspaceReal, resolvedReal);
        if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
            throw Object.assign(new Error("Path must be inside the current workspace"), {
                code: "PATH_OUTSIDE_WORKSPACE"
            });
        }
        if (extension && path.extname(resolvedReal).toLowerCase() !== extension) {
            throw Object.assign(new Error(`Expected a ${extension} file`), { code: "INVALID_FILE_TYPE" });
        }
        return this.cleanPath(resolvedReal);
    }

    update(values) {
        const pending = (this.updateQueue || Promise.resolve()).then(() => this.commit(values));
        // A rejected transaction must not poison the queue for subsequent updates.
        this.updateQueue = pending.catch(() => {});
        return pending;
    }

    async commit(values) {
        if (!values || typeof values !== "object" || Array.isArray(values))
            throw Object.assign(new Error("Configuration values must be an object"), { code: "INVALID_CONFIG_VALUE" });
        const cfg = this.vscode.workspace.getConfiguration("emberprobe");
        const operations = [];
        const state = this.context.workspaceState;
        const stateKeys = { elf: "elfPath", svd: "svdPath", mcu: "mcuCore", debugger: "debugger" };
        const addState = (key, value) => {
            const storageKey = this.cacheKeys[stateKeys[key]];
            operations.push({
                key,
                value,
                previous: state.get(storageKey),
                write: (v) => state.update(storageKey, v)
            });
        };
        const addSetting = (key, value) =>
            operations.push({
                key,
                value,
                previous: typeof cfg.inspect === "function" ? cfg.inspect(key)?.workspaceValue : cfg.get(key),
                write: (v) => cfg.update(key, v, this.vscode.ConfigurationTarget.Workspace)
            });
        for (const [key, value] of Object.entries(values)) {
            if (!ALLOWED_KEYS.has(key))
                throw Object.assign(new Error("Unsupported configuration key: " + key), { code: "UNSUPPORTED_CONFIG" });
            if (key === "elf" || key === "svd") addState(key, this.workspacePath(value, "." + key));
            else if (key === "debugger" || key === "mcu") {
                if (!this.isSafeCfg(value))
                    throw Object.assign(new Error("Invalid " + key + " configuration name"), {
                        code: key === "mcu" ? "INVALID_MCU" : "INVALID_DEBUGGER"
                    });
                addState(key, value);
            } else if (NUMBER_RANGES[key]) {
                const [min, max] = NUMBER_RANGES[key];
                const number = Number(value);
                if (!Number.isInteger(number) || number < min || number > max)
                    throw Object.assign(new Error(key + " must be an integer from " + min + " to " + max), {
                        code: "INVALID_CONFIG_VALUE"
                    });
                addSetting(key, number);
            } else {
                const executable = String(value || "").trim();
                if (!executable || /[\r\n]/.test(executable))
                    throw Object.assign(new Error("Invalid OpenOCD path"), { code: "INVALID_OPENOCD_PATH" });
                addSetting(key, executable);
            }
        }
        const applied = [];
        try {
            for (const operation of operations) {
                applied.push(operation);
                await operation.write(operation.value);
            }
        } catch (cause) {
            const rollbackErrors = [];
            for (const operation of applied.reverse()) {
                try {
                    await operation.write(operation.previous);
                } catch (error) {
                    rollbackErrors.push({ key: operation.key, message: error.message });
                }
            }
            try {
                await this.onChanged();
            } catch (error) {
                rollbackErrors.push({ key: "notification", message: error.message });
            }
            throw Object.assign(new Error("Configuration update failed: " + cause.message), {
                code: "CONFIG_UPDATE_FAILED",
                cause,
                details: { rollbackErrors, actual: this.snapshot() }
            });
        }
        await this.onChanged();
        return this.snapshot();
    }
}

module.exports = { ConfigurationStore, ALLOWED_KEYS, NUMBER_RANGES, AGENT_FORBIDDEN_KEYS, assertAgentSettable };
