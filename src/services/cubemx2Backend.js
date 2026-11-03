"use strict";
const fs = require("fs/promises");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { failure } = require("./cubemxEnvironment");
const { runCli, cubeEnvironment } = require("./cubemx2Cli");

const START_TIMEOUT_MS = 60000;
const STOP_WAIT_MS = 10000;
const LOG_BYTES = 256 * 1024;

function delay(ms, clock) {
    return new Promise((resolve) => (clock?.setTimeout || setTimeout)(resolve, ms));
}

// Start a guiless CubeMX2 backend owned by one operation. A private user data directory makes it a
// separate Electron instance, so it never hands over to (or takes over) a CubeMX2 window the user has
// open. Every CLI call addresses it by its port.
async function startBackend(bundle, options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || cubeEnvironment(bundle);
    if (options.signal?.aborted) throw failure("CUBEMX_CANCELLED", "Generation cancelled");
    await fs.mkdir(options.userDataDir, { recursive: true });
    const args = [
        "--guiless",
        "--allow-multiple-windows",
        "--no-sandbox",
        `--backendTimeout=${options.backendTimeoutMs || 3600000}`,
        `--user-data-dir=${options.userDataDir}`
    ];
    let child;
    try {
        child = (options.spawn || spawn)(bundle.backend, args, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
            // A separate process group lets Linux stop the whole backend tree.
            detached: platform !== "win32",
            windowsHide: true,
            shell: false
        });
    } catch (error) {
        throw failure("CUBEMX2_BACKEND_FAILED", "Cannot start the CubeMX2 backend: " + error.message);
    }
    let log = "";
    const record = (chunk) => {
        if (log.length < LOG_BYTES) log += String(chunk);
    };
    let exited = false;
    const exit = new Promise((resolve) =>
        child.once("exit", (code) => {
            exited = true;
            resolve(code);
        })
    );
    child.once("error", () => {
        exited = true;
    });
    const port = await new Promise((resolve, reject) => {
        let done = false;
        const settle = (fn, value) => {
            if (done) return;
            done = true;
            (options.clock?.clearTimeout || clearTimeout)(timer);
            fn(value);
        };
        const timer = (options.clock?.setTimeout || setTimeout)(
            () => settle(reject, failure("CUBEMX2_BACKEND_FAILED", "CubeMX2 backend did not report its port")),
            options.startTimeoutMs || START_TIMEOUT_MS
        );
        child.stdout?.on("data", (chunk) => {
            record(chunk);
            const match = /BACKEND_PORT\s*(\d{1,5})/.exec(log);
            if (match) settle(resolve, Number(match[1]));
        });
        child.stderr?.on("data", record);
        child.once("error", (error) =>
            settle(reject, failure("CUBEMX2_BACKEND_FAILED", "CubeMX2 backend failed: " + error.message))
        );
        exit.then((code) =>
            settle(
                reject,
                failure("CUBEMX2_BACKEND_FAILED", `CubeMX2 backend exited with code ${code} before it was ready`, {
                    code: "backend_exited"
                })
            )
        );
        options.signal?.addEventListener(
            "abort",
            () => settle(reject, failure("CUBEMX_CANCELLED", "Generation cancelled")),
            { once: true }
        );
    }).catch(async (error) => {
        await killTree(child.pid, platform, options).catch(() => {});
        if (options.logPath) await fs.appendFile(options.logPath, `[backend]\n${log}\n`).catch(() => {});
        throw error;
    });
    if (port < 1 || port > 65535) throw failure("CUBEMX2_BACKEND_FAILED", "CubeMX2 backend reported an invalid port");

    const session = {
        port,
        pid: child.pid,
        run: (argv, runOptions = {}) =>
            (options.runCli || runCli)(bundle, argv, { env, logPath: options.logPath, ...runOptions, port }),
        // Stop the backend; resolves true once the process has exited.
        async close() {
            if (!exited) {
                await (options.runCli || runCli)(bundle, ["shutdown"], {
                    env,
                    port,
                    logPath: options.logPath,
                    timeoutMs: 15000
                }).catch(() => {});
                await Promise.race([exit, delay(STOP_WAIT_MS, options.clock)]);
            }
            if (!exited) {
                await killTree(child.pid, platform, options).catch(() => {});
                await Promise.race([exit, delay(STOP_WAIT_MS, options.clock)]);
            }
            if (options.logPath) await fs.appendFile(options.logPath, `[backend]\n${log}\n`).catch(() => {});
            return exited;
        }
    };
    return session;
}

function killTree(pid, platform, options = {}) {
    if (!pid) return Promise.resolve();
    if (platform === "win32")
        return /** @type {Promise<void>} */ (
            new Promise((resolve) =>
                (options.execFile || execFile)(
                    "taskkill",
                    ["/PID", String(pid), "/T", "/F"],
                    { windowsHide: true },
                    () => resolve()
                )
            )
        );
    try {
        (options.kill || process.kill)(-pid, "SIGKILL");
    } catch {
        // Already gone.
    }
    return Promise.resolve();
}

// The backend keeps per-project scratch state in a working area named after the project's workingAreaId.
// Remove the one a staged copy created; the path comes from the CLI and must end in that id.
async function removeWorkingArea(reportedPath, id) {
    if (typeof reportedPath !== "string" || !id) return false;
    let directory = path.resolve(reportedPath);
    while (path.basename(directory) !== id) {
        const parent = path.dirname(directory);
        if (parent === directory) return false;
        directory = parent;
    }
    if (path.basename(path.dirname(directory)) !== "working_area") return false;
    await fs.rm(directory, { recursive: true, force: true });
    return true;
}

module.exports = { startBackend, removeWorkingArea, killTree };
