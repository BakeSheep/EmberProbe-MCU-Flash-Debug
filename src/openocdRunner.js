"use strict";
const { spawn } = require("child_process");

function parseLine(line) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean) return null;
    let match;
    if (/open on-chip debugger/i.test(clean)) return { stage: 'start', level: 'info', message: clean };
    if (/CMSIS-DAP|ST-?LINK|J-?Link|DAPLink/i.test(clean) && /Info\s*:/i.test(clean)) return { stage: 'probe', level: 'info', message: clean.replace(/^.*?Info\s*:\s*/i, '') };
    if (/target halted|hardware breakpoints|cortex_m reset_config/i.test(clean)) return { stage: 'target', level: 'info', message: clean.replace(/^.*?Info\s*:\s*/i, '') };
    if (/programming started/i.test(clean)) return { stage: 'program', level: 'info', message: '开始写入固件' };
    if ((match = clean.match(/wrote\s+(\d+)\s+bytes.*?in\s+([\d.]+)s/i))) return { stage: 'program', level: 'success', message: `已写入 ${match[1]} bytes（${match[2]}s）` };
    if (/verified\s+OK/i.test(clean)) return { stage: 'verify', level: 'success', message: '固件校验通过' };
    if ((match = clean.match(/verified\s+(\d+)\s+bytes.*?in\s+([\d.]+)s/i))) return { stage: 'verify', level: 'success', message: `已校验 ${match[1]} bytes（${match[2]}s）` };
    if (/shutdown command invoked/i.test(clean)) return { stage: 'done', level: 'success', message: '下载完成，目标已复位' };
    if (/error\s*:|failed|unable to|no device found|libusb_open|timed out/i.test(clean)) return { stage: 'error', level: 'error', message: clean.replace(/^.*?Error\s*:\s*/i, '') };
    return null;
}

function runOpenOcd(vscode, options, onProgress) {
    // 安全校验：配置名不允许路径分隔符与遍历，与 download.ps1 的白名单策略保持一致
    const isSafeCfg = name => /^[^\\/]+\.cfg$/.test(name) && !name.includes('..');
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) {
        return Promise.reject(new Error(`非法的 OpenOCD 配置名：${options.probe} / ${options.target}`));
    }
    return new Promise((resolve, reject) => {
        const writeEmitter = new vscode.EventEmitter();
        let child;
        const terminal = vscode.window.createTerminal({
            name: 'EmberProbe OpenOCD',
            pty: { onDidWrite: writeEmitter.event, open() {}, close() { if (child && !child.killed) child.kill(); } }
        });
        terminal.show(true);
        const elfPath = options.elf.replace(/\\/g, '/');
        // 关键修复：ELF 路径含空格时必须加引号，否则 OpenOCD 的 TCL 解析会把路径拆成多个参数
        const programCmd = `program "${elfPath}" verify reset exit`;
        const args = ['-f', `interface/${options.probe}`, '-f', `target/${options.target}`, '-c', programCmd];
        const quoteArg = a => (a.includes(' ') ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a);
        writeEmitter.fire(`\x1b[1;36mEmberProbe OpenOCD\x1b[0m\r\n${options.executable} ${args.map(quoteArg).join(' ')}\r\n\r\n`);
        onProgress({ stage: 'start', level: 'info', message: '正在启动 OpenOCD' });
        try { child = spawn(options.executable, args, { cwd: options.cwd, windowsHide: true, shell: false }); }
        catch (error) { terminal.dispose(); reject(error); return; }
        let pending = '';
        let lastError = '';
        let spawnFailed = false;
        let doneEmitted = false;
        // OpenOCD 默认把所有日志输出到 stderr，不能按流标红，需逐行解析后按级别着色
        const flushLine = (line) => {
            const text = line.replace(/\r/g, '');
            const event = parseLine(text);
            const isError = event?.level === 'error';
            writeEmitter.fire((isError ? '\x1b[31m' : '') + text + (isError ? '\x1b[0m' : '') + '\r\n');
            if (event) {
                if (event.level === 'error') lastError = event.message;
                if (event.stage === 'done') doneEmitted = true;
                onProgress(event);
            }
        };
        const consume = (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) flushLine(line);
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        child.on('error', error => { spawnFailed = true; onProgress({ stage: 'error', level: 'error', message: error.code === 'ENOENT' ? `找不到 OpenOCD：${options.executable}` : error.message }); reject(error); });
        child.on('close', code => {
            if (pending) { flushLine(pending); pending = ''; }
            if (spawnFailed) return; // spawn 失败已由 error 事件处理，避免重复报错与“退出代码 null”
            writeEmitter.fire(`\r\n${code === 0 ? '\x1b[32m下载成功' : '\x1b[31m下载失败'}（退出代码 ${code}）\x1b[0m\r\n`);
            if (code === 0) { if (!doneEmitted) onProgress({ stage: 'done', level: 'success', message: '下载成功' }); resolve({ code }); }
            else reject(new Error(lastError || `OpenOCD 退出代码 ${code}`));
        });
    });
}
module.exports = { runOpenOcd, parseLine };
