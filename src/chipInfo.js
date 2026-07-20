"use strict";
// 通过 OpenOCD 一次性读取芯片基本信息（小栏目定位：快速确认连接状态、芯片系列、调试链路与运行状态）。
// 仅 init、不复位。读取身份信息（Device ID/Flash/UID）时若芯片在运行会短暂 halt→读取→resume（H7 等运行态下读取不可靠）；
// 运行信息(PC/SP/LR)仅在芯片“原本已暂停”时读取，绝不为展示它而暂停运行中的程序。读取完成后立即 shutdown。
const { spawn } = require("child_process");
const { isSafeCfg, parseLine } = require("./openocdRunner");

// Cortex-M SCB CPUID(0xE000ED00) 的 part number → 内核名称
const CORTEX_M_PARTS = {
    0xc20: 'Cortex-M0', 0xc60: 'Cortex-M0+', 0xc21: 'Cortex-M1',
    0xc23: 'Cortex-M3', 0xc24: 'Cortex-M4', 0xc27: 'Cortex-M7',
    0xd20: 'Cortex-M23', 0xd21: 'Cortex-M33', 0xd22: 'Cortex-M35P',
    0xd23: 'Cortex-M55', 0xd24: 'Cortex-M85'
};
// CPUID 的 implementer 字段 → 厂商
const IMPLEMENTERS = { 0x41: 'ARM', 0x44: 'DEC', 0x4a: 'Fujitsu', 0x51: 'Qualcomm', 0x56: 'Marvell', 0x69: 'Intel' };

// 常见 STM32 家族的 96-bit 唯一 ID(UID) 基址；仅收录较确定的家族，未命中则不读取 UID
const STM32_UID_BASE = {
    stm32f0x: 0x1ffff7ac, stm32f1x: 0x1ffff7e8, stm32f2x: 0x1fff7a10,
    stm32f3x: 0x1ffff7ac, stm32f4x: 0x1fff7a10, stm32f7x: 0x1ff0f420,
    stm32g0x: 0x1fff7590, stm32g4x: 0x1fff7590, stm32h7x: 0x1ff1e800,
    stm32l0: 0x1ff80050, stm32l1: 0x1ff80050, stm32l4x: 0x1fff7590,
    stm32wbx: 0x1fff7590, stm32wlx: 0x1fff7590
};
// STM32 DBGMCU_IDCODE（含 DEV_ID/REV_ID）寄存器基址；F0/G0/L0=0x40015800，H7=0x5C001000，其余经典型号=0xE0042000
const STM32_IDCODE_BASE = {
    stm32f0x: 0x40015800, stm32g0x: 0x40015800, stm32l0: 0x40015800, stm32h7x: 0x5c001000,
    stm32f1x: 0xe0042000, stm32f2x: 0xe0042000, stm32f3x: 0xe0042000, stm32f4x: 0xe0042000,
    stm32f7x: 0xe0042000, stm32l1: 0xe0042000, stm32l4x: 0xe0042000, stm32g4x: 0xe0042000,
    stm32wbx: 0xe0042000, stm32wlx: 0xe0042000
};
// STM32 Flash 容量寄存器（F_SIZE，低 16 位为 KB 数）基址
const STM32_FLASHSIZE_BASE = {
    stm32f0x: 0x1ffff7cc, stm32f1x: 0x1ffff7e0, stm32f2x: 0x1fff7a22,
    stm32f3x: 0x1ffff7cc, stm32f4x: 0x1fff7a22, stm32f7x: 0x1ff0f442,
    stm32g0x: 0x1fff75e0, stm32g4x: 0x1fff75e0, stm32h7x: 0x1ff1e880,
    stm32l0: 0x1ff8007c, stm32l4x: 0x1fff75e0, stm32wbx: 0x1fff75e0, stm32wlx: 0x1fff75e0
};

// CPUID 地址（所有 Cortex-M 通用）
const CPUID_ADDR = 0xe000ed00;
const CPUID_HEX = '0x' + CPUID_ADDR.toString(16);
// 经典 DBGMCU_IDCODE 地址（F1/F2/F3/F4/F7/L1/L4/G4/WB/WL 等大多数 STM32 通用）
const CLASSIC_IDCODE_ADDR = 0xe0042000;
// 常见 Flash 容量寄存器回退地址（F1=0x1FFFF7E0，F2/F4=0x1FFF7A22）
const FALLBACK_FLASHSIZE_ADDRS = [0x1ffff7e0, 0x1fff7a22];
// 常见 UID 回退地址（F1/F3=0x1FFFF7E8，F2/F4/L4=0x1FFF7A10）
const FALLBACK_UID_ADDRS = [0x1ffff7e8, 0x1fff7a10];

// STM32 DEV_ID → 芯片家族映射（用于在目标配置与实际芯片不符时修正系列名）
const DEV_ID_FAMILY = {
    0x410: 'STM32F1x', 0x412: 'STM32F1x', 0x414: 'STM32F1x', 0x430: 'STM32F1x',
    0x411: 'STM32F2x', 0x413: 'STM32F4x', 0x419: 'STM32F4x', 0x421: 'STM32F4x',
    0x423: 'STM32F4x', 0x431: 'STM32F4x', 0x433: 'STM32F4x', 0x434: 'STM32F4x',
    0x441: 'STM32F4x', 0x446: 'STM32F4x', 0x448: 'STM32F4x', 0x463: 'STM32F4x',
    0x422: 'STM32F3x', 0x432: 'STM32F3x', 0x438: 'STM32F3x', 0x439: 'STM32F3x',
    0x444: 'STM32F3x', 0x446: 'STM32F3x',
    0x449: 'STM32F7x', 0x451: 'STM32F7x', 0x452: 'STM32F7x',
    0x450: 'STM32H7x', 0x480: 'STM32H7x',
    0x460: 'STM32G0x', 0x466: 'STM32G0x', 0x467: 'STM32G0x', 0x483: 'STM32G0x',
    0x468: 'STM32G4x', 0x469: 'STM32G4x', 0x470: 'STM32G4x',
    0x415: 'STM32L4x', 0x435: 'STM32L4x', 0x461: 'STM32L4x', 0x462: 'STM32L4x',
    0x471: 'STM32L4x', 0x472: 'STM32L4x',
    0x416: 'STM32L1x', 0x427: 'STM32L0x', 0x425: 'STM32L0x', 0x417: 'STM32L0x',
    0x420: 'STM32F0x', 0x426: 'STM32F0x', 0x428: 'STM32F0x',
    0x495: 'STM32WBx'
};

// 解析 SCB CPUID：得到内核、修订（rNpM）与厂商
function decodeCpuid(word) {
    if (word === null || word === undefined || !Number.isFinite(Number(word))) return null;
    const u = Number(word) >>> 0;
    const implementer = (u >>> 24) & 0xff;
    const variant = (u >>> 20) & 0xf;
    const partno = (u >>> 4) & 0xfff;
    const revision = u & 0xf;
    return {
        raw: '0x' + u.toString(16).toUpperCase().padStart(8, '0'),
        core: CORTEX_M_PARTS[partno] || '',
        partno: '0x' + partno.toString(16).toUpperCase(),
        implementer: IMPLEMENTERS[implementer] || ('0x' + implementer.toString(16).toUpperCase()),
        revision: `r${variant}p${revision}`
    };
}

// 解析 mdw 单字输出行（形如 "0xe000ed00: 410fc241"）；给定地址时校验命中，避免误取其它转储行
function parseMdwWord(line, addr) {
    const m = String(line || '').match(/0x0*([0-9a-f]+)\s*:\s*([0-9a-f]{8})\b/i);
    if (!m) return null;
    if (addr !== undefined && parseInt(m[1], 16) !== (addr >>> 0)) return null;
    return parseInt(m[2], 16);
}

// 解析 mdw 多字转储行（形如 "0x1ff1e800: 00360026 32355114 20393443"）→ { addr, words }
function parseMdwDump(line) {
    const m = String(line || '').match(/0x0*([0-9a-f]+)\s*:\s*((?:[0-9a-f]{8}(?:\s+|$))+)/i);
    if (!m) return null;
    const words = m[2].trim().split(/\s+/).filter(Boolean).map(w => parseInt(w, 16));
    if (!words.length) return null;
    return { addr: parseInt(m[1], 16), words };
}

// 解析寄存器行（形如 "pc (/32): 0x080034ac"），并把 r13/r14/r15 归一化为 sp/lr/pc
function parseRegLine(line) {
    const m = String(line || '').match(/(?:^|\s)(pc|sp|lr|msp|psp|r13|r14|r15)\s*\(\/\d+\)\s*:\s*0x([0-9a-f]+)/i);
    if (!m) return null;
    const alias = { r13: 'sp', r14: 'lr', r15: 'pc' };
    const name = alias[m[1].toLowerCase()] || m[1].toLowerCase();
    return { name, value: '0x' + m[2].toUpperCase() };
}

// 解析自定义标记行 "EP_KV key value"（目标名称/状态/字节序/传输协议）
function parseKv(line) {
    const m = String(line || '').match(/EP_KV\s+(\w+)\s+(.+?)\s*$/);
    if (!m) return null;
    return { key: m[1], value: m[2].trim() };
}

// STM32 DBGMCU_IDCODE 拆分：低 12 位 DEV_ID、高 16 位 REV_ID
function splitIdcode(idcode) {
    if (idcode === null || idcode === undefined || idcode === '') return null;
    const u = (typeof idcode === 'string' ? parseInt(idcode, 16) : Number(idcode)) >>> 0;
    if (!Number.isFinite(u)) return null;
    const dev = u & 0xfff;
    const rev = (u >>> 16) & 0xffff;
    return {
        deviceId: '0x' + dev.toString(16).toUpperCase(),
        revId: rev ? '0x' + rev.toString(16).toUpperCase() : ''
    };
}

// 归一化传输协议名（hla_swd/dapdirect_swd/swd → SWD；hla_jtag/jtag → JTAG）
function normalizeTransport(s) {
    const t = String(s || '').toLowerCase();
    if (t.includes('jtag')) return 'JTAG';
    if (t.includes('swd')) return 'SWD';
    return '';
}

// 由目标配置名推断芯片系列（兜底：用户选择的目标本身即代表系列）
function seriesFromTarget(target) {
    const n = String(target || '').replace(/\.cfg$/i, '').split('_')[0];
    if (!n) return '';
    if (/^stm32/i.test(n)) return n.replace(/^stm32([a-z])/i, (m, p1) => 'STM32' + p1.toUpperCase());
    return n.toUpperCase();
}
// 由 flash 驱动名推断芯片系列（硬件实测，优先级高于目标配置名）
// 例如 flash driver 'stm32f1x' → 'STM32F1x'
function seriesFromFlashDriver(driver) {
    const n = String(driver || '').trim();
    if (!n) return '';
    if (/^stm32/i.test(n)) return n.replace(/^stm32([a-z])/i, (m, p1) => 'STM32' + p1.toUpperCase());
    return '';
}

// 通用：由目标配置名（前缀匹配）查表得到寄存器基址；未命中返回 0
function lookupStmBase(map, target) {
    const name = String(target || '').replace(/\.cfg$/i, '').toLowerCase();
    for (const key of Object.keys(map)) {
        if (name.startsWith(key)) return map[key];
    }
    return 0;
}
function uidBaseForTarget(target) { return lookupStmBase(STM32_UID_BASE, target); }
function idcodeBaseForTarget(target) { return lookupStmBase(STM32_IDCODE_BASE, target); }
function flashSizeBaseForTarget(target) { return lookupStmBase(STM32_FLASHSIZE_BASE, target); }

// 把 UID 三个字拼成连续十六进制串（按读取顺序 w0w1w2）
function formatUid(words) {
    if (!Array.isArray(words) || !words.length) return '';
    return '0x' + words.map(w => (w >>> 0).toString(16).toUpperCase().padStart(8, '0')).join('');
}

// 一次性读取芯片信息。options: { executable, probe, target, cwd }
// 成功 resolve 结构化信息对象；连接/识别失败时 reject 并带排查线索。
function readChipInfo(vscode, options, onProgress) {
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) {
        return Promise.reject(new Error(`非法的 OpenOCD 配置名：${options.probe} / ${options.target}`));
    }
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    const uidBase = uidBaseForTarget(options.target);
    const idcodeBase = idcodeBaseForTarget(options.target);
    const flashSizeBase = flashSizeBaseForTarget(options.target);
    return new Promise((resolve, reject) => {
        // 每条读取命令用 catch 包裹，保证单条失败不影响其余命令，最终 shutdown 干净退出。
        // 身份信息（Device ID/Flash/UID）在运行态下（尤其 H7）读取不可靠：若芯片在运行，
        // 则在本块内短暂 halt→读取→resume；原本已暂停则直接读。运行信息(PC/SP/LR)仍仅在“原本已暂停”时读取。
        const idReads = ['catch { flash probe 0 }'];
        if (idcodeBase) idReads.push('catch { echo [mdw 0x' + idcodeBase.toString(16) + '] }');
        // 回退：若目标配置地址与经典地址不同，额外读取经典 IDCODE 地址（覆盖 F1/F4 等大多数经典型号）
        if (!idcodeBase || (idcodeBase >>> 0) !== CLASSIC_IDCODE_ADDR) idReads.push('catch { echo [mdw 0x' + CLASSIC_IDCODE_ADDR.toString(16) + '] }');
        if (flashSizeBase) idReads.push('catch { echo [mdw 0x' + flashSizeBase.toString(16) + '] }');
        // 回退：若目标配置的 Flash 容量地址不在常见列表中，额外读取常见地址
        for (const fb of FALLBACK_FLASHSIZE_ADDRS) {
            if (!flashSizeBase || (flashSizeBase >>> 0) !== fb) idReads.push('catch { echo [mdw 0x' + fb.toString(16) + '] }');
        }
        if (uidBase) idReads.push('catch { echo [mdw 0x' + uidBase.toString(16) + ' 3] }');
        // 回退：若目标配置的 UID 地址不在常见列表中，额外读取常见 UID 地址
        for (const ub of FALLBACK_UID_ADDRS) {
            if (!uidBase || (uidBase >>> 0) !== ub) idReads.push('catch { echo [mdw 0x' + ub.toString(16) + ' 3] }');
        }
        // 一个 -c 内完成：记录原状态 → 若非 halted 则 halt → 读取 → 若曾 halt 则 resume（确保不把用户程序留在暂停态）
        const identityCmd = 'catch { set o [[target current] curstate]; set h 0; if {$o ne "halted"} { if {![catch {halt}]} { set h 1 } }; '
            + idReads.join('; ') + '; if {$h} { catch { resume } } }';
        const cmds = [
            'init',
            'catch { poll }',
            'catch { echo "EP_KV name [target current]" }',
            'catch { echo "EP_KV state [[target current] curstate]" }',
            'catch { echo "EP_KV endian [[target current] cget -endian]" }',
            'catch { echo "EP_KV transport [transport select]" }',
            `catch { echo [mdw ${CPUID_HEX}] }`,
            identityCmd,
            'catch { if {[[target current] curstate] eq "halted"} { catch {reg pc}; catch {reg sp}; catch {reg lr} } }',
            'shutdown'
        ];
        const args = ['-f', `interface/${options.probe}`, '-f', `target/${options.target}`];
        for (const c of cmds) { args.push('-c', c); }

        let child;
        try {
            child = spawn(options.executable, args, { cwd: options.cwd, windowsHide: true, shell: false });
        } catch (error) {
            reject(new Error(error.code === 'ENOENT' ? `找不到 OpenOCD：${options.executable}` : error.message));
            return;
        }
        report({ stage: 'start', message: '正在读取芯片信息…' });
        const info = {
            // 内核
            core: '', coreRevision: '', cpuid: '', implementer: '',
            // 芯片系列
            chip: '', series: seriesFromTarget(options.target),
            // 芯片信息
            idcode: '', deviceId: '', revId: '', flashSize: '', flashBase: '', flashDriver: '', endian: '', uid: '',
            // 调试连接
            probeName: '', probeVersion: '', probe: '', transport: '', clock: '', voltage: '', targetName: '',
            // 运行信息
            targetState: '', haltReason: '', pc: '', sp: '', lr: ''
        };
        const errors = [];
        const rawTail = [];
        const rawAll = [];
        let transportLog = '';
        let pending = '';
        let settled = false;
        let spawnFailed = false;

        const finish = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { report({ stage: 'raw', commands: cmds.slice(), lines: rawAll.slice() }); } catch (e) { /* ignore */ }
            if (err) reject(err);
            else resolve(info);
        };
        // 正常流程会 shutdown 退出；超时兜底避免探针异常时永久挂起
        const timer = setTimeout(() => {
            if (settled) return;
            try { child.kill(); } catch (e) { /* ignore */ }
            finish(new Error('读取芯片信息超时（15s）：请检查接线、供电与探针占用情况'));
        }, 15000);

        const handleLine = (raw) => {
            const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();
            if (!clean) return;
            rawTail.push(clean);
            if (rawTail.length > 12) rawTail.shift();
            rawAll.push(clean);
            if (rawAll.length > 400) rawAll.shift();

            // 1) 自定义标记：目标名称/状态/字节序/传输协议
            const kv = parseKv(clean);
            if (kv) {
                if (kv.key === 'name' && kv.value) info.targetName = kv.value;
                else if (kv.key === 'state' && kv.value) info.targetState = kv.value;
                else if (kv.key === 'endian' && kv.value) info.endian = kv.value;
                else if (kv.key === 'transport' && !info.transport) info.transport = normalizeTransport(kv.value);
                return;
            }
            // 2) 寄存器行（仅在已暂停时 OpenOCD 才会输出）
            const reg = parseRegLine(clean);
            if (reg && (reg.name === 'pc' || reg.name === 'sp' || reg.name === 'lr')) {
                if (!info[reg.name]) info[reg.name] = reg.value;
                return;
            }
            // 3) mdw 读取（CPUID / DBGMCU IDCODE / FLASHSIZE / UID），按地址分派——不依赖 flash 驱动的日志措辞
            const dump = parseMdwDump(clean);
            if (dump) {
                const a = dump.addr >>> 0;
                if (a === (CPUID_ADDR >>> 0)) {
                    const d = decodeCpuid(dump.words[0]);
                    if (d) {
                        info.cpuid = d.raw;
                        if (d.core && !info.core) info.core = d.core; // "processor detected" 行已给出内核时不覆盖
                        if (!info.coreRevision) info.coreRevision = d.revision;
                        info.implementer = d.implementer;
                    }
                    return;
                }
                if (idcodeBase && a === (idcodeBase >>> 0)) {
                    const w = dump.words[0] >>> 0;
                    if (!info.idcode && (w & 0xfff) !== 0 && (w & 0xfff) !== 0xfff) info.idcode = '0x' + w.toString(16).toUpperCase();
                    return;
                }
                // 经典 IDCODE 地址回退（目标配置地址无效时仍能识别芯片）
                if (a === CLASSIC_IDCODE_ADDR && (!idcodeBase || (idcodeBase >>> 0) !== CLASSIC_IDCODE_ADDR)) {
                    const w = dump.words[0] >>> 0;
                    if (!info._idcodeClassic && (w & 0xfff) !== 0 && (w & 0xfff) !== 0xfff) info._idcodeClassic = '0x' + w.toString(16).toUpperCase();
                    return;
                }
                if (flashSizeBase && a === (flashSizeBase >>> 0)) {
                    const kb = dump.words[0] & 0xffff;
                    if (kb > 0 && kb < 0xffff) info.flashSize = kb + ' KiB'; // 寄存器权威，覆盖 flash probe 的回退值
                    return;
                }
                // Flash 容量回退地址
                if (FALLBACK_FLASHSIZE_ADDRS.includes(a) && (!flashSizeBase || (flashSizeBase >>> 0) !== a)) {
                    const kb = dump.words[0] & 0xffff;
                    if (kb > 0 && kb < 0xffff && !info._flashSizeFallback) info._flashSizeFallback = kb + ' KiB';
                    return;
                }
                if (uidBase && a === (uidBase >>> 0) && dump.words.length >= 3) {
                    if (!info.uid) info.uid = formatUid(dump.words.slice(0, 3));
                    return;
                }
                // UID 回退地址
                if (FALLBACK_UID_ADDRS.includes(a) && (!uidBase || (uidBase >>> 0) !== a) && dump.words.length >= 3) {
                    if (!info._uidFallback) info._uidFallback = formatUid(dump.words.slice(0, 3));
                    return;
                }
            }
            let m;
            // 5) 内核识别行：Info : [xxx] Cortex-M4 r0p1 processor detected（比 CPUID 更直观且更早出现）
            if (/processor detected/i.test(clean) && (m = clean.match(/\b(Cortex-[MAR]\d+\+?)\s+(r\d+p\d+)\b/i))) {
                if (!info.core) info.core = m[1];
                if (!info.coreRevision) info.coreRevision = m[2];
                return;
            }
            // 6) 探针家族与版本
            if (/CMSIS-DAP/i.test(clean)) {
                if (!info.probeName) info.probeName = 'CMSIS-DAP';
                if (!info.probeVersion) {
                    const fw = clean.match(/FW Version\s*=\s*v?([\w.]+)/i);
                    if (fw) info.probeVersion = 'v' + fw[1];
                    else if (/CMSIS-DAPv2/i.test(clean)) info.probeVersion = 'v2';
                }
            } else if (/ST-?LINK/i.test(clean)) {
                if (!info.probeName) info.probeName = 'ST-Link';
                const v = clean.match(/\b(V\d[A-Z]\w*)\b/);
                if (v && !info.probeVersion) info.probeVersion = v[1];
            } else if (/J-?Link/i.test(clean)) {
                if (!info.probeName) info.probeName = 'J-Link';
            } else if (/DAPLink/i.test(clean)) {
                if (!info.probeName) info.probeName = 'DAPLink';
            }
            // 7) 传输协议（日志兜底：DAP 打印 SWD DPIDR；JTAG 打印 JTAG tap:）
            if (!transportLog) {
                if (/SWD DPIDR/i.test(clean)) transportLog = 'SWD';
                else if (/JTAG tap:/i.test(clean)) transportLog = 'JTAG';
            }
            // 8) 停止原因（仅当发生 halt 事件时才会出现，通常不主动触发）
            if (!info.haltReason) {
                const hr = clean.match(/halted due to\s+([^,]+)/i);
                if (hr) info.haltReason = hr[1].trim();
            }
            // 9) flash 'driver' found at 0x...
            if ((m = clean.match(/flash\s+'([^']+)'\s+found\s+at\s+(0x[0-9a-f]+)/i))) {
                if (!info.flashDriver) info.flashDriver = m[1];
                if (!info.flashBase) info.flashBase = m[2];
            }
            // 9.5) 部分驱动（如 H7）打印 "flash size probed value 2048"（单位 KB），补充非 "flash size =" 措辞
            if (!info.flashSize) {
                const fp = clean.match(/flash size probed value\s+(\d+)/i);
                if (fp) info.flashSize = fp[1] + ' KiB';
            }
            // 10) 复用固件下载的日志解析：probe / adapter / voltage / chip / flash
            const event = parseLine(clean);
            if (!event) return;
            if (event.stage === 'probe') { if (!info.probe) info.probe = event.message; }
            else if (event.stage === 'adapter') { if (event.clock && !info.clock) info.clock = event.clock; }
            else if (event.stage === 'voltage') { if (typeof event.volts === 'number') info.voltage = event.volts.toFixed(2) + ' V'; }
            else if (event.stage === 'chip') { if (event.chip) info.chip = event.chip; if (event.deviceId && !info.idcode) info.idcode = event.deviceId; }
            else if (event.stage === 'flash') { if (event.flashSize && !info.flashSize) info.flashSize = normalizeFlashSize(event.flashSize); }
            else if (event.stage === 'error') { if (!errors.includes(event.message)) errors.push(event.message); }
        };

        const consume = (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) handleLine(line);
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        child.on('error', (error) => {
            spawnFailed = true;
            finish(new Error(error.code === 'ENOENT' ? `找不到 OpenOCD：${options.executable}` : error.message));
        });
        child.on('close', (code) => {
            if (spawnFailed) return; // spawn 失败已由 error 事件处理
            if (pending) { handleLine(pending); pending = ''; }
            // 传输协议与 Device/Revision ID 的最终归并
            if (!info.transport && transportLog) info.transport = transportLog;
            // 若目标配置地址未读到有效 IDCODE，使用经典地址回退值
            if (!info.idcode && info._idcodeClassic) info.idcode = info._idcodeClassic;
            if (info.idcode) {
                const split = splitIdcode(info.idcode);
                if (split) { info.deviceId = split.deviceId; info.revId = split.revId; }
            }
            // Flash 容量回退
            if (!info.flashSize && info._flashSizeFallback) info.flashSize = info._flashSizeFallback;
            // UID 回退
            if (!info.uid && info._uidFallback) info.uid = info._uidFallback;
            // 由 DEV_ID 推断实际芯片家族，修正目标配置名推导的系列（用户选错 target 时仍能正确显示）
            if (info.deviceId) {
                const devNum = parseInt(info.deviceId, 16);
                const family = DEV_ID_FAMILY[devNum];
                if (family && family !== info.series) info.series = family;
            }
            // 硬件实测的 flash 驱动名优先于目标配置名修正系列（避免用户选错 target 时显示错误系列）
            const hwSeries = seriesFromFlashDriver(info.flashDriver);
            if (hwSeries && hwSeries !== info.series && !DEV_ID_FAMILY[parseInt(info.deviceId || '0', 16)]) info.series = hwSeries;
            // 拿到芯片层关键信息即视为成功；仅有适配器层字段（探针名/时钟/目标名）但存在错误时仍报错
            const gotChip = info.core || info.chip || info.idcode || info.flashSize || info.uid;
            const gotAny = gotChip || info.targetName || info.clock || info.probeName;
            if (gotChip || (gotAny && !errors.length)) {
                delete info._idcodeClassic;
                delete info._flashSizeFallback;
                delete info._uidFallback;
                report({ stage: 'done', message: '读取完成' });
                finish(null);
                return;
            }
            const reason = errors.length
                ? errors.slice(-3).join('；')
                : (rawTail.slice(-3).join('；') || (code === 0 ? '未获取到芯片信息' : `OpenOCD 退出码 ${code}`));
            finish(new Error(reason));
        });
    });
}

// 统一 Flash 容量展示：把 OpenOCD 的 "kbytes/kbyte" 归一为 "KiB"
function normalizeFlashSize(text) {
    return String(text || '').replace(/kbytes?/i, 'KiB').replace(/\s+/g, ' ').trim();
}

module.exports = {
    readChipInfo, decodeCpuid, parseMdwWord, parseMdwDump, parseRegLine, parseKv,
    splitIdcode, normalizeTransport, seriesFromTarget, seriesFromFlashDriver, uidBaseForTarget, idcodeBaseForTarget,
    flashSizeBaseForTarget, formatUid, normalizeFlashSize, CORTEX_M_PARTS, IMPLEMENTERS,
    CPUID_ADDR, CLASSIC_IDCODE_ADDR, FALLBACK_FLASHSIZE_ADDRS, FALLBACK_UID_ADDRS, DEV_ID_FAMILY,
    STM32_UID_BASE, STM32_IDCODE_BASE, STM32_FLASHSIZE_BASE
};
