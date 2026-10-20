"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

const SETTING = "experimental.unlimitedSampling.enabled";

function createProvider(settings) {
    const config = { get: (key, fallback) => settings.get(key) ?? fallback };
    const Provider = loadProvider({ workspace: { getConfiguration: () => config } });
    const provider = Object.create(Provider.prototype);
    const state = new Map();
    const plans = [];
    const panelMessages = [];
    provider._context = {
        workspaceState: {
            get: (key) => state.get(key),
            update: async (key, value) => state.set(key, value)
        }
    };
    provider._liveIntervalMs = 33;
    provider._unlimitedSamplingRequested = false;
    provider._debugBridge = { hasSession: false };
    provider._consumerTypes = () => ({ graphs: new Map([["graph", new Map([["tick", "u32"]])]]), sidebar: new Map() });
    provider._activeReadPlan = () => [{ name: "tick", address: 0x20000000, size: 4 }];
    provider._liveSession = { setSamplingPlan: (plan) => plans.push(plan) };
    provider._livePanels = new Map([[1, { post: (message) => panelMessages.push(message) }]]);
    return { provider, state, plans, panelMessages };
}

(async () => {
    const settings = new Map();
    const { provider, state, plans, panelMessages } = createProvider(settings);

    // The feature gate rejects requests and keeps the persisted choice untouched.
    await assert.rejects(provider._setUnlimitedSampling(true), { code: "UNLIMITED_SAMPLING_DISABLED" });
    await assert.rejects(provider._setUnlimitedSampling("yes"), { code: "INVALID_PARAMS" });
    assert.strictEqual(state.size, 0);
    assert.strictEqual(plans.length, 0);

    // Enabled setting: the toggle persists per workspace and re-applies the plan immediately.
    settings.set(SETTING, true);
    assert.strictEqual(await provider._setUnlimitedSampling(true), true);
    assert.strictEqual(state.get("liveWatch.unlimitedSampling"), true);
    assert.strictEqual(plans.at(-1).unlimited, true);
    assert.strictEqual(plans.at(-1).graphIntervalMs, 33, "the 200 Hz-capped interval is kept for fallback paths");
    assert.deepStrictEqual(
        plans.at(-1).graphItems.map((item) => item.name),
        ["tick"]
    );
    assert.deepStrictEqual(panelMessages.at(-1), { type: "liveUnlimited", available: true, enabled: true });

    // Turning the experimental setting off disables the mode without forgetting the user's choice.
    settings.set(SETTING, false);
    provider.unlimitedSamplingConfigurationChanged();
    assert.strictEqual(plans.at(-1).unlimited, false);
    assert.deepStrictEqual(panelMessages.at(-1), { type: "liveUnlimited", available: false, enabled: false });
    assert.strictEqual(state.get("liveWatch.unlimitedSampling"), true);
    settings.set(SETTING, true);
    provider.unlimitedSamplingConfigurationChanged();
    assert.strictEqual(plans.at(-1).unlimited, true);

    // Debug sessions keep their own read plan; toggling must not push a standalone plan into them.
    const before = plans.length;
    provider._debugBridge.hasSession = true;
    await provider._setUnlimitedSampling(false);
    assert.strictEqual(plans.length, before);
    assert.deepStrictEqual(panelMessages.at(-1), { type: "liveUnlimited", available: true, enabled: false });
    provider._debugBridge.hasSession = false;
    let finishSave;
    const updateState = provider._context.workspaceState.update;
    provider._context.workspaceState.update = () => new Promise((resolve) => (finishSave = resolve));
    const savingUnlimited = provider._setUnlimitedSampling(true);
    assert.strictEqual(plans.at(-1).unlimited, true, "apply the plan before workspace persistence finishes");
    finishSave();
    await savingUnlimited;
    provider._context.workspaceState.update = updateState;
    await provider._setUnlimitedSampling(false);

    // Status exposes the worker statistics, with safe defaults for sessions without them.
    provider._samplingCoordinator = { status: () => ({}), backpressured: false };
    provider._liveSession.stats = () => ({
        effectiveIntervalMs: 0,
        actualHz: 812.5,
        bytesPerSecond: 65000,
        unlimited: true,
        unlimitedActive: true,
        unlimitedSuppressedReason: null,
        limitedBy: "host",
        hostHoldMs: 240
    });
    let status = provider._samplingStatus();
    assert.strictEqual(status.effectiveIntervalMs, 0);
    assert.strictEqual(status.unlimitedActive, true);
    assert.strictEqual(status.limitedBy, "host");
    assert.strictEqual(status.hostHoldMs, 240);
    assert.strictEqual(status.bytesPerSecond, 65000);
    provider._liveSession.stats = () => ({ effectiveIntervalMs: 33, actualHz: 30 });
    status = provider._samplingStatus();
    assert.strictEqual(status.unlimited, false);
    assert.strictEqual(status.unlimitedActive, false);
    assert.strictEqual(status.unlimitedSuppressedReason, null);
    assert.strictEqual(status.limitedBy, null);
    assert.strictEqual(status.hostHoldMs, 0);
    assert.strictEqual(status.bytesPerSecond, 0);

    // Configuration and Agent Bridge limits stay at 200 Hz; unlimited is a separate, UI-only flag.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const properties = pkg.contributes.configuration.properties;
    assert.strictEqual(properties["emberprobe.sampleFrequencyHz"].maximum, 200);
    assert.strictEqual(properties["emberprobe.experimental.unlimitedSampling.enabled"].default, false);
    await assert.rejects(provider._controlAgentSampling("start", { intervalMs: 1 }), { code: "INVALID_PARAMS" });

    const graph = render(getLiveWatchContent({ backendHistory: true, panelId: 3 }, "en"));
    try {
        graph.assertHealthy();
        const doc = graph.document;
        const slider = doc.getElementById("frequencyPreset");
        const field = doc.getElementById("frequencyField");
        assert.strictEqual(doc.getElementById("unlimited"), null, "the old toolbar toggle is removed");
        assert.strictEqual(slider.max, "3", "unlimited is absent until the setting is enabled");
        assert.ok(!graph.messages.some((m) => m.type === "setUnlimitedSampling"));

        graph.send({ type: "liveUnlimited", available: true, enabled: false });
        assert.strictEqual(slider.max, "4");
        slider.value = "4";
        slider.dispatchEvent(new graph.window.Event("input"));
        assert.deepStrictEqual(graph.messages.at(-1), { type: "setUnlimitedSampling", enabled: true, panelId: 3 });

        graph.send({ type: "liveUnlimited", available: true, enabled: true });
        assert(!field.classList.contains("is-unlimited"), "unlimited changes the track, not the input decoration");
        assert.strictEqual(doc.getElementById("frequency").value, "-");
        assert.strictEqual(doc.getElementById("frequency").disabled, false, "a numeric edit can exit unlimited");

        graph.send({
            type: "liveStatus",
            running: true,
            actualHz: 640,
            bytesPerSecond: 32000,
            effectiveIntervalMs: 0,
            p95DurationMs: 1.4,
            unlimitedActive: true,
            unlimitedSuppressedReason: null,
            limitedBy: "probe",
            hostHoldMs: 0
        });
        const rate = doc.getElementById("rate");
        assert.strictEqual(rate.textContent, "32.0kb/s | 640.0Hz");
        assert.ok(rate.title.includes("Target: unlimited"));
        assert.ok(!/Infinity|NaN/.test(rate.title), "a zero interval must not render as an infinite rate");
        assert.ok(field.title.includes("Limited by probe throughput"));

        graph.send({
            type: "chartValues",
            samples: [],
            actualHz: 902.25,
            bytesPerSecond: 64000,
            unlimitedActive: true,
            limitedBy: "host"
        });
        assert.strictEqual(rate.textContent, "64.0kb/s | 902.3Hz");
        assert.ok(field.title.includes("Limited by extension processing"));
        graph.send({ type: "setLang", lang: "zh" });
        assert.strictEqual(rate.textContent, "64.0kb/s | 902.3Hz");
        graph.send({ type: "liveCompositeSample", samples: [], actualHz: 800, bytesPerSecond: 12345 });
        assert.strictEqual(rate.textContent, "12.3kb/s | 800.0Hz");
        graph.send({ type: "setLang", lang: "en" });

        // Debug sessions suppress the mode: frequency input is usable again and the reason is shown.
        graph.send({
            type: "liveStatus",
            running: true,
            actualHz: 30,
            bytesPerSecond: 0,
            effectiveIntervalMs: 33,
            unlimitedActive: false,
            unlimitedSuppressedReason: "debug",
            limitedBy: null
        });
        assert.strictEqual(rate.textContent, "0.0kb/s | 30.0Hz");
        assert.strictEqual(doc.getElementById("frequency").disabled, false);
        assert.ok(field.title.includes("inactive during debug sessions"));
        graph.send({ type: "liveStatus", running: false, actualHz: 0, bytesPerSecond: 99999 });
        graph.send({ type: "chartValues", samples: [], actualHz: 900, bytesPerSecond: 99999 });
        assert.strictEqual(rate.textContent, "0.0kb/s | 0.0Hz", "late telemetry cannot restore stopped rates");

        graph.send({ type: "liveUnlimited", available: false, enabled: false });
        assert.strictEqual(slider.max, "3");
        assert.strictEqual(doc.getElementById("frequency").value, "30");
        graph.assertHealthy();
    } finally {
        graph.close();
    }
    console.log("Unlimited sampling host and webview tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
