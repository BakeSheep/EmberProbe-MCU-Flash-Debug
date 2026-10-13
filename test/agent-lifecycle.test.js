"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { AgentService } = require("../src/services/agentService");
const { AgentBridge } = require("../src/agentBridge");
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

    console.log("Real Agent server failure, retry and connection cleanup tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
