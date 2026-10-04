"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { testsForGroup } = require("./test-groups");
const root = path.resolve(__dirname, "..");

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
                if (options.stream !== false) stream.write(chunk);
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
    const output = log.join("");
    if (options.reportDir && (options.keepLogs || result.code !== 0))
        fs.writeFileSync(path.join(options.reportDir, relative.replace(/[^a-zA-Z0-9.-]/g, "_") + ".log"), output);
    if (options.stream === false && output) process.stdout.write(output);
    console.log(
        (result.code ? "FAIL " : "PASS ") + relative + " (" + result.durationMs + "ms, exit " + result.code + ")"
    );
    return { ...result, output };
}

function optionValue(args, name) {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
}

function parseJobs(args) {
    if (args.includes("--jobs") && optionValue(args, "--jobs") === undefined)
        throw new Error("--jobs requires a value");
    const value = optionValue(args, "--jobs");
    if (value === undefined)
        return Math.min(4, typeof os.availableParallelism === "function" ? os.availableParallelism() : 4);
    const jobs = Number(value);
    if (!Number.isInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer");
    return jobs;
}

async function runFiles(files, options = {}) {
    const jobs = Math.max(1, Math.min(options.jobs || 1, files.length || 1));
    if (jobs === 1) {
        const results = [];
        for (const file of files) results.push(await runFile(file, options));
        return results;
    }
    const results = new Array(files.length);
    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= files.length) return;
            results[index] = await runFile(files[index], { ...options, stream: false });
        }
    }
    await Promise.all(Array.from({ length: jobs }, () => worker()));
    return results;
}

async function main(args = process.argv.slice(2)) {
    const syntaxOnly = args.includes("--syntax");
    const releaseOnly = args.includes("--release");
    const requestedGroup = optionValue(args, "--group");
    if (args.includes("--group") && requestedGroup === undefined) throw new Error("--group requires a value");
    const group = requestedGroup || (releaseOnly ? "release" : "core");
    // Validate names before deriving or clearing any report path.
    const testFiles = testsForGroup(root, group);
    if (releaseOnly && group !== "release") throw new Error("--release cannot select a different test group");
    const testsOnly = args.includes("--tests") || args.includes("--quality") || releaseOnly || requestedGroup;
    const reportName = syntaxOnly ? "syntax" : releaseOnly ? "release" : group === "core" ? "tests" : "tests-" + group;
    const reportDir = path.join(root, "test-results", reportName);
    const jobs = parseJobs(args);
    const keepLogs = args.includes("--keep-logs");
    fs.rmSync(reportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(reportDir, { recursive: true });
    const metadata = {
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
        node: process.version,
        npm: process.env.npm_config_user_agent || "direct node invocation",
        group,
        jobs,
        sha:
            process.env.GITHUB_SHA ||
            spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim()
    };
    console.log(JSON.stringify(metadata));
    const results = [];
    if (!testsOnly) {
        results.push(
            ...(await runFiles(
                ["src", "skills", "scripts"].flatMap((dir) => discover(path.join(root, dir), true)),
                { syntax: true, reportDir, jobs, keepLogs }
            ))
        );
    }
    if (!syntaxOnly) {
        results.push(...(await runFiles(testFiles, { reportDir, jobs, keepLogs })));
    }
    const failed = results.filter((result) => result.code !== 0);
    const reportResults = results.map(({ output, ...result }) => result);
    fs.writeFileSync(
        path.join(reportDir, "summary.json"),
        JSON.stringify({ metadata, results: reportResults, failed: failed.length }, null, 2)
    );
    console.log(results.length + " files checked; " + failed.length + " failed");
    process.exitCode = failed.length ? 1 : 0;
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { discover, main, optionValue, parseJobs, runFile, runFiles };
