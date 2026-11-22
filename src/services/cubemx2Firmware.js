"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const YAML = require("yaml");
const { XMLParser } = require("fast-xml-parser");
const { parseIoc2, summarize, MAX_IOC2_BYTES } = require("./cubemx2Project");
const { installation } = require("./cubemx2Environment");
const { supportedPlatform } = require("./cubemxEnvironment");

const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
const IDENTIFIER = /^[a-z0-9_-]{1,128}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i;
const FAMILIES = "H7RS WB0 WBA WL3 MP1 MP2 F0 F1 F2 F3 F4 F7 G0 G4 G5 H5 H7 L0 L1 L4 L5 U0 U3 U5 C0 C5 N6 WB WL".split(
    " "
);

function extractStm32Family(value) {
    const name = path.basename(String(value || "").replace(/\\/g, "/")).replace(/\.cfg$/i, "");
    if (/^stm32h7[rs]\d/i.test(name)) return "H7RS";
    return (
        FAMILIES.find((family) => new RegExp("^stm32" + family + "(?:[0-9x_].*|[a-z][0-9].*)?$", "i").test(name)) ||
        name.match(/^stm32([a-z]{1,2}\d)/i)?.[1]?.toUpperCase() ||
        undefined
    );
}

function compareVersionDesc(a, b) {
    const [aCore, aRest = ""] = String(a).split(/[-+]/, 2);
    const [bCore, bRest = ""] = String(b).split(/[-+]/, 2);
    const coreCmp = bCore.localeCompare(aCore, "en", { numeric: true });
    if (coreCmp !== 0) return coreCmp;
    const aPre = String(a).includes("-");
    const bPre = String(b).includes("-");
    if (aPre !== bPre) return aPre ? 1 : -1;
    return bRest.localeCompare(aRest, "en", { numeric: true });
}

const sortVersions = (values) => values.sort(compareVersionDesc);

async function readBounded(file, limit) {
    const handle = await fs.open(file, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error("Firmware metadata exceeds its size limit");
        const bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > stat.size) throw new Error("Firmware metadata changed while reading");
        return bytes
            .subarray(0, bytesRead)
            .toString("utf8")
            .replace(/^\uFEFF/, "");
    } finally {
        await handle.close();
    }
}

async function packRepository(options = {}) {
    const env = options.env || process.env;
    const platform = options.platform || process.platform;
    const home = options.home || os.homedir();
    if (env.CMSIS_PACK_ROOT) {
        if (!path.isAbsolute(env.CMSIS_PACK_ROOT)) throw new Error("CMSIS_PACK_ROOT must be absolute");
        return env.CMSIS_PACK_ROOT;
    }
    const configRoot =
        platform === "win32"
            ? env.APPDATA || path.join(home, "AppData", "Roaming")
            : env.XDG_CONFIG_HOME || path.join(home, ".config");
    let config = {};
    try {
        config = JSON.parse(
            await readBounded(path.join(configRoot, "stm32cube", "CubeUserConfig.json"), 2 * 1024 * 1024)
        );
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const packRoot = config && typeof config === "object" ? /** @type {any} */ (config).cmsis_pack_root : null;
    if (packRoot) {
        if (typeof packRoot !== "string" || !path.isAbsolute(packRoot))
            throw new Error("CubeUserConfig cmsis_pack_root must be an absolute path");
        return packRoot;
    }
    const dataRoot =
        platform === "win32"
            ? env.LOCALAPPDATA || path.join(home, "AppData", "Local")
            : env.XDG_DATA_HOME || path.join(home, ".local", "share");
    return path.join(dataRoot, "stm32cube", "packs");
}

function projectRequirements(project) {
    const result = new Map();
    for (const [file, text] of project.files) {
        if (!/\.(?:csolution|cproject|clayer)\.ya?ml$/i.test(file)) continue;
        const doc = YAML.parseDocument(text, { uniqueKeys: true });
        if (doc.errors.length) throw new Error("Invalid CubeMX2 pack declarations");
        const data = doc.toJS({ maxAliasCount: 0 });
        const packs = data?.solution?.packs || data?.project?.packs || data?.layer?.packs || [];
        if (!Array.isArray(packs) || packs.length > 256) throw new Error("Invalid CubeMX2 pack list");
        for (const entry of packs) {
            const match = typeof entry?.pack === "string" && /^([\w-]+)::([\w-]+)(?:@(.{1,128}))?$/.exec(entry.pack);
            if (!match || !IDENTIFIER.test(match[1]) || !IDENTIFIER.test(match[2]))
                throw new Error("Cannot verify this CubeMX2 pack identifier");
            const requiredVersion = match[3] || "";
            const item = {
                vendor: match[1],
                name: match[2],
                requiredVersion,
                conditional: !!(entry.path || entry["for-context"] || entry["not-for-context"])
            };
            result.set(JSON.stringify(item), item);
            if (result.size > 256) throw new Error("CubeMX2 project has too many pack requirements");
        }
    }
    if (!result.size) throw new Error("CubeMX2 project has no verifiable pack declarations");
    return [...result.values()];
}

function versionMatches(version, required) {
    if (!required) return true;
    if (VERSION.test(required)) return version === required;
    const match = /^(>=|\^|~)(\d+)\.(\d+)\.(\d+)$/.exec(required);
    if (!match || !/^\d+\.\d+\.\d+$/.test(version)) return null;
    const actual = version.split(".").map(Number);
    const expected = match.slice(2).map(Number);
    const compare = actual[0] - expected[0] || actual[1] - expected[1] || actual[2] - expected[2];
    if (compare < 0) return false;
    if (match[1] === ">=") return true;
    if (match[1] === "~") return actual[0] === expected[0] && actual[1] === expected[1];
    if (expected[0] > 0) return actual[0] === expected[0];
    if (expected[1] > 0) return actual[0] === 0 && actual[1] === expected[1];
    return actual[0] === 0 && actual[1] === 0 && actual[2] === expected[2];
}

async function directories(root) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    if (entries.length > 4096) throw new Error("Pack repository directory exceeds the inspection limit");
    return entries.filter((entry) => entry.isDirectory());
}

async function installedVersions(repository, vendor, name) {
    const vendors = await directories(repository);
    const vendorDir = vendors.find((entry) => entry.name.toLowerCase() === vendor.toLowerCase());
    if (!vendorDir) return [];
    const vendorRoot = path.join(repository, vendorDir.name);
    const packs = await directories(vendorRoot);
    const packDir = packs.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!packDir) return [];
    const root = path.join(vendorRoot, packDir.name);
    const versions = [];
    for (const entry of await directories(root)) {
        if (!VERSION.test(entry.name)) continue;
        try {
            const content = await readBounded(
                path.join(root, entry.name, vendorDir.name + "." + packDir.name + ".pdsc"),
                8 * 1024 * 1024
            );
            const pkg = parser.parse(content).package;
            const latest = Array.isArray(pkg?.releases?.release) ? pkg.releases.release[0] : pkg?.releases?.release;
            if (
                String(pkg?.vendor).toLowerCase() === vendor.toLowerCase() &&
                String(pkg?.name).toLowerCase() === name.toLowerCase() &&
                latest?.["@_version"] === entry.name
            )
                versions.push(entry.name);
        } catch (error) {
            if (error.code === "EACCES" || error.code === "EPERM") throw error;
            // A missing or invalid PDSC does not establish an installed version.
        }
    }
    return sortVersions(versions);
}

async function inspectFirmware(config, options = {}) {
    const platform = options.platform || process.platform;
    if (!supportedPlatform(platform) || !config.cubemx2Path) return null;
    await (options.installation || installation)(config.cubemx2Path, { platform });
    let family = extractStm32Family(config.target);
    let requirements;
    if (config.iocPath) {
        const file = await (options.resolveIoc || (async (value) => value))(config.iocPath);
        const project = parseIoc2(await readBounded(file, MAX_IOC2_BYTES));
        const chip = summarize(project, file).chip;
        const projectFamily = extractStm32Family(chip);
        if (family && projectFamily && family !== projectFamily)
            throw new Error("Target and .ioc2 family do not match");
        family = projectFamily || family;
        requirements = projectRequirements(project);
    } else if (family) {
        requirements = ["dfp", "hal_drivers"].map((part) => ({
            vendor: "STMicroelectronics",
            name: "stm32" + family.toLowerCase() + "xx_" + part,
            requiredVersion: ""
        }));
    } else return null;
    const repository = await packRepository(options);
    const packs = [];
    for (const item of requirements) {
        const versions = await installedVersions(repository, item.vendor, item.name);
        const related = requirements.filter(
            (other) =>
                other.vendor.toLowerCase() === item.vendor.toLowerCase() &&
                other.name.toLowerCase() === item.name.toLowerCase() &&
                !other.conditional
        );
        const supported =
            !item.conditional &&
            versionMatches("0.0.0", item.requiredVersion) !== null &&
            related.every((other) => versionMatches("0.0.0", other.requiredVersion) !== null);
        const installed =
            supported &&
            versions.some((version) =>
                related.every((other) => versionMatches(version, other.requiredVersion) === true)
            );
        packs.push({
            ...item,
            versions,
            installed,
            state: !supported ? "unknown" : installed ? "installed" : versions.length ? "version-mismatch" : "missing"
        });
    }
    const unknown = packs.some((pack) => pack.state === "unknown");
    return {
        generator: "cubemx2",
        family: family || "packs",
        repository,
        packs,
        installed: packs.every((pack) => pack.installed),
        state: unknown
            ? "unknown"
            : packs.every((pack) => pack.installed)
              ? "installed"
              : packs.some((pack) => pack.state === "version-mismatch")
                ? "version-mismatch"
                : "missing"
    };
}

module.exports = { inspectFirmware, packRepository, projectRequirements, versionMatches, installedVersions };
