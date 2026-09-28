"use strict";
const fs = require("fs/promises");
const crypto = require("crypto");
const { canonicalFile } = require("./file-identity");

const MAX_ELF_BYTES = 64 * 1024 * 1024;
function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

// Bounded reads use one open handle. Neither stat nor a concurrent build can bypass
// the byte budget. The optional destination is exclusively created by our caller.
async function inspectElf(file, options = {}) {
    const resolved = await canonicalFile(String(file || ""));
    const handle = await fs.open(resolved, "r");
    let output;
    try {
        const before = await handle.stat();
        if (!before.isFile()) throw failure("ELF_FILE_INVALID", "ELF must be a regular file");
        if (before.size > MAX_ELF_BYTES) throw failure("ELF_TOO_LARGE", "ELF exceeds the 64 MiB limit");
        if (options.snapshot) output = await fs.open(options.snapshot, "wx", 0o600);
        const digest = crypto.createHash("sha256");
        const header = Buffer.alloc(52);
        let size = 0;
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            if (options.signal?.aborted) throw failure("ELF_READ_CANCELLED", "ELF read cancelled");
            if (size + bytesRead > MAX_ELF_BYTES) throw failure("ELF_TOO_LARGE", "ELF exceeds the 64 MiB limit");
            if (size < header.length) buffer.copy(header, size, 0, Math.min(bytesRead, header.length - size));
            const chunk = buffer.subarray(0, bytesRead);
            digest.update(chunk);
            if (output) await output.writeFile(chunk);
            size += bytesRead;
        }
        if (size < 52 || header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 1 || header[5] !== 1 || header[6] !== 1)
            throw failure("ELF_FILE_INVALID", "Expected an ELF32 little-endian firmware");
        const after = await handle.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            throw failure("ELF_CHANGED_DURING_FLASH_CONFIRMATION", "ELF changed while being read");
        return { path: resolved, sha256: digest.digest("hex"), size, mtimeMs: before.mtimeMs };
    } finally {
        try {
            if (output) await output.close();
        } finally {
            await handle.close();
        }
    }
}

module.exports = { MAX_ELF_BYTES, inspectElf };
