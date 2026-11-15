"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { ProbeRsDecoder, encodeRequest, decodeSamples } = require("../src/probeRsProtocol");
const { nativePlan, nativeRecipe, unpackRecipe } = require("../src/probeRsReadPlan");

scenario("bounded control frames survive split and coalesced delivery", () => {
    const messages = [];
    const decoder = new ProbeRsDecoder((message) => messages.push(message));
    const a = encodeRequest(1, "plan", { generation: 2 });
    const b = encodeRequest(2, "hold", true);
    decoder.receive(a.subarray(0, 3));
    decoder.receive(Buffer.concat([a.subarray(3), b]));
    assert.equal(messages.length, 2);
    assert.equal(messages[0].value.params.generation, 2);
    assert.equal(messages[1].value.method, "hold");
    assert.throws(() => encodeRequest(3, "plan", "x".repeat(1024 * 1024)), /budget/);
    assert.throws(() => decoder.receive(Buffer.from([255, 255, 255, 255])), /length/);
    const bad = new ProbeRsDecoder(() => {});
    assert.throws(() => bad.receive(Buffer.alloc(3 * 1024 * 1024)), /budget/);
});

scenario("sample frames preserve exact bytes, timestamps and generation", () => {
    const body = Buffer.alloc(12 + 2 * 16);
    body[0] = 2;
    body.writeUInt32LE(9, 1);
    body[5] = 3;
    body.writeUInt16LE(2, 6);
    body.writeUInt32LE(4, 8);
    for (let i = 0; i < 2; i++) {
        body.writeDoubleLE(1000.125 + i, 12 + i * 16);
        body.writeFloatLE(0.5, 20 + i * 16);
        body.writeUInt32LE(100 + i, 24 + i * 16);
    }
    const result = decodeSamples(body);
    assert.equal(result.generation, 9);
    assert.equal(result.samples[0].t, 1000.125);
    assert.equal(result.samples[1].bytes.readUInt32LE(), 101);
    let received;
    const frame = Buffer.alloc(body.length + 4);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    new ProbeRsDecoder((value) => {
        received = value;
    }).receive(frame);
    assert.equal(received.recipe, 3);
    for (const offset of [1, 5, 6, 8]) {
        const invalid = Buffer.from(body);
        invalid.fill(0, offset, offset + (offset === 5 ? 1 : offset === 6 ? 2 : 4));
        assert.throws(() => decodeSamples(invalid));
    }
    assert.throws(() => decodeSamples(Buffer.alloc(3)), /Truncated/);
    body.writeDoubleLE(NaN, 12);
    assert.throws(() => decodeSamples(body), /timestamp/);
    body.writeDoubleLE(2000, 12);
    assert.throws(() => decodeSamples(body), /unordered/);
});

scenario("native plans merge safe adjacent RAM and preserve consumer widths", () => {
    const ram = [{ start: 0x20000000, end: 0x20001000 }];
    const a = { name: "a", address: 0x20000000, size: 4 };
    const b = { name: "b", address: 0x20000008, size: 4 };
    const plan = nativePlan({
        graphItems: [a],
        sidebarItems: [{ ...a, size: 8 }, b],
        graphIntervalMs: 10,
        unlimited: true,
        ramSectionRanges: ram
    });
    assert.equal(plan.rate.unlimitedActive, true);
    assert.deepEqual(
        plan.recipes[3].groups.map(({ address, count }) => ({ address, count })),
        [{ address: 0x20000000, count: 12 }]
    );
    const values = unpackRecipe(plan.recipes[3], Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 2000);
    assert.equal(values[0].bytes.length, 8);
    assert.deepEqual(values[1].bytes, [9, 10, 11, 12]);
    assert.throws(() => unpackRecipe(plan.recipes[3], Buffer.alloc(1), 0), /payload/);
    assert.throws(() => nativeRecipe([{ ...a, runtimeLayout: {} }], ram), /runtime/);
    assert.throws(() => nativeRecipe([{ ...a, address: 0x40000000 }], ram), /RAM/);
    assert.throws(() => nativeRecipe([{ ...a, name: "" }], ram), /name/);
    assert.throws(() => nativeRecipe([{ ...a, size: 4097 }], ram), /budget/);
    assert.deepEqual(nativeRecipe([], []).groups, []);
});
console.log("probe-rs protocol and read-plan tests passed");
