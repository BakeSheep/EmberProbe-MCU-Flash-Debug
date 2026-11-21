"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildElf32 } = require("./helpers/elf-fixture");
const { scenario } = require("./helpers/scenario");
const { imageRanges } = require("../src/services/flashImageBounds");
const {
    buildFlashBoundsCommand,
    buildFlashProgramCommand,
    requiresFlashBounds
} = require("../skills/_emberprobe/openocd-flash");
const { diagnoseOpenOcdFailure } = require("../skills/_emberprobe/openocd-diagnostics");
const { parseLine } = require("../src/openocdRunner");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-image-bounds-"));
try {
    scenario("Use ELF physical load addresses including SRAM data and ignore BSS", () => {
        assert(requiresFlashBounds("gigadevice/gd32f30x-3072.cfg"));
        assert(requiresFlashBounds("artery/at32f4x-1024.cfg"));
        assert(requiresFlashBounds("artery/at32f43x-1024.cfg"));
        const file = path.join(directory, "app.elf");
        const flash = 0x08000000;
        const ram = 0x20000000;
        fs.writeFileSync(
            file,
            buildElf32({
                sections: [
                    { name: ".text", flags: 6, addr: flash, offset: 128, size: 8 },
                    { name: ".data", flags: 3, addr: ram, offset: 136, size: 4 },
                    { name: ".bss", flags: 3, addr: ram + 4, type: 8, size: 256 }
                ],
                programHeaders: [
                    { offset: 128, vaddr: flash, paddr: flash, filesz: 8 },
                    { offset: 136, vaddr: ram, paddr: flash + 8, filesz: 4, memsz: 260 }
                ]
            })
        );
        const expected = [
            [flash, flash + 8],
            [flash + 8, flash + 12]
        ];
        assert.deepStrictEqual(imageRanges({ file }), expected);
        assert.deepStrictEqual(imageRanges({ file }, true), expected);
        const zeroPaddrElf = path.join(directory, "zero-paddr.elf");
        fs.writeFileSync(
            zeroPaddrElf,
            buildElf32({
                sections: [
                    { name: ".text", flags: 6, addr: flash, offset: 160, size: 8 },
                    { name: ".rodata", flags: 2, addr: flash + 8, offset: 168, size: 4 }
                ],
                programHeaders: [
                    { type: 0x70000001, offset: 160, vaddr: flash, paddr: flash, filesz: 8, memsz: 8 },
                    { offset: 160, vaddr: flash, paddr: 0, filesz: 8, memsz: 8 },
                    { offset: 168, vaddr: flash + 8, paddr: 0, filesz: 4, memsz: 4 }
                ]
            })
        );
        assert.deepStrictEqual(imageRanges({ file: zeroPaddrElf }), expected);
        assert.deepStrictEqual(imageRanges({ file: zeroPaddrElf }, true), expected);
        assert.throws(() => imageRanges({ file, offset: "-0x08000001" }), /ARM32 address range/);
        const command = buildFlashProgramCommand('"app.elf"', 0, expected);
        assert(command.includes(`{${flash} ${flash + 12}}`), "adjacent intervals are merged");
        assert(command.indexOf("_ep_flash_check") < command.indexOf("set ::_ep_flash_base [_ep_flash_boost"));
        assert.throws(() => buildFlashBoundsCommand([[0x08000000, 0x100000001]]), /address interval/);
    });

    scenario("Validate programmed addresses in HEX and BIN including relocation and malformed input", () => {
        const hex = path.join(directory, "app.hex");
        fs.writeFileSync(hex, ":020000040800F2\n:01001000AA45\n:00000001FF\n");
        assert.deepStrictEqual(imageRanges({ file: hex, format: "hex", offset: "0x100" }), [[0x08000110, 0x08000111]]);
        fs.appendFileSync(hex, ":01001000AA45\n");
        assert.throws(() => imageRanges({ file: hex, format: "hex" }), /Intel HEX record/);
        const bin = path.join(directory, "app.bin");
        fs.writeFileSync(bin, Buffer.alloc(8));
        assert.deepStrictEqual(imageRanges({ file: bin, format: "bin", address: "0x08000000" }), [
            [0x08000000, 0x08000008]
        ]);
        assert.throws(() => imageRanges({ file: bin, format: "bin", address: "0xfffffffc" }), /ARM32 address range/);
        const error = diagnoseOpenOcdFailure([
            "EP_FLASH_BOUNDS_ERROR Image address 0x08010000 is outside the configured Flash banks"
        ]);
        assert.strictEqual(error.code, "FLASH_IMAGE_OUT_OF_RANGE");
        assert.strictEqual(error.retryable, false);
        assert.strictEqual(
            parseLine("EP_FLASH_BOUNDS_ERROR Image address 0x08010000 is outside the configured Flash banks")?.stage,
            "error"
        );
        assert.strictEqual(
            parseLine("GD32 Flash bank: device reports 32 KiB, configuration specifies 64 KiB")?.stage,
            "error"
        );
        const guard = diagnoseOpenOcdFailure([
            "GD32 Flash bank: device reports 32 KiB, configuration specifies 64 KiB",
            "target/gigadevice/gd32f1x0.cfg:39: Error:",
            "shutdown error"
        ]);
        assert.match(guard.message, /device reports 32 KiB/);
    });
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
