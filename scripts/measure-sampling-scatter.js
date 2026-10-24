"use strict";

// Opt-in, read-only comparison. No reset, halt, programming, writes or driver operations.
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { spawnSync } = require("child_process");
const { parseElfSections, parseElfSymbols } = require("../src/elfSymbols");
const { writableRamSectionRanges } = require("../src/services/liveWatchService");
const { resolveOpenOcdLaunch } = require("../src/openocdScripts");
const { normalizeAdapterSpeed, normalizeProbeSerial, probeFamily } = require("../skills/_emberprobe/probe-connection");

function optionsFromArgs(argv) {
    const options = {};
    const allowed = new Set([
        "openocd",
        "probe",
        "target",
        "serial",
        "speed",
        "transport",
        "elf",
        "addresses",
        "variables",
        "seconds",
        "output",
        "layout",
        "block-bytes",
        "rate-hz",
        "src"
    ]);
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        if (
            !key?.startsWith("--") ||
            !allowed.has(key.slice(2)) ||
            !argv[index + 1] ||
            argv[index + 1].startsWith("--")
        )
            throw new Error(`Expected a supported --name value at argument ${index + 1}`);
        if (Object.hasOwn(options, key.slice(2))) throw new Error(`Duplicate ${key}`);
        options[key.slice(2)] = argv[index + 1];
    }
    for (const key of ["openocd", "probe", "target", "output"]) if (!options[key]) throw new Error(`Missing --${key}`);
    if (!!options.elf === !!options.addresses) throw new Error("Specify exactly one of --elf or --addresses");
    const variables = Number(options.variables || 16);
    const seconds = Number(options.seconds || 10);
    if (!Number.isInteger(variables) || variables < 1 || variables > 4096)
        throw new Error("--variables must be an integer from 1 to 4096");
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error("--seconds must be from 1 to 3600");
    const transport = options.transport || "auto";
    if (!["auto", "swd", "jtag"].includes(transport)) throw new Error("--transport must be auto, swd or jtag");
    const layout = options.layout || "scattered";
    if (!["scattered", "clustered", "block", "mixed"].includes(layout))
        throw new Error("--layout must be scattered, clustered, block or mixed");
    if (options.addresses && layout !== "scattered") throw new Error("--addresses only supports --layout scattered");
    const blockBytes = Number(options["block-bytes"] || 1024);
    if (!Number.isInteger(blockBytes) || blockBytes < 4 || blockBytes > 4096 || blockBytes % 4)
        throw new Error("--block-bytes must be a multiple of 4 from 4 to 4096");
    // 0 keeps unlimited mode; a rate measures the adaptive scheduler against a fixed target.
    const rateHz = Number(options["rate-hz"] || 0);
    if (!Number.isInteger(rateHz) || rateHz < 0 || rateHz > 200)
        throw new Error("--rate-hz must be an integer from 0 to 200");
    return {
        openocd: options.openocd,
        probe: options.probe,
        target: options.target,
        elf: options.elf,
        addresses: options.addresses,
        variables,
        seconds,
        transport,
        layout,
        blockBytes,
        rateHz,
        // Another EmberProbe checkout whose sampling session is measured, e.g. a baseline commit.
        src: path.resolve(options.src || path.join(__dirname, "..")),
        speed: normalizeAdapterSpeed(options.speed || 0),
        serial: normalizeProbeSerial(options.serial, probeFamily({ probe: options.probe })),
        output: path.resolve(options.output)
    };
}

function conventionalRam(address, size) {
    return (
        (address >= 0x20000000 && address + size <= 0x40000000) ||
        (address >= 0x10000000 && address + size <= 0x10080000)
    );
}

function selectItems(options) {
    if (options.addresses) {
        const addresses = options.addresses.split(",");
        if (addresses.length > 4096) throw new Error("At most 4096 explicit addresses are allowed");
        const items = addresses.map((text, index) => {
            if (!/^0x[0-9a-f]{1,8}$/i.test(text)) throw new Error(`Invalid hex address: ${text}`);
            const address = Number(text);
            if (address % 4 || !conventionalRam(address, 4))
                throw new Error("Explicit addresses must be aligned words in conventional SRAM/CCM RAM");
            return { name: `address${index}`, address, size: 4 };
        });
        if (new Set(items.map((item) => item.address)).size !== items.length) throw new Error("Duplicate addresses");
        return { items, ramSectionRanges: [] };
    }
    const filename = path.resolve(options.elf);
    if (fs.statSync(filename).size > 128 * 1024 * 1024) throw new Error("ELF exceeds the 128 MiB input limit");
    const buffer = fs.readFileSync(filename);
    const ramSectionRanges = writableRamSectionRanges(parseElfSections(buffer).sections);
    const candidates = parseElfSymbols(buffer)
        .symbols.filter(
            (entry) =>
                entry.size > 0 &&
                conventionalRam(entry.address, entry.size) &&
                ramSectionRanges.some(
                    (range) => entry.address >= range.start && entry.address + entry.size <= range.end
                )
        )
        .sort((a, b) => a.address - b.address);
    const scalar = (entry) => ({ name: entry.name, address: entry.address, size: Math.min(entry.size, 4) });
    const block = () => {
        const host = candidates
            .filter((entry) => entry.size >= options.blockBytes + 4)
            .sort((a, b) => b.size - a.size)[0];
        if (!host) throw new Error(`ELF has no RAM global of at least ${options.blockBytes + 4} bytes`);
        return { name: `${host.name}[block]`, address: Math.ceil(host.address / 4) * 4, size: options.blockBytes };
    };
    const scatteredFrom = (pool) => {
        const scattered = [];
        for (const entry of pool) {
            const previous = scattered[scattered.length - 1];
            if (!previous || entry.address - (previous.address + previous.size) > 32) scattered.push(scalar(entry));
        }
        if (scattered.length < options.variables)
            throw new Error(`ELF has only ${scattered.length} RAM globals separated by more than 32 bytes`);
        return Array.from(
            { length: options.variables },
            (_, index) => scattered[Math.floor((index * scattered.length) / options.variables)]
        );
    };
    if (options.layout === "block") return { items: [block()], ramSectionRanges };
    if (options.layout === "mixed") {
        const big = block();
        const pool = candidates.filter(
            (entry) => entry.address + entry.size + 32 < big.address || entry.address > big.address + big.size + 32
        );
        return { items: [big, ...scatteredFrom(pool)], ramSectionRanges };
    }
    if (options.layout === "clustered") {
        // Like watching several members of one struct: 4-byte fields 16 bytes apart in one large object.
        const host = candidates
            .filter((entry) => entry.size >= options.variables * 16 + 4)
            .sort((a, b) => b.size - a.size)[0];
        if (!host) throw new Error(`ELF has no RAM global of at least ${options.variables * 16 + 4} bytes`);
        const base = Math.ceil(host.address / 4) * 4;
        const items = Array.from({ length: options.variables }, (_, index) => ({
            name: `${host.name}[+${index * 16}]`,
            address: base + index * 16,
            size: 4
        }));
        return { items, ramSectionRanges };
    }
    return { items: scatteredFrom(candidates), ramSectionRanges };
}

function percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

async function main(argv = process.argv.slice(2)) {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Read-only hardware sampling requires EMBERPROBE_HIL_CONFIRM=YES");
    const options = optionsFromArgs(argv);
    const { ManagedOpenOcdSession, findFreePort } = require(path.join(options.src, "src", "liveWatch"));
    const { items, ramSectionRanges } = selectItems(options);
    const launch = resolveOpenOcdLaunch(options.openocd, options.probe, options.target, options.transport);
    const version = spawnSync(launch.executable, ["--version"], {
        encoding: "utf8",
        // The first launch of a new binary can wait on an antivirus scan.
        timeout: 30000,
        windowsHide: true
    });
    if (version.error || version.status !== 0)
        throw new Error(`Cannot read OpenOCD version: ${version.error || version.stderr}`);
    const port = await findFreePort();
    if (!port) throw new Error("Cannot allocate a loopback Tcl port");
    let failure = null;
    let endMeasurement = () => {};
    const session = new ManagedOpenOcdSession(
        null,
        {
            executable: options.openocd,
            probe: options.probe,
            target: options.target,
            transport: options.transport,
            probeSerial: options.serial,
            adapterSpeedKhz: options.speed,
            port,
            mode: "standalone"
        },
        {
            onError: (message) => {
                failure = new Error(String(message));
                endMeasurement();
            },
            onDisconnect: (error) => {
                failure = error;
                endMeasurement();
            }
        }
    );
    session.setSamplingPlan({
        graphItems: items,
        sidebarItems: [],
        ramSectionRanges,
        graphIntervalMs: options.rateHz ? Math.round(1000 / options.rateHz) : 5,
        unlimited: !options.rateHz
    });
    const durations = [];
    const rpcCounts = [];
    let rpcs = 0;
    let cycleRpcs = 0;
    let validCycle = false;
    const send = session._sendCommand.bind(session);
    session._sendCommand = (command) => {
        rpcs++;
        return send(command);
    };
    const read = session._readItems.bind(session);
    session._readItems = async (...args) => {
        const before = rpcs;
        validCycle = false;
        try {
            const result = await read(...args);
            validCycle = result.ok === items.length && result.samples.every((sample) => sample.bytes);
            if (!validCycle) {
                failure = new Error("Incomplete sample cycle");
                endMeasurement();
            }
            return result;
        } finally {
            cycleRpcs = rpcs - before;
        }
    };
    const record = session._recordCycle.bind(session);
    session._recordCycle = (duration, success, timestamp) => {
        if (success && validCycle) {
            durations.push(duration);
            rpcCounts.push(cycleRpcs);
        }
        record(duration, success, timestamp);
    };
    try {
        await session.start();
        if (failure) throw failure;
        const startedAt = new Date().toISOString();
        const started = performance.now();
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, options.seconds * 1000);
            endMeasurement = () => {
                clearTimeout(timer);
                resolve(undefined);
            };
        });
        const elapsedMs = performance.now() - started;
        session.setSamplingEnabled(false);
        await session._acquireExclusive(Date.now() + (session.rpcTimeoutMs || 2000) + 1000);
        const stats = session.stats();
        session._releaseExclusive();
        if (failure) throw failure;
        if (!durations.length) throw new Error("No complete sampling cycles recorded");
        const report = {
            startedAt,
            openocdVersion: `${version.stdout || ""}${version.stderr || ""}`.trim(),
            executable: launch.executable,
            probe: options.probe,
            target: options.target,
            serial: options.serial,
            transport: options.transport,
            layout: options.layout,
            rateHz: options.rateHz,
            src: options.src,
            speedKhz: options.speed,
            items,
            elapsedMs,
            cycles: durations.length,
            achievedHz: (durations.length * 1000) / elapsedMs,
            p50CycleMs: percentile(durations, 0.5),
            p95CycleMs: percentile(durations, 0.95),
            tclRpcsPerCycle: rpcCounts.reduce((a, b) => a + b, 0) / rpcCounts.length,
            scatterReads: stats.scatterReads ?? null,
            noEchoResponses: stats.noEchoResponses ?? null
        };
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
        fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n");
        console.log(`Recorded ${report.cycles} cycles to ${options.output}`);
    } finally {
        await session.stop();
    }
}

if (require.main === module)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
module.exports = { optionsFromArgs, selectItems, percentile, main };
