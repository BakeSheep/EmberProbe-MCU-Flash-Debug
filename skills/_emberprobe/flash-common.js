"use strict";
// mcu-flash 编程/校验入口的共享逻辑：EmberProbe 配置复用、ELF/目标/探针自动
// 检测与 OpenOCD 进程调用。仅依赖 Node 内置模块，随 skills/_emberprobe 一起分发，
// 不依赖扩展本体；bridge 不可用时各项检测自动降级为工作区推断。

const fs = require("fs");
const { canonicalFileSync } = require("./file-identity");
const { detectProbe, probeFromText } = require("./probe-detection");
const { isSafeCfgPath, resolveExecutablePath, resolveOpenOcdLaunch, normalizeTransport } = require("./openocd-launch");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { call, diagnosticForError } = require("./agent-client");
const { MIN_OPENOCD_VERSION, parseVersion: parseOpenOcdVersion, checkCompatibility } = require("./openocd-policy");
const { normalizeProbeSerial, normalizeAdapterSpeed } = require("./probe-connection");
const { prepareProbeConnection } = require("./probe-preflight");

const TARGET_RULES = [
    ["apm32f0", "geehy/apm32f0x.cfg"],
    ["apm32f1", "geehy/apm32f1x.cfg"],
    ["apm32f4", "geehy/apm32f4x.cfg"],
    ["stm32f0", "stm32f0x.cfg"],
    ["stm32f1", "stm32f1x.cfg"],
    ["stm32f2", "stm32f2x.cfg"],
    ["stm32f3", "stm32f3x.cfg"],
    ["stm32f4", "stm32f4x.cfg"],
    ["stm32f7", "stm32f7x.cfg"],
    ["stm32g0", "stm32g0x.cfg"],
    ["stm32g4", "stm32g4x.cfg"],
    ["stm32h7", "stm32h7x.cfg"],
    ["stm32l0", "stm32l0.cfg"],
    ["stm32l1", "stm32l1.cfg"],
    ["stm32l4", "stm32l4x.cfg"],
    ["stm32l5", "stm32l5x.cfg"],
    ["stm32u5", "stm32u5x.cfg"],
    ["stm32wb", "stm32wbx.cfg"],
    ["stm32wl", "stm32wlx.cfg"],
    ["gd32vf103", "gd32vf103.cfg"],
    ["gd32e23", "gd32e23x.cfg"],
    ["nrf51", "nordic/nrf51.cfg"],
    ["nrf52", "nordic/nrf52.cfg"],
    ["rp2040", "rp2040.cfg"],
    ["esp32s3", "esp32s3.cfg"],
    ["esp32s2", "esp32s2.cfg"],
    ["esp32", "esp32.cfg"]
];

function parseArgs(argv) {
    const out = { execute: false };
    const valued = [
        "--workspace",
        "--elf",
        "--target",
        "--probe",
        "--openocd",
        "--transport",
        "--probe-serial",
        "--adapter-speed-khz",
        "--confirmation-id"
    ];
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

// 读取 EmberProbe 配置。config.get 失败时不再吞掉异常：返回结构化 diagnostic，
// 供预检记录降级原因并保留原始错误码与详情；调用方仍可继续用显式参数/自动检测降级。
async function getEmberProbeConfig(workspace) {
    try {
        return { config: await call(workspace, "config.get", {}), diagnostic: null };
    } catch (error) {
        return { config: null, diagnostic: diagnosticForError(error, { operation: "config.get" }) };
    }
}

async function authorizeFlash(result, confirmationId) {
    return call(result.workspace, "flash.authorize", {
        elf: result.elf,
        elfSha256: result.elfSha256,
        target: result.target,
        probe: result.probe,
        openocd: result.openocd,
        transport: result.transport,
        probeSerial: result.probeSerial,
        adapterSpeedKhz: result.adapterSpeedKhz,
        confirmationId
    });
}

// 深度优先遍历工作区文件；跳过 node_modules/.git，忽略不可读目录。
// 扩展名比较统一小写，避免 Linux 等大小写敏感文件系统上漏掉 FIRMWARE.ELF。
function walkFiles(root, accept) {
    const files = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
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
    for (const file of walkFiles(root, (name) => name.toLowerCase().endsWith(".elf"))) {
        try {
            const stats = fs.statSync(file);
            if (!best || stats.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stats.mtimeMs };
        } catch {}
    }
    return best ? best.file : "";
}

function inferTarget(root) {
    const files = walkFiles(root, (name) => {
        const ext = path.extname(name).toLowerCase();
        return ext === ".ioc" || ext === ".cmake" || ext === ".ld" || name === "CMakeLists.txt";
    }).slice(0, 80);
    let text = "";
    for (const file of files) {
        text += path.basename(file) + "\n";
        try {
            text += fs.readFileSync(file, "utf8") + "\n";
        } catch {}
    }
    const joined = text.toLowerCase();
    for (const [keyword, cfg] of TARGET_RULES) {
        if (joined.includes(keyword)) return cfg;
    }
    return "";
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file);
        const hash = crypto.createHash("sha256");
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

function checkOpenOcdVersion(version) {
    const { compatible, reason, minimumVersion } = checkCompatibility(version);
    return { compatible, reason, minimumVersion };
}

function probeOpenOcdCompatibility(executable, timeoutMs = 5000, spawnProcess = spawn) {
    let binary;
    try {
        binary = resolveExecutablePath(executable);
    } catch (error) {
        return Promise.resolve({
            found: false,
            path: executable,
            version: "",
            compatible: false,
            minimumVersion: MIN_OPENOCD_VERSION,
            error: error.message,
            code: error.code
        });
    }
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnProcess(binary, ["--version"], { windowsHide: true, shell: false });
        } catch (error) {
            resolve({
                found: false,
                path: binary,
                version: "",
                compatible: false,
                minimumVersion: MIN_OPENOCD_VERSION,
                error: error.message
            });
            return;
        }
        let output = "";
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                /* already exited */
            }
            finish({
                found: false,
                path: binary,
                version: "",
                compatible: false,
                minimumVersion: MIN_OPENOCD_VERSION,
                error: "OpenOCD version check timed out"
            });
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            output += chunk.toString();
        });
        child.on("error", (error) =>
            finish({
                found: false,
                path: binary,
                version: "",
                compatible: false,
                minimumVersion: MIN_OPENOCD_VERSION,
                error: error.message
            })
        );
        child.on("close", () => {
            const version = parseOpenOcdVersion(output);
            const found = Boolean(version || /open on-chip debugger/i.test(output));
            finish({
                found,
                path: binary,
                version,
                ...checkOpenOcdVersion(version),
                error: found ? "" : "Executable output was not recognized as OpenOCD"
            });
        });
    });
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
function runOpenOcd(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = (options.spawnProcess || spawn)(executable, args, {
                cwd: options.cwd,
                windowsHide: true,
                shell: false
            });
        } catch (error) {
            reject(error);
            return;
        }
        const lines = [];
        let settled = false;
        const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(result);
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                /* process may already be exiting */
            }
            finish(Object.assign(new Error(`OpenOCD timed out after ${timeoutMs}ms`), { code: "OPENOCD_TIMEOUT" }));
        }, timeoutMs);
        let outputBytes = 0;
        const collect = (stream) => {
            let buffer = "";
            stream.on("data", (chunk) => {
                if (settled) return;
                outputBytes += chunk.length;
                if (outputBytes > 4 * 1024 * 1024 || buffer.length + chunk.length > 65536) {
                    child.kill("SIGKILL");
                    finish(Object.assign(new Error("OpenOCD output limit exceeded"), { code: "OPENOCD_OUTPUT_LIMIT" }));
                    return;
                }
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
        child.on("error", (error) => {
            finish(error);
        });
        child.on("close", (code) => {
            finish(null, { code: code == null ? -1 : code, lines });
        });
    });
}

// 统一预检：显式参数 > EmberProbe 配置（Agent Bridge）> 工作区/USB 自动检测。
// notes 携带检测工具缺失等提示，随 JSON 一并输出。
async function preflight(options) {
    const root = fs.realpathSync(path.resolve(options.workspace));
    const { config, diagnostic } = await getEmberProbeConfig(root);
    // diagnostics 保留 config.get 失败的原始诊断（错误码/详情），不因降级而丢弃；
    // sources 记录每个字段的最终来源，供 agent 区分显式参数、EmberProbe 配置与自动检测。
    const diagnostics = diagnostic ? [diagnostic] : [];
    const sources = { elf: "none", target: "none", probe: "none", openocd: "none" };
    const notes = [];
    let transport = normalizeTransport(options.transport ?? config?.transport ?? "auto");
    let probeSerial = normalizeProbeSerial(options["probe-serial"] ?? config?.probeSerial ?? "");
    const adapterSpeedKhz = normalizeAdapterSpeed(options["adapter-speed-khz"] ?? config?.adapterSpeedKhz ?? 0);
    sources.probeSerial =
        options["probe-serial"] !== undefined ? "explicit" : config?.probeSerial !== undefined ? "config" : "default";
    sources.adapterSpeedKhz =
        options["adapter-speed-khz"] !== undefined
            ? "explicit"
            : config?.adapterSpeedKhz !== undefined
              ? "config"
              : "default";
    sources.transport =
        options.transport !== undefined ? "explicit" : config?.transport !== undefined ? "config" : "default";
    let candidates = [];
    let elf = "";
    if (options.elf) {
        elf = String(options.elf);
        sources.elf = "explicit";
    } else if (config && config.elf) {
        elf = String(config.elf);
        sources.elf = "config";
    }
    let target = "";
    if (options.target) {
        target = String(options.target);
        sources.target = "explicit";
    } else if (config && config.mcu) {
        target = String(config.mcu);
        sources.target = "config";
    }
    let probe = "";
    if (options.probe) {
        probe = String(options.probe);
        sources.probe = "explicit";
    } else if (config && config.debugger) {
        probe = String(config.debugger);
        sources.probe = "config";
    }
    let openocd;
    if (options.openocd) {
        openocd = String(options.openocd);
        sources.openocd = "explicit";
    } else if (config && config.openocdPath) {
        openocd = String(config.openocdPath);
        sources.openocd = "config";
    } else {
        openocd = "openocd";
        sources.openocd = "default";
    }
    // Configuration values are workspace-relative by convention; canonicalize the
    // selected ELF before hashing/authorizing so the same bytes are flashed that the
    // user saw in preflight, regardless of the skill process' current directory.
    if (elf && !path.isAbsolute(elf)) elf = path.resolve(root, elf);
    if (!elf) {
        elf = findNewestElf(root);
        sources.elf = elf ? "auto" : "none";
    }
    if (!target) {
        target = inferTarget(root);
        sources.target = target ? "auto" : "none";
    }
    if (!probe) {
        const detected = await detectProbe();
        probe = detected.probe;
        candidates = detected.candidates;
        sources.probe = probe ? "auto" : "none";
        notes.push(...detected.notes);
    }
    const openocdCheck = await probeOpenOcdCompatibility(openocd);
    if (!openocdCheck.compatible) {
        const detected = openocdCheck.version ? ` ${openocdCheck.version}` : " with an unknown version";
        const action =
            process.platform === "win32"
                ? "Upgrade it or use EmberProbe's bundled xPack OpenOCD."
                : "Upgrade OpenOCD with your package manager and select the new executable.";
        notes.push(
            `OpenOCD${detected} is incompatible; EmberProbe requires ${MIN_OPENOCD_VERSION} or newer. ${action}`
        );
    }
    let elfMtimeUtc = "";
    let elfSha256 = "";
    if (elf) {
        try {
            elf = canonicalFileSync(elf);
            const stats = fs.statSync(elf);
            if (!stats.isFile())
                throw Object.assign(new Error("ELF path must be a file"), { code: "ELF_FILE_INVALID" });
            elfMtimeUtc = stats.mtime.toISOString();
            elfSha256 = await sha256(elf);
        } catch (error) {
            diagnostics.push(diagnosticForError(error, { operation: "elf.read" }));
            notes.push(`Cannot read ELF: ${error.message}`);
        }
    }
    let scriptsReady = false;
    if (target && probe) {
        try {
            resolveOpenOcdLaunch(openocd, probe, target, transport);
            const connection = await prepareProbeConnection({
                openocd,
                probe,
                target,
                transport,
                probeSerial,
                adapterSpeedKhz
            });
            if (!probeSerial && connection.probeSerial) sources.probeSerial = "inventory";
            probeSerial = connection.probeSerial;
            transport = connection.transport;
            if (connection.selection) sources.transport = connection.selection.transport;
            notes.push(...connection.inventory.notes);
            scriptsReady = true;
        } catch (error) {
            diagnostics.push(diagnosticForError(error, { operation: "openocd.launch" }));
            notes.push(error.message);
        }
    }
    return {
        transport,
        probeSerial,
        adapterSpeedKhz,
        probeCandidates: candidates,
        workspace: root,
        elf,
        elfSha256,
        elfMtimeUtc,
        target,
        probe,
        openocd,
        openocdVersion: openocdCheck.version,
        openocdCompatible: openocdCheck.compatible,
        minimumOpenocdVersion: MIN_OPENOCD_VERSION,
        ready: Boolean(elfSha256 && target && probe && scriptsReady && openocdCheck.compatible),
        notes,
        sources,
        diagnostics
    };
}

function emit(value) {
    process.stdout.write(JSON.stringify(value) + "\n");
}

module.exports = {
    parseArgs,
    getEmberProbeConfig,
    authorizeFlash,
    findNewestElf,
    inferTarget,
    detectProbe,
    probeFromText,
    sha256,
    isSafeCfgPath,
    resolveExecutablePath,
    parseOpenOcdVersion,
    checkOpenOcdVersion,
    probeOpenOcdCompatibility,
    resolveOpenOcdLaunch,
    tclQuote,
    toPosix,
    runOpenOcd,
    preflight,
    emit,
    MIN_OPENOCD_VERSION
};
