"use strict";
const assert = require("assert");
const { encodeValue, decodeValue, decodeValueText } = require("../src/elfSymbols");
const { LiveWatchSession } = require("../src/liveWatch");
const writeSkill = require("../skills/mcu-variables/scripts/write");

(async () => {
    // —— encodeValue：各类型小端编码与 decodeValue 往返 ——
    assert.deepStrictEqual(encodeValue(255, "u8"), [0xff]);
    assert.deepStrictEqual(encodeValue(-1, "i16"), [0xff, 0xff]);
    assert.deepStrictEqual(encodeValue(0x12345678, "u32"), [0x78, 0x56, 0x34, 0x12]);
    assert.deepStrictEqual(encodeValue(-2, "i8"), [0xfe]);
    assert.strictEqual(decodeValue(encodeValue(1.5, "f32"), "f32"), 1.5);
    assert.strictEqual(decodeValue(encodeValue(-123456, "i32"), "i32"), -123456);

    // 越界 / 非法值 / 非法类型
    assert.throws(
        () => encodeValue(256, "u8"),
        (e) => e.code === "INVALID_WRITE_VALUE"
    );
    assert.throws(
        () => encodeValue(-1, "u16"),
        (e) => e.code === "INVALID_WRITE_VALUE"
    );
    assert.throws(
        () => encodeValue(1.5, "i32"),
        (e) => e.code === "INVALID_WRITE_VALUE",
        "integer types reject fractions"
    );
    assert.throws(
        () => encodeValue(NaN, "u32"),
        (e) => e.code === "INVALID_WRITE_VALUE"
    );
    assert.strictEqual(decodeValueText(encodeValue("18446744073709551615", "u64"), "u64"), "18446744073709551615");
    assert.strictEqual(decodeValueText(encodeValue("-9223372036854775808", "i64"), "i64"), "-9223372036854775808");
    assert.deepStrictEqual(
        encodeValue(0x0102030405060708n, "u64"),
        [8, 7, 6, 5, 4, 3, 2, 1],
        "u64 should use little-endian bytes"
    );
    assert.deepStrictEqual(
        encodeValue(-2n, "i64"),
        [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        "i64 should use two's-complement little-endian bytes"
    );
    const expectedF64 = Buffer.alloc(8);
    expectedF64.writeDoubleLE(1.25);
    assert.deepStrictEqual(
        encodeValue(1.25, "f64"),
        Array.from(expectedF64),
        "f64 should use little-endian IEEE-754 bytes"
    );
    assert.strictEqual(
        decodeValueText(encodeValue("+00042", "u64"), "u64"),
        "42",
        "encoded write echo should be canonical decimal text"
    );
    assert.throws(
        () => encodeValue(Number.MAX_SAFE_INTEGER + 1, "u64"),
        (e) => e.code === "INVALID_WRITE_VALUE",
        "unsafe Number inputs must be rejected"
    );
    assert.throws(
        () => encodeValue("18446744073709551616", "u64"),
        (e) => e.code === "INVALID_WRITE_VALUE"
    );
    assert.throws(
        () => encodeValue("-9223372036854775809", "i64"),
        (e) => e.code === "INVALID_WRITE_VALUE"
    );
    assert.throws(
        () => encodeValue("1e3", "u64"),
        (e) => e.code === "INVALID_WRITE_VALUE"
    );
    assert.ok(Number.isNaN(decodeValue(encodeValue("nan", "f64"), "f64")));
    assert.ok(Number.isNaN(decodeValue(encodeValue("NaN", "f64"), "f64")), "f64 aliases should be case-insensitive");
    assert.strictEqual(decodeValue(encodeValue("inf", "f64"), "f64"), Infinity);
    assert.strictEqual(decodeValue(encodeValue("-inf", "f64"), "f64"), -Infinity);

    // —— _writeMemoryBytes：32 位读-改-写、ocd_→ 无前缀回退、失败抛错 ——
    const okSession = new LiveWatchSession(null, {}, {});
    const sent = [];
    okSession._readMemoryBytes = async () => [0x11, 0x22, 0x33, 0x44];
    okSession._sendCheckedCommand = async (cmd) => {
        sent.push(cmd);
        return "";
    };
    await okSession._writeMemoryBytes(0x20000010, [0x2a, 0x00]);
    assert.deepStrictEqual(sent, ["ocd_write_memory 0x20000010 32 {0x4433002a}"]);
    assert.strictEqual(okSession.writeCmd, "ocd_write_memory", "keep the primary command on success");

    const fallbackSession = new LiveWatchSession(null, {}, {});
    const fallbackSent = [];
    fallbackSession._readMemoryBytes = async () => [0, 0, 0, 0];
    fallbackSession._sendCheckedCommand = async (cmd) => {
        fallbackSent.push(cmd);
        if (cmd.startsWith("ocd_")) throw new Error('invalid command name "ocd_write_memory"');
        return "";
    };
    await fallbackSession._writeMemoryBytes(0x20000000, [1]);
    assert.strictEqual(fallbackSent.length, 2);
    assert.ok(fallbackSent[1].startsWith("write_memory "), "fall back to write_memory");
    assert.strictEqual(fallbackSession.writeCmd, "write_memory", "lock the fallback command");

    const failSession = new LiveWatchSession(null, {}, {});
    failSession._readMemoryBytes = async () => [0, 0, 0, 0];
    failSession._sendCheckedCommand = async () => {
        throw new Error("address out of bounds");
    };
    await assert.rejects(() => failSession._writeMemoryBytes(0x20000000, [1]), /写入内存失败/);

    const alignedSession = new LiveWatchSession(null, {}, {});
    const alignedSent = [];
    alignedSession._readMemoryBytes = async () => {
        throw new Error("aligned word writes must not pre-read");
    };
    alignedSession._sendCheckedCommand = async (cmd) => {
        alignedSent.push(cmd);
        return "";
    };
    await alignedSession._writeMemoryBytes(0x20000000, [0x78, 0x56, 0x34, 0x12]);
    assert.deepStrictEqual(alignedSent, ["ocd_write_memory 0x20000000 32 {0x12345678}"]);

    const highAddressSession = new LiveWatchSession(null, {}, {});
    const highAddressSent = [];
    highAddressSession._readMemoryBytes = async () => [0x11, 0x22, 0x33, 0x44];
    highAddressSession._sendCheckedCommand = async (cmd) => {
        highAddressSent.push(cmd);
        return "";
    };
    await highAddressSession._writeMemoryBytes(0x90000001, [0xaa]);
    assert.deepStrictEqual(
        highAddressSent,
        ["ocd_write_memory 0x90000000 32 {0x4433aa11}"],
        "high RAM addresses must remain unsigned"
    );

    // —— writeOnce：串行写入、不改 watch 列表 ——
    const session = new LiveWatchSession(null, {}, {});
    session.socket = { destroyed: false };
    const written = [];
    session._writeMemoryBytes = async (address, bytes) => {
        written.push({ address, bytes });
        return true;
    };
    const count = await session.writeOnce([
        { address: 0x20000000, bytes: [1, 0, 0, 0] },
        { address: 0x20000004, bytes: [2] }
    ]);
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(
        written.map((w) => w.address),
        [0x20000000, 0x20000004]
    );
    assert.deepStrictEqual(session.watch, [], "one-shot writes must not modify the UI watch list");
    assert.strictEqual(await session.writeOnce([]), 0);

    // Concurrent transactions must finish verification and resume before the next writer enters.
    const concurrent = new LiveWatchSession(null, {}, {});
    concurrent.socket = { destroyed: false };
    const operations = [];
    let releaseWrite;
    const writeGate = new Promise((resolve) => {
        releaseWrite = resolve;
    });
    concurrent._sendCheckedCommand = async (command) => {
        operations.push(command);
        return command.includes("curstate") ? "running" : "";
    };
    concurrent._readItems = async () => ({ samples: [] });
    concurrent._writeMemoryBytes = async (_address, bytes) => {
        operations.push(`write:${bytes[0]}`);
        if (bytes[0] === 1) await writeGate;
    };
    const firstWrite = concurrent.writeAndVerify([{ name: "x", address: 0x20000000, bytes: [1] }]);
    const secondWrite = concurrent.writeAndVerify([{ name: "x", address: 0x20000000, bytes: [2] }]);
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = operations.slice();
    releaseWrite();
    await Promise.all([firstWrite, secondWrite]);
    assert.deepStrictEqual(beforeRelease, ["[target current] curstate", "halt", "write:1"]);
    assert.deepStrictEqual(operations, [
        "[target current] curstate",
        "halt",
        "write:1",
        "resume",
        "[target current] curstate",
        "halt",
        "write:2",
        "resume"
    ]);
    assert.strictEqual(concurrent.busy, false);
    concurrent._writeMemoryBytes = async () => {
        throw new Error("write failed");
    };
    await assert.rejects(concurrent.writeAndVerify([{ name: "x", address: 0x20000000, bytes: [3] }]), /write failed/);
    assert.strictEqual(concurrent.busy, false, "failed transactions must release the lock");
    assert.strictEqual(operations.at(-1), "resume", "failed transactions must restore the running target");
    concurrent.busy = true;
    await assert.rejects(concurrent.writeAndVerify([{ name: "x", bytes: [1] }], 0), /超时/);
    concurrent.busy = false;

    // —— variables/write.js 的 --set 解析 ——
    assert.deepStrictEqual(writeSkill.parseSet("kp=0.5,counter=2"), [
        { name: "kp", value: "0.5" },
        { name: "counter", value: "2" }
    ]);
    assert.deepStrictEqual(writeSkill.parseSet("sensor.x=-3,buf[0]=255"), [
        { name: "sensor.x", value: "-3" },
        { name: "buf[0]", value: "255" }
    ]);
    assert.throws(() => writeSkill.parseSet("broken"), /Invalid assignment/);
    assert.throws(() => writeSkill.parseSet("x="), /Invalid assignment/);
    assert.deepStrictEqual(writeSkill.parseSet("wide=18446744073709551615"), [
        { name: "wide", value: "18446744073709551615" }
    ]);
    assert.throws(() => writeSkill.parseSet(""), /at least one/);
    assert.deepStrictEqual(writeSkill.args(["--set", "kp=1", "--confirm", "abc", "--remember"]), {
        set: "kp=1",
        confirm: "abc",
        remember: true
    });
    assert.deepStrictEqual(writeSkill.args(["--reset-permission"]), { "reset-permission": true });
    assert.throws(() => writeSkill.args(["--force"]), /Unknown argument/);

    console.log("Variable write tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
