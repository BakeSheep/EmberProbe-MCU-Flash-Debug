"use strict";
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

async function newestElf(vscode) {
    const files = await vscode.workspace.findFiles('**/*.elf', '{**/node_modules/**,**/.git/**}', 200);
    const ranked = await Promise.all(files.map(async uri => {
        try { return { uri, mtime: (await fs.stat(uri.fsPath)).mtimeMs }; }
        catch { return { uri, mtime: 0 }; }
    }));
    ranked.sort((a, b) => b.mtime - a.mtime);
    return ranked[0]?.uri.fsPath || '';
}

function targetFromText(text) {
    const value = text.toLowerCase();
    const rules = [
        [/stm32f0/, 'stm32f0x.cfg'], [/stm32f1/, 'stm32f1x.cfg'], [/stm32f2/, 'stm32f2x.cfg'],
        [/stm32f3/, 'stm32f3x.cfg'], [/stm32f4/, 'stm32f4x.cfg'], [/stm32f7/, 'stm32f7x.cfg'],
        [/stm32g0/, 'stm32g0x.cfg'], [/stm32g4/, 'stm32g4x.cfg'], [/stm32h7/, 'stm32h7x.cfg'],
        [/stm32l0/, 'stm32l0.cfg'], [/stm32l1/, 'stm32l1.cfg'], [/stm32l4/, 'stm32l4x.cfg'],
        [/stm32l5/, 'stm32l5x.cfg'], [/stm32u5/, 'stm32u5x.cfg'], [/stm32wb/, 'stm32wbx.cfg'],
        [/stm32wl/, 'stm32wlx.cfg'], [/gd32vf103/, 'gd32vf103.cfg'], [/gd32e23/, 'gd32e23x.cfg'],
        [/nrf51/, 'nrf51.cfg'], [/nrf52/, 'nrf52.cfg'], [/rp2040/, 'rp2040.cfg'],
        [/esp32s3/, 'esp32s3.cfg'], [/esp32s2/, 'esp32s2.cfg'], [/esp32/, 'esp32.cfg']
    ];
    return rules.find(([pattern]) => pattern.test(value))?.[1] || '';
}

async function detectMcu(vscode) {
    const candidates = [
        ...(await vscode.workspace.findFiles('**/*.ioc', '{**/node_modules/**,**/.git/**}', 20)),
        ...(await vscode.workspace.findFiles('**/{CMakeLists.txt,*.cmake,*.ld}', '{**/node_modules/**,**/.git/**}', 80))
    ];
    for (const uri of candidates) {
        try {
            const content = await fs.readFile(uri.fsPath, 'utf8');
            const target = targetFromText(content + '\n' + path.basename(uri.fsPath));
            if (target) return target;
        } catch { }
    }
    return '';
}

async function usbInventory() {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-PnpDevice -PresentOnly | Select-Object -ExpandProperty FriendlyName'], { timeout: 6000, windowsHide: true });
            return stdout;
        }
        const command = process.platform === 'darwin' ? ['system_profiler', ['SPUSBDataType']] : ['lsusb', []];
        return (await execFileAsync(command[0], command[1], { timeout: 6000 })).stdout;
    } catch { return ''; }
}

async function detectDebugger() {
    const devices = (await usbInventory()).toLowerCase();
    if (/st-?link|stm32 stlink/.test(devices)) return 'stlink.cfg';
    if (/j-?link|segger/.test(devices)) return 'jlink.cfg';
    if (/cmsis[- ]dap|daplink|picoprobe/.test(devices)) return 'cmsis-dap.cfg';
    if (/xds110/.test(devices)) return 'xds110.cfg';
    if (/nu-?link/.test(devices)) return 'nulink.cfg'; // 兼容 "Nu-Link" 连字符写法
    return '';
}

async function detectWorkspace(vscode) {
    const [elf, mcu, debuggerConfig] = await Promise.all([newestElf(vscode), detectMcu(vscode), detectDebugger()]);
    return { elf, mcu, debugger: debuggerConfig };
}
module.exports = { detectWorkspace, targetFromText };
