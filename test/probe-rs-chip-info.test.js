"use strict";

const assert = require("node:assert/strict");
const { parseReadWords, readProbeRsChipInfo } = require("../src/services/probeRsChipInfo");

async function main() {
    assert.deepEqual(parseReadWords("5c001000: 10016483\n", 0x5c001000, 1), [0x10016483]);
    assert.deepEqual(
        parseReadWords("1ff1e800: 001d0041 31345104 38373332\n", 0x1ff1e800, 3),
        [0x001d0041, 0x31345104, 0x38373332]
    );
    assert.throws(() => parseReadWords("wrong", 0xe000ed00, 1), /did not return/);
    assert.throws(() => parseReadWords("e000ed00: 411fc272", 0xe000ed00, 2), /returned 1 of 2/);

    const words = new Map([
        [0xe000ed00, [0x411fc272]],
        [0x5c001000, [0x10016483]],
        [0x1ff1e880, [0x00000400]],
        [0x1ff1e800, [0x001d0041, 0x31345104, 0x38373332]]
    ]);
    const settings = { executable: "probe-rs", chip: "STM32H723VGTx", probe: "faed:4873-0:d5381744" };
    const seen = [];
    const run = async (_executable, args) => {
        const address = Number(args.at(-2));
        const count = Number(args.at(-1));
        seen.push([address, count]);
        return {
            stdout: `${address.toString(16)}: ${(words.get(address) || []).map((word) => word.toString(16).padStart(8, "0")).join(" ")}\n`
        };
    };
    const cli = await readProbeRsChipInfo(settings, { run });
    assert.equal(cli.core, "Cortex-M7");
    assert.equal(cli.deviceId, "0x483");
    assert.equal(cli.revId, "0x1001");
    assert.equal(cli.flashSize, "1024 KiB");
    assert.equal(cli.uid, "0x001D00413134510438373332");
    assert.equal(cli.controlsAvailable, false);
    assert.deepEqual(seen, [
        [0xe000ed00, 1],
        [0x5c001000, 1],
        [0x1ff1e880, 1],
        [0x1ff1e800, 3]
    ]);

    const session = {
        async customRequest(command, request) {
            assert.equal(command, "readMemory");
            const address = Number(request.memoryReference);
            const values = words.get(address);
            const bytes = Buffer.alloc(values.length * 4);
            values.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
            return { data: bytes.toString("base64") };
        }
    };
    const dap = await readProbeRsChipInfo(settings, { session, state: "running" });
    assert.equal(dap.uid, cli.uid);
    assert.equal(dap.targetState, "running");
    await assert.rejects(readProbeRsChipInfo({ ...settings, chip: "" }), /probeRsChip/);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
