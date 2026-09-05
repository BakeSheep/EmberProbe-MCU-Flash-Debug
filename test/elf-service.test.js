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
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
