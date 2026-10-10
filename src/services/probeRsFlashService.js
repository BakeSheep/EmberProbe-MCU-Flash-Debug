"use strict";

const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { inspectElf } = require("../../skills/_emberprobe/elf-file");
const { serializeError } = require("./errorEnvelope");

const MAX_LINE_CHARS = 2000;
const MAX_TAIL_CHARS = 8000;

function probeRsArgs(command, settings, elf) {
    const chip = String(settings.chip || "").trim();
    if (!chip || !/^[A-Za-z0-9_.+-]+$/.test(chip)) throw new Error("Set emberprobe.probeRsChip before using probe-rs");
    const args = [command, "--chip", chip, "--non-interactive"];
    if (settings.probe) args.push("--probe", settings.probe);
    if (settings.speed) args.push("--speed", String(settings.speed));
    if (settings.protocol) {
        const protocol = String(settings.protocol).toLowerCase();
        if (!["swd", "jtag"].includes(protocol)) throw new Error("Invalid probe-rs wire protocol");
        args.push("--protocol", protocol);
    }
    if (command === "download") args.push("--verify", "--reset", "--binary-format", "elf");
    if (elf) args.push(elf);
    return args;
}

function runProbeRs(executable, args, cwd, options = {}) {
    return new Promise((resolve, reject) => {
        const pending = ["", ""];
        const emitLine = (line) => {
            if (!line) return;
            try {
                options.onLine?.(line.slice(-MAX_LINE_CHARS));
            } catch {
                // An output observer must not release ownership before process exit.
            }
        };
        const child = execFile(
            executable,
            args,
            { cwd, windowsHide: true, timeout: options.timeoutMs ?? 120000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                pending.forEach(emitLine);
                if (error) {
                    error.message = `${error.message}\n${String(stderr || stdout).slice(-2000)}`;
                    error.stdout = stdout;
                    error.stderr = stderr;
                    reject(error);
                } else resolve({ stdout, stderr });
            }
        );
        if (options.onLine) {
            [child.stdout, child.stderr].forEach((stream, index) => {
                stream.setEncoding("utf8");
                stream.on("data", (chunk) => {
                    const lines = (pending[index] + chunk).split(/[\r\n]/);
                    pending[index] = lines.pop().slice(-MAX_LINE_CHARS);
                    lines.forEach(emitLine);
                });
            });
        }
        // Some CLI versions still prompt for ambiguous probes despite --non-interactive.
        child.stdin.end();
    });
}

function flashStageFromLine(line, fallback) {
    if (/\b(?:resetting|reset failed|failed to reset)\b/i.test(line)) return "reset";
    if (/\b(?:verifying|verification|verify failed|verified)\b/i.test(line)) return "verify";
    if (/\b(?:programming|writing (?:flash|firmware)|program failed|write failed)\b/i.test(line)) return "program";
    if (/\b(?:erasing|erase failed|failed to erase)\b/i.test(line)) return "erase";
    return fallback;
}

async function downloadWithProbeRs(settings, elf, cwd, options = {}) {
    let temporary;
    let inspected;
    let stage = "prepare";
    let started = false;
    let probeRsTail = "";
    const timeoutMs = options.timeoutMs ?? 120000;
    const report = (event) => {
        try {
            options.onProgress?.({ backend: "probe-rs", ...event });
        } catch {
            // Progress delivery cannot interrupt a hardware operation or its cleanup.
        }
    };
    const onLine = (line) => {
        const clean = String(line)
            .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
            .trim()
            .slice(-MAX_LINE_CHARS);
        if (!clean) return;
        probeRsTail = `${probeRsTail}${clean}\n`.slice(-MAX_TAIL_CHARS);
        stage = flashStageFromLine(clean, stage);
        report({
            stage,
            level: /\b(?:error|failed|failure|mismatch)\b/i.test(clean) ? "error" : "info",
            message: clean
        });
    };
    try {
        const args = probeRsArgs("download", settings);
        report({ stage, level: "info", key: "pr.flashPreparing" });
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-probe-rs-"));
        const snapshot = path.join(temporary, "firmware.elf");
        inspected = await inspectElf(elf, { snapshot });
        await options.beforeRun?.();
        stage = "download";
        report({ stage, level: "info", key: "pr.flashRunning" });
        started = true;
        await (options.run || runProbeRs)(settings.executable, [...args, snapshot], cwd, { timeoutMs, onLine });
        report({ stage: "complete", level: "success", key: "msg.downloadSuccess" });
        return inspected;
    } catch (error) {
        if (started) {
            if (!probeRsTail && (error.stderr || error.stdout))
                String(error.stderr || error.stdout)
                    .split(/[\r\n]/)
                    .forEach(onLine);
            stage = flashStageFromLine(String(error.message), stage);
        }
        const timedOut = started && error.killed === true && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const resultUnknown = started && !["ENOENT", "EACCES", "ENOEXEC"].includes(error.code);
        const message = String(error.message || error).slice(-MAX_LINE_CHARS);
        const failure = Object.assign(new Error(`probe-rs ${stage} ${timedOut ? "timed out" : "failed"}: ${message}`), {
            code: started
                ? timedOut
                    ? "PROBE_RS_TIMEOUT"
                    : "PROBE_RS_FLASH_FAILED"
                : error.code || "PROBE_RS_FLASH_FAILED",
            stage,
            retryable: false,
            i18nKey: timedOut ? "pr.flashTimeout" : "pr.flashFailed",
            i18nParams: { stage, error: message, timeoutMs },
            details: {
                backend: "probe-rs",
                chip: settings.chip,
                probe: settings.probe || "",
                elfSha256: inspected?.sha256,
                timeoutMs,
                resultUnknown,
                exitCode: error.code,
                signal: error.signal,
                probeRsTail
            }
        });
        report({
            stage,
            level: "error",
            key: failure.i18nKey,
            params: failure.i18nParams,
            message: failure.message,
            diagnostic: serializeError(failure)
        });
        throw failure;
    } finally {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
}

module.exports = { probeRsArgs, runProbeRs, downloadWithProbeRs };
