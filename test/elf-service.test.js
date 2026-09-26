"use strict";
const fs = require("fs");

const assert = require("assert");
const { ElfService } = require("../src/services/elfService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        let dwarfParses = 0;
        const elfService = new ElfService({
            context: { workspaceState: { get: () => elf } },
            cacheKey: "elf",
            fs,
            crypto: require("crypto"),
            cleanPath: (value) => value,
            t: (key) => key,
            elfSymbols: {
                parseElfSymbols: () => ({ symbols: [{ name: "counter", size: 4 }], warnings: [] }),
                defaultType: () => "u32"
            },
            dwarf: {
                parseDwarf: () => {
                    dwarfParses++;
                    return {
                        types: new Map([["counter", { typeName: "unsigned int", watchType: "u32" }]]),
                        layouts: new Map()
                    };
                }
            }
        });
        const firstElf = elfService.read();
        assert.strictEqual(firstElf.symbols[0].hasDwarfWriteType, true);
        assert.strictEqual(elfService.read(), firstElf, "matching content hash should reuse the enriched result");
        assert.strictEqual(dwarfParses, 1);
        elfService.invalidate();
        elfService.read();
        assert.strictEqual(dwarfParses, 2);

        const noDwarfWide = new ElfService({
            context: { workspaceState: { get: () => elf } },
            cacheKey: "elf",
            fs,
            crypto: require("crypto"),
            cleanPath: (value) => value,
            t: (key) => key,
            elfSymbols: {
                parseElfSymbols: () => ({ symbols: [{ name: "wide", size: 8 }], warnings: [] }),
                defaultType: (size) => (size === 8 ? "u64" : "u32")
            },
            dwarf: { parseDwarf: () => ({ types: new Map(), layouts: new Map() }) }
        }).read().symbols[0];
        assert.strictEqual(noDwarfWide.isComposite, false, "an 8-byte symbol without DWARF should remain a scalar");
        assert.strictEqual(noDwarfWide.watchType, "u64");
        assert.strictEqual(noDwarfWide.hasDwarfWriteType, false, "a guessed u64 type must remain read-only");

        const typedefStruct = new ElfService({
            context: { workspaceState: { get: () => elf } },
            cacheKey: "elf",
            fs,
            crypto: require("crypto"),
            cleanPath: (value) => value,
            t: (key) => key,
            elfSymbols: {
                parseElfSymbols: () => ({ symbols: [{ name: "sensor", size: 4 }], warnings: [] }),
                defaultType: () => "u32"
            },
            dwarf: {
                parseDwarf: () => ({
                    types: new Map([["sensor", { kind: "struct", typeName: "SensorAlias", watchType: "" }]]),
                    layouts: new Map()
                })
            }
        }).read().symbols[0];
        assert.strictEqual(typedefStruct.isComposite, true, "a typedef struct must stay composite at scalar width");
        assert.strictEqual(typedefStruct.watchType, "");
        assert.strictEqual(typedefStruct.hasDwarfWriteType, false);
        const pointer = { name: "pointer", size: 4 };
        elfService._enrich(
            { symbols: [pointer] },
            new Map([["pointer", { kind: "scalar", typeName: "struct Sensor *", watchType: "u32" }]])
        );
        assert.strictEqual(pointer.isComposite, false, "a pointer to a struct must remain a scalar pointer");

        // §3：解析前必须有 ELF 体积硬上限。autoDetect 会取工作区 mtime 最新的 .elf，
        // 旧实现 readFileSync 无任何上限，多 GB 的 .elf 会被整份读入内存并送入 DWARF 解析。
        let readCalls = 0;
        const oversized = new ElfService({
            context: { workspaceState: { get: () => "/fake/huge.elf" } },
            cacheKey: "elf",
            fs: {
                statSync: () => ({ size: 128 * 1024 * 1024, mtimeMs: 1 }),
                readFileSync: () => {
                    readCalls++;
                    throw new Error("readFileSync must not be reached for an oversized ELF");
                }
            },
            crypto: require("crypto"),
            cleanPath: (value) => value,
            t: (key) => key,
            elfSymbols: { parseElfSymbols: () => ({ symbols: [], warnings: [] }), defaultType: () => "u32" },
            dwarf: { parseDwarf: () => ({ types: new Map(), layouts: new Map() }) }
        });
        assert.throws(() => oversized.read(), { code: "ELF_TOO_LARGE" }, "超过体积上限的 ELF 必须被拒绝");
        assert.strictEqual(readCalls, 0, "体积校验必须在 readFileSync 之前生效");
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
