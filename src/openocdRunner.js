"use strict";
const { spawn } = require("child_process");

// 配置名白名单校验：不允许路径分隔符与遍历，与 download.ps1 策略一致（供 liveWatch 复用）
function isSafeCfg(name) {
    return /^[^\\/]+\.cfg$/.test(name) && !name.includes('..');
}

// Tcl 的双引号字符串仍会展开 $变量 和 [命令]，因此路径必须逐字符转义。
function quoteTclWord(value) {
    const escaped = String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
    return `"${escaped}"`;
}

function parseLine(line) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean) return null;
    let match;
    if (/open on-chip debugger/i.test(clean)) return { stage: 'start', level: 'info', message: clean };
    if (/CMSIS-DAP|ST-?LINK|J-?Link|DAPLink/i.test(clean) && /Info\s*:/i.test(clean)) return { stage: 'probe', level: 'info', message: clean.replace(/^.*?Info\s*:\s*/i, '') || clean };
    // 适配器时钟：Info : clock speed 1800 kHz / adapter speed: 2000 kHz
    if ((match = clean.match(/(?:clock speed|adapter speed:?)\s*([\d.]+\s*k?hz)/i))) return { stage: 'adapter', level: 'info', message: `适配器时钟 ${match[1]}`, key: 'run.adapterClock', params: { clock: match[1] }, clock: match[1] };
    // 目标电压：Info : Target voltage: 3.239000（≈0 视为目标板未供电）
    if ((match = clean.match(/target voltage:?\s*=?\s*([\d.]+)/i))) { const volts = Number(match[1]); return { stage: 'voltage', level: volts > 0.5 ? 'info' : 'error', message: volts > 0.5 ? `目标电压 ${volts.toFixed(2)} V` : `目标电压异常（${volts.toFixed(2)} V），目标板可能未供电`, key: volts > 0.5 ? 'run.voltage' : 'run.voltageLow', params: { volts: volts.toFixed(2) }, volts }; }
    // 芯片/器件识别：Info : device id = 0x10076413 / Info : Device: STM32F40x
    if ((match = clean.match(/device id\s*=\s*(0x[0-9a-f]+)/i))) return { stage: 'chip', level: 'info', message: `器件 ID ${match[1]}`, key: 'run.deviceId', params: { id: match[1] }, deviceId: match[1] };
    if ((match = clean.match(/\bDevice:\s*(.+)$/i))) return { stage: 'chip', level: 'info', message: `识别芯片 ${match[1].trim()}`, key: 'run.chip', params: { chip: match[1].trim() }, chip: match[1].trim() };
    // Flash 容量：Info : flash size = 1024 kbytes
    if ((match = clean.match(/flash size\s*=\s*([\d.]+\s*k?bytes?)/i))) return { stage: 'flash', level: 'info', message: `Flash 容量 ${match[1]}`, key: 'run.flash', params: { size: match[1] }, flashSize: match[1] };
    if (/target halted|hardware breakpoints|cortex_m reset_config/i.test(clean)) return { stage: 'target', level: 'info', message: clean.replace(/^.*?Info\s*:\s*/i, '') || clean };
    if (/programming started/i.test(clean)) return { stage: 'program', level: 'info', message: '开始写入固件', key: 'run.programStart' };
    if ((match = clean.match(/wrote\s+(\d+)\s+bytes.*?in\s+([\d.]+)s(?:\s*\(([^)]+)\))?/i))) return { stage: 'program', level: 'success', message: `已写入 ${match[1]} bytes（${match[2]}s${match[3] ? `，${match[3]}` : ''}）`, key: match[3] ? 'run.wrote' : 'run.wroteNoSpeed', params: { bytes: Number(match[1]), seconds: Number(match[2]), speed: match[3] || '' }, bytes: Number(match[1]), seconds: Number(match[2]), speed: match[3] || '' };
    if (/verified\s+OK/i.test(clean)) return { stage: 'verify', level: 'success', message: '固件校验通过', key: 'run.verifyOk' };
    if ((match = clean.match(/verified\s+(\d+)\s+bytes.*?in\s+([\d.]+)s(?:\s*\(([^)]+)\))?/i))) return { stage: 'verify', level: 'success', message: `已校验 ${match[1]} bytes（${match[2]}s${match[3] ? `，${match[3]}` : ''}）`, key: match[3] ? 'run.verified' : 'run.verifiedNoSpeed', params: { bytes: Number(match[1]), seconds: Number(match[2]), speed: match[3] || '' }, bytes: Number(match[1]), seconds: Number(match[2]), speed: match[3] || '' };
    // 注意：失败时 OpenOCD 也会打印 "shutdown command invoked"，不能据此判定完成，统一以退出代码为准
    // Info : Unable to ... 可能只是降速等正常提示；非 Info 行仍保留常见失败模式识别。
    const isInfo = /\bInfo\s*:/i.test(clean);
    if (/\bError\s*:/i.test(clean) || (!isInfo && /failed|unable to|no device found|libusb_open|timed out|can't find|cannot find/i.test(clean))) {
        return { stage: 'error', level: 'error', message: clean.replace(/^.*?Error\s*:\s*/i, '') || clean };
    }
    return null;
}

// 常见失败原因 → 排查建议
function hintForErrors(errors) {
    const text = errors.join('\n').toLowerCase();
    if (/(can't find|cannot find|no such file|unknown command|invalid command).*(\.cfg|interface|target)|\.cfg.*(can't find|cannot find)/.test(text)) return 'OpenOCD 找不到配置脚本：请确认探针/目标配置名正确，且 OpenOCD 的 scripts 目录完整（或检查 openocdPath 指向的安装是否完整）';
    if (/address already in use|couldn't bind|can't bind|error .*binding/.test(text)) return '端口被占用：可能已有 OpenOCD/GDB 在运行，请关闭后重试（默认占用 3333/4444/6666）';
    if (/cannot read idr|error connecting dp|target not examined|init failed|no target connected|dp initialisation failed/.test(text)) return '无法连接目标芯片：请检查 SWD/JTAG 接线、目标板供电与 NRST 连接';
    if (/voltage|unpowered|not powered|电压|未供电/.test(text)) return '目标板可能未供电或供电异常：请检查目标板电源与探针 VCC/GND 连接';
    if (/scan chain|all ones|all zeroes|tap .*(disabled|invalid)/.test(text)) return 'JTAG/SWD 链路异常：请检查接线、上拉电阻与时钟设置';
    if (/unable to find|no device found|no .*found|open failed/.test(text)) return '未找到调试器：请检查 USB 连接与驱动，或确认探针型号选择是否正确';
    if (/libusb|access denied|usb_open|permission denied/.test(text)) return 'USB 驱动/权限异常：Windows 上可用 Zadig 将探针驱动替换为 WinUSB';
    if (/timed? ?out/.test(text)) return '通信超时：请检查接线是否牢固，或降低适配器时钟后重试';
    if (/protected|unlock|rdp|read out protection|option byte/.test(text)) return '芯片可能处于读保护（RDP）状态：请先解除保护或全片擦除';
    if (/flash write failed|failed erasing|failed to write|error writing|error erasing|write discontinued/.test(text)) return 'Flash 写入/擦除失败：请检查供电稳定性、是否写保护，或确认目标配置是否匹配';
    if (/verify|verification/.test(text)) return '校验失败：Flash 内容不一致，请检查供电稳定性后重试';
    if (/not halted|target running/.test(text)) return '目标未进入停机状态：请检查复位配置（reset_config），或在连接时按住复位';
    return '';
}

// 将 OpenOCD 原始日志归一化为稳定的机器可读诊断，供 UI 与 Agent Skills 共用。
// 匹配顺序很重要：目标芯片未连接与调试器未找到是两类完全不同的故障。
function diagnoseOpenOcdFailure(lines, details = {}) {
    const tail = (Array.isArray(lines) ? lines : [lines])
        .map(line => String(line || '').trim())
        .filter(Boolean)
        .slice(-8);
    const text = tail.join('\n').toLowerCase();
    const make = (code, category, likelyCause, suggestedActions, retryable = true) => ({
        code,
        category,
        stage: 'openocd_start',
        message: likelyCause,
        likelyCause,
        retryable,
        suggestedActions,
        details: { ...details, openocdTail: tail }
    });
    if (/(can't find|cannot find|no such file|unknown command|invalid command).*(\.cfg|interface|target)|\.cfg.*(can't find|cannot find)/.test(text)) {
        return make('OPENOCD_CONFIG_INVALID', 'configuration',
            'OpenOCD 找不到探针或目标配置脚本。',
            ['检查 EmberProbe 中的调试器与 MCU 目标配置。', '确认 openocdPath 指向完整的 OpenOCD 安装。'], false);
    }
    if (/address already in use|couldn't bind|can't bind|error .*binding/.test(text)) {
        return make('TCL_PORT_IN_USE', 'resource_conflict',
            'OpenOCD Tcl 端口已被其他进程占用。',
            ['关闭残留的 OpenOCD 或其他调试会话后重试。', '必要时在 EmberProbe 配置中更换 Tcl 端口。']);
    }
    if (/voltage.*(?:0(?:\.0+)?\b|too low)|unpowered|not powered|target power.*(?:off|low)/.test(text)) {
        return make('TARGET_UNPOWERED', 'target_connection',
            '目标板未供电或目标电压过低。',
            ['检查目标板电源。', '检查探针 VCC/GND 与目标板共地连接。']);
    }
    if (/cannot read idr|error connecting dp|target not examined|init failed|no target connected|dp initialisation failed|unable to connect to target|jtag scan chain interrogation failed|all ones|all zeroes/.test(text)) {
        return make('TARGET_NOT_CONNECTED', 'target_connection',
            '调试器已启动，但无法与目标 MCU 建立 SWD/JTAG 连接。',
            ['检查 MCU 供电以及 SWDIO/SWCLK/GND/NRST 接线。', '确认所选 MCU target 配置与实际芯片一致。', '可尝试降低 adapter speed 后重试。']);
    }
    if (/libusb.*(?:access|permission)|access denied|permission denied|usb_open.*access/.test(text)) {
        return make('PROBE_PERMISSION_DENIED', 'probe_connection',
            '操作系统拒绝访问调试探针。',
            ['检查是否有其他调试程序占用探针。', '检查 USB 驱动与当前用户权限。']);
    }
    if (/unable to find.*(?:cmsis|dap|st-?link|j-?link|probe)|no device found|no .*probe.*found|libusb_open.*(?:not found|no device)|open failed.*(?:probe|device)|unable to open.*(?:probe|device)/.test(text)) {
        return make('PROBE_NOT_FOUND', 'probe_connection',
            'OpenOCD 未找到或无法打开配置的调试探针。',
            ['检查探针 USB 连接。', '确认 EmberProbe 中选择的调试器型号正确。', '关闭可能占用探针的其他调试软件。']);
    }
    if (/timed? ?out|timeout/.test(text)) {
        return make('OPENOCD_CONNECTION_TIMEOUT', 'connection_timeout',
            'OpenOCD 与探针或目标 MCU 通信超时。',
            ['检查 USB、目标供电和调试接线。', '降低 adapter speed 后重试。']);
    }
    return make('OPENOCD_START_FAILED', 'openocd',
        tail.slice().reverse().find(line => /\berror\b|failed|unable|denied/i.test(line)) || 'OpenOCD 未能建立采样连接。',
        ['检查诊断中的 openocdTail 原始输出。', '确认探针、目标板供电、接线和 EmberProbe 配置。']);
}

// 复用同一个终端，避免每次下载都新建终端导致堆叠
let sharedTerminal = null;
let sharedEmitter = null;
let sharedChild = null;
function acquireTerminal(vscode) {
    if (sharedTerminal) return { terminal: sharedTerminal, writeEmitter: sharedEmitter, created: false };
    const writeEmitter = new vscode.EventEmitter();
    sharedEmitter = writeEmitter;
    sharedTerminal = vscode.window.createTerminal({
        name: 'EmberProbe OpenOCD',
        pty: {
            onDidWrite: writeEmitter.event,
            open() {},
            close() {
                if (sharedChild && !sharedChild.killed) sharedChild.kill();
                sharedTerminal = null;
                sharedEmitter = null;
            }
        }
    });
    return { terminal: sharedTerminal, writeEmitter, created: true };
}
function runOpenOcd(vscode, options, onProgress) {
    // 安全校验：配置名不允许路径分隔符与遍历，与 download.ps1 的白名单策略保持一致
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) {
        return Promise.reject(new Error(`非法的 OpenOCD 配置名：${options.probe} / ${options.target}`));
    }
    return new Promise((resolve, reject) => {
        const { terminal, writeEmitter, created } = acquireTerminal(vscode);
        terminal.show(true);
        const elfPath = options.elf.replace(/\\/g, '/');
        // 关键修复：ELF 路径含空格时必须加引号，否则 OpenOCD 的 TCL 解析会把路径拆成多个参数
        const programCmd = `program ${quoteTclWord(elfPath)} verify reset exit`;
        const args = ['-f', `interface/${options.probe}`, '-f', `target/${options.target}`, '-c', programCmd];
        // 终端不再镜像 OpenOCD 原始输出，只展示解析后的关键事件与最终结论
        const print = (text, color) => writeEmitter.fire((color || '') + text + '\x1b[0m\r\n');
        const printEvent = (event) => {
            const color = event.level === 'error' ? '\x1b[31m' : event.level === 'success' ? '\x1b[32m' : '';
            const icon = event.level === 'error' ? '✗' : event.level === 'success' ? '✓' : '→';
            print(`${icon} ${event.message}`, color);
        };
        print('\x1b[1;36mEmberProbe 固件下载\x1b[0m');
        print(`固件 ${elfPath}`);
        print(`探针 ${options.probe} · 目标 ${options.target}\r\n`);
        onProgress({ stage: 'start', level: 'info', key: 'run.starting', message: '正在启动 OpenOCD' });
        let child;
        try { child = spawn(options.executable, args, { cwd: options.cwd, windowsHide: true, shell: false }); sharedChild = child; }
        catch (error) {
            print(`✗ 启动 OpenOCD 失败：${error.message}`, '\x1b[31m');
            // 新建终端却启动失败时清理空终端；复用的终端保留历史输出
            if (created) { sharedTerminal = null; sharedEmitter = null; terminal.dispose(); }
            reject(error);
            return;
        }
        let pending = '';
        let lastError = '';
        let spawnFailed = false;
        const errors = [];
        const stats = { wrote: null, verified: null, probe: '', chip: '', deviceId: '', flashSize: '', clock: '' };
        const rawTail = [];
        // OpenOCD 默认把所有日志输出到 stderr，需逐行解析；未识别的行不展示，仅留作失败诊断
        const flushLine = (line) => {
            const text = line.replace(/\r/g, '');
            if (text) { rawTail.push(text); if (rawTail.length > 8) rawTail.shift(); }
            const event = parseLine(text);
            if (!event) return;
            printEvent(event);
            if (event.level === 'error') { lastError = event.message; if (!errors.includes(event.message)) errors.push(event.message); }
            if (event.stage === 'probe' && !stats.probe) stats.probe = event.message;
            if (event.stage === 'chip') { if (event.chip) stats.chip = event.chip; if (event.deviceId && !stats.deviceId) stats.deviceId = event.deviceId; }
            if (event.stage === 'flash' && event.flashSize && !stats.flashSize) stats.flashSize = event.flashSize;
            if (event.stage === 'adapter' && event.clock && !stats.clock) stats.clock = event.clock;
            if (event.stage === 'program' && event.bytes) stats.wrote = event;
            if (event.stage === 'verify' && event.bytes) stats.verified = event;
            onProgress(event);
        };
        const consume = (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) flushLine(line);
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        child.on('error', error => {
            spawnFailed = true;
            const isEnoent = error.code === 'ENOENT';
            const message = isEnoent ? `找不到 OpenOCD：${options.executable}` : error.message;
            print('\r\n\x1b[1;31m✗ 下载失败\x1b[0m');
            print(`  失败原因：${message}`, '\x1b[31m');
            onProgress({ stage: 'error', level: 'error', key: isEnoent ? 'run.notFound' : undefined, params: { path: options.executable }, message });
            reject(error);
        });
        child.on('close', code => {
            if (sharedChild === child) sharedChild = null;
            if (pending) { flushLine(pending); pending = ''; }
            if (spawnFailed) return; // spawn 失败已由 error 事件处理
            if (code === 0) {
                const elfName = elfPath.split('/').pop() || elfPath;
                print('\r\n\x1b[1;32m✓ 固件下载并校验成功\x1b[0m');
                print(`  固件 ${elfName}`);
                const chipLine = [stats.chip, stats.deviceId].filter(Boolean).join(' · ');
                if (chipLine) print(`  芯片 ${chipLine}`);
                if (stats.flashSize) print(`  Flash 容量 ${stats.flashSize}`);
                if (stats.probe) print(`  探针 ${stats.probe}`);
                if (stats.clock) print(`  时钟 ${stats.clock}`);
                if (stats.wrote) print(`  写入 ${stats.wrote.bytes} bytes，耗时 ${stats.wrote.seconds}s${stats.wrote.speed ? `（${stats.wrote.speed}）` : ''}`);
                if (stats.verified) print(`  校验 ${stats.verified.bytes} bytes，耗时 ${stats.verified.seconds}s${stats.verified.speed ? `（${stats.verified.speed}）` : ''}`);
                print(`  目标 ${options.target} · 探针配置 ${options.probe}`);
                onProgress({ stage: 'done', level: 'success', key: 'run.downloadSuccess', message: '下载成功' });
                resolve({ code });
            }
            else {
                const failureText = code === null ? '下载已取消（终端被关闭）' : `下载失败（退出代码 ${code}）`;
                print(`\r\n\x1b[1;31m✗ ${failureText}\x1b[0m`);
                if (errors.length) {
                    print('  失败原因：');
                    for (const message of errors.slice(-5)) print(`  • ${message}`, '\x1b[31m');
                    const hint = hintForErrors(errors);
                    if (hint) print(`  建议：${hint}`, '\x1b[33m');
                }
                else if (rawTail.length) {
                    print('  未解析到明确错误，OpenOCD 末尾输出：');
                    for (const raw of rawTail.slice(-5)) print(`  ${raw}`, '\x1b[2m');
                }
                reject(new Error(lastError || failureText));
            }
        });
    });
}
module.exports = { runOpenOcd, parseLine, isSafeCfg, quoteTclWord, hintForErrors, diagnoseOpenOcdFailure };
