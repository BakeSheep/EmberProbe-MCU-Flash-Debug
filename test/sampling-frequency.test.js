"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
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
scenario("Ignore obsolete intervals and read the effective frequency", () => {
    const legacy = { sampleIntervalMs: 50 };
    const configuration = { get: (key, fallback) => legacy[key] ?? fallback };
    assert.strictEqual(configuredFrequencyHz(configuration), 30);
    legacy.sampleFrequencyHz = 60;
    assert.strictEqual(configuredFrequencyHz(configuration), 60);
});

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
    provider._sampling.frequencyHz = 30;
    provider._sampling.intervalMs = 33;
    provider._sampling.session = { setIntervalMs: (interval) => intervals.push(interval) };
    provider._livePanels = new Map([[1, { post: (message) => messages.push(message) }]]);

    assert.strictEqual(await provider._sampling.saveFrequency(60), 60);
    assert.strictEqual(settings.get("sampleFrequencyHz"), 60);
    assert.deepStrictEqual(targets, [vscode.ConfigurationTarget.Workspace]);
    assert.deepStrictEqual(intervals, [17]);
    assert.strictEqual(messages.at(-1).frequencyHz, 60);
    assert.strictEqual(configuredFrequencyHz(config), 60, "Reopening this workspace should restore the chosen rate");

    provider._sampling.setIntervalMs(17);
    assert.strictEqual(
        provider._sampling.frequencyHz,
        60,
        "Matching internal interval must preserve the requested rate"
    );
    await assert.rejects(provider._sampling.saveFrequency(0), { code: "INVALID_SAMPLE_FREQUENCY" });
    assert.strictEqual(settings.get("sampleFrequencyHz"), 60);
    settings.set("sampleFrequencyHz", 45);
    provider.samplingFrequencyConfigurationChanged();
    assert.strictEqual(provider._sampling.frequencyHz, 45);
    assert.strictEqual(provider._sampling.intervalMs, 22);
    let finishSave;
    config.update = () => new Promise((resolve) => (finishSave = resolve));
    const saving = provider._sampling.saveFrequency(200);
    assert.strictEqual(intervals.at(-1), 5, "apply the runtime rate before workspace persistence finishes");
    finishSave();
    await saving;
    console.log("Sampling frequency conversion and workspace persistence tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
