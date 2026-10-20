"use strict";

// Windows orchestrator for the HIL smoke matrix. For each board/probe profile it runs the smoke on
// Windows, hands the same probe to WSL2 with usbipd, repeats the smoke under Linux, then always
// detaches the probe again. DESTRUCTIVE: each platform run erases and programs the target.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
    loadConfig,
    parseArgs,
    profileNames,
    resolveProfile,
    splitList,
    toWslPath
} = require("../test/hil/smoke-profile");

const root = path.resolve(__dirname, "..");
const results = path.join(root, "test-results");
const wslEnv = { ...process.env, WSL_UTF8: "1" };
const attached = new Set();

function run(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
        child.once("error", (error) => {
            console.error(`${command}: ${error.message}`);
            resolve(1);
        });
        child.once("close", (code) => resolve(code ?? 1));
    });
}

function capture(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", env: wslEnv, windowsHide: true });
    const stdout = result.stdout || "";
    return { code: result.error ? 1 : result.status, stdout, output: `${stdout}${result.stderr || ""}` };
}

function wsl(options, args) {
    return run("wsl.exe", ["-d", options.distro, "--exec", ...args], { env: wslEnv });
}

function usbSelector(profile) {
    if (profile.usb.busid) return ["--busid", profile.usb.busid];
    if (profile.usb.hardwareId) return ["--hardware-id", profile.usb.hardwareId];
    throw new Error(`${profile.name}: usb.hardwareId (or usb.busid) is required for the WSL run`);
}

function detach(profile) {
    const result = capture("usbipd", ["detach", ...usbSelector(profile)]);
    attached.delete(profile);
    if (result.code !== 0) console.error(`usbipd detach failed for ${profile.name}: ${result.output.trim()}`);
}

async function attach(options, profile) {
    const result = capture("usbipd", ["attach", "--wsl", ...usbSelector(profile)]);
    if (result.code !== 0) throw new Error(`usbipd attach failed: ${result.output.trim()}`);
    attached.add(profile);
    if (!profile.usb.hardwareId) return new Promise((resolve) => setTimeout(resolve, 3000));
    for (let attempt = 0; attempt < 20; attempt++) {
        const listed = capture("wsl.exe", ["-d", options.distro, "--exec", "lsusb", "-d", profile.usb.hardwareId]);
        if (listed.code === 0 && listed.stdout.trim()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${profile.usb.hardwareId} did not appear in WSL after attach`);
}

function readReport(platform, profile) {
    try {
        return JSON.parse(fs.readFileSync(path.join(results, `hil-smoke-${platform}-${profile}.json`), "utf8"));
    } catch {
        return null;
    }
}

function pause(message) {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(
        /** @param {(value?: void) => void} resolve */ (resolve) =>
            prompt.question(`${message} Press Enter to continue...`, () => {
                prompt.close();
                resolve();
            })
    );
}

function defaultDistro() {
    const listed = capture("wsl.exe", ["-l", "-q"]);
    return (
        listed.stdout
            .split(/\r?\n/u)
            .map((line) => line.replace(/\0/gu, "").trim())
            .find(Boolean) || ""
    );
}

async function doctor(options, config, names, platforms) {
    let failed = false;
    if (platforms.includes("win32"))
        failed =
            (await run(process.execPath, [
                path.join(root, "test/hil/run-smoke.js"),
                "--doctor",
                "--config",
                options.config,
                "--profile",
                names.join(",")
            ])) !== 0;
    if (!platforms.includes("linux")) return failed;
    const usbipd = capture("usbipd", ["list"]);
    if (usbipd.code !== 0) {
        console.log("MISS usbipd-win (install as administrator: winget install --exact dorssel.usbipd-win)");
        return true;
    }
    for (const name of names) {
        const profile = resolveProfile(config, name, "linux");
        const id = profile.usb.busid || profile.usb.hardwareId;
        const line = usbipd.output.split(/\r?\n/u).find((row) => id && row.toLowerCase().includes(id.toLowerCase()));
        if (!line) {
            console.log(`MISS ${name}: probe ${id || "(no usb selector)"} is not connected`);
            failed = true;
        } else if (/not shared/iu.test(line)) {
            console.log(`MISS ${name}: run once as administrator: usbipd bind ${usbSelector(profile).join(" ")}`);
            failed = true;
        } else console.log(`ok   ${name}: ${line.trim()}`);
    }
    const script = toWslPath(path.join(root, "scripts/hil-wsl.sh"));
    const code = await wsl(options, [
        "bash",
        script,
        "doctor",
        toWslPath(root),
        toWslPath(options.config),
        names.join(",")
    ]);
    return failed || code !== 0;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (process.platform !== "win32") throw new Error("hil-matrix runs on Windows; use test/hil/run-smoke.js on Linux");
    options.config = path.resolve(options.config || path.join(root, "test/hil/smoke.local.json"));
    const config = loadConfig(options.config);
    const names = profileNames(config, options.profiles);
    const platforms = splitList(options.platforms || "win32,linux");
    for (const platform of platforms)
        if (!["win32", "linux"].includes(platform)) throw new Error(`Unknown platform: ${platform}`);
    if (platforms.includes("linux")) {
        options.distro = options.distro || process.env.EMBERPROBE_WSL_DISTRO || defaultDistro();
        if (!options.distro) throw new Error("No WSL distribution found; pass --distro");
    }
    if (options.doctor) {
        if (await doctor(options, config, names, platforms)) process.exitCode = 1;
        return;
    }
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES to permit erasing and programming the configured boards");
    // Resolve every profile up front so a bad entry fails before any board is touched.
    const profiles = names.map((name) =>
        Object.fromEntries(platforms.map((p) => [p, resolveProfile(config, name, p)]))
    );
    if (platforms.includes("linux")) for (const entry of profiles) usbSelector(entry.linux);
    const wslScript = toWslPath(path.join(root, "scripts/hil-wsl.sh"));
    let wslWork = "";
    if (platforms.includes("linux")) {
        const home = capture("wsl.exe", ["-d", options.distro, "--exec", "printenv", "HOME"]).stdout.trim();
        wslWork = (options["wsl-dir"] || "$HOME/emberprobe-hil").replace(/^\$HOME/u, home);
    }
    if (!options["skip-bundle"] && platforms.includes("win32"))
        if ((await run("npm", ["run", "bundle"], { cwd: root, shell: true })) !== 0)
            throw new Error("Windows bundle failed");
    // The WSL mirror is always refreshed: a stale copy would test different code than Windows.
    if (platforms.includes("linux"))
        if ((await wsl(options, ["bash", wslScript, "prepare", toWslPath(root), wslWork])) !== 0)
            throw new Error("WSL prepare failed");
    const matrix = [];
    for (const entry of profiles) {
        const name = entry[platforms[0]].name;
        if (options.pause) await pause(`\nConnect the hardware for ${name}.`);
        for (const platform of platforms) {
            console.log(`\n=== ${platform} ${name}`);
            const started = Date.now();
            // A run that fails before writing its report must not inherit the previous result.
            fs.rmSync(path.join(results, `hil-smoke-${platform}-${name}.json`), { force: true });
            let code;
            let error;
            try {
                if (platform === "win32")
                    code = await run(
                        process.execPath,
                        [
                            path.join(root, "test/hil/run-smoke.js"),
                            "--config",
                            options.config,
                            "--profile",
                            name,
                            "--repeat",
                            String(options.repeat || 1)
                        ],
                        { cwd: root }
                    );
                else {
                    await attach(options, entry.linux);
                    try {
                        code = await wsl(options, [
                            "bash",
                            wslScript,
                            "run",
                            toWslPath(root),
                            wslWork,
                            toWslPath(options.config),
                            name,
                            String(options.repeat || 1)
                        ]);
                    } finally {
                        detach(entry.linux);
                    }
                }
            } catch (failure) {
                code = 1;
                error = failure.message;
                console.error(error);
            }
            const report = readReport(platform, name);
            matrix.push({
                profile: name,
                platform,
                passed: code === 0 && report?.passed === true,
                ms: Date.now() - started,
                failedStep: report?.steps?.find((step) => !step.ok)?.name,
                ...(error ? { error } : {})
            });
        }
    }
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(
        path.join(results, "hil-matrix.json"),
        JSON.stringify({ finishedAt: new Date().toISOString(), matrix }, null, 2)
    );
    console.log("\nprofile              platform  result");
    for (const row of matrix)
        console.log(
            `${row.profile.padEnd(20)} ${row.platform.padEnd(9)} ${row.passed ? "PASS" : `FAIL ${row.failedStep || row.error || ""}`}`
        );
    if (matrix.some((row) => !row.passed)) process.exitCode = 1;
}

// Never leave a probe attached to WSL: Windows would lose it until a manual detach.
process.once("SIGINT", () => {
    for (const profile of attached) detach(profile);
    process.exit(130);
});

main().catch((error) => {
    for (const profile of attached) detach(profile);
    console.error(error.message);
    process.exitCode = 1;
});
