"use strict";
// 验证 DWARF 复合类型布局解析：结构体成员名/偏移/类型、数组维度与元素类型。
// 程序化构造最小 ELF32 + DWARF v4 调试段（.debug_info/.debug_abbrev），无需外部工具链。
const assert = require("assert");
const { parseCompositeLayout, parseDwarfVariableTypes } = require("../src/dwarf");

function str(s) { const b = []; for (const c of Buffer.from(s, "latin1")) b.push(c); b.push(0); return b; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

// —— .debug_info（DWARF v4）——  注释中的 @N 为该 DIE 在节内的偏移，供 ref4 引用
const di = [];
di.push(...u32(0));            // unit_length 占位（末尾回填）
di.push(4, 0);                 // version = 4
di.push(...u32(0));            // debug_abbrev_offset = 0
di.push(4);                    // address_size = 4
di.push(1);                    // @11 compile_unit
di.push(2, ...str("int"), 0x05, 4);     // @12 base_type int (signed, 4B)
di.push(2, ...str("float"), 0x04, 4);   // @19 base_type float (float, 4B)
di.push(3, ...str("Sensor"), 8);        // @28 structure_type Sensor (byte_size 8)
di.push(4, ...str("x"), ...u32(12), 0); // @37   member x -> int@12, offset 0
di.push(4, ...str("y"), ...u32(19), 4); // @45   member y -> float@19, offset 4
di.push(0);                             // @53   end Sensor children
di.push(8, ...str("SensorAlias"), ...u32(28)); // @54 typedef SensorAlias -> Sensor@28
di.push(6, ...u32(12), 16);             // @71 array_type of int@12 (byte_size 16)
di.push(7, 3);                          // @77   subrange upper_bound = 3 -> 4 elements
di.push(0);                             // @79   end array children
di.push(6, ...u32(28), 16);             // @80 array_type of Sensor@28 (byte_size 16)
di.push(7, 1);                          // @86   subrange upper_bound = 1 -> 2 elements
di.push(0);                             // @88   end array children
di.push(5, ...str("sensorAlias"), ...u32(54), 5, 0x03, ...u32(0x20000100)); // @89 typedef variable
di.push(5, ...str("sensorArr"), ...u32(80), 5, 0x03, ...u32(0x20000200));   // @112 Sensor[2]
di.push(5, ...str("buf"), ...u32(71), 5, 0x03, ...u32(0x20000300));         // @133 int[4]
di.push(0);                             // @148 end CU children
const unitLen = di.length - 4;
di[0] = unitLen & 0xff; di[1] = (unitLen >>> 8) & 0xff; di[2] = (unitLen >>> 16) & 0xff; di[3] = (unitLen >>> 24) & 0xff;
const debugInfo = Buffer.from(di);

// —— .debug_abbrev ——（code, tag, has_children, [attr, form]..., 0, 0）
const abbrev = Buffer.from([
    1, 0x11, 1, 0, 0,                                       // compile_unit
    2, 0x24, 0, 0x03, 0x08, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0,   // base_type: name(str) encoding(data1) byte_size(data1)
    3, 0x13, 1, 0x03, 0x08, 0x0b, 0x0b, 0, 0,               // structure_type: name(str) byte_size(data1)
    4, 0x0d, 0, 0x03, 0x08, 0x49, 0x13, 0x38, 0x0b, 0, 0,   // member: name(str) type(ref4) data_member_location(data1)
    5, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x18, 0, 0,   // variable: name(str) type(ref4) location(exprloc)
    6, 0x01, 1, 0x49, 0x13, 0x0b, 0x0b, 0, 0,               // array_type: type(ref4) byte_size(data1)
    7, 0x21, 0, 0x2f, 0x0b, 0, 0,                           // subrange_type: upper_bound(0x2f, data1)
    8, 0x16, 0, 0x03, 0x08, 0x49, 0x13, 0, 0,               // typedef: name(str) type(ref4)
    0
]);

// —— .shstrtab ——
const names = ["", ".debug_info", ".debug_abbrev", ".shstrtab"];
const nameOff = {};
const shBytes = [];
for (const nm of names) { nameOff[nm] = shBytes.length; for (const c of Buffer.from(nm, "latin1")) shBytes.push(c); shBytes.push(0); }
const shstrtab = Buffer.from(shBytes);

// —— 组装 ELF32 LE ——
const diOff = 52;
const abOff = diOff + debugInfo.length;
const shstrOff = abOff + abbrev.length;
let shoff = shstrOff + shstrtab.length;
shoff = (shoff + 3) & ~3;
const shnum = 4;
const buf = Buffer.alloc(shoff + shnum * 40);
buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; buf[4] = 1; buf[5] = 1; buf[6] = 1;
buf.writeUInt16LE(2, 16); buf.writeUInt16LE(0x28, 18); buf.writeUInt32LE(1, 20);
buf.writeUInt32LE(shoff, 32); buf.writeUInt16LE(52, 40); buf.writeUInt16LE(40, 46);
buf.writeUInt16LE(shnum, 48); buf.writeUInt16LE(3, 50); // e_shstrndx = 3
debugInfo.copy(buf, diOff); abbrev.copy(buf, abOff); shstrtab.copy(buf, shstrOff);
const sh = i => shoff + i * 40;
buf.writeUInt32LE(nameOff[".debug_info"], sh(1) + 0); buf.writeUInt32LE(1, sh(1) + 4); buf.writeUInt32LE(diOff, sh(1) + 16); buf.writeUInt32LE(debugInfo.length, sh(1) + 20);
buf.writeUInt32LE(nameOff[".debug_abbrev"], sh(2) + 0); buf.writeUInt32LE(1, sh(2) + 4); buf.writeUInt32LE(abOff, sh(2) + 16); buf.writeUInt32LE(abbrev.length, sh(2) + 20);
buf.writeUInt32LE(nameOff[".shstrtab"], sh(3) + 0); buf.writeUInt32LE(3, sh(3) + 4); buf.writeUInt32LE(shstrOff, sh(3) + 16); buf.writeUInt32LE(shstrtab.length, sh(3) + 20);

// —— 断言：结构体布局 ——
const layouts = parseCompositeLayout(buf);
const sensor = layouts.get("sensorAlias");
assert.ok(sensor, "应穿透 typedef 并解析出 sensorAlias 复合布局");
assert.strictEqual(sensor.kind, "struct");
assert.strictEqual(sensor.typeName, "SensorAlias");
assert.strictEqual(sensor.byteSize, 8);
assert.deepStrictEqual(
    sensor.members.map(m => [m.name, m.offset, m.byteSize, m.watchType]),
    [["x", 0, 4, "i32"], ["y", 4, 4, "f32"]],
    "结构体成员名/偏移/宽度/类型应正确解析"
);

// —— 断言：数组布局（回归守护 DW_AT_upper_bound = 0x2f）——
const bufArr = layouts.get("buf");
assert.ok(bufArr, "应解析出 buf 数组布局");
assert.strictEqual(bufArr.kind, "array");
assert.deepStrictEqual(bufArr.dimensions, [4], "upper_bound=3 应得到 4 个元素（常量必须为 0x2f，否则维度丢失）");
assert.strictEqual(bufArr.totalElements, 4);
assert.strictEqual(bufArr.elementType.watchType, "i32");
assert.strictEqual(bufArr.elementType.byteSize, 4);
assert.strictEqual(bufArr.typeName, "int[]");

// —— 断言：结构体数组保留元素的完整嵌套布局 ——
const sensorArr = layouts.get("sensorArr");
assert.ok(sensorArr, "应解析出结构体数组");
assert.strictEqual(sensorArr.kind, "array");
assert.strictEqual(sensorArr.totalElements, 2);
assert.strictEqual(sensorArr.elementType.kind, "struct");
assert.ok(sensorArr.elementType.compositeLayout, "结构体数组元素应保留成员布局");
assert.deepStrictEqual(sensorArr.elementType.compositeLayout.members.map(m => m.name), ["x", "y"]);

// —— 断言：parseDwarfVariableTypes 一致识别复合类型 ——
const types = parseDwarfVariableTypes(buf);
assert.strictEqual(types.get("sensorAlias").typeName, "SensorAlias");
assert.strictEqual(types.get("sensorAlias").watchType, "", "结构体整体不可作为标量观察");
assert.strictEqual(types.get("buf").typeName, "int[]");

console.log("DWARF composite layout tests passed");
