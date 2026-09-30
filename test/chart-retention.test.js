"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const {
    intervalMsFromHz,
    normalizeFrequencyHz,
    MIN_FREQUENCY_HZ,
    MAX_FREQUENCY_HZ
} = require("../src/samplingFrequency");

const graph = render(getLiveWatchContent({ maxSamples: 2000, frequencyHz: 200 }, "en"));
try {
    graph.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    const samples = Array.from({ length: 12513 }, (_, i) => ({ name: "tick", value: i, t: 1000 + i * 5 }));
    graph.send({ type: "liveSample", samples });
    const retained = graph.window.data.tick;
    assert.ok(retained.length <= graph.window.MAXPTS);
    assert.ok(retained.at(-1).t - retained[0].t >= 60000, "200 Hz must retain the whole 60-second window");
    graph.assertHealthy();
} finally {
    graph.close();
}

// The clock period is round(1000 / hz), so the effective rate can exceed the nominal one. Sizing
// the buffer from the nominal Hz left 731 of the 2000 selectable frequencies below 60 seconds;
// 181.9 Hz was the worst at 54.57 s. Sweep every step through the renderer's own limit function.
{
    const sweep = render(getLiveWatchContent({ maxSamples: 2000, frequencyHz: 200 }, "en"));
    try {
        const chunk = sweep.window.RETENTION_TRIM_CHUNK;
        assert.strictEqual(chunk, 256, "the trim chunk the limit compensates for must stay in sync");
        const steps = Math.round((MAX_FREQUENCY_HZ - MIN_FREQUENCY_HZ) * 10);
        let worst = Infinity;
        let worstHz = 0;
        for (let i = 0; i <= steps; i++) {
            const hz = normalizeFrequencyHz(MIN_FREQUENCY_HZ + i / 10);
            const ms = intervalMsFromHz(hz);
            const limit = sweep.window.retainedSampleLimit(hz, ms);
            // Worst case is the trim firing one point over the limit and taking a full chunk.
            const trimmed = Math.min(chunk, Math.max(1, Math.floor(limit / 20)));
            const span = (limit + 1 - trimmed - 1) * ms;
            if (span < worst) {
                worst = span;
                worstHz = hz;
            }
        }
        assert.ok(
            worst >= 60000,
            `every selectable frequency must retain 60 s; worst was ${worst} ms at ${worstHz} Hz`
        );
        sweep.assertHealthy();
    } finally {
        sweep.close();
    }
}

// End-to-end at the previously worst frequency: the real trim path, not just the limit arithmetic.
const rounded = render(getLiveWatchContent({ maxSamples: 2000, frequencyHz: 181.9 }, "en"));
try {
    assert.strictEqual(rounded.window.CFG.intervalMs, 5, "181.9 Hz rounds to a 5 ms period, i.e. an effective 200 Hz");
    rounded.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    const samples = Array.from({ length: 12513 }, (_, i) => ({ name: "tick", value: i, t: 1000 + i * 5 }));
    rounded.send({ type: "liveSample", samples });
    const retained = rounded.window.data.tick;
    assert.ok(retained.length <= rounded.window.MAXPTS);
    assert.ok(
        retained.at(-1).t - retained[0].t >= 60000,
        "a nominal rate whose period rounds down must still retain the whole 60-second window"
    );
    rounded.assertHealthy();
} finally {
    rounded.close();
}

const limited = render(getLiveWatchContent({ maxSamples: 100, autoMaxSamples: false, frequencyHz: 200 }, "en"));
try {
    assert.strictEqual(limited.window.MAXPTS, 100, "an explicit point limit must still be respected");
    limited.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    limited.send({ type: "liveFrequency", frequencyHz: 30, intervalMs: 33 });
    limited.send({
        type: "liveSample",
        samples: Array.from({ length: 500 }, (_, i) => ({ name: "tick", value: i, t: 1000 + i * 33 }))
    });
    assert.ok(limited.window.data.tick.length <= 100, "explicit limits override time retention after a rate change");
    limited.assertHealthy();
} finally {
    limited.close();
}

const changing = render(getLiveWatchContent({ maxSamples: 2000, frequencyHz: 200 }, "en"));
try {
    changing.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    changing.send({
        type: "liveSample",
        samples: Array.from({ length: 12257 }, (_, i) => ({ name: "tick", value: i, t: 1000 + i * 5 }))
    });
    let time = changing.window.data.tick.at(-1).t;
    for (const hz of [30, 0.1, 200]) {
        const ms = intervalMsFromHz(hz);
        changing.send({ type: "liveFrequency", frequencyHz: hz, intervalMs: ms });
        for (let i = 0; i < Math.ceil(65000 / ms); i++) {
            time += ms;
            changing.window.onSamples([{ name: "tick", value: i % 10 === 0 ? null : i, t: time }]);
            const retained = changing.window.data.tick;
            assert.ok(retained.at(-1).t - retained[0].t >= 60000, `rate change to ${hz} Hz keeps 60 s`);
            assert.ok(retained.length <= 20000, "automatic retention remains bounded during rate changes");
            if (hz === 30 && i === 0) {
                changing.window.freezeChart();
                const snapshot = changing.window.analysis.snapshot.tick;
                assert.strictEqual(
                    snapshot.length,
                    retained.length,
                    "freezing preserves the retained transition history"
                );
                assert.ok(snapshot.at(-1).t - snapshot[0].t >= 60000);
                changing.window.resumeChart();
            }
        }
    }
    changing.assertHealthy();
} finally {
    changing.close();
}
console.log("High-frequency chart retention tests passed");
