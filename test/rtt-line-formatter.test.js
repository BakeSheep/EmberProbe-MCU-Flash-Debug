"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const { RttLineFormatter, formatTimestamp, stripAnsi } = require("../src/rttLineFormatter");

const stamp = (ms) => `t${ms}`;

scenario("LF and CRLF become CRLF, split CRLF included", () => {
    const formatter = new RttLineFormatter();
    assert.strictEqual(formatter.push("a\nb\r"), "a\r\nb");
    assert.strictEqual(formatter.push("\nc\r\n"), "\r\nc\r\n");
    assert.strictEqual(formatter.flush(), "");
});

scenario("a lone CR is kept for progress lines", () => {
    const formatter = new RttLineFormatter();
    assert.strictEqual(formatter.push("10%\r20%\r"), "10%\r20%");
    assert.strictEqual(formatter.flush(), "\r");
});

scenario("UTF-8 split across chunks is joined", () => {
    const formatter = new RttLineFormatter();
    const bytes = Buffer.from("温度\n");
    assert.strictEqual(formatter.push(bytes.subarray(0, 2)), "");
    assert.strictEqual(formatter.push(bytes.subarray(2)), "温度\r\n");
});

scenario("timestamps are written when a line starts", async () => {
    const clock = new FakeClock();
    const formatter = new RttLineFormatter({ timestamps: true, clock, formatTime: stamp });
    assert.strictEqual(formatter.push("par"), "[t1000] par");
    await clock.advance(5);
    assert.strictEqual(formatter.push("tial\n\nnext"), "tial\r\n[t1005] \r\n[t1005] next");
    await clock.advance(5);
    assert.strictEqual(formatter.push("\r50%"), "\r[t1010] 50%");
    formatter.setTimestamps(false);
    assert.strictEqual(formatter.push("\nplain\n"), "\r\nplain\r\n");
});

scenario("ANSI sequences pass through and can be stripped for files", () => {
    const formatter = new RttLineFormatter();
    const colored = "\x1b[31mERR\x1b[0m done\x1b]0;title\x07\n";
    assert.strictEqual(formatter.push(colored), "\x1b[31mERR\x1b[0m done\x1b]0;title\x07\r\n");
    assert.strictEqual(stripAnsi(colored), "ERR done\n");
    assert.strictEqual(stripAnsi(undefined), "");
});

scenario("default timestamps are local HH:MM:SS.mmm", () => {
    const at = new Date(2026, 10, 3, 9, 5, 7, 42).getTime();
    assert.strictEqual(formatTimestamp(at), "09:05:07.042");
});
