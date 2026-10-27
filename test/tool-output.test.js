"use strict";

const assert = require("assert");
const { ansiEncoding, decodeLine, createLineDecoder, decodeOutput } = require("../skills/_emberprobe/tool-output");

// "远程主机强迫关闭了一个现有的连接。" in GBK, as Windows FormatMessage prints it for WSA 10054.
const gbk = Buffer.from("d4b6b3ccd6f7bbfac7bfc6c8b9d8b1d5c1cbd2bbb8f6cfd6d3d0b5c4c1acbdd3a1a3", "hex");
const expected = "远程主机强迫关闭了一个现有的连接。";
const win = { platform: "win32", locale: "zh-CN" };

assert.strictEqual(ansiEncoding("zh-CN"), "gbk");
assert.strictEqual(ansiEncoding("zh-TW"), "big5");
assert.strictEqual(ansiEncoding("zh-Hant-HK"), "big5");
assert.strictEqual(ansiEncoding("ja-JP"), "shift_jis");
assert.strictEqual(ansiEncoding("en-US"), "windows-1252");
assert.strictEqual(ansiEncoding(""), "windows-1252");

assert.strictEqual(decodeLine(gbk, win), expected);
// UTF-8 output stays UTF-8, including Chinese text OpenOCD may print itself.
assert.strictEqual(decodeLine(Buffer.from("目标已连接", "utf8"), win), "目标已连接");
// Other platforms always print UTF-8.
assert.ok(decodeLine(gbk, { platform: "linux", locale: "zh-CN" }).includes("�"));

{
    const lines = [];
    const decoder = createLineDecoder((line) => lines.push(line), win);
    const prefix = Buffer.from("Error on socket 'GDB': WSAGetLastError==10054, message: ");
    const line = Buffer.concat([prefix, gbk, Buffer.from("\r\nInfo : next")]);
    // Split inside a two-byte GBK character and inside a UTF-8 character on the next write.
    const cut = prefix.length + 3;
    decoder.write(line.subarray(0, cut));
    assert.strictEqual(decoder.length, cut);
    decoder.write(line.subarray(cut));
    assert.deepStrictEqual(lines, [`Error on socket 'GDB': WSAGetLastError==10054, message: ${expected}`]);
    const utf8 = Buffer.from(" 完成\n", "utf8");
    decoder.write(utf8.subarray(0, 2));
    decoder.write(utf8.subarray(2));
    decoder.write("tail");
    decoder.end();
    assert.deepStrictEqual(lines.slice(1), ["Info : next 完成", "tail"]);
    assert.strictEqual(decoder.length, 0);
}

{
    const lines = [];
    const decoder = createLineDecoder((line) => lines.push(line), { maxPending: 4 });
    decoder.write("abcdefgh");
    assert.strictEqual(decoder.length, 4);
    decoder.end();
    assert.deepStrictEqual(lines, ["efgh"]);
}

{
    // keepEnds hands lines over with their own breaks, so a caller can keep the output as it was.
    const lines = [];
    const decoder = createLineDecoder((line) => lines.push(line), { ...win, keepEnds: true });
    decoder.write(Buffer.concat([Buffer.from("a\r\n"), gbk, Buffer.from("\nend")]));
    decoder.end();
    assert.strictEqual(lines.join(""), `a\r\n${expected}\nend`);
}

// A whole captured output decodes line by line.
assert.strictEqual(
    decodeOutput(Buffer.concat([Buffer.from("x\r\n"), gbk, Buffer.from("\n")]), win),
    `x\n${expected}\n`
);
assert.strictEqual(decodeOutput("already text"), "already text");
assert.strictEqual(decodeOutput(null), "");

console.log("tool-output tests passed");
