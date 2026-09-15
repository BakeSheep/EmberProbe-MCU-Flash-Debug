"use strict";
// §2 / §3 回归：DWARF 缩写与 DIE 预算必须是「整个解析全局」而非「每次调用 / 每个 CU 独立」。
// 旧实现下 abbrevCache 以文件可控的 abbrevOff 为键无界增长、DIE guard 在每个 CU 重置，
// 攻击者用多个 CU / 多个缩写表偏移即可让扩展宿主累积数百 MB 堆直至 OOM。
// 这里用程序化构造的最小 ELF32 验证全局预算会及时以 DWARF_BUDGET_EXCEEDED 中止。
const assert = require("assert");
const { parseDwarfInternal } = require("../src/dwarf/parser");

function uleb(v) {
    const out = [];
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v) b |= 0x80;
        out.push(b);
    } while (v);
    return out;
}

// 构造 ELF32 LE，仅含 .debug_info / .debug_abbrev / .shstrtab 三节。
function buildElf(infoData, abbrevData) {
    const names = ["", ".debug_info", ".debug_abbrev", ".shstrtab"];
    const shBytes = [];
    const nameOff = {};
    for (const nm of names) {
        nameOff[nm] = shBytes.length;
        for (const c of Buffer.from(nm, "latin1")) shBytes.push(c);
        shBytes.push(0);
    }
    const shstrtab = Buffer.from(shBytes);
    const infoOff = 52;
    const abbrevOff = infoOff + infoData.length;
    const shstrOff = abbrevOff + abbrevData.length;
    const shoff = (shstrOff + shstrtab.length + 3) & ~3;
    const shnum = 4;
    const buf = Buffer.alloc(shoff + shnum * 40);
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf[4] = 1; // ELFCLASS32
    buf[5] = 1; // ELFDATA2LSB
    buf[6] = 1; // EV_CURRENT
    buf.writeUInt16LE(2, 16); // e_type = ET_EXEC
    buf.writeUInt16LE(0x28, 18); // e_machine = ARM
    buf.writeUInt32LE(1, 20); // e_version
    buf.writeUInt32LE(shoff, 32); // e_shoff
    buf.writeUInt16LE(52, 40); // e_ehsize
    buf.writeUInt16LE(40, 46); // e_shentsize
    buf.writeUInt16LE(shnum, 48); // e_shnum
    buf.writeUInt16LE(3, 50); // e_shstrndx
    infoData.copy(buf, infoOff);
    abbrevData.copy(buf, abbrevOff);
    shstrtab.copy(buf, shstrOff);
    const sh = (i) => shoff + i * 40;
    const section = (i, name, type, offset, size) => {
        buf.writeUInt32LE(nameOff[name], sh(i) + 0);
        buf.writeUInt32LE(type, sh(i) + 4);
        buf.writeUInt32LE(0, sh(i) + 8);
        buf.writeUInt32LE(offset, sh(i) + 16);
        buf.writeUInt32LE(size, sh(i) + 20);
    };
    section(1, ".debug_info", 1, infoOff, infoData.length);
    section(2, ".debug_abbrev", 1, abbrevOff, abbrevData.length);
    section(3, ".shstrtab", 3, shstrOff, shstrtab.length);
    return buf;
}

// 一个含 count 个零属性缩写的表；返回 { bytes, size }。code 从 1 递增。
function abbrevTable(count, tag) {
    const bytes = [];
    for (let code = 1; code <= count; code++) {
        bytes.push(...uleb(code), ...uleb(tag), 0, 0, 0); // hasChildren=0, at=0, form=0
    }
    bytes.push(0); // 表结束（code 0）
    return Buffer.from(bytes);
}

// —— §2：全局缩写预算 ——
// 三个 CU 各引用一个不同的 abbrevOff，每张表 8000 个缩写。
// 旧实现：每次 parseAbbrev 独立计数（8000 < 每调用上限 100000），三张表全部缓存存活，无错误。
// 新实现：全局缩写预算（≤20000）在第三张表解析途中触发 DWARF_BUDGET_EXCEEDED。
{
    const PER_TABLE = 8000;
    const tables = [abbrevTable(PER_TABLE, 0x24), abbrevTable(PER_TABLE, 0x24), abbrevTable(PER_TABLE, 0x24)];
    const offsets = [];
    let acc = 0;
    for (const t of tables) {
        offsets.push(acc);
        acc += t.length;
    }
    const abbrevData = Buffer.concat(tables);

    // 每个 CU：unit_length(u32) + version(u16=4) + abbrev_off(u32) + addr_size(u8=4) + code1 DIE
    const infoParts = [];
    for (const off of offsets) {
        const dieBytes = Buffer.from([1]); // code 1
        const unitLen = 2 + 4 + 1 + dieBytes.length;
        const cu = Buffer.alloc(4 + unitLen);
        cu.writeUInt32LE(unitLen, 0);
        cu.writeUInt16LE(4, 4); // version
        cu.writeUInt32LE(off, 6); // debug_abbrev_offset
        cu.writeUInt8(4, 10); // address_size
        dieBytes.copy(cu, 11);
        infoParts.push(cu);
    }
    const infoData = Buffer.concat(infoParts);
    const elf = buildElf(infoData, abbrevData);
    assert.throws(() => parseDwarfInternal(elf), { code: "DWARF_BUDGET_EXCEEDED" }, "全局缩写预算必须跨 CU 生效");
}

// —— §3：全局 DIE 预算 ——
// 两个 CU，各含约 105 万个零属性 DIE。
// 旧实现：guard 每个 CU 重置（每 CU 105 万 < 每 CU 上限 200 万），两个 CU 都完整解析，
//         dies 映射累积约 210 万条（数百 MB 堆）且不报错。
// 新实现：全局 DIE 预算（≤200 万）在第二个 CU 解析途中触发 DWARF_BUDGET_EXCEEDED。
{
    const DIES_PER_CU = 1050000;
    // 缩写表：code1 = compile_unit(0x11, 无子, 0 属性)，code2 = base_type(0x24, 无子, 0 属性)
    const abbrevData = Buffer.from([1, 0x11, 0, 0, 0, 2, 0x24, 0, 0, 0, 0]);

    const infoParts = [];
    for (let cu = 0; cu < 2; cu++) {
        // header: version(2) + abbrev_off(4) + addr_size(1)；DIE: code1 + code2 × N
        const dieCount = 1 + DIES_PER_CU;
        const unitLen = 2 + 4 + 1 + dieCount;
        const cuBuf = Buffer.alloc(4 + unitLen);
        cuBuf.writeUInt32LE(unitLen, 0);
        cuBuf.writeUInt16LE(4, 4);
        cuBuf.writeUInt32LE(0, 6); // abbrev offset 0
        cuBuf.writeUInt8(4, 10);
        cuBuf.writeUInt8(1, 11); // compile_unit DIE
        cuBuf.fill(2, 12, 12 + DIES_PER_CU); // 其余全是 code2 DIE
        infoParts.push(cuBuf);
    }
    const infoData = Buffer.concat(infoParts);
    const elf = buildElf(infoData, abbrevData);
    assert.throws(() => parseDwarfInternal(elf), { code: "DWARF_BUDGET_EXCEEDED" }, "全局 DIE 预算必须跨 CU 生效");
}

console.log("DWARF global budget tests passed");
