"use strict";
const assert = require("assert");
const { paint } = require("../src/webview/liveWatch/samplingRateMotion");
const width = 208,
    height = 28;
const frame = (seconds) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    assert.strictEqual(paint(pixels, width, height, seconds), true);
    return pixels;
};
const early = frame(0.15);
const middle = frame(0.6);
const full = frame(2);
const next = frame(2.25);
const at = (pixels, x, y) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4));
assert.strictEqual(at(early, 0, 14)[3], 0, "the wave has not reached the left edge");
assert(at(early, width - 10, 14)[3] > 150, "the soft reveal starts at the right-hand centre");
assert(
    middle.some((value, index) => index % 4 === 3 && value > 0 && value < 255),
    "the wavefront has a soft moving edge"
);
assert(
    full.every((value, index) => index % 4 !== 3 || value === 255),
    "the completed reveal fills the track"
);
assert.notDeepStrictEqual(at(full, 70, 3), at(full, 70, 24), "colour varies vertically as well as horizontally");
assert.notDeepStrictEqual(full, next, "revealed colour fields keep undulating after the leading wave passes");
for (let x = 1; x < width; x++) {
    const before = at(full, x - 1, 14),
        after = at(full, x, 14);
    assert(
        after.slice(0, 3).every((value, i) => Math.abs(value - before[i]) <= 2),
        "colour stays smoothly blended"
    );
}
assert.deepStrictEqual(frame(2), full, "motion is deterministic and uses no random particles");
assert.deepStrictEqual(frame(-1), frame(0));
for (const [w, h, time] of [
    [0, 1, 0],
    [385, 1, 0],
    [1, 65, 0],
    [1.5, 1, 0],
    [1, 1, NaN],
    [1, 1, Infinity]
])
    assert.strictEqual(paint(new Uint8ClampedArray(4), w, h, time), false);
assert.strictEqual(paint(new Uint8ClampedArray(1), 1, 1, 0), false);
console.log("Bounded sampling texture, circular reveal, irregular colour and continuing wave motion passed");
