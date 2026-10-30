"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { encodeValue, decodeValue, decodeValueText } = require("../src/elfSymbols");
const { LiveWatchSession, validateManagedWritePlan } = require("../src/liveWatch");
const { isNonHaltingWordWrite } = require("../src/writeAccess");
const writeSkill = require("../skills/mcu-variables/scripts/write");

(async () => {
    assert.strictEqual(isNonHaltingWordWrite({ address: 0x20000000, bytes: [1, 2, 3, 4] }), true);
    for (const [address, size] of [
        [0x20000000, 0],
        [0x20000000, 1],
        [0x20000000, 2],
        [0x20000001, 4],
        [0x20000000, 8]
    ])
        assert.strictEqual(isNonHaltingWordWrite({ address, bytes: new Uint8Array(size) }), false);
    assert.strictEqual(isNonHaltingWordWrite(null), false);
    assert.strictEqual(isNonHaltingWordWrite({ address: 0x20000000 }), false);
    for (const address of [-4, 0x100000000, "536870912"])
        assert.throws(() => validateManagedWritePlan([{ address, bytes: [1, 2, 3, 4] }]), {
            code: "LIVE_ADDRESS_NOT_RAM"
        });
    for (const byte of [-1, 256, 1.5, "1", NaN])
        assert.throws(() => validateManagedWritePlan([{ address: 0x20000000, bytes: [byte, 0, 0, 0] }]), {
            code: "INVALID_WRITE_VALUE"
        });
    validateManagedWritePlan([{ address: 0xfffffffc, bytes: Buffer.from([1, 2, 3, 4]) }]);

    // encodeValue: little-endian encoding per type and round trip through decodeValue
    assert.deepStrictEqual(encodeValue(255, "u8"), [0xff]);
    assert.deepStrictEqual(encodeValue(-1, "i16"), [0xff, 0xff]);
    assert.deepStrictEqual(encodeValue(0x12345678, "u32"), [0x78, 0x56, 0x34, 0x12]);
    assert.deepStrictEqual(encodeValue(-2, "i8"), [0xfe]);
    assert.strictEqual(decodeValue(encodeValue(1.5, "f32"), "f32"), 1.5);
    assert.strictEqual(decodeValue(encodeValue(-123456, "i32"), "i32"), -123456);

    // Out of range / invalid values / invalid types
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
    // Number() coerces these to 0/1/n; a missing or malformed value must never be written.
    for (const type of ["u8", "i16", "u32", "i32", "f32", "f64"])
        for (const value of [null, undefined, "", "   ", false, true, [], [7], {}])
            assert.throws(
                () => encodeValue(value, type),
                { code: "INVALID_WRITE_VALUE" },
                `${type} rejects ${JSON.stringify(value)}`
            );
    assert.deepStrictEqual(encodeValue(" 0x10 ", "u8"), [0x10], "numeric strings are still accepted");
    assert.deepStrictEqual(encodeValue(5n, "u16"), [5, 0]);
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

    // _writeMemoryBytes: write at natural width first, fall back to a 32-bit read-modify-write when narrow writes are
    // dropped, fall back from ocd_ to unprefixed commands, and throw on failure
    const okSession = new LiveWatchSession(null, {}, {});
    const sent = [];
    okSession._readMemoryBytes = async () => [0x11, 0x22, 0x33, 0x44];
    okSession._sendCheckedCommand = async (cmd) => {
        sent.push(cmd);
        return "";
    };
    await okSession._writeMemoryBytes(0x20000010, [0x2a, 0x00]);
    assert.deepStrictEqual(
        sent,
        ["ocd_write_memory 0x20000010 16 {0x2a}", "ocd_write_memory 0x20000010 32 {0x4433002a}"],
        "a narrow write that did not land falls back to an aligned read-modify-write"
    );
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
    assert.strictEqual(fallbackSent.length, 3);
    assert.ok(fallbackSent[1].startsWith("write_memory "), "fall back to write_memory");
    assert.strictEqual(fallbackSession.writeCmd, "write_memory", "lock the fallback command");

    const failSession = new LiveWatchSession(null, {}, {});
    failSession._readMemoryBytes = async () => [0, 0, 0, 0];
    failSession._sendCheckedCommand = async () => {
        throw new Error("address out of bounds");
    };
    await assert.rejects(() => failSession._writeMemoryBytes(0x20000000, [1]), /Memory write failed/);

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
        ["ocd_write_memory 0x90000001 8 {0xaa}", "ocd_write_memory 0x90000000 32 {0x4433aa11}"],
        "high RAM addresses must remain unsigned"
    );

    // Narrow writes that land never rewrite neighbouring bytes, so a DMA update made while the
    // target is halted survives; unaligned spans use naturally aligned 8/16-bit accesses.
    const memorySession = new LiveWatchSession(null, {}, {});
    const ram = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    const memorySent = [];
    memorySession._readMemoryBytes = async (address, count) =>
        ram.slice(address - 0x20000000, address - 0x20000000 + count);
    memorySession._sendCheckedCommand = async (cmd) => {
        memorySent.push(cmd);
        const [, address, width, data] = cmd.match(/^\S+ (0x[0-9a-f]+) (\d+) \{(.*)\}$/);
        let offset = Number(address) - 0x20000000;
        for (const value of data.split(" ").map(Number))
            for (let index = 0; index < Number(width) / 8; index++) ram[offset++] = (value >>> (index * 8)) & 0xff;
        ram[0] = 0x99; // DMA updates a neighbouring byte while the target is halted
        return "";
    };
    await memorySession._writeMemoryBytes(0x20000001, [0xa1, 0xa2, 0xa3, 0xa4]);
    assert.deepStrictEqual(memorySent, [
        "ocd_write_memory 0x20000001 8 {0xa1}",
        "ocd_write_memory 0x20000002 16 {0xa3a2}",
        "ocd_write_memory 0x20000004 8 {0xa4}"
    ]);
    assert.deepStrictEqual(ram, [0x99, 0xa1, 0xa2, 0xa3, 0xa4, 0x66, 0x77, 0x88], "neighbouring bytes are kept");

    // Every runtime write goes through writeAndVerify; no unverified write path remains.
    assert.strictEqual(LiveWatchSession.prototype.writeOnce, undefined);

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
    await assert.rejects(concurrent.writeAndVerify([{ name: "x", bytes: [1] }], 0), {
        code: "PROBE_CONNECTION_BUSY_TIMEOUT"
    });
    concurrent.busy = false;

    await scenario("Aligned transactions retain exclusive ownership without run control", async () => {
        const session = new LiveWatchSession(null, {}, {});
        session.socket = { destroyed: false };
        const operations = [];
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        session._sendCheckedCommand = async () => assert.fail("word writes must not query or change target state");
        session._readItems = async () => {
            operations.push("read");
            return { samples: [] };
        };
        session._writeMemoryBytes = async (_address, bytes) => {
            operations.push("write:" + bytes[0]);
            if (bytes[0] === 1) await gate;
        };
        const first = session.writeAndVerify([{ address: 0x20000000, bytes: [1, 0, 0, 0] }]);
        const second = session.writeAndVerify([{ address: 0x20000004, bytes: [2, 0, 0, 0] }]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(operations, ["read", "write:1"]);
        release();
        const results = await Promise.all([first, second]);
        assert(results.every((result) => result.halted === false));
        assert.deepStrictEqual(operations, ["read", "write:1", "read", "read", "write:2", "read"]);
        session._writeMemoryBytes = async () => {
            throw Error("word write failed");
        };
        await assert.rejects(
            session.writeAndVerify([{ address: 0x20000000, bytes: [1, 0, 0, 0] }]),
            /word write failed/
        );
        assert.strictEqual(session.busy, false);
        assert.deepStrictEqual(await session.writeAndVerify([]), { before: [], after: [], halted: false });
    });

    // --set parsing in variables/write.js
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

    await scenario("Reject overflowing float writes", async () => {
        const { encodeValue } = require("../src/elfSymbols");
        assert.throws(
            () => encodeValue("1e39", "f32"),
            (error) => error.code === "INVALID_WRITE_VALUE"
        );
    });

    console.log("Variable write tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
