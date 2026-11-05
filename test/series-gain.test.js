"use strict";
const assert = require("assert");
const { create } = require("../src/webview/liveWatch/seriesGain");
const { scenario } = require("./helpers/scenario");

function pageState() {
    return {
        watch: [
            { name: "a", type: "f32" },
            { name: "a.x", type: "u32" },
            { name: "a[0]", type: "u32" },
            { name: "ab", type: "u64" },
            { name: "pointer", type: "u32", isPointer: true },
            { name: "object", isComposite: true },
            { name: "text", type: "string" },
            { name: "symbolPointer", type: "u32" }
        ],
        symbols: new Map([["symbolPointer", { isPointer: true }]])
    };
}

(async () => {
    await scenario("Display gain accepts finite numeric settings only and forgets descendants", () => {
        const state = pageState();
        const gain = create(state);
        assert.equal(gain.get("a"), 1);
        for (const name of ["pointer", "symbolPointer", "object", "text", "missing"])
            assert.equal(gain.set(name, 2), false);
        for (const value of [NaN, Infinity, -Infinity, "2", null]) assert.equal(gain.set("a", value), false);
        assert.equal(gain.set("a", 1), false);
        for (const name of ["a", "a.x", "a[0]", "ab"]) assert.equal(gain.set(name, -0.125), true);
        gain.forget("a");
        for (const name of ["a", "a.x", "a[0]"]) assert.equal(gain.get(name), 1);
        assert.equal(gain.get("ab"), -0.125, "a similarly named variable is independent");
        gain.set("a", 0);
        assert.equal(gain.get("a"), 0);
        gain.set("a", 1);
        assert.equal(Object.hasOwn(state.gain.values, "a"), false);
        assert.equal(create(pageState()).get("ab"), 1, "each page starts with fresh settings");
    });

    await scenario("Projection preserves raw points, gaps, exact unit-gain values and cache identity", () => {
        const gain = create(pageState());
        const points = Object.freeze([
            Object.freeze({ t: 1, v: 2, valueText: "2" }),
            Object.freeze({ t: 2, v: null }),
            Object.freeze({ t: 3, v: -4 })
        ]);
        const series = Object.freeze([Object.freeze({ item: { name: "a" }, arr: points })]);
        const unit = gain.project(series);
        assert.strictEqual(unit[0], series[0]);
        assert.strictEqual(gain.project(series), unit);
        gain.set("a", -2);
        const scaled = gain.project(series);
        assert.deepEqual(
            scaled[0].arr.map((p) => p.v),
            [-4, null, 8]
        );
        assert.equal(scaled[0].arr[0].valueText, undefined, "scaled points cannot reuse raw exact labels");
        assert.strictEqual(gain.project(series), scaled);
        assert.deepEqual(
            points.map((p) => p.v),
            [2, null, -4]
        );
        gain.set("a", 0);
        assert.deepEqual(
            gain.project(series)[0].arr.map((p) => p.v),
            [0, null, -0]
        );
        gain.set("a", 2);
        const overflow = gain.project([
            { item: { name: "a" }, visibleCount: 2, arr: [{ v: Number.MAX_VALUE }, { v: undefined }] }
        ]);
        assert.equal(overflow[0].visibleCount, undefined, "raw counts must not hide an all-overflow display");
        assert.deepEqual(
            overflow[0].arr.map((p) => p.v),
            [null, null]
        );
        assert.notStrictEqual(gain.project([...series]), scaled, "new data invalidates the display cache");
        gain.forget("a");
        assert.strictEqual(gain.project(series)[0], series[0]);
    });

    await scenario("Scaled labels discard enums, preserve unit-gain precision and use decimal fractions", () => {
        const gain = create(pageState());
        const exact = { value: Number("18446744073709551615"), valueText: "18446744073709551615" };
        assert.equal(gain.format("ab", exact, 10), "18446744073709551615");
        assert.equal(gain.format("ab", exact, 16), "0xFFFFFFFFFFFFFFFF");
        const enumeration = { value: 2, valueText: "2", enumText: "Ready" };
        assert.equal(gain.format("a", enumeration, 10), "Ready");
        gain.set("a", 2);
        assert.equal(gain.format("a", enumeration, 16), "0x4");
        assert.equal(gain.formatPoint("a", { v: 4 }, 2), "0b100", "hover values are already scaled");
        gain.set("a", 0.125);
        assert.equal(gain.format("a", enumeration, 16), "0.25");
        assert.equal(gain.formatPoint("a", { v: 0.25 }, 16), "0.25");
        assert.equal(gain.format("a", { value: null }, 10), "—");
        gain.set("a", 2);
        assert.equal(gain.format("a", { value: Number.MAX_VALUE }, 16), "—");
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
