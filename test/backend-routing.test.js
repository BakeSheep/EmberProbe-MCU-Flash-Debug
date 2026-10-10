"use strict";

const assert = require("node:assert/strict");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { checkProbeRs, ProbeRsStatusService } = require("../src/services/probeRsStatusService");
const { detectWorkspace } = require("../src/autoDetect");

async function main() {
    const values = { backend: "probe-rs", probeRsPath: "probe-rs", probeRsChip: "STM32H723VG" };
    const vscode = {
        ConfigurationTarget: { Workspace: 2 },
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => values[key] ?? fallback,
                update: async (key, value) => {
                    values[key] = value;
                }
            }),
            findFiles: async () => [],
            workspaceFolders: []
        }
    };
    let openOcdCalls = 0;
    let probeRsReads = 0;
    let chipState = "running";
    const chipControls = [];
    const Provider = loadProvider(vscode, {
        "./services/probeRsChipInfo": {
            readProbeRsChipInfo: async (settings, options) => {
                probeRsReads++;
                assert.equal(settings.chip, "STM32H723VG");
                if (options.fields) assert.deepEqual(options.fields, ["core"]);
                options.onProgress?.({ core: "Cortex-M7" });
                return { core: "Cortex-M7", deviceId: "0x483", targetState: chipState };
            },
            controlProbeRsTarget: async (settings, action, options) => {
                assert.equal(options.lease.operation, "chipInfo");
                assert.equal(options.lease.released, false);
                options.assertCurrent();
                chipControls.push({ settings, action });
                chipState = action === "pause" ? "halted" : "running";
                assert.equal(options.refresh, true);
                return { state: chipState, info: { core: "Cortex-M7", targetState: chipState } };
            }
        }
    });
    const provider = Object.create(Provider.prototype);
    provider._probeCoordinator = new ProbeCoordinator();
    provider._commandContext = () => ({ cwd: __dirname });
    provider._debugBridge = { activeSession: null, hasAnySession: false };
    provider._chipInfoService = { info: null, infoConnection: null };
    provider._openOcdStatusService = {
        refresh: () => {
            openOcdCalls++;
            throw new Error("OpenOCD must not be checked");
        }
    };
    provider._probeRsStatusService = { refresh: async () => "probe-rs" };
    const chipUpdates = [];
    provider._postChipInfo = (status, info) => chipUpdates.push({ status, info });
    provider._t = (key) => key;
    provider._webviewView = { webview: { postMessage: () => {} } };
    assert.equal(await provider.refreshBackendStatus(), "probe-rs");
    const info = await provider.readChipInfoAction(true);
    assert.equal(info.core, "Cortex-M7");
    assert.equal(probeRsReads, 1);
    assert.equal(chipUpdates.find(({ status }) => status === null).info.controlsAvailable, false);
    assert.equal(openOcdCalls, 0);
    assert.equal(provider._chipInfoService.infoConnection.target, "STM32H723VG");
    assert.equal((await provider.controlChipInfoAction("pause")).targetState, "halted");
    assert.equal((await provider.controlChipInfoAction("continue")).targetState, "running");
    assert.equal(probeRsReads, 1, "controls reuse the information refreshed inside the native session");
    const cached = provider._chipInfoService.info;
    const partial = await provider.readChipInfoAction(true, { fields: ["core"], sections: [] });
    assert.equal(partial.core, "Cortex-M7");
    assert.strictEqual(
        provider._chipInfoService.info,
        cached,
        "a selective Agent read must not replace the full panel cache"
    );
    assert.equal(provider._probeCoordinator.anyActive(), false);
    assert.deepEqual(
        chipControls.map(({ action }) => action),
        ["pause", "continue"]
    );
    values.probeRsProbe = "different-probe";
    assert.equal(await provider.controlChipInfoAction("reset"), null);
    assert.equal(chipControls.length, 2, "a changed probe selector rejects controls before execution");
    values.probeRsProbe = "";
    await assert.rejects(
        provider._withAgentProbe(() => {}),
        { code: "PROBE_RS_SESSION_REQUIRED" }
    );
    provider._debugBridge = {
        activeSession: { type: "emberprobe-probe-rs" },
        canRead: true,
        readOnce: async () => [{ name: "GAIN", bytes: Buffer.from([1, 0, 0, 0]) }]
    };
    const agentRead = await provider._withAgentProbe(async ({ session, source }) => ({
        source,
        samples: await session.readOnce([])
    }));
    assert.equal(agentRead.source, "probe-rs-dap");
    assert.equal(agentRead.samples[0].bytes[0], 1);
    assert.equal(openOcdCalls, 0);
    provider._assertConnectionEditable = () => {};
    provider.updateView = async () => {};
    provider.refreshBackendStatus = async () => {};
    await provider._selectBackend("openocd");
    assert.equal(values.backend, "openocd");
    assert.equal(provider._chipInfoService.info, null);
    await provider._selectBackend("probe-rs");
    assert.equal(values.backend, "probe-rs");
    assert.deepEqual(await detectWorkspace(vscode, "probe-rs"), {
        elf: "",
        mcu: "",
        mcuCandidates: [],
        debugger: "",
        probeCandidates: []
    });

    const statuses = [];
    const service = new ProbeRsStatusService({
        vscode,
        onStatus: (status) => statuses.push(status),
        check: async (executable) =>
            executable === "probe-rs"
                ? { state: "ready", key: "pr.ready", params: { version: "0.32.0" } }
                : { state: "missing", key: "pr.missing" }
    });
    assert.equal(await service.refresh(), "probe-rs");
    assert.equal(statuses.at(-1).state, "ready");
    values.probeRsPath = "missing-probe-rs";
    assert.equal(await service.refresh(), null);
    assert.equal(statuses.at(-1).key, "pr.missing");
    assert.equal(openOcdCalls, 0);
    assert.equal((await checkProbeRs("")).state, "missing");
    assert.equal((await checkProbeRs(process.execPath)).state, "error");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
