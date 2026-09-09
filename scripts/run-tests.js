"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const RELEASE_TESTS = new Set(["release-consistency.test.js"]);

function discover(directory, recursive = false) {
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const file = path.join(directory, entry.name);
            return entry.isDirectory() ? (recursive ? discover(file, true) : []) : [file];
        })
        .filter((file) => file.endsWith(".js"))
        .sort();
}

function terminateTree(child) {
    if (!child.pid) return;
    if (process.platform === "win32") {
        const result = spawnSync(
            path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
            ["/pid", String(child.pid), "/T", "/F"],
            {
                windowsHide: true,
                timeout: 5000
            }
        );
        if (result.status !== 0) child.kill("SIGKILL");
    } else {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    }
}

async function runFile(file, options = {}) {
    const started = Date.now();
    const relative = path.relative(root, file).replace(/\\/g, "/");
    console.log("START " + relative);
    const args = options.syntax ? ["--check", file] : [file];
    const log = [];
    let timedOut = false;
    const env = { ...process.env };
    // macOS exposes /var through a symlink. Give every child a canonical, private
    // temp root so new fixtures do not repeat platform-specific path assertions.
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-test-env-")));
    const temp = path.join(sandbox, "tmp");
    fs.mkdirSync(temp);
    for (const key of Object.keys(env)) {
        if (["path", "home", "userprofile", "openocd_scripts", "tmp", "temp", "tmpdir"].includes(key.toLowerCase()))
            delete env[key];
    }
    env.PATH = sandbox;
    env.HOME = sandbox;
    env.USERPROFILE = sandbox;
    env.XDG_CONFIG_HOME = sandbox;
    env.TMPDIR = temp;
    env.TMP = temp;
    env.TEMP = temp;
    delete env.OPENOCD_SCRIPTS;
    let result;
    try {
        result = await new Promise((resolve) => {
            const child = spawn(process.execPath, args, {
                cwd: root,
                env,
                windowsHide: true,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"]
            });
            const capture = (stream, chunk) => {
                log.push(chunk.toString());
                stream.write(chunk);
            };
            child.stdout.on("data", (chunk) => capture(process.stdout, chunk));
            child.stderr.on("data", (chunk) => capture(process.stderr, chunk));
            child.on("error", (error) => log.push(error.stack || error.message));
            const timer = setTimeout(() => {
                timedOut = true;
                log.push("Test exceeded its execution timeout");
                terminateTree(child);
            }, options.timeoutMs || 120000);
            child.on("close", (code, signal) => {
                clearTimeout(timer);
                resolve({
                    file: relative,
                    code: timedOut ? 124 : (code ?? 1),
                    signal,
                    timedOut,
                    durationMs: Date.now() - started
                });
            });
        });
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (options.reportDir)
        fs.writeFileSync(path.join(options.reportDir, relative.replace(/[^a-zA-Z0-9.-]/g, "_") + ".log"), log.join(""));
    console.log(
        (result.code ? "FAIL " : "PASS ") + relative + " (" + result.durationMs + "ms, exit " + result.code + ")"
    );
    return result;
}

async function main(args = process.argv.slice(2)) {
    const syntaxOnly = args.includes("--syntax");
    const releaseOnly = args.includes("--release");
    const testsOnly = args.includes("--tests") || args.includes("--quality") || releaseOnly;
    const reportDir = path.join(root, "test-results", syntaxOnly ? "syntax" : releaseOnly ? "release" : "tests");
    fs.mkdirSync(reportDir, { recursive: true });
    const metadata = {
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
        node: process.version,
        npm: process.env.npm_config_user_agent || "direct node invocation",
        sha:
            process.env.GITHUB_SHA ||
            spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim()
    };
    console.log(JSON.stringify(metadata));
    const results = [];
    if (!testsOnly) {
        for (const file of ["src", "skills", "scripts"].flatMap((dir) => discover(path.join(root, dir), true)))
            results.push(await runFile(file, { syntax: true, reportDir }));
    }
    if (!syntaxOnly) {
        for (const file of discover(path.join(root, "test")).filter(
            (file) => file.endsWith(".test.js") && RELEASE_TESTS.has(path.basename(file)) === releaseOnly
        ))
            results.push(await runFile(file, { reportDir }));
    }
    const failed = results.filter((result) => result.code !== 0);
    fs.writeFileSync(
        path.join(reportDir, "summary.json"),
        JSON.stringify({ metadata, results, failed: failed.length }, null, 2)
    );
    console.log(results.length + " files checked; " + failed.length + " failed");
    process.exitCode = failed.length ? 1 : 0;
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { discover, runFile, main };
