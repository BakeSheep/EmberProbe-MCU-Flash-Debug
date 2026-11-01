"use strict";
// DWARF parsing: DWARF 4/5 forms and location expressions, verified split-DWARF companions, skipped function
// locals with static locals and retained references kept, and form validation.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const fixtures = require("./fixtures/dwarf-formats.json");
const { parseDwarf } = require("../src/dwarf");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const c = require("../src/dwarf/constants");
const {
    buildVariableTypes,
    buildCompositeLayouts,
    buildDisplayNames,
    bindVariableSymbols
} = require("../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const { scenario } = require("./helpers/scenario");
const { buildDwarfElf, buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
const { cstr: string, u32, uleb } = require("./helpers/dwarf-tree");

// DWARF 4/5 forms, verified companions and type-loss guards
async function forms() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-formats-"));
    try {
        for (const [key, fixture] of Object.entries(fixtures)) {
            const buffer = zlib.inflateSync(Buffer.from(fixture.elf, "base64"));
            const filePath = path.join(root, key + ".elf");
            fs.writeFileSync(filePath, buffer);
            for (const [name, bytes] of Object.entries(fixture.companions))
                fs.writeFileSync(path.join(root, name), zlib.inflateSync(Buffer.from(bytes, "base64")));
            const parsed = parseDwarf(buffer, { filePath });
            assert.deepStrictEqual(parsed.diagnostics, [], key);
            assert.strictEqual(parsed.types.get("packet").kind, "struct", key);
            assert.deepStrictEqual(
                parsed.layouts.get("packet").members.map((field) => field.name),
                ["value", "ready"]
            );
            assert.strictEqual(parsed.layouts.get("_ZN3app6objectE").byteSize, 8);
            if (!key.includes("split")) continue;
            const names = Object.keys(fixture.companions);
            assert(names.length > 0, "split fixture includes its companion");
            for (const name of names) fs.unlinkSync(path.join(root, name));
            const missing = parseDwarf(buffer, { filePath });
            assert(missing.diagnostics.some((item) => item.code === "DWARF_COMPANION_MISSING"));
            const result = elf.parseElfSymbols(buffer);
            result.typeMetadataIncomplete = true;
            new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(result, missing.types, missing.layouts);
            const packet = result.symbols.find((symbol) => symbol.name === "packet");
            assert(packet.isComposite, "unknown objects must not become guessed integers");
            assert.strictEqual(packet.watchType, "");
            assert.strictEqual(packet.hasDwarfWriteType, false);
            const companion = zlib.inflateSync(Buffer.from(fixture.companions[names[0]], "base64"));
            const internal = parseDwarfInternal(companion);
            const identity = [...internal.dies.values()].find((die) => die.unit.dwoId)?.unit.dwoId;
            assert(identity);
            const original = Buffer.alloc(8),
                replacement = Buffer.alloc(8);
            original.writeBigUInt64LE(BigInt(identity));
            replacement.writeBigUInt64LE(BigInt(identity) ^ 1n);
            const position = companion.indexOf(original);
            assert(position >= 0);
            replacement.copy(companion, position);
            fs.writeFileSync(path.join(root, names[0]), companion);
            const mismatched = parseDwarf(buffer, { filePath });
            assert(mismatched.diagnostics.some((item) => item.code === "DWARF_COMPANION_MISMATCH"));
            assert(!mismatched.layouts.has("packet"));
            fs.writeFileSync(path.join(root, names[0]), Buffer.from("invalid ELF"));
            const malformed = parseDwarf(buffer, { filePath });
            assert(malformed.diagnostics.some((item) => item.code === "DWARF_INVALID_ELF"));
            fs.unlinkSync(path.join(root, names[0]));
        }
    } finally {
        for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
        fs.rmdirSync(root);
    }

    scenario("Reject truncated, unterminated and recursively indirect forms", () => {
        const { createFormReader } = require("../src/dwarf/forms");
        const reader = createFormReader({ buf: Buffer.from([10, 3, 0]), str: null, lineStr: null });
        assert.throws(() => reader({ p: 0 }, 0x09, {}), /Truncated/);
        assert.throws(
            () => createFormReader({ buf: Buffer.from("name"), str: null, lineStr: null })({ p: 0 }, 0x08, {}),
            /Unterminated/
        );
        const indirect = createFormReader({ buf: Buffer.alloc(100, 0x16), str: null, lineStr: null });
        assert.throws(() => indirect({ p: 0 }, 0x16, {}), /nesting/);
    });

    scenario("Verify absolute location expressions and companion path containment", () => {
        const c = require("../src/dwarf/constants");
        const { readCompanion } = require("../src/dwarf/files");
        const { attr, base, composite, fixed, fixture, member, node, variable } = require("./helpers/dwarf-tree");
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
            // A companion over the shared file budget stops the parse but keeps the skeleton unit.
            const limited = parseDwarf(skeleton, { filePath: file, budgets: { companionBytes: 1 } });
            assert.strictEqual(limited.diagnostics[0].code, "DWARF_PARTIAL");
            assert.deepStrictEqual(limited.diagnostics[0].i18nParams, { loaded: 1, total: 1, budget: "companion" });
            assert.strictEqual(limited.layouts.has("packet"), false, "the companion over budget is never read");
            assert.deepStrictEqual(limited.companions, []);
            assert(
                readCompanion({ dwoName: name, compDir: path.join(temp, "absent") }, file, 65536).buffer.equals(
                    companion
                ),
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
            assert.throws(
                () => readCompanion({ dwoName: "link/victim.dwo", compDir: compiled }, file, 65536),
                /escapes/
            );
            assert.throws(() => readCompanion({ dwoName: name, compDir: compiled }, file, 1), {
                code: "DWARF_BUDGET_EXCEEDED"
            });
        }
        scenario("Reject trailing address expression operations", addressTests);
        const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-companions-")));
        try {
            scenario("Resolve and contain split DWARF companion files", () => companionTests(temp));
        } finally {
            fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });

    console.log("DWARF4/5 formats, verified companions and type-loss guards passed");
}

// Local skipping, static locals, retained references, form validation and global budgets
async function skipLocals() {
    const ref = (target) => ({ target });
    const address = (value) => [5, 0x03, ...u32(value)];
    const stackLocation = [2, 0x91, 0];

    const declarations = [
        [1, 0x11, 1],
        [2, 0x24, 0, [0x03, 0x08], [0x3e, 0x0b], [0x0b, 0x0b]],
        [3, 0x39, 1, [0x03, 0x08]],
        [4, 0x2e, 1, [0x03, 0x08], [0x6e, 0x08]],
        [5, 0x05, 0, [0x03, 0x08], [0x49, 0x13], [0x02, 0x18]],
        [6, 0x0b, 1],
        [7, 0x13, 1, [0x03, 0x08], [0x0b, 0x0b]],
        [8, 0x0d, 0, [0x03, 0x08], [0x49, 0x13], [0x38, 0x0b]],
        [9, 0x34, 0, [0x03, 0x08], [0x49, 0x13], [0x02, 0x18]],
        [10, 0x1d, 1, [0x31, 0x13]],
        [11, 0x0a, 0, [0x03, 0x08]],
        [12, 0x48, 1, [0x31, 0x13]],
        [13, 0x49, 0, [0x49, 0x13], [0x02, 0x18]],
        [14, 0x18, 0],
        [15, 0x0f, 0, [0x49, 0x13]],
        [16, 0x13, 0, [0x03, 0x08], [0x3c, 0x19]],
        [17, 0x34, 0, [0x31, 0x13], [0x02, 0x18]],
        [18, 0x34, 0, [0x03, 0x08], [0x49, 0x13]],
        [19, 0x05, 0, [0x03, 0x08], [0x49, 0x13], [0x31, 0x13]],
        [20, 0x05, 0, [0x31, 0x13]],
        [21, 0x34, 0, [0x03, 0x08], [0x47, 0x13], [0x02, 0x18]],
        [22, 0x15, 1, [0x49, 0x13]],
        [23, 0x2f, 0, [0x49, 0x13]],
        [24, 0x4109, 1],
        [25, 0x410a, 0],
        [26, 0x05, 0, [0x03, 0x08], [0x49, 0x13], [0x02, 0x16]],
        [27, 0x34, 0, [0x31, 0x10], [0x02, 0x18]]
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

    function createUnit() {
        const bytes = [...u32(0), 4, 0, ...u32(0), 4];
        const offsets = new Map();
        const fixups = [];
        return {
            offsets,
            die(label, code, ...attributes) {
                offsets.set(label, bytes.length);
                bytes.push(...uleb(code));
                for (const attr of attributes) {
                    if (attr.target) {
                        fixups.push({ position: bytes.length, target: attr.target });
                        bytes.push(...u32(0));
                    } else bytes.push(...attr);
                }
            },
            end() {
                bytes.push(0);
            },
            finish(external = new Map()) {
                const buffer = Buffer.from(bytes);
                buffer.writeUInt32LE(bytes.length - 4);
                for (const { position, target } of fixups) {
                    const offset = external.get(target) ?? offsets.get(target);
                    assert.notStrictEqual(offset, undefined, target);
                    buffer.writeUInt32LE(offset, position);
                }
                return buffer;
            }
        };
    }

    // Static locals and local type definitions survive nested lexical/inline scopes. Every
    // direct child of a type remains, including otherwise unused rows counted by layout budgets.
    {
        const unit = createUnit();
        unit.die("cu", 1);
        unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
        unit.die("pointer", 15, ref("int"));
        unit.die("namespace", 3, string("app"));
        unit.die("function", 4, string("work"), string("_ZN3app4workEv"));
        unit.die("parameter", 26, string("argument"), ref("int"), [0x18, ...stackLocation]);
        unit.die("lexical", 6);
        unit.die("declaration", 16, string("Local"));
        unit.die("struct", 7, string("Local"), [8]);
        unit.die("value", 8, string("value"), ref("int"), [0]);
        unit.die("next", 8, string("next"), ref("pointer"), [4]);
        unit.die("typeParameter", 5, string("unusedTypeChild"), ref("int"), stackLocation);
        unit.die("templateParameter", 23, ref("int"));
        unit.end();
        unit.die("static", 9, string("staticLocal"), ref("declaration"), address(0x20000000));
        unit.die("automatic", 9, string("automatic"), ref("struct"), stackLocation);
        unit.die("inline", 10, ref("function"));
        unit.die("inlineParameter", 5, string("inlineArgument"), ref("int"), stackLocation);
        unit.die("emptyLexical", 6);
        unit.die("inlineAutomatic", 9, string("temporary"), ref("struct"), stackLocation);
        unit.end();
        unit.die("label", 11, string("label"));
        unit.die("callSite", 12, ref("function"));
        unit.die("callParameter", 13, ref("int"), stackLocation);
        unit.end();
        unit.die("gnuCallSite", 24);
        unit.die("gnuCallParameter", 25);
        unit.end();
        unit.die("unspecified", 14);
        unit.end();
        unit.die("keptInline", 10, ref("function"));
        unit.die("keptLexical", 6);
        unit.die("nestedStatic", 9, string("nestedStatic"), ref("struct"), address(0x20000008));
        unit.end();
        unit.end();
        unit.die("subroutineType", 22, ref("int"));
        unit.die("signatureParameter", 5, string("signatureArgument"), ref("int"), stackLocation);
        unit.end();
        unit.end();
        unit.end();
        unit.end();
        unit.end();

        const parsed = parseDwarfInternal(buildDwarfElf(unit.finish(), abbrev));
        const offset = (name) => unit.offsets.get(name);
        assert.deepStrictEqual(parsed.diagnostics, []);
        assert.deepStrictEqual(
            parsed.variables.map((variable) => variable.name),
            ["staticLocal", "nestedStatic"]
        );
        for (const name of [
            "parameter",
            "automatic",
            "inline",
            "inlineParameter",
            "emptyLexical",
            "inlineAutomatic",
            "label",
            "callSite",
            "callParameter",
            "gnuCallSite",
            "gnuCallParameter",
            "unspecified"
        ]) {
            assert(!parsed.dies.has(offset(name)), name + " must allocate no DIE record");
            assert(!parsed.parentOf.has(offset(name)), name + " must allocate no parent entry");
            assert(!parsed.childrenMap.has(offset(name)), name + " must allocate no child list");
            assert(![...parsed.childrenMap.values()].some((children) => children.includes(offset(name))), name);
        }
        assert.strictEqual(parsed.parentOf.get(offset("static")), offset("lexical"));
        assert.strictEqual(parsed.parentOf.get(offset("lexical")), offset("function"));
        assert.strictEqual(parsed.parentOf.get(offset("nestedStatic")), offset("keptLexical"));
        assert.strictEqual(parsed.parentOf.get(offset("keptLexical")), offset("keptInline"));
        assert(parsed.dies.has(offset("typeParameter")), "type child counts must remain unchanged");
        assert(parsed.dies.has(offset("signatureParameter")), "subroutine type children must remain");
        const localType = parsed.dies.get(offset("struct"));
        assert(localType.cuLocalType);
        assert.strictEqual(
            localType.localTypeScope,
            [offset("function"), offset("lexical")].sort((a, b) => a - b).join(",")
        );
        assert.strictEqual(
            parsed.variables[0].typeRef,
            offset("struct"),
            "local declaration resolves in its lexical scope"
        );
        assert.strictEqual(buildVariableTypes(parsed).get("staticLocal").typeName, "struct app::Local");
        const layout = buildCompositeLayouts(parsed).get("staticLocal");
        assert.strictEqual(layout.byteSize, 8);
        assert.deepStrictEqual(
            layout.members.map((member) => member.name),
            ["value", "next"]
        );
        assert(createRuntimeLayoutResolver(parsed)("staticLocal"), "local pointer fields retain runtime layouts");
        assert.strictEqual(buildDisplayNames(parsed).get("_ZN3app4workEv"), "app::work");
        assert.strictEqual(buildDisplayNames(parsed).get("staticLocal"), "app::staticLocal");
        const bound = bindVariableSymbols(parsed, [{ name: "staticLocal.2", address: 0x20000000 }]);
        assert.strictEqual(bound.variables[0].linkageName, "staticLocal.2");
    }

    // Keep all reference targets, even unusual formal-parameter type/origin/specification
    // targets, backwards references, and cycles. A retry is bounded to one full-retention pass.
    {
        const unit = createUnit();
        unit.die("cu", 1);
        unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
        unit.die("function", 4, string("work"), string("work"));
        unit.die("lexical", 6);
        unit.die("origin", 19, string("origin"), ref("int"), ref("cycle"));
        unit.die("cycle", 20, ref("origin"));
        unit.die("abstractLocal", 18, string("staticIdentity"), ref("int"));
        unit.end();
        unit.end();
        unit.die("fromOrigin", 17, ref("origin"), address(0x20000000));
        unit.die("fromSpecification", 21, string("fromSpecification"), ref("origin"), address(0x20000004));
        unit.die("fromType", 9, string("fromType"), ref("origin"), address(0x20000008));
        unit.die("fromAbstractLocal", 17, ref("abstractLocal"), address(0x2000000c));
        unit.end();
        const parsed = parseDwarfInternal(buildDwarfElf(unit.finish(), abbrev));
        assert.deepStrictEqual(parsed.diagnostics, []);
        for (const name of ["origin", "cycle", "abstractLocal", "lexical"])
            assert(parsed.dies.has(unit.offsets.get(name)), "retained reference chain: " + name);
        assert.strictEqual(parsed.variables[0].name, "origin");
        assert.strictEqual(buildVariableTypes(parsed).get("origin").watchType, "i32");
        assert.strictEqual(buildVariableTypes(parsed).get("fromSpecification").watchType, "i32");
        assert.strictEqual(buildVariableTypes(parsed).get("staticIdentity").watchType, "i32");
        assert.strictEqual(parsed.variables[2].typeRef, unit.offsets.get("origin"));
    }

    // A forward DW_FORM_ref_addr may target a skipped local in a later CU.
    {
        const first = createUnit();
        first.die("cu", 1);
        first.die("variable", 27, ref("externalOrigin"), address(0x20000000));
        first.end();
        const second = createUnit();
        second.die("cu", 1);
        second.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
        second.die("namespace", 3, string("later"));
        second.die("function", 4, string("work"), string("laterWork"));
        second.die("origin", 5, string("laterStatic"), ref("int"), stackLocation);
        second.end();
        second.end();
        second.end();
        const target = first.finish(new Map([["externalOrigin", 0]])).length + second.offsets.get("origin");
        const info = Buffer.concat([first.finish(new Map([["externalOrigin", target]])), second.finish()]);
        const parsed = parseDwarfInternal(buildDwarfElf(info, abbrev));
        assert.deepStrictEqual(parsed.diagnostics, []);
        assert(parsed.dies.has(target));
        assert.strictEqual(parsed.variables[0].qualifiedName, "later::laterStatic");
        assert.strictEqual(buildVariableTypes(parsed).get("laterStatic").watchType, "i32");
    }

    // A reference fallback in split DWARF reuses verified companions and rebinds their
    // parent unit. Indexed static addresses and CU identity checks retain the same semantics.
    {
        const splitAbbrev = Buffer.concat([
            abbrev.subarray(0, -1),
            Buffer.from([
                28,
                0x11,
                1,
                ...uleb(0x2131),
                0x07,
                ...uleb(0x2130),
                0x08,
                0x73,
                0x06,
                0,
                0,
                29,
                0x11,
                1,
                ...uleb(0x2131),
                0x07,
                0,
                0,
                0
            ])
        ]);
        const id = [...u32(1), ...u32(0)];
        const skeleton = createUnit();
        skeleton.die("cu", 28, id, string("locals.dwo"), u32(4));
        skeleton.end();
        const companion = createUnit();
        companion.die("cu", 29, id);
        companion.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
        companion.die("function", 4, string("work"), string("work"));
        companion.die("origin", 5, string("indexedStatic"), ref("int"), stackLocation);
        companion.end();
        companion.die("variable", 17, ref("origin"), [2, 0xa1, 0]);
        companion.end();
        const buffer = buildElf32({
            sections: [
                ...buildDebugSections({ info: skeleton.finish(), abbrev: splitAbbrev, compress: true }),
                { name: ".debug_addr", data: Buffer.from([...u32(0), ...u32(0x20000000)]) }
            ]
        });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-skip-"));
        const filePath = path.join(directory, "locals.elf");
        const companionPath = path.join(directory, "locals.dwo");
        try {
            fs.writeFileSync(filePath, buffer);
            fs.writeFileSync(companionPath, buildDwarfElf(companion.finish(), splitAbbrev, { compress: true }));
            const parsed = parseDwarfInternal(buffer, { filePath });
            assert.deepStrictEqual(parsed.diagnostics, []);
            assert.strictEqual(parsed.companions.length, 1);
            assert.strictEqual(parsed.variables[0].address, 0x20000000);
            assert.strictEqual(buildVariableTypes(parsed).get("indexedStatic").watchType, "i32");
            assert.strictEqual(parsed.variables[0].unit.input.parent, parsed.dies.get(skeleton.offsets.get("cu")).unit);
        } finally {
            fs.unlinkSync(companionPath);
            fs.unlinkSync(filePath);
            fs.rmdirSync(directory);
        }
    }

    // Attribute validation remains active on skipped DIEs; unsupported forms still
    // diagnose the CU, and a later healthy CU retains its static variable.
    {
        const brokenAbbrev = Buffer.concat([abbrev.subarray(0, -1), Buffer.from([28, 0x05, 0, 0x02, 0x7f, 0, 0, 0])]);
        const broken = createUnit();
        broken.die("cu", 1);
        broken.die("function", 4, string("broken"), string("broken"));
        broken.die("parameter", 28);
        const healthy = createUnit();
        healthy.die("cu", 1);
        healthy.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
        healthy.die("variable", 9, string("healthy"), ref("int"), address(0x20000000));
        healthy.end();
        const parsed = parseDwarfInternal(
            buildDwarfElf(Buffer.concat([broken.finish(), healthy.finish()]), brokenAbbrev)
        );
        assert(parsed.diagnostics.some((diagnostic) => diagnostic.code === "DWARF_UNSUPPORTED"));
        assert.strictEqual(buildVariableTypes(parsed).get("healthy").watchType, "i32");
    }

    // A malformed retained type child still reserves its row in traversal budgets.
    {
        const invalidAbbrev = Buffer.concat([abbrev.subarray(0, -1), Buffer.from([28, 0x0d, 0, 0x38, 0x7f, 0, 0, 0])]);
        const unit = createUnit();
        unit.die("cu", 1);
        unit.die("struct", 7, string("Broken"), [4]);
        unit.die("member", 28);
        const parsed = parseDwarfInternal(buildDwarfElf(unit.finish(), invalidAbbrev));
        assert(parsed.diagnostics.some((diagnostic) => diagnostic.code === "DWARF_UNSUPPORTED"));
        assert.deepStrictEqual(parsed.childrenMap.get(unit.offsets.get("struct")), [unit.offsets.get("member")]);
        assert.strictEqual(parsed.parentOf.get(unit.offsets.get("member")), unit.offsets.get("struct"));
    }

    // Skipped DIEs still count toward the global budget across compilation units.
    {
        const count = 1050000;
        const units = [];
        for (let index = 0; index < 2; index++) {
            const unit = Buffer.alloc(11 + 2 + count + 2);
            unit.writeUInt32LE(unit.length - 4);
            unit.writeUInt16LE(4, 4);
            unit[10] = 4;
            unit[11] = 1;
            unit[12] = 2;
            unit.fill(3, 13, 13 + count);
            units.push(unit);
        }
        const budgetAbbrev = Buffer.from([1, 0x11, 1, 0, 0, 2, 0x2e, 1, 0, 0, 3, 0x05, 0, 0, 0, 0]);
        const parsed = parseDwarfInternal(buildDwarfElf(Buffer.concat(units), budgetAbbrev));
        assert.deepStrictEqual(parsed.partial, {
            budget: "DIE",
            loadedUnits: 1,
            droppedUnits: 1,
            droppedBytes: units[1].length
        });
        assert.ok(
            [...parsed.dies.keys()].every((offset) => offset < units[0].length),
            "skipped DIEs still exhaust the budget and the second unit is rolled back"
        );
    }

    console.log("DWARF local skipping, static locals, retained references, form validation and global budgets passed");
}

(async () => {
    await scenario("DWARF 4/5 forms, verified companions and type-loss guards", forms);
    await scenario(
        "Local skipping, static locals, retained references, form validation and global budgets",
        skipLocals
    );
    console.log("DWARF form, companion and local-skipping parse tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
