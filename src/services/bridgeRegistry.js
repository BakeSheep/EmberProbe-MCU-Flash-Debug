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

// 每个扩展窗口在 <globalStorage>/agent-bridges/<instanceId>.json 登记一条记录。instanceId 在窗口
// 激活时生成，Bridge 重启时保持不变，因此 VS Code 注入的 EMBERPROBE_BRIDGE_INSTANCE 一直有效。
// Bridge 运行时记录含 port/token；未运行时只保留不含 token 的“未启用”标记，供定位方给出准确诊断。
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

    // 写入串行化并原子替换，读取方不会看到写了一半的文件。
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

// 扩展启动时清理宿主进程已退出的条目和残留临时文件；定位方本身从不删除文件。
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
