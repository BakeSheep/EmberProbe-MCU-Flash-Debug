"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { loadProvider } = require("./helpers/load-provider");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { ProbeCoordinator } = require("../src/probeCoordinator");

const elf = path.join(__dirname, "fixtures/rust-globals.elf");
const otherElf = path.join(__dirname, "fixtures/other-firmware.elf");
const folder = { uri: { fsPath: __dirname, toString: () => "file:///probe-rs-test" } };
const ramItem = { name: "GAIN", address: 0x20000000, size: 4 };
const mmioItem = { name: "MMIO", address: 0x40000000, size: 4 };

function ready(bridge, session) {
    bridge.attach(session);
    bridge.handleMessage(session, {
        type: "response",
        command: "initialize",
        success: true,
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }
    });
    bridge.handleMessage(session, { type: "response", command: "attach", success: true });
}

function fixture() {
    const values = { backend: "probe-rs", probeRsChip: "", probeRsProbe: "different-probe" };
    const starts = [];
    const Provider = loadProvider({
        workspace: { getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback }) },
        debug: {
            startDebugging: async (...args) => {
                starts.push(args);
                return false;
            }
        }
    });
    const provider = Object.create(Provider.prototype);
    let selectedElf = elf;
    const requests = [];
    let afterRead = () => {};
    const session = {
        id: "probe-rs-a",
        type: "emberprobe-probe-rs",
        workspaceFolder: folder,
        configuration: {
            chip: "STM32F407ZG",
            probe: "1366:0101:20781318",
            wireProtocol: "Jtag",
            speed: 2000,
            cwd: __dirname,
            coreConfigs: [{ programBinary: elf }]
        },
        async customRequest(command, args) {
            requests.push({ command, args });
            if (command === "writeMemory") return { bytesWritten: Buffer.from(args.data, "base64").length };
            assert.equal(command, "readMemory");
            const data = Buffer.alloc(args.count);
            data.writeUInt32LE(Number(args.memoryReference) === 0xe000ed00 ? 0x410fc241 : 123);
            afterRead();
            return { data: data.toString("base64") };
        }
    };
    provider._context = { workspaceState: { get: () => selectedElf } };
    provider._probeCoordinator = new ProbeCoordinator();
    provider._probeRsAdapters = new Map();
    provider._commandContext = () => ({ folder });
    provider._probeConnectionService = { assertCurrent() {} };
    provider._postConsumerStatuses = () => {};
    provider._chipInfoService = {};
    provider._postChipInfo = () => {};
    provider.readElfSymbols = () => ({
        elf: { path: selectedElf, sha256: selectedElf },
        memory: { sections: [{ name: ".data", addr: 0x20000000, size: 0x100, flags: 3 }] }
    });
    provider._debugBridge = new DebugSessionBridge({
        schedule: () => 1,
        cancel() {},
        getReadPlan: () => [ramItem],
        validateReadPlan: (items, selectedSession) => provider._validateDebugReadPlan(items, selectedSession)
    });
    provider._debugBridge.setWorkspace(folder);
    provider._debugBridge.setIntent(true);
    ready(provider._debugBridge, session);
    return {
        provider,
        session,
        requests,
        starts,
        values,
        selectElf(value) {
            selectedElf = value;
        },
        afterRead(callback) {
            afterRead = callback;
        }
    };
}

async function main() {
    const state = fixture();
    const { provider, session, requests } = state;
    try {
        state.selectElf(otherElf);
        await assert.rejects(provider._debugBridge.readOnce([ramItem]), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        provider._debugBridge.snapshotReady = true;
        provider._prepareRequestedLayouts = async () => {};
        provider._agentWritePlan = () => ({
            elfResult: { elf: otherElf },
            items: [{ ...ramItem, requestedName: ramItem.name, type: "u32", bytes: [1, 0, 0, 0] }]
        });
        await assert.rejects(provider._writeUiVariable("GAIN", 1), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        assert.equal(requests.length, 0, "ELF mismatches must be rejected before all DAP memory operations");

        state.selectElf(elf);
        const samples = await provider._withAgentProbe(({ session: bridge }) => bridge.readOnce([ramItem]));
        assert.equal(Buffer.from(samples[0].bytes).readUInt32LE(0), 123);
        requests.length = 0;
        await assert.rejects(
            provider._withAgentProbe(({ session: bridge }) => bridge.readOnce([mmioItem])),
            { code: "LIVE_ADDRESS_NOT_RAM" }
        );
        await assert.rejects(provider._debugBridge.readOnce([{ ...ramItem, address: 0x200000fe }]), {
            code: "LIVE_ADDRESS_NOT_RAM"
        });
        assert.equal(requests.length, 0, "Agent and direct running reads share the RAM boundary");

        provider._agentVariablePlan = () => ({
            elfResult: { elf: { path: otherElf } },
            plan: [{ ...ramItem, type: "u32" }],
            compositePlan: []
        });
        await assert.rejects(provider._runAgentSamples({}, 1, 100, false), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        assert.equal(requests.length, 0, "An Agent read keeps the ELF identity used to construct its addresses");

        state.afterRead(() => state.selectElf(otherElf));
        await assert.rejects(provider._debugBridge.readOnce([ramItem]), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        state.afterRead(() => {});
        state.selectElf(elf);

        const second = { ...session, id: "probe-rs-b" };
        ready(provider._debugBridge, second);
        assert.equal(provider._debugBridge.conflict, true);
        provider._debugBridge.selectSession({ sessionId: session.id });
        assert.equal(provider._debugBridge.probeRsReady, true);
        assert.equal(provider._debugBridge.canRead, true);
        assert.equal(provider._debugBridge.snapshotPending, true);
        await provider._debugBridge._poll();
        assert.equal(provider._debugBridge.snapshotReady, true);
        provider._debugBridge.selectSession({ sessionId: second.id });
        assert.equal(provider._debugBridge.canRead, true);
        assert.equal(provider._debugBridge.snapshotReady, false, "selection must invalidate the previous sample");
        provider._debugBridge.detach(second);

        const debugLease = provider._probeCoordinator.acquire("debugStart").transition("debugServer");
        const info = await provider.readChipInfoAction(true);
        assert.equal(info.core, "Cortex-M4");
        assert.equal(info.chip, session.configuration.chip);
        assert.equal(info.probe, session.configuration.probe);
        assert.equal(info.transport, "JTAG");
        assert.equal(provider._chipInfoService.infoConnection.target, session.configuration.chip);
        assert.equal(provider._probeCoordinator.isActive("debugServer"), true);

        state.afterRead(() => provider._debugBridge.detach(session));
        await assert.rejects(provider.readChipInfoAction(true), { code: "DEBUG_STATE_CHANGED" });
        assert.equal(provider._probeRsChipReading, false);
        debugLease.release();
        assert.equal(provider._probeCoordinator.anyActive(), false);

        const config = { request: "attach", chip: "STM32F407ZG", executable: elf };
        for (const operation of ["download", "chipInfo", "cpuLoad", "debugStart", "debugServer"]) {
            const lease = provider._probeCoordinator.acquire(operation);
            await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_BUSY" });
            await assert.rejects(provider._startProbeRsDebug("attach", undefined, false, config), {
                code: "PROBE_BUSY"
            });
            assert.equal(state.starts.length, 0);
            lease.release();
        }
        provider._probeDriverSwitching = true;
        await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_DRIVER_BUSY" });
        provider._probeDriverSwitching = false;
        provider._liveExitUnconfirmed = true;
        await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_EXIT_UNCONFIRMED" });
        provider._liveExitUnconfirmed = false;
        assert.equal(await provider._startProbeRsDebug("attach", undefined, false, config), false);
        assert.equal(
            provider._probeCoordinator.anyActive(),
            false,
            "cancelled before descriptor creation owns no probe"
        );
        assert.equal(state.starts[0][1].coreConfigs[0].programBinary, elf);
        assert.equal(state.starts[0][1].flashingConfig.flashingEnabled, false);
        provider._liveStartPromise = new Promise(() => {});
        const automatic = provider.prepareProbeRsDebug(folder, { ...config, __emberprobeWatchOnly: true });
        let timer;
        try {
            const resolved = await Promise.race([
                automatic,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("Automatic attach waited for itself")), 100);
                })
            ]);
            assert.equal(resolved.__emberprobeWatchOnly, true);
        } finally {
            clearTimeout(timer);
            provider._liveStartPromise = null;
        }
    } finally {
        provider._debugBridge.dispose();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
