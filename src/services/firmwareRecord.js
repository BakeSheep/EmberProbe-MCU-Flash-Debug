"use strict";
const { normalizeFileIdentity } = require("../../skills/_emberprobe/file-identity");
const { inspectElf } = require("../../skills/_emberprobe/elf-file");

const DEFAULT_STORAGE_KEY = "agent.lastFlashedFirmware";

// Records the last image EmberProbe programmed in this workspace so Agent reads and writes can
// flag a rebuilt ELF whose addresses may no longer match the firmware still running on the target.
// Programming by other tools is invisible here, so a missing or stale record is reported, not enforced.
class FirmwareRecord {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
        this.now = options.now || (() => Date.now());
        this.inspectElf = options.inspectElf || null;
    }

    /**
     * @param {{ elf?: string, sha256?: string, connection?: { target?: string, probe?: string, probeSerial?: string } }} entry
     */
    async record({ elf, sha256, connection = {} }) {
        if (!this.storage || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return;
        await this.storage.update(this.storageKey, {
            elfPath: normalizeFileIdentity(elf || ""),
            sha256,
            target: String(connection.target || ""),
            probe: String(connection.probe || ""),
            probeSerial: String(connection.probeSerial || ""),
            flashedAt: new Date(this.now()).toISOString()
        });
    }

    // The target was programmed with something this record cannot identify; report "unknown", not a stale match.
    async forget() {
        if (this.storage && this.saved()) await this.storage.update(this.storageKey, undefined);
    }

    /**
     * Follows a built-in debugger launch, which programs the ELF (or confirms it with compare-sections).
     * The adapter stamps the executable before GDB reads it and after the download; the hash is recorded
     * only when the file still has that stamp, so a rebuild during or after launch is never recorded.
     * @param {string} executable
     * @param {{ image?: string, firmware?: string, size?: number, mtimeMs?: number }} loaded
     * @param {{ target?: string, probe?: string, probeSerial?: string }} [connection]
     */
    async recordDebugLaunch(executable, loaded = {}, connection = {}) {
        if (loaded.firmware !== "programmed" && loaded.firmware !== "unchanged") return;
        if (loaded.image === "executable" && executable && Number.isFinite(loaded.size)) {
            try {
                const elf = await (this.inspectElf || inspectElf)(executable);
                if (elf.size === loaded.size && elf.mtimeMs === loaded.mtimeMs)
                    return await this.record({ elf: elf.path, sha256: elf.sha256, connection });
            } catch {
                // An unreadable or changing ELF leaves the target firmware unidentified.
            }
        }
        await this.forget();
    }

    saved() {
        const saved = this.storage?.get(this.storageKey, null);
        return saved && typeof saved === "object" && typeof saved.sha256 === "string" ? saved : null;
    }

    // status: match | mismatch | unknown (nothing recorded by EmberProbe in this workspace).
    check(elf = {}) {
        const saved = this.saved();
        const elfSha256 = String(elf.sha256 || "");
        if (!saved || !elfSha256) return { status: "unknown", elfSha256 };
        const flashed = {
            flashedSha256: saved.sha256,
            flashedElf: saved.elfPath,
            flashedAt: saved.flashedAt,
            target: saved.target
        };
        return saved.sha256 === elfSha256
            ? { status: "match", elfSha256, ...flashed }
            : { status: "mismatch", elfSha256, ...flashed };
    }

    warning(elf) {
        const consistency = this.check(elf);
        return consistency.status === "mismatch"
            ? {
                  code: "ELF_TARGET_MISMATCH",
                  message:
                      "The configured ELF differs from the firmware EmberProbe last programmed; addresses may not match the running target. Flash the current ELF or rebuild the flashed version before trusting these values.",
                  details: consistency
              }
            : null;
    }
}

module.exports = { FirmwareRecord, DEFAULT_STORAGE_KEY };
