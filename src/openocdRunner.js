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
    return new Promise((resolve, reject) => {
        const writeEmitter = new vscode.EventEmitter();
        let child;
        const terminal = vscode.window.createTerminal({
            name: 'EmberProbe OpenOCD',
            pty: { onDidWrite: writeEmitter.event, open() {}, close() { if (child && !child.killed) child.kill(); } }
        });
        terminal.show(true);
        const args = ['-f', `interface/${options.probe}`, '-f', `target/${options.target}`, '-c', `program ${options.elf.replace(/\\/g, '/')} verify reset exit`];
        writeEmitter.fire(`\x1b[1;36mEmberProbe OpenOCD\x1b[0m\r\n${options.executable} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}\r\n\r\n`);
        onProgress({ stage: 'start', level: 'info', message: '正在启动 OpenOCD' });
        try { child = spawn(options.executable, args, { cwd: options.cwd, windowsHide: true, shell: false }); }
        catch (error) { reject(error); return; }
        let pending = '';
        let lastError = '';
        const consume = (chunk, isError) => {
            const text = chunk.toString();
            writeEmitter.fire((isError ? '\x1b[31m' : '') + text.replace(/\n/g, '\r\n') + (isError ? '\x1b[0m' : ''));
            pending += text;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) {
                const event = parseLine(line);
                if (event) { if (event.level === 'error') lastError = event.message; onProgress(event); }
            }
        };
        child.stdout.on('data', chunk => consume(chunk, false));
        child.stderr.on('data', chunk => consume(chunk, true));
        child.on('error', error => { onProgress({ stage: 'error', level: 'error', message: error.code === 'ENOENT' ? `找不到 OpenOCD：${options.executable}` : error.message }); reject(error); });
        child.on('close', code => {
            if (pending) { const event = parseLine(pending); if (event) { if (event.level === 'error') lastError = event.message; onProgress(event); } }
            writeEmitter.fire(`\r\n${code === 0 ? '\x1b[32m下载成功' : '\x1b[31m下载失败'}（退出代码 ${code}）\x1b[0m\r\n`);
            if (code === 0) { onProgress({ stage: 'done', level: 'success', message: '下载成功' }); resolve({ code }); }
            else reject(new Error(lastError || `OpenOCD 退出代码 ${code}`));
        });
    });
}
module.exports = { runOpenOcd, parseLine };
