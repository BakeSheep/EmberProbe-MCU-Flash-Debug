"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { quote } = require("../debug/mi");
const {
    buildDownloadBoostCommand,
    buildFlashBoundsCommand,
    DOWNLOAD_CLOCK_RESTORE
} = require("../../skills/_emberprobe/openocd-flash");
const { imageRanges, validateLoadImage } = require("./flashImageBounds");
const { inspectElf, MAX_ELF_BYTES } = require("../../skills/_emberprobe/elf-file");

const HOOKS = [
    "preLaunchCommands",
    "postLaunchCommands",
    "preAttachCommands",
    "postAttachCommands",
    "preResetCommands",
    "postResetCommands"
];
const gdbPath = (file) => file.replace(/\\/g, "/");
// compare-sections result lines; a localized GDB prints other text, which falls back to downloading.
const SECTION_MATCHED = /^Section \S+, range 0x[\da-f]+ -- 0x[\da-f]+: matched\.\s*$/;

function isRemoteDisconnectedError(error) {
    return /remote connection closed|target disconnected|not connected to a remote target|"monitor" command not supported by this target|when your target is ['"`]exec['"`]/i.test(
        String(error?.message || error || "")
    );
}

function address(value, signed = false) {
    if (
        (typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "number" && !Number.isSafeInteger(value)) ||
        !/^-?(?:0x[\da-f]+|\d+)$/i.test(String(value))
    )
        throw new Error("Image addresses must be integer or hexadecimal literals");
    const negative = String(value).startsWith("-");
    const number = BigInt(negative ? String(value).slice(1) : String(value)) * (negative ? -1n : 1n);
    if (number > 0xffffffffn || number < (signed ? -0xffffffffn : 0n))
        throw new Error("Image address is outside ARM32 range");
    return number < 0n ? `-0x${(-number).toString(16)}` : `0x${number.toString(16)}`;
}
function imageFile(value, cwd) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value))
        throw new Error("Provide a valid image file path");
    const file = path.resolve(cwd, value);
    if (!fs.statSync(file).isFile()) throw new Error(`Image is not a file: ${file}`);
    return fs.realpathSync(file);
}
function normalizeDebugImages(config, cwd = config.cwd || process.cwd()) {
    const result = {};
    for (const key of HOOKS) {
        const commands = config[key];
        if (commands === undefined) continue;
        if (
            !Array.isArray(commands) ||
            commands.length > 64 ||
            commands.some(
                (command) =>
                    typeof command !== "string" ||
                    !command.trim() ||
                    command.length > 16384 ||
                    /[\x00-\x1f]/.test(command)
            )
        )
            throw new Error(`${key} must contain at most 64 single-line GDB commands`);
        result[key] = [...commands];
    }
    for (const key of ["symbolFiles", "loadFiles"]) {
        if (config[key] === undefined) continue;
        if (!Array.isArray(config[key]) || config[key].length > 32)
            throw new Error(`${key} must contain at most 32 images`);
        result[key] = config[key].map((value) => {
            const entry = typeof value === "string" ? { file: value } : value;
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid ${key} entry`);
            const allowed =
                key === "symbolFiles"
                    ? ["file", "offset", "textaddress", "sections"]
                    : ["file", "format", "address", "offset"];
            if (Object.keys(entry).some((name) => !allowed.includes(name)))
                throw new Error(`Unknown ${key} image property`);
            const item = { file: imageFile(entry.file, cwd) };
            if (entry.offset !== undefined) item.offset = address(entry.offset, true);
            if (key === "symbolFiles") {
                if (entry.textaddress !== undefined) item.textaddress = address(entry.textaddress);
                if (entry.sections !== undefined) {
                    if (!Array.isArray(entry.sections) || entry.sections.length > 128)
                        throw new Error("Image sections must be an array with at most 128 entries");
                    const seen = new Set();
                    item.sections = entry.sections.map((section) => {
                        if (
                            !section ||
                            !/^[.\w$][.\w$-]{0,127}$/.test(section.name || "") ||
                            seen.has(section.name) ||
                            Object.keys(section).some((name) => !["name", "address"].includes(name))
                        )
                            throw new Error("Invalid or duplicate image section name");
                        seen.add(section.name);
                        return { name: section.name, address: address(section.address) };
                    });
                }
            } else {
                item.format = entry.format || path.extname(item.file).slice(1).toLowerCase();
                if (!["elf", "hex", "bin"].includes(item.format))
                    throw new Error("Load images must be ELF, HEX or BIN");
                if (entry.address !== undefined) item.address = address(entry.address);
                if (item.format === "bin" && item.address === undefined)
                    throw new Error("BIN load images require an explicit address");
                if (item.format === "bin" && item.offset !== undefined)
                    throw new Error("Use address, not offset, for BIN images");
                if (item.format !== "bin" && item.address !== undefined)
                    throw new Error("Use offset for ELF/HEX; their base addresses come from the file");
                if (item.format === "bin" && BigInt(item.address) + BigInt(fs.statSync(item.file).size) > 0x100000000n)
                    throw new Error("BIN load image exceeds the ARM32 address range");
                validateLoadImage(item);
            }
            return item;
        });
        if (key === "symbolFiles") {
            const files = result[key].map((item) => item.file);
            if (new Set(files).size !== files.length)
                throw new Error("Each symbol image must have a distinct file identity");
        }
    }
    return result;
}

function symbolImages(config) {
    return config.symbolFiles ?? [{ file: config.executable }];
}

class DebugImages {
    constructor(session) {
        this.session = session;
    }
    async hooks(key) {
        const commands = this.session.config[key] || [];
        if (commands.length) this.session.symbolDirectory.reset();
        for (const [index, command] of commands.entries()) {
            this.session.variableDiagnostic(`GDB ${key} hook ${index + 1}/${commands.length}\n`);
            try {
                await this.session.mi.command(`-interpreter-exec console ${quote(command)}`);
            } catch (error) {
                throw new Error(`${key} failed (${command.slice(0, 100)}): ${error.message}`);
            }
        }
    }
    async symbols() {
        const { config, mi } = this.session;
        const images = symbolImages(config);
        config.primarySymbolFile = images[0]?.file || null;
        if (config.symbolFiles === undefined) {
            await mi.command(`-file-exec-and-symbols ${quote(gdbPath(config.executable))}`);
        } else {
            await mi.command(`-file-exec-file ${quote(gdbPath(config.executable))}`);
            await mi.command("-file-symbol-file");
            for (const [index, image] of images.entries()) {
                const sections = image.sections || [];
                if (index === 0 && image.textaddress === undefined && !sections.length) {
                    const command = `symbol-file ${quote(gdbPath(image.file))}${image.offset ? ` -o ${image.offset}` : ""}`;
                    await mi.command(`-interpreter-exec console ${quote(command)}`);
                } else {
                    const command =
                        `add-symbol-file ${quote(gdbPath(image.file))}${image.offset ? ` -o ${image.offset}` : ""}${image.textaddress !== undefined ? ` ${image.textaddress}` : ""}` +
                        sections.map((section) => ` -s ${section.name} ${section.address}`).join("");
                    await mi.command(`-interpreter-exec console ${quote(command)}`);
                }
            }
        }
        this.session.symbolDirectory.reset();
        await this.verifyRtosPrimary();
    }
    async verifyRtosPrimary() {
        const { config, mi } = this.session;
        if (!this.session.rtosAware || !["FreeRTOS", "auto"].includes(config.rtos) || symbolImages(config).length < 2)
            return;
        const entries = await this.session.symbolDirectory.load({ symbolSetup: true });
        if (config.rtos === "auto" && !entries.some((entry) => entry.name === "pxCurrentTCB")) return;
        const primary = gdbPath(config.primarySymbolFile || "");
        const matches = entries.filter((entry) => entry.image === primary && entry.name === "pxCurrentTCB");
        if (matches.length !== 1 || !matches[0].expression || !matches[0].symbolAddress)
            throw new Error("FreeRTOS primary symbol image is missing an unambiguous pxCurrentTCB");
        const result = await mi.command('-data-evaluate-expression "(unsigned long long)&(pxCurrentTCB)"');
        const address = String(result.value).match(/^\s*(0x[\da-f]+|\d+)(?=\s|$)/i);
        if (!address || BigInt(address[1]) !== BigInt(matches[0].symbolAddress))
            throw new Error("GDB RTOS symbol lookup does not select the primary image");
    }
    // Verify a raised-clock download section by section using the server's CRC (qCRC). A segment-wide
    // checksum is not equivalent: GDB leaves alignment gaps at the erased value instead of ELF zero fill.
    // "matched", "mismatched", or "unknown" when the check failed or its output was not recognized.
    async compareSections() {
        const { mi } = this.session;
        let output;
        try {
            output = await this.session.captureConsole(() =>
                mi.command(`-interpreter-exec console ${quote("compare-sections")}`, 60000)
            );
        } catch (error) {
            if (mi.closed || isRemoteDisconnectedError(error)) throw error;
            return "unknown";
        }
        if (/MIS-MATCHED|does not match|do not match/.test(output)) return "mismatched";
        const lines = output.split(/\r?\n/).filter((line) => line.startsWith("Section "));
        return lines.length > 0 && lines.every((line) => SECTION_MATCHED.test(line)) ? "matched" : "unknown";
    }
    // Managed launches pass the sidebar's programming clock. It is raised through OpenOCD only for Cortex-M
    // over SWD and only when CPUID reads back unchanged; anything else downloads at the script clock.
    // Returns the effective kHz, or 0 when the clock was left alone.
    async raiseDownloadClock() {
        const { config, mi } = this.session;
        const khz = Number(config.__emberprobeDownloadSpeedKhz);
        if (!Number.isSafeInteger(khz) || khz <= 0) return 0;
        let output;
        try {
            output = await this.session.captureConsole(() =>
                mi.command(`-interpreter-exec console ${quote(`monitor ${buildDownloadBoostCommand(khz)}`)}`)
            );
        } catch (error) {
            if (mi.closed) throw error;
            return 0;
        }
        if (!(Number(output.match(/EP_DOWNLOAD_BASE=(\d+)/)?.[1]) > 0)) return 0;
        return Number(output.match(/EP_FLASH_SPEED=(\d+)/)?.[1]) || khz;
    }
    async restoreDownloadClock() {
        try {
            await this.session.captureConsole(() =>
                this.session.mi.command(`-interpreter-exec console ${quote(`monitor ${DOWNLOAD_CLOCK_RESTORE}`)}`)
            );
        } catch (error) {
            if (this.session.mi.closed || isRemoteDisconnectedError(error)) throw error;
        }
    }
    async checkedDownload(executableStamp) {
        const { config, mi } = this.session;
        const sources = config.loadFiles ?? [
            { file: path.resolve(config.cwd || "", config.executable), format: "elf" }
        ];
        if (!sources.length) return { firmware: /** @type {const} */ ("none") };
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-debug-flash-"));
        try {
            const snapshots = [];
            const ranges = [];
            for (const [index, image] of sources.entries()) {
                const file = path.join(directory, `image-${index}.${image.format}`);
                if (image.format === "elf") {
                    const snapshot = await inspectElf(image.file, { snapshot: file });
                    if (
                        config.loadFiles === undefined &&
                        executableStamp &&
                        (snapshot.size !== executableStamp.size || snapshot.mtimeMs !== executableStamp.mtimeMs)
                    )
                        throw new Error("The ELF changed after GDB opened it. Restart debugging with the current ELF");
                } else {
                    // The inclusive limit captures at most one extra byte to detect a growing file.
                    await pipeline(
                        fs.createReadStream(image.file, { end: MAX_ELF_BYTES }),
                        fs.createWriteStream(file, { flags: "wx", mode: 0o600 })
                    );
                }
                const snapshot = { ...image, file };
                const imageIntervals = imageRanges(snapshot, true);
                if (!imageIntervals.length) throw new Error("Image has no loadable data");
                if (ranges.length + imageIntervals.length > 16384)
                    throw new Error(`Load interval limit exceeded at ${path.basename(image.file)}`);
                ranges.push(...imageIntervals);
                snapshots.push(snapshot);
            }
            const check = buildFlashBoundsCommand(ranges);
            let failed;
            const output = await this.session.captureConsole(async () => {
                try {
                    await mi.command(`-interpreter-exec console ${quote(`monitor ${check}`)}`);
                } catch (error) {
                    failed = error;
                }
            });
            if (!/^EP_FLASH_BOUNDS_OK\s*$/m.test(output))
                throw new Error(
                    output.match(/^EP_FLASH_BOUNDS_ERROR (.+)$/m)?.[1] ||
                        failed?.message ||
                        "Unable to verify the Flash ranges"
                );
            if (failed) throw failed;
            if (config.loadFiles !== undefined) return await this.downloadPrepared(snapshots);

            // Keep GDB's symbols on the user's file and load the exact bytes used by the bounds check.
            await mi.command(`-file-exec-file ${quote(gdbPath(snapshots[0].file))}`);
            try {
                return await this.downloadPrepared();
            } finally {
                if (!mi.closed) await mi.command(`-file-exec-file ${quote(gdbPath(config.executable))}`);
            }
        } finally {
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    }
    /** @returns {Promise<{firmware: "none" | "programmed", downloadClockKhz?: number, speedFallback?: boolean}>} */
    async download(executableStamp = undefined) {
        const { config } = this.session;
        if (config.attach) return { firmware: "none" };
        return config.__emberprobeFlashBounds
            ? this.checkedDownload(executableStamp)
            : this.downloadPrepared(config.loadFiles);
    }
    /** @returns {Promise<{firmware: "none" | "programmed", downloadClockKhz?: number, speedFallback?: boolean}>} */
    async downloadPrepared(images = undefined) {
        const { mi } = this.session;
        if (images === undefined) {
            const clockKhz = await this.raiseDownloadClock();
            let speedFallback = false;
            let clockRestored = false;
            let remoteDisconnected = false;
            try {
                await mi.command("-target-download", 60000);
                // A write at the raised clock is checked once by CRC, as the sidebar's verify_image does.
                if (clockKhz && (await this.compareSections()) !== "matched")
                    throw new Error("Firmware written at the raised clock does not match the image");
            } catch (error) {
                if (isRemoteDisconnectedError(error)) {
                    remoteDisconnected = true;
                    throw error;
                }
                if (!clockKhz || mi.closed) throw error;
                speedFallback = true;
                try {
                    await this.restoreDownloadClock();
                    clockRestored = true;
                } catch (restoreError) {
                    if (isRemoteDisconnectedError(restoreError)) {
                        remoteDisconnected = true;
                        throw error;
                    }
                    throw restoreError;
                }
                await mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
                await mi.command("-target-download", 60000);
            } finally {
                if (clockKhz && !clockRestored && !remoteDisconnected && !mi.closed) await this.restoreDownloadClock();
            }
            return {
                firmware: "programmed",
                ...(clockKhz ? { downloadClockKhz: clockKhz, speedFallback } : {})
            };
        }
        for (const image of images) {
            const binary = image.format === "bin";
            if (binary) await mi.command("-gdb-set gnutarget binary");
            try {
                const command = `load ${quote(gdbPath(image.file))}${binary ? ` ${image.address}` : image.offset ? ` ${image.offset}` : ""}`;
                await mi.command(`-interpreter-exec console ${quote(command)}`, 60000);
            } finally {
                if (binary && !mi.closed) await mi.command("-gdb-set gnutarget auto");
            }
        }
        // GDB load can alter its symbol tables; restore the configured identities before breakpoints.
        if (images.length) await this.symbols();
        return { firmware: images.length ? "programmed" : "none" };
    }
}

module.exports = { normalizeDebugImages, symbolImages, DebugImages, HOOKS, address };
