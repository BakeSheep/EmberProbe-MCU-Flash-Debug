"use strict";

// §2 Stage A: a global DWARF budget keeps every complete compilation unit instead of discarding all
// types. The unit being parsed when a budget runs out is rolled back as a whole.
const assert = require("assert");
const crypto = require("crypto");
const c = require("../src/dwarf/constants");
const { parseDwarfInternal, DEFAULT_BUDGETS } = require("../src/dwarf/parser");
const { buildVariableTypes, buildCompositeLayouts } = require("../src/dwarf/types");
const { ElfService } = require("../src/services/elfService");
const elfSymbols = require("../src/elfSymbols");
const { formatDiagnostic } = require("../src/webview/elfDiagnostics");
const { buildDwarfElf } = require("./helpers/elf-fixture");
const { cstr: string, u32, uleb } = require("./helpers/dwarf-tree");

const address = (value) => [5, 0x03, ...u32(value)];
const ref = (label) => ({ label });
const refAddr = (unit, label) => ({ unit, label });

const declarations = [
    [1, 0x11, 1, [0x03, 0x08]],
    [2, 0x24, 0, [0x03, 0x08], [0x3e, 0x0b], [0x0b, 0x0b]],
    [3, 0x13, 1, [0x03, 0x08], [0x0b, 0x0b]],
    [4, 0x0d, 0, [0x03, 0x08], [0x49, 0x13], [0x38, 0x0b]],
    [5, 0x34, 0, [0x03, 0x08], [0x49, 0x13], [0x02, 0x18]],
    [6, 0x34, 0, [0x03, 0x08], [0x49, 0x10], [0x02, 0x18]],
    [7, 0x2e, 1, [0x03, 0x08]],
    [8, 0x34, 0, [0x03, 0x08], [0x49, 0x13]],
    [9, 0x34, 0, [0x31, 0x13], [0x02, 0x18]]
];
const abbrev = Buffer.from([
    ...declarations.flatMap(([code, tag, children, ...attrs]) => [
        ...uleb(code),
        ...uleb(tag),
        children,
        ...attrs.flat(),
        0,
        0
    ]),
    0
]);

// Units are DWARF 4 with a 32-bit offset size. ref4 targets are unit-relative, ref_addr targets are
// .debug_info offsets, so both are resolved after every unit has its final position.
function buildInfo(specs) {
    const units = specs.map((spec) => {
        const bytes = [...u32(0), 4, 0, ...u32(0), 4];
        const offsets = new Map();
        const fixups = [];
        spec({
            die(label, code, ...attributes) {
                offsets.set(label, bytes.length);
                bytes.push(...uleb(code));
                for (const attr of attributes) {
                    if (attr.label) {
                        fixups.push({ position: bytes.length, ...attr });
                        bytes.push(...u32(0));
                    } else bytes.push(...attr);
                }
            },
            end() {
                bytes.push(0);
            }
        });
        return { bytes, offsets, fixups };
    });
    const starts = [];
    let start = 0;
    for (const unit of units) {
        starts.push(start);
        start += unit.bytes.length;
    }
    const info = Buffer.concat(
        units.map((unit) => {
            const buffer = Buffer.from(unit.bytes);
            buffer.writeUInt32LE(buffer.length - 4, 0);
            for (const fixup of unit.fixups) {
                const target = fixup.unit === undefined ? unit : units[fixup.unit];
                const offset = target.offsets.get(fixup.label);
                assert.notStrictEqual(offset, undefined, fixup.label);
                buffer.writeUInt32LE(fixup.unit === undefined ? offset : starts[fixup.unit] + offset, fixup.position);
            }
            return buffer;
        })
    );
    return { elf: buildDwarfElf(info, abbrev), starts, size: info.length };
}

// Eight budgeted DIEs: unit, int, struct, two members, struct terminator, variable, unit terminator.
function standardUnit(index) {
    return (unit) => {
        unit.die("cu", 1, string(`file${index}.c`));
        unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
        unit.die("struct", 3, string(`S${index}`), [8]);
        unit.die("a", 4, string("a"), ref("int"), [0]);
        unit.die("b", 4, string("b"), ref("int"), [4]);
        unit.end();
        unit.die("var", 5, string(`v${index}`), ref("struct"), address(0x20000000 + index * 16));
        unit.end();
    };
}

function partialOf(parsed) {
    return parsed.diagnostics.filter((entry) => entry.code === "DWARF_PARTIAL");
}

// A DIE budget that runs out inside the third unit keeps the first two and rolls back the third.
{
    const fixture = buildInfo([0, 1, 2, 3].map(standardUnit));
    const full = parseDwarfInternal(fixture.elf);
    assert.deepStrictEqual(full.diagnostics, []);
    assert.strictEqual(full.partial, null);
    assert.deepStrictEqual(
        full.variables.map((variable) => variable.name),
        ["v0", "v1", "v2", "v3"]
    );

    const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies: 20 } });
    assert.deepStrictEqual(
        parsed.variables.map((variable) => variable.name),
        ["v0", "v1"]
    );
    const [diagnostic] = partialOf(parsed);
    assert.strictEqual(parsed.diagnostics[0], diagnostic, "the partial notice leads the diagnostics");
    assert.strictEqual(partialOf(parsed).length, 1);
    assert.deepStrictEqual(parsed.partial, {
        budget: "DIE",
        loadedUnits: 2,
        droppedUnits: 2,
        droppedBytes: fixture.size - fixture.starts[2]
    });
    assert.strictEqual(diagnostic.i18nKey, "elfDiag.partial");
    assert.deepStrictEqual(diagnostic.i18nParams, { loaded: 2, total: 4, budget: "DIE" });
    assert.strictEqual(
        diagnostic.message,
        "DWARF types are partial: 2 of 4 units loaded; parsing stopped at the DIE budget"
    );

    // Rollback equivalence: what remains is exactly the full parse restricted to the kept units.
    const kept = (offset) => offset < fixture.starts[2];
    for (const field of ["dies", "childrenMap", "parentOf"]) {
        assert.deepStrictEqual(
            [...parsed[field].keys()],
            [...full[field].keys()].filter(kept),
            field + " keeps only complete units"
        );
        for (const [key, value] of parsed[field])
            if (field !== "dies") assert.deepStrictEqual(value, full[field].get(key), field);
    }
    assert.ok(
        [...parsed.childrenMap.values()].flat().every(kept),
        "no child of a rolled-back unit survives in a kept list"
    );
    const fullTypes = buildVariableTypes(full);
    const partialTypes = buildVariableTypes(parsed);
    const fullLayouts = buildCompositeLayouts(full);
    const partialLayouts = buildCompositeLayouts(parsed);
    for (const name of ["v0", "v1"]) {
        assert.deepStrictEqual(partialTypes.get(name), fullTypes.get(name), name);
        assert.deepStrictEqual(partialLayouts.get(name), fullLayouts.get(name), name);
    }
    for (const name of ["v2", "v3"]) {
        assert.strictEqual(partialTypes.has(name), false, name + " is absent, not guessed");
        assert.strictEqual(partialLayouts.has(name), false, name);
    }

    // Stopping on the unit terminator rolls back a unit whose variable and type were already stored.
    const late = parseDwarfInternal(fixture.elf, { budgets: { dies: 23 } });
    assert.deepStrictEqual(
        late.variables.map((variable) => variable.name),
        ["v0", "v1"]
    );
    assert.deepStrictEqual([...late.dies.keys()], [...full.dies.keys()].filter(kept));
    assert.strictEqual(buildVariableTypes(late).has("v2"), false);
}

// A cross-unit reference into a dropped unit resolves as missing, never as another type.
{
    const fixture = buildInfo([
        standardUnit(0),
        (unit) => {
            unit.die("cu", 1, string("cross.c"));
            unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
            unit.die("cross", 6, string("cross"), refAddr(2, "struct"), address(0x20001000));
            unit.end();
        },
        standardUnit(2)
    ]);
    const full = parseDwarfInternal(fixture.elf);
    assert.deepStrictEqual(
        buildCompositeLayouts(full)
            .get("cross")
            .members.map((member) => member.name),
        ["a", "b"]
    );
    const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies: 14 } });
    assert.deepStrictEqual(parsed.partial, {
        budget: "DIE",
        loadedUnits: 2,
        droppedUnits: 1,
        droppedBytes: fixture.size - fixture.starts[2]
    });
    assert.ok(
        parsed.variables.some((variable) => variable.name === "cross"),
        "the referencing variable is kept"
    );
    const type = buildVariableTypes(parsed).get("cross");
    assert.ok(!type || type.kind === "unknown", "a dangling type reference is never resolved to a struct");
    assert.strictEqual(buildCompositeLayouts(parsed).has("cross"), false);
}

// Unit and abbreviation budgets degrade the same way.
{
    const fixture = buildInfo([0, 1, 2, 3].map(standardUnit));
    const units = parseDwarfInternal(fixture.elf, { budgets: { units: 3 } });
    assert.deepStrictEqual(
        units.variables.map((variable) => variable.name),
        ["v0", "v1", "v2"]
    );
    assert.deepStrictEqual(units.partial, {
        budget: "compilation unit",
        loadedUnits: 3,
        droppedUnits: 1,
        droppedBytes: fixture.size - fixture.starts[3]
    });

    for (const budgets of [{ abbrevs: 3 }, { attrs: 3 }]) {
        const parsed = parseDwarfInternal(fixture.elf, { budgets });
        assert.strictEqual(parsed.dies.size, 0, "the first unit cannot load its abbreviations");
        assert.deepStrictEqual(parsed.variables, []);
        assert.strictEqual(parsed.partial.loadedUnits, 0);
        assert.strictEqual(parsed.partial.droppedUnits, 4);
        assert.match(parsed.partial.budget, /abbreviation|attribute/);
    }

    // Overrides can only lower a budget; malformed or larger values keep the production limits.
    for (const dies of [0, -1, 1.5, "5", DEFAULT_BUDGETS.dies * 2]) {
        const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies } });
        assert.strictEqual(parsed.partial, null, String(dies));
        assert.strictEqual(parsed.variables.length, 4);
    }
    assert.ok(Object.isFrozen(DEFAULT_BUDGETS));
}

// The local-retention retry pass stops at the same unit and reports one partial notice.
{
    const fixture = buildInfo([
        (unit) => {
            unit.die("cu", 1, string("locals.c"));
            unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
            unit.die("function", 7, string("work"));
            unit.die("counter", 8, string("counter"), ref("int"));
            unit.end();
            unit.die("concrete", 9, ref("counter"), address(0x20002000));
            unit.end();
        },
        standardUnit(1),
        standardUnit(2)
    ]);
    const full = parseDwarfInternal(fixture.elf);
    assert.deepStrictEqual(
        full.variables.map((variable) => variable.name),
        ["counter", "v1", "v2"],
        "the retry pass resolves the skipped abstract origin"
    );
    const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies: 19 } });
    assert.deepStrictEqual(
        parsed.variables.map((variable) => variable.name),
        ["counter", "v1"]
    );
    assert.strictEqual(partialOf(parsed).length, 1);
    assert.strictEqual(parsed.partial.loadedUnits, 2);
    assert.strictEqual(parsed.partial.droppedUnits, 1);
}

// The partial notice is localized from the parser message as well as from its i18n key.
{
    const en = require("../src/i18n/en");
    const zh = require("../src/i18n/zh");
    for (const table of [en, zh]) {
        const t = (key, params = {}) =>
            String(table[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
        const text = formatDiagnostic(
            "DWARF_PARTIAL: DWARF types are partial: 2 of 4 units loaded; parsing stopped at the DIE budget",
            t
        );
        assert.ok(text.startsWith("DWARF_PARTIAL: "), text);
        assert.ok(text.includes("2") && text.includes("4") && text.includes("DIE"), text);
        assert.notStrictEqual(text, "DWARF_PARTIAL: " + table["elfDiag.code.DWARF_PARTIAL"]);
        assert.ok(table["elfDiag.code.DWARF_PARTIAL"]);
    }
}

// A partial parse is not complete debug information: symbols without a kept DWARF record keep the
// user origin instead of being classified as toolchain runtime objects, and stay type-unknown.
{
    const fixture = buildInfo([standardUnit(0)]);
    const symbols = (names) => names.map((name, index) => ({ name, address: 0x20000000 + index * 16, size: 4 }));
    const service = (diagnostics) =>
        new ElfService({
            context: { workspaceState: { get: () => "/fake/app.elf" } },
            cacheKey: "elf",
            fs: {
                statSync: () => ({ size: fixture.elf.length, mtimeMs: 1 }),
                readFileSync: () => fixture.elf
            },
            crypto,
            cleanPath: (value) => value,
            t: (key) => key,
            elfSymbols: {
                ...elfSymbols,
                parseElfSymbols: () => ({ symbols: symbols(["v0", "sensorValue"]), functions: [], warnings: [] }),
                parseElfSections: () => ({ sections: [], programHeaders: [] })
            },
            dwarf: {
                parseDwarf: () => ({
                    types: new Map([["v0", { kind: "scalar", typeName: "int", watchType: "i32" }]]),
                    layouts: new Map(),
                    displayNames: new Map(),
                    diagnostics
                })
            }
        });
    const partialDiagnostic = { code: "DWARF_PARTIAL", stage: "parse", message: "partial" };
    const partial = service([partialDiagnostic]).read();
    const complete = service([]).read();
    const origin = (result, name) => result.symbols.find((symbol) => symbol.name === name).origin;
    assert.strictEqual(origin(complete, "sensorValue"), "runtime", "complete DWARF without a record means runtime");
    assert.strictEqual(origin(partial, "sensorValue"), "user", "a dropped unit's variable stays a user variable");
    assert.strictEqual(partial.typeMetadataIncomplete, true);
    const dropped = partial.symbols.find((symbol) => symbol.name === "sensorValue");
    assert.strictEqual(dropped.hasDwarfWriteType, false, "writes still need a DWARF type");
    assert.ok(partial.warnings.some((warning) => warning.startsWith("DWARF_PARTIAL: ")));
}

console.log("DWARF partial-parse degradation tests passed");
