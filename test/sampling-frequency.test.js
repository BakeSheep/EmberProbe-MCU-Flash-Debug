"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const {
    configuredFrequencyHz,
    frequencyHzFromInterval,
    intervalMsFromHz,
    normalizeFrequencyHz
} = require("../src/samplingFrequency");

assert.strictEqual(intervalMsFromHz(30), 33);
assert.strictEqual(intervalMsFromHz(200), 5);
assert.strictEqual(frequencyHzFromInterval(100), 10);
assert.strictEqual(normalizeFrequencyHz(500), 200);
assert.strictEqual(configuredFrequencyHz({ get: (_key, fallback) => fallback }), 30);
assert.strictEqual(
    configuredFrequencyHz({
        inspect: (key) => (key === "sampleIntervalMs" ? { workspaceValue: 50 } : {}),
        get: (_key, fallback) => fallback
    }),
    20,
    "An explicit legacy interval should remain effective until a frequency is saved"
);
assert.strictEqual(
    configuredFrequencyHz({
        inspect: (key) => (key === "sampleIntervalMs" ? { workspaceValue: 50 } : { globalValue: 60 }),
        get: (_key, fallback) => fallback
    }),
    20,
    "A workspace legacy setting should take priority over a global frequency setting"
);

(async () => {
    const settings = new Map();
    const targets = [];
    const config = {
        get: (key, fallback) => settings.get(key) ?? fallback,
        inspect: (key) => ({ workspaceValue: settings.get(key) }),
        update: async (key, value, target) => {
            settings.set(key, value);
            targets.push(target);
        }
    };
    const vscode = {
        ConfigurationTarget: { Workspace: 2 },
        workspace: { getConfiguration: () => config }
    };
    const Provider = loadProvider(vscode);
    const provider = Object.create(Provider.prototype);
    const messages = [];
    const intervals = [];
    provider._liveFrequencyHz = 30;
    provider._liveIntervalMs = 33;
    provider._liveSession = { setIntervalMs: (interval) => intervals.push(interval) };
    provider._livePanels = new Map([[1, { post: (message) => messages.push(message) }]]);

    assert.strictEqual(await provider._saveLiveFrequency(60), 60);
    assert.strictEqual(settings.get("sampleFrequencyHz"), 60);
    assert.deepStrictEqual(targets, [vscode.ConfigurationTarget.Workspace]);
    assert.deepStrictEqual(intervals, [17]);
    assert.strictEqual(messages.at(-1).frequencyHz, 60);
    assert.strictEqual(configuredFrequencyHz(config), 60, "Reopening this workspace should restore the chosen rate");

    provider._setLiveInterval(17);
    assert.strictEqual(provider._liveFrequencyHz, 60, "Matching internal interval must preserve the requested rate");
    await assert.rejects(provider._saveLiveFrequency(0), { code: "INVALID_SAMPLE_FREQUENCY" });
    assert.strictEqual(settings.get("sampleFrequencyHz"), 60);
    settings.set("sampleFrequencyHz", 45);
    provider.samplingFrequencyConfigurationChanged();
    assert.strictEqual(provider._liveFrequencyHz, 45);
    assert.strictEqual(provider._liveIntervalMs, 22);
    console.log("Sampling frequency conversion and workspace persistence tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
