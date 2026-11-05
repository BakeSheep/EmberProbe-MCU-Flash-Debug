"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { MAX_READ_BYTES, RttBuffer, utf8Boundary } = require("../src/rttBuffer");

scenario("reads continue from the returned cursor", () => {
    const buffer = new RttBuffer({ maxBytes: 64 });
    buffer.append("hello ");
    buffer.append(Buffer.from("world"));
    const first = buffer.read();
    assert.strictEqual(first.data.toString(), "hello world");
    assert.deepStrictEqual(
        [first.cursor, first.nextCursor, first.droppedBytes, first.reset, first.more],
        [0, 11, 0, false, false]
    );
    buffer.append("!\n");
    const next = buffer.read({ generation: first.generation, cursor: first.nextCursor });
    assert.strictEqual(next.data.toString(), "!\n");
    assert.strictEqual(next.nextCursor, 13);
    const idle = buffer.read({ generation: next.generation, cursor: next.nextCursor });
    assert.strictEqual(idle.data.length, 0);
});

scenario("appended chunks are copied", () => {
    const buffer = new RttBuffer({ maxBytes: 64 });
    const chunk = Buffer.from("abc");
    buffer.append(chunk);
    chunk.fill(0x7a);
    assert.strictEqual(buffer.read().data.toString(), "abc");
});

scenario("old bytes are evicted and reported as dropped", () => {
    const buffer = new RttBuffer({ maxBytes: 8 });
    buffer.append("0123");
    buffer.append("4567");
    buffer.append("89");
    assert.deepStrictEqual(buffer.stats(), { generation: 0, start: 2, end: 10, bytes: 8 });
    const read = buffer.read({ generation: 0, cursor: 0 });
    assert.strictEqual(read.data.toString(), "23456789");
    assert.strictEqual(read.droppedBytes, 2);
    assert.strictEqual(read.cursor, 2);
    // A single chunk larger than the buffer keeps its tail
    buffer.append("abcdefghijkl");
    assert.strictEqual(buffer.read().data.toString(), "efghijkl");
    assert.deepStrictEqual(buffer.stats(), { generation: 0, start: 14, end: 22, bytes: 8 });
});

scenario("cursors from another generation restart at the oldest byte", () => {
    const previous = new RttBuffer({ maxBytes: 64, generation: 0 });
    previous.append("before");
    const old = previous.read();
    const buffer = new RttBuffer({ maxBytes: 64, generation: 1 });
    buffer.append("after");
    const read = buffer.read({ generation: old.generation, cursor: old.nextCursor });
    assert.strictEqual(read.generation, 1);
    assert.strictEqual(read.reset, true);
    assert.strictEqual(read.data.toString(), "after");
    // A cursor beyond the end is also treated as stale
    assert.strictEqual(buffer.read({ generation: 1, cursor: 999 }).reset, true);
    assert.strictEqual(buffer.read({ generation: 1, cursor: -1 }).reset, true);
});

scenario("reads are limited and never split a UTF-8 character", () => {
    const buffer = new RttBuffer({ maxBytes: 64 });
    buffer.append("ab温度");
    const first = buffer.read({ maxBytes: 4 });
    assert.strictEqual(first.data.toString(), "ab");
    assert.strictEqual(first.more, true);
    const rest = buffer.read({ generation: first.generation, cursor: first.nextCursor, maxBytes: 64 });
    assert.strictEqual(rest.data.toString(), "温度");
    // Invalid limits fall back to the default, oversized ones are capped
    assert.strictEqual(buffer.read({ maxBytes: "x" }).data.toString(), "ab温度");
    assert.ok(MAX_READ_BYTES >= 64);
});

scenario("utf8Boundary only trims incomplete trailing sequences", () => {
    const bytes = Buffer.from("a温");
    assert.strictEqual(utf8Boundary(bytes, bytes.length), 4);
    assert.strictEqual(utf8Boundary(bytes, 3), 1);
    assert.strictEqual(utf8Boundary(bytes, 2), 1);
    assert.strictEqual(utf8Boundary(Buffer.from([0x80, 0x80]), 2), 2);
    assert.strictEqual(utf8Boundary(Buffer.from("😀"), 3), 0);
});

scenario("base64 reads keep exact bytes at the limit", () => {
    const buffer = new RttBuffer();
    buffer.append("a温度");
    const read = buffer.read({ maxBytes: 3, encoding: "base64" });
    assert.deepStrictEqual(read.data, Buffer.from("a温度").subarray(0, 3));
    assert.strictEqual(read.nextCursor, 3);
    assert.strictEqual(read.more, true);
});

scenario("buffer size is validated", () => {
    assert.throws(
        () => new RttBuffer({ maxBytes: 0 }),
        (error) => error.code === "RTT_INVALID_BUFFER"
    );
    assert.strictEqual(new RttBuffer().append(""), 0);
});
