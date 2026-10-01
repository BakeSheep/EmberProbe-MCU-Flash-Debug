"use strict";

const assert = require("assert");
const { SymbolDirectory, relocatedAddress } = require("../src/debug/symbolDirectory");

(async () => {
    const primary = "C:/images/primary.elf",
        secondary = "C:/images/secondary.elf";
    const sourceA = "C:/source/a.cpp",
        sourceB = "C:/source/b.cpp";
    const calls = [];
    const catalog = {
        symbols: {
            debug: [
                {
                    fullname: sourceA,
                    symbols: [
                        { name: "duplicate", type: "int" },
                        { name: "sameFile", type: "int" },
                        { name: "staticValue", type: "int", description: "static int staticValue;" }
                    ]
                },
                { fullname: sourceB, symbols: [{ name: "duplicate", type: "long" }] }
            ]
        }
    };
    const adapter = {
        config: { executable: primary, symbolFiles: [{ file: primary }, { file: secondary }], nmPath: "nm" },
        mi: { command: async (command) => (command === "-symbol-info-variables" ? catalog : { value: "536870912" }) },
        variableDiagnostic: () => {}
    };
    const directory = new SymbolDirectory(adapter, async (file, args, options) => {
        assert.strictEqual(file, "nm");
        assert(options.timeout <= 10000 && options.windowsHide);
        calls.push(args.at(-1));
        return {
            stdout: `20000000 00000004 D duplicate\t${args.at(-1) === primary ? sourceA : sourceB}:4\n20000004 00000004 D sameFile\t${sourceA}:5\n20000008 00000004 d staticValue\t${sourceA}:6\n2000000c 00000004 D compilerGuard\t${sourceA}:7\n`
        };
    });
    const globals = await directory.variables("globals");
    assert.strictEqual(globals.length, 4, "nm augments image identity, not the GDB-visible variable set");
    const duplicate = globals.filter((entry) => entry.name.startsWith("duplicate"));
    assert(duplicate.every((entry) => entry.expression.startsWith("'C:/source/")));
    assert.deepStrictEqual(
        duplicate.map((entry) => entry.type),
        ["int", "long"]
    );
    assert(duplicate.every((entry) => entry.name.includes(entry.image)));
    assert(globals.filter((entry) => entry.name.startsWith("sameFile")).every((entry) => entry.expression === null));
    const statics = await directory.variables("statics", sourceA);
    assert.strictEqual(statics.length, 2);
    assert(statics.every((entry) => entry.expression === null && entry.name.includes(entry.image)));
    await directory.load();
    assert.deepStrictEqual(calls, [primary, secondary]);
    directory.reset();
    await directory.load();
    assert.strictEqual(calls.length, 4);

    const missingTool = new SymbolDirectory({ ...adapter, config: { ...adapter.config, nmPath: undefined } });
    await assert.rejects(missingTool.load(), /matching nm/);
    const empty = new SymbolDirectory({
        config: { symbolFiles: [] },
        mi: {
            command: () => {
                throw new Error("must not run");
            }
        }
    });
    assert.deepStrictEqual(await empty.load(), []);
    adapter.mi.command = async (command) => {
        if (command === "-symbol-info-variables") throw new Error("Undefined MI command");
        return { value: "536870912" };
    };
    directory.reset();
    assert.strictEqual((await directory.load()).length, 8, "old GDB fallback retains both image identities");
    adapter.mi.command = async () => {
        throw new Error("transport closed");
    };
    directory.reset();
    const before = calls.length;
    await assert.rejects(directory.load(), /transport closed/);
    assert.strictEqual(calls.length, before);
    adapter.config.symbolFiles[1].offset = "0x10000";
    adapter.mi.command = async (command) =>
        command === "-symbol-info-variables" ? catalog : { value: command.includes("sizeof") ? "4" : "536870912" };
    directory.reset();
    const relocated = (await directory.variables("globals")).filter((entry) => entry.name.startsWith("duplicate"));
    assert.strictEqual(
        relocated[1].expression,
        "*(long *)0x20010000",
        "a wrong file-qualified lookup falls back only to a size-checked builtin type"
    );
    catalog.symbols.debug[1].symbols[0].type = "Complex";
    directory.reset();
    assert.strictEqual(
        (await directory.variables("globals")).filter((entry) => entry.name.startsWith("duplicate"))[1].expression,
        null
    );
    adapter.mi.command = async (command) => {
        if (command === "-symbol-info-variables") return catalog;
        throw new Error("transport closed");
    };
    directory.reset();
    await assert.rejects(directory.load(), /transport closed/);
    assert.strictEqual(directory.entries, null, "failed identity verification cannot cache a partially safe directory");
    const sections = [
        { name: ".data", addr: 0x20000000, size: 32, flags: 2 },
        { name: ".text", addr: 0x8000000, size: 16, flags: 6 }
    ];
    assert.strictEqual(
        relocatedAddress(
            { address: "0x20000004" },
            { offset: "0x1000", sections: [{ name: ".data", address: "0x20010000" }] },
            sections
        ),
        "0x20010004"
    );
    assert.strictEqual(relocatedAddress({ address: "0x8000004" }, { textaddress: "0x8010000" }, sections), "0x8010004");
    assert.strictEqual(relocatedAddress({ address: "0x20000004" }, { offset: "-0x1000" }, null), "0x1ffff004");
    assert.strictEqual(relocatedAddress({ address: "0" }, { offset: "-0x1000" }, null), null);
    assert.strictEqual(relocatedAddress({ address: "0x20000040" }, {}, sections), null);
    console.log("Per-image typed symbol catalogs, qualified globals and ambiguous source identities passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
