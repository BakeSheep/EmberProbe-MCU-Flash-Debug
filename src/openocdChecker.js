"use strict";
// OpenOCD detection, bundled runtime preparation and path configuration. Design points:
// - never changes the system PATH, rc files or registry;
// - runs with emberprobe.openocdPath pointing at an absolute openocd path;
// - an in-memory cache avoids probing again for every programming, debug or live watch run;
// - detection and preparation state reach the sidebar through callbacks, never notification pop-ups.

const { resolveExecutablePath } = require("./openocdScripts");
const fs = require("fs");
const { spawn } = require("child_process");
const { decodeLine } = require("../skills/_emberprobe/tool-output");
const installer = require("./openocdInstaller");
const i18n = require("./i18n");

const {
    MIN_OPENOCD_VERSION,
    parseVersion,
    compareVersions,
    checkCompatibility
} = require("../skills/_emberprobe/openocd-policy");

// In-memory probe result cache
let _cachedResult = null;
// Verified bundled runtimes by executable path. Flash, debug and live starts each resolve the bundled default,
// and a cold Windows start of `openocd --version` can take hundreds of milliseconds, so a runtime whose
// executable keeps its size and mtime is not probed again.
const bundledVerified = new Map();

function executableStamp(file) {
    try {
        const stat = fs.statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
    } catch {
        return "";
    }
}

function withCompatibility(result) {
    if (!result || !result.found) return result;
    return { ...result, ...checkCompatibility(result.version) };
}

function isCompatibleResult(result) {
    return Boolean(result && result.found && withCompatibility(result).compatible);
}

// Checks whether an executable is a runnable OpenOCD. A spawn failure (ENOENT) or no response within 5 s counts as not
// found; returns a structured result for the caller.
function probeOpenOcd(executable) {
    const target = executable && String(executable).trim();
    if (!target) {
        return Promise.resolve({
            found: false,
            path: "",
            version: "",
            error: "未配置 OpenOCD 路径",
            errorKey: "oc.errNoPath"
        });
    }
    const doProbe = (resolved) =>
        new Promise((resolve) => {
            let child;
            try {
                // windowsHide avoids a flashing console window; shell:false calls the binary directly to avoid PATH
                // injection
                child = spawn(resolved, ["--version"], { windowsHide: true, shell: false });
            } catch (error) {
                resolve({
                    found: false,
                    path: resolved,
                    requested: target,
                    version: "",
                    error: error.code === "ENOENT" ? "找不到该可执行文件" : error.message,
                    errorKey: error.code === "ENOENT" ? "oc.errNotFound" : undefined
                });
                return;
            }
            const stdout = [];
            const stderr = [];
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                try {
                    child.kill();
                } catch (e) {
                    /* ignore */
                }
                done({
                    found: false,
                    path: resolved,
                    requested: target,
                    version: "",
                    error: "探测超时",
                    errorKey: "oc.errTimeout"
                });
            }, 5000);
            child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
            child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
            child.on("error", (error) => {
                const isEnoent = error.code === "ENOENT";
                const permissionDenied = ["EACCES", "EPERM"].includes(error.code);
                const msg = isEnoent ? "找不到该可执行文件（请确认路径或将其加入 PATH）" : error.message;
                done({
                    found: false,
                    path: resolved,
                    requested: target,
                    version: "",
                    error: msg,
                    errorKey: isEnoent ? "oc.errNotFoundPath" : permissionDenied ? "oc.errPermission" : undefined,
                    errorParams: permissionDenied ? { path: resolved, error: error.message } : undefined,
                    code: error.code
                });
            });
            child.on("close", (code) => {
                const out = `${decodeLine(Buffer.concat(stdout))}\n${decodeLine(Buffer.concat(stderr))}`;
                const version = parseVersion(out);
                // --version usually exits with 0; some old or special builds exit non-zero but still print their
                // banner, so any output containing "open on-chip debugger" counts as runnable.
                if (version || /open on-chip debugger/i.test(out)) {
                    done(withCompatibility({ found: true, path: resolved, requested: target, version, error: "" }));
                } else {
                    done({
                        found: false,
                        path: resolved,
                        requested: target,
                        version: "",
                        error: code ? `退出码 ${code}，且输出无法识别为 OpenOCD` : "所选文件不是有效的 OpenOCD",
                        errorKey: code ? "oc.errExit" : "oc.errNotOpenocd",
                        errorParams: code ? { code } : undefined
                    });
                }
            });
        });
    try {
        return doProbe(resolveExecutablePath(target));
    } catch (error) {
        return Promise.resolve({
            found: false,
            path: target,
            requested: target,
            version: "",
            error: error.message,
            code: error.code
        });
    }
}

function getCachedResult() {
    return _cachedResult;
}
function setCache(result) {
    _cachedResult = withCompatibility(result);
}
function resetCache() {
    _cachedResult = null;
    bundledVerified.clear();
}
function reportStatus(report, status) {
    if (typeof report === "function") report(status);
}
function hasBundledArchive(context) {
    return Boolean(context && typeof context.asAbsolutePath === "function" && installer.getBundledArchive(context));
}

function shouldUseBundledDefault(executable, context) {
    const target = String(executable || "").trim();
    return (
        ["linux-x64", "win32-x64"].includes(installer.platformKey()) &&
        (!target || target === "openocd") &&
        hasBundledArchive(context)
    );
}

// Resolve the bundled default before hardware startup. Keep the configured value unchanged,
// and fail closed if the bundled runtime cannot run instead of starting the affected system build.
async function probeDefaultOpenOcd(executable, context, report) {
    if (!shouldUseBundledDefault(executable, context)) return undefined;
    // The installer reports progress only when it must extract; reusing a verified runtime
    // keeps the sidebar status unchanged so flash/debug startup does not flash the preparation card.
    try {
        let probed;
        const result = await installer.installBundledOpenOcd(
            null,
            context,
            (progress) => reportStatus(report, { state: "preparing", ...progress }),
            async (candidate) => {
                const stamp = executableStamp(candidate);
                const known = stamp ? bundledVerified.get(candidate) : undefined;
                probed = known?.stamp === stamp ? known.result : await probeOpenOcd(candidate);
                return {
                    ok: isCompatibleResult(probed),
                    version: probed.version,
                    error: probed.error || `OpenOCD ${MIN_OPENOCD_VERSION} or newer is required`
                };
            },
            { reuse: true }
        );
        if (!result.ok) throw new Error(result.error);
        // A fresh extraction is verified in staging; renaming keeps the stamp, so the published path reuses it.
        const stamp = executableStamp(result.path);
        if (stamp) bundledVerified.set(result.path, { stamp, result: probed });
        return { ...probed, path: result.path, requested: String(executable || "").trim(), bundled: true };
    } catch (error) {
        return {
            found: false,
            path: "",
            requested: String(executable || "").trim(),
            version: "",
            error: error.message || String(error),
            errorKey: "oc.prepareFailed",
            errorParams: { error: error.message || String(error) }
        };
    }
}

// Writes the path to the configuration level actually in effect. With a workspace open it prefers Workspace and also
// replaces Folder overrides still equal to the old path, so a higher-priority setting does not shadow the new value.
async function persistOpenOcdPath(vscode, fsPath, previousPath) {
    const folders = vscode.workspace.workspaceFolders || [];
    const target = folders.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration("emberprobe").update("openocdPath", fsPath, target);
    if (folders.length && vscode.ConfigurationTarget.WorkspaceFolder !== undefined) {
        for (const folder of folders) {
            const scoped = vscode.workspace.getConfiguration("emberprobe", folder.uri);
            const inspected = typeof scoped.inspect === "function" ? scoped.inspect("openocdPath") : null;
            if (
                inspected?.workspaceFolderValue !== undefined &&
                String(inspected.workspaceFolderValue).trim() === String(previousPath || "").trim()
            ) {
                await scoped.update("openocdPath", fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
            }
        }
    }
    return fsPath;
}

// Lets the user pick openocd(.exe) in a file dialog, validates it and writes the extension setting; returns the final
// path or null.
async function pickOpenOcdPath(vscode, context, report, lang) {
    const isWin = process.platform === "win32";
    const previousPath = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
    const exeLabel = i18n.t(lang, "oc.pickExe");
    const allLabel = i18n.t(lang, "oc.allFiles");
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: i18n.t(lang, "oc.pickLabel"),
        filters: isWin ? { [exeLabel]: ["exe"], [allLabel]: ["*"] } : { [allLabel]: ["*"] }
    });
    if (!uris || !uris.length) return null;
    const fsPath = uris[0].fsPath;
    reportStatus(report, { state: "checking", key: "oc.validatingSelected" });
    const result = await probeOpenOcd(fsPath);
    if (isCompatibleResult(result)) {
        await persistOpenOcdPath(vscode, fsPath, previousPath);
        // The configuration change listener resets the cache; update it here as well so the rest of this action can use
        // it immediately
        _cachedResult = result;
        reportStatus(report, {
            state: "ready",
            key: result.version ? "oc.readyVer" : "oc.ready",
            params: { version: result.version },
            result
        });
        return fsPath;
    }
    if (result.found) {
        reportStatus(report, incompatibleStatus(result));
        return null;
    }
    reportStatus(report, {
        state: "error",
        key: "oc.selectedUnusable",
        params: {
            error: result.errorKey
                ? i18n.t(lang, result.errorKey, result.errorParams)
                : result.error || i18n.t(lang, "oc.reselect")
        },
        result
    });
    return null;
}

function incompatibleStatus(result) {
    const checked = withCompatibility(result);
    const hasVersion = Boolean(checked.version);
    return {
        state: "incompatible",
        key: hasVersion ? "oc.incompatibleUpgrade" : "oc.versionUnknownUpgrade",
        params: { version: checked.version, minimum: MIN_OPENOCD_VERSION },
        result: checked
    };
}

// Probes and reports the state through the sidebar callback, without notifications. Returns the current executable path
// (cached or just configured), or null when not ready.
async function resolveOpenOcdStatus(executable, context, probedResult, report) {
    const target = String(executable || "").trim();
    const rawResult =
        probedResult && (probedResult.requested || probedResult.path) === target
            ? probedResult
            : await probeOpenOcd(executable);
    const result = withCompatibility(rawResult);
    setCache(result);
    if (isCompatibleResult(result)) {
        reportStatus(report, {
            state: "ready",
            key: result.version ? "oc.readyVer" : "oc.ready",
            params: { version: result.version },
            result
        });
        return result.path;
    }
    if (result.found) {
        reportStatus(report, incompatibleStatus(result));
        return null;
    }
    reportStatus(report, {
        state: "missing",
        key: result.errorKey || (result.error ? "oc.probeFailed" : "oc.missing"),
        params: result.errorKey ? result.errorParams : { error: result.error },
        message: result.error || "未检测到 OpenOCD",
        result
    });
    return null;
}

module.exports = {
    shouldUseBundledDefault,
    probeDefaultOpenOcd,
    parseVersion,
    compareVersions,
    checkCompatibility,
    withCompatibility,
    isCompatibleResult,
    hasBundledArchive,
    probeOpenOcd,
    getCachedResult,
    setCache,
    resetCache,
    persistOpenOcdPath,
    pickOpenOcdPath,
    resolveOpenOcdStatus,
    incompatibleStatus,
    MIN_OPENOCD_VERSION
};
