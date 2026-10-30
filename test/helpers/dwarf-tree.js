"use strict";
// Builds DWARF test ELFs from DIE trees: node(id, tag, attrs, children) with [at, form, value] attributes.
// Form 0x13/0x10 values are DIE ids resolved after layout; units are DIE arrays or a compile_unit node.
const assert = require("assert");
const c = require("../../src/dwarf/constants");
const { buildElf32, buildDebugSections } = require("./elf-fixture");

function fixed(value, width = 4) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
    return Array.from(bytes.subarray(0, width));
}
function leb(value, signed = false) {
    let remaining = BigInt(value);
    const bytes = [];
    do {
        let byte = Number(remaining & 127n);
        remaining >>= 7n;
        const last = signed
            ? (remaining === 0n && !(byte & 64)) || (remaining === -1n && !!(byte & 64))
            : remaining === 0n;
        if (!last) byte |= 128;
        bytes.push(byte);
        if (last) break;
    } while (true);
    return bytes;
}
const node = (id, tag, attrs = [], children = []) => ({ id, tag, attrs, children });
const attr = (at, form, value) => [at, form, value];
const nameAttr = (name) => attr(c.DW_AT_name, 8, name);
const typeAttr = (ref) => attr(c.DW_AT_type, 0x13, ref);
const base = (id, name = "int", size = 4, encoding = c.DW_ATE_signed) =>
    node(id, c.DW_TAG_base_type, [
        nameAttr(name),
        attr(c.DW_AT_byte_size, 0x0b, size),
        attr(c.DW_AT_encoding, 0x0b, encoding)
    ]);
const composite = (id, name, size, children = [], tag = c.DW_TAG_class_type) =>
    node(id, tag, [...(name ? [nameAttr(name)] : []), attr(c.DW_AT_byte_size, 6, size)], children);
const declaration = (id, name, tag = c.DW_TAG_class_type) =>
    node(id, tag, [nameAttr(name), attr(c.DW_AT_declaration, 0x19, true)]);
const member = (id, name, type, offset) =>
    node(id, c.DW_TAG_member, [nameAttr(name), typeAttr(type), attr(c.DW_AT_data_member_location, 6, offset)]);
const pointer = (id, type) => node(id, c.DW_TAG_pointer_type, [typeAttr(type)]);
const variable = (name, type, address = 0x20000000, expression) =>
    node("var-" + name, c.DW_TAG_variable, [
        nameAttr(name),
        typeAttr(type),
        attr(c.DW_AT_location, 0x18, expression || [3, ...fixed(address)])
    ]);
function fixture(units, { version = 4, symbols = [], sections = [] } = {}) {
    const info = [],
        abbrev = [],
        definitions = new Map(),
        offsets = new Map(),
        references = [];
    const value = (form, input, cuStart) => {
        if ([0x13, 0x10].includes(form)) {
            references.push({ offset: info.length, label: input, cuStart: form === 0x13 ? cuStart : 0 });
            info.push(0, 0, 0, 0);
        } else if ([0x0b, 5, 6, 7].includes(form)) info.push(...fixed(input, { 0x0b: 1, 5: 2, 6: 4, 7: 8 }[form]));
        else if (form === 8) info.push(...Buffer.from(input + "\0"));
        else if (form === 0x18) info.push(...leb(input.length), ...input);
        else if ([0x0f, 0x0d].includes(form)) info.push(...leb(input, form === 0x0d));
        else if (form === 0x16) {
            info.push(...leb(input.form));
            value(input.form, input.value, cuStart);
        } else if (![0x19, 0x21].includes(form)) throw new Error("Unsupported fixture form " + form);
    };
    const emit = (die, cuStart) => {
        offsets.set(die.id, info.length);
        const key = JSON.stringify([
            die.tag,
            !!die.children.length,
            die.attrs.map(([at, form, v]) => [at, form, form === 0x21 ? v : null])
        ]);
        if (!definitions.has(key)) {
            const code = definitions.size + 1;
            definitions.set(key, code);
            abbrev.push(...leb(code), ...leb(die.tag), Number(!!die.children.length));
            for (const [at, form, v] of die.attrs) {
                abbrev.push(...leb(at), ...leb(form));
                if (form === 0x21) abbrev.push(...leb(v, true));
            }
            abbrev.push(0, 0);
        }
        info.push(...leb(definitions.get(key)));
        for (const [, form, v] of die.attrs) value(form, v, cuStart);
        for (const child of die.children) emit(child, cuStart);
        if (die.children.length) info.push(0);
    };
    for (let index = 0; index < units.length; index++) {
        const cuStart = info.length;
        info.push(0, 0, 0, 0, version, 0);
        if (version === 5) info.push(1, 4, 0, 0, 0, 0);
        else info.push(0, 0, 0, 0, 4);
        const unit = Array.isArray(units[index]) ? node("cu-" + index, 0x11, [], units[index]) : units[index];
        emit(unit, cuStart);
        fixed(info.length - cuStart - 4).forEach((byte, offset) => {
            info[cuStart + offset] = byte;
        });
    }
    for (const ref of references) {
        assert(offsets.has(ref.label), "Unknown reference " + ref.label);
        fixed(offsets.get(ref.label) - ref.cuStart).forEach((byte, offset) => {
            info[ref.offset + offset] = byte;
        });
    }
    abbrev.push(0);
    return {
        buffer: buildElf32({
            sections: [...buildDebugSections({ info: Buffer.from(info), abbrev: Buffer.from(abbrev) }), ...sections],
            symbols
        }),
        offsets
    };
}
const u32 = (value) => fixed(value);
const uleb = (value) => leb(value);
const cstr = (value) => [...Buffer.from(value), 0];

module.exports = {
    cstr,
    u32,
    uleb,
    attr,
    base,
    composite,
    declaration,
    fixed,
    fixture,
    leb,
    member,
    nameAttr,
    node,
    pointer,
    typeAttr,
    variable
};
