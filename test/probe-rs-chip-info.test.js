"use strict";

const assert = require("node:assert/strict");
const rules = require("../src/chip/rules");
const {
    DHCSR_ADDR,
    parseReadWords,
    parseRegisters,
    targetForChip,
    readCliMemory,
    readDapMemory,
    readProbeRsChipInfo
} = require("../src/services/probeRsChipInfo");

function fixture(chip = "STM32H723VG") {
    const memory = new Map();
    const requests = [];
    const settings = { executable: "probe-rs", chip, probe: "1366:0101:123456", speed: 2000, protocol: "JTAG" };
    const put = (address, words) => {
        const bytes = Buffer.alloc(words.length * 4);
        words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
        memory.set(address, bytes);
    };
    put(rules.CPUID_ADDR, [chip.startsWith("STM32H7") ? 0x411fc272 : 0x410fc241]);
    put(DHCSR_ADDR, [0x40000]); // sleeping, so still executing firmware
    put(rules.ROM_PIDR0_ADDR, [0x13, 0x04, 0x0a, 0]);
    put(rules.ROM_PIDR4_ADDR, [0, 0, 0, 0]);
    put(rules.ROM_CIDR_ADDR, [0x0d, 0x10, 0x05, 0xb1]);
    const target = targetForChip(chip);
    if (rules.idcodeBaseForTarget(target))
        put(rules.idcodeBaseForTarget(target), [0x10010000 | (chip.startsWith("STM32H7") ? 0x483 : 0x413)]);
    if (rules.flashSizeBaseForTarget(target)) put(rules.flashSizeBaseForTarget(target), [1024]);
    if (rules.uidBaseForTarget(target)) put(rules.uidBaseForTarget(target), [0x001d0041, 0x31345104, 0x38373332]);
    if (/^stm32f[1247]x\.cfg$/.test(target)) {
        const flash = rules.flashSizeBaseForTarget(target);
        const uid = rules.uidBaseForTarget(target);
        const gapStart = flash > uid ? uid + 12 : flash + 4;
        const gapEnd = flash > uid ? flash : uid;
        memory.set(gapStart, Buffer.alloc(gapEnd - gapStart));
    }
    const bytesAt = (address, count) => {
        const bytes = Buffer.alloc(count);
        for (let index = 0; index < count; index++) {
            const entry = [...memory.entries()].find(
                ([base, block]) => address + index >= base && address + index < base + block.length
            );
            if (!entry) throw new Error(`unreadable address 0x${(address + index).toString(16)}`);
            bytes[index] = entry[1][address + index - entry[0]];
        }
        return bytes;
    };
    const run = async (executable, args, cwd, options) => {
        assert.equal(executable, "probe-rs");
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 15000);
        assert.equal(args[0], "read", "ordinary CLI reads never send execution or write commands");
        assert.equal(args[args.indexOf("--protocol") + 1], "jtag");
        const width = Number(args.at(-3).slice(1)) / 8;
        const address = Number(args.at(-2));
        const count = Number(args.at(-1));
        requests.push({ address, count, width });
        const bytes = bytesAt(address, count * width);
        const words = Array.from({ length: count }, (_, index) =>
            bytes
                .readUIntLE(index * width, width)
                .toString(16)
                .padStart(width * 2, "0")
        );
        const perLine = 8;
        const lines = [];
        for (let index = 0; index < words.length; index += perLine)
            lines.push(`${(address + index * width).toString(16)}: ${words.slice(index, index + perLine).join(" ")}`);
        return { stdout: `${lines.join("\n")}\n` };
    };
    const session = {
        async customRequest(command, args) {
            requests.push({ command, args });
            if (command === "evaluate") {
                assert.equal(args.expression, "info reg");
                assert.equal(args.context, "repl");
                return { result: "SP/R13: 0x20001000 LR/R14: 0xffffffff\nPC/R15: 0x08000100" };
            }
            assert.equal(command, "readMemory");
            const address = Number(args.memoryReference);
            return { body: { address: args.memoryReference, data: bytesAt(address, args.count).toString("base64") } };
        }
    };
    return { settings, memory, put, requests, run, session };
}

async function main() {
    assert.deepEqual(parseReadWords("5c001000: 10016483\n", 0x5c001000, 1), [0x10016483]);
    assert.deepEqual(
        parseReadWords("1ff1e800: 001d0041 31345104 38373332\n", 0x1ff1e800, 3),
        [0x001d0041, 0x31345104, 0x38373332]
    );
    assert.throws(() => parseReadWords("wrong", 0xe000ed00, 1), /did not return/);
    assert.throws(() => parseReadWords("e000ed00: 411fc272", 0xe000ed00, 2), /returned 1 of 2/);

    assert.deepEqual(parseReadWords("0xe000ed00: 411fc272\ne000ed04: 00000001", 0xe000ed00, 2), [0x411fc272, 1]);
    assert.throws(() => parseReadWords("e000ed00: 411fc272 junk", 0xe000ed00, 1), /Invalid/);
    assert.throws(() => parseReadWords("e000ed00: 411fc272\ne000ed08: 1", 0xe000ed00, 2), /noncontiguous/);
    assert.throws(() => parseReadWords("", 0, 1000), { code: "CHIP_READ_BUDGET" });
    assert.deepEqual(parseRegisters("PC/R15: 0x08000abc\nSP/R13: 0x20001000 LR/R14: 0xfffffff9"), {
        pc: "0x08000ABC",
        sp: "0x20001000",
        lr: "0xFFFFFFF9"
    });
    const state = fixture();
    const { settings, run, session } = state;
    const cli = await readProbeRsChipInfo(settings, { run });
    assert.equal(cli.core, "Cortex-M7");
    assert.equal(cli.deviceId, "0x483");
    assert.equal(cli.revId, "0x1001");
    assert.equal(cli.flashSize, "1024 KiB");
    assert.equal(cli.uid, "0x001D00413134510438373332");
    assert.equal(cli.controlsAvailable, true);
    assert.equal(cli.series, "STM32H7x");
    assert.equal(cli.targetState, "running");
    assert.equal(cli.designer, "STMicroelectronics");
    assert.equal(cli.authenticity, "genuine");
    assert.equal(cli.romPart, "0x413");
    assert.equal(cli.clock, "2000 kHz");
    assert.equal(cli.probeName, "J-Link");
    assert.equal(cli.endian, "little");
    assert.deepEqual(cli.readErrors, []);
    assert.deepEqual(
        state.requests.find(({ address }) => address === 0x1ff1e880),
        { address: 0x1ff1e880, count: 1, width: 2 }
    );
    const dap = await readProbeRsChipInfo(settings, { session, state: "running" });
    assert.equal(dap.uid, cli.uid);
    assert.equal(dap.targetState, "running");
    assert.equal(dap.pc, undefined);
    assert.equal(dap.resetAvailable, false);
    const halted = await readProbeRsChipInfo(settings, {
        session,
        state: "halted",
        haltReason: "breakpoint",
        resetAvailable: true
    });
    assert.equal(halted.pc, "0x08000100");
    assert.equal(halted.sp, "0x20001000");
    assert.equal(halted.lr, "0xFFFFFFFF");
    assert.equal(halted.haltReason, "breakpoint");
    assert.equal(halted.resetAvailable, true);

    for (const chip of [
        "STM32F030C8",
        "STM32F103C8",
        "STM32F207VG",
        "STM32F303RE",
        "STM32F407ZG",
        "STM32F746ZG",
        "STM32G071RB",
        "STM32G474RE",
        "STM32L072CB",
        "STM32L152RE",
        "STM32L476RG",
        "STM32WB55RG",
        "STM32WL55JC"
    ]) {
        const family = fixture(chip);
        const info = await readProbeRsChipInfo(family.settings, { run: family.run });
        assert.equal(info.deviceId, "0x413", chip);
        assert.equal(info.uid, cli.uid, chip);
        assert.equal(info.flashSize, chip.startsWith("STM32L1") ? undefined : "1024 KiB", chip);
        const mapped = targetForChip(chip);
        const expected = new Set([
            rules.CPUID_ADDR,
            DHCSR_ADDR,
            rules.ROM_PIDR0_ADDR,
            rules.ROM_PIDR4_ADDR,
            rules.ROM_CIDR_ADDR,
            rules.idcodeBaseForTarget(mapped),
            rules.uidBaseForTarget(mapped),
            rules.flashSizeBaseForTarget(mapped)
        ]);
        assert.ok(
            family.requests.every(({ address }) => expected.has(address)),
            "family reads must not scan unrelated addresses"
        );
        if (chip.startsWith("STM32F4"))
            assert.deepEqual(
                family.requests.find(({ address }) => address === 0x1fff7a10),
                {
                    address: 0x1fff7a10,
                    count: 10,
                    width: 2
                }
            );
        if (chip.startsWith("STM32F7"))
            assert.deepEqual(
                family.requests.find(({ address }) => address === 0x1ff0f420),
                {
                    address: 0x1ff0f420,
                    count: 18,
                    width: 2
                }
            );
    }

    const unknown = fixture("nRF52840_xxAA");
    const unknownInfo = await readProbeRsChipInfo(unknown.settings, { run: unknown.run });
    assert.equal(unknownInfo.idcode, undefined);
    assert.equal(unknownInfo.uid, undefined);
    assert.equal(unknown.requests.length, 3);
    for (const chip of ["APM32F407ZG", "STM32F407ZG"]) {
        const compatible = fixture(chip);
        compatible.put(rules.ROM_PIDR0_ADDR, [0x13, 0x34, 0x0a, 0]);
        compatible.put(rules.ROM_PIDR4_ADDR, [0x0b, 0, 0, 0]);
        const info = await readProbeRsChipInfo(compatible.settings, { run: compatible.run });
        assert.equal(info.deviceId, "0x413");
        assert.equal(info.designer, "Apex Microelectronics (Geehy)");
        assert.equal(info.flashSize, undefined);
        assert.equal(info.uid, undefined);
        assert.ok(compatible.requests.every(({ address }) => address !== 0x1fff7a22 && address !== 0x1fff7a10));
        if (chip.startsWith("STM32")) assert.equal(info.compatBrand, "Geehy APM32");
    }
    const partial = fixture("STM32F407ZG");
    partial.memory.delete(rules.ROM_CIDR_ADDR);
    partial.memory.delete(0x1fff7a22);
    const partialInfo = await readProbeRsChipInfo(partial.settings, { run: partial.run });
    assert.equal(partialInfo.uid, cli.uid);
    assert.equal(partialInfo.deviceId, "0x413");
    assert.deepEqual(
        partialInfo.readErrors.map(({ field }) => field),
        ["romDesigner", "flashSize"]
    );
    partial.memory.delete(DHCSR_ADDR);
    const noState = await readProbeRsChipInfo(partial.settings, { run: partial.run });
    assert.equal(noState.targetState, "unknown");
    assert.match(noState.stateError, /unreadable/);
    const invalid = fixture();
    invalid.put(rules.CPUID_ADDR, [0xffffffff]);
    await assert.rejects(readProbeRsChipInfo(invalid.settings, { run: invalid.run }), {
        code: "CHIP_ARCHITECTURE_UNSUPPORTED"
    });
    await assert.rejects(
        readProbeRsChipInfo(settings, {
            run: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { stdout: "e000ed00: 411fc272" };
            },
            timeoutMs: 5
        }),
        { code: "CHIP_READ_TIMEOUT" }
    );
    await assert.rejects(
        readProbeRsChipInfo(settings, { session: { customRequest: () => new Promise(() => {}) }, timeoutMs: 5 }),
        { code: "CHIP_READ_TIMEOUT" }
    );
    for (const response of [
        { data: "AAAAAA==", unreadableBytes: 1 },
        { data: "AA==" },
        { data: "AAAAAA==", address: "0x1" },
        { data: "!!!!AA==" },
        { data: "AAAAAA==", success: false }
    ]) {
        await assert.rejects(
            readDapMemory({ customRequest: async () => response }, rules.CPUID_ADDR, 4),
            /could not read/
        );
    }
    let unexpectedCalls = 0;
    await assert.rejects(
        readCliMemory(settings, 0xffffffff, 4, () => unexpectedCalls++),
        { code: "CHIP_READ_BUDGET" }
    );
    assert.equal(unexpectedCalls, 0);
    await assert.rejects(readProbeRsChipInfo({ ...settings, chip: "" }), /probeRsChip/);
    assert.equal(rules.DEV_ID_FAMILY[0x483], "STM32H7x");
    assert.equal(targetForChip("STM32H7S3L8"), "");

    const coreOnly = fixture("STM32F407ZG");
    const coreInfo = await readProbeRsChipInfo(coreOnly.settings, { run: coreOnly.run, fields: ["core", "cpuid"] });
    assert.equal(coreInfo.core, "Cortex-M4");
    assert.deepEqual(
        coreOnly.requests.map(({ address }) => address),
        [rules.CPUID_ADDR]
    );
    const runtimeOnly = fixture("STM32F407ZG");
    const runtimeInfo = await readProbeRsChipInfo(runtimeOnly.settings, {
        run: runtimeOnly.run,
        fields: ["targetState"]
    });
    assert.equal(runtimeInfo.targetState, "running");
    assert.deepEqual(
        runtimeOnly.requests.map(({ address }) => address),
        [rules.CPUID_ADDR, DHCSR_ADDR]
    );
    const metadataOnly = fixture();
    assert.equal(
        (await readProbeRsChipInfo(metadataOnly.settings, { run: metadataOnly.run, fields: ["clock"] })).clock,
        "2000 kHz"
    );
    assert.deepEqual(metadataOnly.requests, []);
    const identityOnly = fixture("STM32F407ZG");
    await readProbeRsChipInfo(identityOnly.settings, { run: identityOnly.run, fields: ["deviceId"] });
    assert.deepEqual(
        identityOnly.requests.map(({ address }) => address),
        [rules.CPUID_ADDR, 0xe0042000]
    );
    const uidOnly = fixture("STM32F407ZG");
    assert.equal((await readProbeRsChipInfo(uidOnly.settings, { run: uidOnly.run, fields: ["uid"] })).uid, cli.uid);
    assert.deepEqual(
        uidOnly.requests.map(({ address }) => address),
        [rules.CPUID_ADDR, rules.ROM_PIDR4_ADDR, 0x1fff7a10]
    );
    const progressFixture = fixture("STM32F407ZG");
    const snapshots = [];
    const progressive = await readProbeRsChipInfo(progressFixture.settings, {
        run: progressFixture.run,
        onProgress: (snapshot) => snapshots.push({ snapshot, reads: progressFixture.requests.length })
    });
    assert.equal(snapshots[0].reads, 1, "publish the core before completing all hardware reads");
    assert.equal(snapshots[0].snapshot.core, "Cortex-M4");
    assert.equal(snapshots[0].snapshot.uid, undefined);
    assert.equal(snapshots[0].snapshot.readAt, "");
    assert.equal(progressive.uid, cli.uid);
    assert.equal(progressFixture.requests.length, 5, "one CLI connection reads both factory fields");
    assert.ok(progressive.readAt);
    const factoryHole = fixture("STM32F407ZG");
    factoryHole.memory.delete(0x1fff7a1c);
    const recovered = await readProbeRsChipInfo(factoryHole.settings, { run: factoryHole.run });
    assert.equal(recovered.flashSize, "1024 KiB");
    assert.equal(recovered.uid, cli.uid);
    assert.deepEqual(recovered.readErrors, []);
    await assert.rejects(
        readCliMemory(settings, 0x1fff7a22, 2, () => unexpectedCalls++, { width: 4 }),
        {
            code: "CHIP_READ_BUDGET"
        }
    );
    assert.equal(unexpectedCalls, 0);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
