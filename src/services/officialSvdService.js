"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const yauzl = require("yauzl");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { normalizePart } = require("./deviceIdentityService");
const { wildcardMatches, normalizeVendor } = require("./svdLibraryService");

const DEFAULT_INDEX_URL = "https://www.keil.com/pack/index.pidx";
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_PACK_BYTES = 512 * 1024 * 1024;

function asArray(value) {
    return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}
function attrs(value) {
    return value && typeof value === "object" ? value : {};
}
function stableVersion(version) {
    return /^\d+(?:\.\d+){1,3}(?:\.\d+)?$/.test(String(version || ""));
}
function compareVersions(a, b) {
    const aa = String(a).split(".").map(Number),
        bb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
        const d = (aa[i] || 0) - (bb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" });
}

function parseXml(buffer, source) {
    const xml = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw Object.assign(new Error(`${source || "XML"} contains a forbidden DTD/entity`), { code: "UNSAFE_XML" });
    const valid = XMLValidator.validate(xml);
    if (valid !== true)
        throw Object.assign(new Error(`Invalid ${source || "XML"}: ${valid.err?.msg || "parse error"}`), {
            code: "INVALID_XML"
        });
    return new XMLParser({ ignoreAttributes: false, processEntities: false, trimValues: true }).parse(xml);
}

function ensureSafeUrl(value, allowHttpLocalhost = false) {
    const url = new URL(value);
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
    if (url.protocol !== "https:" && !(allowHttpLocalhost && local && url.protocol === "http:")) {
        throw Object.assign(new Error(`Only HTTPS CMSIS-Pack sources are allowed: ${url.href}`), {
            code: "INSECURE_SOURCE"
        });
    }
    if (url.username || url.password)
        throw Object.assign(new Error("Credential-bearing download URLs are not allowed"), { code: "UNSAFE_SOURCE" });
    return url;
}

function requestBuffer(urlValue, options = {}, redirects = 0) {
    const maxBytes = options.maxBytes || MAX_XML_BYTES;
    const url = ensureSafeUrl(urlValue, options.allowHttpLocalhost);
    if (redirects > (options.maxRedirects ?? 4))
        return Promise.reject(Object.assign(new Error("Too many download redirects"), { code: "TOO_MANY_REDIRECTS" }));
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        const client = url.protocol === "https:" ? https : http;
        const request = client.get(
            url,
            {
                headers: {
                    "User-Agent": "EmberProbe-CMSIS-Pack/1",
                    Accept: "application/xml,text/xml,application/octet-stream,*/*"
                }
            },
            (response) => {
                const status = response.statusCode || 0;
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    let redirected;
                    try {
                        redirected = new URL(response.headers.location, url).href;
                        ensureSafeUrl(redirected, options.allowHttpLocalhost);
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    requestBuffer(redirected, options, redirects + 1).then(resolve, reject);
                    settled = true;
                    return;
                }
                if (status !== 200 && status !== 206) {
                    response.resume();
                    fail(
                        Object.assign(new Error(`Download failed with HTTP ${status}: ${url.href}`), {
                            code: "HTTP_ERROR",
                            status
                        })
                    );
                    return;
                }
                const total = Number(response.headers["content-length"]) || 0;
                if (total > maxBytes) {
                    response.destroy();
                    fail(Object.assign(new Error("Download exceeds the size limit"), { code: "DOWNLOAD_TOO_LARGE" }));
                    return;
                }
                const chunks = [];
                let received = 0;
                response.on("data", (chunk) => {
                    received += chunk.length;
                    if (received > maxBytes) {
                        response.destroy(
                            Object.assign(new Error("Download exceeds the size limit"), { code: "DOWNLOAD_TOO_LARGE" })
                        );
                        return;
                    }
                    chunks.push(chunk);
                    options.onProgress?.({
                        phase: "downloading",
                        received,
                        total,
                        percent: total ? Math.min(100, Math.round((received * 100) / total)) : null,
                        url: url.href
                    });
                });
                response.on("error", fail);
                response.on("end", () => {
                    if (!settled) {
                        settled = true;
                        resolve({ buffer: Buffer.concat(chunks), url: url.href, headers: response.headers });
                    }
                });
            }
        );
        request.setTimeout(options.timeoutMs || 30000, () =>
            request.destroy(Object.assign(new Error("Download timed out"), { code: "DOWNLOAD_TIMEOUT" }))
        );
        request.on("error", fail);
        if (options.signal) {
            if (options.signal.aborted)
                request.destroy(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
            else
                options.signal.addEventListener(
                    "abort",
                    () =>
                        request.destroy(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" })),
                    { once: true }
                );
        }
    });
}

async function requestFile(urlValue, filePath, options = {}, redirects = 0) {
    const maxBytes = options.maxBytes || MAX_PACK_BYTES;
    const url = ensureSafeUrl(urlValue, options.allowHttpLocalhost);
    if (redirects > (options.maxRedirects ?? 4))
        throw Object.assign(new Error("Too many download redirects"), { code: "TOO_MANY_REDIRECTS" });
    throwIfAborted(options.signal);
    let request;
    const cancel = () =>
        request?.destroy(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
        const response = await new Promise((resolve, reject) => {
            request = (url.protocol === "https:" ? https : http).get(
                url,
                {
                    headers: { "User-Agent": "EmberProbe-CMSIS-Pack/1", Accept: "application/octet-stream,*/*" }
                },
                resolve
            );
            request.on("error", reject);
            request.setTimeout(options.timeoutMs || 120000, () =>
                request.destroy(Object.assign(new Error("Download timed out"), { code: "DOWNLOAD_TIMEOUT" }))
            );
            if (options.signal?.aborted) cancel();
        });
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
            response.destroy();
            return await requestFile(new URL(response.headers.location, url).href, filePath, options, redirects + 1);
        }
        if (status !== 200) {
            response.destroy();
            throw Object.assign(new Error("Download failed with HTTP " + status), { code: "HTTP_ERROR", status });
        }
        const total = Number(response.headers["content-length"]) || 0;
        if (total > maxBytes) {
            response.destroy();
            throw Object.assign(new Error("Download exceeds the size limit"), { code: "DOWNLOAD_TOO_LARGE" });
        }
        let received = 0;
        const hash = crypto.createHash("sha256");
        const meter = new (require("stream").Transform)({
            transform(chunk, _encoding, callback) {
                try {
                    received += chunk.length;
                    if (received > maxBytes)
                        throw Object.assign(new Error("Download exceeds the size limit"), {
                            code: "DOWNLOAD_TOO_LARGE"
                        });
                    hash.update(chunk);
                    options.onProgress?.({
                        phase: "downloading",
                        received,
                        total,
                        percent: total ? Math.min(100, Math.round((received * 100) / total)) : null,
                        url: url.href
                    });
                    callback(null, chunk);
                } catch (error) {
                    callback(error);
                }
            }
        });
        // pipeline closes every participant before reporting network or filesystem failure.
        await require("stream/promises").pipeline(
            response,
            meter,
            fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 })
        );
        throwIfAborted(options.signal);
        return { path: filePath, url: url.href, headers: response.headers, received, sha256: hash.digest("hex") };
    } catch (error) {
        throwIfAborted(options.signal);
        throw error;
    } finally {
        options.signal?.removeEventListener("abort", cancel);
        request?.destroy();
    }
}

function packageScore(item, identity) {
    const name = normalizePart(item.name);
    const device = normalizePart(identity.device || identity.family);
    if (!name || !device) return -1;
    let score = 0;
    if (/DFP|DEVICEFAMILYPACK/.test(name)) score += 10;
    const stem = name.replace(/(?:DEVICEFAMILYPACK|DFP|PACK)$/g, "");
    if (wildcardMatches(stem, device)) score += 100;
    else {
        const prefix = stem.replace(/[X*?].*$/, "");
        if (prefix.length >= 4 && device.startsWith(prefix)) score += 50 + prefix.length;
        else if (device.includes(prefix) || stem.includes(device.slice(0, Math.min(device.length, 7)))) score += 20;
    }
    const vendor = normalizePart(identity.vendor);
    if (vendor && normalizePart(item.vendor).includes(vendor.slice(0, 5))) score += 30;
    return score;
}

function parseIndex(buffer) {
    const parsed = parseXml(buffer, "CMSIS-Pack index");
    const list = asArray(parsed?.index?.pindex?.pdsc).map((item) => ({
        vendor: String(item?.["@_vendor"] || ""),
        name: String(item?.["@_name"] || ""),
        version: String(item?.["@_version"] || ""),
        url: String(item?.["@_url"] || parsed?.index?.url || ""),
        deprecated: String(item?.["@_deprecated"] || ""),
        replacement: String(item?.["@_replacement"] || "")
    }));
    return list.filter((item) => item.vendor && item.name && item.url && !item.deprecated);
}

function latestRelease(packageNode, fallback) {
    const releases = asArray(packageNode?.releases?.release)
        .map((release) => ({
            version: String(release?.["@_version"] || ""),
            url: String(release?.["@_url"] || ""),
            checksum: String(release?.["@_sha256"] || release?.["@_checksum"] || "")
        }))
        .filter((item) => stableVersion(item.version))
        .sort((a, b) => compareVersions(b.version, a.version));
    return releases[0] || { version: fallback, url: "", checksum: "" };
}

function collectLicenses(packageNode) {
    const sets = asArray(packageNode?.licenseSets?.licenseSet);
    const items = [];
    let gating = false;
    for (const set of sets) {
        gating = gating || String(set?.["@_gating"] || "").toLowerCase() === "true";
        for (const license of asArray(set?.license))
            items.push({
                title: String(license?.["@_title"] || license?.["@_spdx"] || license?.["@_name"] || "License"),
                name: String(license?.["@_name"] || ""),
                spdx: String(license?.["@_spdx"] || "")
            });
    }
    if (!items.length && packageNode?.license)
        items.push({ title: String(packageNode.license), name: String(packageNode.license), spdx: "" });
    return { gating, items };
}

function collectDevices(packageNode) {
    const results = [];
    const walk = (node, inherited = {}) => {
        if (!node || typeof node !== "object") return;
        /** @type {Record<string, any>} */
        const current = { ...inherited };
        for (const key of ["Dvendor", "Dfamily", "DsubFamily", "Dname", "Dvariant", "Dcore", "Pname"]) {
            if (node[`@_${key}`] !== undefined) current[key] = String(node[`@_${key}`]);
        }
        const debug = node.debug !== undefined ? asArray(node.debug) : inherited.debug || [];
        current.debug = debug;
        const deviceName = current.Dvariant || current.Dname;
        if (deviceName) {
            for (const entry of debug) {
                const svd = String(entry?.["@_svd"] || "");
                if (!svd) continue;
                results.push({
                    device: deviceName,
                    family: current.Dfamily || "",
                    subFamily: current.DsubFamily || "",
                    vendor: current.Dvendor || packageNode.vendor || "",
                    core: String(entry?.["@_Pname"] || entry?.["@_Dcore"] || current.Pname || current.Dcore || ""),
                    svd
                });
            }
        }
        for (const key of ["family", "subFamily", "device", "variant"])
            for (const child of asArray(node[key])) walk(child, current);
    };
    for (const family of asArray(packageNode?.devices?.family)) walk(family, {});
    const seen = new Set();
    return results.filter((item) => {
        const key = [item.device, item.core, item.svd].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function deviceMatches(candidate, identity) {
    if (identity.device) return wildcardMatches(candidate.device, identity.device);
    const family = normalizePart(identity.family);
    if (!family) return false;
    const prefix = family.replace(/[X*?].*$/, "");
    return normalizePart(candidate.device).startsWith(prefix) || wildcardMatches(candidate.family, family);
}

function vendorMatches(candidate, identity) {
    if (!identity.vendor || !candidate.vendor) return true;
    const actual = normalizeVendor(candidate.vendor).replace(/\d+$/, "");
    const expected = normalizeVendor(identity.vendor).replace(/\d+$/, "");
    return actual === expected || actual.startsWith(expected) || expected.startsWith(actual);
}

function safeZipName(name) {
    const normalized = String(name || "").replace(/\\/g, "/");
    const pathValue = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    if (
        !pathValue ||
        normalized.startsWith("/") ||
        /^[A-Za-z]:/.test(normalized) ||
        pathValue.split("/").some((part) => part === ".." || part === "")
    ) {
        throw Object.assign(new Error(`Unsafe path in CMSIS-Pack: ${name}`), { code: "UNSAFE_PACK_PATH" });
    }
    return normalized;
}

function extractPackEntry(packPath, wantedPath, maxBytes = MAX_XML_BYTES) {
    return new Promise((resolve, reject) => {
        yauzl.open(
            packPath,
            { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true },
            (openError, zip) => {
                if (openError) {
                    reject(Object.assign(openError, { code: "INVALID_PACK" }));
                    return;
                }
                let found = false,
                    settled = false,
                    targetBuffer = null;
                const fail = (error) => {
                    if (!settled) {
                        settled = true;
                        try {
                            zip.close();
                        } catch {}
                        reject(error);
                    }
                };
                zip.on("error", fail);
                zip.on("entry", (entry) => {
                    let name;
                    try {
                        name = safeZipName(entry.fileName);
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
                    if (unixMode === 0o120000) {
                        fail(
                            Object.assign(new Error(`Symbolic links are not allowed in CMSIS-Pack: ${name}`), {
                                code: "UNSAFE_PACK_LINK"
                            })
                        );
                        return;
                    }
                    // ZIP 目录条目（如 SVD/）是合法的 Pack 结构；它们不包含可提取数据。
                    if (name.endsWith("/")) {
                        zip.readEntry();
                        return;
                    }
                    if (name.toLowerCase() !== String(wantedPath).replace(/\\/g, "/").toLowerCase()) {
                        zip.readEntry();
                        return;
                    }
                    if (found) {
                        fail(
                            Object.assign(new Error("CMSIS-Pack contains duplicate SVD entries"), {
                                code: "DUPLICATE_PACK_ENTRY"
                            })
                        );
                        return;
                    }
                    found = true;
                    if (entry.uncompressedSize > maxBytes) {
                        fail(Object.assign(new Error("SVD entry exceeds the size limit"), { code: "SVD_TOO_LARGE" }));
                        return;
                    }
                    zip.openReadStream(entry, (streamError, stream) => {
                        if (streamError) {
                            fail(streamError);
                            return;
                        }
                        const chunks = [];
                        let size = 0;
                        stream.on("data", (chunk) => {
                            size += chunk.length;
                            if (size > maxBytes)
                                stream.destroy(
                                    Object.assign(new Error("SVD entry exceeds the size limit"), {
                                        code: "SVD_TOO_LARGE"
                                    })
                                );
                            else chunks.push(chunk);
                        });
                        stream.on("error", fail);
                        stream.on("end", () => {
                            if (!settled) {
                                targetBuffer = Buffer.concat(chunks);
                                zip.readEntry();
                            }
                        });
                    });
                });
                zip.on("end", () => {
                    if (!found || !targetBuffer)
                        fail(
                            Object.assign(new Error(`SVD ${wantedPath} was not found in the CMSIS-Pack`), {
                                code: "SVD_NOT_IN_PACK"
                            })
                        );
                    else if (!settled) {
                        settled = true;
                        resolve(targetBuffer);
                    }
                });
                zip.readEntry();
            }
        );
    });
}

class OfficialSvdService {
    constructor(options = {}) {
        this.indexUrl = options.indexUrl || DEFAULT_INDEX_URL;
        this.allowHttpLocalhost = !!options.allowHttpLocalhost;
        this.timeoutMs = options.timeoutMs || 30000;
    }

    async discover(identity, options = {}) {
        throwIfAborted(options.signal);
        options.onProgress?.({ phase: "catalog", percent: null });
        const common = {
            timeoutMs: this.timeoutMs,
            signal: options.signal,
            onProgress: options.onProgress,
            allowHttpLocalhost: this.allowHttpLocalhost
        };
        const index = parseIndex((await requestBuffer(this.indexUrl, { ...common, maxBytes: MAX_XML_BYTES })).buffer);
        throwIfAborted(options.signal);
        const ranked = index
            .map((item) => ({ ...item, score: packageScore(item, identity) }))
            .filter((item) => item.score >= 20)
            .sort((a, b) => b.score - a.score)
            .slice(0, 12);
        const found = [];
        for (const item of ranked) {
            throwIfAborted(options.signal);
            const base = item.url.endsWith("/") ? item.url : `${item.url}/`;
            const pdscUrl = new URL(`${item.vendor}.${item.name}.pdsc`, base).href;
            let response;
            try {
                response = await requestBuffer(pdscUrl, { ...common, maxBytes: MAX_XML_BYTES });
            } catch (error) {
                if (error?.code === "DOWNLOAD_CANCELLED") throw error;
                throwIfAborted(options.signal);
                continue;
            }
            throwIfAborted(options.signal);
            const packageNode = parseXml(response.buffer, "PDSC")?.package;
            const release = latestRelease(packageNode, item.version);
            if (!stableVersion(release.version)) continue;
            const devices = collectDevices(packageNode).filter(
                (device) => deviceMatches(device, identity) && vendorMatches(device, identity)
            );
            const license = collectLicenses(packageNode);
            for (const device of devices)
                found.push({
                    ...device,
                    packageVendor: String(packageNode?.vendor || item.vendor),
                    packageName: String(packageNode?.name || item.name),
                    packageVersion: release.version,
                    packageBaseUrl: String(packageNode?.url || base),
                    packageUrl: release.url || "",
                    checksum: release.checksum,
                    pdscUrl: response.url,
                    license
                });
            if (identity.exact && found.length) break;
        }
        return found;
    }

    async download(candidate, options = {}) {
        throwIfAborted(options.signal);
        if (!candidate)
            throw Object.assign(new Error("Select a device/SVD candidate first"), { code: "NO_SVD_CANDIDATE" });
        if (candidate.license?.gating) {
            const accepted = await options.onLicense?.({
                source: candidate.pdscUrl,
                package: `${candidate.packageVendor}.${candidate.packageName}@${candidate.packageVersion}`,
                licenses: candidate.license.items
            });
            if (!accepted)
                throw Object.assign(new Error("The CMSIS-Pack license was not accepted"), { code: "LICENSE_DECLINED" });
            throwIfAborted(options.signal);
        }
        const base = String(candidate.packageBaseUrl || "").endsWith("/")
            ? candidate.packageBaseUrl
            : `${candidate.packageBaseUrl}/`;
        const packUrl = candidate.packageUrl
            ? new URL(candidate.packageUrl, base).href
            : new URL(`${candidate.packageVendor}.${candidate.packageName}.${candidate.packageVersion}.pack`, base)
                  .href;
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-svd-"));
        const packPath = path.join(dir, "package.pack");
        try {
            const response = await requestFile(packUrl, packPath, {
                timeoutMs: Math.max(this.timeoutMs, 120000),
                maxBytes: MAX_PACK_BYTES,
                signal: options.signal,
                onProgress: options.onProgress,
                allowHttpLocalhost: this.allowHttpLocalhost
            });
            throwIfAborted(options.signal);
            if (
                candidate.checksum &&
                /^[a-f0-9]{64}$/i.test(candidate.checksum) &&
                response.sha256.toLowerCase() !== candidate.checksum.toLowerCase()
            )
                throw Object.assign(new Error("CMSIS-Pack checksum verification failed"), {
                    code: "CHECKSUM_MISMATCH"
                });
            options.onProgress?.({ phase: "validating", percent: 100 });
            throwIfAborted(options.signal);
            const svd = await extractPackEntry(packPath, candidate.svd);
            throwIfAborted(options.signal);
            return { buffer: svd, sourceUrl: response.url, candidate };
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

module.exports = {
    OfficialSvdService,
    DEFAULT_INDEX_URL,
    MAX_XML_BYTES,
    MAX_PACK_BYTES,
    parseXml,
    parseIndex,
    collectDevices,
    collectLicenses,
    latestRelease,
    requestBuffer,
    requestFile,
    extractPackEntry,
    safeZipName,
    deviceMatches,
    vendorMatches,
    packageScore,
    compareVersions
};
