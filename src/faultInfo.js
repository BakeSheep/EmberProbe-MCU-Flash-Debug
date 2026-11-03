"use strict";
// Reads the Cortex-M SCB fault registers (CFSR/HFSR/DFSR/MMFAR/BFAR/ICSR/SHCSR) in one OpenOCD run and decodes the
// fault bits, dispatching mdw output by address like chipInfo.readChipInfo. OpenOCD 0.12.0's catch swallows mdw output,
// so the catch { echo [mdw ...] } form is required.
const { isSafeCfg, diagnoseOpenOcdFailure } = require("./openocdRunner");
const { parseMdwDump, parseRegLine, parseKv } = require("./chipInfo");
const { runOpenOcdOnce } = require("./services/openocdExec");

// SCB fault register addresses (Cortex-M3/M4/M7/M33 debug address space, readable while running)
const FAULT_REGS = {
    icsr: 0xe000ed04,
    shcsr: 0xe000ed24,
    cfsr: 0xe000ed28,
    hfsr: 0xe000ed2c,
    dfsr: 0xe000ed30,
    mmfar: 0xe000ed34,
    bfar: 0xe000ed38
};

// CFSR/HFSR fault bits: [register field, bit, flag name]
/** @type {Array<[number, string, string, string]>} */
const CFSR_BITS = [
    // MemManage fault status (bits 0-7)
    [0, "IACCVIOL", "mem", "取指访问违例（MPU 或 XN 区域执行）"],
    [1, "DACCVIOL", "mem", "数据访问违例（MPU 拒绝）"],
    [3, "MUNSTKERR", "mem", "异常返回出栈时访问违例"],
    [4, "MSTKERR", "mem", "异常进入压栈时访问违例"],
    [5, "MLSPERR", "mem", "浮点惰性压栈时访问违例"],
    // BusFault status (bits 8-15)
    [8, "IBUSERR", "bus", "取指总线错误"],
    [9, "PRECISERR", "bus", "精确数据总线错误（BFAR 指向出错地址）"],
    [10, "IMPRECISERR", "bus", "非精确数据总线错误（写缓冲，PC 已越过出错指令）"],
    [11, "UNSTKERR", "bus", "异常返回出栈时总线错误"],
    [12, "STKERR", "bus", "异常进入压栈时总线错误（常见于栈溢出）"],
    [13, "LSPERR", "bus", "浮点惰性压栈时总线错误"],
    // UsageFault status (bits 16-31)
    [16, "UNDEFINSTR", "usage", "未定义指令"],
    [17, "INVSTATE", "usage", "非法 EPSR 状态（如跳转地址缺少 Thumb bit）"],
    [18, "INVPC", "usage", "非法 EXC_RETURN / PC 加载"],
    [19, "NOCP", "usage", "协处理器不可用（如 FPU 未使能）"],
    [20, "STKOF", "usage", "栈溢出（ARMv8-M）"],
    [24, "UNALIGNED", "usage", "非对齐访问"],
    [25, "DIVBYZERO", "usage", "除零（需 CCR.DIV_0_TRP 使能）"]
];
/** @type {Array<[number, string, string, string]>} */
const HFSR_BITS = [
    [1, "VECTTBL", "hard", "向量表读取失败（向量表地址/VTOR 异常）"],
    [30, "FORCED", "hard", "低优先级故障升级为 HardFault（根因看 CFSR）"],
    [31, "DEBUGEVT", "hard", "调试事件引起"]
];

// Pure decoder for the fault registers, returning { faultDetected, faults, exception, mmfarValid, bfarValid }. Inputs
// are numbers; undefined/null means not read.
function decodeFaultRegisters(regs) {
    const cfsr = Number(regs?.cfsr) >>> 0;
    const hfsr = Number(regs?.hfsr) >>> 0;
    const icsr = Number(regs?.icsr) >>> 0;
    const hasCfsr = regs?.cfsr !== undefined && regs?.cfsr !== null;
    const hasHfsr = regs?.hfsr !== undefined && regs?.hfsr !== null;
    const faults = [];
    const mmfarValid = hasCfsr && !!(cfsr & (1 << 7));
    const bfarValid = hasCfsr && !!(cfsr & (1 << 15));
    if (hasCfsr) {
        for (const [bit, flag, group, description] of CFSR_BITS) {
            if (!(cfsr & (1 << bit))) continue;
            const fault = { register: "CFSR", flag, group, description };
            if (group === "mem" && mmfarValid && regs.mmfar !== undefined) {
                fault.faultAddress = "0x" + (Number(regs.mmfar) >>> 0).toString(16).toUpperCase().padStart(8, "0");
            }
            if (flag === "PRECISERR" && bfarValid && regs.bfar !== undefined) {
                fault.faultAddress = "0x" + (Number(regs.bfar) >>> 0).toString(16).toUpperCase().padStart(8, "0");
            }
            faults.push(fault);
        }
    }
    if (hasHfsr) {
        for (const [bit, flag, group, description] of HFSR_BITS) {
            if (hfsr & (1 << bit)) faults.push({ register: "HFSR", flag, group, description });
        }
    }
    // ICSR.VECTACTIVE (bits 0-8): active exception number (0 = thread mode, 3 = HardFault, 4 = MemManage, 5 = BusFault,
    // 6 = UsageFault)
    const vectactive = icsr & 0x1ff;
    const exception =
        regs?.icsr === undefined || regs?.icsr === null
            ? null
            : { number: vectactive, name: exceptionName(vectactive) };
    return { faultDetected: faults.length > 0, faults, exception, mmfarValid, bfarValid };
}

const EXCEPTIONS = {
    2: "NMI",
    3: "HardFault",
    4: "MemManage",
    5: "BusFault",
    6: "UsageFault",
    11: "SVCall",
    14: "PendSV",
    15: "SysTick"
};

function exceptionName(number) {
    if (number === 0) return "Thread";
    return EXCEPTIONS[number] || (number >= 16 ? `IRQ${number - 16}` : `#${number}`);
}

// Pure decoder for the halted execution context: the exception the core was executing (IPSR, xPSR bits 0-8) and the
// interrupt masks. Hex string inputs; empty means not read. Returns null without xPSR.
function decodeExecutionContext(raw) {
    const hex = (value) => (/^0x[0-9a-f]+$/i.test(String(value || "")) ? parseInt(value, 16) >>> 0 : null);
    const xpsr = hex(raw?.xpsr);
    if (xpsr === null) return null;
    const ipsr = xpsr & 0x1ff;
    const masks = {};
    for (const name of ["primask", "basepri", "faultmask"]) {
        const value = hex(raw?.[name]);
        if (value !== null) masks[name] = value;
    }
    return {
        mode: ipsr === 0 ? "thread" : "handler",
        exception: { number: ipsr, name: exceptionName(ipsr), ...(ipsr >= 16 ? { irq: ipsr - 16 } : {}) },
        masks
    };
}

// PC samples taken after the first halt when the target was running, to tell a tight loop from code that moves on
const PC_SAMPLES = 4;
const PC_SAMPLE_INTERVAL_MS = 10;

// CPU registers need a halt: record the state, halt if not halted, read, and resume if this run halted. catch swallows
// command output, so register lines need the same echo [...] form as mdw to reach stdout. In an exception the vector
// table entry for IPSR (at VTOR) names the handler. A run that halted the target also samples PC a few times, resuming
// in between, and always ends running.
function cpuRegisterCommand() {
    const word =
        "proc _ep_fault_word {address} { " +
        "if {[catch {read_memory $address 32 1} words]} { " +
        "if {[catch {mem2array _ep_fault_words 32 $address 1}]} { return {} }; set words $_ep_fault_words(0) }; " +
        "return [lindex $words 0] }; ";
    const handler =
        "catch { if {[regexp {0x([0-9a-fA-F]+)} [reg xPSR] -> _ep_x]} { set _ep_n [expr {[scan $_ep_x %x] & 0x1ff}]; " +
        "if {$_ep_n >= 2} { set _ep_vtor [_ep_fault_word 0xe000ed08]; " +
        'set _ep_h [_ep_fault_word [expr {($_ep_vtor & 0xffffff80) + 4 * $_ep_n}]]; echo [format "EP_KV handler 0x%08X" $_ep_h] } } }; ';
    const samples =
        `for {set _ep_i 0} {$_ep_i < ${PC_SAMPLES}} {incr _ep_i} { catch { resume }; sleep ${PC_SAMPLE_INTERVAL_MS}; ` +
        'if {[catch {halt}]} { break }; catch { echo "EP_PC_SAMPLE [reg pc]" } }; ';
    return (
        word +
        'catch { set o [[target current] curstate]; set h 0; if {$o ne "halted"} { if {![catch {halt}]} { set h 1 } }; ' +
        "catch { echo [reg pc] }; catch { echo [reg sp] }; catch { echo [reg lr] }; catch { echo [reg xPSR] }; " +
        "catch { echo [reg primask] }; catch { echo [reg basepri] }; catch { echo [reg faultmask] }; " +
        handler +
        `if {$h} { ${samples}catch { resume } } }`
    );
}

// Reads fault and CPU registers in one run. options: { executable, probe, target, cwd }. Resolves { targetState,
// registers: {cfsr,...} (hex strings), values: {cfsr,...} (numbers), pc, sp, lr, xpsr, primask, basepri, faultmask,
// handler (vector table entry of the active exception), pcSamples (hex strings) }
async function readFaultInfo(options) {
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) {
        return Promise.reject(new Error(`非法的 OpenOCD 配置名：${options.probe} / ${options.target}`));
    }
    const regReads = Object.values(FAULT_REGS).map((a) => `catch { echo [mdw 0x${a.toString(16)}] }`);
    const cmds = [
        "init",
        "catch { poll }",
        'catch { echo "EP_KV state [[target current] curstate]" }',
        ...regReads,
        cpuRegisterCommand(),
        "shutdown"
    ];
    const result = {
        targetState: "",
        registers: {},
        values: {},
        pc: "",
        sp: "",
        lr: "",
        xpsr: "",
        primask: "",
        basepri: "",
        faultmask: "",
        handler: "",
        pcSamples: []
    };
    const addrToKey = new Map(Object.entries(FAULT_REGS).map(([key, addr]) => [addr >>> 0, key]));

    const handleLine = (raw) => {
        const clean = raw;
        if (!clean) return;
        const kv = parseKv(clean);
        if (kv) {
            if (kv.key === "state" && kv.value) result.targetState = kv.value;
            if (kv.key === "handler" && /^0x[0-9a-f]{8}$/i.test(kv.value) && !result.handler)
                result.handler = "0x" + kv.value.slice(2).toUpperCase();
            return;
        }
        // Checked before parseRegLine, which would also match the "pc (/32): ..." text inside a sample line
        const sample = clean.match(/EP_PC_SAMPLE\b.*?0x([0-9a-f]+)/i);
        if (sample) {
            if (result.pcSamples.length < PC_SAMPLES) result.pcSamples.push("0x" + sample[1].toUpperCase());
            return;
        }
        const mask = clean.match(/(?:^|\s)(primask|basepri|faultmask)\s*\(\/\d+\)\s*:\s*0x([0-9a-f]+)/i);
        if (mask) {
            const name = mask[1].toLowerCase();
            if (!result[name]) result[name] = "0x" + mask[2].toUpperCase();
            return;
        }
        const reg = parseRegLine(clean);
        if (reg && ["pc", "sp", "lr"].includes(reg.name)) {
            if (!result[reg.name]) result[reg.name] = reg.value;
            return;
        }
        // xPSR line (not covered by parseRegLine): "xPSR (/32): 0x61000000"
        const xpsr = clean.match(/\bxPSR\s*\(\/\d+\)\s*:\s*0x([0-9a-f]+)/i);
        if (xpsr) {
            if (!result.xpsr) result.xpsr = "0x" + xpsr[1].toUpperCase();
            return;
        }
        const dump = parseMdwDump(clean);
        if (dump) {
            const key = addrToKey.get(dump.addr >>> 0);
            if (key && result.values[key] === undefined) {
                const word = dump.words[0] >>> 0;
                result.values[key] = word;
                result.registers[key] = "0x" + word.toString(16).toUpperCase().padStart(8, "0");
            }
        }
    };
    const execution = await runOpenOcdOnce({
        executable: options.executable,
        probe: options.probe,
        target: options.target,
        transport: options.transport,
        probeSerial: options.probeSerial,
        adapterSerial: options.adapterSerial,
        adapterBackend: options.adapterBackend,
        targetCheck: options.targetCheck,
        adapterSpeedKhz: options.adapterSpeedKhz,
        inventory: options.inventory,
        cwd: options.cwd,
        timeoutMs: 15000,
        waitForCloseOnTimeout: true,
        buildCommands: () => cmds,
        onLine: handleLine,
        buildTimeoutError: () =>
            Object.assign(new Error("读取故障寄存器超时（15s）：请检查接线、供电与探针占用情况"), {
                i18nKey: "chip.timeout"
            })
    });
    // Succeeds once the key fault registers are read; otherwise the OpenOCD log classifies the failure
    if (result.values.cfsr !== undefined || result.values.hfsr !== undefined) return result;
    const diagnostic =
        execution.diagnostic ||
        diagnoseOpenOcdFailure(execution.openocdTail, { probe: options.probe, exitCode: execution.exitCode });
    throw Object.assign(new Error(diagnostic.message), diagnostic, { code: diagnostic.code || "FAULT_READ_FAILED" });
}

module.exports = { readFaultInfo, decodeFaultRegisters, decodeExecutionContext, FAULT_REGS, CFSR_BITS, HFSR_BITS };
