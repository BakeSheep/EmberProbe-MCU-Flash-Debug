"use strict";
// mcu-download / mcu-flash-verify 的共享逻辑：EmberProbe 配置复用、ELF/目标/探针自动
// 检测与 OpenOCD 进程调用。仅依赖 Node 内置模块，随 skills/_emberprobe 一起分发，
// 不依赖扩展本体；bridge 不可用时各项检测自动降级为工作区推断。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { call } = require("./agent-client");

const TARGET_RULES = [
    ["apm32f0", "geehy/apm32f0x.cfg"], ["apm32f1", "geehy/apm32f1x.cfg"], ["apm32f4", "geehy/apm32f4x.cfg"],
    ["stm32f0", "stm32f0x.cfg"], ["stm32f1", "stm32f1x.cfg"], ["stm32f2", "stm32f2x.cfg"],
    ["stm32f3", "stm32f3x.cfg"], ["stm32f4", "stm32f4x.cfg"], ["stm32f7", "stm32f7x.cfg"],
    ["stm32g0", "stm32g0x.cfg"], ["stm32g4", "stm32g4x.cfg"], ["stm32h7", "stm32h7x.cfg"],
    ["stm32l0", "stm32l0.cfg"], ["stm32l1", "stm32l1.cfg"], ["stm32l4", "stm32l4x.cfg"],
    ["stm32l5", "stm32l5x.cfg"], ["stm32u5", "stm32u5x.cfg"], ["stm32wb", "stm32wbx.cfg"],
    ["stm32wl", "stm32wlx.cfg"], ["gd32vf103", "gd32vf103.cfg"], ["gd32e23", "gd32e23x.cfg"],
    ["nrf51", "nordic/nrf51.cfg"], ["nrf52", "nordic/nrf52.cfg"], ["rp2040", "rp2040.cfg"],
    ["esp32s3", "esp32s3.cfg"], ["esp32s2", "esp32s2.cfg"], ["esp32", "esp32.cfg"]
];

function parseArgs(argv) {
    const out = { execute: false };
    const valued = ["--workspace", "--elf", "--target", "--probe", "--openocd"];
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === "--execute") out.execute = true;
        else if (valued.includes(key)) {
            if (!argv[i + 1]) throw new Error(`Missing value for ${key}`);
            out[key.slice(2)] = argv[++i];
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!out.workspace) throw new Error("Missing required argument: --workspace <path>");
    return out;
}

async function getEmberProbeConfig(workspace) {
    try { return await call(workspace, "config.get", {}); } catch { return null; }
}

// 深度优先遍历工作区文件；跳过 node_modules/.git，忽略不可读目录。
// 扩展名比较统一小写，避免 Linux 等大小写敏感文件系统上漏掉 FIRMWARE.ELF。
function walkFiles(root, accept) {
    const files = [];
    const visit = dir => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "node_modules" && entry.name !== ".git") visit(full);
            } else if (entry.isFile() && accept(entry.name)) files.push(full);
        }
    };
    visit(root);
    return files;
}

function findNewestElf(root) {
    let best = null;
    for (const file of walkFiles(root, name => name.toLowerCase().endsWith(".elf"))) {
        try {
            const stats = fs.statSync(file);
            if (!best || stats.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stats.mtimeMs };
        } catch { }
    }
    return best ? best.file : "";
}

function inferTarget(root) {
    const files = walkFiles(root, name => {
        const ext = path.extname(name).toLowerCase();
        return ext === ".ioc" || ext === ".cmake" || ext === ".ld" || name === "CMakeLists.txt";
    }).slice(0, 80);
    let text = "";
    for (const file of files) {
        text += path.basename(file) + "\n";
        try { text += fs.readFileSync(file, "utf8") + "\n"; } catch { }
    }
    const joined = text.toLowerCase();
    for (const [keyword, cfg] of TARGET_RULES) {
        if (joined.includes(keyword)) return cfg;
    }
    return "";
}

function execText(command, args) {
    return new Promise(resolve => {
        execFile(command, args, { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            resolve({ ok: !error, text: error ? "" : String(stdout || "") });
        });
    });
}

// 兼容常见固件与设备描述里的拼写：CMSIS-DAP / CMSIS DAP / CMSISDAP / DAPLink / MCU-Link 等。
function probeFromText(text) {
    const devices = String(text || "").toLowerCase();
    if (/st[- ]?link|stm32\s+stlink/.test(devices)) return "stlink.cfg";
    if (/j[- ]?link|segger/.test(devices)) return "jlink.cfg";
    if (/cmsis(?:[- _]?dap)|daplink|pico\s?probe|mcu[- ]?link/.test(devices)) return "cmsis-dap.cfg";
    if (/xds[- ]?110/.test(devices)) return "xds110.cfg";
    if (/nu[- ]?link/.test(devices)) return "nulink.cfg";
    return "";
}

async function detectProbe() {
    const notes = [];
    let text = "";
    if (process.platform === "win32") {
        text = (await execText("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "Get-PnpDevice -PresentOnly | Select-Object -ExpandProperty FriendlyName"])).text;
        if (!text.trim()) text = (await execText("pnputil.exe", ["/enum-devices", "/connected"])).text;
        if (!text.trim()) notes.push("USB enumeration unavailable (Get-PnpDevice and pnputil failed). If a probe is attached, pass --probe explicitly.");
    } else {
        const darwin = process.platform === "darwin";
        const tool = darwin ? "system_profiler" : "lsusb";
        const result = await execText(tool, darwin ? ["SPUSBDataType"] : []);
        text = result.text;
        if (!result.ok) notes.push(darwin
            ? `${tool} is unavailable. If a probe is attached, pass --probe explicitly.`
            : `${tool} is not installed. Install usbutils (e.g. sudo apt install usbutils) or pass --probe explicitly.`);
    }
    return { probe: probeFromText(text), notes };
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file);
        const hash = crypto.createHash("sha256");
        stream.on("data", chunk => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

// OpenOCD 的 -f 参数只接受相对 scripts/ 的 cfg 名，拒绝绝对路径、盘符与目录穿越，
// 防止把任意本地文件当作 OpenOCD 配置执行。
function isSafeCfgPath(value) {
    if (!value || !value.endsWith(".cfg") || value.includes("\\") || value.startsWith("/")) return false;
    if (/[\0\n\r]|:/.test(value)) return false;
    return value.split("/").every(part => part && part !== "." && part !== "..");
}

function tclQuote(value) {
    const escaped = String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\$/g, "\\$")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
    return `"${escaped}"`;
}

// OpenOCD Tcl 内的文件名使用正斜杠，Windows 路径也能被解析。
function toPosix(value) {
    return path.sep === "/" ? value : value.split(path.sep).join("/");
}

// 运行 OpenOCD 并把 stdout/stderr 逐行转发到本进程 stdout（OpenOCD 诊断走 stderr，
// 与 PowerShell 版的 2>&1 行为保持一致），同时收集行供 EP_VERIFY 标记解析。
function runOpenOcd(executable, args) {
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawn(executable, args, { windowsHide: true, shell: false }); }
        catch (error) { reject(error); return; }
        const lines = [];
        let settled = false;
        const collect = stream => {
            let buffer = "";
            stream.on("data", chunk => {
                buffer += chunk.toString();
                const parts = buffer.split(/\r?\n/);
                buffer = parts.pop();
                for (const line of parts) {
                    lines.push(line);
                    process.stdout.write(line + "\n");
                }
            });
            stream.on("end", () => {
                if (buffer) {
                    lines.push(buffer);
                    process.stdout.write(buffer + "\n");
                }
            });
        };
        collect(child.stdout);
        collect(child.stderr);
        child.on("error", error => {
            if (!settled) { settled = true; reject(error); }
        });
        child.on("close", code => {
            if (!settled) { settled = true; resolve({ code: code == null ? -1 : code, lines }); }
        });
    });
}

// 统一预检：显式参数 > EmberProbe 配置（Agent Bridge）> 工作区/USB 自动检测。
// notes 携带检测工具缺失等提示，随 JSON 一并输出。
async function preflight(options) {
    const root = fs.realpathSync(path.resolve(options.workspace));
    const config = await getEmberProbeConfig(root);
    const notes = [];
    let elf = options.elf || (config && config.elf ? String(config.elf) : "");
    let target = options.target || (config && config.mcu ? String(config.mcu) : "");
    let probe = options.probe || (config && config.debugger ? String(config.debugger) : "");
    let openocd = options.openocd || (config && config.openocdPath ? String(config.openocdPath) : "") || "openocd";
    if (!elf) elf = findNewestElf(root);
    if (!target) target = inferTarget(root);
    if (!probe) {
        const detected = await detectProbe();
        probe = detected.probe;
        notes.push(...detected.notes);
    }
    let elfMtimeUtc = "";
    let elfSha256 = "";
    if (elf) {
        try {
            const stats = fs.statSync(elf);
            if (stats.isFile()) {
                elfMtimeUtc = stats.mtime.toISOString();
                elfSha256 = await sha256(elf);
            }
        } catch { }
    }
    return {
        workspace: root,
        elf,
        elfSha256,
        elfMtimeUtc,
        target,
        probe,
        openocd,
        ready: Boolean(elf && target && probe),
        notes
    };
}

function emit(value) {
    process.stdout.write(JSON.stringify(value) + "\n");
}

module.exports = {
    parseArgs,
    getEmberProbeConfig,
    findNewestElf,
    inferTarget,
    detectProbe,
    probeFromText,
    sha256,
    isSafeCfgPath,
    tclQuote,
    toPosix,
    runOpenOcd,
    preflight,
    emit
};
