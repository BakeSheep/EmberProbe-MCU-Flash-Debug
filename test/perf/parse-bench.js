"use strict";
// DWARF 解析性能基准（手动运行，不进 CI）：
//   node test/perf/parse-bench.js [--cus 300] [--vars 400] [--structs 4] [--members 8]
// 程序化生成合成 ELF32 + DWARF v4（多 CU、结构体/数组/标量变量），无需外部工具链，确定性输出。
// 对比两条路径的成本：
//   double-parse : 重构前的行为——parseDwarfVariableTypes 与 parseCompositeLayout
//                  各自全量解析（用两个 Buffer 副本绕过解析缓存，等价于旧实现的两次完整遍历）
//   parseDwarf   : 重构后的聚合入口——一次完整解析 + 两个视图构建（重构前不存在，显示 N/A）
const dwarf = require("../../src/dwarf");

function parseArgs(argv) {
    const out = { cus: 300, vars: 400, structs: 4, members: 8 };
    for (let i = 2; i < argv.length; i++) {
        const m = argv[i].match(/^--(cus|vars|structs|members)$/);
        if (m && argv[i + 1]) {
            out[m[1]] = Math.max(1, Number(argv[++i]) || out[m[1]]);
        }
    }
    return out;
}

function u32(v) {
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
function strBytes(s) {
    const b = Array.from(Buffer.from(s, "latin1"));
    b.push(0);
    return b;
}

// DWARF v4 缩写表（与 test/dwarf-composite.test.js 同构）：
// 1=compile_unit(有子) 2=base_type(name,encoding,byte_size) 3=structure_type(name,byte_size,有子)
// 4=member(name,type ref4,data_member_location data1) 5=variable(name,type ref4,location exprloc)
// 6=array_type(type ref4,byte_size,有子) 7=subrange(upper_bound data1)
const ABBREV = Buffer.from([
    1, 0x11, 1, 0, 0, 2, 0x24, 0, 0x03, 0x08, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 0x03, 0x08, 0x0b, 0x0b, 0, 0, 4,
    0x0d, 0, 0x03, 0x08, 0x49, 0x13, 0x38, 0x0b, 0, 0, 5, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x18, 0, 0, 6, 0x01, 1,
    0x49, 0x13, 0x0b, 0x0b, 0, 0, 7, 0x21, 0, 0x2f, 0x0b, 0, 0, 0
]);

// 构建一个 CU 的 .debug_info 负载；ref4 为 CU 相对偏移（DW_FORM_ref4 语义）
function buildCu(index, cfg) {
    const b = [];
    const off = () => b.length;
    b.push(...u32(0), 4, 0, ...u32(0), 4); // unit_length 占位 + version 4 + abbrev_off 0 + addr_size 4
    b.push(1); // compile_unit
    const intOff = off();
    b.push(2, ...strBytes("int"), 0x05, 4); // base_type int
    const floatOff = off();
    b.push(2, ...strBytes("float"), 0x04, 4); // base_type float
    const structOffs = [];
    for (let s = 0; s < cfg.structs; s++) {
        const structOff = off();
        b.push(3, ...strBytes(`S${index}_${s}`), cfg.members * 4); // structure_type
        structOffs.push(structOff);
        for (let m = 0; m < cfg.members; m++) {
            b.push(4, ...strBytes(`m${m}`), ...u32(intOff), m * 4); // member → int
        }
        b.push(0); // end struct children
    }
    const arrOff = off();
    b.push(6, ...u32(intOff), 16); // array_type of int
    b.push(7, 3, 0); // subrange upper_bound=3 → 4 元素
    b.push(5, ...strBytes(`cu${index}_f`), ...u32(floatOff), 5, 0x03, ...u32(0x20000000 + index * 4));
    b.push(5, ...strBytes(`cu${index}_a`), ...u32(arrOff), 5, 0x03, ...u32(0x20010000 + index * 4));
    for (let v = 0; v < cfg.vars; v++) {
        const kind = v % (2 + cfg.structs); // int、float、各 struct 轮转
        const typeRef = kind === 0 ? intOff : kind === 1 ? floatOff : structOffs[kind - 2];
        b.push(
            5,
            ...strBytes(`v${index}_${v}`),
            ...u32(typeRef),
            5,
            0x03,
            ...u32(0x20000000 + index * 0x10000 + v * 4)
        );
    }
    b.push(0); // end CU children
    const unitLen = b.length - 4;
    b[0] = unitLen & 0xff;
    b[1] = (unitLen >>> 8) & 0xff;
    b[2] = (unitLen >>> 16) & 0xff;
    b[3] = (unitLen >>> 24) & 0xff;
    return b;
}

function buildElf(cfg) {
    const cus = [];
    for (let i = 0; i < cfg.cus; i++) cus.push(buildCu(i, cfg));
    const debugInfo = Buffer.from(cus.flat());
    const names = ["", ".debug_info", ".debug_abbrev", ".shstrtab", ".strtab", ".symtab"];
    const nameOff = {};
    const shBytes = [];
    for (const nm of names) {
        nameOff[nm] = shBytes.length;
        for (const c of Buffer.from(nm, "latin1")) shBytes.push(c);
        shBytes.push(0);
    }
    const shstrtab = Buffer.from(shBytes);
    const symbolNames = [];
    for (let i = 0; i < cfg.cus; i++) {
        symbolNames.push(`cu${i}_f`, `cu${i}_a`);
        for (let v = 0; v < cfg.vars; v++) symbolNames.push(`v${i}_${v}`);
    }
    const stringOffsets = new Map();
    const stringParts = [Buffer.from([0])];
    let stringSize = 1;
    for (const name of symbolNames) {
        stringOffsets.set(name, stringSize);
        const part = Buffer.from(`${name}\0`, "latin1");
        stringParts.push(part);
        stringSize += part.length;
    }
    const strtab = Buffer.concat(stringParts);
    const symtab = Buffer.alloc((symbolNames.length + 1) * 16);
    symbolNames.forEach((name, index) => {
        const offset = (index + 1) * 16;
        symtab.writeUInt32LE(stringOffsets.get(name), offset);
        symtab.writeUInt32LE(0x20000000 + index * 4, offset + 4);
        symtab.writeUInt32LE(4, offset + 8);
        symtab[offset + 12] = 0x11;
        symtab.writeUInt16LE(1, offset + 14);
    });
    const diOff = 52;
    const abOff = diOff + debugInfo.length;
    const shstrOff = abOff + ABBREV.length;
    const strtabOff = shstrOff + shstrtab.length;
    const symtabOff = (strtabOff + strtab.length + 3) & ~3;
    const shoff = symtabOff + symtab.length;
    const shnum = 6;
    const buf = Buffer.alloc(shoff + shnum * 40);
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf[4] = 1;
    buf[5] = 1;
    buf[6] = 1;
    buf.writeUInt16LE(2, 16);
    buf.writeUInt16LE(0x28, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(shoff, 32);
    buf.writeUInt16LE(52, 40);
    buf.writeUInt16LE(40, 46);
    buf.writeUInt16LE(shnum, 48);
    buf.writeUInt16LE(3, 50);
    debugInfo.copy(buf, diOff);
    ABBREV.copy(buf, abOff);
    shstrtab.copy(buf, shstrOff);
    strtab.copy(buf, strtabOff);
    symtab.copy(buf, symtabOff);
    const sh = (i) => shoff + i * 40;
    buf.writeUInt32LE(nameOff[".debug_info"], sh(1) + 0);
    buf.writeUInt32LE(1, sh(1) + 4);
    buf.writeUInt32LE(diOff, sh(1) + 16);
    buf.writeUInt32LE(debugInfo.length, sh(1) + 20);
    buf.writeUInt32LE(nameOff[".debug_abbrev"], sh(2) + 0);
    buf.writeUInt32LE(1, sh(2) + 4);
    buf.writeUInt32LE(abOff, sh(2) + 16);
    buf.writeUInt32LE(ABBREV.length, sh(2) + 20);
    buf.writeUInt32LE(nameOff[".shstrtab"], sh(3) + 0);
    buf.writeUInt32LE(3, sh(3) + 4);
    buf.writeUInt32LE(shstrOff, sh(3) + 16);
    buf.writeUInt32LE(shstrtab.length, sh(3) + 20);
    buf.writeUInt32LE(nameOff[".strtab"], sh(4) + 0);
    buf.writeUInt32LE(3, sh(4) + 4);
    buf.writeUInt32LE(strtabOff, sh(4) + 16);
    buf.writeUInt32LE(strtab.length, sh(4) + 20);
    buf.writeUInt32LE(nameOff[".symtab"], sh(5) + 0);
    buf.writeUInt32LE(2, sh(5) + 4);
    buf.writeUInt32LE(symtabOff, sh(5) + 16);
    buf.writeUInt32LE(symtab.length, sh(5) + 20);
    buf.writeUInt32LE(4, sh(5) + 24);
    buf.writeUInt32LE(16, sh(5) + 36);
    return { buf, debugInfoBytes: debugInfo.length };
}

function ms(startNs) {
    return Number(process.hrtime.bigint() - startNs) / 1e6;
}
function fmt(n) {
    return n.toFixed(1).padStart(8);
}

if (require.main === module) {
    const cfg = parseArgs(process.argv);
    const { buf, debugInfoBytes } = buildElf(cfg);
    console.log(
        `合成 ELF: .debug_info=${(debugInfoBytes / 1024).toFixed(0)} KiB，CU=${cfg.cus}，每 CU 变量=${cfg.vars + 2}，结构体=${cfg.structs}×${cfg.members} 成员`
    );

    // 旧路径成本：两个 Buffer 副本各完整解析一次（重构前 parseDwarfVariableTypes/parseCompositeLayout 无共享缓存）
    let t0 = process.hrtime.bigint();
    const bufA = Buffer.from(buf);
    const types = dwarf.parseDwarfVariableTypes(bufA);
    const tTypes = ms(t0);
    t0 = process.hrtime.bigint();
    const bufB = Buffer.from(buf);
    const layouts = dwarf.parseCompositeLayout(bufB);
    const tLayouts = ms(t0);
    console.log(
        `double-parse（旧路径等价成本）: types=${fmt(tTypes)} ms  layouts=${fmt(tLayouts)} ms  合计=${fmt(tTypes + tLayouts)} ms`
    );

    if (typeof dwarf.parseDwarf === "function") {
        // 新聚合入口：同一 Buffer 一次解析、两个视图
        dwarf.parseDwarf(Buffer.from(buf)); // 预热（JIT）
        t0 = process.hrtime.bigint();
        const agg = dwarf.parseDwarf(Buffer.from(buf));
        const tAgg = ms(t0);
        console.log(`parseDwarf（聚合入口）        : ${fmt(tAgg)} ms`);
        if (agg.types.size !== types.size || agg.layouts.size !== layouts.size) {
            console.error(
                `!! 视图结果数不一致: agg types=${agg.types.size} layouts=${agg.layouts.size} vs legacy ${types.size}/${layouts.size}`
            );
            process.exitCode = 1;
        } else {
            console.log(`结果一致性: types=${agg.types.size} 项, layouts=${agg.layouts.size} 项 ✓`);
        }
    } else {
        console.log("parseDwarf（聚合入口）        : N/A（尚未实现）");
    }
}

module.exports = { buildElf };
