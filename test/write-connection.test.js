"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { connectionIdentity } = require("../skills/_emberprobe/probe-connection");
const { WriteAuthorization, writeConnectionIdentity } = require("../src/writeAuthorization");

(async () => {
    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    let config = {
        debugger: "jlink.cfg",
        mcu: "stm32f1x.cfg",
        transport: "swd",
        probeSerial: "1234",
        adapterSpeedKhz: 100
    };
    provider._debugBridge = {};
    provider._probeConnectionService = new ProbeConnectionService({ getConfig: () => config });
    let writes = 0;
    const session = {
        options: { ...connectionIdentity(config), settingsIdentity: connectionIdentity(config) },
        writeAndVerify: async () => {
            writes++;
            return { before: [], after: [] };
        }
    };
    const plan = {
        elfResult: { elf: { sha256: "elf" } },
        items: [],
        connection: writeConnectionIdentity(session.options)
    };
    await provider._executeWritePlan(session, "test", plan);
    assert.strictEqual(writes, 1);
    provider._managedDebugServer = session;
    assert.deepStrictEqual(provider._sessionWriteConnection(provider._debugBridge), plan.connection);
    provider._managedDebugServer = null;
    await assert.rejects(
        provider._executeWritePlan(session, "test", {
            ...plan,
            connection: { ...plan.connection, probeSerial: "5678" }
        }),
        { code: "WRITE_CONNECTION_CHANGED" }
    );
    config = { ...config, adapterSpeedKhz: 200 };
    await assert.rejects(provider._executeWritePlan(session, "test", plan), { code: "PROBE_SESSION_STALE" });
    assert.strictEqual(writes, 1, "no write reaches hardware after identity or settings change");
    const storage = new Map();
    const auth = new WriteAuthorization({
        get: (key) => storage.get(key),
        update: async (key, value) => storage.set(key, value)
    });
    await auth.trustWorkspace(plan);
    const legacy = { ...storage.get("agent.writeTrusted") };
    delete legacy.connection;
    storage.set("agent.writeTrusted", legacy);
    assert.strictEqual(auth.isTrusted(plan), false, "old ELF-only trust is invalidated");
    const dapPlan = { ...plan, connection: { kind: "dap", sessionId: "session-a", workspace: "workspace" } };
    const request = auth.authorize(dapPlan).response;
    assert.throws(
        () =>
            auth.authorize(
                { ...dapPlan, connection: { ...dapPlan.connection, sessionId: "session-b" } },
                { confirmationId: request.confirmationId }
            ),
        { code: "WRITE_CONFIRMATION_INVALID" }
    );
    assert.throws(() => auth.authorize({ ...plan, connection: null }), { code: "WRITE_CONNECTION_REQUIRED" });
    console.log("Write connection binding, stale sessions and legacy trust tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
