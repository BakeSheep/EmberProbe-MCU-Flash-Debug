"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const zlib = require("zlib");
const fixtures = require("./fixtures/runtime-layouts.json");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { bindVariableSymbols, buildDisplayNames } = require("../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const { parseElfSymbols, parseElfSections } = require("../src/elfSymbols");
const { exerciseRuntimeLayouts } = require("./helpers/runtime-layouts");

(async () => {
    for (const compressed of Object.values(fixtures)) {
        const buffer = zlib.inflateSync(Buffer.from(compressed, "base64"));
        const symbols = parseElfSymbols(buffer).symbols;
        const parsed = bindVariableSymbols(parseDwarfInternal(buffer), symbols);
        const names = buildDisplayNames(parsed);
        for (const symbol of symbols) symbol.displayName = names.get(symbol.name);
        assert.deepStrictEqual(parsed.diagnostics, []);
        await exerciseRuntimeLayouts(
            symbols,
            createRuntimeLayoutResolver(parsed, symbols),
            parseElfSections(buffer).sections
        );
    }

    await scenario("Bound runtime graphs and atomically roll back incomplete vtable catalogs", async () => {
        const c = require("../src/dwarf/constants");
        const { parseDwarf } = require("../src/dwarf");
        const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
        const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
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
                } else if ([0x0b, 5, 6, 7].includes(form))
                    info.push(...fixed(input, { 0x0b: 1, 5: 2, 6: 4, 7: 8 }[form]));
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
                    sections: [
                        ...buildDebugSections({ info: Buffer.from(info), abbrev: Buffer.from(abbrev) }),
                        ...sections
                    ],
                    symbols
                }),
                offsets
            };
        }
        function runtimeFixture(count = 4200) {
            const children = [],
                members = [];
            for (let index = 0; index < count; index++) {
                children.push(pointer("ptr-" + index, "int"));
                members.push(member("field-" + index, "p" + index, "ptr-" + index, index * 4));
            }
            return fixture(
                [
                    [
                        base("int"),
                        ...children,
                        composite("large", "Large", count * 4, members),
                        composite("small", "Small", 4, [member("small-x", "x", "int", 0)]),
                        variable("large", "large"),
                        variable("small", "small", 0x20010000)
                    ]
                ],
                {
                    symbols: [
                        { name: "large", value: 0x20000000, size: count * 4 },
                        { name: "small", value: 0x20010000, size: 4 }
                    ]
                }
            );
        }
        const f = runtimeFixture();
        const result = parseDwarf(f.buffer, { runtime: true });
        assert.strictEqual(result.layouts.get("large").members.length, 4200, "preserve successful static layout");
        assert.strictEqual(result.layouts.get("large").runtimeLayout.truncated, true);
        assert.ok(result.layouts.get("large").runtimeLayout.types.length <= 4096);
        assert.strictEqual(result.layouts.get("small").members[0].name, "x");
        assert.strictEqual(result.displayNames.get("large"), "large");
        assert.strictEqual(result.diagnostics.length, 1);
        assert.deepStrictEqual(
            [result.diagnostics[0].code, result.diagnostics[0].stage, result.diagnostics[0].symbol],
            ["DWARF_BUDGET_EXCEEDED", "runtime-layouts", "large"]
        );

        const dies = new Map([
            [1, { tag: c.DW_TAG_base_type, name: "int", byteSize: 4, encoding: c.DW_ATE_signed }],
            [2, { tag: c.DW_TAG_pointer_type, typeRef: 1 }]
        ]);
        const childrenMap = new Map(),
            symbols = [];
        for (let index = 0; index < 5000; index++) {
            const ref = 100 + index * 2,
                name = "Poly" + index;
            dies.set(ref, { tag: c.DW_TAG_class_type, name, qualifiedTypeName: name, byteSize: 4 });
            dies.set(ref + 1, { tag: c.DW_TAG_member, name: "_vptr." + name, typeRef: 2, memberOffset: 0 });
            childrenMap.set(ref, [ref + 1]);
            symbols.push({ name: "_ZTV" + name.length + name, address: 0x08000000 + index * 16, size: 16 });
        }
        const parsed = {
            dies,
            childrenMap,
            variables: [
                { name: "p", typeRef: 2 },
                { name: "poly", typeRef: 100 }
            ]
        };
        let iterations = 0;
        const originalIterator = dies[Symbol.iterator];
        const iterator = originalIterator.bind(dies);
        dies[Symbol.iterator] = () => {
            iterations++;
            return iterator();
        };
        try {
            const resolve = createRuntimeLayoutResolver(parsed, symbols),
                errors = [];
            const plain = resolve("p", (name, error) => errors.push([name, error]));
            assert.strictEqual(plain.types.length, 2);
            assert.strictEqual(iterations, 0, "scalar pointers must not scan ELF-wide vtable types");
            assert.deepStrictEqual(plain.dynamicTypes, []);
            const poly = resolve("poly", (name, error) => errors.push([name, error]));
            assert.strictEqual(poly.types.length, 3);
            assert.deepStrictEqual(poly.dynamicTypes, []);
            assert.strictEqual(errors[0][1].code, "DWARF_BUDGET_EXCEEDED");
            resolve("poly", () => {});
            assert.strictEqual(iterations, 1, "vtable candidate index is shared across variables");
            const reader = new RuntimeObjectReader(
                { runtimeLayout: poly, runtimeRanges: [{ start: 0x20000000, end: 0x20000004 }] },
                async () => Buffer.from(fixed(0x08000008))
            );
            await assert.rejects(
                reader.dynamic({ address: 0x20000000, type: poly.root }),
                /no verified vtable identity/
            );

            // A failure after some dynamic candidates were expanded must roll back all.
            const huge = 20000;
            dies.set(huge, { tag: c.DW_TAG_class_type, name: "Huge", qualifiedTypeName: "Huge", byteSize: 16800 });
            childrenMap.set(huge, []);
            for (let index = 0; index < 4200; index++) {
                const ref = 30000 + index * 2;
                dies.set(ref, { tag: c.DW_TAG_pointer_type, typeRef: 1 });
                dies.set(ref + 1, { tag: c.DW_TAG_member, name: "p" + index, typeRef: ref, memberOffset: index * 4 });
                childrenMap.get(huge).push(ref + 1);
            }
            const atomic = createRuntimeLayoutResolver(parsed, [
                symbols[0],
                { name: "_ZTV4Huge", address: 0x08010000, size: 16 }
            ]);
            const partial = atomic("poly", () => {});
            assert.strictEqual(partial.types.length, 3);
            assert.deepStrictEqual(partial.dynamicTypes, []);
            const complete = createRuntimeLayoutResolver(parsed, symbols.slice(0, 2))("poly");
            assert.strictEqual(complete.dynamicTypes.length, 2, "small complete catalogs still work");
        } finally {
            dies[Symbol.iterator] = originalIterator;
        }
    });

    console.log("Real ARM libstdc++ layouts: 24 runtime object kinds / DWARF 4 and 5 passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
