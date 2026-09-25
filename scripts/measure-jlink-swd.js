"use strict";

// Read-only H750 SWD comparison. Driver changes and board power cycles are deliberately manual.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { resolveOpenOcdLaunch, buildOpenOcdConfigArgs } = require("../skills/_emberprobe/openocd-launch");
const { normalizeProbeSerial, normalizeAdapterSpeed } = require("../skills/_emberprobe/probe-connection");

function optionsFromArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        if (!key?.startsWith("--") || i + 1 >= argv.length || argv[i + 1].startsWith("--"))
            throw new Error(`Expected --name value at argument ${i + 1}`);
        options[key.slice(2)] = argv[i + 1];
    }
    for (const name of ["openocd", "instance", "serial", "phase", "output"]) {
        if (!options[name]) throw new Error(`Missing --${name}`);
    }
    if (!/^(baseline|after-switch|probe-replug|board-power-cycle)$/.test(options.phase))
        throw new Error("Invalid phase");
    const runs = Number(options.runs || 10);
    if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error("--runs must be an integer from 1 to 50");
    const speed = normalizeAdapterSpeed(options.speed || 1800);
    if (!speed) throw new Error("--speed must be greater than zero");
    return {
        openocd: options.openocd,
        instance: options.instance,
        serial: normalizeProbeSerial(options.serial),
        phase: options.phase,
        output: path.resolve(options.output),
        runs,
        speed
    };
}

function readBinding(helper, instanceId) {
    const result = spawnSync(helper, ["list"], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0)
        throw new Error(`Driver inventory failed: ${result.error || result.stderr}`);
    const matches = JSON.parse(result.stdout).filter((device) => device.instanceId?.toUpperCase() === instanceId);
    if (matches.length !== 1) throw new Error(`Selected device instance is not unique: ${instanceId}`);
    if (matches[0].service?.toLowerCase() !== "winusb")
        throw new Error(`Expected WinUSB on ${instanceId}; found ${matches[0].service || "unknown"}`);
    return matches[0];
}

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
    const options = optionsFromArgs(process.argv.slice(2));
    const instanceId = options.instance.toUpperCase();
    const instanceSerial = instanceId.split("\\").at(-1);
    if (!/^\d+$/.test(instanceSerial) || Number(instanceSerial) !== Number(options.serial))
        throw new Error("The selected instance ID does not match the selected J-Link serial");

    const helper = path.resolve(__dirname, "../resources/driver-helper/win32-x64/emberprobe-driver-helper.exe");
    const launch = resolveOpenOcdLaunch(options.openocd, "jlink.cfg", "stm32h7x.cfg", "swd");
    const phaseDir = path.join(options.output, options.phase);
    if (fs.existsSync(phaseDir)) throw new Error(`Phase output already exists: ${phaseDir}`);
    const binding = readBinding(helper, instanceId);
    fs.mkdirSync(phaseDir, { recursive: true });
    const args = [
        "-d3",
        ...buildOpenOcdConfigArgs(launch, "swd", { probeSerial: options.serial, adapterSpeedKhz: options.speed }),
        "-c",
        "gdb port disabled",
        "-c",
        "tcl port disabled",
        "-c",
        "telnet port disabled",
        "-c",
        "init",
        "-c",
        "shutdown"
    ];
    const context = {
        phase: options.phase,
        instanceId,
        serial: options.serial,
        speedKhz: options.speed,
        runs: options.runs,
        binding,
        windowsBuild: os.release(),
        arch: os.arch(),
        executable: launch.executable,
        scriptsRoot: launch.scriptsRoot,
        args,
        openocdVersion: (() => {
            const version = spawnSync(launch.executable, ["--version"], { encoding: "utf8", timeout: 10000 });
            return `${version.stdout || ""}${version.stderr || ""}`.trim();
        })(),
        openocdSha256: sha256(launch.executable),
        helperSha256: sha256(helper),
        libwdiSha256: sha256(path.join(path.dirname(helper), "libwdi.dll")),
        startedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(phaseDir, "context.json"), JSON.stringify(context, null, 2));
    const results = [];
    try {
        for (let run = 1; run <= options.runs; run++) {
            const currentBinding = readBinding(helper, instanceId);
            const started = Date.now();
            const result = spawnSync(launch.executable, args, {
                cwd: launch.cwd,
                encoding: "utf8",
                windowsHide: true,
                timeout: 30000,
                maxBuffer: 16 * 1024 * 1024
            });
            const elapsedMs = Date.now() - started;
            const name = `run-${String(run).padStart(2, "0")}`;
            fs.writeFileSync(path.join(phaseDir, `${name}.stdout.log`), result.stdout || "");
            fs.writeFileSync(path.join(phaseDir, `${name}.stderr.log`), result.stderr || "");
            const log = `${result.stdout || ""}\n${result.stderr || ""}`;
            const item = {
                run,
                startedAt: new Date(started).toISOString(),
                elapsedMs,
                exitCode: result.status,
                signal: result.signal,
                error: result.error?.message || "",
                driverInf: currentBinding.driverInf,
                driverProvider: currentBinding.driverProvider,
                vtarget: /VTarget\s*=\s*([\d.]+\s*V)/i.exec(log)?.[1] || "",
                dpError: /Error connecting DP: cannot read IDR/i.test(log),
                swdAckCounts: [...log.matchAll(/SWD ack not OK[^\r\n]*/gi)].reduce((counts, match) => {
                    const key = match[0];
                    counts[key] = (counts[key] || 0) + 1;
                    return counts;
                }, {}),
                success: result.status === 0 && !/Error connecting DP: cannot read IDR/i.test(log)
            };
            results.push(item);
            fs.writeFileSync(path.join(phaseDir, "results.json"), JSON.stringify(results, null, 2));
            process.stdout.write(
                `${options.phase} ${run}/${options.runs}: ${item.success ? "OK" : "FAIL"}, ${elapsedMs} ms, VTarget=${item.vtarget || "unknown"}\n`
            );
        }
    } finally {
        fs.writeFileSync(path.join(phaseDir, "results.json"), JSON.stringify(results, null, 2));
    }
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
