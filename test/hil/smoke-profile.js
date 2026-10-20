"use strict";

// Pure helpers shared by the HIL smoke runner, the Windows/WSL matrix and their unit test.
// A profile is one board + probe pair; platform-specific paths are { win32, linux } objects.
const fs = require("fs");
const path = require("path");

const PLATFORMS = Object.freeze(["win32", "linux"]);
const CFG_NAME = /^[\w.-]+\.cfg$/u;
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const HARDWARE_ID = /^[0-9a-f]{4}:[0-9a-f]{4}$/iu;
const BUS_ID = /^\d+-[\d.]+$/u;
const FUNCTION_NAME = /^[A-Za-z_][\w:]*$/u;
// Data files can be read from WSL through the automount; executables must be Linux builds.
const DATA_FILES = new Set(["elf", "svd"]);

function invalid(message) {
    return Object.assign(new Error(message), { code: "HIL_SMOKE_CONFIG_INVALID" });
}

function isPlatformMap(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function platformValue(value, platform) {
    return isPlatformMap(value) ? value[platform] : value;
}

// Default WSL automount: C:\Users\x -> /mnt/c/Users/x. Non-drive paths are returned unchanged.
function toWslPath(file) {
    const match = /^([A-Za-z]):[\\/]?(.*)$/u.exec(String(file));
    if (!match) return String(file);
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/gu, "/")}`.replace(/\/$/u, "");
}

function platformPath(value, platform, key, profile) {
    let resolved = platformValue(value, platform);
    // A single Windows data-file path is readable from WSL through the automount; tools never are.
    const data = platform === "linux" && DATA_FILES.has(key);
    if (resolved === undefined && data && isPlatformMap(value) && value.win32) resolved = toWslPath(value.win32);
    else if (data && typeof resolved === "string") resolved = toWslPath(resolved);
    if (resolved === undefined || resolved === "") return "";
    if (typeof resolved !== "string") throw invalid(`${profile}: ${key} must be a path string`);
    if (!(platform === "win32" ? path.win32 : path.posix).isAbsolute(resolved))
        throw invalid(`${profile}: ${key} must be an absolute ${platform} path`);
    return resolved;
}

function variableName(value, profile) {
    const name = String(value || "").trim();
    if (!name || name.length > 256) throw invalid(`${profile}: invalid variable name`);
    return name;
}

function text(value, profile, label, max = 256) {
    const result = String(value ?? "").trim();
    if (!result || result.length > max) throw invalid(`${profile}: ${label} must be a non-empty string`);
    return result;
}

// Optional deeper checks; each one is skipped when its configuration is absent.
function resolveChecks(raw = {}, profile) {
    const checks = {};
    if (raw.sampling) {
        const count = Number(raw.sampling.count ?? 20);
        const intervalMs = Number(raw.sampling.intervalMs ?? 50);
        if (!Number.isInteger(count) || count < 2 || count > 1000)
            throw invalid(`${profile}: checks.sampling.count must be 2-1000`);
        if (!Number.isInteger(intervalMs) || intervalMs < 5 || intervalMs > 10000)
            throw invalid(`${profile}: checks.sampling.intervalMs must be 5-10000`);
        checks.sampling = {
            variable: variableName(raw.sampling.variable, profile),
            increasing: raw.sampling.increasing === true,
            count,
            intervalMs
        };
    }
    if (raw.breakpoint !== undefined) {
        const name = text(raw.breakpoint, profile, "checks.breakpoint");
        if (!FUNCTION_NAME.test(name)) throw invalid(`${profile}: checks.breakpoint must be a function name`);
        checks.breakpoint = name;
    }
    if (raw.rtosTasks !== undefined) {
        if (!Array.isArray(raw.rtosTasks) || !raw.rtosTasks.length)
            throw invalid(`${profile}: checks.rtosTasks must list task names`);
        checks.rtosTasks = raw.rtosTasks.map((item) => text(item, profile, "checks.rtosTasks entry", 64));
    }
    if (raw.peripherals) {
        const peripherals = raw.peripherals;
        const read = (Array.isArray(peripherals.read) ? peripherals.read : []).map((item) =>
            text(item, profile, "checks.peripherals.read entry")
        );
        if (!read.length) throw invalid(`${profile}: checks.peripherals.read needs at least one register`);
        const write = peripherals.write
            ? {
                  target: text(peripherals.write.target, profile, "checks.peripherals.write.target"),
                  value: text(peripherals.write.value, profile, "checks.peripherals.write.value")
              }
            : null;
        const reject = (Array.isArray(peripherals.reject) ? peripherals.reject : []).map((item) => ({
            target: text(item?.target, profile, "checks.peripherals.reject target"),
            value: text(item?.value, profile, "checks.peripherals.reject value"),
            code: text(item?.code, profile, "checks.peripherals.reject code")
        }));
        checks.peripherals = { read, write, reject };
    }
    if (raw.negative)
        checks.negative = {
            readOnly: raw.negative.readOnly ? variableName(raw.negative.readOnly, profile) : null,
            outOfBounds: raw.negative.outOfBounds ? variableName(raw.negative.outOfBounds, profile) : null
        };
    return checks;
}

/** @param {string} [platform] */
function resolveProfile(config, name, platform = process.platform) {
    if (!PLATFORMS.includes(platform)) throw invalid(`Unsupported HIL smoke platform: ${platform}`);
    const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
    const raw = profiles.find((item) => item?.name === name);
    if (!raw) throw invalid(`Unknown HIL smoke profile: ${name}`);
    const merged = { ...(config.defaults || {}), ...raw };
    if (!PROFILE_NAME.test(merged.name)) throw invalid(`Profile names use lowercase letters, digits and -: ${name}`);
    for (const key of ["probe", "target"])
        if (!CFG_NAME.test(String(merged[key] || ""))) throw invalid(`${name}: ${key} must be a plain .cfg name`);
    const transport = String(merged.transport || "auto");
    if (!["auto", "swd", "jtag"].includes(transport)) throw invalid(`${name}: transport must be auto, swd or jtag`);
    const adapterSpeedKhz = Number(merged.adapterSpeedKhz ?? 0);
    if (!Number.isInteger(adapterSpeedKhz) || adapterSpeedKhz < 0 || adapterSpeedKhz > 100000)
        throw invalid(`${name}: adapterSpeedKhz must be a non-negative integer`);
    const elf = platformPath(merged.elf, platform, "elf", name);
    if (!elf) throw invalid(`${name}: elf is required`);
    const openocd = platformPath(merged.openocd, platform, "openocd", name);
    if (!openocd) throw invalid(`${name}: openocd is required for ${platform}`);
    const toolchain = platformPath(merged.toolchain, platform, "toolchain", name);
    if (!toolchain) throw invalid(`${name}: toolchain (ARM GNU bin directory) is required for ${platform}`);
    const variables = merged.variables || {};
    const read = (Array.isArray(variables.read) ? variables.read : []).map((item) => variableName(item, name));
    if (!read.length) throw invalid(`${name}: variables.read needs at least one variable`);
    let write = null;
    if (variables.write) {
        write = { name: variableName(variables.write.name, name), value: String(variables.write.value ?? "") };
        if (!write.value) throw invalid(`${name}: variables.write.value is required`);
    }
    const svd = platformPath(merged.svd, platform, "svd", name);
    const checks = resolveChecks(merged.checks, name);
    if (checks.peripherals && !svd) throw invalid(`${name}: checks.peripherals needs an svd file`);
    const usb = merged.usb || {};
    if (usb.hardwareId !== undefined && !HARDWARE_ID.test(String(usb.hardwareId)))
        throw invalid(`${name}: usb.hardwareId must look like 1366:0101`);
    if (usb.busid !== undefined && !BUS_ID.test(String(usb.busid)))
        throw invalid(`${name}: usb.busid must look like 2-4`);
    return {
        name: merged.name,
        platform,
        probe: merged.probe,
        target: merged.target,
        transport,
        probeSerial: String(merged.probeSerial || ""),
        adapterSpeedKhz,
        rtos: String(merged.rtos || ""),
        openocd,
        toolchain,
        elf,
        svd,
        variables: { read, write },
        checks,
        debug: merged.debug !== false,
        usb: {
            ...(usb.hardwareId ? { hardwareId: String(usb.hardwareId).toLowerCase() } : {}),
            ...(usb.busid ? { busid: String(usb.busid) } : {})
        }
    };
}

function profileNames(config, requested = []) {
    const all = (Array.isArray(config?.profiles) ? config.profiles : []).map((item) => item?.name);
    if (!all.length) throw invalid("The HIL smoke configuration has no profiles");
    const names = requested.length ? requested : all;
    for (const name of names) if (!all.includes(name)) throw invalid(`Unknown HIL smoke profile: ${name}`);
    return [...new Set(names)];
}

function loadConfig(file) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        throw invalid(`Cannot read HIL smoke configuration ${file}: ${error.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw invalid(`HIL smoke configuration is not valid JSON: ${error.message}`);
    }
}

function parseArgs(argv) {
    const options = { profiles: [] };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg);
        if (!match) throw invalid(`Unexpected argument: ${arg}`);
        const [, key, inline] = match;
        if (["pause", "doctor", "skip-bundle"].includes(key)) {
            options[key] = true;
            continue;
        }
        const value = inline ?? argv[++index];
        if (value === undefined || value.startsWith("--")) throw invalid(`--${key} needs a value`);
        if (key === "profile") options.profiles.push(...splitList(value));
        else if (key === "repeat") {
            options.repeat = Number(value);
            if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 50)
                throw invalid("--repeat must be an integer from 1 to 50");
        } else if (["config", "platforms", "distro", "wsl-dir"].includes(key)) options[key] = value;
        else throw invalid(`Unknown option: --${key}`);
    }
    return options;
}

function splitList(value) {
    return String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

// Firmware floats read back through float32 storage, so compare numerically with a relative tolerance.
function sameValue(actual, expected) {
    const a = Number(actual),
        b = Number(expected);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    return String(actual) === String(expected);
}

module.exports = {
    PLATFORMS,
    loadConfig,
    parseArgs,
    platformValue,
    profileNames,
    resolveProfile,
    sameValue,
    splitList,
    toWslPath
};
