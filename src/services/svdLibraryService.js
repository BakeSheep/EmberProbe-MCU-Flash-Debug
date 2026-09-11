"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { normalizePart } = require("./deviceIdentityService");

const BINDINGS_KEY = "emberprobe.svd.bindings.v1";
const MAX_SVD_BYTES = 32 * 1024 * 1024;

function textValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return String(value["#text"] || value._text || "");
    return String(value);
}

function normalizeVendor(value) {
    return String(value || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .replace(/^ST$/, "STMICROELECTRONICS")
        .replace(/^NORDIC$/, "NORDICSEMICONDUCTOR")
        .replace(/^SILABS$/, "SILICONLABS");
}

function wildcardMatches(pattern, value) {
    const p = normalizePart(pattern);
    const v = normalizePart(value);
    if (!p || !v) return false;
    const re = new RegExp("^" + p.replace(/[X*?]/g, ".") + "$");
    if (re.test(v) || new RegExp("^" + v.replace(/[X*?]/g, ".") + "$").test(p)) return true;
    const pp = p.replace(/[X*?].*$/, ""),
        vp = v.replace(/[X*?].*$/, "");
    return (pp.length >= 5 && v.startsWith(pp)) || (vp.length >= 5 && p.startsWith(vp));
}

function validateSvdBuffer(buffer, identity = null) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (!buffer.length || buffer.length > MAX_SVD_BYTES)
        throw Object.assign(new Error("SVD file is empty or exceeds the size limit"), { code: "INVALID_SVD_SIZE" });
    const xml = buffer.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw Object.assign(new Error("SVD files with DTD or external entities are not allowed"), {
            code: "UNSAFE_XML"
        });
    const valid = XMLValidator.validate(xml);
    if (valid !== true)
        throw Object.assign(new Error(`Invalid SVD XML: ${valid.err?.msg || "parse error"}`), {
            code: "INVALID_SVD_XML"
        });
    const parser = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
        allowBooleanAttributes: false,
        trimValues: true
    });
    const parsed = parser.parse(xml);
    const device = parsed?.device;
    const name = textValue(device?.name).trim();
    const vendor = textValue(device?.vendor).trim();
    const peripherals = device?.peripherals?.peripheral;
    if (!device || !name || !peripherals)
        throw Object.assign(new Error("SVD must contain device/name and at least one peripheral"), {
            code: "INVALID_SVD_STRUCTURE"
        });
    if (identity?.device && !wildcardMatches(name, identity.device)) {
        throw Object.assign(new Error(`SVD device ${name} does not match ${identity.device}`), {
            code: "SVD_DEVICE_MISMATCH",
            details: { svdDevice: name, expected: identity.device }
        });
    }
    if (identity?.vendor && vendor && normalizeVendor(identity.vendor) !== normalizeVendor(vendor)) {
        throw Object.assign(new Error(`SVD vendor ${vendor} does not match ${identity.vendor}`), {
            code: "SVD_VENDOR_MISMATCH",
            details: { svdVendor: vendor, expected: identity.vendor }
        });
    }
    return {
        device: name,
        vendor,
        version: textValue(device?.version).trim(),
        description: textValue(device?.description).trim(),
        peripheralCount: Array.isArray(peripherals) ? peripherals.length : 1
    };
}

class SvdLibraryService {
    constructor(options) {
        this.context = options.context;
        this.validationCache = new Map();
        this.root = path.join(options.context.globalStorageUri.fsPath, "svd-library");
    }

    async init() {
        await fs.promises.mkdir(this.root, { recursive: true });
    }

    async acquireLock() {
        await this.init();
        const lockPath = path.join(this.root, ".library.lock");
        for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
                const handle = await fs.promises.open(lockPath, "wx", 0o600);
                await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
                return async () => {
                    await handle.close().catch(() => {});
                    await fs.promises.unlink(lockPath).catch(() => {});
                };
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                try {
                    const stat = await fs.promises.stat(lockPath);
                    if (Date.now() - stat.mtimeMs > 120000) await fs.promises.unlink(lockPath);
                } catch {
                    /* the lock changed between checks; retry */
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        throw Object.assign(new Error("The shared SVD library is busy"), { code: "SVD_LIBRARY_BUSY" });
    }

    bindings() {
        return { ...(this.context.globalState.get(BINDINGS_KEY) || {}) };
    }

    async bind(folderUri, hash) {
        const key = folderUri?.toString?.() || String(folderUri || "");
        if (!key)
            throw Object.assign(new Error("A workspace folder is required for SVD binding"), { code: "NO_WORKSPACE" });
        const bindings = this.bindings();
        if (hash) bindings[key] = hash;
        else delete bindings[key];
        await this.context.globalState.update(BINDINGS_KEY, bindings);
    }

    async importFile(filePath, metadata = {}, identity = null) {
        await this.init();
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_SVD_BYTES)
            throw Object.assign(new Error("Selected SVD is not a valid file or is too large"), {
                code: "INVALID_SVD_SIZE"
            });
        const buffer = await fs.promises.readFile(filePath);
        const svd = validateSvdBuffer(buffer, identity);
        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        const releaseLock = await this.acquireLock();
        try {
            const finalDir = path.join(this.root, hash);
            const finalSvd = path.join(finalDir, "device.svd");
            if (!fs.existsSync(finalSvd)) {
                const tmpDir = path.join(this.root, `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
                await fs.promises.mkdir(tmpDir, { recursive: false });
                try {
                    await fs.promises.writeFile(path.join(tmpDir, "device.svd"), buffer, { flag: "wx" });
                    const record = {
                        schemaVersion: 1,
                        hash,
                        importedAt: new Date().toISOString(),
                        source: metadata.source || "local",
                        sourceUrl: metadata.sourceUrl || "",
                        vendor: metadata.vendor || svd.vendor,
                        device: metadata.device || svd.device,
                        core: metadata.core || "",
                        packageVendor: metadata.packageVendor || "",
                        packageName: metadata.packageName || "",
                        packageVersion: metadata.packageVersion || "",
                        license: metadata.license || "",
                        svd
                    };
                    await fs.promises.writeFile(path.join(tmpDir, "metadata.json"), JSON.stringify(record, null, 2), {
                        flag: "wx"
                    });
                    try {
                        await fs.promises.rename(tmpDir, finalDir);
                    } catch (error) {
                        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
                        await fs.promises.rm(tmpDir, { recursive: true, force: true });
                    }
                } catch (error) {
                    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
                    throw error;
                }
            } else if (metadata && Object.values(metadata).some(Boolean)) {
                const previous = (await this.metadata(hash)) || {};
                const enriched = {
                    ...previous,
                    source: metadata.source || previous.source || "local",
                    sourceUrl: metadata.sourceUrl || previous.sourceUrl || "",
                    vendor: metadata.vendor || previous.vendor || svd.vendor,
                    device: metadata.device || previous.device || svd.device,
                    core: metadata.core || previous.core || "",
                    packageVendor: metadata.packageVendor || previous.packageVendor || "",
                    packageName: metadata.packageName || previous.packageName || "",
                    packageVersion: metadata.packageVersion || previous.packageVersion || "",
                    license: metadata.license || previous.license || "",
                    hash,
                    svd
                };
                const metadataPath = path.join(finalDir, "metadata.json");
                const tmpMetadata = `${metadataPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
                await fs.promises.writeFile(tmpMetadata, JSON.stringify(enriched, null, 2), { flag: "wx" });
                await fs.promises.rename(tmpMetadata, metadataPath);
            }
            return { hash, path: finalSvd, metadata: await this.metadata(hash), svd };
        } finally {
            await releaseLock();
        }
    }

    async metadata(hash) {
        try {
            return JSON.parse(await fs.promises.readFile(path.join(this.root, hash, "metadata.json"), "utf8"));
        } catch {
            return null;
        }
    }

    async resolveBound(folderUri, identity = null, options = {}) {
        const key = folderUri?.toString?.() || String(folderUri || "");
        const hash = this.bindings()[key];
        if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
        const file = path.join(this.root, hash, "device.svd");
        try {
            const buffer = await fs.promises.readFile(file);
            const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
            const cacheKey = sha256 + JSON.stringify(identity);
            let svd = this.validationCache.get(cacheKey);
            if (!svd) {
                svd = validateSvdBuffer(buffer, identity);
                this.validationCache.set(cacheKey, svd);
                while (this.validationCache.size > 4)
                    this.validationCache.delete(this.validationCache.keys().next().value);
            }
            return { hash, path: file, metadata: await this.metadata(hash), svd, source: "binding", buffer, sha256 };
        } catch {
            if (!options.readOnly) await this.bind(folderUri, "");
            return null;
        }
    }

    async list() {
        await this.init();
        const entries = [];
        for (const name of await fs.promises.readdir(this.root)) {
            if (!/^[a-f0-9]{64}$/i.test(name)) continue;
            const file = path.join(this.root, name, "device.svd");
            try {
                const svd = validateSvdBuffer(await fs.promises.readFile(file));
                entries.push({ hash: name, path: file, metadata: await this.metadata(name), svd });
            } catch {
                /* ignore corrupt entries */
            }
        }
        return entries;
    }

    async findCompatible(identity) {
        const matches = [];
        for (const entry of await this.list()) {
            try {
                validateSvdBuffer(await fs.promises.readFile(entry.path), identity);
                matches.push(entry);
            } catch {
                /* incompatible */
            }
        }
        return matches;
    }
}

module.exports = {
    SvdLibraryService,
    BINDINGS_KEY,
    MAX_SVD_BYTES,
    validateSvdBuffer,
    wildcardMatches,
    normalizeVendor
};
