"use strict";
const assert = require("assert");
const { readFaultInfo, decodeFaultRegisters, FAULT_REGS, CFSR_BITS, HFSR_BITS } = require("../src/faultInfo");

// Register addresses (SCB, ARMv7-M Architecture Reference Manual)
assert.strictEqual(FAULT_REGS.icsr, 0xe000ed04);
assert.strictEqual(FAULT_REGS.shcsr, 0xe000ed24);
assert.strictEqual(FAULT_REGS.cfsr, 0xe000ed28);
assert.strictEqual(FAULT_REGS.hfsr, 0xe000ed2c);
assert.strictEqual(FAULT_REGS.dfsr, 0xe000ed30);
assert.strictEqual(FAULT_REGS.mmfar, 0xe000ed34);
assert.strictEqual(FAULT_REGS.bfar, 0xe000ed38);
assert.ok(CFSR_BITS.length >= 15 && HFSR_BITS.length === 3);

// Scenario 1: precise bus fault escalated to HardFault (PRECISERR + BFARVALID + FORCED)
const busFault = decodeFaultRegisters({
    cfsr: (1 << 9) | (1 << 15),
    hfsr: 1 << 30,
    bfar: 0x60000000,
    icsr: 3
});
assert.strictEqual(busFault.faultDetected, true);
assert.strictEqual(busFault.bfarValid, true);
const precise = busFault.faults.find((f) => f.flag === "PRECISERR");
assert.ok(precise, "PRECISERR must be decoded");
assert.strictEqual(precise.faultAddress, "0x60000000", "BFAR provides the fault address");
assert.ok(busFault.faults.some((f) => f.flag === "FORCED" && f.register === "HFSR"));
assert.strictEqual(busFault.exception.name, "HardFault");
assert.strictEqual(busFault.exception.number, 3);

// Scenario 2: MPU data access violation (DACCVIOL + MMARVALID)
const memFault = decodeFaultRegisters({
    cfsr: (1 << 1) | (1 << 7),
    hfsr: 0,
    mmfar: 0x10,
    icsr: 4
});
assert.strictEqual(memFault.faultDetected, true);
assert.strictEqual(memFault.mmfarValid, true);
const daccviol = memFault.faults.find((f) => f.flag === "DACCVIOL");
assert.strictEqual(daccviol.faultAddress, "0x00000010", "MMFAR provides the fault address");
assert.strictEqual(memFault.exception.name, "MemManage");

// Scenario 3: UsageFault divide by zero and undefined instruction (no address)
const usageFault = decodeFaultRegisters({ cfsr: (1 << 25) | (1 << 16), hfsr: 0, icsr: 6 });
assert.deepStrictEqual(usageFault.faults.map((f) => f.flag).sort(), ["DIVBYZERO", "UNDEFINSTR"]);
assert.ok(usageFault.faults.every((f) => f.faultAddress === undefined));

// Scenario 4: no fault, thread mode running normally
const clean = decodeFaultRegisters({ cfsr: 0, hfsr: 0, dfsr: 0, icsr: 0 });
assert.strictEqual(clean.faultDetected, false);
assert.deepStrictEqual(clean.faults, []);
assert.strictEqual(clean.exception.name, "Thread");

// Scenario 5: missing registers (not read)
const missing = decodeFaultRegisters({});
assert.strictEqual(missing.faultDetected, false);
assert.strictEqual(missing.exception, null);
assert.strictEqual(decodeFaultRegisters(null).faultDetected, false);

// Scenario 6: external interrupt number decoding
assert.strictEqual(decodeFaultRegisters({ cfsr: 0, icsr: 16 + 37 }).exception.name, "IRQ37");
assert.strictEqual(decodeFaultRegisters({ cfsr: 0, icsr: 15 }).exception.name, "SysTick");

// CPU register reads must be issued as echo [reg ...]. OpenOCD's catch swallows command output, so a bare catch {reg
// pc} never reaches the parser (pc/sp/lr/xPSR all empty). A fake OpenOCD checks the whole chain of Tcl construction and
// output parsing. Node cannot spawn .sh with shell:false on Windows, so this runs on Unix only.
(async () => {
    if (process.platform !== "win32") {
        const fs = require("fs");
        const os = require("os");
        const path = require("path");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-fault-"));
        const bin = path.join(dir, "bin");
        const scripts = path.join(dir, "openocd", "scripts");
        fs.mkdirSync(path.join(scripts, "interface"), { recursive: true });
        fs.mkdirSync(path.join(scripts, "target"), { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(scripts, "interface", "cmsis-dap.cfg"), "");
        fs.writeFileSync(path.join(scripts, "target", "stm32f4x.cfg"), "");
        const fake = path.join(bin, "fake-openocd.sh");
        fs.writeFileSync(
            fake,
            [
                "#!/bin/sh",
                // Only shell builtins: ordinary tests deliberately isolate PATH.
                'case "$*" in *"echo [reg pc]"*)',
                '  echo "pc (/32): 0x080034AC"',
                '  echo "sp (/32): 0x2000FF00"',
                '  echo "lr (/32): 0x08003401"',
                '  echo "xPSR (/32): 0x61000000"',
                ";; esac",
                'echo "0xE000ED28: 00000082"',
                "exit 0",
                ""
            ].join("\n")
        );
        fs.chmodSync(fake, 0o755);
        try {
            const info = await readFaultInfo({
                executable: fake,
                probe: "cmsis-dap.cfg",
                target: "stm32f4x.cfg",
                cwd: dir
            });
            assert.strictEqual(info.pc, "0x080034AC");
            assert.strictEqual(info.sp, "0x2000FF00");
            assert.strictEqual(info.lr, "0x08003401");
            assert.strictEqual(info.xpsr, "0x61000000");
            assert.ok(info.values.cfsr !== undefined, "fault registers must still be captured");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    console.log("Fault info tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
