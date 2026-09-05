"use strict";
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
            handlers: {
                "config.get": async () => ({ ok: true }),
                "chip.read": async () => ({ core: "Cortex-M4", pc: "0x1", secret: "hidden" })
            }
        });
        assert.strictEqual(agent.isStarted(), false, "constructing the service must not create/start a bridge");
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
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
