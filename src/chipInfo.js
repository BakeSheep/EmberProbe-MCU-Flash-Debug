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
// CoreSight ROM Table（0xE00FF000）的外围/组件 ID 寄存器：PIDR 中的 JEP106 设计者代码是最可靠的厂商指纹，
// 兼容芯片可以照抄 DBGMCU_IDCODE，但正规厂商不会伪造 ST 的 JEDEC 设计者代码
const ROM_PIDR4_ADDR = 0xe00fffd0; // PIDR4-7（PIDR4[3:0] = JEP106 延续码）
const ROM_PIDR0_ADDR = 0xe00fffe0; // PIDR0-3（器件号 + JEP106 识别码）
const ROM_CIDR_ADDR = 0xe00ffff0;  // CIDR0-3（前导码 0xB105xx0D，用于确认 PIDR 可信）
// 经典 DBGMCU_IDCODE 地址（F1/F2/F3/F4/F7/L1/L4/G4/WB/WL 等大多数 STM32 通用）
const CLASSIC_IDCODE_ADDR = 0xe0042000;
// 常见 Flash 容量寄存器回退地址（F1=0x1FFFF7E0，F2/F4=0x1FFF7A22）
const FALLBACK_FLASHSIZE_ADDRS = [0x1ffff7e0, 0x1fff7a22];
// 常见 UID 回退地址（F1/F3=0x1FFFF7E8，F2/F4/L4=0x1FFF7A10）
const FALLBACK_UID_ADDRS = [0x1ffff7e8, 0x1fff7a10];
// 全家族候选地址集：目标配置可能选错（如 H750 误选 stm32f1x），故每次扫描全部已知地址，
// 再按读到的 DEV_ID 锁定真实家族后选取对应地址的值（单条 mdw 很快，失败由 catch 吞掉）
const ALL_IDCODE_ADDRS = Array.from(new Set([CLASSIC_IDCODE_ADDR, ...Object.values(STM32_IDCODE_BASE)]));
const ALL_FLASHSIZE_ADDRS = Array.from(new Set([...FALLBACK_FLASHSIZE_ADDRS, ...Object.values(STM32_FLASHSIZE_BASE)]));
const ALL_UID_ADDRS = Array.from(new Set([...FALLBACK_UID_ADDRS, ...Object.values(STM32_UID_BASE)]));
const IDCODE_ADDR_SET = new Set(ALL_IDCODE_ADDRS);
const FLASHSIZE_ADDR_SET = new Set(ALL_FLASHSIZE_ADDRS);
const UID_ADDR_SET = new Set(ALL_UID_ADDRS);

// STM32 DEV_ID → 芯片家族映射（用于在目标配置与实际芯片不符时修正系列名）
const DEV_ID_FAMILY = {
    0x410: 'STM32F1x', 0x412: 'STM32F1x', 0x414: 'STM32F1x', 0x430: 'STM32F1x',
    0x411: 'STM32F2x', 0x413: 'STM32F4x', 0x419: 'STM32F4x', 0x421: 'STM32F4x',
    0x423: 'STM32F4x', 0x431: 'STM32F4x', 0x433: 'STM32F4x', 0x434: 'STM32F4x',
    0x441: 'STM32F4x', 0x448: 'STM32F4x', 0x463: 'STM32F4x',
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

// JEP106 设计者代码 → 厂商名（键为 "延续码:识别码"，摘自 JEDEC JEP106 正式列表，收录 Cortex-M MCU 常见厂商）
const JEP106_DESIGNERS = {
    '0:0x0e': 'Freescale (NXP)', '0:0x15': 'NXP', '0:0x17': 'Texas Instruments',
    '0:0x1f': 'Atmel (Microchip)', '0:0x20': 'STMicroelectronics', '0:0x29': 'Microchip',
    '0:0x34': 'Cypress (Infineon)', '0:0x41': 'Infineon', '0:0x65': 'Analog Devices',
    '2:0x21': 'Silicon Labs', '2:0x44': 'Nordic Semiconductor',
    '4:0x23': 'Renesas', '4:0x3b': 'Arm', '4:0x71': 'Toshiba',
    '6:0x48': 'GigaDevice', '7:0x21': 'Fudan Microelectronics', '7:0x36': 'HiSilicon',
    '7:0x51': 'GigaDevice (Beijing)', '8:0x1b': 'Ambiq Micro', '8:0x2d': 'Nuvoton',
    '8:0x79': 'Realtek', '9:0x05': 'Puya Semiconductor', '9:0x13': 'Raspberry Pi',
    '9:0x3b': 'Artery Technology', '9:0x4f': 'Puya Semiconductor (Shenzhen)',
    '11:0x23': 'Apex Microelectronics (Geehy)', '11:0x2d': 'Goodix', '11:0x68': 'Hangshun Chip Technology',
    '12:0x12': 'Espressif'
};
// ST 的 JEP106 键：M0/M3/M4 等经典内核上 ST 会定制 0xE00FF000 的 ROM 表（设计者 ST、器件号=DEV_ID）
const ST_JEP106_KEY = '0:0x20';
// Arm 的 JEP106 键：M7/M23/M33 等新内核上 0xE00FF000 是 Arm 内核自带 ROM 表（器件号 0x4Cx），
// 原厂 ST 芯片也会读到 Arm，因此 Arm 不能作为“非原厂”的证据，只能视为无法判定
const ARM_JEP106_KEY = '4:0x3b';
// 已知 STM32 兼容芯片厂商 → 产品线品牌（识别为兼容芯片时给出直观提示）
const COMPAT_BRANDS = {
    '11:0x23': 'Geehy APM32', '6:0x48': 'GigaDevice GD32', '7:0x51': 'GigaDevice GD32',
    '9:0x3b': 'Artery AT32', '11:0x68': 'HK32', '9:0x05': 'Puya PY32', '9:0x4f': 'Puya PY32',
    '7:0x21': 'Fudan FM33'
};

// 解析 CoreSight ROM 表的 PIDR/CIDR：得到 JEP106 设计者（厂商指纹）与器件号。
// pidr03/pidr47/cidr 均为 4 个 32 位字；CIDR 前导码不合法或未使用 JEDEC 编码时返回 null
function decodeRomPidr(pidr03, pidr47, cidr) {
    if (!Array.isArray(pidr03) || pidr03.length < 4 || !Array.isArray(pidr47) || pidr47.length < 1) return null;
    if (!Array.isArray(cidr) || cidr.length < 4) return null;
    // CIDR 前导码固定为 0x0D / 0xX0 / 0x05 / 0xB1（CIDR1 高 4 位为组件类型）
    if ((cidr[0] & 0xff) !== 0x0d || (cidr[1] & 0x0f) !== 0x00 || (cidr[2] & 0xff) !== 0x05 || (cidr[3] & 0xff) !== 0xb1) return null;
    const p0 = pidr03[0] & 0xff, p1 = pidr03[1] & 0xff, p2 = pidr03[2] & 0xff, p4 = pidr47[0] & 0xff;
    if (!(p2 & 0x08)) return null; // 未使用 JEDEC 分配的设计者代码
    const id = ((p2 & 0x07) << 4) | ((p1 >>> 4) & 0x0f); // JEP106 识别码（7 位，不含奇偶位）
    const cont = p4 & 0x0f;                              // JEP106 延续码个数（bank）
    const key = cont + ':0x' + id.toString(16).padStart(2, '0');
    const part = ((p1 & 0x0f) << 8) | p0;                // ST 芯片此值等于 DEV_ID，可作交叉校验
    return {
        key,
        designer: JEP106_DESIGNERS[key] || '',
        code: 'JEP106 bank ' + cont + ', 0x' + id.toString(16).toUpperCase().padStart(2, '0'),
        part: '0x' + part.toString(16).toUpperCase()
    };
}

// 依据芯片系列与 ROM 表设计者给出原厂/兼容判定：仅对宣称 STM32 的芯片有意义。
// 设计者为 ST → 原厂；为 Arm（内核自带 ROM 表，M7/M33 等原厂芯片也如此）→ 不判定；
// 为其它硬件厂商→ 兼容芯片（正规厂商会在自定义 ROM 表中写入自己的 JEDEC 代码）
function assessAuthenticity(series, designerKey) {
    const none = { authenticity: '', compatVendor: '', compatBrand: '' };
    if (!designerKey || !/^stm32/i.test(String(series || ''))) return none;
    if (designerKey === ST_JEP106_KEY) return { authenticity: 'genuine', compatVendor: '', compatBrand: '' };
    if (designerKey === ARM_JEP106_KEY) return none; // 内核 ROM 表不携带芯片厂商信息，无法判定
    return { authenticity: 'compatible', compatVendor: JEP106_DESIGNERS[designerKey] || '', compatBrand: COMPAT_BRANDS[designerKey] || '' };
}

// 推导芯片设计厂商：仅当 ROM 表携带已知的非 Arm 硬件厂商码时才采信。
// Arm 内核 ROM 表、未知码或读取失败均无法证明芯片厂商，必须保持未知。
function deriveVendor(series, rom) {
    if (rom && rom.designer && rom.key !== ARM_JEP106_KEY) return rom.designer;
    return '';
}

// 从全家族 IDCODE 读取结果中选择可信值：优先取 DEV_ID 在已知家族表中的读数（目标配置选错时也能命中）；
// 未收录的 DEV_ID 只能从目标家族的 preferredAddr 接受，避免把其它家族地址上的普通数据当成 IDCODE。
function chooseIdcode(idcMap, preferredAddr) {
    const addrs = Object.keys(idcMap || {}).map(Number).sort((x, y) => x - y);
    for (const a of addrs) {
        const w = idcMap[a] >>> 0, dev = w & 0xfff;
        if (dev !== 0 && dev !== 0xfff && DEV_ID_FAMILY[dev]) return w;
    }
    const preferred = Number(preferredAddr) >>> 0;
    if (preferredAddr && Object.hasOwn(idcMap || {}, preferred)) {
        const w = idcMap[preferred] >>> 0, dev = w & 0xfff;
        if (dev !== 0 && dev !== 0xfff) return w;
    }
    return null;
}

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
    if (typeof idcode === 'string' && !/^(?:0x)?[0-9a-f]+$/i.test(idcode.trim())) return null;
    const parsed = typeof idcode === 'string' ? Number.parseInt(idcode, 16) : Number(idcode);
    if (!Number.isFinite(parsed)) return null;
    const u = parsed >>> 0;
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
    const n = String(target || '').split(/[\\/]/).pop().replace(/\.cfg$/i, '').split('_')[0];
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
    const name = String(target || '').split(/[\\/]/).pop().replace(/\.cfg$/i, '').toLowerCase();
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
        // 身份寄存器按全家族候选地址扫描（目标配置可能选错），收尾时按真实家族选值
        const idReads = ['catch { flash probe 0 }'];
        for (const a of ALL_IDCODE_ADDRS) idReads.push('catch { echo [mdw 0x' + a.toString(16) + '] }');
        for (const a of ALL_FLASHSIZE_ADDRS) idReads.push('catch { echo [mdw 0x' + a.toString(16) + '] }');
        for (const a of ALL_UID_ADDRS) idReads.push('catch { echo [mdw 0x' + a.toString(16) + ' 3] }');
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
            // 厂商指纹：ROM 表 PIDR/CIDR 属调试地址空间，运行态可直接读取，无需 halt
            `catch { echo [mdw 0x${ROM_PIDR4_ADDR.toString(16)} 4] }`,
            `catch { echo [mdw 0x${ROM_PIDR0_ADDR.toString(16)} 4] }`,
            `catch { echo [mdw 0x${ROM_CIDR_ADDR.toString(16)} 4] }`,
            identityCmd,
            // catch 会吞掉命令输出，寄存器行需 echo [...] 形式才能到达 stdout（仅 halted 时读取）
            'catch { if {[[target current] curstate] eq "halted"} { catch { echo [reg pc] }; catch { echo [reg sp] }; catch { echo [reg lr] } } }',
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
        report({ stage: 'start', message: '正在读取芯片信息…' });
        const info = {
            // 内核
            core: '', coreRevision: '', cpuid: '', implementer: '',
            // 芯片系列
            chip: '', series: seriesFromTarget(options.target),
            // 厂商指纹（ROM 表 JEP106）与原厂/兼容判定；designer=指纹确认的芯片厂商，romDesigner=CoreSight ROM 表原始设计者
            designer: '', romDesigner: '', designerCode: '', romPart: '', authenticity: '', compatVendor: '', compatBrand: '',
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
        // 全家族扫描的原始读数（地址 → 值），收尾时按真实家族选值
        const idcReads = {}, flsReads = {}, uidReads = {};
        let idcodeLog = ''; // OpenOCD flash 驱动自报的 device id（仅作最后回退）
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
            finish(Object.assign(new Error('读取芯片信息超时（15s）：请检查接线、供电与探针占用情况'), { i18nKey: 'chip.timeout' }));
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
                // ROM 表 PIDR/CIDR（厂商指纹）：收集三组字，统一在 close 时解码
                if (a === (ROM_PIDR4_ADDR >>> 0) && dump.words.length >= 4) { if (!info._pidr47) info._pidr47 = dump.words.slice(0, 4); return; }
                if (a === (ROM_PIDR0_ADDR >>> 0) && dump.words.length >= 4) { if (!info._pidr03) info._pidr03 = dump.words.slice(0, 4); return; }
                if (a === (ROM_CIDR_ADDR >>> 0) && dump.words.length >= 4) { if (!info._cidr) info._cidr = dump.words.slice(0, 4); return; }
                // 身份寄存器全家族扫描：只收集原始读数，不在此处判断取舍（目标配置可能选错）
                if (IDCODE_ADDR_SET.has(a)) { if (idcReads[a] == null) idcReads[a] = dump.words[0] >>> 0; return; }
                if (FLASHSIZE_ADDR_SET.has(a)) { if (flsReads[a] == null) flsReads[a] = dump.words[0] & 0xffff; return; }
                if (UID_ADDR_SET.has(a) && dump.words.length >= 3) { if (uidReads[a] == null) uidReads[a] = dump.words.slice(0, 3); return; }
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
            else if (event.stage === 'chip') { if (event.chip) info.chip = event.chip; if (event.deviceId && !idcodeLog) idcodeLog = event.deviceId; }
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
            finish(error.code === 'ENOENT' ? Object.assign(new Error(`找不到 OpenOCD：${options.executable}`), { i18nKey: 'run.notFound', i18nParams: { path: options.executable } }) : new Error(error.message));
        });
        child.on('close', (code) => {
            if (spawnFailed) return; // spawn 失败已由 error 事件处理
            if (pending) { handleLine(pending); pending = ''; }
            if (!info.transport && transportLog) info.transport = transportLog;
            // IDCODE：先取任意候选地址上已知的 DEV_ID（目标选错也能命中），再采信 OpenOCD 自报值；
            // 两者都没有时，未收录 DEV_ID 仅允许从目标家族的 IDCODE 地址回退。
            const knownIdcode = chooseIdcode(idcReads);
            if (knownIdcode != null) info.idcode = '0x' + (knownIdcode >>> 0).toString(16).toUpperCase();
            else if (idcodeLog && idcodeBase) info.idcode = idcodeLog;
            else {
                const targetIdcode = chooseIdcode(idcReads, idcodeBase);
                if (targetIdcode != null) info.idcode = '0x' + (targetIdcode >>> 0).toString(16).toUpperCase();
            }
            if (info.idcode) {
                const split = splitIdcode(info.idcode);
                if (split) { info.deviceId = split.deviceId; info.revId = split.revId; }
            }
            // 由 DEV_ID 推断实际芯片家族，修正目标配置名推导的系列（用户选错 target 时仍能正确显示）
            if (info.deviceId) {
                const devNum = parseInt(info.deviceId, 16);
                const family = DEV_ID_FAMILY[devNum];
                if (family && family !== info.series) info.series = family;
            }
            // 硬件实测的 flash 驱动名优先于目标配置名修正系列（避免用户选错 target 时显示错误系列）
            const hwSeries = seriesFromFlashDriver(info.flashDriver);
            if (hwSeries && hwSeries !== info.series && !DEV_ID_FAMILY[parseInt(info.deviceId || '0', 16)]) info.series = hwSeries;
            // Flash 容量：优先取“修正后家族”地址的寄存器值（权威，覆盖日志推导值），次取目标配置地址；
            // 均未命中时仅对 STM32 系列接受任意候选地址的有效值（避免非 STM32 芯片展示杂值）
            {
                const seriesKey = String(info.series || '').toLowerCase();
                const famFlashBase = lookupStmBase(STM32_FLASHSIZE_BASE, seriesKey);
                let kb = null;
                if (famFlashBase && flsReads[famFlashBase >>> 0] != null) kb = flsReads[famFlashBase >>> 0];
                else if (flashSizeBase && flsReads[flashSizeBase >>> 0] != null) kb = flsReads[flashSizeBase >>> 0];
                if (kb != null && kb > 0 && kb < 0xffff) info.flashSize = kb + ' KiB';
                else if (!info.flashSize && /^stm32/i.test(seriesKey)) {
                    for (const a of ALL_FLASHSIZE_ADDRS) { const v = flsReads[a]; if (v != null && v > 0 && v < 0xffff) { info.flashSize = v + ' KiB'; break; } }
                }
                // UID：同样按修正后家族 → 目标配置 → STM32 任意候选的顺序选值
                const famUidBase = lookupStmBase(STM32_UID_BASE, seriesKey);
                let uidWords = (famUidBase && uidReads[famUidBase >>> 0]) || (uidBase && uidReads[uidBase >>> 0]) || null;
                if (!uidWords && /^stm32/i.test(seriesKey)) {
                    for (const a of ALL_UID_ADDRS) { if (uidReads[a]) { uidWords = uidReads[a]; break; } }
                }
                if (uidWords) info.uid = formatUid(uidWords);
            }
            // 厂商指纹：解码 ROM 表 PIDR 得到 CoreSight 设计者，对 STM32 系列做原厂/兼容判定，
            // 并推导芯片设计厂商（Arm 内核 ROM 表或读取失败时保持未知）
            const rom = decodeRomPidr(info._pidr03, info._pidr47, info._cidr);
            if (rom) {
                info.romDesigner = rom.designer;
                info.designerCode = rom.code;
                info.romPart = rom.part;
                const verdict = assessAuthenticity(info.series, rom.key);
                info.authenticity = verdict.authenticity;
                info.compatVendor = verdict.compatVendor;
                info.compatBrand = verdict.compatBrand;
            }
            info.designer = deriveVendor(info.series, rom);
            delete info._pidr03; delete info._pidr47; delete info._cidr;
            // 拿到芯片层关键信息即视为成功；仅有适配器层字段（探针名/时钟/目标名）但存在错误时仍报错
            const gotChip = info.core || info.chip || info.idcode || info.flashSize || info.uid;
            const gotAny = gotChip || info.targetName || info.clock || info.probeName;
            if (gotChip || (gotAny && !errors.length)) {
                report({ stage: 'done', message: '读取完成' });
                finish(null);
                return;
            }
            let reasonErr;
            if (errors.length) reasonErr = new Error(errors.slice(-3).join('；'));
            else if (rawTail.length) reasonErr = new Error(rawTail.slice(-3).join('；'));
            else if (code === 0) reasonErr = Object.assign(new Error('未获取到芯片信息'), { i18nKey: 'chip.noInfo' });
            else reasonErr = Object.assign(new Error(`OpenOCD 退出码 ${code}`), { i18nKey: 'chip.exitCode', i18nParams: { code } });
            finish(reasonErr);
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
    flashSizeBaseForTarget, formatUid, normalizeFlashSize, decodeRomPidr, assessAuthenticity, deriveVendor, chooseIdcode,
    CORTEX_M_PARTS, IMPLEMENTERS,
    CPUID_ADDR, CLASSIC_IDCODE_ADDR, FALLBACK_FLASHSIZE_ADDRS, FALLBACK_UID_ADDRS, DEV_ID_FAMILY,
    ALL_IDCODE_ADDRS, ALL_FLASHSIZE_ADDRS, ALL_UID_ADDRS,
    ROM_PIDR4_ADDR, ROM_PIDR0_ADDR, ROM_CIDR_ADDR, JEP106_DESIGNERS, ST_JEP106_KEY, ARM_JEP106_KEY, COMPAT_BRANDS,
    STM32_UID_BASE, STM32_IDCODE_BASE, STM32_FLASHSIZE_BASE
};
