"use strict";
const assert = require("assert");
const { readFaultInfo, decodeFaultRegisters, FAULT_REGS, CFSR_BITS, HFSR_BITS } = require("../src/faultInfo");

// —— 寄存器地址表（SCB，ARMv7-M 架构手册）——
assert.strictEqual(FAULT_REGS.icsr, 0xE000ED04);
assert.strictEqual(FAULT_REGS.shcsr, 0xE000ED24);
assert.strictEqual(FAULT_REGS.cfsr, 0xE000ED28);
assert.strictEqual(FAULT_REGS.hfsr, 0xE000ED2C);
assert.strictEqual(FAULT_REGS.dfsr, 0xE000ED30);
assert.strictEqual(FAULT_REGS.mmfar, 0xE000ED34);
assert.strictEqual(FAULT_REGS.bfar, 0xE000ED38);
assert.ok(CFSR_BITS.length >= 15 && HFSR_BITS.length === 3);

// —— 场景 1：精确总线错误升级为 HardFault（PRECISERR + BFARVALID + FORCED）——
const busFault = decodeFaultRegisters({
    cfsr: (1 << 9) | (1 << 15),
    hfsr: 1 << 30,
    bfar: 0x60000000,
    icsr: 3
});
assert.strictEqual(busFault.faultDetected, true);
assert.strictEqual(busFault.bfarValid, true);
const precise = busFault.faults.find(f => f.flag === "PRECISERR");
assert.ok(precise, "PRECISERR must be decoded");
assert.strictEqual(precise.faultAddress, "0x60000000", "BFAR provides the fault address");
assert.ok(busFault.faults.some(f => f.flag === "FORCED" && f.register === "HFSR"));
assert.strictEqual(busFault.exception.name, "HardFault");
assert.strictEqual(busFault.exception.number, 3);

// —— 场景 2：MPU 数据访问违例（DACCVIOL + MMARVALID）——
const memFault = decodeFaultRegisters({
    cfsr: (1 << 1) | (1 << 7),
    hfsr: 0,
    mmfar: 0x10,
    icsr: 4
});
assert.strictEqual(memFault.faultDetected, true);
assert.strictEqual(memFault.mmfarValid, true);
const daccviol = memFault.faults.find(f => f.flag === "DACCVIOL");
assert.strictEqual(daccviol.faultAddress, "0x00000010", "MMFAR provides the fault address");
assert.strictEqual(memFault.exception.name, "MemManage");

// —— 场景 3：UsageFault 除零与未定义指令（无地址）——
const usageFault = decodeFaultRegisters({ cfsr: (1 << 25) | (1 << 16), hfsr: 0, icsr: 6 });
assert.deepStrictEqual(usageFault.faults.map(f => f.flag).sort(), ["DIVBYZERO", "UNDEFINSTR"]);
assert.ok(usageFault.faults.every(f => f.faultAddress === undefined));

// —— 场景 4：无故障、线程模式正常运行 ——
const clean = decodeFaultRegisters({ cfsr: 0, hfsr: 0, dfsr: 0, icsr: 0 });
assert.strictEqual(clean.faultDetected, false);
assert.deepStrictEqual(clean.faults, []);
assert.strictEqual(clean.exception.name, "Thread");

// —— 场景 5：寄存器缺失（未读到）——
const missing = decodeFaultRegisters({});
assert.strictEqual(missing.faultDetected, false);
assert.strictEqual(missing.exception, null);
assert.strictEqual(decodeFaultRegisters(null).faultDetected, false);

// —— 场景 6：外部中断号解码 ——
assert.strictEqual(decodeFaultRegisters({ cfsr: 0, icsr: 16 + 37 }).exception.name, "IRQ37");
assert.strictEqual(decodeFaultRegisters({ cfsr: 0, icsr: 15 }).exception.name, "SysTick");

// —— 回归守护：CPU 寄存器读取必须以 echo [reg …] 形式发出 ——
// OpenOCD 的 catch 会吞掉命令输出，裸 catch {reg pc} 的结果永远到不了解析器
// （pc/sp/lr/xPSR 全空）。用假 OpenOCD 验证 Tcl 构造与输出解析的完整链路。
// Windows 上 Node 以 shell:false spawn .sh 会失败，仅 Unix 执行。
(async () => {
    if (process.platform !== "win32") {
        const fs = require("fs");
        const os = require("os");
        const path = require("path");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-fault-"));
        const fake = path.join(dir, "fake-openocd.sh");
        fs.writeFileSync(fake, [
            "#!/bin/sh",
            "if printf '%s' \"$*\" | grep -q 'echo \\[reg pc\\]'; then",
            "  echo \"pc (/32): 0x080034AC\"",
            "  echo \"sp (/32): 0x2000FF00\"",
            "  echo \"lr (/32): 0x08003401\"",
            "  echo \"xPSR (/32): 0x61000000\"",
            "fi",
            "echo \"0xE000ED28: 00000082\"",
            "exit 0",
            ""
        ].join("\n"));
        fs.chmodSync(fake, 0o755);
        try {
            const info = await readFaultInfo({ executable: fake, probe: "cmsis-dap.cfg", target: "stm32f4x.cfg", cwd: dir });
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
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
