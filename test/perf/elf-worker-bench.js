"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { ElfService } = require("../../src/services/elfService");
const elfSymbols = require("../../src/elfSymbols");
const { buildElf } = require("./parse-bench");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-elf-bench-"));
    const file = path.join(temp, "many-variables.elf");
    const { buf } = buildElf({ cus: 300, vars: 400, structs: 4, members: 8 });
    fs.writeFileSync(file, buf);
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("crypto"),
        elfSymbols,
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.join(__dirname, "../../src/elfWorker.js")
    });
    let maxTickGap = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        maxTickGap = Math.max(maxTickGap, now - lastTick);
        lastTick = now;
    }, 10);
    try {
        const start = performance.now();
        const symbols = await service.load();
        const listMs = performance.now() - start;
        await service.ready();
        const typesMs = performance.now() - start;
        const layout = await service.layout("v0_2");
        const layoutMs = performance.now() - start;
        console.log(
            JSON.stringify({
                elfMiB: Number((buf.length / 1048576).toFixed(2)),
                symbols: symbols.symbols.length,
                listMs: Math.round(listMs),
                typesMs: Math.round(typesMs),
                layoutMs: Math.round(layoutMs),
                maxHostTickGapMs: Math.round(maxTickGap),
                layoutMembers: layout?.members.length || 0,
                hostHeapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
                workerHeapMiB: Math.round((symbols.workerHeapUsed || 0) / 1048576)
            })
        );
    } finally {
        clearInterval(timer);
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
