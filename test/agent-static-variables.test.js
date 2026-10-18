"use strict";

// Issue #38: Agent reads of mangled C++ statics/namespace objects by display name, per-variable
// failures inside a batch, and .bss statics emitted as NOTYPE LOCAL symbols.
// Fixture source and regeneration: test/gdb/cpp-static-objects.test.js --fixtures.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const elf = require("../src/elfSymbols");
const { loadProvider } = require("./helpers/load-provider");
const { createWorkerElfService } = require("./helpers/elf-service");
const { variableErrorDiagnostics } = require("../skills/_emberprobe/agent-client");
const { withVariableErrors, parseSymbolsBuffer } = require("../skills/mcu-variables/scripts/read");
const fixture = require("./fixtures/cpp-static-objects.json");

const buffer = zlib.inflateSync(Buffer.from(fixture.elf, "base64"));

// Untyped .bss statics are visible; mapping symbols and linker markers are not.
for (const names of [
    elf.parseElfSymbols(buffer).symbols.map((symbol) => symbol.name),
    parseSymbolsBuffer(buffer).map((symbol) => symbol.name)
]) {
    for (const name of ["_ZL3ep7", "_ZN3app6objectE", "_ZL6s_anon", "counter", "c_plain"])
        assert(names.includes(name), `${name} must be listed: ${names.join(",")}`);
    assert(!names.some((name) => name.startsWith("$") || name.startsWith("__bss") || name === "_end"), names.join());
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-static-variables-"));
    const file = path.join(root, "objects.elf");
    fs.writeFileSync(file, buffer);
    const service = createWorkerElfService(file);
    try {
        const result = await service.ready();
        const symbol = (name) => result.symbols.find((item) => item.name === name);
        assert.strictEqual(symbol("_ZL3ep7").displayName, "ep7");
        assert.strictEqual(symbol("_ZN3app6objectE").displayName, "app::object");
        assert.strictEqual(symbol("_ZL6s_anon").displayName, "s_anon", "DWARF binds the NOTYPE static by address");
        assert.strictEqual(symbol("_ZL6s_anon").isComposite, true);
        assert.strictEqual(symbol("c_plain").watchType, "u32");
        assert(!symbol("_ZL3ep7").compositeLayout, "layouts are fetched on demand");

        const sections = elf.parseElfSections(buffer).sections;
        const reads = [];
        const memoryAt = (address, size) => {
            const data = sections.find(
                (section) => section.type === 1 && address >= section.addr && address < section.addr + section.size
            );
            return data
                ? buffer.subarray(data.offset + address - data.addr, data.offset + address - data.addr + size)
                : Buffer.alloc(size);
        };
        const provider = Object.create(loadProvider().prototype);
        provider._elfService = service;
        provider._withAgentProbe = (handler) =>
            handler({
                source: "test-probe",
                temporary: false,
                session: {
                    readOnce: async (items) => {
                        reads.push(items.map((item) => item.name));
                        return items.map((item) => ({
                            name: item.name,
                            bytes: memoryAt(item.address, item.size),
                            t: 1
                        }));
                    }
                }
            });
        const read = (variables) => provider._readAgentVariables({ variables });

        // Display names resolve to the same symbol in layout prefetch and planning.
        const named = await read(["ep7", "ep7.port", "app::object.id", "s_anon.y"]);
        assert.strictEqual(named.partial, undefined);
        assert.strictEqual(named.variableErrors, undefined);
        assert.strictEqual(named.values.ep7.type, "composite");
        assert.deepStrictEqual(
            named.values.ep7.tree.members.map((member) => [member.name, member.value]),
            [
                ["id", 7],
                ["port", 80],
                ["up", 1]
            ]
        );
        assert.strictEqual(named.values["ep7.port"].value, 80);
        assert.strictEqual(named.values["app::object.id"].value, 9);
        assert.strictEqual(named.values["s_anon.y"].value, 0);
        assert(symbol("_ZL3ep7").compositeLayout, "the raw ELF symbol receives the layout");
        assert.deepStrictEqual(
            reads.at(-1).sort(),
            ["_ZL3ep7", "_ZL6s_anon", "_ZN3app6objectE"],
            "reads use raw ELF names"
        );

        // One failing variable no longer fails the batch.
        const partial = await read(["ep7.port", "does_not_exist", "counter", "counter.bad", "c_plain"]);
        assert.strictEqual(partial.partial, true);
        assert.strictEqual(partial.values["ep7.port"].value, 80);
        assert.strictEqual(partial.values.counter.value, 5);
        assert.strictEqual(partial.values.c_plain.value, 0);
        assert.deepStrictEqual(
            partial.variableErrors.map((entry) => [entry.requestedName, entry.error.code]),
            [
                ["does_not_exist", "VARIABLE_NOT_FOUND"],
                ["counter.bad", "INVALID_VARIABLE_PATH"]
            ]
        );
        const duplicate = await read(["counter", "counter", "nope"]);
        assert.deepStrictEqual(Object.keys(duplicate.values), ["counter"]);
        assert.deepStrictEqual(
            duplicate.variableErrors.map((entry) => [entry.requestedName, entry.error.code]),
            [
                ["counter", "DUPLICATE_VARIABLE"],
                ["nope", "VARIABLE_NOT_FOUND"]
            ]
        );
        const sampled = await provider._sampleAgentVariables({
            variables: ["counter", "nope"],
            count: 2,
            intervalMs: 5
        });
        assert.strictEqual(sampled.samples.length, 2);
        assert.deepStrictEqual(
            sampled.variableErrors.map((entry) => entry.requestedName),
            ["nope"]
        );

        // All-failing requests keep the previous error codes.
        await assert.rejects(read(["nope"]), (error) => error.code === "VARIABLE_NOT_FOUND" && !error.details);
        await assert.rejects(
            read(["nope", "counter.bad"]),
            (error) =>
                error.code === "VARIABLE_NOT_FOUND" &&
                error.details.variableErrors.map((entry) => entry.error.code).join() ===
                    "VARIABLE_NOT_FOUND,INVALID_VARIABLE_PATH"
        );

        // A layout failure is reported for its own variable with its original code.
        const object = symbol("_ZN3app6objectE");
        const savedLayout = object.compositeLayout;
        const layout = service.layout.bind(service);
        object.compositeLayout = null;
        service.layout = async (name) => {
            if (name === "_ZN3app6objectE")
                throw Object.assign(new Error("DWARF layout budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
            return layout(name);
        };
        const layoutFailure = await read(["app::object.id", "ep7.id"]);
        assert.strictEqual(layoutFailure.values["ep7.id"].value, 7);
        assert.deepStrictEqual(layoutFailure.variableErrors, [
            {
                requestedName: "app::object.id",
                error: { code: "DWARF_BUDGET_EXCEEDED", message: "DWARF layout budget exceeded" }
            }
        ]);
        // Without a collector (watch/write paths) the layout error still aborts the request.
        await assert.rejects(provider._prepareRequestedLayouts(["app::object"]), { code: "DWARF_BUDGET_EXCEEDED" });
        service.layout = layout;
        object.compositeLayout = savedLayout;

        // Skill output enriches each failed variable with the shared diagnostic fields.
        assert.strictEqual(withVariableErrors(named, "variables.read"), named);
        const enriched = withVariableErrors(partial, "variables.read");
        assert.strictEqual(enriched.partial, true);
        assert.strictEqual(enriched.values.counter.value, 5);
        assert.deepStrictEqual(
            enriched.variableErrors.map((entry) => [entry.requestedName, entry.code, entry.category]),
            [
                ["does_not_exist", "VARIABLE_NOT_FOUND", "variable_resolution"],
                ["counter.bad", "INVALID_VARIABLE_PATH", "variable_resolution"]
            ]
        );
        assert(enriched.variableErrors.every((entry) => entry.suggestedActions.length && entry.likelyCause));
        assert.deepStrictEqual(variableErrorDiagnostics({}), []);
        console.log("agent static variables ok");
    } finally {
        service.invalidate();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
