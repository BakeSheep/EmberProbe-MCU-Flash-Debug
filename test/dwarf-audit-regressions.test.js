"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../src/dwarf/constants");
const { parseDwarf } = require("../src/dwarf");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { buildCompositeLayouts, buildVariableTypes } = require("../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const { readCompanion } = require("../src/dwarf/files");
const { createTypeComparer } = require("../src/dwarf/typeIdentity");
const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
const { validateComposite } = require("../src/compositeValidation");
const { expandCompositeLeaves } = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
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

// All fixtures are synthetic ELF32/DWARF4/5; normal tests need no compiler.
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

function zeroArrayTests() {
    const bounds = [
        [6, 4294967295],
        [7, 18446744073709551615n],
        [0x0d, -1],
        [0x21, -1],
        [0x16, { form: 6, value: 4294967295 }]
    ];
    for (const version of [4, 5])
        for (const [form, upper] of bounds) {
            const f = fixture(
                [
                    [
                        base("int"),
                        base("char", "char", 1, c.DW_ATE_signed_char),
                        pointer("ptr", "int"),
                        node(
                            "empty",
                            c.DW_TAG_array_type,
                            [typeAttr("char")],
                            [node("range", c.DW_TAG_subrange_type, [attr(c.DW_AT_upper_bound, form, upper)])]
                        ),
                        composite(
                            "Z",
                            "Z",
                            4,
                            [member("n", "n", "int", 0), member("tail", "tail", "empty", 4)],
                            c.DW_TAG_structure_type
                        ),
                        composite("Outer", "Outer", 8, [member("z", "z", "Z", 0), member("p", "p", "ptr", 4)]),
                        variable("zl", "Z"),
                        variable("outer", "Outer", 0x20000010)
                    ]
                ],
                { version }
            );
            const parsed = parseDwarfInternal(f.buffer);
            assert.strictEqual(parsed.dies.get(f.offsets.get("range")).subrangeCount, 0, "all-ones upper bound");
            const result = parseDwarf(f.buffer, { runtime: true });
            assert.deepStrictEqual(result.diagnostics, []);
            const layout = result.layouts.get("zl");
            const tail = layout.members.find((entry) => entry.name === "tail");
            assert.strictEqual(tail.byteSize, 0);
            assert.deepStrictEqual(tail.compositeLayout.dimensions, [0]);
            assert.strictEqual(tail.compositeLayout.totalElements, 0);
            validateComposite(layout, 4);
            assert.deepStrictEqual(
                expandCompositeLeaves({ name: "zl", address: 0x20000000, size: 4 }, layout).map((entry) => entry.path),
                ["zl.n"]
            );
            const outer = result.layouts.get("outer");
            assert.strictEqual(outer.members[0].compositeLayout.members.length, 2);
            assert.strictEqual(outer.members[1].name, "p");
            const empty = outer.runtimeLayout.types.find((entry) => entry.kind === "array");
            assert.strictEqual(empty.count, 0);
            assert.strictEqual(empty.byteSize, 0);
        }
    // The sentinel is form-width-specific, not any integer ending in FF. GCC emits
    // uint8_t a[256] as data1 0xff and a[65536] as data2 0xffff: ordinary bounds.
    for (const [form, upper, count] of [
        [6, 255, 256],
        [0x0b, 255, 256],
        [5, 65535, 65536]
    ]) {
        const f = fixture([
            [
                base("char", "char", 1, c.DW_ATE_signed_char),
                pointer("ptr", "char"),
                node(
                    "a",
                    c.DW_TAG_array_type,
                    [typeAttr("char")],
                    [node("r", c.DW_TAG_subrange_type, [attr(c.DW_AT_upper_bound, form, upper)])]
                ),
                node(
                    "pa",
                    c.DW_TAG_array_type,
                    [typeAttr("ptr")],
                    [node("pr", c.DW_TAG_subrange_type, [attr(c.DW_AT_upper_bound, form, upper)])]
                ),
                variable("a", "a"),
                variable("pa", "pa", 0x20010000)
            ]
        ]);
        const result = parseDwarf(f.buffer, { runtime: true });
        assert.strictEqual(result.layouts.get("a").totalElements, count, "form 0x" + form.toString(16));
        assert.strictEqual(result.layouts.get("a").byteSize, count);
        // Runtime nodes describe large arrays without expanding them.
        const runtimeArray = result.layouts.get("pa").runtimeLayout.types.find((entry) => entry.kind === "array");
        assert.strictEqual(runtimeArray.count, count);
        assert.ok(!result.diagnostics.some((entry) => entry.stage === "runtime-layouts"));
    }
}

function declarationTests() {
    for (const version of [4, 5]) {
        const inner = composite(
            "inner-def",
            "",
            8,
            [member("x", "x", "int-a", 0), member("y", "y", "short", 4)],
            c.DW_TAG_structure_type
        );
        inner.attrs.push(attr(c.DW_AT_specification, 0x13, "inner-decl"));
        const f = fixture(
            [
                [
                    base("int-a"),
                    base("short", "short int", 2),
                    declaration("axis-decl", "Axis"),
                    node(
                        "axis-array",
                        c.DW_TAG_array_type,
                        [typeAttr("axis-decl")],
                        [node("axis-range", c.DW_TAG_subrange_type, [attr(c.DW_AT_count, 0x0b, 1)])]
                    ),
                    node("alias", c.DW_TAG_typedef, [nameAttr("AxisAlias"), typeAttr("axis-decl")]),
                    pointer("inner-ptr", "inner-decl"),
                    composite(
                        "outer",
                        "Outer",
                        8,
                        [
                            declaration("inner-decl", "Inner", c.DW_TAG_structure_type),
                            member("p", "p", "inner-ptr", 0),
                            member("k", "k", "int-a", 4)
                        ],
                        c.DW_TAG_structure_type
                    ),
                    inner,
                    variable("axes", "axis-array"),
                    variable("alias_g", "alias", 0x20000020),
                    variable("inner_g", "inner-def", 0x20000030),
                    variable("outer_g", "outer", 0x20000040)
                ],
                [
                    base("int-b"),
                    base("float", "float", 4, c.DW_ATE_float),
                    composite("axis-def", "Axis", 12, [member("a", "a", "int-b", 4), member("b", "b", "float", 8)])
                ]
            ],
            { version }
        );
        const parsed = parseDwarfInternal(f.buffer);
        assert.strictEqual(parsed.dies.get(f.offsets.get("axis-array")).typeRef, f.offsets.get("axis-def"));
        assert.strictEqual(parsed.dies.get(f.offsets.get("alias")).typeRef, f.offsets.get("axis-def"));
        assert.strictEqual(
            parsed.dies.get(f.offsets.get("axis-decl")).tag,
            c.DW_TAG_class_type,
            "retain declaration tag"
        );
        const result = parseDwarf(f.buffer, { runtime: true });
        assert.deepStrictEqual(result.diagnostics, []);
        const axis = result.layouts.get("axes").elementType;
        assert.strictEqual(axis.byteSize, 12);
        assert.deepStrictEqual(
            axis.compositeLayout.members.map((entry) => entry.name),
            ["a", "b"]
        );
        assert.strictEqual(result.types.get("inner_g").typeName, "struct Outer::Inner");
        assert.strictEqual(result.layouts.get("inner_g").typeName, "struct Outer::Inner");
        const runtime = result.layouts.get("outer_g").runtimeLayout;
        assert(
            runtime.types.some(
                (entry) => entry.kind === "class" && entry.typeName === "Outer::Inner" && entry.byteSize === 8
            )
        );
    }
    const candidateFixture = ({
        sizes = [4],
        fieldKinds = [],
        tags = [],
        local = null,
        definitionLocal = null,
        sameCU = false,
        count = sizes.length,
        memberCount = 1
    } = {}) => {
        const decl = declaration("decl", "Thing");
        const wrap = (die, kind, id) =>
            !kind
                ? die
                : node(
                      id,
                      kind === "anonymous" ? c.DW_TAG_namespace : kind === "function" ? c.DW_TAG_subprogram : 0x0b,
                      [],
                      [die]
                  );
        const scoped = [decl];
        if (sameCU) scoped.push(composite("same", "Thing", 4, [member("same-x", "x", "first-int", 0)]));
        const first = [
            base("first-int"),
            ...(local ? [wrap(scoped[0], local, "private-decl")] : scoped),
            variable("thing", "decl")
        ];
        if (local && sameCU) first[1].children.push(scoped[1]);
        const units = [first];
        for (let index = 0; index < count; index++)
            units.push([
                base(
                    "int-" + index,
                    fieldKinds[index] || "int",
                    4,
                    fieldKinds[index] === "float" ? c.DW_ATE_float : c.DW_ATE_signed
                ),
                wrap(
                    composite(
                        "def-" + index,
                        "Thing",
                        sizes[index % sizes.length],
                        Array.from({ length: memberCount }, (_, field) =>
                            member("field-" + index + "-" + field, field ? "x" + field : "x", "int-" + index, field * 4)
                        ),
                        tags[index] || c.DW_TAG_class_type
                    ),
                    definitionLocal,
                    "private-def-" + index
                )
            ]);
        return fixture(units);
    };
    for (const options of [
        {},
        { sizes: [4, 4] },
        { sizes: [4, 4], tags: [c.DW_TAG_structure_type, c.DW_TAG_class_type] },
        { sizes: [8], sameCU: true },
        { sizes: [4], sameCU: true, local: "anonymous" }
    ]) {
        const f = candidateFixture(options);
        const layout = parseDwarf(f.buffer).layouts.get("thing");
        assert(layout, JSON.stringify(options));
        assert.strictEqual(layout.byteSize, 4);
        assert.strictEqual(layout.members[0].name, "x");
    }
    for (const options of [
        { sizes: [4, 8] },
        { sizes: [4, 4], fieldKinds: ["int", "float"] },
        { local: "anonymous" },
        { local: "function" },
        { local: "block" },
        { definitionLocal: "anonymous" },
        { sizes: [4], tags: [c.DW_TAG_union_type] },
        { sizes: [4], count: 65 },
        { sizes: [36000, 36000], memberCount: 9000 }
    ]) {
        const f = candidateFixture(options);
        const parsed = parseDwarfInternal(f.buffer);
        assert.strictEqual(
            parsed.variables[0].typeRef,
            f.offsets.get("decl"),
            "unsafe or over-budget association " + JSON.stringify(options)
        );
        assert.strictEqual(parsed.dies.get(f.offsets.get("decl")).isDecl, true);
    }
    // Same-CU lookup must retain the actual anonymous/function scope identity.
    const distinctScope = fixture([
        [
            base("int"),
            node("anon", c.DW_TAG_namespace, [], [declaration("decl", "Thing")]),
            composite("public", "Thing", 4, [member("x", "x", "int", 0)]),
            variable("private", "decl")
        ]
    ]);
    assert.strictEqual(parseDwarf(distinctScope.buffer).layouts.has("private"), false);
    const enumeration = fixture([
        [declaration("enum-decl", "Mode", c.DW_TAG_enumeration_type), variable("mode", "enum-decl")],
        [
            node(
                "enum-def",
                c.DW_TAG_enumeration_type,
                [nameAttr("Mode"), attr(c.DW_AT_byte_size, 0x0b, 4), attr(c.DW_AT_encoding, 0x0b, c.DW_ATE_signed)],
                [node("enum-value", c.DW_TAG_enumerator, [nameAttr("negative"), attr(0x1c, 0x0d, -1)])]
            )
        ]
    ]);
    assert.strictEqual(parseDwarf(enumeration.buffer).types.get("mode").enumInfo.entries[0].value, "-1");

    // Direct DIE consumers also prefer the sole definition before comparing size.
    for (const reversed of [false, true]) {
        const dies = new Map([
            [1, { tag: c.DW_TAG_class_type, name: "Thing", isDecl: true }],
            [2, { tag: c.DW_TAG_class_type, name: "Thing", byteSize: 4 }]
        ]);
        const variables = [
            { name: "thing", typeRef: 1 },
            { name: "thing", typeRef: 2 }
        ];
        if (reversed) variables.reverse();
        const parsed = { dies, childrenMap: new Map(), variables };
        assert.strictEqual(buildCompositeLayouts(parsed).get("thing").byteSize, 4);
        assert.strictEqual(buildVariableTypes(parsed).get("thing").ambiguous, undefined);
    }
}

function ambiguityTests() {
    for (const sameSize of [false, true]) {
        const f = fixture([
            [
                base("int"),
                composite("a", "", 4, [member("x", "x", "int", 0)], c.DW_TAG_structure_type),
                variable("ctx", "a")
            ],
            [
                base("double", "double", sameSize ? 4 : 8, c.DW_ATE_float),
                composite("b", "", sameSize ? 4 : 16, [member("y", "y", "double", 0)], c.DW_TAG_structure_type),
                variable("ctx", "b", 0x20000000)
            ]
        ]);
        const result = parseDwarf(f.buffer);
        assert.strictEqual(result.types.get("ctx").ambiguous, true);
        assert.strictEqual(result.layouts.has("ctx"), false);
        const enriched = { symbols: [{ name: "ctx", address: 0x20000000, size: 16 }] };
        new ElfService({ t: (key) => key })._enrich(enriched, result.types, result.layouts);
        assert.match(enriched.symbols[0].unsupportedReason, /ambiguous/i);
    }
    // Same-named, same-typed statics in different CUs (static int state;) keep their type.
    const statics = fixture([
        [base("int"), variable("state", "int", 0x20000000)],
        [base("int"), variable("state", "int", 0x20000004)]
    ]);
    const staticResult = parseDwarf(statics.buffer);
    assert.strictEqual(staticResult.types.get("state").ambiguous, undefined);
    assert.strictEqual(staticResult.types.get("state").watchType, "i32");
}

function comparisonBudgetTests() {
    // One oversized comparison must not starve later, unrelated comparisons.
    const dies = new Map();
    const childrenMap = new Map();
    for (const root of [1, 2]) {
        dies.set(root, { tag: c.DW_TAG_structure_type, name: "Big", byteSize: 4 });
        const kids = [];
        for (let index = 0; index < 20000; index++) {
            const off = root * 100000 + index;
            dies.set(off, { tag: c.DW_TAG_member, name: "m" + index, memberOffset: 0 });
            kids.push(off);
        }
        childrenMap.set(root, kids);
    }
    dies.set(3, { tag: c.DW_TAG_base_type, name: "int", byteSize: 4, encoding: c.DW_ATE_signed });
    dies.set(4, { tag: c.DW_TAG_base_type, name: "int", byteSize: 4, encoding: c.DW_ATE_signed });
    const equivalent = createTypeComparer({ dies, childrenMap });
    assert.strictEqual(equivalent(1, 2), false, "oversized comparison falls back");
    assert.strictEqual(equivalent(3, 4), true, "later comparison has its own budget");
}

function addressTests() {
    const f = fixture(
        [
            [
                base("int"),
                variable("plain", "int"),
                variable("addrExtra", "int", 0, [3, ...fixed(0x20000000), 0x23, 1]),
                variable("index", "int", 0, [0xa1, 0]),
                variable("indexExtra", "int", 0, [0xa1, 0, 0x23, 1]),
                variable("gnu", "int", 0, [0xfb, 0]),
                variable("gnuExtra", "int", 0, [0xfb, 0, 0x23, 1])
            ]
        ],
        { sections: [{ name: ".debug_addr", data: Buffer.from(fixed(0x20001000)) }] }
    );
    const parsed = parseDwarfInternal(f.buffer);
    assert.deepStrictEqual(
        parsed.variables.map((entry) => entry.name),
        ["plain", "index", "gnu"]
    );
    for (const name of ["addrExtra", "indexExtra", "gnuExtra"]) {
        const die = parsed.dies.get(f.offsets.get("var-" + name));
        assert.strictEqual(die.hasAddr, false);
        assert.strictEqual(die.address, undefined);
        assert.strictEqual(die.addressIndex, undefined);
    }
    assert.strictEqual(parsed.variables[1].address, 0x20001000);
}

function companionTests(temp) {
    const compiled = path.join(temp, "compiled"),
        build = path.join(compiled, "build");
    fs.mkdirSync(build, { recursive: true });
    const dwoId = 123456789012345n;
    const companion = fixture([
        node(
            "dwo-cu",
            0x11,
            [attr(0x2131, 7, dwoId)],
            [
                base("int"),
                composite("Packet", "Packet", 4, [member("value", "value", "int", 0)], c.DW_TAG_structure_type),
                variable("packet", "Packet")
            ]
        )
    ]).buffer;
    const name = "build/unit.dwo";
    const skeleton = fixture([
        node("skeleton", 0x11, [attr(0x2130, 8, name), attr(0x1b, 8, compiled), attr(0x2131, 7, dwoId)])
    ]).buffer;
    const file = path.join(build, "app.elf");
    fs.writeFileSync(file, skeleton);
    fs.writeFileSync(path.join(build, "unit.dwo"), companion);
    const result = parseDwarf(skeleton, { filePath: file });
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.layouts.get("packet").members[0].name, "value");
    assert.strictEqual(result.companions[0].path, fs.realpathSync(path.join(build, "unit.dwo")));
    assert(
        readCompanion({ dwoName: name, compDir: path.join(temp, "absent") }, file, 65536).buffer.equals(companion),
        "basename fallback"
    );
    const outside = path.join(temp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "victim.dwo"), companion);
    assert.throws(() => readCompanion({ dwoName: "../victim.dwo" }, file, 65536), /escapes/);
    assert.throws(() => readCompanion({ dwoName: path.join(outside, "victim.dwo") }, file, 65536), /escapes/);
    const missing = assert.throws(
        () => readCompanion({ dwoName: "victim.dwo", compDir: outside }, file, 65536),
        /missing/
    );
    assert.strictEqual(missing, undefined);
    const link = path.join(build, "link");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => readCompanion({ dwoName: "link/victim.dwo", compDir: compiled }, file, 65536), /escapes/);
    assert.throws(() => readCompanion({ dwoName: name, compDir: compiled }, file, 1), {
        code: "DWARF_BUDGET_EXCEEDED"
    });
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

async function runtimeTests(temp) {
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
    const iterator = dies[Symbol.iterator].bind(dies);
    dies[Symbol.iterator] = () => {
        iterations++;
        return iterator();
    };
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
    await assert.rejects(reader.dynamic({ address: 0x20000000, type: poly.root }), /no verified vtable identity/);

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

    const file = path.join(temp, "runtime.elf");
    fs.writeFileSync(file, f.buffer);
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("crypto"),
        elfSymbols: require("../src/elfSymbols"),
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.join(__dirname, "../src/elfWorker.js")
    });
    try {
        const ready = await service.ready();
        const layout = await service.layout("large");
        assert.strictEqual(layout.members.length, 4200, "Worker returns successful static layout");
        assert.strictEqual(layout.runtimeLayout.truncated, true);
        assert.ok(layout.runtimeLayout.types.length <= 4096);
        assert(ready.diagnostics.some((entry) => entry.stage === "runtime-layouts" && entry.symbol === "large"));
        assert.strictEqual((await service.layout("small")).members[0].name, "x");
        assert.strictEqual(ready.symbols.find((symbol) => symbol.name === "small").displayName, "small");
    } finally {
        service.invalidate();
    }
}

(async () => {
    zeroArrayTests();
    declarationTests();
    ambiguityTests();
    comparisonBudgetTests();
    addressTests();
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-audit-")));
    try {
        companionTests(temp);
        await runtimeTests(temp);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log("Audited DWARF array, runtime, cross-CU identity, companion and address regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
