"use strict";

const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { inspectElf } = require("../../skills/_emberprobe/elf-file");

function probeRsArgs(command, settings, elf) {
    const chip = String(settings.chip || "").trim();
    if (!chip || !/^[A-Za-z0-9_.+-]+$/.test(chip)) throw new Error("Set emberprobe.probeRsChip before using probe-rs");
    const args = [command, "--chip", chip, "--non-interactive"];
    if (settings.probe) args.push("--probe", settings.probe);
    if (settings.speed) args.push("--speed", String(settings.speed));
    if (elf) args.push(elf);
    return args;
}

function runProbeRs(executable, args, cwd) {
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            args,
            { cwd, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    error.message = `${error.message}\n${String(stderr || stdout).slice(-2000)}`;
                    reject(error);
                } else resolve({ stdout, stderr });
            }
        );
    });
}

async function downloadWithProbeRs(settings, elf, cwd) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-probe-rs-"));
    try {
        const snapshot = path.join(temporary, "firmware.elf");
        const inspected = await inspectElf(elf, { snapshot });
        await runProbeRs(settings.executable, probeRsArgs("download", settings, snapshot), cwd);
        await runProbeRs(settings.executable, probeRsArgs("reset", settings), cwd);
        return inspected;
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

module.exports = { probeRsArgs, runProbeRs, downloadWithProbeRs };
