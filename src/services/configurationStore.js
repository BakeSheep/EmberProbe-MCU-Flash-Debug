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
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw Object.assign(new Error("Path must be inside the current workspace"), {
                code: "PATH_OUTSIDE_WORKSPACE"
            });
        }
        if (extension && path.extname(resolvedReal).toLowerCase() !== extension) {
            throw Object.assign(new Error(`Expected a ${extension} file`), { code: "INVALID_FILE_TYPE" });
        }
        return this.cleanPath(resolvedReal);
    }

    async update(values) {
        for (const key of Object.keys(values || {})) {
            if (!ALLOWED_KEYS.has(key)) {
                throw Object.assign(new Error(`Unsupported configuration key: ${key}`), { code: "UNSUPPORTED_CONFIG" });
            }
        }
        if (Object.hasOwn(values, "elf")) {
            await this.context.workspaceState.update(this.cacheKeys.elfPath, this.workspacePath(values.elf, ".elf"));
        }
        if (Object.hasOwn(values, "svd")) {
            await this.context.workspaceState.update(
                this.cacheKeys.svdPath,
                this.workspacePath(values.svd, values.svd === "" ? "" : ".svd")
            );
        }
        if (Object.hasOwn(values, "debugger")) {
            if (!this.isSafeCfg(values.debugger)) {
                throw Object.assign(new Error("Invalid debugger configuration name"), { code: "INVALID_DEBUGGER" });
            }
            await this.context.workspaceState.update(this.cacheKeys.debugger, values.debugger);
        }
        if (Object.hasOwn(values, "mcu")) {
            if (!this.isSafeCfg(values.mcu)) {
                throw Object.assign(new Error("Invalid MCU target configuration name"), { code: "INVALID_MCU" });
            }
            await this.context.workspaceState.update(this.cacheKeys.mcuCore, values.mcu);
        }
        const cfg = this.vscode.workspace.getConfiguration("emberprobe");
        for (const [key, range] of Object.entries(NUMBER_RANGES)) {
            if (!Object.hasOwn(values, key)) continue;
            const number = Number(values[key]);
            if (!Number.isInteger(number) || number < range[0] || number > range[1]) {
                throw Object.assign(new Error(`${key} must be an integer from ${range[0]} to ${range[1]}`), {
                    code: "INVALID_CONFIG_VALUE"
                });
            }
            await cfg.update(key, number, this.vscode.ConfigurationTarget.Workspace);
        }
        if (Object.hasOwn(values, "openocdPath")) {
            const executable = String(values.openocdPath || "").trim();
            if (!executable || /[\r\n]/.test(executable)) {
                throw Object.assign(new Error("Invalid OpenOCD path"), { code: "INVALID_OPENOCD_PATH" });
            }
            await cfg.update("openocdPath", executable, this.vscode.ConfigurationTarget.Workspace);
        }
        await this.onChanged();
        return this.snapshot();
    }
}

module.exports = { ConfigurationStore, ALLOWED_KEYS, NUMBER_RANGES };
