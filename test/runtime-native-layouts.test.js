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
        const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
        const { base, composite, fixed, fixture, member, pointer, variable } = require("./helpers/dwarf-tree");
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
