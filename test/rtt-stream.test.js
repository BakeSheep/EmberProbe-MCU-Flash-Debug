"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { checkStream, fixtureDelta, parseFixtureStatus } = require("./helpers/rtt-stream");

function line(sequence) {
    const bytes = Buffer.alloc(64, 10);
    bytes.write(`S ${sequence.toString(16).padStart(8, "0")} `, "ascii");
    for (let column = 11; column < 63; column++) bytes[column] = 97 + (((sequence + column) >>> 0) % 26);
    return bytes;
}

const stream = (first, count) => Buffer.concat(Array.from({ length: count }, (_, i) => line((first + i) >>> 0)));
const envelope = { firstSequence: 10, attempts: 5 };

scenario("finite envelope finds leading, internal and trailing omissions", () => {
    const result = checkStream([line(11), line(13)], envelope);
    assert.deepStrictEqual([result.missingLeading, result.missingInternal, result.missingTrailing], [1, 1, 1]);
    assert.strictEqual(result.missingLines, 3);
    assert.strictEqual(result.internalGaps, 1);
    assert.strictEqual(result.complete, false);
    const empty = checkStream(Buffer.alloc(0), envelope);
    assert.strictEqual(empty.missingLines, 5);
    assert.strictEqual(empty.complete, false);
    assert.strictEqual(checkStream(stream(10, 0), { firstSequence: 10, attempts: 0 }).complete, true);
});

scenario("chunk boundaries preserve every byte and complete pattern", () => {
    const bytes = stream(10, 5);
    const result = checkStream(
        [bytes.subarray(0, 1), bytes.subarray(1, 63), bytes.subarray(63, 66), bytes.subarray(66)],
        envelope
    );
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.rawBytes, 320);
    assert.strictEqual(result.lines, 5);
    assert.strictEqual(result.partialBytes, 0);
});

scenario("unterminated 63-byte tail is never a full 64-byte line", () => {
    const result = checkStream(stream(10, 5).subarray(0, 319), envelope);
    assert.strictEqual(result.lines, 4);
    assert.strictEqual(result.partialBytes, 63);
    assert.strictEqual(result.missingTrailing, 1);
    assert.strictEqual(result.missingLines, 1);
    assert.strictEqual(result.complete, false);
    assert.strictEqual(checkStream(line(10).subarray(0, 63), { firstSequence: 10, attempts: 1 }).lines, 0);
});

scenario("trim regression accounts for 64000 attempted, 16383 accepted and 47617 rejected bytes", () => {
    const before = status(0, 0, 0);
    const after = status(1000, 16383, 47617);
    const counters = fixtureDelta(before, after);
    const result = checkStream(stream(0, 1000).subarray(0, 16383), counters);
    assert.deepStrictEqual(
        [counters.attempts, counters.attemptedBytes, counters.acceptedBytes, counters.rejectedBytes],
        [1000, 64000, 16383, 47617]
    );
    assert.deepStrictEqual([result.rawBytes, result.lines, result.partialBytes], [16383, 255, 63]);
    assert.strictEqual(result.missingLines, 745);
    assert.strictEqual(result.missingTrailing, 745);
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.internalGaps, 0); // A gap-free prefix does not establish a loss-free finite burst.
});

scenario("duplicates and backward resets cannot fill an envelope", () => {
    const result = checkStream([line(10), line(11), line(10), line(12), line(12)], envelope);
    assert.strictEqual(result.duplicates, 2);
    assert.strictEqual(result.resets, 1);
    assert.strictEqual(result.missingLines, 2);
    assert.strictEqual(result.complete, false);
    const outside = checkStream([stream(10, 5), line(15)], envelope);
    assert.strictEqual(outside.outOfEnvelope, 1);
    assert.strictEqual(outside.complete, false);
});

scenario("uint32 sequence and pattern wrap match C arithmetic", () => {
    const result = checkStream(stream(0xfffffffe, 4), { firstSequence: 0xfffffffe, attempts: 4 });
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.resets, 0);
    assert.strictEqual(result.last, 1);
    const gap = checkStream([line(0xfffffffe), line(0)], { firstSequence: 0xfffffffe, attempts: 3 });
    assert.strictEqual(gap.internalGaps, 1);
    assert.strictEqual(gap.missingInternal, 1);
});

scenario("invalid pattern, width, header and binary bytes remain malformed raw records", () => {
    for (const column of [0, 1, 2, 10, 11, 35, 62]) {
        const bytes = line(10);
        bytes[column] = 0xff;
        const result = checkStream(bytes, { firstSequence: 10, attempts: 1 });
        assert.strictEqual(result.malformed, 1, `column ${column}`);
        assert.strictEqual(result.lines, 0);
        assert.strictEqual(result.rawBytes, 64);
        assert.strictEqual(result.missingLines, 1);
    }
    for (const bytes of [
        Buffer.from("unrelated\n"),
        Buffer.concat([line(10).subarray(0, 62), Buffer.from("\n")]),
        Buffer.concat([Buffer.from("x"), line(10)])
    ]) {
        assert.strictEqual(checkStream(bytes).malformed, 1);
    }
    const binary = checkStream([Buffer.from([0xff, 0xfe]), line(10)]);
    assert.strictEqual(binary.rawBytes, 66);
    assert.strictEqual(binary.malformed, 1);
});

scenario("partial trim records inside a capture are malformed until the next valid boundary", () => {
    const result = checkStream([line(10), line(11).subarray(0, 23), line(12), line(13), line(14)], envelope);
    assert.strictEqual(result.rawBytes, 279);
    assert.strictEqual(result.lines, 3);
    assert.strictEqual(result.malformed, 1);
    assert.strictEqual(result.missingInternal, 2);
    assert.strictEqual(result.partialBytes, 0);
    assert.strictEqual(result.complete, false);
});

scenario("unterminated firmware status never snapshots a partial counter", () => {
    const response =
        "status: profile=dtcm cb=0x200041a4 up=1s rate=0 seq=0\r\n" +
        "status: ch0 mode=skip written=1 dropped=0 maxCycles=3\r\n" +
        "status: ch1 mode=trim written=16383 dropped=47617 maxCycles=123";
    assert.strictEqual(parseFixtureStatus(response), null);
    assert.strictEqual(parseFixtureStatus(`${response}\r\n`).channels[1].maxWriteCycles, 123);
});

scenario("unbounded capture leaves finite loss unknown and validates its envelope", () => {
    const result = checkStream(line(10));
    assert.strictEqual(result.missingLines, null);
    assert.strictEqual(result.complete, false);
    for (const invalid of [
        { firstSequence: -1, attempts: 2 },
        { firstSequence: 0x100000000, attempts: 2 },
        { firstSequence: 0, attempts: 0x80000000 },
        { firstSequence: 0, attempts: 1.5 }
    ])
        assert.throws(() => checkStream([], invalid), /finite stream/u);
});

function status(sequence, written, dropped, cycles = 100) {
    return parseFixtureStatus(
        `status: profile=dtcm cb=0x200041a4 up=1s rate=0 seq=${sequence}\nstatus: ch0 mode=skip written=30 dropped=0 maxCycles=3\nstatus: ch1 mode=trim written=${written} dropped=${dropped} maxCycles=${cycles}\n`
    );
}

scenario("fixture status requires the complete response and marks mode as shadow", () => {
    assert.strictEqual(parseFixtureStatus("status: profile=dtcm cb=0x200041a4 up=1s rate=0 seq=0\n"), null);
    assert.strictEqual(status(0, 0, 0).channels[1].shadowMode, "trim");
    assert.throws(() => status(0x100000000, 0, 0), /uint32/u);
});

scenario("firmware byte and sequence counters wrap and lifetime maxima are not subtracted", () => {
    const result = fixtureDelta(status(0xffffffff, 0xfffffff0, 0xfffffff0, 200), status(1, 80, 16, 300));
    assert.deepStrictEqual([result.attempts, result.acceptedBytes, result.rejectedBytes], [2, 96, 32]);
    assert.deepStrictEqual([result.lifetimeMaxWriteCyclesBefore, result.lifetimeMaxWriteCyclesAfter], [200, 300]);
    assert.throws(() => fixtureDelta(status(5, 0, 0), status(4, 0, 0)), /reset/u);
    assert.throws(() => fixtureDelta(status(0, 0, 0), status(1, 63, 0)), /64 bytes/u);
    const changed = status(1, 64, 0);
    changed.controlBlock++;
    assert.throws(() => fixtureDelta(status(0, 0, 0), changed), /identity/u);
});
