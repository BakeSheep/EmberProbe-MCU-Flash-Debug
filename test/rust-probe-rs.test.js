"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseElfSymbols, parseElfSections } = require("../src/elfSymbols");
const { parseDwarf } = require("../src/dwarf");
const { filterRuntimeRamPlan } = require("../src/services/liveWatchService");
const { cargoTargetExecutables } = require("../src/autoDetect");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { resolveProbeRsDebugConfiguration } = require("../src/services/probeRsConfiguration");
const { probeRsArgs } = require("../src/services/probeRsFlashService");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");

async function main() {
    const elf = path.join(__dirname, "fixtures", "rust-globals.elf");
    const bytes = fs.readFileSync(elf);
    const { symbols } = parseElfSymbols(bytes);
    const dwarf = parseDwarf(bytes);
    const gain = symbols.find((symbol) => symbol.name.endsWith("4GAIN"));
    const offset = symbols.find((symbol) => symbol.name.endsWith("6OFFSET"));
    assert.ok(gain && offset, "Rust globals must be present in the ELF symbol table");
    assert.equal(dwarf.types.get(gain.name)?.watchType, "u32");
    assert.equal(dwarf.displayNames.get(gain.name), "rust_globals::GAIN");
    assert.equal(dwarf.types.get(offset.name)?.watchType, "f32");
    assert.equal(dwarf.displayNames.get(offset.name), "rust_globals::OFFSET");
    assert.deepEqual(dwarf.diagnostics, []);
    assert.deepEqual(
        filterRuntimeRamPlan(
            [gain, offset].map((symbol) => ({ ...symbol, size: 4 })),
            parseElfSections(bytes).sections
        ).denied,
        []
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rust-"));
    try {
        const target = path.join(root, "target", "thumbv7em-none-eabihf", "debug");
        fs.mkdirSync(target, { recursive: true });
        const program = path.join(target, "firmware");
        fs.copyFileSync(elf, program);
        assert.deepEqual(await cargoTargetExecutables(root), [program]);
        const folder = { uri: { fsPath: root } };
        const config = resolveProbeRsDebugConfiguration(
            {
                type: "emberprobe-probe-rs",
                request: "attach",
                executable: program,
                rttEnabled: true,
                rttChannelFormats: [{ channelNumber: 0, dataFormat: "Defmt" }]
            },
            folder,
            "",
            { chip: "STM32H723VG", probe: "", speed: 0 }
        );
        assert.equal(config.coreConfigs[0].programBinary, program);
        assert.equal(config.coreConfigs[0].rttEnabled, true);
        assert.deepEqual(config.coreConfigs[0].rttChannelFormats, [{ channelNumber: 0, dataFormat: "Defmt" }]);
        assert.equal(config.flashingConfig.flashingEnabled, false);
        assert.deepEqual(probeRsArgs("download", { chip: "STM32H723VG" }, program), [
            "download",
            "--chip",
            "STM32H723VG",
            "--non-interactive",
            program
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const memory = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const writes = [];
    let refreshDuringWrite = false;
    let pauseDuringWrite = false;
    let continuedDuringWrite = false;
    let now = 1000;
    const session = {
        id: "probe-rs-session",
        type: "emberprobe-probe-rs",
        workspaceFolder: { uri: { toString: () => "workspace" } },
        async customRequest(command, request) {
            const address = Number(request.memoryReference) - 0x20000000;
            if (command === "readMemory") {
                now += 3;
                return { data: Buffer.from(memory.slice(address, address + request.count)).toString("base64") };
            }
            if (command === "writeMemory") {
                const data = Buffer.from(request.data, "base64");
                memory.set(data, address);
                writes.push({ address, data: [...data] });
                if (refreshDuringWrite) bridge.refreshSnapshot();
                if (pauseDuringWrite) bridge.handleRequest(session, { type: "request", command: "pause" });
                if (continuedDuringWrite)
                    bridge.handleMessage(session, {
                        type: "event",
                        event: "continued",
                        body: { threadId: 0, allThreadsContinued: true }
                    });
                return { bytesWritten: data.length };
            }
            throw new Error(`Unexpected DAP request: ${command}`);
        }
    };
    const sampled = [];
    const bridge = new DebugSessionBridge({
        schedule: () => 1,
        cancel: () => {},
        now: () => now,
        getReadPlan: () => [{ name: "GAIN", address: 0x20000000, size: 4 }],
        getIntervalMs: () => 100,
        onSamples: (samples) => sampled.push(samples)
    });
    bridge.setWorkspace({ uri: { toString: () => "workspace" } });
    bridge.attach(session);
    bridge.setIntent(true);
    bridge.handleMessage(session, {
        type: "response",
        command: "initialize",
        success: true,
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }
    });
    bridge.handleMessage(session, { type: "response", command: "attach", success: true });
    assert.equal(bridge.canRead, true, "probe-rs can read globals while the core runs");
    const runtimeEpoch = bridge.epoch;
    bridge.handleMessage(session, { type: "event", event: "continued", body: { threadId: 0 } });
    assert.equal(
        bridge.epoch,
        runtimeEpoch,
        "WFI wake reports must not invalidate an already running probe-rs session"
    );
    assert.deepEqual(
        [...(await bridge.readOnce([{ name: "GAIN", address: 0x20000000, size: 4 }]))[0].bytes],
        [1, 2, 3, 4]
    );
    await bridge._poll();
    assert.deepEqual([...sampled[0][0].bytes], [1, 2, 3, 4]);
    now += 100;
    await bridge._poll();
    assert.ok(bridge.stats().actualHz > 9 && bridge.stats().actualHz < 11);
    assert.equal(bridge.stats().effectiveIntervalMs, 100);
    assert.equal(bridge.stats().p95DurationMs, 3);
    assert.equal(bridge.canWrite, true);
    const transaction = await bridge.writeAndVerify([{ name: "GAIN", address: 0x20000000, bytes: [9, 10, 11, 12] }]);
    assert.deepEqual([...transaction.after[0].bytes], [9, 10, 11, 12]);
    assert.deepEqual(writes, [{ address: 0, data: [9, 10, 11, 12] }], "running write must not touch adjacent memory");
    assert.equal(bridge.snapshotPending, true, "running sampling resumes after the write");
    refreshDuringWrite = true;
    const refreshedWrite = await bridge.writeAndVerify([{ name: "GAIN", address: 0x20000000, bytes: [4, 3, 2, 1] }]);
    assert.deepEqual(
        [...refreshedWrite.after[0].bytes],
        [4, 3, 2, 1],
        "a chart snapshot refresh must not cancel the in-flight write verification"
    );
    assert.equal(bridge.snapshotPending, true);
    refreshDuringWrite = false;
    await bridge._poll();
    continuedDuringWrite = true;
    const wakeWrite = await bridge.writeAndVerify([{ name: "GAIN", address: 0x20000000, bytes: [5, 6, 7, 8] }]);
    assert.deepEqual([...wakeWrite.after[0].bytes], [5, 6, 7, 8], "WFI wake event must allow exact write read-back");
    continuedDuringWrite = false;
    pauseDuringWrite = true;
    await assert.rejects(
        bridge.writeAndVerify([{ name: "GAIN", address: 0x20000000, bytes: [1, 2, 3, 4] }]),
        /Target state changed/,
        "a real execution transition must still cancel write verification"
    );
    bridge.dispose();

    const Provider = loadProvider({
        workspace: { getConfiguration: () => ({ get: (name) => (name === "backend" ? "probe-rs" : undefined) }) }
    });
    const provider = Object.create(Provider.prototype);
    provider._probeCoordinator = new ProbeCoordinator();
    provider._samplingCoordinator = new SamplingCoordinator();
    provider._chipInfoService = { running: false };
    provider._context = { workspaceState: { get: (name) => (name === "mcu.elfPath" ? elf : undefined) } };
    provider._elfService = { ready: async () => {} };
    provider._elfRebindPromise = Promise.resolve();
    provider._debugBridge = {
        activeSession: null,
        hasSession: false,
        setIntent() {},
        refreshSnapshot() {},
        status: () => ({ source: "dap" })
    };
    provider._activeReadPlan = () => [{ name: gain.name, address: gain.address, size: 4 }];
    provider._runtimeRamPlan = (items) => ({ allowed: items, denied: [] });
    provider._setLiveInterval = () => {};
    provider._postConsumerStatuses = () => {};
    const starts = [];
    provider._startProbeRsDebug = async (...args) => {
        starts.push(args);
        return true;
    };
    await provider.startLiveWatch(undefined, 100);
    assert.deepEqual(starts[0].slice(0, 3), ["attach", undefined, true]);
    assert.equal(provider._samplingIntent, true);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
