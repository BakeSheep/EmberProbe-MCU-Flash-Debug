"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { connectionIdentity } = require("../skills/_emberprobe/probe-connection");
const { WriteAuthorization, writeConnectionIdentity } = require("../src/writeAuthorization");
const { FirmwareRecord } = require("../src/services/firmwareRecord");

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
    assert.deepStrictEqual(
        await provider._prepareWriteConnection(),
        plan.connection,
        "Agent write confirmation must bind to the managed debug server while DAP is between stop events"
    );
    provider._managedDebugServer = null;
    const unverified = { options: { selectionIdentity: { kind: "usb", anonymous: true, attachmentId: "" } } };
    assert.throws(() => provider._assertWriteSessionCurrent(unverified), { code: "PROBE_IDENTITY_UNVERIFIED" });
    provider._managedDebugServer = unverified;
    assert.throws(() => provider._assertWriteSessionCurrent(provider._debugBridge), {
        code: "PROBE_IDENTITY_UNVERIFIED"
    });
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
    const verifyProvider = Object.create(Provider.prototype);
    const verifyConnection = writeConnectionIdentity({ kind: "dap", sessionId: "verify", workspace: "workspace" });
    verifyProvider._sessionWriteConnection = () => verifyConnection;
    const verifyItem = {
        requestedName: "value",
        name: "value",
        address: 0x20000000,
        type: "u32",
        bytes: [42, 0, 0, 0],
        value: 42,
        valueText: "42"
    };
    const verifyPlan = { elfResult: { elf: { sha256: "verify" } }, items: [verifyItem], connection: verifyConnection };
    for (const halted of [false, true]) {
        let readBack = [42, 0, 0, 0];
        const verifySession = {
            writeAndVerify: async () => ({
                before: [{ name: "value", bytes: [1, 0, 0, 0] }],
                after: [{ name: "value", bytes: readBack }],
                halted
            })
        };
        const success = await verifyProvider._executeWritePlan(verifySession, "test", verifyPlan);
        assert.strictEqual(success.halted, halted);
        assert.strictEqual(success.results[0].verified, true);
        readBack = [41, 0, 0, 0];
        await assert.rejects(
            verifyProvider._executeWritePlan(verifySession, "test", verifyPlan),
            (error) =>
                error.code === "WRITE_VERIFY_FAILED" &&
                error.details.targetHaltedDuringWrite === halted &&
                error.details.results[0].readBack === 41 &&
                error.i18nKey === (halted ? "sb.writeVerifyFailedHalted" : "sb.writeVerifyFailedRunning") &&
                (halted
                    ? /while the target was halted/.test(error.message)
                    : /running firmware may have modified it right after the write/.test(error.message))
        );
    }

    const unreadableSession = {
        writeAndVerify: async () => ({
            before: [{ name: "value", bytes: [1, 0, 0, 0] }],
            after: [{ name: "value", bytes: null, diagnostic: { message: "incomplete data" } }],
            halted: false
        })
    };
    await assert.rejects(
        verifyProvider._executeWritePlan(unreadableSession, "test", verifyPlan),
        (error) =>
            error.code === "WRITE_READBACK_FAILED" &&
            error.i18nKey === "sb.writeReadBackFailed" &&
            /incomplete data/.test(error.i18nParams.msg) &&
            error.details.results[0].verified === false &&
            error.details.results[0].readBackError === "incomplete data",
        "a failed read-back must not be reported as firmware modifying the value"
    );

    const namedItem = { ...verifyItem, name: "_ZN3lab5valueE", requestedName: "_ZN3lab5valueE" };
    const namedPlan = {
        ...verifyPlan,
        elfResult: { ...verifyPlan.elfResult, symbols: [{ name: namedItem.name, displayName: "lab::value" }] },
        items: [namedItem]
    };
    const namedUnreadable = {
        writeAndVerify: async () => ({
            before: [],
            after: [{ name: namedItem.name, bytes: null, diagnostic: { message: "incomplete data" } }]
        })
    };
    await assert.rejects(verifyProvider._executeWritePlan(namedUnreadable, "test", namedPlan), (error) => {
        assert.strictEqual(error.i18nParams.msg, "lab::value: incomplete data");
        assert.strictEqual(error.details.results[0].resolvedName, namedItem.name);
        return error.code === "WRITE_READBACK_FAILED";
    });

    const runtimeProvider = Object.create(Provider.prototype);
    const writeCalls = [];
    const runtime = {
        ready: true,
        samplingEnabled: true,
        writeAndVerify: async (items) => {
            writeCalls.push(items);
            return {
                before: items.map((item) => ({ name: item.name, bytes: [0, 0, 0, 0] })),
                after: items.map((item) => ({ name: item.name, bytes: item.bytes })),
                halted: false
            };
        }
    };
    const debugBridge = {
        hasAnySession: true,
        hasSession: true,
        paused: false,
        canWrite: false,
        activeSession: { id: "runtime", configuration: {} },
        stopEpoch: 1,
        agentStatus() {
            return { state: this.paused ? "paused" : "running" };
        },
        status() {
            return { mode: this.paused ? "debug-paused-ready" : "debug-running-waiting", canWrite: this.canWrite };
        }
    };
    const runtimeElf = {
        elf: { path: "runtime.elf", sha256: "runtime" },
        memory: { sections: [{ name: ".data", flags: 3, addr: 0x20000000, size: 16 }] },
        symbols: [
            { name: "word", address: 0x20000000, size: 4, watchType: "u32", hasDwarfWriteType: true },
            { name: "byte", address: 0x20000004, size: 1, watchType: "u8", hasDwarfWriteType: true }
        ]
    };
    Object.assign(runtimeProvider, {
        _samplingCoordinator: new SamplingCoordinator(),
        _samplingIntent: true,
        _debugBridge: debugBridge,
        _managedDebugServer: runtime,
        _livePanels: new Map(),
        _unlimitedSamplingEnabled: () => false,
        _elfService: { invalidate() {} },
        readElfSymbols: () => runtimeElf,
        _prepareRequestedLayouts: async () => {},
        _sessionWriteConnection: () => verifyConnection,
        _prepareWriteConnection: async () => verifyConnection,
        _t: (key) => key,
        _withAgentProbe: () => assert.fail("running writes must reuse the managed OpenOCD session")
    });
    const uiWord = await runtimeProvider._writeUiVariable("word", 42);
    assert.strictEqual(uiWord.source, "debug-running-openocd");
    assert.strictEqual(uiWord.halted, false);
    assert.strictEqual(writeCalls.length, 1);
    await assert.rejects(runtimeProvider._writeUiVariable("byte", 42), { code: "RUNTIME_WRITE_DISABLED" });
    assert.strictEqual(writeCalls.length, 1, "halting UI requests are refused before touching hardware");
    const runtimePlan = runtimeProvider._agentWritePlan([{ name: "word", value: 43 }], { refreshSymbols: false });
    runtimePlan.connection = verifyConnection;
    runtimeProvider._samplingCoordinator.setBackpressure(true);
    await assert.rejects(runtimeProvider._executeWritePlan(runtime, "test", runtimePlan), {
        code: "RUNTIME_WRITE_DISABLED"
    });
    runtimeProvider._samplingCoordinator.setBackpressure(false);
    await assert.rejects(
        runtimeProvider._executeWritePlan(runtime, "test", {
            ...runtimePlan,
            items: [{ ...runtimePlan.items[0], address: 0x20000100 }]
        }),
        { code: "LIVE_ADDRESS_NOT_RAM" }
    );
    assert.strictEqual(writeCalls.length, 1, "backpressure and RAM restrictions prevent hardware writes");

    runtimeProvider._writeAuthorization = new WriteAuthorization({ get: () => undefined, update: async () => {} });
    const values = [{ name: "word", value: 44 }];
    const requestWrite = await runtimeProvider._writeAgentVariables({ values });
    assert.strictEqual(requestWrite.confirmationRequired, true);
    assert.strictEqual(writeCalls.length, 1);
    const agentWord = await runtimeProvider._writeAgentVariables({
        values,
        confirmationId: requestWrite.confirmationId
    });
    assert.strictEqual(agentWord.source, "debug-running-openocd");
    assert.strictEqual(agentWord.halted, false);
    assert.strictEqual(writeCalls.length, 2);
    const byteValues = [{ name: "byte", value: 1 }];
    const requestByte = await runtimeProvider._writeAgentVariables({ values: byteValues });
    await assert.rejects(
        runtimeProvider._writeAgentVariables({ values: byteValues, confirmationId: requestByte.confirmationId }),
        { code: "RUNTIME_WRITE_DISABLED" }
    );
    assert.strictEqual(writeCalls.length, 2);

    const normalWrite = runtime.writeAndVerify;
    for (const change of ["epoch", "selected-session", "server"]) {
        const active = debugBridge.activeSession;
        runtime.writeAndVerify = async (items) => {
            const result = await normalWrite(items);
            if (change === "epoch") debugBridge.stopEpoch++;
            else if (change === "selected-session") debugBridge.activeSession = { ...active, id: "other" };
            else runtimeProvider._managedDebugServer = null;
            return result;
        };
        await assert.rejects(
            runtimeProvider._executeWritePlan(runtime, "test", runtimePlan),
            (error) =>
                error.code === "DEBUG_STATE_CHANGED" &&
                error.i18nKey === "sb.writeTargetChanged.verified" &&
                error.details.written === true &&
                error.details.verified === true &&
                error.details.results.length === runtimePlan.items.length
        );
        debugBridge.activeSession = active;
        runtimeProvider._managedDebugServer = runtime;
    }
    for (const writtenItems of [0, 1]) {
        runtime.writeAndVerify = async () => {
            throw Object.assign(new Error("Runtime read was cancelled by a target state change"), {
                code: "LIVE_READ_CANCELLED",
                details: { writtenItems, totalItems: 1 }
            });
        };
        await assert.rejects(
            runtimeProvider._executeWritePlan(runtime, "test", runtimePlan),
            (error) =>
                error.code === "DEBUG_STATE_CHANGED" &&
                error.i18nKey === `sb.writeTargetChanged.${writtenItems ? "unverified" : "notWritten"}` &&
                error.retryable === !writtenItems &&
                error.details.written === !!writtenItems &&
                error.details.verified === false &&
                !/Runtime read/.test(error.message),
            "cancelled runtime writes report whether target memory changed"
        );
    }
    runtime.writeAndVerify = normalWrite;
    debugBridge.paused = true;
    debugBridge.canWrite = true;
    debugBridge.writeAndVerify = async (items) => ({ ...(await normalWrite(items)), halted: true });
    const postedStatuses = [];
    runtimeProvider._postConsumerStatuses = (status) => postedStatuses.push(status);
    const pausedWrite = await runtimeProvider._writeUiVariable("byte", 2);
    assert.strictEqual(pausedWrite.source, "cortex-debug-dap");
    assert.strictEqual(pausedWrite.halted, true);
    assert.deepStrictEqual(postedStatuses, [], "a paused UI write never gates the write controls mid-drag");
    delete runtimeProvider._postConsumerStatuses;
    const blockedProvider = Object.create(Provider.prototype);
    blockedProvider._debugBridge = { canWrite: false };
    blockedProvider._t = (key) => key;
    const blockedWriteCount = writeCalls.length;
    for (const [status, key] of [
        [{ intentEnabled: false }, "sb.writeNeedSampling"],
        [{ intentEnabled: true, mode: "debug-paused-reading" }, "live.dapReading"],
        [{ intentEnabled: true, mode: "debug-paused-reading", key: "live.dapFailed" }, "live.dapFailed"],
        [{ intentEnabled: true, mode: "debug-paused-ready" }, "sb.writeDebuggerUnsupported"],
        [{ intentEnabled: true, mode: "debug-session-conflict" }, "live.debugConflict"],
        [{ intentEnabled: true, connectionStale: true }, "sb.writeConnectionChanged"],
        [{ intentEnabled: true, pauseReason: "archive_backpressure" }, "sb.writeArchiveBusy"],
        [{ intentEnabled: true }, "sb.writeUnavailable"]
    ]) {
        blockedProvider._samplingStatus = () => ({ canWrite: false, ...status });
        await assert.rejects(blockedProvider._writeUiVariable("word", 42), { i18nKey: key, message: key });
    }
    assert.strictEqual(writeCalls.length, blockedWriteCount, "reporting a blocked reason never performs a write");

    // UI writes with an ELF that differs from the last programmed firmware need an explicit choice.
    const prompts = [];
    let answer;
    const PromptProvider = loadProvider({
        window: {
            showWarningMessage: async (message, options, ...choices) => {
                prompts.push({ message, options, choices });
                return answer;
            }
        }
    });
    const flashed = (sha256) => new FirmwareRecord({ get: () => ({ sha256 }) });
    const prompting = Object.assign(Object.create(PromptProvider.prototype), runtimeProvider, {
        _firmwareRecord: flashed("flashed")
    });
    const mismatchWrites = writeCalls.length;
    await assert.rejects(prompting._writeUiVariable("word", 7, { requestedAt: Date.now() }), {
        code: "ELF_TARGET_MISMATCH",
        i18nKey: "sb.writeFirmwareMismatchDeclined"
    });
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].options.modal, true);
    assert.deepStrictEqual(prompts[0].choices, ["sb.writeFirmwareMismatchAnyway"]);
    assert.strictEqual(writeCalls.length, mismatchWrites, "a declined mismatch never writes");
    await assert.rejects(prompting._writeUiVariable("word", 7, { requestedAt: 0 }), { code: "ELF_TARGET_MISMATCH" });
    assert.strictEqual(prompts.length, 1, "writes queued while declining are not prompted again");
    answer = "sb.writeFirmwareMismatchAnyway";
    await prompting._writeUiVariable("word", 7, { requestedAt: Date.now() + 1 });
    assert.strictEqual(prompts.length, 2);
    assert.strictEqual(writeCalls.length, mismatchWrites + 1);
    await prompting._writeUiVariable("word", 8);
    assert.strictEqual(prompts.length, 2, "the choice covers later writes with the same ELF digest");
    runtimeElf.elf.sha256 = "rebuilt";
    answer = undefined;
    await assert.rejects(prompting._writeUiVariable("word", 9, { requestedAt: Date.now() + 2 }), {
        code: "ELF_TARGET_MISMATCH"
    });
    assert.strictEqual(prompts.length, 3, "a different ELF digest asks again");
    prompting._firmwareRecord = flashed("rebuilt");
    await prompting._writeUiVariable("word", 9);
    assert.strictEqual(prompts.length, 3, "matching firmware writes without a prompt");
    runtimeElf.elf.sha256 = "runtime";
    console.log("Write connection binding, verification, managed routing and approval tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
