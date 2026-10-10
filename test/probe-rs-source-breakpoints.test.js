"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveSourceLines } = require("../src/dwarf/lineTable");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { ElfService } = require("../src/services/elfService");
const { ProbeRsBreakpoints } = require("../src/services/probeRsBreakpoints");
const { buildSourceElf } = require("./helpers/probe-rs-source-fixture");

async function main() {
    const source = "C:/project/App/app_main.cpp";
    const elf = buildSourceElf(source);
    const parsed = parseDwarfInternal(elf);
    const units = [...new Set([...parsed.dies.values()].filter((die) => die.tag === 0x11).map((die) => die.unit))];
    assert.equal(units[0].stmtList, 0);
    for (const version of [2, 3, 4, 5]) {
        assert.deepEqual(
            resolveSourceLines(buildSourceElf(source, { version }), units, "c:\\project\\App\\app_main.cpp", [
                { line: 2, column: 1 },
                { line: 3 },
                { line: 4 },
                { line: 99 }
            ]),
            [{ address: 0x08000100, line: 2, column: 9 }, { address: 0x08000104, line: 3, column: 9 }, null, null]
        );
    }
    assert.deepEqual(resolveSourceLines(elf, units, "C:/other/App/app_main.cpp", [{ line: 2 }]), [null]);
    assert.throws(() => resolveSourceLines(elf, units, source, [{ line: 2 }], { maxOperations: 1 }), {
        code: "DWARF_BUDGET_EXCEEDED"
    });
    assert.throws(() => resolveSourceLines(elf.subarray(0, elf.length - 100), units, source, [{ line: 2 }]));
    assert.throws(() => resolveSourceLines(elf, units, source, Array(257).fill({ line: 2 })));
    assert.throws(
        () =>
            resolveSourceLines(buildSourceElf(source, { program: Buffer.from([0, 100, 2]) }), units, source, [
                { line: 2 }
            ]),
        /extended DWARF/
    );

    let instructionRequests = [];
    let deny = false;
    const mapper = new ProbeRsBreakpoints(
        async (command, args) => {
            if (command === "setBreakpoints")
                return {
                    success: true,
                    body: {
                        breakpoints: args.breakpoints.map((bp) => ({
                            ...bp,
                            verified: false,
                            message: "No valid breakpoint information found"
                        }))
                    }
                };
            instructionRequests.push(args.breakpoints);
            return {
                success: true,
                body: {
                    breakpoints: args.breakpoints.map((bp, index) => ({
                        ...bp,
                        id: index + 1,
                        verified: !deny,
                        message: deny ? "No hardware breakpoint slots available" : undefined
                    }))
                }
            };
        },
        async (file, bp) => resolveSourceLines(elf, units, file, bp)
    );
    const request = (file, breakpoints) =>
        mapper.handle({ command: "setBreakpoints", arguments: { source: { path: file }, breakpoints } });
    const first = await request(source, [{ line: 2 }]);
    assert.equal(first.body.breakpoints[0].verified, true);
    assert.equal(first.body.breakpoints[0].instructionReference, "0x8000100");
    const raw = { instructionReference: "0x08000110" };
    await mapper.handle({ command: "setInstructionBreakpoints", arguments: { breakpoints: [raw] } });
    assert.equal(instructionRequests.at(-1).length, 2, "user instruction breakpoints preserve source fallbacks");
    const second = await request("c:\\project\\App\\app_main.cpp", [{ line: 3 }]);
    assert.equal(second.body.breakpoints[0].instructionReference, "0x8000104");
    assert.equal(instructionRequests.at(-1).length, 2, "path aliases replace the same source's prior breakpoints");
    await request(source, []);
    assert.deepEqual(instructionRequests.at(-1), [raw]);
    deny = true;
    const denied = await request(source, [{ line: 2 }]);
    assert.equal(denied.body.breakpoints[0].verified, false);
    assert.match(denied.body.breakpoints[0].message, /slots/);
    deny = false;
    const advanced = await request(source, [{ line: 2, condition: "true" }]);
    assert.equal(
        advanced.body.breakpoints[0].verified,
        false,
        "unsupported conditions must never become unconditional fallbacks"
    );
    assert.deepEqual(instructionRequests.at(-1), [raw]);
    const missing = await request(source, [{ line: 99 }]);
    assert.equal(missing.body.breakpoints[0].verified, false);
    await mapper.handle({ command: "setInstructionBreakpoints", arguments: { breakpoints: [] } });
    assert.deepEqual(instructionRequests.at(-1), []);

    const conditionalInstruction = {
        instructionReference: "0x080000f0",
        offset: 16,
        condition: "GAIN > 0",
        hitCondition: "3"
    };
    await mapper.handle({
        command: "setInstructionBreakpoints",
        arguments: { breakpoints: [conditionalInstruction] }
    });
    const sameAddress = await request(source, [{ line: 2 }]);
    assert.equal(sameAddress.body.breakpoints[0].verified, true);
    assert.deepEqual(instructionRequests.at(-1), [conditionalInstruction, { instructionReference: "0x8000100" }]);
    await request(source, []);
    assert.deepEqual(instructionRequests.at(-1), [conditionalInstruction]);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-source-lines-"));
    const file = path.join(temp, "firmware.elf");
    fs.writeFileSync(file, elf);
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto: require("node:crypto"),
        elfSymbols: require("../src/elfSymbols"),
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.join(__dirname, "../src/elfWorker.js")
    });
    try {
        await service.ready();
        assert.equal(service.cache.symbols[0].hasDwarfWriteType, true);
        assert.deepEqual(await service.sourceLines(source, [{ line: 2 }]), [
            { address: 0x08000100, line: 2, column: 9 }
        ]);
        assert.deepEqual(await service.sourceLines("C:/other/app_main.cpp", [{ line: 2 }]), [null]);
        const pending = service.sourceLines(source, [{ line: 3 }]);
        await new Promise((resolve) => setImmediate(resolve));
        service.invalidate();
        await assert.rejects(pending, /ELF changed/);
    } finally {
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log(
        "probe-rs source line fallback, Windows paths, instruction ownership, budgets and ELF worker isolation passed"
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
