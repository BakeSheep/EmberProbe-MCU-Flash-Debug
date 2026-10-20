"use strict";

// Opt-in real-board smoke: chip info, flash + verify, variable read/write and a managed debug session
// for each configured board/probe profile, run in an isolated VS Code development host.
// DESTRUCTIVE: every profile erases and programs the target. See test/hil/README.md.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { loadConfig, parseArgs, profileNames, resolveProfile } = require("./smoke-profile");

const root = path.resolve(__dirname, "../..");
const VSCODE_VERSION = "1.136.1";

function configPath(options) {
    return path.resolve(
        options.config || process.env.EMBERPROBE_SMOKE_CONFIG || path.join(__dirname, "smoke.local.json")
    );
}

function executable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

// Read-only environment check for one platform; never opens the probe.
function doctor(config, names) {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const problems = [];
    for (const name of names) {
        let profile;
        try {
            profile = resolveProfile(config, name);
        } catch (error) {
            problems.push(error.message);
            continue;
        }
        const checks = [
            ["openocd", executable(profile.openocd), profile.openocd],
            ["gdb", executable(path.join(profile.toolchain, `arm-none-eabi-gdb${suffix}`)), profile.toolchain],
            ["objdump", executable(path.join(profile.toolchain, `arm-none-eabi-objdump${suffix}`)), profile.toolchain],
            ["elf", fs.existsSync(profile.elf), profile.elf],
            ...(profile.svd ? [["svd", fs.existsSync(profile.svd), profile.svd]] : [])
        ];
        for (const [label, ok, detail] of checks) {
            console.log(`${ok ? "ok  " : "MISS"} ${process.platform} ${name} ${label}: ${detail}`);
            if (!ok) problems.push(`${name}: ${label} not found at ${detail}`);
        }
    }
    if (!fs.existsSync(path.join(root, "dist", "extension.js")))
        console.log("note: dist/extension.js is missing; run npm run bundle before the smoke run");
    return problems;
}

async function runProfile(profile, repeat = 1) {
    const { runTests } = require("@vscode/test-electron");
    const temporary = path.join(root, ".vscode-test", `smoke-${profile.name}-${process.pid}`);
    if (!path.resolve(temporary).startsWith(path.join(root, ".vscode-test") + path.sep))
        throw new Error("Unsafe smoke workspace path");
    const workspace = path.join(temporary, "workspace");
    // A private temp directory, like scripts/run-tests.js: some hosts deny the test build writes to %TEMP%.
    const tmp = path.join(temporary, "tmp");
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(tmp, { recursive: true });
    // ELF and SVD configuration must stay inside the workspace, so both are copied there.
    const elfRelative = path.basename(profile.elf);
    await fsp.copyFile(profile.elf, path.join(workspace, elfRelative));
    const svdRelative = profile.svd ? path.basename(profile.svd) : "";
    if (svdRelative) await fsp.copyFile(profile.svd, path.join(workspace, svdRelative));
    const started = Date.now();
    try {
        await runTests({
            version: VSCODE_VERSION,
            extensionDevelopmentPath: root,
            extensionTestsPath: path.resolve(__dirname, "smoke.test.js"),
            extensionTestsEnv: {
                EMBERPROBE_E2E: "1",
                TEMP: tmp,
                TMP: tmp,
                TMPDIR: tmp,
                EMBERPROBE_SMOKE_PROFILE: JSON.stringify({ ...profile, elfRelative, svdRelative, repeat })
            },
            launchArgs: [
                workspace,
                `--user-data-dir=${temporary}/user-data`,
                `--extensions-dir=${temporary}/extensions`,
                "--disable-extensions",
                "--disable-workspace-trust",
                "--disable-gpu",
                "--skip-welcome",
                "--skip-release-notes"
            ]
        });
        return { profile: profile.name, passed: true, ms: Date.now() - started };
    } catch (error) {
        // Output channels (OpenOCD, GDB, adapter) are only in the VS Code logs, which the cleanup below removes.
        const logs = path.join(root, "test-results", "hil-logs", `${process.platform}-${profile.name}`);
        await fsp.rm(logs, { recursive: true, force: true });
        await fsp.cp(path.join(temporary, "user-data", "logs"), logs, { recursive: true }).catch(() => {});
        return { profile: profile.name, passed: false, ms: Date.now() - started, error: error.message, logs };
    } finally {
        await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const config = loadConfig(configPath(options));
    const names = profileNames(config, options.profiles);
    if (options.doctor) {
        const problems = doctor(config, names);
        if (problems.length) process.exitCode = 1;
        return;
    }
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES to permit erasing and programming the configured boards");
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
        throw new Error("No display: run under xvfb-run -a");
    if (!fs.existsSync(path.join(root, "dist", "extension.js"))) throw new Error("Run npm run bundle first");
    const profiles = names.map((name) => resolveProfile(config, name));
    const results = [];
    for (const profile of profiles) {
        console.log(`\n== ${process.platform} ${profile.name} (${profile.probe} / ${profile.target})`);
        results.push(await runProfile(profile, options.repeat || 1));
    }
    const summary = { platform: process.platform, finishedAt: new Date().toISOString(), results };
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    fs.writeFileSync(
        path.join(root, "test-results", `hil-smoke-${process.platform}.json`),
        JSON.stringify(summary, null, 2)
    );
    for (const result of results)
        console.log(`${result.passed ? "PASS" : "FAIL"} ${process.platform} ${result.profile} (${result.ms} ms)`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
