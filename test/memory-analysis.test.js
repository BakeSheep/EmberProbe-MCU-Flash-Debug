"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { evaluate, parseLinkerScript, parseMap } = require("../src/memoryRegions");
const { analyzeMemory, topSymbols, loadAddress, unionBytes } = require("../src/memoryAnalysis");
const { MemoryAnalysisService } = require("../src/services/memoryAnalysisService");
const { ElfService } = require("../src/services/elfService");
const { buildMemoryElf, snapshot, memoryMap, h750Regions, f407Regions } = require("./helpers/memory-fixture");

(async () => {
    assert.strictEqual(evaluate("(128K - 4) / 2 + (1 << 2)"), 65538);
    assert.strictEqual(evaluate("~0 & 0xFFFF"), 65535);
    assert.strictEqual(evaluate("(2M % 1024) | 3 ^ 1"), 2);
    assert.throws(() => evaluate("process.exit()"), /Unsupported|Unknown/);
    assert.throws(() => evaluate("1 << 200"), /shift/);
    assert.throws(() => evaluate("1 / 0"));
    assert.throws(() => evaluate("-1"));
    const script = `BASE = 0x08000000; SIZE = 1M;
        REGION_ALIAS("APP", FLASH);
        MEMORY {
          FLASH (rx) : ORIGIN = BASE, LENGTH = SIZE
          RAM (xrw) : org = 0x20000000, len = (128K - 4)
          CCMRAM : o = ORIGIN(RAM) + LENGTH(RAM), l = 64K
          ROM2 : ORIGIN = ORIGIN(APP) + LENGTH(APP), LENGTH = 256K
        }`;
    const parsed = parseLinkerScript(script);
    assert.deepStrictEqual(parsed.diagnostics, []);
    assert.strictEqual(parsed.regions[2].origin, 0x20000000 + 128 * 1024 - 4);
    assert.strictEqual(parsed.regions[3].origin, 0x08100000);
    assert.ok(parseLinkerScript("A=B; B=A; MEMORY { FLASH : ORIGIN=A, LENGTH=1K }").diagnostics.length);
    assert.ok(
        parseLinkerScript('REGION_ALIAS("A",B); REGION_ALIAS("B",A); MEMORY { FLASH : ORIGIN=ORIGIN(A), LENGTH=1K }')
            .diagnostics.length
    );
    assert.ok(parseLinkerScript("MEMORY { FLASH : ORIGIN=DEFINED(X), LENGTH=1K }").diagnostics.length);
    assert.ok(
        parseLinkerScript("MEMORY { FLASH : ORIGIN=0, LENGTH=1K FLASH : ORIGIN=2K, LENGTH=1K }").diagnostics.length
    );
    assert.ok(parseLinkerScript("MEMORY { FLASH : ORIGIN=0xffffffff, LENGTH=2K }").diagnostics.length);
    assert.ok(parseLinkerScript("MEMORY { nonsense }").diagnostics.length);

    for (const [regions, ram, flash, expected] of [
        [h750Regions, 55248, 67052, ["42.15", "0.00", "0.00", "0.00", "0.00", "51.16"]],
        [f407Regions, 21544, 35020, ["16.44", "0.00", "3.34"]]
    ]) {
        const data = snapshot(
            buildMemoryElf([
                { name: ".text", addr: 0x08000000, size: flash, type: 1, flags: 6 },
                { name: ".bss", addr: 0x20000000, size: ram, type: 8, flags: 3 }
            ])
        );
        const map = parseMap(memoryMap(regions, data.memory.sections), data.memory.sections);
        assert.deepStrictEqual(map.diagnostics, []);
        const result = analyzeMemory(data, map.regions);
        assert.deepStrictEqual(
            result.regions.map((r) => r.percent.toFixed(2)),
            expected
        );
        assert.strictEqual(result.flash.total, flash);
        assert.strictEqual(result.ram.total, ram);
        assert.strictEqual(result.flash.estimated, false);
        assert.strictEqual(result.regions[1].used, regions === h750Regions ? 0 : 0);
        const stale = memoryMap(regions, data.memory.sections).replace(".text 0x8000000", ".text 0x8000004");
        assert.strictEqual(parseMap(stale, data.memory.sections).regions.length, 0);
        assert.ok(parseMap(stale, data.memory.sections).diagnostics.some((d) => d.code === "MAP_ELF_MISMATCH"));
        const wrapped = memoryMap(regions, data.memory.sections).replace(".text 0x", ".text\n                0x");
        assert.deepStrictEqual(parseMap(wrapped, data.memory.sections).diagnostics, []);
    }
    const data = snapshot(
        buildMemoryElf([
            { name: ".text", addr: 0x08000000, size: 64, type: 1, flags: 6 },
            { name: ".itcm", addr: 0, lma: 0x08000100, size: 64, type: 1, flags: 6 },
            { name: ".readonly", addr: 0x24000000, size: 32, type: 1, flags: 2 },
            { name: ".data", addr: 0x30000000, lma: 0x08000140, size: 16, type: 1, flags: 3 },
            { name: ".bss", addr: 0x30000010, size: 16, type: 8, flags: 3 },
            { name: "._user_heap_stack", addr: 0x30000100, size: 1536, type: 8, flags: 3 }
        ])
    );
    data.functions = [{ name: "fn", displayName: "ns::fn", size: 32, address: 0x08000000 }];
    data.symbols = [{ name: "counter", size: 4, address: 0x30000000 }];
    const result = analyzeMemory(data, h750Regions);
    assert.strictEqual(result.flash.total, 144, "FLASH copy of ITCM and .data, without RAM-only readonly contents");
    assert.strictEqual(result.ram.total, 1664, "ITCM code, readonly RAM, .data, .bss, and reserved stack");
    assert.strictEqual(result.regions[2].used, 1792, "span includes the gap before heap/stack");
    assert.strictEqual(result.regions[2].sectionBytes, 1568);
    assert.strictEqual(result.regions[4].used, 64);
    assert.strictEqual(topSymbols(data, 1)[0].displayName, "ns::fn");
    assert.strictEqual(topSymbols(data, 1000).length, 2);
    assert.strictEqual(
        unionBytes([
            [0, 10],
            [3, 6],
            [6, 20],
            [30, 40]
        ]),
        30
    );
    const duplicate = structuredClone(data);
    duplicate.memory.sections.push({ ...duplicate.memory.sections.find((s) => s.name === ".itcm"), name: ".alias" });
    assert.strictEqual(analyzeMemory(duplicate, h750Regions).ram.total, result.ram.total);
    assert.strictEqual(analyzeMemory(data).flash.estimated, true);
    const overflow = analyzeMemory(
        snapshot(buildMemoryElf([{ name: ".bss", type: 8, flags: 3, addr: 0x20000000, size: 2048 }])),
        [{ name: "RAM", origin: 0x20000000, capacity: 1024 }]
    );
    assert.strictEqual(overflow.regions[0].percent, 200);
    const overlap = analyzeMemory(data, [...h750Regions, { name: "ALIAS", origin: 0, capacity: 1024 }]);
    assert.strictEqual(overlap.regions[4].used, null);
    assert.ok(overlap.diagnostics.some((d) => d.code === "MEMORY_REGION_AMBIGUOUS"));
    const custom = analyzeMemory(
        data,
        h750Regions.map((r) => ({ ...r, name: r.name === "ITCMRAM" ? "FAST" : r.name })),
        { FAST: "ram" }
    );
    assert.strictEqual(custom.ram.total, result.ram.total);
    assert.strictEqual(loadAddress({ addr: 0, offset: 0, size: 1 }, []), null);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-memory-"));
    let workerService;
    try {
        const elf = path.join(temp, "app.elf");
        const buffer = buildMemoryElf([{ name: ".text", addr: 0x08000000, size: 64, type: 1, flags: 6 }]);
        fs.writeFileSync(elf, buffer);
        const snap = snapshot(buffer, elf);
        const map = path.join(temp, "app.map");
        fs.writeFileSync(map, memoryMap(f407Regions, snap.memory.sections));
        const ld = path.join(temp, "chip.ld");
        fs.writeFileSync(ld, 'INCLUDE "regions.ld"\n');
        fs.writeFileSync(path.join(temp, "regions.ld"), script);
        let scripts = [ld],
            selection = {};
        const service = new MemoryAnalysisService({
            elfService: { load: async () => snap },
            roots: () => [temp],
            findScripts: async () => scripts,
            selection: () => selection
        });
        assert.strictEqual((await service.analyze()).source.kind, "map");
        assert.strictEqual((await service.analyze({ top: 1 })).flash.total, 64);
        fs.writeFileSync(map, "stale");
        service.invalidate();
        let report = await service.analyze();
        assert.strictEqual(report.source.kind, "linker-script");
        assert.ok(report.source.files.includes(path.join(temp, "regions.ld")));
        assert.ok(report.diagnostics.some((d) => d.code === "MAP_ELF_MISMATCH"));
        fs.rmSync(map);
        service.invalidate();
        fs.writeFileSync(path.join(temp, "regions.ld"), 'INCLUDE "chip.ld"');
        report = await service.analyze();
        assert.strictEqual(report.source.kind, "elf");
        assert.ok(report.diagnostics.some((d) => d.code === "MEMORY_SOURCE_READ_FAILED"));
        scripts = [ld, path.join(temp, "other.ld")];
        service.invalidate();
        report = await service.analyze();
        assert.ok(report.diagnostics.some((d) => d.code === "MEMORY_SOURCE_AMBIGUOUS"));
        selection = { linkerScript: ld };
        fs.writeFileSync(path.join(temp, "regions.ld"), script);
        service.invalidate();
        assert.strictEqual((await service.analyze()).source.kind, "linker-script");
        await assert.rejects(service.analyze({ mapFile: "wrong.txt" }), (e) => e.code === "INVALID_MEMORY_LAYOUT_PATH");
        await assert.rejects(
            service.analyze({ mapFile: "../outside.map" }),
            (e) => e.code === "PATH_OUTSIDE_WORKSPACE"
        );
        assert.strictEqual((await service.analyze({ mapFile: "missing.map" })).source.kind, "linker-script");
        scripts = [];
        selection = {};
        service.invalidate();
        assert.strictEqual((await service.analyze()).regions.length, 0);
        fs.writeFileSync(map, memoryMap(f407Regions, snap.memory.sections));
        fs.writeFileSync(elf + ".map", memoryMap(f407Regions, snap.memory.sections));
        service.invalidate();
        assert.ok((await service.analyze()).source.candidates.includes(map));
        assert.strictEqual((await service.analyze({ mapFile: map })).source.kind, "map");
        const invalidKinds = new MemoryAnalysisService({
            elfService: { load: async () => snap },
            regionKinds: () => ({ FLASH: "bad" })
        });
        await assert.rejects(invalidKinds.analyze(), (e) => e.code === "INVALID_MEMORY_REGION_KINDS");
        let reads = 0;
        workerService = new ElfService({
            context: { workspaceState: { get: () => elf } },
            cacheKey: "elf",
            fs: {
                ...fs,
                readFileSync: (...args) => {
                    reads++;
                    return fs.readFileSync(...args);
                }
            },
            crypto: require("crypto"),
            elfSymbols: require("../src/elfSymbols"),
            workerPath: path.resolve("src/elfWorker.js"),
            cleanPath: (value) => value,
            t: (key) => key
        });
        const shared = new MemoryAnalysisService({ elfService: workerService });
        const first = await shared.analyze({ mapFile: map });
        const second = await shared.analyze({ mapFile: map });
        assert.strictEqual(first.flash.total, second.flash.total);
        assert.strictEqual(first.elf.sha256, second.elf.sha256);
        assert.strictEqual(reads, 0, "ELF bytes are read in the worker, never re-read in the extension host");
        assert.ok(workerService.cache.memory.sections.length);
        await workerService.ready();
    } finally {
        workerService?.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log("Shared memory analysis, map/linker parsing and ELF snapshot tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
