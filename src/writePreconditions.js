"use strict";

// Coalesce contiguous or overlapping descriptors so adjacent struct/container control words share one read.
function preconditionSpans(checks) {
    const spans = [];
    for (const check of [...checks].sort((a, b) => a.address - b.address || a.bytes.length - b.bytes.length)) {
        const last = spans[spans.length - 1];
        if (!last || check.address > last.address + last.bytes.length) {
            spans.push({ address: check.address, bytes: Array.from(check.bytes) });
            continue;
        }
        const offset = check.address - last.address;
        for (let i = 0; i < check.bytes.length; i++) {
            if (offset + i < last.bytes.length) {
                if (last.bytes[offset + i] !== check.bytes[i])
                    throw Object.assign(new Error("Inconsistent dynamic write descriptors"), {
                        code: "INVALID_WRITE_PLAN"
                    });
            } else {
                last.bytes.push(check.bytes[i]);
            }
        }
    }
    return spans;
}

// Serializable descriptor snapshots cross the sampling Worker boundary. These checks
// detect relocation; they do not hold firmware objects alive or prevent ABA reuse.
function validateWritePreconditions(checks, writes) {
    if (!Array.isArray(checks) || checks.length > 32)
        throw Object.assign(new Error("Invalid dynamic write preconditions"), { code: "INVALID_WRITE_PLAN" });
    for (const check of checks) {
        if (
            !Number.isSafeInteger(check.address) ||
            check.address <= 0 ||
            !Array.isArray(check.bytes) ||
            !check.bytes.length ||
            check.address + check.bytes.length > 0x100000000 ||
            check.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
        )
            throw Object.assign(new Error("Invalid dynamic write descriptor"), { code: "INVALID_WRITE_PLAN" });
        if (
            writes.some(
                (item) =>
                    check.address < item.address + item.bytes.length &&
                    item.address < check.address + check.bytes.length
            )
        )
            throw Object.assign(new Error("A write overlaps its own address descriptor"), {
                code: "WRITE_NOT_ALLOWED"
            });
    }
    const spans = preconditionSpans(checks);
    const bytes = spans.reduce((sum, span) => sum + span.bytes.length, 0);
    // Reserve an extra descriptor check per item for a narrow-write read-back mismatch.
    if (spans.length * (2 * writes.length + 2) > 32 || bytes * (2 * writes.length + 2) > 4096)
        throw Object.assign(new Error("Dynamic write verification exceeds 4096 bytes / 32 reads"), {
            code: "LIVE_WRITE_BUDGET_EXCEEDED"
        });
}

async function verifyWritePreconditions(checks, read, writtenItems = 0) {
    for (const check of preconditionSpans(checks)) {
        let actual;
        try {
            actual = await read(check.address, check.bytes.length);
        } catch (error) {
            error.retryable = false;
            error.details = { ...error.details, written: writtenItems > 0, writtenItems, verified: false };
            throw error;
        }
        if (!actual || actual.length !== check.bytes.length || !check.bytes.every((byte, i) => byte === actual[i]))
            throw Object.assign(new Error("Dynamic write target changed; resolve the path again before retrying"), {
                code: "WRITE_TARGET_CHANGED",
                retryable: false,
                details: { written: writtenItems > 0, writtenItems, verified: false }
            });
    }
}

module.exports = { preconditionSpans, validateWritePreconditions, verifyWritePreconditions };
