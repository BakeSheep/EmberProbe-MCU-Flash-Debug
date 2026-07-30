"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { isSafeCfg, quoteTclWord } = require("../../src/openocdRunner");

function required(name) {
    const value = String(process.env[name] || "").trim();
    if (!value)
        throw Object.assign(new Error(`Missing required environment variable: ${name}`), {
            code: "HIL_CONFIG_MISSING"
        });
    return value;
}

function runOpenOcd(executable, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { shell: false, windowsHide: true });
        let output = "";
        const collect = (chunk) => {
            output += chunk.toString();
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const timer = setTimeout(() => {
            child.kill();
            reject(
                Object.assign(new Error(`OpenOCD HIL run timed out after ${timeoutMs}ms`), {
                    code: "HIL_TIMEOUT",
                    output: output.slice(-8000)
                })
            );
        }, timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(output);
            else
                reject(
                    Object.assign(new Error(`OpenOCD exited with code ${code}`), {
                        code: "HIL_OPENOCD_FAILED",
                        exitCode: code,
                        output: output.slice(-8000)
                    })
                );
        });
    });
}

async function main() {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES") {
        throw Object.assign(new Error("Set EMBERPROBE_HIL_CONFIRM=YES to permit flashing physical hardware"), {
            code: "HIL_CONFIRMATION_REQUIRED"
        });
    }
    const board = required("EMBERPROBE_HIL_BOARD");
    const executable = required("EMBERPROBE_HIL_OPENOCD");
    const probe = required("EMBERPROBE_HIL_PROBE");
    const target = required("EMBERPROBE_HIL_TARGET");
    const elf = path.resolve(required("EMBERPROBE_HIL_ELF"));
    if (!isSafeCfg(probe) || !isSafeCfg(target)) {
        throw Object.assign(new Error("Probe and target must be safe relative .cfg paths"), {
            code: "HIL_INVALID_CFG"
        });
    }
    if (!fs.statSync(elf).isFile() || path.extname(elf).toLowerCase() !== ".elf") {
        throw Object.assign(new Error(`HIL firmware is not an ELF file: ${elf}`), { code: "HIL_INVALID_ELF" });
    }
    const fingerprint = crypto.createHash("sha256").update(fs.readFileSync(elf)).digest("hex");
    const args = [
        "-f",
        `interface/${probe}`,
        "-f",
        `target/${target}`,
        "-c",
        "init",
        "-c",
        "reset halt",
        "-c",
        `program ${quoteTclWord(elf)} verify reset exit`
    ];
    const output = await runOpenOcd(executable, args, 120000);
    if (!/verified|verified OK|shutdown command invoked/i.test(output)) {
        throw Object.assign(new Error("OpenOCD completed without a recognizable verification marker"), {
            code: "HIL_VERIFY_MARKER_MISSING",
            output: output.slice(-8000)
        });
    }
    console.log(JSON.stringify({ ok: true, board, elf, sha256: fingerprint, probe, target }));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(
            JSON.stringify({
                ok: false,
                code: error.code || "HIL_FAILED",
                message: error.message,
                output: error.output
            })
        );
        process.exitCode = 1;
    });
}

module.exports = { required, runOpenOcd };
