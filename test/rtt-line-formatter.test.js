"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const {
    AnsiStripper,
    RttHexFormatter,
    RttLineFormatter,
    RttRawFormatter,
    createRttFormatter,
    formatTimestamp
} = require("../src/rttLineFormatter");

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
    assert.strictEqual(new AnsiStripper().push(colored), "ERR done\n");
    assert.strictEqual(new AnsiStripper().push(undefined), "");
    const split = new AnsiStripper();
    assert.strictEqual(["a\x1b[3", "1mb\x1b]0;t", "\x1b\\c"].map((chunk) => split.push(chunk)).join(""), "abc");
    split.push("\x1b[");
    split.reset();
    assert.strictEqual(split.push("plain"), "plain", "reset forgets an unfinished sequence");
});

scenario("every supported encoding joins a character split across chunks", () => {
    const samples = {
        gbk: [Buffer.from([0xce, 0xc2, 0xb6, 0xc8, 0x0a]), "温度\r\n"],
        gb18030: [Buffer.from([0x81, 0x30, 0x81, 0x30, 0x0a]), "\u0080\r\n"],
        big5: [Buffer.from([0xa4, 0xa4, 0x0a]), "中\r\n"],
        shift_jis: [Buffer.from([0x93, 0xfa, 0x0a]), "日\r\n"],
        "euc-kr": [Buffer.from([0xc7, 0xd1, 0x0a]), "한\r\n"],
        latin1: [Buffer.from([0xe9, 0x0a]), "é\r\n"]
    };
    for (const [encoding, [bytes, text]] of Object.entries(samples)) {
        const formatter = new RttLineFormatter({ encoding });
        const whole = [...bytes].map((byte) => formatter.push(Buffer.of(byte))).join("");
        assert.strictEqual(whole, text, encoding);
    }
    assert.strictEqual(new RttLineFormatter({ encoding: "gbk" }).flush(), "");
    const cut = new RttLineFormatter({ encoding: "gbk" });
    assert.strictEqual(cut.push(Buffer.of(0xce)), "");
    assert.strictEqual(cut.flush(), "\ufffd", "a closed channel shows the incomplete character");
});

scenario("SEGGER terminal switches are removed and label the lines they apply to", () => {
    const clock = new FakeClock();
    const formatter = new RttLineFormatter({ virtualTerminals: true, timestamps: true, clock, formatTime: stamp });
    const switchTo = (id) => Buffer.from([0xff, id.charCodeAt(0)]);
    assert.strictEqual(
        formatter.push(Buffer.concat([Buffer.from("zero "), switchTo("1"), Buffer.from("one\nmore\n")])),
        "[t1000] zero \r\n[t1000] [T1] one\r\n[t1000] [T1] more\r\n"
    );
    assert.strictEqual(
        formatter.push(Buffer.concat([switchTo("A"), Buffer.from("alarm\n")])),
        "[t1000] [TA] alarm\r\n"
    );
    assert.strictEqual(formatter.push(Buffer.concat([switchTo("0"), Buffer.from("back\n")])), "[t1000] back\r\n");
    assert.strictEqual(
        formatter.push(Buffer.concat([Buffer.from("a"), switchTo("0"), Buffer.from("b")])),
        "[t1000] ab"
    );
});

scenario("a terminal switch split across chunks still switches", () => {
    const formatter = new RttLineFormatter({ virtualTerminals: true });
    assert.strictEqual(formatter.push(Buffer.of(0x61, 0xff)), "a");
    assert.strictEqual(formatter.push(Buffer.from("3b\n")), "\r\n[T3] b\r\n");
    const trailing = new RttLineFormatter({ virtualTerminals: true });
    assert.strictEqual(trailing.push(Buffer.of(0xff)), "");
    assert.strictEqual(trailing.flush(), "\ufffd", "a lone 0xFF is decoded when the channel closes");
    const other = new RttLineFormatter({ virtualTerminals: true });
    assert.strictEqual(other.push(Buffer.of(0xff, 0x7a)), "\ufffdz", "0xFF without an id is plain data");
});

scenario("terminal switches stay data when virtual terminals are off", () => {
    const formatter = new RttLineFormatter({ encoding: "latin1" });
    assert.strictEqual(formatter.push(Buffer.of(0xff, 0x31)), "ÿ1");
});

scenario("the raw format decodes and changes nothing else", () => {
    const formatter = createRttFormatter({ format: "raw", encoding: "gbk" });
    assert.ok(formatter instanceof RttRawFormatter);
    formatter.setTimestamps(true);
    assert.strictEqual(formatter.push(Buffer.of(0x0a, 0x1b, 0x5b, 0x32, 0x4a, 0xce)), "\n\x1b[2J");
    assert.strictEqual(formatter.push(Buffer.of(0xc2, 0x0d)), "温\r");
    assert.strictEqual(formatter.push("text"), "text");
    assert.strictEqual(formatter.flush(), "");
});

scenario("the hex format shows absolute offsets and printable bytes", async () => {
    const clock = new FakeClock();
    const formatter = createRttFormatter({ format: "hex", clock, formatTime: stamp });
    assert.ok(formatter instanceof RttHexFormatter);
    const row = `00000100  ${"41 ".repeat(16).trimEnd()}  |${"A".repeat(16)}|\r\n`;
    const tail = `00000110  00 7f 42${" ".repeat(39)}  |..B|\r\n`;
    assert.strictEqual(
        formatter.push(Buffer.concat([Buffer.alloc(16, 0x41), Buffer.of(0, 0x7f, 0x42)]), 0x100),
        row + tail
    );
    assert.ok(formatter.push(Buffer.of(1)).startsWith("00000113  01"), "without a cursor it continues");
    formatter.setTimestamps(true);
    assert.ok(formatter.push(Buffer.of(1), 0).startsWith("[t1000] 00000000  01"));
    assert.strictEqual(formatter.flush(), "");
    assert.ok(createRttFormatter() instanceof RttLineFormatter);
});

scenario("default timestamps are local HH:MM:SS.mmm", () => {
    const at = new Date(2026, 10, 3, 9, 5, 7, 42).getTime();
    assert.strictEqual(formatTimestamp(at), "09:05:07.042");
});
