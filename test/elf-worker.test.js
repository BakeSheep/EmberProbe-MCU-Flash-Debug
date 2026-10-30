"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildElf } = require("./perf/parse-bench");
const { createWorkerElfService } = require("./helpers/elf-service");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-elf-worker-"));
    const file = path.join(temp, "firmware.elf");
    fs.writeFileSync(file, buildElf({ cus: 2, vars: 40, structs: 2, members: 3 }).buf);
    const phases = [];
    const service = createWorkerElfService(file, {
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
        assert.strictEqual(ready.symbols.find((symbol) => symbol.name === "v0_2").displayName, "v0_2");
        const first = await service.layout("v0_2");
        assert.strictEqual(first.members.length, 3);
        assert.strictEqual(await service.layout("v0_2"), first, "resolved layouts are reused by the service");
        assert.deepStrictEqual(await service.layout("v0_6"), first, "shared types resolve consistently");
        const worker = service.worker;
        const exited = new Promise((resolve) => worker.once("exit", resolve));
        await worker.terminate();
        await exited;
        assert.strictEqual(service.read().symbols.length, 84, "worker failure keeps the symbol list available");
        assert.strictEqual((await service.ready()).dwarfReady, true, "a failed worker can be retried");
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

    await scenario("Coalesce concurrent ELF loads and recover from worker startup failure", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-elf-concurrency-"));
        const file = path.join(temp, "firmware.elf");
        fs.writeFileSync(file, buildElf({ cus: 1, vars: 4, structs: 1, members: 2 }).buf);
        const service = createWorkerElfService(file);
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
    });

    await scenario("Retain static layouts when worker runtime graph budgets are exceeded", async () => {
        const { base, composite, fixture, member, pointer, variable } = require("./helpers/dwarf-tree");
        function runtimeFixture(count = 4200) {
            const children = [],
                members = [];
            for (let index = 0; index < count; index++) {
                children.push(pointer("ptr-" + index, "int"));
                members.push(member("field-" + index, "p" + index, "ptr-" + index, index * 4));
            }
            return fixture(
                [
                    [
                        base("int"),
                        ...children,
                        composite("large", "Large", count * 4, members),
                        composite("small", "Small", 4, [member("small-x", "x", "int", 0)]),
                        variable("large", "large"),
                        variable("small", "small", 0x20010000)
                    ]
                ],
                {
                    symbols: [
                        { name: "large", value: 0x20000000, size: count * 4 },
                        { name: "small", value: 0x20010000, size: 4 }
                    ]
                }
            );
        }
        const f = runtimeFixture();
        const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-runtime-worker-")));
        try {
            const file = path.join(temp, "runtime.elf");
            fs.writeFileSync(file, f.buffer);
            const service = createWorkerElfService(file);
            try {
                const ready = await service.ready();
                const layout = await service.layout("large");
                assert.strictEqual(layout.members.length, 4200, "Worker returns successful static layout");
                assert.strictEqual(layout.runtimeLayout.truncated, true);
                assert.ok(layout.runtimeLayout.types.length <= 4096);
                assert(
                    ready.diagnostics.some((entry) => entry.stage === "runtime-layouts" && entry.symbol === "large")
                );
                assert.strictEqual((await service.layout("small")).members[0].name, "x");
                assert.strictEqual(ready.symbols.find((symbol) => symbol.name === "small").displayName, "small");
            } finally {
                service.invalidate();
            }
        } finally {
            fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });

    await scenario("Preserve const internal-linkage C++ globals and ARM member pointer widths", async () => {
        const zlib = require("zlib");
        const dwarf = require("../src/dwarf");
        const elf = require("../src/elfSymbols");
        const fixtures = require("./fixtures/cpp-review/elf.json");
        const workerTemporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-cpp-worker-"));
        const file = path.join(workerTemporary, "types.elf");
        fs.writeFileSync(file, zlib.inflateSync(Buffer.from(fixtures.dwarf5, "base64")));
        const service = createWorkerElfService(file, { cacheKey: "test", dwarf });
        try {
            const result = await service.ready();
            const readonly = result.symbols.find((symbol) => symbol.displayName === "readonlyRoot");
            assert.ok(readonly?.isConst, "the worker must bind internal-linkage C++ globals by unique static address");
            const layout = await service.layout(readonly.name);
            assert.ok(elf.expandCompositeLeaves(readonly, layout).every((leaf) => leaf.isConst));
            assert.strictEqual(result.symbols.find((symbol) => symbol.name === "methodPointer").watchType, "u64");
        } finally {
            service.invalidate();
            fs.rmSync(workerTemporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });

    console.log("ELF worker progressive parsing and lazy layout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
