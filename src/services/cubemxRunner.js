"use strict";
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { failure } = require("./cubemxEnvironment");

async function runCubeMx(tool, directory, iocName, options = {}) {
    const quote = (value) => {
        if (/[\r\n"]/.test(value)) throw failure("CUBEMX_PATH_INVALID", "Invalid CLI path");
        return `"${value}"`;
    };
    const script = path.join(directory, ".emberprobe-cubemx-script.txt");
    await fs.writeFile(
        script,
        [
            `config load ${quote(path.join(directory, iocName))}`,
            `project path ${quote(directory)}`,
            "project generate",
            "exit",
            ""
        ].join("\n")
    );
    if (options.signal?.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
    return new Promise((resolve, reject) => {
        let log = "";
        let stopped = "";
        const child = (options.spawn || spawn)(tool.java, ["-jar", tool.executable, "-q", script], {
            cwd: path.dirname(tool.executable),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        const stop = (code) => {
            stopped = code;
            child.kill();
        };
        const cancel = () => stop("CUBEMX_CANCELLED");
        const timer = setTimeout(() => stop("CUBEMX_TIMEOUT"), options.timeoutMs || 300000);
        options.signal?.addEventListener("abort", cancel, { once: true });
        const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", cancel);
        };
        const capture = (chunk) => {
            log = (log + chunk.toString()).slice(-1024 * 1024);
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("error", (error) => {
            cleanup();
            reject(failure("CUBEMX_START_FAILED", error.message));
        });
        child.once("close", (code) => {
            cleanup();
            if (stopped) reject(failure(stopped, "CubeMX stopped", { log }));
            else if (
                code !== 0 ||
                /\b(?:error|exception|failed|migration|migrate)\b|not installed|not found|please.*download/i.test(log)
            )
                reject(failure("CUBEMX_GENERATION_FAILED", "CubeMX did not complete cleanly", { code, log }));
            else if (!/(?:generat[^\r\n]*(?:success|succes)|(?:success|succes)[^\r\n]*generat)/i.test(log))
                reject(failure("CUBEMX_OUTPUT_UNCONFIRMED", "CubeMX did not report successful generation", { log }));
            else resolve({ log });
        });
    });
}
module.exports = { runCubeMx };
