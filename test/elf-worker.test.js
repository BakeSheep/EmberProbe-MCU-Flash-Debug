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
        const c = require("../src/dwarf/constants");
        const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
        function fixed(value, width = 4) {
            const bytes = Buffer.alloc(8);
            bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
            return Array.from(bytes.subarray(0, width));
        }
        function leb(value, signed = false) {
            let remaining = BigInt(value);
            const bytes = [];
            do {
                let byte = Number(remaining & 127n);
                remaining >>= 7n;
                const last = signed
                    ? (remaining === 0n && !(byte & 64)) || (remaining === -1n && !!(byte & 64))
                    : remaining === 0n;
                if (!last) byte |= 128;
                bytes.push(byte);
                if (last) break;
            } while (true);
            return bytes;
        }
        const node = (id, tag, attrs = [], children = []) => ({ id, tag, attrs, children });
        const attr = (at, form, value) => [at, form, value];
        const nameAttr = (name) => attr(c.DW_AT_name, 8, name);
        const typeAttr = (ref) => attr(c.DW_AT_type, 0x13, ref);
        const base = (id, name = "int", size = 4, encoding = c.DW_ATE_signed) =>
            node(id, c.DW_TAG_base_type, [
                nameAttr(name),
                attr(c.DW_AT_byte_size, 0x0b, size),
                attr(c.DW_AT_encoding, 0x0b, encoding)
            ]);
        const composite = (id, name, size, children = [], tag = c.DW_TAG_class_type) =>
            node(id, tag, [...(name ? [nameAttr(name)] : []), attr(c.DW_AT_byte_size, 6, size)], children);
        const member = (id, name, type, offset) =>
            node(id, c.DW_TAG_member, [nameAttr(name), typeAttr(type), attr(c.DW_AT_data_member_location, 6, offset)]);
        const pointer = (id, type) => node(id, c.DW_TAG_pointer_type, [typeAttr(type)]);
        const variable = (name, type, address = 0x20000000, expression) =>
            node("var-" + name, c.DW_TAG_variable, [
                nameAttr(name),
                typeAttr(type),
                attr(c.DW_AT_location, 0x18, expression || [3, ...fixed(address)])
            ]);
        function fixture(units, { version = 4, symbols = [], sections = [] } = {}) {
            const info = [],
                abbrev = [],
                definitions = new Map(),
                offsets = new Map(),
                references = [];
            const value = (form, input, cuStart) => {
                if ([0x13, 0x10].includes(form)) {
                    references.push({ offset: info.length, label: input, cuStart: form === 0x13 ? cuStart : 0 });
                    info.push(0, 0, 0, 0);
                } else if ([0x0b, 5, 6, 7].includes(form))
                    info.push(...fixed(input, { 0x0b: 1, 5: 2, 6: 4, 7: 8 }[form]));
                else if (form === 8) info.push(...Buffer.from(input + "\0"));
                else if (form === 0x18) info.push(...leb(input.length), ...input);
                else if ([0x0f, 0x0d].includes(form)) info.push(...leb(input, form === 0x0d));
                else if (form === 0x16) {
                    info.push(...leb(input.form));
                    value(input.form, input.value, cuStart);
                } else if (![0x19, 0x21].includes(form)) throw new Error("Unsupported fixture form " + form);
            };
            const emit = (die, cuStart) => {
                offsets.set(die.id, info.length);
                const key = JSON.stringify([
                    die.tag,
                    !!die.children.length,
                    die.attrs.map(([at, form, v]) => [at, form, form === 0x21 ? v : null])
                ]);
                if (!definitions.has(key)) {
                    const code = definitions.size + 1;
                    definitions.set(key, code);
                    abbrev.push(...leb(code), ...leb(die.tag), Number(!!die.children.length));
                    for (const [at, form, v] of die.attrs) {
                        abbrev.push(...leb(at), ...leb(form));
                        if (form === 0x21) abbrev.push(...leb(v, true));
                    }
                    abbrev.push(0, 0);
                }
                info.push(...leb(definitions.get(key)));
                for (const [, form, v] of die.attrs) value(form, v, cuStart);
                for (const child of die.children) emit(child, cuStart);
                if (die.children.length) info.push(0);
            };
            for (let index = 0; index < units.length; index++) {
                const cuStart = info.length;
                info.push(0, 0, 0, 0, version, 0);
                if (version === 5) info.push(1, 4, 0, 0, 0, 0);
                else info.push(0, 0, 0, 0, 4);
                const unit = Array.isArray(units[index]) ? node("cu-" + index, 0x11, [], units[index]) : units[index];
                emit(unit, cuStart);
                fixed(info.length - cuStart - 4).forEach((byte, offset) => {
                    info[cuStart + offset] = byte;
                });
            }
            for (const ref of references) {
                assert(offsets.has(ref.label), "Unknown reference " + ref.label);
                fixed(offsets.get(ref.label) - ref.cuStart).forEach((byte, offset) => {
                    info[ref.offset + offset] = byte;
                });
            }
            abbrev.push(0);
            return {
                buffer: buildElf32({
                    sections: [
                        ...buildDebugSections({ info: Buffer.from(info), abbrev: Buffer.from(abbrev) }),
                        ...sections
                    ],
                    symbols
                }),
                offsets
            };
        }
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
