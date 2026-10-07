"use strict";

// Compile-only ARM evidence: no target execution, GDB server or board connection.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseDwarf } = require("../../src/dwarf");
const { parseDwarfInternal } = require("../../src/dwarf/parser");
const { bindVariableSymbols } = require("../../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../../src/dwarf/runtimeTypes");
const { ElfService } = require("../../src/services/elfService");
const { LiveWatchService } = require("../../src/services/liveWatchService");
const { RuntimeObjectReader } = require("../../src/services/runtimeObjectReader");
const { normalizeWatchList } = require("../../src/validation");
const elf = require("../../src/elfSymbols");

const sources = {
    c: `enum State { ERROR=-1, IDLE=0, ACTIVE=3, READY=3 };
        volatile enum State state=ERROR;
        typedef enum State StateAlias; StateAlias alias=ACTIVE;
        struct Packet { enum State state; }; struct Packet packet={ERROR};
        enum State states[2]={ERROR,ACTIVE}; enum State *pointer=&alias;
        int ordinary=ACTIVE; void entry(void) {}`,
    cpp: `namespace app {
        enum class State : signed char { Error=-1, Idle=0, Active=3, Ready=3 };
        volatile State state=State::Error; using StateAlias=State; StateAlias alias=State::Active;
        struct Packet { State state; }; Packet packet={State::Error};
        State states[2]={State::Error,State::Active}; State *pointer=&alias;
        enum class Wide : unsigned long long { Maximum=18446744073709551615ULL };
        Wide wide=Wide::Maximum;
        enum class SignedWide : long long { Minimum=(-9223372036854775807LL-1) };
        SignedWide signedWide=SignedWide::Minimum;
        int ordinary=3; } extern "C" void entry() {}`
};

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-enum-arm-"));
    try {
        for (const language of ["c", "cpp"]) {
            const source = path.join(root, "enum." + language);
            fs.writeFileSync(source, sources[language]);
            for (const version of [2, 4, 5]) {
                for (const short of [false, true]) {
                    const file = path.join(root, `${language}-${version}-${short}.elf`);
                    execFileSync(
                        language === "c"
                            ? process.env.IMAGE_CC || "arm-none-eabi-gcc"
                            : process.env.IMAGE_CXX || "arm-none-eabi-g++",
                        [
                            "-g",
                            `-gdwarf-${version}`,
                            "-gstrict-dwarf",
                            "-O0",
                            "-nostdlib",
                            short ? "-fshort-enums" : "-fno-short-enums",
                            "-Wl,-e,entry",
                            source,
                            "-o",
                            file
                        ],
                        { windowsHide: true }
                    );
                    const buffer = fs.readFileSync(file);
                    const parsed = parseDwarf(buffer);
                    assert.deepStrictEqual(parsed.diagnostics, []);
                    const result = elf.parseElfSymbols(buffer);
                    new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
                        result,
                        parsed.types,
                        parsed.layouts,
                        parsed.displayNames
                    );
                    const symbols = result.symbols;
                    const find = (name) =>
                        symbols.find(
                            (symbol) =>
                                symbol.displayName === (language === "cpp" && version >= 4 ? "app::" : "") + name
                        );
                    const sections = elf.parseElfSections(buffer).sections;
                    const read = async (address, size) => {
                        const section = sections.find(
                            (entry) =>
                                entry.type !== 8 && address >= entry.addr && address + size <= entry.addr + entry.size
                        );
                        assert(section, "read must remain within fixture storage");
                        return buffer.subarray(
                            section.offset + address - section.addr,
                            section.offset + address - section.addr + size
                        );
                    };
                    const service = new LiveWatchService(elf);
                    const watch = normalizeWatchList(
                        symbols.map((symbol) => ({ name: symbol.name })),
                        symbols
                    );
                    const samples = await Promise.all(
                        watch.map(async (item) => ({ name: item.name, bytes: await read(item.address, item.size) }))
                    );
                    const decoded = service.decodeConsumerSamples(
                        samples,
                        1,
                        new Map(watch.filter((item) => !item.isComposite).map((item) => [item.name, item])),
                        new Map(
                            watch
                                .filter((item) => item.isComposite)
                                .map((item) => [item.name, { layout: item.compositeLayout }])
                        )
                    );
                    const state = decoded.scalarSamples.find((sample) => sample.name === find("state").name);
                    assert.strictEqual(state.value, -1);
                    assert(state.enumText.endsWith(language === "cpp" ? "Error(-1)" : "ERROR(-1)"));
                    if (version >= 4 && language === "cpp") assert.strictEqual(state.enumText, ".Error(-1)");
                    assert.strictEqual(find("state").hasDwarfWriteType, version !== 2);
                    const alias = decoded.scalarSamples.find((sample) => sample.name === find("alias").name);
                    assert.strictEqual(alias.value, 3);
                    assert(alias.enumText.includes(" / "));
                    assert.strictEqual(
                        decoded.scalarSamples.find((sample) => sample.name === find("ordinary").name).enumText,
                        undefined
                    );
                    const packet = decoded.compositeSamples.find((sample) => sample.name === find("packet").name);
                    assert.strictEqual(packet.tree.members[0].enumText, state.enumText);
                    const array = decoded.compositeSamples.find((sample) => sample.name === find("states").name);
                    assert.strictEqual(array.tree.elements[0].enumText, state.enumText);
                    const pointer = find("pointer");
                    const internal = bindVariableSymbols(parseDwarfInternal(buffer), symbols);
                    const graph = createRuntimeLayoutResolver(internal, symbols)(pointer.name);
                    const reader = new RuntimeObjectReader(
                        {
                            address: pointer.address,
                            runtimeLayout: graph,
                            runtimeSegments: [{ kind: "dereference" }],
                            runtimeRanges: sections
                                .filter((section) => section.flags & 2)
                                .map((section) => ({ start: section.addr, end: section.addr + section.size }))
                        },
                        read
                    );
                    const tree = await reader.sample();
                    assert.strictEqual(tree.value, 3);
                    assert.strictEqual(tree.enumText, alias.enumText);
                    if (language === "cpp") {
                        const wide = decoded.scalarSamples.find((sample) => sample.name === find("wide").name);
                        assert.strictEqual(wide.valueText, "18446744073709551615");
                        assert(wide.enumText.endsWith("Maximum(18446744073709551615)"));
                        const minimum = decoded.scalarSamples.find((sample) => sample.name === find("signedWide").name);
                        assert.strictEqual(minimum.valueText, "-9223372036854775808");
                        assert(minimum.enumText.endsWith("Minimum(-9223372036854775808)"));
                    }
                    console.log(`PASS ARM ${language} enums DWARF ${version}, ${short ? "short" : "normal"} storage`);
                }
            }
        }
    } finally {
        for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name));
        fs.rmdirSync(root);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
