"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { loadProvider } = require("./helpers/load-provider");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { ChipInfoService } = require("../src/services/chipInfoService");
const { ProbeCoordinator } = require("../src/probeCoordinator");

async function main() {
    const connection = {
        probe: "jlink.cfg",
        target: "stm32f4x.cfg",
        probeSerial: "1234",
        transport: "swd",
        openocd: "fake"
    };
    const P = loadProvider();
    const provider = Object.create(P.prototype);
    let recorded = 0;
    provider._probeConnectionService = {
        recordSuccess: (value) => {
            assert.strictEqual(value, connection);
            recorded++;
        }
    };
    provider._matchesManagedDebugSession = (session) => session.id === "managed";
    provider._terminatedDebugSessionIds = new Set();
    provider._managedDebugServer = { options: connection };
    provider._markDebugStartupReady = () => {};
    provider._clearDebugStartupWatchdog = (outcome) => {
        assert.strictEqual(outcome.kind, "failed");
    };
    provider._t = (key) => key;
    provider._debugBridge = { handleMessage: () => {} };
    const session = { id: "managed" };
    provider.handleDebugAdapterMessage(session, { type: "event", event: "initialized" });
    provider.handleDebugAdapterMessage(session, { type: "response", command: "launch", success: false });
    provider.handleDebugAdapterMessage({ id: "other" }, { type: "response", command: "launch", success: true });
    assert.strictEqual(recorded, 0);
    provider.handleDebugAdapterMessage(session, { type: "response", command: "attach", success: true });
    assert.strictEqual(recorded, 1);
    provider._terminatedDebugSessionIds.add(session.id);
    provider.handleDebugAdapterMessage(session, { type: "response", command: "launch", success: true });
    assert.strictEqual(recorded, 1);

    let readsFail = false,
        chipRecords = 0;
    const chip = new ChipInfoService({
        vscode: { workspace: { getConfiguration: () => ({ get: (_key, value) => value }) } },
        context: { workspaceState: { get: () => "configured.cfg" } },
        cacheKeys: { debugger: "probe", mcuCore: "target" },
        coordinator: new ProbeCoordinator(),
        isDebugActive: () => false,
        resolveExecutable: async () => "fake",
        prepareConnection: async () => connection,
        commandContext: () => ({}),
        onPost: () => {},
        onDiagnostics: () => {},
        t: (key) => key,
        recordSuccess: async (value) => {
            assert.strictEqual(value, connection);
            chipRecords++;
        },
        chipInfo: {
            readChipInfo: async (_vscode, options) => {
                assert.strictEqual(options.transport, "swd");
                if (readsFail) throw new Error("connection failed");
                return { cpuid: "0x410fc241" };
            }
        }
    });
    await chip.read(true);
    readsFail = true;
    await assert.rejects(chip.read(true), /connection failed/);
    assert.strictEqual(chipRecords, 1);
    chip.chipInfo.readChipInfo = async () => ({ probeName: "J-Link", targetName: "configured" });
    await chip.read(true);
    assert.strictEqual(chipRecords, 1, "adapter metadata alone must not establish target success");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-auto-flash-"));
    try {
        const elf = path.join(root, "firmware.elf");
        await fs.writeFile(elf, "firmware");
        let flashRecords = 0,
            fail = false,
            executionTransport;
        const flash = new AgentFlashService({
            coordinator: new ProbeCoordinator(),
            isDebugActive: () => false,
            resolveLaunch: () => ({ executable: "fake" }),
            check: async () => ({ compatible: true }),
            prepare: async () => connection,
            authorization: { authorize: (plan) => assert.strictEqual(plan.transport, "swd") },
            recordSuccess: async (value) => {
                assert.strictEqual(value, connection);
                flashRecords++;
            },
            run: async (options) => {
                executionTransport = options.transport;
                return { exitCode: fail ? 1 : 0, openocdTail: [] };
            }
        });
        const params = {
            elf,
            elfSha256: crypto.createHash("sha256").update("firmware").digest("hex"),
            probe: "jlink.cfg",
            target: "stm32f4x.cfg",
            transport: "auto",
            openocd: "fake",
            confirmationId: "confirmed"
        };
        assert.strictEqual((await flash.execute(params)).verified, true);
        assert.strictEqual(executionTransport, "swd", "authorization and execution must use resolved protocol");
        fail = true;
        assert.strictEqual((await flash.execute(params)).verified, false);
        assert.strictEqual(flashRecords, 1);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("Debug, chip and flash success recording and effective transport tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
