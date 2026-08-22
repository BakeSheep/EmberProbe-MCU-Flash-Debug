"use strict";
// 一次性读取 Cortex-M SCB 故障寄存器（CFSR/HFSR/DFSR/MMFAR/BFAR/ICSR/SHCSR）并解码故障位。
// 模式同 chipInfo.readChipInfo：一次性 OpenOCD 命令行 + mdw 输出按地址分派。
// 注意：OpenOCD 0.12.0 中 catch 会吞掉 mdw 输出，必须用 catch { echo [mdw ...] } 形式。
const { spawn } = require("child_process");
const { isSafeCfg, diagnoseOpenOcdFailure } = require("./openocdRunner");
const { parseMdwDump, parseRegLine, parseKv } = require("./chipInfo");

// SCB 故障相关寄存器地址（Cortex-M3/M4/M7/M33 调试地址空间，运行态可直读）
const FAULT_REGS = {
    icsr: 0xE000ED04,
    shcsr: 0xE000ED24,
    cfsr: 0xE000ED28,
    hfsr: 0xE000ED2C,
    dfsr: 0xE000ED30,
    mmfar: 0xE000ED34,
    bfar: 0xE000ED38
};

// CFSR/HFSR 各故障位定义：[寄存器字段, 位号, 标志名]
const CFSR_BITS = [
    // MemManage Fault Status（bits 0-7）
    [0, 'IACCVIOL', 'mem', '取指访问违例（MPU 或 XN 区域执行）'],
    [1, 'DACCVIOL', 'mem', '数据访问违例（MPU 拒绝）'],
    [3, 'MUNSTKERR', 'mem', '异常返回出栈时访问违例'],
    [4, 'MSTKERR', 'mem', '异常进入压栈时访问违例'],
    [5, 'MLSPERR', 'mem', '浮点惰性压栈时访问违例'],
    // BusFault Status（bits 8-15）
    [8, 'IBUSERR', 'bus', '取指总线错误'],
    [9, 'PRECISERR', 'bus', '精确数据总线错误（BFAR 指向出错地址）'],
    [10, 'IMPRECISERR', 'bus', '非精确数据总线错误（写缓冲，PC 已越过出错指令）'],
    [11, 'UNSTKERR', 'bus', '异常返回出栈时总线错误'],
    [12, 'STKERR', 'bus', '异常进入压栈时总线错误（常见于栈溢出）'],
    [13, 'LSPERR', 'bus', '浮点惰性压栈时总线错误'],
    // UsageFault Status（bits 16-31）
    [16, 'UNDEFINSTR', 'usage', '未定义指令'],
    [17, 'INVSTATE', 'usage', '非法 EPSR 状态（如跳转地址缺少 Thumb bit）'],
    [18, 'INVPC', 'usage', '非法 EXC_RETURN / PC 加载'],
    [19, 'NOCP', 'usage', '协处理器不可用（如 FPU 未使能）'],
    [20, 'STKOF', 'usage', '栈溢出（ARMv8-M）'],
    [24, 'UNALIGNED', 'usage', '非对齐访问'],
    [25, 'DIVBYZERO', 'usage', '除零（需 CCR.DIV_0_TRP 使能）']
];
const HFSR_BITS = [
    [1, 'VECTTBL', 'hard', '向量表读取失败（向量表地址/VTOR 异常）'],
    [30, 'FORCED', 'hard', '低优先级故障升级为 HardFault（根因看 CFSR）'],
    [31, 'DEBUGEVT', 'hard', '调试事件引起']
];

// 纯函数：解码故障寄存器，返回 { faultDetected, faults, exception, mmfarValid, bfarValid }
// 输入为数值（undefined/null 表示未读到）
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
            const fault = { register: 'CFSR', flag, group, description };
            if (group === 'mem' && mmfarValid && regs.mmfar !== undefined) {
                fault.faultAddress = '0x' + (Number(regs.mmfar) >>> 0).toString(16).toUpperCase().padStart(8, '0');
            }
            if (flag === 'PRECISERR' && bfarValid && regs.bfar !== undefined) {
                fault.faultAddress = '0x' + (Number(regs.bfar) >>> 0).toString(16).toUpperCase().padStart(8, '0');
            }
            faults.push(fault);
        }
    }
    if (hasHfsr) {
        for (const [bit, flag, group, description] of HFSR_BITS) {
            if (hfsr & (1 << bit)) faults.push({ register: 'HFSR', flag, group, description });
        }
    }
    // ICSR.VECTACTIVE（bits 0-8）：当前活跃异常号（0=线程模式，3=HardFault，4=MemManage，5=BusFault，6=UsageFault）
    const vectactive = icsr & 0x1ff;
    const EXCEPTIONS = { 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 11: 'SVCall', 14: 'PendSV', 15: 'SysTick' };
    const exception = regs?.icsr === undefined || regs?.icsr === null ? null : {
        number: vectactive,
        name: vectactive === 0 ? 'Thread' : (EXCEPTIONS[vectactive] || (vectactive >= 16 ? `IRQ${vectactive - 16}` : `#${vectactive}`))
    };
    return { faultDetected: faults.length > 0, faults, exception, mmfarValid, bfarValid };
}

// 一次性读取故障寄存器与 CPU 寄存器。options: { executable, probe, target, cwd }
// resolve { targetState, registers: {cfsr,...}（十六进制串）, values: {cfsr,...}（数值）, pc, sp, lr, xpsr }
function readFaultInfo(options) {
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) {
        return Promise.reject(new Error(`非法的 OpenOCD 配置名：${options.probe} / ${options.target}`));
    }
    return new Promise((resolve, reject) => {
        const regReads = Object.values(FAULT_REGS).map(a => `catch { echo [mdw 0x${a.toString(16)}] }`);
        // CPU 寄存器需 halt 才能读：记录原状态 → 非 halted 则 halt → 读取 → 若曾 halt 则 resume。
        // catch 会吞掉命令输出，寄存器行必须与 mdw 相同的 echo [...] 形式才能到达 stdout
        const cpuRegCmd = 'catch { set o [[target current] curstate]; set h 0; if {$o ne "halted"} { if {![catch {halt}]} { set h 1 } }; '
            + 'catch { echo [reg pc] }; catch { echo [reg sp] }; catch { echo [reg lr] }; catch { echo [reg xPSR] }; if {$h} { catch { resume } } }';
        const cmds = [
            'init',
            'catch { poll }',
            'catch { echo "EP_KV state [[target current] curstate]" }',
            ...regReads,
            cpuRegCmd,
            'shutdown'
        ];
        const args = ['-f', `interface/${options.probe}`, '-f', `target/${options.target}`];
        for (const c of cmds) { args.push('-c', c); }

        let child;
        try {
            child = spawn(options.executable, args, { cwd: options.cwd, windowsHide: true, shell: false });
        } catch (error) {
            reject(error.code === 'ENOENT' ? Object.assign(new Error(`找不到 OpenOCD：${options.executable}`), { i18nKey: 'run.notFound', i18nParams: { path: options.executable } }) : new Error(error.message));
            return;
        }
        const result = { targetState: '', registers: {}, values: {}, pc: '', sp: '', lr: '', xpsr: '' };
        const addrToKey = new Map(Object.entries(FAULT_REGS).map(([key, addr]) => [addr >>> 0, key]));
        const logTail = [];
        let pending = '';
        let settled = false;

        const finish = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(result);
        };
        const timer = setTimeout(() => {
            if (settled) return;
            try { child.kill(); } catch (e) { /* ignore */ }
            finish(Object.assign(new Error('读取故障寄存器超时（15s）：请检查接线、供电与探针占用情况'), { i18nKey: 'chip.timeout' }));
        }, 15000);

        const handleLine = (raw) => {
            const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();
            if (!clean) return;
            logTail.push(clean.slice(0, 500));
            if (logTail.length > 20) logTail.shift();
            const kv = parseKv(clean);
            if (kv) {
                if (kv.key === 'state' && kv.value) result.targetState = kv.value;
                return;
            }
            const reg = parseRegLine(clean);
            if (reg && ['pc', 'sp', 'lr'].includes(reg.name)) {
                if (!result[reg.name]) result[reg.name] = reg.value;
                return;
            }
            // xPSR 行（parseRegLine 不覆盖）："xPSR (/32): 0x61000000"
            const xpsr = clean.match(/\bxPSR\s*\(\/\d+\)\s*:\s*0x([0-9a-f]+)/i);
            if (xpsr) { if (!result.xpsr) result.xpsr = '0x' + xpsr[1].toUpperCase(); return; }
            const dump = parseMdwDump(clean);
            if (dump) {
                const key = addrToKey.get(dump.addr >>> 0);
                if (key && result.values[key] === undefined) {
                    const word = dump.words[0] >>> 0;
                    result.values[key] = word;
                    result.registers[key] = '0x' + word.toString(16).toUpperCase().padStart(8, '0');
                }
            }
        };
        const onData = (chunk) => {
            pending += chunk.toString();
            let idx;
            while ((idx = pending.indexOf('\n')) >= 0) {
                handleLine(pending.slice(0, idx));
                pending = pending.slice(idx + 1);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (error) => {
            finish(error.code === 'ENOENT'
                ? Object.assign(new Error(`找不到 OpenOCD：${options.executable}`), { i18nKey: 'run.notFound', i18nParams: { path: options.executable } })
                : new Error(error.message));
        });
        child.on('close', (code) => {
            if (pending) handleLine(pending);
            // 只要读到关键故障寄存器即视为成功；否则用 OpenOCD 日志归类失败原因
            if (result.values.cfsr !== undefined || result.values.hfsr !== undefined) {
                finish(null);
                return;
            }
            const diagnostic = diagnoseOpenOcdFailure(logTail, { exitCode: code });
            finish(Object.assign(new Error(diagnostic.message), diagnostic, { code: diagnostic.code || 'FAULT_READ_FAILED' }));
        });
    });
}

module.exports = { readFaultInfo, decodeFaultRegisters, FAULT_REGS, CFSR_BITS, HFSR_BITS };
