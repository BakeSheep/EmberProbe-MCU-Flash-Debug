"use strict";
const assert = require("assert");
const { createFixture } = require("./helpers/service-fixture");
const { AgentService } = require("../src/services/agentService");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
};
(async () => {
    const fixture = createFixture();
    try {
        const { store, state, settings, context, vscode } = fixture;
        await assert.rejects(
            store.update({ debugger: "stlink.cfg", sampleIntervalMs: 0 }),
            (error) => error.code === "INVALID_CONFIG_VALUE"
        );
        assert.strictEqual(state.size, 0);
        const original = context.workspaceState.update;
        context.workspaceState.update = async (key, value) => {
            if (key === "mcu" && value === "bad.cfg") throw Error("disk error");
            return original(key, value);
        };
        await assert.rejects(
            store.update({ debugger: "stlink.cfg", mcu: "bad.cfg" }),
            (error) => error.code === "CONFIG_UPDATE_FAILED" && error.details.rollbackErrors.length === 0
        );
        assert.strictEqual(state.get("debugger"), undefined);
        context.workspaceState.update = async (key, value) => {
            if (key === "mcu" || value === undefined) throw Error("disk error");
            return original(key, value);
        };
        await assert.rejects(
            store.update({ debugger: "stlink.cfg", mcu: "bad.cfg" }),
            (error) => error.details.rollbackErrors.length === 2 && error.details.actual.debugger === "stlink.cfg"
        );
        context.workspaceState.update = original;
        await Promise.all([store.update({ sampleIntervalMs: 25 }), store.update({ sampleIntervalMs: 50 })]);
        assert.strictEqual(settings.get("sampleIntervalMs"), 50);
        await assert.rejects(store.update(null), (error) => error.code === "INVALID_CONFIG_VALUE");
    } finally {
        fixture.dispose();
    }
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
    const sampling = new SamplingCoordinator();
    const bridge = new DebugSessionBridge();
    try {
        bridge.sessions.set("session", { id: "session" });
        bridge.intentEnabled = true;
        bridge.capabilities.read = true;
        const server = {
            samplingEnabled: true,
            setSamplingEnabled(value) {
                this.samplingEnabled = value;
                return value;
            }
        };
        const status = () => sampling.status({ intent: true, bridge, managedServer: server });
        assert.strictEqual(status().mode, "debug-running-sampling");
        sampling.setBackpressure(true);
        sampling.setDebugIntent(bridge, true);
        sampling.setRuntimeEnabled(server, true, bridge);
        assert.strictEqual(bridge.intentEnabled, false);
        assert.strictEqual(server.samplingEnabled, false);
        sampling.setDebugIntent(bridge, true);
        assert.strictEqual(bridge.intentEnabled, false);
        assert.strictEqual(status().canRead, false);
        sampling.setBackpressure(false);
        bridge.paused = true;
        assert.strictEqual(sampling.setRuntimeEnabled(server, true, bridge), false);
        bridge.paused = false;
        bridge.transitionKind = "continue";
        assert.strictEqual(sampling.setRuntimeEnabled(server, true, bridge), false);
        bridge.transitionKind = "";
        assert.strictEqual(sampling.setRuntimeEnabled(server, true, bridge), true);
        assert.strictEqual(status().source, "openocd");
        assert.strictEqual(
            sampling.status({ intent: false, bridge: { hasSession: false }, standaloneRunning: false }).mode,
            "stopped"
        );
    } finally {
        bridge.dispose();
    }
    console.log("Configuration, Agent lifecycle and sampling regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
