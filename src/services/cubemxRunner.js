"use strict";
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { failure } = require("./cubemxEnvironment");

const { createLogMonitor } = require("./cubemxLog");

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
        const monitor = createLogMonitor();
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
        child.stdout.on("data", monitor.stdout);
        child.stderr.on("data", monitor.stderr);
        child.once("error", (error) => {
            cleanup();
            reject(failure("CUBEMX_START_FAILED", error.message));
        });
        child.once("close", (code) => {
            cleanup();
            const { log, confirmed, failureLine, diagnostic, generatedFiles } = monitor.finish();
            const details = { log: diagnostic, ...(failureLine ? { failureLine } : {}) };
            if (stopped) reject(failure(stopped, "CubeMX stopped", details));
            else if (code !== 0 || failureLine)
                reject(failure("CUBEMX_GENERATION_FAILED", "CubeMX did not complete cleanly", { code, ...details }));
            else if (!confirmed)
                reject(failure("CUBEMX_OUTPUT_UNCONFIRMED", "CubeMX did not report successful generation", details));
            else resolve({ log, generatedFiles });
        });
    });
}
module.exports = { runCubeMx };
