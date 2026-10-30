"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { AgentService } = require("../src/services/agentService");
const { AgentBridge } = require("../src/agentBridge");
const { BridgeRegistry, cleanupStaleEntries } = require("../src/services/bridgeRegistry");
const locator = require("../skills/_emberprobe/bridge-locator");
const { call } = require("../skills/_emberprobe/agent-client");
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-agent-lifecycle-"));
    const instances = [];
    class Bridge extends AgentBridge {
        constructor(...args) {
            super(...args);
            instances.push(this);
        }
    }
    let storage = path.join(root, "blocked");
    fs.writeFileSync(storage, "not a directory");
    const agent = new AgentService({
        Bridge,
        workspaceProvider: () => root,
        storageDirProvider: () => storage,
        handlers: {}
    });
    let socket;
    try {
        await assert.rejects(agent.start());
        assert.strictEqual(instances[0].server, null);
        assert.strictEqual(agent.isStarted(), false);
        storage = path.join(root, "storage");
        const descriptor = await agent.start();
        assert.ok(descriptor.port > 0);
        socket = net.connect({ host: "127.0.0.1", port: descriptor.port });
        socket.on("error", (error) => {
            if (!["ECONNRESET", "EPIPE"].includes(error.code)) throw error;
        });
        await new Promise((resolve) => socket.once("connect", resolve));
        socket.write("POST /v1/call HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n");
        await agent.stop();
        assert.strictEqual(instances[1].server, null);
        assert.strictEqual(fs.existsSync(instances[1].descriptorPath), false);
        assert.strictEqual(fs.existsSync(instances[1].pointerPath), false);
        await agent.start();
        await agent.stop();
    } finally {
        socket?.destroy();
        await agent.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }

    await scenario("Retry failed starts and stop an in-progress Agent start", async () => {
        const deferred = () => {
            let resolve, reject;
            const promise = new Promise((a, b) => {
                resolve = a;
                reject = b;
            });
            return { promise, resolve, reject };
        };
        let stops = 0,
            attempts = 0;
        let gate = deferred();
        class Bridge {
            async start() {
                attempts++;
                return gate.promise;
            }
            async stop() {
                stops++;
            }
        }
        const agent = new AgentService({ Bridge, workspaceProvider: () => "workspace", handlers: {} });
        const first = agent.start();
        assert.strictEqual(first, agent.start());
        assert.strictEqual(agent.isStarted(), false);
        gate.reject(Error("failed"));
        await assert.rejects(first, /failed/);
        assert.strictEqual(stops, 1);
        gate = deferred();
        const second = agent.start();
        gate.resolve({ ok: true });
        await second;
        assert.strictEqual(agent.isStarted(), true);
        await agent.stop();
        assert.strictEqual(agent.isStarted(), false);
        gate = deferred();
        const third = agent.start();
        const stopped = agent.stop();
        gate.resolve({ ok: true });
        assert.strictEqual(await third, null);
        await stopped;
        assert.strictEqual(agent.isStarted(), false);
        gate = deferred();
        const fourth = agent.start();
        gate.resolve({ ok: true });
        await fourth;
        assert.strictEqual(attempts, 4);
        await agent.stop();
    });

    await scenario("Keep both windows discoverable when two hosts open the same folder", async () => {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-agent-two-hosts-")));
        const workspace = path.join(base, "project");
        fs.mkdirSync(workspace);
        const storages = [path.join(base, "vscode"), path.join(base, "cursor")];
        const saved = process.env.EMBERPROBE_BRIDGE_REGISTRY;
        process.env.EMBERPROBE_BRIDGE_REGISTRY = storages
            .map((dir) => path.join(dir, locator.REGISTRY_DIR))
            .join(path.delimiter);
        const [first, second] = storages.map(
            (storageDir, index) =>
                new AgentService({
                    Bridge: AgentBridge,
                    workspaceProvider: () => workspace,
                    storageDirProvider: () => storageDir,
                    registry: new BridgeRegistry({ storageDir, hostApp: index ? "Cursor" : "Visual Studio Code" }),
                    handlers: { "config.get": () => ({ host: index ? "cursor" : "vscode" }) }
                })
        );
        try {
            await first.start({ legacyPointer: true });
            await second.start({ legacyPointer: true });
            await assert.rejects(call(workspace, "config.get"), { code: "BRIDGE_AMBIGUOUS" });
            // When the later instance stops it removes only its own entry and the earlier one stays discoverable (it
            // deletes the legacy pointer, a leftover issue of old clients)
            await second.stop();
            assert.deepStrictEqual(await call(workspace, "config.get"), { host: "vscode" });
            const marker = JSON.parse(fs.readFileSync(second.registry.file, "utf8"));
            assert.strictEqual(marker.agentAccess, "disabled");
            assert.strictEqual(marker.token, undefined, "a stopped window must not leave its token behind");
            await second.start();
            await first.dispose();
            assert.strictEqual(fs.existsSync(first.registry.file), false);
            assert.deepStrictEqual(await call(workspace, "config.get"), { host: "cursor" });
            const entry = JSON.parse(fs.readFileSync(second.registry.file, "utf8"));
            assert.strictEqual(entry.instanceId, second.instanceId(), "restarts keep the window instance id");
            assert.strictEqual((await second.call("capabilities")).protocol, locator.BRIDGE_PROTOCOL);
            if (process.platform !== "win32") assert.strictEqual(fs.statSync(second.registry.file).mode & 0o777, 0o600);
            // A Bridge that writes no legacy pointer is discoverable only through the registry
            await second.stop();
            await second.start({ legacyPointer: false });
            assert.strictEqual(
                fs.existsSync(path.join(workspace, ".agents", "skills", "_emberprobe", "agent-bridge.json")),
                false
            );
            assert.deepStrictEqual(await call(workspace, "config.get"), { host: "cursor" });
            await second.start({ legacyPointer: true });
            assert.ok(fs.existsSync(path.join(workspace, ".agents", "skills", "_emberprobe", "agent-bridge.json")));
        } finally {
            await first.dispose();
            await second.dispose();
            process.env.EMBERPROBE_BRIDGE_REGISTRY = saved;
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    await scenario("Clean registry entries whose host process exited", async () => {
        const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-agent-registry-clean-"));
        try {
            const live = new BridgeRegistry({ storageDir });
            const dead = new BridgeRegistry({ storageDir });
            await live.publish({ workspaceFolders: [storageDir] });
            await dead.publish({ workspaceFolders: [storageDir] });
            fs.writeFileSync(path.join(live.dir, "ffffffffffffffffffffffffffffffff.json"), "not json");
            const removed = await cleanupStaleEntries(storageDir, () => false);
            assert.strictEqual(removed.length, 3);
            await live.publish({ workspaceFolders: [storageDir] });
            assert.deepStrictEqual(await cleanupStaleEntries(storageDir), []);
            assert.ok(fs.existsSync(live.file));
        } finally {
            fs.rmSync(storageDir, { recursive: true, force: true });
        }
    });

    console.log("Real Agent server failure, retry and connection cleanup tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
