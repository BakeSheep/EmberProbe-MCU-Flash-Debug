"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ElfService } = require("../src/services/elfService");
const { buildElf } = require("./perf/parse-bench");
const { parseSvd, assertWritable } = require("../src/services/svdPeripheralService");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-audit-regression-"));
    const file = path.join(temp, "firmware.elf");
    fs.writeFileSync(file, buildElf({ cus: 1, vars: 4, structs: 1, members: 2 }).buf);
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("crypto"),
        elfSymbols: require("../src/elfSymbols"),
        cleanPath: (value) => value,
        t: (value) => value,
        workerPath: path.resolve(__dirname, "../src/elfWorker.js")
    });
    try {
        const first = service.load();
        const worker = service.worker;
        const results = await Promise.allSettled([first, service.load(), service.ready()]);
        assert.ok(
            results.every((result) => result.status === "fulfilled"),
            JSON.stringify(results)
        );
        assert.strictEqual(service.worker, worker);
        service.invalidate();
        const validWorkerPath = service.workerPath;
        service.workerPath = "invalid-worker-path";
        await assert.rejects(service.load(), { code: "ERR_WORKER_PATH" });
        assert.strictEqual(service.loadIdentity, null);
        service.workerPath = validWorkerPath;
        assert((await service.ready()).dwarfReady);
    } finally {
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    const model = parseSvd(`<device><name>T</name><size>32</size><peripherals>
        <peripheral><name>A</name><baseAddress>0x40000000</baseAddress><registers>
        <register><name>R</name><addressOffset>0</addressOffset><access>read-only</access></register>
        </registers></peripheral><peripheral><name>B</name><baseAddress>0x40001000</baseAddress><registers>
        <register><name>R</name><addressOffset>0</addressOffset><access>read-write</access></register>
        <register derivedFrom="A.R"><name>C</name><addressOffset>4</addressOffset></register>
        </registers></peripheral></peripherals></device>`);
    const inherited = model.registersByPath.get("b.c");
    assert.strictEqual(inherited.access, "read-only");
    assert.throws(() => assertWritable(inherited), { code: "PERIPHERAL_WRITE_NOT_ALLOWED" });
    console.log("Audit concurrency and inheritance regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
