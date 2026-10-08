"use strict";

const fs = require("fs");
const path = require("path");

/** @type {ReadonlyArray<[RegExp, string]>} */
const VENDOR_HINTS = Object.freeze([
    [/^STM32/i, "STMicroelectronics"],
    [/^GD32/i, "GigaDevice"],
    [/^APM32/i, "Geehy"],
    [/^AT(?:SAM|SAME|SAMD|SAMC|SAMG|SAML|SAMV)/i, "Microchip"],
    [/^NRF/i, "NordicSemiconductor"],
    [/^(?:LPC|MIMXRT|MK[LEV]?|KE\d)/i, "NXP"],
    [/^EFM32|^EFR32/i, "SiliconLabs"],
    [/^HC32/i, "HDSC"],
    [/^MM32/i, "MindMotion"],
    [/^CH32/i, "WCH"],
    [/^RP2040/i, "RaspberryPi"]
]);

function normalizePart(value) {
    return String(value || "")
        .toUpperCase()
        .replace(/[^A-Z0-9X*?]/g, "");
}

function vendorForPart(part) {
    for (const [pattern, vendor] of VENDOR_HINTS) if (pattern.test(String(part || ""))) return vendor;
    return "";
}

function targetIdentity(target) {
    const stem = path
        .basename(String(target || ""), path.extname(String(target || "")))
        .replace(/(?:_dual_bank|[-_]core\d+)$/i, "")
        .toUpperCase();
    /** @type {Array<[RegExp, string]>} */
    const aliases = [
        [/^STM32([FGLHUW]\d)X?$/i, "STM32$1XX"],
        [/^NRF(51|52)$/i, "NRF$1"],
        [/^GD32([A-Z]\d{2})X$/i, "GD32$1X"],
        [/^ATSAM([A-Z0-9]+)XX$/i, "ATSAM$1"]
    ];
    let family = stem;
    for (const [pattern, replacement] of aliases) if (pattern.test(stem)) family = stem.replace(pattern, replacement);
    return { family, vendor: vendorForPart(family), source: "openocd-target", confidence: "family" };
}

function extractProjectParts(text) {
    const parts = [];
    const patterns = [
        /^Mcu\.(?:Name|Cpn)\s*=\s*([^\s,]+)/gim,
        /\b(?:device|deviceName|Dname|mcu|processor)\s*[:=]\s*["']?([A-Z][A-Z0-9_.-]{4,})/gim,
        /\b(STM32[A-Z0-9]{5,}|GD32[A-Z0-9]{5,}|APM32[A-Z0-9]{4,}|ATSAM[A-Z0-9]{4,}|NRF\d{5,}|LPC\d{4,}[A-Z0-9]*)\b/gim
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text))) {
            const part = normalizePart(match[1]);
            if (part && !parts.includes(part)) parts.push(part);
            if (parts.length >= 128) return parts;
        }
    }
    return parts;
}

function scanProject(workspacePath, maxFiles = 80, maxEntries = 5000) {
    if (!workspacePath || !fs.existsSync(workspacePath)) return [];
    const found = [];
    const queue = [workspacePath];
    const allowed = /(?:\.ioc|\.ya?ml|\.pdsc|\.cprj)$/i;
    const ignored = new Set([".git", "node_modules", "dist", "build", "out"]);
    let scannedFiles = 0;
    let visitedEntries = 0;
    while (queue.length && scannedFiles < maxFiles && visitedEntries < maxEntries) {
        const dir = queue.shift();
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            visitedEntries += 1;
            if (entry.isDirectory()) {
                if (!ignored.has(entry.name)) queue.push(path.join(dir, entry.name));
            } else if (allowed.test(entry.name)) {
                scannedFiles += 1;
                const file = path.join(dir, entry.name);
                try {
                    const stat = fs.statSync(file);
                    if (stat.size > 2 * 1024 * 1024) continue;
                    const parts = extractProjectParts(fs.readFileSync(file, "utf8"));
                    for (const part of parts) found.push({ part, file });
                } catch {
                    /* ignore unreadable project metadata */
                }
            }
            if (scannedFiles >= maxFiles || visitedEntries >= maxEntries) break;
        }
    }
    return found;
}

class DeviceIdentityService {
    async resolveAsync(options = {}) {
        return this.resolve({ ...options, project: await scanProjectAsync(options.workspacePath) });
    }
    resolve(options = {}) {
        const project = options.project || scanProject(options.workspacePath);
        const uniqueProject = [...new Map(project.map((item) => [item.part, item])).values()];
        const chip = options.chipInfo || {};
        const exactChip = normalizePart(chip.chip || chip.device || chip.partNumber);
        const compatible = chip.authenticity === "compatible";
        if (uniqueProject.length === 1) {
            const part = uniqueProject[0].part;
            return {
                device: part,
                vendor: vendorForPart(part),
                exact: true,
                confidence: "exact",
                source: "project",
                evidence: uniqueProject
            };
        }
        if (exactChip) {
            const actualVendor = compatible
                ? String(chip.compatBrand || chip.compatVendor || vendorForPart(exactChip) || "")
                : String(chip.vendor || vendorForPart(exactChip) || "");
            return {
                device: exactChip,
                vendor: actualVendor,
                exact: true,
                confidence: "exact",
                source: "openocd-device",
                compatible
            };
        }
        const target = targetIdentity(options.target);
        return {
            device: "",
            family: target.family,
            vendor: compatible
                ? String(chip.compatBrand || chip.compatVendor || target.vendor)
                : String(chip.vendor || "") || target.vendor,
            exact: false,
            confidence: chip.deviceId || chip.flashSize || chip.core ? "fingerprint" : target.confidence,
            source: chip.deviceId || chip.flashSize || chip.core ? "hardware-fingerprint" : target.source,
            core: chip.core || "",
            deviceId: chip.deviceId || "",
            flashSize: chip.flashSize || "",
            candidates: uniqueProject.map((item) => item.part),
            compatible
        };
    }
}
async function scanProjectAsync(workspacePath, maxFiles = 80, maxEntries = 5000) {
    if (!workspacePath) return [];
    const found = [],
        queue = [workspacePath];
    const ignored = new Set([".git", "node_modules", "dist", "build", "out"]);
    let scanned = 0,
        visited = 0;
    for (let index = 0; index < queue.length && scanned < maxFiles && visited < maxEntries; index++) {
        const dir = queue[index];
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            visited++;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory() && !ignored.has(entry.name)) queue.push(file);
            else if (entry.isFile() && /(?:\.ioc|\.ya?ml|\.pdsc|\.cprj)$/i.test(entry.name)) {
                scanned++;
                try {
                    const stat = await fs.promises.stat(file);
                    if (stat.size <= 2 * 1024 * 1024) {
                        const text = await fs.promises.readFile(file, "utf8");
                        if (Buffer.byteLength(text) <= 2 * 1024 * 1024)
                            for (const part of extractProjectParts(text)) found.push({ part, file });
                    }
                } catch {
                    /* Unreadable metadata is optional. */
                }
            }
            if (scanned >= maxFiles || visited >= maxEntries) break;
        }
    }
    return found;
}

module.exports = {
    DeviceIdentityService,
    normalizePart,
    vendorForPart,
    targetIdentity,
    extractProjectParts,
    scanProject,
    scanProjectAsync
};
