"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { AgentService } = require("../src/services/agentService");

function shutdownFixture() {
    const Provider = loadProvider({ debug: {}, workspace: {} });
    const p = Object.create(Provider.prototype);
    const order = [];
    let bridgeStopped = false;
    const agentService = new AgentService({
        Bridge: class {
            async start() {
                return {};
            }
            async stop() {
                bridgeStopped = true;
                order.push("bridge-stopped");
            }
        },
        workspaceProvider: () => "workspace",
        handlers: { "variables.read": async () => p._probeCoordinator.acquire("agentRead") }
    });
    Object.assign(p, {
        _probeCoordinator: new ProbeCoordinator(),
        _agentService: agentService,
        _debugBridge: { activeSession: null },
        _elfService: { invalidate() {} },
        _cubemxService: { cancel() {} },
        _samplingArchive: { dispose: async () => {} },
        _chartHistory: null,
        finishForeignDebug() {},
        _clearDebugStartupWatchdog() {},
        _stopJlinkDriverMonitor() {},
        _flushPendingChartHistorySamples: async () => {},
        disposeDebugBridge: () => order.push("debug-bridge-disposed"),
        stopAgentReadIfRunning: () => {
            order.push("agent-read-stopped");
            return null;
        },
        _stopManagedDebugServer: async () => order.push("debug-server-stopped"),
        stopLiveWatch: () => {
            order.push("live-stopped");
            return null;
        }
    });
    return { p, order, agentService, bridgeStopped: () => bridgeStopped };
}

(async () => {
    await scenario("Close Agent access and the probe before stopping sampling and debugging", async () => {
        const { p, order, agentService, bridgeStopped } = shutdownFixture();
        await agentService.start();
        await p.shutdown();
        assert.ok(bridgeStopped());
        assert.deepStrictEqual(order.slice(0, 2), ["bridge-stopped", "agent-read-stopped"]);
        assert.ok(order.indexOf("bridge-stopped") < order.indexOf("debug-server-stopped"));
        assert.ok(order.indexOf("bridge-stopped") < order.indexOf("live-stopped"));
        assert.ok(!order.slice(2).includes("agent-read-stopped"), "the read is cancelled once, before cleanup");
        // An Agent call accepted just before shutdown cannot run, start the Bridge again or take a probe lease.
        await assert.rejects(agentService.call("variables.read"), { code: "EXTENSION_SHUTTING_DOWN" });
        await assert.rejects(agentService.start(), { code: "EXTENSION_SHUTTING_DOWN" });
        assert.throws(() => p._probeCoordinator.acquire("agentRead"), { activeOperation: "shutdown" });
        assert.strictEqual(p.shutdown(), p._shutdownPromise, "shutdown runs once");
    });

    await scenario("Finish cleanup when the Agent read exit cannot be confirmed", async () => {
        const { p, order } = shutdownFixture();
        const errors = [];
        const originalError = console.error;
        console.error = (...args) => errors.push(args);
        p.stopAgentReadIfRunning = () => {
            order.push("agent-read-stopped");
            return Promise.reject(Object.assign(new Error("unconfirmed"), { code: "PROBE_EXIT_UNCONFIRMED" }));
        };
        try {
            await p.shutdown();
        } finally {
            console.error = originalError;
        }
        assert.ok(order.includes("debug-server-stopped") && order.includes("live-stopped"));
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0][1].code, "PROBE_EXIT_UNCONFIRMED");
    });

    console.log("Extension shutdown order tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
