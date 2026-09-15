"use strict";
// §17.1 回归：zstd 压缩节的长度校验曾形同虚设。
// fzstd.decompress(dat, buf) 直接返回调用方按 ch_size 预分配的缓冲区，长度恒等于 ch_size，
// 使 `data.length !== expectedSize` 在 zstd 路径永不触发；谎报 ch_size 的 <1KB ELF 就能让
// 每个必需节占用 ch_size 大小的零填充内存（5 节 × 128MiB = 640MiB）。
const assert = require("assert");
const { _debugSectionData } = require("../src/dwarf");

// zstd CLI 对 ASCII "DWARF-zstd-test"（15 字节）的单帧输出；测试不依赖系统 zstd。
const zstdPayload = Buffer.from("28b52ffd045879000044574152462d7a7374642d746573741a9e4eec", "hex");

function zstdSection(chSize, frame) {
    const section = Buffer.alloc(12 + frame.length);
    section.writeUInt32LE(2, 0); // ELFCOMPRESS_ZSTD
    section.writeUInt32LE(chSize, 4);
    section.writeUInt32LE(1, 8);
    frame.copy(section, 12);
    return { section, entry: { offset: 0, size: section.length, flags: 0x800 } };
}

// 基线：ch_size 与真实解码长度一致时正常解压（修复前后都应通过）。
const baseline = zstdSection(15, zstdPayload);
assert.strictEqual(_debugSectionData(baseline.section, baseline.entry, ".debug_info").toString(), "DWARF-zstd-test");

// 核心缺陷：ch_size 谎报为远大于真实解码长度时必须拒绝，而不是返回零填充缓冲区。
const lying = zstdSection(4096, zstdPayload);
assert.throws(
    () => _debugSectionData(lying.section, lying.entry, ".debug_info"),
    /size mismatch|budget/i,
    "谎报 ch_size 的 zstd 节必须被拒绝"
);

// 纵深防御：帧头声明的窗口 / content size 超过预算时，必须在 fzstd 预分配前中止。
// 单段帧（single_segment=1）+ 4 字节 FCS（fcf=2）声明 contentSize=0xFFFFFFFF（4GiB）。
const hugeFcs = Buffer.from("28b52ffda0ffffffff", "hex");
const huge = zstdSection(1000, hugeFcs);
assert.throws(
    () => _debugSectionData(huge.section, huge.entry, ".debug_info"),
    /budget/i,
    "声明超大 content size 的 zstd 帧必须在解码前被拒绝"
);

function decode(frame, size = 15) {
    const { section, entry } = zstdSection(size, frame);
    return _debugSectionData(section, entry, ".debug_info");
}

const skip = Buffer.from("502a4d1804000000deadbeef", "hex");
assert.strictEqual(decode(Buffer.concat([skip, zstdPayload])).toString(), "DWARF-zstd-test");
assert.strictEqual(
    decode(Buffer.concat([zstdPayload, skip, zstdPayload, skip]), 30).toString(),
    "DWARF-zstd-testDWARF-zstd-test"
);
// Raw and RLE blocks have different encoded lengths; magic inside raw data is not a frame.
assert.deepStrictEqual(decode(Buffer.from("28b52ffd200421000028b52ffd", "hex"), 4), Buffer.from("28b52ffd", "hex"));
assert.strictEqual(decode(Buffer.from("28b52ffd200423000041", "hex"), 4).toString(), "AAAA");
assert.strictEqual(decode(Buffer.from("28b52ffd2004100000414213000043", "hex"), 4).toString(), "ABCC");

for (const invalid of [
    Buffer.from("28b5", "hex"),
    Buffer.from("28b52ffd28ff", "hex"),
    Buffer.from("28b52ffd2300", "hex"),
    Buffer.from("28b52ffd20010100", "hex"),
    Buffer.from("28b52ffd2001090000", "hex"),
    Buffer.from("28b52ffd2001070000", "hex"),
    zstdPayload.subarray(0, -1),
    skip.subarray(0, 6),
    skip.subarray(0, -1)
]) {
    assert.throws(() => decode(invalid), /invalid|truncated/i);
}

// Instrument the actual decoder's allocations, so regressions fail without allocating huge windows.
const fs = require("fs");
const vm = require("vm");
const { createRequire } = require("module");
const decoder = { exports: {} };
const allocations = [];
const guardedUint8Array = new Proxy(Uint8Array, {
    construct(target, args) {
        if (typeof args[0] === "number") {
            allocations.push(args[0]);
            assert.ok(args[0] <= 32 * 1024 * 1024 + 12, "decoder allocated an unchecked window");
        }
        return Reflect.construct(target, args);
    }
});
vm.runInNewContext(fs.readFileSync(require.resolve("fzstd"), "utf8"), {
    exports: decoder.exports,
    Uint8Array: guardedUint8Array
});
const binaryFile = require.resolve("../src/dwarf/binary");
const binaryRequire = createRequire(binaryFile);
const binary = { exports: {} };
vm.runInNewContext(fs.readFileSync(binaryFile, "utf8"), {
    module: binary,
    Buffer,
    require: (name) => (name === "fzstd" ? decoder.exports : binaryRequire(name))
});
for (const prefix of [Buffer.alloc(0), zstdPayload, skip, Buffer.concat([zstdPayload, skip])]) {
    for (const frame of [
        Buffer.from("28b52ffda000000004010000", "hex"), // 64 MiB single-segment window
        Buffer.from("28b52ffd0080010000", "hex"), // 64 MiB window, unknown content size
        Buffer.from("28b52ffd00ff010000", "hex") // exponent must not wrap through a 32-bit shift
    ]) {
        const { section, entry } = zstdSection(15, Buffer.concat([prefix, frame]));
        assert.throws(() => binary.exports.debugSectionData(section, entry, ".debug_info"), {
            code: "DWARF_BUDGET_EXCEEDED"
        });
    }
}
assert.ok(
    allocations.some((size) => size > 1024),
    "valid prefix must exercise the instrumented decoder"
);

console.log("DWARF zstd section budget tests passed");
