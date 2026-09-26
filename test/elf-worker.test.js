"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ElfService } = require("../src/services/elfService");
const elfSymbols = require("../src/elfSymbols");
const { buildElf } = require("./perf/parse-bench");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-elf-worker-"));
    const file = path.join(temp, "firmware.elf");
    fs.writeFileSync(file, buildElf({ cus: 2, vars: 40, structs: 2, members: 3 }).buf);
    const phases = [];
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("crypto"),
        elfSymbols,
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.join(__dirname, "../src/elfWorker.js"),
        onChange: (phase, _result, entries) => phases.push([phase, entries?.length || 0])
    });
    try {
        const partial = await service.load();
        assert.strictEqual(partial.symbols.length, 84);
        assert.ok(phases.some(([phase]) => phase === "symbolsDone"));
        assert.ok(phases.filter(([phase]) => phase === "symbols").every(([, size]) => size <= 1000));
        const ready = await service.ready();
        assert.strictEqual(ready.dwarfReady, true);
        assert.strictEqual(ready.symbols.find((symbol) => symbol.name === "v0_2").typeName, "struct S0_0");
        const first = await service.layout("v0_2");
        assert.strictEqual(first.members.length, 3);
        assert.strictEqual(await service.layout("v0_2"), first, "resolved layouts are reused by the service");
        assert.deepStrictEqual(await service.layout("v0_6"), first, "shared types resolve consistently");
        const worker = service.worker;
        const exited = new Promise((resolve) => worker.once("exit", resolve));
        await worker.terminate();
        await exited;
        assert.strictEqual(service.read().symbols.length, 84, "worker failure keeps the symbol list available");
        await assert.rejects(service.ready(), { code: "DWARF_PARSE_FAILED" });
        const oldGeneration = service.generation;
        service.invalidate();
        assert.ok(service.generation > oldGeneration);
        assert.strictEqual(service.cache, null);
        const staleLoad = service.load();
        service.invalidate();
        await assert.rejects(staleLoad, /ELF changed/);
        assert.strictEqual(service.cache, null, "stale worker responses must not restore an invalidated ELF");
    } finally {
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log("ELF worker progressive parsing and lazy layout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
