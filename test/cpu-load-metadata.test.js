"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ElfService } = require("../src/services/elfService");
const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const { bindVariableSymbols } = require("../src/dwarf/types");
const elfSymbols = require("../src/elfSymbols");

function firmware(version) {
    const abbrev = Buffer.from([
        1, 0x11, 1, 0, 0, 2, 0x24, 0, 3, 8, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 3, 8, 0x0b, 0x0b, 0, 0, 4, 0x0d,
        0, 3, 8, 0x49, 0x13, 0x38, 0x0b, 0, 0, 5, 0x34, 0, 3, 8, 0x49, 0x13, 2, 0x18, 0, 0, 6, 1, 1, 0x49, 0x13, 0, 0,
        7, 0x21, 0, 0x2f, 0x0b, 0, 0, 8, 0x0f, 0, 0x49, 0x13, 0x0b, 0x0b, 0, 0, 0
    ]);
    const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    const str = (s) => [...Buffer.from(s), 0];
    const bytes = version === 4 ? [...u32(0), 4, 0, ...u32(0), 4] : [...u32(0), 5, 0, 1, 4, ...u32(0)];
    bytes.push(1);
    const integer = bytes.length;
    bytes.push(2, ...str("uint32_t"), 7, 4);
    const char = bytes.length;
    bytes.push(2, ...str("char"), 6, 1);
    const stack = bytes.length;
    bytes.push(8, ...u32(integer), 4);
    const name = bytes.length;
    bytes.push(6, ...u32(char), 7, 19, 0);
    const tcb = bytes.length;
    bytes.push(3, ...str("TCB_t"), 36);
    for (const [field, type, offset] of [
        ["pxTopOfStack", stack, 0],
        ["pxStack", stack, 4],
        ["uxPriority", integer, 8],
        ["pcTaskName", name, 12],
        ["uxTCBNumber", integer, 32]
    ])
        bytes.push(4, ...str(field), ...u32(type), offset);
    bytes.push(0);
    const pointer = bytes.length;
    bytes.push(8, ...u32(tcb), 4);
    const symbols = ["pxCurrentTCB", "xIdleTaskHandle", "xSchedulerRunning"].map((symbol, index) => {
        const value = 0x20000000 + index * 4;
        bytes.push(5, ...str(symbol), ...u32(index === 2 ? integer : pointer), 5, 3, ...u32(value));
        return { name: symbol, value, size: 4, section: 1 };
    });
    bytes.push(0);
    const info = Buffer.from(bytes);
    info.writeUInt32LE(bytes.length - 4, 0);
    return buildElf32({
        sections: [
            { name: ".bss", flags: 3, type: 8, addr: 0x20000000, size: 0x10000 },
            ...buildDebugSections({ info, abbrev })
        ],
        symbols
    });
}

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-cpu-elf-"));
    const file = path.join(directory, "firmware.elf");
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("crypto"),
        elfSymbols,
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.resolve(__dirname, "../src/elfWorker.js")
    });
    try {
        for (const version of [4, 5]) {
            service.invalidate();
            fs.writeFileSync(file, firmware(version));
            const plan = await service.cpuLoadPlan();
            assert.strictEqual(plan.tcb.fields.pcTaskName.size, 20);
            assert.strictEqual(plan.currentAddress, 0x20000000);
            assert.strictEqual(plan.idleAddress, 0x20000004);
            assert(plan.image.length === 64);
        }
        const actualPlan = await service.cpuLoadPlan();
        assert(actualPlan.image);
        fs.writeFileSync(file, firmware(4));
        assert.throws(() => service.read(), { code: "ELF_CHANGED" });
        await service.ready();
        const buffer = firmware(4),
            parsed = elfSymbols.parseElfSymbols(buffer);
        const bound = bindVariableSymbols(parseDwarfInternal(buffer), parsed.symbols);
        const resolve = createRuntimeLayoutResolver(bound, parsed.symbols);
        const synchronous = new ElfService({});
        synchronous.read = () => ({
            ...parsed,
            memory: elfSymbols.parseElfSections(buffer),
            elf: { machine: 40, elfClass: 1, encoding: 1, sha256: "sync" }
        });
        parsed.symbols.find((symbol) => symbol.name === "pxCurrentTCB").runtimeLayout = resolve("pxCurrentTCB");
        assert.strictEqual((await synchronous.cpuLoadPlan()).image, "sync");
        const duplicate = buildElf32({
            sections: [{ name: ".bss", flags: 3, type: 8, addr: 0x20000000, size: 16 }],
            symbols: [
                { name: "pxCurrentTCB", value: 0x20000000, size: 4 },
                { name: "pxCurrentTCB", value: 0x20000004, size: 4 }
            ]
        });
        assert.strictEqual(elfSymbols.parseElfSymbols(duplicate).symbols[0].addressAmbiguous, true);
        const stalled = new ElfService({ workerPath: "fake" });
        stalled.ready = async () => service.read();
        stalled.layout = async () => {
            stalled.generation++;
            return null;
        };
        await assert.rejects(stalled.cpuLoadPlan(), /changed/);
        service.invalidate();
        fs.writeFileSync(file, duplicate);
        await assert.rejects(service.cpuLoadPlan(), /DWARF|unavailable|ambiguous/);
    } finally {
        service.invalidate();
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log("CPU ELF Worker DWARF 4/5, ambiguity and metadata invalidation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
