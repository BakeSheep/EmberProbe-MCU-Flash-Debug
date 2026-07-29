"use strict";
const assert = require("assert");
const { encodeValue, decodeValue } = require("../src/elfSymbols");
const { LiveWatchSession } = require("../src/liveWatch");
const writeSkill = require("../skills/mcu-var-write/scripts/write-var");

(async () => {
    // —— encodeValue：各类型小端编码与 decodeValue 往返 ——
    assert.deepStrictEqual(encodeValue(255, "u8"), [0xff]);
    assert.deepStrictEqual(encodeValue(-1, "i16"), [0xff, 0xff]);
    assert.deepStrictEqual(encodeValue(0x12345678, "u32"), [0x78, 0x56, 0x34, 0x12]);
    assert.deepStrictEqual(encodeValue(-2, "i8"), [0xfe]);
    assert.strictEqual(decodeValue(encodeValue(1.5, "f32"), "f32"), 1.5);
    assert.strictEqual(decodeValue(encodeValue(-123456, "i32"), "i32"), -123456);

    // 越界 / 非法值 / 非法类型
    assert.throws(() => encodeValue(256, "u8"), e => e.code === "INVALID_WRITE_VALUE");
    assert.throws(() => encodeValue(-1, "u16"), e => e.code === "INVALID_WRITE_VALUE");
    assert.throws(() => encodeValue(1.5, "i32"), e => e.code === "INVALID_WRITE_VALUE", "integer types reject fractions");
    assert.throws(() => encodeValue(NaN, "u32"), e => e.code === "INVALID_WRITE_VALUE");
    assert.throws(() => encodeValue(1, "u64"), e => e.code === "UNSUPPORTED_VARIABLE_TYPE");

    // —— _writeMemoryBytes：命令拼装、ocd_→ 无前缀回退、失败抛错 ——
    const okSession = new LiveWatchSession(null, {}, {});
    const sent = [];
    okSession._sendCommand = async (cmd) => { sent.push(cmd); return ""; };
    await okSession._writeMemoryBytes(0x20000010, [0x2a, 0x00]);
    assert.deepStrictEqual(sent, ["ocd_write_memory 0x20000010 8 {0x2a 0x0}"]);
    assert.strictEqual(okSession.writeCmd, "ocd_write_memory", "keep the primary command on success");

    const fallbackSession = new LiveWatchSession(null, {}, {});
    const fallbackSent = [];
    fallbackSession._sendCommand = async (cmd) => {
        fallbackSent.push(cmd);
        return cmd.startsWith("ocd_") ? 'invalid command name "ocd_write_memory"' : "";
    };
    await fallbackSession._writeMemoryBytes(0x20000000, [1]);
    assert.strictEqual(fallbackSent.length, 2);
    assert.ok(fallbackSent[1].startsWith("write_memory "), "fall back to write_memory");
    assert.strictEqual(fallbackSession.writeCmd, "write_memory", "lock the fallback command");

    const failSession = new LiveWatchSession(null, {}, {});
    failSession._sendCommand = async () => "Error: address out of bounds";
    await assert.rejects(() => failSession._writeMemoryBytes(0x20000000, [1]), /写入内存失败/);

    // —— writeOnce：串行写入、不改 watch 列表 ——
    const session = new LiveWatchSession(null, {}, {});
    session.socket = { destroyed: false };
    const written = [];
    session._writeMemoryBytes = async (address, bytes) => { written.push({ address, bytes }); return true; };
    const count = await session.writeOnce([
        { address: 0x20000000, bytes: [1, 0, 0, 0] },
        { address: 0x20000004, bytes: [2] }
    ]);
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(written.map(w => w.address), [0x20000000, 0x20000004]);
    assert.deepStrictEqual(session.watch, [], "one-shot writes must not modify the UI watch list");
    assert.strictEqual(await session.writeOnce([]), 0);

    // —— write-var.js 的 --set 解析 ——
    assert.deepStrictEqual(writeSkill.parseSet("kp=0.5,counter=2"), [
        { name: "kp", value: 0.5 }, { name: "counter", value: 2 }
    ]);
    assert.deepStrictEqual(writeSkill.parseSet("sensor.x=-3,buf[0]=255"), [
        { name: "sensor.x", value: -3 }, { name: "buf[0]", value: 255 }
    ]);
    assert.throws(() => writeSkill.parseSet("broken"), /Invalid assignment/);
    assert.throws(() => writeSkill.parseSet("x="), /Invalid assignment/);
    assert.throws(() => writeSkill.parseSet("x=abc"), /not a number/);
    assert.throws(() => writeSkill.parseSet(""), /at least one/);
    assert.deepStrictEqual(writeSkill.args(["--set", "kp=1", "--confirm", "abc", "--remember"]), { set: "kp=1", confirm: "abc", remember: true });
    assert.deepStrictEqual(writeSkill.args(["--reset-permission"]), { "reset-permission": true });
    assert.throws(() => writeSkill.args(["--force"]), /Unknown argument/);

    console.log("Variable write tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
