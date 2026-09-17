"use strict";
const { buildOpenOcdConfigArgs } = require("./openocdScripts");
const { spawn } = require("child_process");
const { isSafeCfgPath, resolveOpenOcdLaunch } = require("./openocdScripts");

// 配置路径白名单校验：允许 geehy/apm32f4x.cfg 等 scripts 内安全相对路径。
function isSafeCfg(name) {
    return isSafeCfgPath(name);
}

// Tcl 的双引号字符串仍会展开 $变量 和 [命令]，因此路径必须逐字符转义。
function quoteTclWord(value) {
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

function parseLine(line) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) return null;
    let match;
    if (/open on-chip debugger/i.test(clean)) return { stage: "start", level: "info", message: clean };
    if (/CMSIS-DAP|ST-?LINK|J-?Link|DAPLink/i.test(clean) && /Info\s*:/i.test(clean))
        return { stage: "probe", level: "info", message: clean.replace(/^.*?Info\s*:\s*/i, "") || clean };
    // 适配器时钟：Info : clock speed 1800 kHz / adapter speed: 2000 kHz
    if ((match = clean.match(/(?:clock speed|adapter speed:?)\s*([\d.]+\s*k?hz)/i)))
        return {
            stage: "adapter",
            level: "info",
            message: `适配器时钟 ${match[1]}`,
            key: "run.adapterClock",
            params: { clock: match[1] },
            clock: match[1]
        };
    // 目标电压：Info : Target voltage: 3.239000（≈0 视为目标板未供电）
    if ((match = clean.match(/target voltage:?\s*=?\s*([\d.]+)/i))) {
        const volts = Number(match[1]);
        return {
            stage: "voltage",
            level: volts > 0.5 ? "info" : "error",
            message:
                volts > 0.5
                    ? `目标电压 ${volts.toFixed(2)} V`
                    : `目标电压异常（${volts.toFixed(2)} V），目标板可能未供电`,
            key: volts > 0.5 ? "run.voltage" : "run.voltageLow",
            params: { volts: volts.toFixed(2) },
            volts
        };
    }
    // 芯片/器件识别：Info : device id = 0x10076413 / Info : Device: STM32F40x
    if ((match = clean.match(/device id\s*=\s*(0x[0-9a-f]+)/i)))
        return {
            stage: "chip",
            level: "info",
            message: `器件 ID ${match[1]}`,
            key: "run.deviceId",
            params: { id: match[1] },
            deviceId: match[1]
        };
    if ((match = clean.match(/\bDevice:\s*(.+)$/i)))
        return {
            stage: "chip",
            level: "info",
            message: `识别芯片 ${match[1].trim()}`,
            key: "run.chip",
            params: { chip: match[1].trim() },
            chip: match[1].trim()
        };
    // Flash 容量：Info : flash size = 1024 kbytes
    if ((match = clean.match(/flash size\s*=\s*([\d.]+\s*k?bytes?)/i)))
        return {
            stage: "flash",
            level: "info",
            message: `Flash 容量 ${match[1]}`,
            key: "run.flash",
            params: { size: match[1] },
            flashSize: match[1]
        };
    if (/target halted|hardware breakpoints|cortex_m reset_config/i.test(clean))
        return { stage: "target", level: "info", message: clean.replace(/^.*?Info\s*:\s*/i, "") || clean };
    if (/programming started/i.test(clean))
        return { stage: "program", level: "info", message: "开始写入固件", key: "run.programStart" };
    if ((match = clean.match(/wrote\s+(\d+)\s+bytes.*?in\s+([\d.]+)s(?:\s*\(([^)]+)\))?/i)))
        return {
            stage: "program",
            level: "success",
            message: `已写入 ${match[1]} bytes（${match[2]}s${match[3] ? `，${match[3]}` : ""}）`,
            key: match[3] ? "run.wrote" : "run.wroteNoSpeed",
            params: { bytes: Number(match[1]), seconds: Number(match[2]), speed: match[3] || "" },
            bytes: Number(match[1]),
            seconds: Number(match[2]),
            speed: match[3] || ""
        };
    if (/verified\s+OK/i.test(clean))
        return { stage: "verify", level: "success", message: "固件校验通过", key: "run.verifyOk" };
    if ((match = clean.match(/verified\s+(\d+)\s+bytes.*?in\s+([\d.]+)s(?:\s*\(([^)]+)\))?/i)))
        return {
            stage: "verify",
            level: "success",
            message: `已校验 ${match[1]} bytes（${match[2]}s${match[3] ? `，${match[3]}` : ""}）`,
            key: match[3] ? "run.verified" : "run.verifiedNoSpeed",
            params: { bytes: Number(match[1]), seconds: Number(match[2]), speed: match[3] || "" },
            bytes: Number(match[1]),
            seconds: Number(match[2]),
            speed: match[3] || ""
        };
    // 注意：失败时 OpenOCD 也会打印 "shutdown command invoked"，不能据此判定完成，统一以退出代码为准
    // Info : Unable to ... 可能只是降速等正常提示；非 Info 行仍保留常见失败模式识别。
    const isInfo = /\bInfo\s*:/i.test(clean);
    if (
        /\bError\s*:/i.test(clean) ||
        (!isInfo && /failed|unable to|no device found|libusb_open|timed out|can't find|cannot find/i.test(clean))
    ) {
        return { stage: "error", level: "error", message: clean.replace(/^.*?Error\s*:\s*/i, "") || clean };
    }
    return null;
}

const { diagnoseOpenOcdFailure, hintForErrors } = require("../skills/_emberprobe/openocd-diagnostics");

// 复用同一个终端，避免每次下载都新建终端导致堆叠
let sharedTerminal = null;
let sharedEmitter = null;
let sharedChild = null;
function acquireTerminal(vscode) {
    if (sharedTerminal) return { terminal: sharedTerminal, writeEmitter: sharedEmitter, created: false };
    const writeEmitter = new vscode.EventEmitter();
    sharedEmitter = writeEmitter;
    sharedTerminal = vscode.window.createTerminal({
        name: "EmberProbe OpenOCD",
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
    if (sharedChild && sharedChild.exitCode == null && sharedChild.signalCode == null) {
        return Promise.reject(
            Object.assign(new Error("OpenOCD download is already running"), {
                code: "PROBE_BUSY",
                retryable: true
            })
        );
    }
    if (sharedChild) sharedChild = null;
    // 安全校验：配置只能是 OpenOCD scripts 目录内的安全相对路径
    if (!isSafeCfg(options.probe) || !isSafeCfg(options.target)) {
        return Promise.reject(new Error(`非法的 OpenOCD 配置名：${options.probe} / ${options.target}`));
    }
    let launch;
    try {
        launch = resolveOpenOcdLaunch(options.executable, options.probe, options.target, options.transport);
    } catch (error) {
        return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
        const { terminal, writeEmitter, created } = acquireTerminal(vscode);
        terminal.show(true);
        const elfPath = options.elf.replace(/\\/g, "/");
        // 关键修复：ELF 路径含空格时必须加引号，否则 OpenOCD 的 TCL 解析会把路径拆成多个参数
        const programCmd = `program ${quoteTclWord(elfPath)} verify reset exit`;
        const preserveWorkArea = "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }";
        const args = [
            ...buildOpenOcdConfigArgs(launch, options.transport),
            "-c",
            "bindto 127.0.0.1",
            "-c",
            "tcl_port disabled",
            "-c",
            "gdb_port disabled",
            "-c",
            "telnet_port disabled",
            "-c",
            preserveWorkArea,
            "-c",
            programCmd
        ];
        // 终端不再镜像 OpenOCD 原始输出，只展示解析后的关键事件与最终结论
        const print = (text, color) => writeEmitter.fire((color || "") + text + "\x1b[0m\r\n");
        const printEvent = (event) => {
            const color = event.level === "error" ? "\x1b[31m" : event.level === "success" ? "\x1b[32m" : "";
            const icon = event.level === "error" ? "✗" : event.level === "success" ? "✓" : "→";
            print(`${icon} ${event.message}`, color);
        };
        print("\x1b[1;36mEmberProbe 固件下载\x1b[0m");
        print(`固件 ${elfPath}`);
        print(`探针 ${options.probe} · 目标 ${options.target}\r\n`);
        onProgress({ stage: "start", level: "info", key: "run.starting", message: "正在启动 OpenOCD" });
        let child;
        try {
            child = spawn(launch.executable, args, { cwd: launch.cwd, windowsHide: true, shell: false });
            sharedChild = child;
        } catch (error) {
            print(`✗ 启动 OpenOCD 失败：${error.message}`, "\x1b[31m");
            // 新建终端却启动失败时清理空终端；复用的终端保留历史输出
            if (created) {
                sharedTerminal = null;
                sharedEmitter = null;
                terminal.dispose();
            }
            reject(error);
            return;
        }
        const pending = { stdout: "", stderr: "" };
        let lastError = "";
        let spawnFailed = false;
        let timedOut = false;
        const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch (error) {
                /* process may already be exiting */
            }
            setTimeout(() => {
                if (child.exitCode == null && child.signalCode == null) {
                    try {
                        child.kill("SIGKILL");
                    } catch (error) {
                        /* process may already be exiting */
                    }
                }
            }, 500).unref?.();
            const timeoutError = Object.assign(new Error(`OpenOCD 下载超时（${timeoutMs}ms）`), {
                code: "OPENOCD_TIMEOUT"
            });
            print(`\r\n\x1b[1;31m✗ ${timeoutError.message}\x1b[0m`);
            reject(timeoutError);
        }, timeoutMs);
        const errors = [];
        const stats = { wrote: null, verified: null, probe: "", chip: "", deviceId: "", flashSize: "", clock: "" };
        const rawTail = [];
        // OpenOCD 默认把所有日志输出到 stderr，需逐行解析；未识别的行不展示，仅留作失败诊断
        const flushLine = (line) => {
            const text = line.replace(/\r/g, "");
            if (text) {
                rawTail.push(text);
                // Bounded by the process output limit; classify before trimming for display.
            }
            const event = parseLine(text);
            if (!event) return;
            printEvent(event);
            if (event.level === "error") {
                lastError = event.message;
                if (!errors.includes(event.message)) errors.push(event.message);
            }
            if (event.stage === "probe" && !stats.probe) stats.probe = event.message;
            if (event.stage === "chip") {
                if (event.chip) stats.chip = event.chip;
                if (event.deviceId && !stats.deviceId) stats.deviceId = event.deviceId;
            }
            if (event.stage === "flash" && event.flashSize && !stats.flashSize) stats.flashSize = event.flashSize;
            if (event.stage === "adapter" && event.clock && !stats.clock) stats.clock = event.clock;
            if (event.stage === "program" && event.bytes) stats.wrote = event;
            if (event.stage === "verify" && event.bytes) stats.verified = event;
            onProgress(event);
        };
        let outputBytes = 0;
        const consume = (stream, chunk) => {
            if (timedOut || spawnFailed) return;
            outputBytes += chunk.length;
            if (outputBytes > 4 * 1024 * 1024 || pending[stream].length + chunk.length > 65536) {
                timedOut = true;
                clearTimeout(timeout);
                child.kill("SIGKILL");
                reject(Object.assign(new Error("OpenOCD output limit exceeded"), { code: "OPENOCD_OUTPUT_LIMIT" }));
                return;
            }
            pending[stream] += chunk.toString();
            const lines = pending[stream].split(/\r?\n/);
            pending[stream] = lines.pop() || "";
            for (const line of lines) flushLine(line);
        };
        child.stdout.on("data", (chunk) => consume("stdout", chunk));
        child.stderr.on("data", (chunk) => consume("stderr", chunk));
        child.on("error", (error) => {
            clearTimeout(timeout);
            if (timedOut) return;
            spawnFailed = true;
            const isEnoent = error.code === "ENOENT";
            const message = isEnoent ? `找不到 OpenOCD：${options.executable}` : error.message;
            print("\r\n\x1b[1;31m✗ 下载失败\x1b[0m");
            print(`  失败原因：${message}`, "\x1b[31m");
            onProgress({
                stage: "error",
                level: "error",
                key: isEnoent ? "run.notFound" : undefined,
                params: { path: options.executable },
                message
            });
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            if (sharedChild === child) sharedChild = null;
            for (const stream of ["stdout", "stderr"]) {
                if (pending[stream]) flushLine(pending[stream]);
                pending[stream] = "";
            }
            if (spawnFailed) return; // spawn 失败已由 error 事件处理
            if (timedOut) return;
            if (code === 0) {
                const elfName = elfPath.split("/").pop() || elfPath;
                print("\r\n\x1b[1;32m✓ 固件下载并校验成功\x1b[0m");
                print(`  固件 ${elfName}`);
                const chipLine = [stats.chip, stats.deviceId].filter(Boolean).join(" · ");
                if (chipLine) print(`  芯片 ${chipLine}`);
                if (stats.flashSize) print(`  Flash 容量 ${stats.flashSize}`);
                if (stats.probe) print(`  探针 ${stats.probe}`);
                if (stats.clock) print(`  时钟 ${stats.clock}`);
                if (stats.wrote)
                    print(
                        `  写入 ${stats.wrote.bytes} bytes，耗时 ${stats.wrote.seconds}s${stats.wrote.speed ? `（${stats.wrote.speed}）` : ""}`
                    );
                if (stats.verified)
                    print(
                        `  校验 ${stats.verified.bytes} bytes，耗时 ${stats.verified.seconds}s${stats.verified.speed ? `（${stats.verified.speed}）` : ""}`
                    );
                print(`  目标 ${options.target} · 探针配置 ${options.probe}`);
                onProgress({ stage: "done", level: "success", key: "run.downloadSuccess", message: "下载成功" });
                resolve({ code });
            } else {
                const failureText = code === null ? "下载已取消（终端被关闭）" : `下载失败（退出代码 ${code}）`;
                print(`\r\n\x1b[1;31m✗ ${failureText}\x1b[0m`);
                if (errors.length) {
                    print("  失败原因：");
                    for (const message of errors.slice(-5)) print(`  • ${message}`, "\x1b[31m");
                    const hint = hintForErrors(rawTail, { probe: options.probe });
                    if (hint) print(`  建议：${hint}`, "\x1b[33m");
                } else if (rawTail.length) {
                    print("  未解析到明确错误，OpenOCD 末尾输出：");
                    for (const raw of rawTail.slice(-5)) print(`  ${raw}`, "\x1b[2m");
                }
                const diagnostic = diagnoseOpenOcdFailure(rawTail, { probe: options.probe, exitCode: code });
                reject(Object.assign(new Error(lastError || failureText), diagnostic));
            }
        });
    });
}
module.exports = { runOpenOcd, parseLine, isSafeCfg, quoteTclWord, hintForErrors, diagnoseOpenOcdFailure };
