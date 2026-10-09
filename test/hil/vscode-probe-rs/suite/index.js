"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vscode = require("vscode");

async function waitFor(predicate, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    assert.ok(extension);
    const api = await extension.activate();
    const provider = api.debugTestProvider;
    assert.ok(provider);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const elfPath = process.env.EMBERPROBE_HIL_ELF;
    const chip = process.env.EMBERPROBE_HIL_CHIP;
    const probe = process.env.EMBERPROBE_HIL_PROBE;
    const settings = vscode.workspace.getConfiguration("emberprobe");
    await settings.update("backend", "probe-rs", vscode.ConfigurationTarget.Global);
    await settings.update("probeRsChip", chip, vscode.ConfigurationTarget.Global);
    if (probe) await settings.update("probeRsProbe", probe, vscode.ConfigurationTarget.Global);
    await provider._context.workspaceState.update("mcu.elfPath", elfPath);
    await provider._downloadProbeRs();
    const standaloneChip = await provider.readChipInfoAction(true);
    assert.equal(standaloneChip?.core, "Cortex-M7");
    assert.equal(standaloneChip?.deviceId, "0x483");
    assert.equal(standaloneChip?.flashSize, "1024 KiB");
    assert.match(standaloneChip?.uid || "", /^0x[0-9A-F]{24}$/);
    await provider._refreshElfBindings();
    const parsed = await provider._elfService.ready();
    const variables = new Map();
    for (const name of ["TICKS", "TUNE_MS", "APPLIED_MS"]) {
        const matching = parsed.symbols.filter((symbol) => symbol.displayName?.endsWith(`::${name}`));
        assert.equal(matching.length, 1, `Expected one ${name} in Rust ELF`);
        variables.set(name, matching[0]);
    }
    await provider._saveWatchList(
        "mcu.sidebarWatchList",
        [...variables.values()].map((symbol) => ({
            name: symbol.name,
            address: symbol.address,
            size: symbol.size,
            type: "u32"
        }))
    );
    provider.openLiveWatchPanel();
    const chart = provider._livePanels.get(1);
    assert.ok(chart, "LiveWatch chart panel should open");
    await waitFor(() => chart.ready, "LiveWatch chart Webview ready");
    await provider._saveWatchList(
        chart.watchKey,
        [...variables.values()].map((symbol) => ({
            name: symbol.name,
            address: symbol.address,
            size: symbol.size,
            type: "u32"
        }))
    );
    const chartSamples = [];
    const chartStatuses = [];
    const originalPost = chart.post;
    chart.post = (message) => {
        if (["liveSample", "chartValues"].includes(message.type))
            chartSamples.push(structuredClone({ ...message, type: "liveSample", sourceEvent: message.type }));
        if (message.type === "liveStatus") chartStatuses.push(structuredClone(message));
        return originalPost(message);
    };
    let session;
    let tuned = false;
    try {
        const started = await vscode.debug.startDebugging(folder, {
            type: "emberprobe-probe-rs",
            request: "attach",
            name: "EmberProbe H723 HIL",
            chip,
            ...(probe ? { probe } : {}),
            executable: elfPath,
            rttEnabled: true,
            rttChannelFormats: [{ channelNumber: 0, dataFormat: "Defmt" }]
        });
        assert.equal(started, true);
        await waitFor(() => provider._debugBridge.runtimeProbeRs, "probe-rs DAP attach");
        session = provider._debugBridge.activeSession;
        const sharedChip = await provider.readChipInfoAction(true);
        assert.equal(sharedChip?.core, "Cortex-M7");
        assert.equal(sharedChip?.deviceId, standaloneChip.deviceId);
        assert.equal(sharedChip?.uid, standaloneChip.uid);
        await provider.startLiveWatch(undefined, 100, "sidebar", false);
        const tickName = variables.get("TICKS").name;
        await waitFor(
            () => Number.isInteger(provider._latestSidebarSamples.get(tickName)?.value),
            "first LiveWatch sample"
        );
        const first = provider._latestSidebarSamples.get(tickName).value;
        await waitFor(() => provider._latestSidebarSamples.get(tickName)?.value > first, "changing waveform");
        await waitFor(
            () =>
                chartSamples.flatMap((message) => message.samples).filter((sample) => sample.name === tickName)
                    .length >= 8,
            "eight chart waveform samples"
        );
        const ticks = chartSamples.flatMap((message) => message.samples).filter((sample) => sample.name === tickName);
        assert.ok(ticks.at(-1).value > ticks[0].value, "Chart waveform must increase");
        assert.ok(ticks.at(-1).t > ticks[0].t, "Chart samples need acquisition timestamps");
        await waitFor(() => chartStatuses.some((status) => status.actualHz > 0), "actual probe-rs sampling frequency");
        assert.equal(provider._samplingStatus().effectiveIntervalMs, 100);
        const runningChip = await provider.readChipInfoAction(true);
        assert.equal(runningChip.deviceId, "0x483", "Chip information must remain readable while sampling");
        const batchesBeforeChipRead = chartSamples.length;
        await waitFor(() => chartSamples.length > batchesBeforeChipRead, "chart sampling after chip information read");
        const write = await provider._writeUiVariable(variables.get("TUNE_MS").name, 250);
        assert.equal(write.values?.[0]?.verified ?? write.results?.[0]?.verified ?? write.verified, true);
        tuned = true;
        const appliedName = variables.get("APPLIED_MS").name;
        await waitFor(() => provider._latestSidebarSamples.get(appliedName)?.value === 250, "applied tuning");
        await waitFor(
            () =>
                chartSamples.some((message) =>
                    message.samples.some((sample) => sample.name === appliedName && sample.value === 250)
                ),
            "tuned value in chart data"
        );
        await provider._writeUiVariable(variables.get("TUNE_MS").name, 100);
        tuned = false;
        await waitFor(() => provider._latestSidebarSamples.get(appliedName)?.value === 100, "restored tuning");
        await waitFor(() => provider._probeRsRttChannels.size > 0, "RTT channel");
        if (process.env.EMBERPROBE_HIL_CHART_CAPTURE)
            fs.writeFileSync(
                process.env.EMBERPROBE_HIL_CHART_CAPTURE,
                JSON.stringify({
                    variables: Object.fromEntries([...variables].map(([name, symbol]) => [name, symbol.name])),
                    messages: chartSamples
                })
            );
        console.log(
            `✓ VS Code EmberProbe H723 chip info, LiveWatch chart (${chartSamples.length} sample batches), tuning and RTT passed`
        );
    } finally {
        if (tuned) {
            try {
                await provider._writeUiVariable(variables.get("TUNE_MS").name, 100);
            } catch {
                /* Resetting the board also restores the smoke app default. */
            }
        }
        provider.stopLiveWatch();
        if (session) await vscode.debug.stopDebugging(session);
    }
}

module.exports = { run };
