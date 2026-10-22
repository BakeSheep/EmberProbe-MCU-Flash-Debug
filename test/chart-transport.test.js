"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { encodeViewport, decodeViewport } = require("../src/webview/liveWatch/chartTransport");

const store = new ChartHistoryStore();
const items = [
    { name: "counter", type: "u64" },
    { name: "signal", type: "f64" },
    { name: "signed", type: "i64" }
];
const exact = "18446744073709551615";
store.configure("p", items);
store.append(
    "p",
    [
        { name: "counter", t: 1, value: Number(exact), valueText: exact },
        { name: "counter", t: 2, value: null },
        { name: "counter", t: 3, value: 2 ** 53 - 1 },
        { name: "signal", t: 1, value: -0, valueText: "-0" },
        { name: "signal", t: 2, value: null },
        { name: "signal", t: 3, value: 1.23456789012345 },
        { name: "signed", t: 1, value: -9223372036854775808, valueText: "-9223372036854775808" }
    ],
    3
);
const original = store.viewport(
    "p",
    items.map((item) => item.name),
    { min: 0, max: 4 },
    100
);
assert.strictEqual(original.series.length, 5, "missing samples split both channels into continuous segments");
const before = structuredClone(original);
const { message, transfer } = encodeViewport(original);
assert.notStrictEqual(message, original);
assert.deepStrictEqual(original, before, "encoding leaves store output intact");
for (const key of Object.keys(original).filter((key) => key !== "series"))
    assert.strictEqual(message[key], original[key], `status property ${key} is passed through untouched`);
assert.strictEqual(message.series.length, 3, "each consecutive name run shares one set of columns");
assert.deepStrictEqual([...message.series[0].ends], [1, 2]);
assert.deepStrictEqual(message.series[0].texts, [[0, exact]]);
assert.deepStrictEqual(decodeViewport(message.series), original.series);
assert.ok(Object.is(message.series[1].v[0], -0));
assert.ok(Object.is(decodeViewport(message.series)[2].arr[0].v, -0));
assert.strictEqual(message.series[0].v[1], 2 ** 53 - 1, "safe integers stay exact in Float64");

const buffers = message.series.flatMap((entry) => [
    entry.t.buffer,
    entry.v.buffer,
    entry.ends.buffer,
    entry.visibleCounts.buffer
]);
assert.strictEqual(new Set(transfer).size, transfer.length);
assert.deepStrictEqual(transfer, buffers);
assert.ok(transfer.every((buffer) => buffer instanceof ArrayBuffer));
const cloned = structuredClone(message, { transfer });
assert.ok(
    transfer.every((buffer) => buffer.byteLength === 0),
    "the transfer list detaches every source buffer"
);
assert.deepStrictEqual(decodeViewport(cloned.series), original.series);

const legacy = { name: "a", item: {}, arr: [{ t: 1, v: -0, valueText: "-0" }] };
const zeroCount = { ...legacy, arr: [], visibleCount: 0 };
const other = { ...legacy, name: "b" };
const runs = encodeViewport({ series: [legacy, zeroCount, other, legacy], evictedNames: ["evicted"] });
assert.deepStrictEqual(runs.message.evictedNames, ["evicted"]);
assert.deepStrictEqual(
    runs.message.series.map((entry) => entry.name),
    ["a", "b", "a"]
);
assert.deepStrictEqual([...runs.message.series[0].ends], [1, 1], "empty segments retain their boundary");
assert.ok(Number.isNaN(runs.message.series[0].visibleCounts[0]));
assert.deepStrictEqual(decodeViewport(runs.message.series), [legacy, zeroCount, other, legacy]);
assert.strictEqual(decodeViewport([legacy])[0], legacy, "legacy entries pass through by identity");
assert.deepStrictEqual(decodeViewport([legacy, runs.message.series[0], other]), [legacy, legacy, zeroCount, other]);
assert.strictEqual(decodeViewport(runs.message.series)[0].visibleCount, undefined);
for (const input of [undefined, null, {}, "series", 42]) assert.deepStrictEqual(decodeViewport(input), []);
assert.deepStrictEqual(encodeViewport({ series: [], bounds: null }), {
    message: { series: [], bounds: null },
    transfer: []
});
assert.deepStrictEqual(decodeViewport([]), []);

const withoutText = encodeViewport({
    series: [
        {
            name: "plain",
            item: {},
            arr: [
                { t: 1, v: -0 },
                { t: 2, v: 2, valueText: 123 }
            ]
        }
    ]
});
assert.deepStrictEqual(withoutText.message.series[0].texts, []);
assert.deepStrictEqual(decodeViewport(withoutText.message.series)[0].arr, [
    { t: 1, v: -0, valueText: null },
    { t: 2, v: 2, valueText: null }
]);

const packed = cloned.series[0];
const malformed = [
    null,
    undefined,
    1,
    "bad",
    {},
    { ...packed, t: [...packed.t] },
    { ...packed, t: new Float32Array(2) },
    { ...packed, v: new Float32Array(2) },
    { ...packed, t: new DataView(new ArrayBuffer(16)) },
    { ...packed, v: new Float64Array(1) },
    { ...packed, ends: [1, 2] },
    { ...packed, ends: new Int32Array([1, 2]) },
    { ...packed, ends: new Uint32Array([2, 1]) },
    { ...packed, ends: new Uint32Array([1, 3]) },
    { ...packed, ends: new Uint32Array([1, 1]) },
    { ...packed, visibleCounts: new Float32Array(2) },
    { ...packed, visibleCounts: new Float64Array(1) },
    { ...packed, texts: null },
    { ...packed, texts: Array(1) },
    ...[null, {}, [], [0], [-1, "x"], [2, "x"], [0.5, "x"], [NaN, "x"], [0, null], [0, 1], [0, "x", 1]].map((text) => ({
        ...packed,
        texts: [text]
    }))
];
for (const entry of malformed) assert.deepStrictEqual(decodeViewport([entry, legacy]), [legacy]);

// The browser UMD export must accept typed arrays cloned in another realm.
const browser = vm.createContext({});
vm.runInContext(fs.readFileSync(require.resolve("../src/webview/liveWatch/chartTransport"), "utf8"), browser);
assert.deepStrictEqual(
    structuredClone(browser.EmberProbeChartTransport.decodeViewport(cloned.series)),
    original.series
);

const large = {
    series: Array.from({ length: 10 }, (_, channel) => ({
        name: `channel${channel}`,
        item: { type: "f64" },
        arr: Array.from({ length: 4800 }, (_, i) => ({
            t: 1700000000000 + i * 375,
            v: Math.sin(i + channel),
            valueText: null
        })),
        visibleCount: 360000
    }))
};
const largePacked = encodeViewport(large);
const packedBytes =
    largePacked.transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0) +
    Buffer.byteLength(
        JSON.stringify(largePacked.message, (key, value) => (ArrayBuffer.isView(value) ? undefined : value))
    );
assert.ok(
    packedBytes < Buffer.byteLength(JSON.stringify(large)) * 0.35,
    "packed replies are less than 35% of legacy JSON bytes"
);
assert.deepStrictEqual(decodeViewport(largePacked.message.series), large.series);
console.log("Chart transport round-trip, precision, gaps, validation, transfer and size tests passed");
