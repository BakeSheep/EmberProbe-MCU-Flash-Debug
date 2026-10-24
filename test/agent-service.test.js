"use strict";

const { scenario } = require("./helpers/scenario");

const path = require("path");

const assert = require("assert");
const { AgentService } = require("../src/services/agentService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        class FakeBridge {
            constructor(workspace, handler, storageDir) {
                this.workspace = workspace;
                this.handler = handler;
                this.storageDir = storageDir;
                this.stopped = false;
            }
            async start() {
                return { workspace: this.workspace, storageDir: this.storageDir };
            }
            async stop() {
                this.stopped = true;
            }
        }
        const bridgeCalls = [];
        const agent = new AgentService({
            Bridge: FakeBridge,
            workspaceProvider: () => temp,
            storageDirProvider: () => path.join(temp, "global-storage"),
            onCall: (method) => bridgeCalls.push(method),
            onAudit: (entry) => audit.push(entry),
            handlers: {
                "config.get": async () => ({ ok: true }),
                "chip.read": async () => ({ core: "Cortex-M4", pc: "0x1", secret: "hidden" })
            }
        });
        const audit = [];
        assert.strictEqual(agent.isStarted(), false, "constructing the service must not create/start a bridge");
        assert.deepStrictEqual(await agent.call("config.get", { secret: "value" }, { channel: "mcp", client: "c/1" }), {
            ok: true
        });
        // 审计只记录通道、客户端、方法与结果码，不记录参数值
        assert.deepStrictEqual(audit, [{ channel: "mcp", client: "c/1", method: "config.get", code: "OK" }]);
        await assert.rejects(agent.call("missing"));
        assert.deepStrictEqual(audit[1], { channel: "", client: "", method: "missing", code: "METHOD_NOT_FOUND" });
        assert.ok(!JSON.stringify(audit).includes("value"));
        bridgeCalls.length = 0;
        assert.deepStrictEqual(await agent.call("config.get"), { ok: true });
        assert.deepStrictEqual(await agent.call("chip.read", { sections: ["runtime"] }), { pc: "0x1" });
        const capabilities = await agent.call("capabilities");
        assert.deepStrictEqual(capabilities.methods, ["config.get", "chip.read"]);
        await assert.rejects(
            () => agent.call("missing"),
            (error) => error.code === "METHOD_NOT_FOUND"
        );
        // onCall 钩子在每次调用前触发（capabilities 除外），供扩展侧做安全检查
        assert.deepStrictEqual(bridgeCalls, ["config.get", "chip.read"]);
        assert.deepStrictEqual(await agent.start(), { workspace: temp, storageDir: path.join(temp, "global-storage") });
        assert.strictEqual(agent.isStarted(), true);
        const bridge = agent.bridge;
        await agent.stop();
        assert.strictEqual(bridge.stopped, true);
        assert.strictEqual(agent.isStarted(), false);
    } finally {
        fixture.dispose();
    }

    await scenario("Reject calls and startup in untrusted workspaces", async () => {
        let attemptedWrites = 0;
        const untrusted = new AgentService({
            isTrusted: () => false,
            handlers: {
                write: () => {
                    attemptedWrites++;
                }
            }
        });
        await assert.rejects(untrusted.call("write"), { code: "WORKSPACE_UNTRUSTED" });
        await assert.rejects(untrusted.start(), { code: "WORKSPACE_UNTRUSTED" });
        assert.strictEqual(attemptedWrites, 0);
    });

    await scenario("Refuse calls in transit and restarts once shutdown closes the service", async () => {
        let reads = 0;
        let releaseCheck;
        const closing = new AgentService({
            Bridge: class {
                async start() {
                    return {};
                }
                async stop() {}
            },
            workspaceProvider: () => "workspace",
            // The extension's pre-call check is async; shutdown can begin while it runs.
            onCall: () =>
                new Promise((resolve) => {
                    releaseCheck = resolve;
                }),
            handlers: {
                "variables.read": async () => {
                    reads++;
                    return {};
                }
            }
        });
        const inTransit = closing.call("variables.read");
        await new Promise((resolve) => setImmediate(resolve));
        closing.close();
        releaseCheck();
        await assert.rejects(inTransit, { code: "EXTENSION_SHUTTING_DOWN" });
        await assert.rejects(closing.call("variables.read"), { code: "EXTENSION_SHUTTING_DOWN" });
        await assert.rejects(closing.start(), { code: "EXTENSION_SHUTTING_DOWN" });
        assert.strictEqual(reads, 0, "no handler runs after shutdown begins");
        assert.strictEqual(closing.isStarted(), false);
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
