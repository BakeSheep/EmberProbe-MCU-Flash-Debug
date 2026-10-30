"use strict";
// Agent Bridge locator shared by skill scripts and the MCP server. It prefers the instance registry the extension
// writes in globalStorage, matched by the longest workspace-folder prefix, and falls back to the workspace pointer
// (searched upwards). It only reads files and never deletes stale entries.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { leavesDirectory } = require("./file-identity");

// The Bridge declares protocol / minClientProtocol; the client declares its own protocol and the lowest Bridge protocol
// it accepts.
const BRIDGE_PROTOCOL = 2;
const MIN_CLIENT_PROTOCOL = 1;
const CLIENT_PROTOCOL = 2;
const MIN_BRIDGE_PROTOCOL = 1;
const EXTENSION_IDS = ["bakesheep.emberprobe", "BakeSheep.emberprobe"];
const REGISTRY_DIR = "agent-bridges";
const MAX_ENTRY_BYTES = 64 * 1024;

function bridgeError(code, message, details) {
    return Object.assign(new Error(message), { code, details });
}

function canonicalPath(value) {
    let resolved = path.resolve(String(value));
    try {
        resolved = fs.realpathSync.native(resolved);
    } catch {
        /* Paths that do not exist are compared literally */
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// True for root itself or any ancestor; both should already be canonicalPath results.
function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || !leavesDirectory(relative);
}

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

// Without an explicit --workspace (scripts pass cwd by default), EMBERPROBE_WORKSPACE takes precedence over cwd.
function resolveTarget(workspace, env = process.env) {
    const cwd = path.resolve(process.cwd());
    const explicit = workspace ? path.resolve(workspace) : "";
    if (explicit && explicit !== cwd) return explicit;
    return env.EMBERPROBE_WORKSPACE ? path.resolve(env.EMBERPROBE_WORKSPACE) : explicit || cwd;
}

function storageCandidates(userDir) {
    return EXTENSION_IDS.map((id) => path.join(userDir, "User", "globalStorage", id, REGISTRY_DIR));
}

function listDir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// Each host (VS Code, Insiders, Cursor, VSCodium, remote servers, ...) has its own globalStorage. Scan the known
// user-data roots instead of hard-coding host names.
function wellKnownRegistryDirs(env = process.env, platform = process.platform) {
    const home = os.homedir();
    const bases = [];
    if (platform === "win32") bases.push(env.APPDATA || path.join(home, "AppData", "Roaming"));
    else if (platform === "darwin") bases.push(path.join(home, "Library", "Application Support"));
    else bases.push(env.XDG_CONFIG_HOME || path.join(home, ".config"));
    const dirs = [];
    for (const base of bases)
        for (const entry of listDir(base))
            if (entry.isDirectory()) dirs.push(...storageCandidates(path.join(base, entry.name)));
    for (const entry of listDir(home))
        if (entry.isDirectory() && /^\.[\w.-]+-server(-insiders)?$/.test(entry.name))
            dirs.push(...storageCandidates(path.join(home, entry.name, "data")));
    return dirs;
}

// When EMBERPROBE_BRIDGE_REGISTRY (path.delimiter separated) is set, only those directories are searched; tests and
// controlled environments use it for isolation.
function registryDirs(options = {}) {
    const env = options.env || process.env;
    const dirs = [];
    if (env.EMBERPROBE_BRIDGE_REGISTRY)
        dirs.push(...env.EMBERPROBE_BRIDGE_REGISTRY.split(path.delimiter).filter(Boolean));
    else dirs.push(...wellKnownRegistryDirs(env));
    dirs.push(...(options.extraDirs || []));
    const seen = new Set();
    return dirs.filter((dir) => {
        const key = canonicalPath(dir);
        if (seen.has(key) || !fs.existsSync(dir)) return false;
        seen.add(key);
        return true;
    });
}

function readJson(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) throw new Error("Registry entry is not a small file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readRegistry(dirs) {
    const entries = [];
    for (const dir of dirs) {
        for (const item of listDir(dir)) {
            if (!item.isFile() || !/^[0-9a-f]{32}\.json$/.test(item.name)) continue;
            try {
                const entry = readJson(path.join(dir, item.name));
                if (entry && typeof entry === "object" && entry.instanceId === item.name.slice(0, -5))
                    entries.push({ ...entry, registryFile: path.join(dir, item.name) });
            } catch {
                /* Skip entries that are being replaced atomically or are corrupt */
            }
        }
    }
    return entries;
}

function hasEndpoint(entry) {
    return entry.host === "127.0.0.1" && Number.isInteger(entry.port) && entry.port > 0 && !!entry.token;
}

function checkProtocol(value, file) {
    const protocol = Number.isInteger(value.protocol) ? value.protocol : 1;
    const minClient = Number.isInteger(value.minClientProtocol) ? value.minClientProtocol : 1;
    if (minClient > CLIENT_PROTOCOL || protocol < MIN_BRIDGE_PROTOCOL)
        throw bridgeError("BRIDGE_PROTOCOL_MISMATCH", "EmberProbe Agent Bridge protocol is incompatible", {
            bridgeProtocol: protocol,
            minClientProtocol: minClient,
            clientProtocol: CLIENT_PROTOCOL,
            minBridgeProtocol: MIN_BRIDGE_PROTOCOL,
            extensionVersion: value.extensionVersion || "",
            descriptor: file
        });
}

function summarize(entry) {
    return {
        instanceId: entry.instanceId,
        hostApp: entry.hostApp || "",
        pid: entry.pid,
        startedAt: entry.startedAt || "",
        primaryWorkspace: entry.primaryWorkspace || ""
    };
}

function fromRegistry(entry, source, matchedRoot) {
    if (!hasEndpoint(entry))
        throw bridgeError("BRIDGE_DESCRIPTOR_INVALID", "Invalid EmberProbe Agent Bridge descriptor", {
            descriptor: entry.registryFile
        });
    checkProtocol(entry, entry.registryFile);
    const primary = entry.primaryWorkspace || "";
    const secondaryRoot = !!matchedRoot && !!primary && canonicalPath(matchedRoot) !== canonicalPath(primary);
    return {
        descriptor: {
            protocol: entry.protocol,
            host: entry.host,
            port: entry.port,
            token: entry.token,
            pid: entry.pid,
            workspace: primary
        },
        source,
        instanceId: entry.instanceId,
        hostApp: entry.hostApp || "",
        primaryWorkspace: primary,
        matchedRoot: matchedRoot || primary,
        secondaryRoot
    };
}

function findPointer(target) {
    let current = target;
    for (;;) {
        for (const file of [
            path.join(current, ".agents", "skills", "_emberprobe", "agent-bridge.json"),
            path.join(current, ".emberprobe", "agent-bridge.json")
        ])
            if (fs.existsSync(file)) return { root: current, file };
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

// Older format: the workspace file is a pointer (no token) to the real descriptor in the user directory; the oldest
// format stored the token directly.
function readPointer(found) {
    let pointer;
    try {
        pointer = readJson(found.file);
    } catch {
        throw bridgeError("BRIDGE_UNAVAILABLE", "EmberProbe Agent Bridge descriptor is unavailable.", {
            descriptor: found.file
        });
    }
    const file =
        typeof pointer.descriptorPath === "string" && pointer.descriptorPath ? pointer.descriptorPath : found.file;
    let value;
    try {
        value = file === found.file ? pointer : readJson(file);
    } catch {
        throw bridgeError("BRIDGE_DESCRIPTOR_INVALID", "Invalid EmberProbe Agent Bridge descriptor", {
            descriptor: file
        });
    }
    if (value.host !== "127.0.0.1" || !Number.isInteger(value.port) || !value.token)
        throw bridgeError("BRIDGE_DESCRIPTOR_INVALID", "Invalid EmberProbe Agent Bridge descriptor", {
            descriptor: file
        });
    checkProtocol(value, file);
    return { value, file };
}

// Longest-prefix match; only reachable instances compete, and stopped windows are used for diagnostics only.
function matchRegistry(entries, target, exclude) {
    let best = [];
    let bestLength = -1;
    let disabled = null;
    for (const entry of entries) {
        if (exclude.has(entry.instanceId) || !isAlive(entry.pid)) continue;
        const folders = Array.isArray(entry.workspaceFolders) ? entry.workspaceFolders : [];
        let length = -1;
        let matchedRoot = "";
        for (const folder of folders) {
            if (typeof folder !== "string" || !folder) continue;
            const root = canonicalPath(folder);
            if (isWithin(root, target) && root.length > length) {
                length = root.length;
                matchedRoot = folder;
            }
        }
        if (length < 0) continue;
        if (!hasEndpoint(entry)) {
            if (!disabled || length > disabled.length) disabled = { length, entry };
            continue;
        }
        if (length > bestLength) {
            best = [{ entry, matchedRoot }];
            bestLength = length;
        } else if (length === bestLength) best.push({ entry, matchedRoot });
    }
    return { best, disabled: disabled && disabled.length >= bestLength ? disabled.entry : null };
}

function locate(workspace, options = {}) {
    const env = options.env || process.env;
    const exclude = options.exclude || new Set();
    const requested = resolveTarget(workspace, env);
    const target = canonicalPath(requested);
    const pointer = findPointer(path.resolve(requested));
    const extraDirs = [];
    if (pointer) {
        try {
            const value = readJson(pointer.file);
            if (typeof value.descriptorPath === "string" && value.descriptorPath)
                extraDirs.push(path.join(path.dirname(value.descriptorPath), REGISTRY_DIR));
        } catch {
            /* A corrupt pointer is diagnosed by the fallback path */
        }
    }
    const entries = readRegistry(registryDirs({ env, extraDirs }));
    const instance = options.instance ?? env.EMBERPROBE_BRIDGE_INSTANCE;
    if (instance) {
        const entry = entries.find((item) => item.instanceId === instance);
        if (!entry || !isAlive(entry.pid) || exclude.has(entry.instanceId))
            throw bridgeError("BRIDGE_UNAVAILABLE", "The selected EmberProbe Agent Bridge instance is not running.", {
                searchedFrom: requested,
                instance,
                registryEntries: entries.length
            });
        if (!hasEndpoint(entry))
            throw bridgeError("BRIDGE_UNAVAILABLE", "Agent access is not enabled for the selected EmberProbe window.", {
                searchedFrom: requested,
                instance,
                registryEntries: entries.length,
                bridgeDisabledFor: entry.primaryWorkspace || "",
                reason: entry.agentAccess || "disabled"
            });
        const located = fromRegistry(entry, "instance", "");
        located.secondaryRoot = false;
        return located;
    }
    const { best, disabled } = matchRegistry(entries, target, exclude);
    if (best.length > 1)
        throw bridgeError(
            "BRIDGE_AMBIGUOUS",
            "Several EmberProbe windows have this folder open; choose one explicitly.",
            { searchedFrom: requested, instances: best.map(({ entry }) => summarize(entry)) }
        );
    if (best.length === 1) return fromRegistry(best[0].entry, "registry", best[0].matchedRoot);
    if (pointer && !exclude.has(`pointer:${pointer.file}`)) {
        const { value, file } = readPointer(pointer);
        return {
            descriptor: value,
            source: "pointer",
            pointerFile: file,
            instanceId: `pointer:${pointer.file}`,
            hostApp: "",
            primaryWorkspace: value.workspace || pointer.root,
            matchedRoot: pointer.root,
            secondaryRoot: false
        };
    }
    throw bridgeError("BRIDGE_UNAVAILABLE", "EmberProbe Agent Bridge descriptor is unavailable.", {
        searchedFrom: requested,
        registryEntries: entries.length,
        ...(disabled
            ? { bridgeDisabledFor: disabled.primaryWorkspace || "", reason: disabled.agentAccess || "disabled" }
            : {})
    });
}

module.exports = {
    BRIDGE_PROTOCOL,
    MIN_CLIENT_PROTOCOL,
    CLIENT_PROTOCOL,
    MIN_BRIDGE_PROTOCOL,
    REGISTRY_DIR,
    canonicalPath,
    isWithin,
    isAlive,
    resolveTarget,
    registryDirs,
    wellKnownRegistryDirs,
    readRegistry,
    checkProtocol,
    locate
};
