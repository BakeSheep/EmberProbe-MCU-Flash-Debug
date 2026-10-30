"use strict";
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const {
    BRIDGE_PROTOCOL,
    MIN_CLIENT_PROTOCOL,
    REGISTRY_DIR,
    isAlive
} = require("../../skills/_emberprobe/bridge-locator");

// Each extension window registers one record at <globalStorage>/agent-bridges/<instanceId>.json. instanceId is created
// when the window activates and survives Bridge restarts, so the EMBERPROBE_BRIDGE_INSTANCE VS Code injects stays
// valid. While the Bridge runs the record holds port/token; otherwise only a token-free disabled marker remains so
// locators can diagnose precisely.
class BridgeRegistry {
    constructor(options) {
        this.dir = path.join(options.storageDir, REGISTRY_DIR);
        this.instanceId = options.instanceId || crypto.randomBytes(16).toString("hex");
        this.file = path.join(this.dir, `${this.instanceId}.json`);
        this.hostApp = options.hostApp || "";
        this.extensionVersion = options.extensionVersion || "";
        this.queue = Promise.resolve();
    }

    entry(state) {
        const folders = (state.workspaceFolders || []).filter((folder) => typeof folder === "string" && folder);
        const base = {
            protocol: BRIDGE_PROTOCOL,
            minClientProtocol: MIN_CLIENT_PROTOCOL,
            instanceId: this.instanceId,
            pid: process.pid,
            hostApp: this.hostApp,
            extensionVersion: this.extensionVersion,
            primaryWorkspace: folders[0] || "",
            workspaceFolders: folders,
            agentAccess: state.bridge ? "enabled" : state.agentAccess || "disabled",
            updatedAt: new Date().toISOString()
        };
        if (!state.bridge) return base;
        return {
            ...base,
            host: state.bridge.host,
            port: state.bridge.port,
            token: state.bridge.token,
            startedAt: state.bridge.startedAt
        };
    }

    // Writes are serialized and replaced atomically, so readers never see a half-written file.
    publish(state) {
        const run = async () => {
            await fs.mkdir(this.dir, { recursive: true });
            const temp = `${this.file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
            try {
                await fs.writeFile(temp, JSON.stringify(this.entry(state), null, 2), { mode: 0o600 });
                await fs.rename(temp, this.file);
            } catch (error) {
                await fs.unlink(temp).catch(() => {});
                throw error;
            }
        };
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => {});
        return next;
    }

    remove() {
        const run = () => fs.unlink(this.file).catch(() => {});
        const next = this.queue.then(run, run);
        this.queue = next;
        return next;
    }
}

// On startup the extension removes entries whose host process has exited and leftover temporary files; locators never
// delete files.
async function cleanupStaleEntries(storageDir, alive = isAlive) {
    const dir = path.join(storageDir, REGISTRY_DIR);
    let names;
    try {
        names = await fs.readdir(dir);
    } catch {
        return [];
    }
    const removed = [];
    for (const name of names) {
        const file = path.join(dir, name);
        if (name.endsWith(".tmp")) {
            const stat = await fs.stat(file).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > 60000) {
                await fs.unlink(file).catch(() => {});
                removed.push(name);
            }
            continue;
        }
        if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
        let entry;
        try {
            entry = JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
            entry = null;
        }
        if (entry && alive(entry.pid)) continue;
        await fs.unlink(file).catch(() => {});
        removed.push(name);
    }
    return removed;
}

module.exports = { BridgeRegistry, cleanupStaleEntries };
