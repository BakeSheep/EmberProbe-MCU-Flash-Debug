"use strict";
// Bridge 定位：注册表匹配、最长前缀、win32 大小写、歧义、陈旧条目、向上查找指针、协议错配，
// 以及客户端请求头与连接被拒后的安全重试。只使用本机 http 服务器与临时目录。
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const locator = require("../skills/_emberprobe/bridge-locator");
const { callVia, call } = require("../skills/_emberprobe/agent-client");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-locator-")));
const registry = path.join(root, "registry");
const otherRegistry = path.join(root, "registry-cursor");
fs.mkdirSync(registry);
fs.mkdirSync(otherRegistry);
process.env.EMBERPROBE_BRIDGE_REGISTRY = [registry, otherRegistry].join(path.delimiter);
delete process.env.EMBERPROBE_BRIDGE_INSTANCE;
delete process.env.EMBERPROBE_WORKSPACE;

const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
let counter = 0;
function instanceId() {
    return (++counter).toString(16).padStart(32, "0");
}
function writeEntry(dir, fields) {
    const id = fields.instanceId || instanceId();
    const entry = {
        protocol: locator.BRIDGE_PROTOCOL,
        minClientProtocol: locator.MIN_CLIENT_PROTOCOL,
        instanceId: id,
        pid: process.pid,
        hostApp: "Visual Studio Code",
        startedAt: new Date().toISOString(),
        host: "127.0.0.1",
        port: 1,
        token: "token-" + id,
        ...fields
    };
    entry.primaryWorkspace ??= entry.workspaceFolders?.[0] || "";
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(entry));
    return entry;
}
function clearRegistries() {
    for (const dir of [registry, otherRegistry])
        for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
}
function folder(...parts) {
    const target = path.join(root, ...parts);
    fs.mkdirSync(target, { recursive: true });
    return target;
}
function startServer(reply = (method) => ({ method })) {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push({ headers: request.headers, payload });
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ ok: true, result: reply(payload.method, payload.params) }));
        });
    });
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }))
    );
}

(async () => {
    try {
        const project = folder("work", "project");
        const nested = folder("work", "project", "firmware", "src");
        const library = folder("libs", "hal");

        await scenario("Pick the registry entry with the longest matching workspace folder", () => {
            clearRegistries();
            writeEntry(registry, { workspaceFolders: [path.join(root, "work")], port: 1001 });
            const best = writeEntry(otherRegistry, { workspaceFolders: [project], port: 1002 });
            const located = locator.locate(nested);
            assert.strictEqual(located.source, "registry");
            assert.strictEqual(located.instanceId, best.instanceId);
            assert.strictEqual(located.descriptor.port, 1002);
            assert.strictEqual(located.secondaryRoot, false);
        });

        await scenario("Report the primary root when a secondary folder matches", () => {
            clearRegistries();
            writeEntry(registry, { workspaceFolders: [project, library], port: 1003 });
            const located = locator.locate(library);
            assert.strictEqual(located.secondaryRoot, true);
            assert.strictEqual(located.primaryWorkspace, project);
            assert.strictEqual(located.matchedRoot, library);
        });

        await scenario("Match folders case-insensitively on Windows or case-insensitive filesystems", () => {
            clearRegistries();
            const upper = project.toUpperCase();
            writeEntry(registry, { workspaceFolders: [upper], port: 1004 });
            // macOS APFS 默认不区分大小写：realpath 会把大写路径解析回磁盘上的实际目录
            let sameDirectory = false;
            try {
                sameDirectory = fs.realpathSync.native(upper) === fs.realpathSync.native(project);
            } catch {
                /* 区分大小写的文件系统上大写路径不存在 */
            }
            if (process.platform === "win32" || sameDirectory)
                assert.strictEqual(locator.locate(nested).descriptor.port, 1004);
            else assert.throws(() => locator.locate(nested), { code: "BRIDGE_UNAVAILABLE" });
        });

        await scenario("Refuse to choose between windows that opened the same folder", () => {
            clearRegistries();
            const first = writeEntry(registry, { workspaceFolders: [project], hostApp: "Visual Studio Code" });
            const second = writeEntry(otherRegistry, { workspaceFolders: [project], hostApp: "Cursor" });
            assert.throws(
                () => locator.locate(nested),
                (error) => {
                    assert.strictEqual(error.code, "BRIDGE_AMBIGUOUS");
                    const ids = error.details.instances.map((item) => item.instanceId).sort();
                    assert.deepStrictEqual(ids, [first.instanceId, second.instanceId].sort());
                    assert.ok(error.details.instances.every((item) => item.hostApp && item.pid && !item.token));
                    return true;
                }
            );
            // 显式指定实例时不做路径匹配
            assert.strictEqual(locator.locate(nested, { instance: second.instanceId }).instanceId, second.instanceId);
            process.env.EMBERPROBE_BRIDGE_INSTANCE = first.instanceId;
            try {
                assert.strictEqual(locator.locate(root).instanceId, first.instanceId);
            } finally {
                delete process.env.EMBERPROBE_BRIDGE_INSTANCE;
            }
            assert.throws(() => locator.locate(nested, { instance: "f".repeat(32) }), { code: "BRIDGE_UNAVAILABLE" });
        });

        await scenario("Ignore entries whose host process has exited", () => {
            clearRegistries();
            writeEntry(registry, { workspaceFolders: [project], pid: deadPid, port: 1005 });
            const live = writeEntry(otherRegistry, { workspaceFolders: [project], port: 1006 });
            assert.strictEqual(locator.locate(nested).instanceId, live.instanceId);
            assert.strictEqual(fs.readdirSync(registry).length, 1, "the locator never deletes registry files");
        });

        await scenario("Explain a workspace whose Agent access is disabled", () => {
            clearRegistries();
            writeEntry(registry, {
                workspaceFolders: [project],
                host: undefined,
                port: undefined,
                token: undefined,
                agentAccess: "disabled"
            });
            assert.throws(
                () => locator.locate(nested),
                (error) =>
                    error.code === "BRIDGE_UNAVAILABLE" &&
                    error.details.bridgeDisabledFor === project &&
                    error.details.registryEntries === 1 &&
                    error.details.searchedFrom === nested
            );
            // 运行中的实例优先于同一文件夹的未启用标记
            const live = writeEntry(otherRegistry, { workspaceFolders: [project] });
            assert.strictEqual(locator.locate(nested).instanceId, live.instanceId);
        });

        await scenario("Reject incompatible protocol ranges", () => {
            clearRegistries();
            writeEntry(registry, { workspaceFolders: [project], minClientProtocol: locator.CLIENT_PROTOCOL + 1 });
            assert.throws(
                () => locator.locate(nested),
                (error) =>
                    error.code === "BRIDGE_PROTOCOL_MISMATCH" &&
                    error.details.clientProtocol === locator.CLIENT_PROTOCOL
            );
            clearRegistries();
            writeEntry(registry, { workspaceFolders: [project], protocol: 1, minClientProtocol: undefined });
            assert.strictEqual(locator.locate(nested).source, "registry", "protocol 1 Bridges stay compatible");
        });

        await scenario("Fall back to a workspace pointer found in an ancestor directory", () => {
            clearRegistries();
            const descriptorPath = path.join(root, "storage", "agent-bridge-0123456789abcdef.json");
            fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
            fs.writeFileSync(
                descriptorPath,
                JSON.stringify({ protocol: 2, host: "127.0.0.1", port: 1007, token: "t" })
            );
            const pointer = path.join(project, ".agents", "skills", "_emberprobe", "agent-bridge.json");
            fs.mkdirSync(path.dirname(pointer), { recursive: true });
            fs.writeFileSync(pointer, JSON.stringify({ protocol: 1, descriptorPath }));
            const located = locator.locate(nested);
            assert.strictEqual(located.source, "pointer");
            assert.strictEqual(located.descriptor.port, 1007);
            // 指针旁的 globalStorage 注册表也会被搜索，即使没有设置环境变量
            const saved = process.env.EMBERPROBE_BRIDGE_REGISTRY;
            const pointerRegistry = path.join(root, "storage", locator.REGISTRY_DIR);
            fs.mkdirSync(pointerRegistry);
            process.env.EMBERPROBE_BRIDGE_REGISTRY = path.join(root, "missing");
            try {
                writeEntry(pointerRegistry, { workspaceFolders: [project], port: 1008 });
                assert.strictEqual(locator.locate(nested).descriptor.port, 1008);
            } finally {
                process.env.EMBERPROBE_BRIDGE_REGISTRY = saved;
                fs.rmSync(pointerRegistry, { recursive: true, force: true });
            }
            fs.writeFileSync(descriptorPath, JSON.stringify({ host: "127.0.0.1", port: 1007 }));
            assert.throws(() => locator.locate(nested), { code: "BRIDGE_DESCRIPTOR_INVALID" });
            fs.rmSync(path.join(project, ".agents"), { recursive: true, force: true });
            assert.throws(
                () => locator.locate(nested),
                (error) => error.code === "BRIDGE_UNAVAILABLE" && error.details.registryEntries === 0
            );
        });

        await scenario("Prefer EMBERPROBE_WORKSPACE over the default working directory", () => {
            const cwd = path.resolve(process.cwd());
            assert.strictEqual(locator.resolveTarget(undefined, {}), cwd);
            assert.strictEqual(locator.resolveTarget(cwd, { EMBERPROBE_WORKSPACE: project }), project);
            assert.strictEqual(locator.resolveTarget(library, { EMBERPROBE_WORKSPACE: project }), library);
        });

        await scenario("Send channel headers and retry a refused registry entry", async () => {
            clearRegistries();
            const live = await startServer((method) => ({ method }));
            const closed = await startServer();
            const closedPort = closed.port;
            await new Promise((resolve) => closed.server.close(resolve));
            try {
                // 关闭端口的条目最长匹配，连接被拒后排除它，再连到下一个匹配实例
                writeEntry(registry, { workspaceFolders: [nested], port: closedPort });
                writeEntry(otherRegistry, { workspaceFolders: [library, project], port: live.port });
                const result = await call(nested, "config.get", {});
                assert.deepStrictEqual(result, {
                    method: "config.get",
                    bridge: { workspace: library, notice: "BRIDGE_SECONDARY_ROOT" }
                });
                const headers = live.requests[0].headers;
                assert.strictEqual(headers["x-emberprobe-channel"], "skill");
                assert.strictEqual(
                    decodeURIComponent(headers["x-emberprobe-skill-root"]),
                    path.resolve(__dirname, "..", "skills")
                );
                await callVia({ name: "mcp", client: "客户端/1.0" }, nested, "debug.status", {});
                const mcp = live.requests[1].headers;
                assert.strictEqual(mcp["x-emberprobe-channel"], "mcp");
                assert.strictEqual(decodeURIComponent(mcp["x-emberprobe-client"]), "客户端/1.0");
                assert.strictEqual(mcp["x-emberprobe-skill-root"], undefined);
                // 数组结果保持原样，不附加 bridge 字段
                live.requests.length = 0;
                clearRegistries();
                writeEntry(registry, { workspaceFolders: [library, project], port: live.port });
                const array = await startServer(() => [1, 2]);
                writeEntry(otherRegistry, { workspaceFolders: [library, nested], port: array.port });
                assert.deepStrictEqual(await call(nested, "probe.list", {}), [1, 2]);
                array.server.close();
            } finally {
                live.server.close();
            }
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("Bridge locator tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
