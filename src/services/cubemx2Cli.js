"use strict";
const fs = require("fs/promises");
const { spawn } = require("child_process");
const { failure } = require("./cubemxEnvironment");

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LOG_ENTRY_BYTES = 64 * 1024;

// Environment for the CubeMX2 backend and CLI: the caller's environment with the bundle's exported
// variables. The VS Code extension host runs with ELECTRON_RUN_AS_NODE, which would turn the Electron
// backend into a plain Node process, and NODE_OPTIONS could load code into the bundled Node.
function cubeEnvironment(bundle, base = process.env) {
    const env = { ...base, ...bundle.env };
    for (const key of Object.keys(env))
        if (/^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|NODE_OPTIONS)$/i.test(key)) delete env[key];
    return env;
}

// The CLI prints one JSON document ({ status, data } or { status, errorMessage }); warnings may precede it,
// and error documents were seen on stdout as well as stderr.
function parseDocument(text) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].startsWith("{")) continue;
        try {
            const document = JSON.parse(lines.slice(index).join("\n"));
            if (document && typeof document.status === "string") return document;
        } catch {
            // Not the document start; keep looking.
        }
    }
    return null;
}

function commandFailure(message, details) {
    const packMissing =
        /\bpacks?\b/i.test(message) && /not (?:be )?(?:found|installed)|missing|download/i.test(message);
    const error = failure(packMissing ? "CUBEMX2_PACK_MISSING" : "CUBEMX2_COMMAND_FAILED", message, details);
    if (packMissing)
        error.suggestedActions = [
            "Install the missing pack in the CubeMX2 application, then prepare again. EmberProbe does not download packs."
        ];
    return error;
}

async function appendLog(logPath, text) {
    if (!logPath) return;
    await fs
        .appendFile(logPath, text.length > LOG_ENTRY_BYTES ? text.slice(0, LOG_ENTRY_BYTES) + "\n[truncated]\n" : text)
        .catch(() => {});
}

// Run one MX CLI command against an owned backend and return its data. Commands are argument vectors
// without a shell; the project path and port come from EmberProbe, never from the Agent.
async function runCli(bundle, argv, options = {}) {
    const args = [
        bundle.cli,
        ...argv,
        ...(options.project ? ["-p", options.project] : []),
        "--port",
        String(options.port)
    ];
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
        let child;
        try {
            child = (options.spawn || spawn)(bundle.node, args, {
                env: options.env || cubeEnvironment(bundle),
                cwd: options.cwd,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                shell: false
            });
        } catch (error) {
            reject(failure("CUBEMX2_CLI_FAILED", "Cannot start the CubeMX2 CLI: " + error.message));
            return;
        }
        const out = [];
        const err = [];
        let size = 0;
        let settled = false;
        let reason;
        const stop = (why) => {
            if (reason) return;
            reason = why;
            child.kill();
        };
        const collect = (target) => (chunk) => {
            size += chunk.length;
            if (size > MAX_OUTPUT_BYTES) stop("output");
            else target.push(chunk);
        };
        child.stdout?.on("data", collect(out));
        child.stderr?.on("data", collect(err));
        const timer = setTimeout(() => stop("timeout"), options.timeoutMs || 120000);
        const abort = () => stop("cancelled");
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        const finish = (value, isError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            (isError ? reject : resolve)(value);
        };
        child.on("error", (error) =>
            finish(failure("CUBEMX2_CLI_FAILED", "CubeMX2 CLI failed: " + error.message), true)
        );
        child.on("close", (code) =>
            finish({
                code,
                reason,
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(err).toString("utf8")
            })
        );
    });
    const command = argv.filter((part) => !part.startsWith("--")).join(" ");
    await appendLog(
        options.logPath,
        `$ ${argv.join(" ")}\n[exit ${result.code}${result.reason ? ", " + result.reason : ""}, ${Date.now() - started} ms]\n` +
            `${result.stdout}${result.stderr ? "\n[stderr]\n" + result.stderr : ""}\n`
    );
    if (result.reason === "cancelled") throw failure("CUBEMX_CANCELLED", "Generation cancelled");
    if (result.reason === "timeout")
        throw failure("CUBEMX2_TIMEOUT", `CubeMX2 command timed out: ${command}`, { command });
    if (result.reason === "output")
        throw failure("CUBEMX2_OUTPUT_TOO_LARGE", `CubeMX2 output exceeded 16 MiB: ${command}`, { command });
    const document = parseDocument(result.stdout) || parseDocument(result.stderr);
    if (document?.status === "success" && result.code === 0) return document.data;
    const message =
        typeof document?.errorMessage === "string"
            ? document.errorMessage
            : (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ") ||
              `CubeMX2 CLI exited with code ${result.code}`;
    throw commandFailure(message.slice(0, 2000), { command, exitCode: result.code });
}

module.exports = { runCli, parseDocument, cubeEnvironment };
