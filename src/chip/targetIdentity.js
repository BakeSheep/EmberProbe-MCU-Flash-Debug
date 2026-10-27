"use strict";
const {
    CPUID_ADDR,
    CORTEX_M_PARTS,
    DEV_ID_FAMILY,
    STM32_SERIES_CORES,
    idcodeBaseForTarget,
    uidBaseForTarget,
    seriesFromTarget
} = require("./rules");

// Automatic probe selection follows the target chip, not the probe. Every operation in automatic mode reads the
// chip's identity right after OpenOCD's init, in its own session, and stops OpenOCD before the operation's first
// command when it differs from the chip recorded for the workspace. The reads take a few milliseconds and never
// halt, reset or write the target.
const FIELDS = ["cpuid", "idcode", "uid"];
const HEX = { cpuid: /^[0-9A-F]{8}$/, idcode: /^[0-9A-F]{8}$/, uid: /^[0-9A-F]{24}$/ };
const TARGET_ID_LINE = /^\s*EP_TARGET_ID((?:\s+\w+=[0-9A-Fa-f]*)*)\s*$/;
const MISMATCH_LINE = /^\s*EP_TARGET_MISMATCH (cpuid|idcode|uid)\s*$/;

/** @returns {{cpuid: string, idcode: string, uid: string} | null} */
function normalizeTargetIdentity(value) {
    if (!value || typeof value !== "object") return null;
    const identity = { cpuid: "", idcode: "", uid: "" };
    for (const field of FIELDS) {
        const text = typeof value[field] === "string" ? value[field].toUpperCase() : "";
        if (text && !HEX[field].test(text)) return null;
        identity[field] = text;
    }
    return identity.cpuid || identity.idcode || identity.uid ? identity : null;
}

// The part of each field that names the chip. Silicon revisions of one model differ in CPUID's variant and
// revision nibbles and in DBGMCU IDCODE's REV_ID (bits 31:16), so only the implementer, architecture and part
// number, the DEV_ID (bits 11:0) and the whole UID are compared.
const FIELD_MASKS = { cpuid: 0xff0ffff0, idcode: 0x00000fff };

function fieldKey(field, text) {
    if (!text || !FIELD_MASKS[field]) return text;
    return ((parseInt(text, 16) & FIELD_MASKS[field]) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function identityReads(target) {
    return [
        ["cpuid", CPUID_ADDR, 1],
        ["idcode", idcodeBaseForTarget(target), 1],
        ["uid", uidBaseForTarget(target), 3]
    ].filter(([, address]) => address);
}

// One OpenOCD command for a running session: prints EP_TARGET_ID and, with an expected identity, ends OpenOCD
// with an error status at the first field that was read and differs. An unreadable field is not a mismatch.
function targetCheckCommand(target, expected = null) {
    const known = normalizeTargetIdentity(expected);
    const reads = identityReads(target);
    const word =
        "proc _ep_target_word {address count} { " +
        "if {[catch {read_memory $address 32 $count} words]} { " +
        "if {[catch {mem2array _ep_words 32 $address $count}]} { return {} }; set words {}; " +
        "for {set i 0} {$i < $count} {incr i} { lappend words $_ep_words($i) } }; " +
        "set text {}; foreach value $words { append text [format %08X $value] }; return $text }; " +
        "proc _ep_target_key {field text} { " +
        Object.entries(FIELD_MASKS)
            .map(
                ([field, mask]) =>
                    `if {$field eq "${field}"} { return [format %08X [expr {[scan $text %x] & 0x${mask.toString(16)}}]] }; `
            )
            .join("") +
        "return $text }; ";
    const read = reads
        .map(([field, address, count]) => `${field} [_ep_target_word 0x${address.toString(16)} ${count}]`)
        .join(" ");
    const echo = reads.map(([field]) => `${field}=[dict get $_ep_target_id ${field}]`).join(" ");
    const expectedPairs = known
        ? reads.filter(([field]) => known[field]).map(([field]) => `${field} ${fieldKey(field, known[field])}`)
        : [];
    const check = expectedPairs.length
        ? `; foreach {_ep_field _ep_value} {${expectedPairs.join(" ")}} { ` +
          "set _ep_read [dict get $_ep_target_id $_ep_field]; " +
          'if {$_ep_read ne ""} { if {[_ep_target_key $_ep_field $_ep_read] ne $_ep_value} { ' +
          'echo "EP_TARGET_MISMATCH $_ep_field"; shutdown error } } }'
        : "";
    return `${word}set _ep_target_id [list ${read}]; echo "EP_TARGET_ID ${echo}"${check}`;
}

function parseTargetIdentityLine(line) {
    const match = String(line).match(TARGET_ID_LINE);
    if (!match) return null;
    const values = Object.fromEntries(
        [...match[1].matchAll(/(\w+)=([0-9A-Fa-f]*)/g)].map(([, field, value]) => [field, value])
    );
    return normalizeTargetIdentity(values);
}

// Inserts the check right after the operation's init, or starts with init when the operation's own command
// (for example `program`) would initialize later. Commands before init stay in place.
function withTargetCheck(commands, targetCheck, target) {
    if (!targetCheck) return commands;
    const check = targetCheckCommand(target, targetCheck.expected);
    const index = commands.indexOf("init");
    return index < 0
        ? ["init", check, ...commands]
        : [...commands.slice(0, index + 1), check, ...commands.slice(index + 1)];
}

function hexValue(text) {
    return text ? parseInt(text, 16) >>> 0 : null;
}

function targetSeries(identity) {
    const idcode = hexValue(identity?.idcode);
    return idcode === null ? "" : DEV_ID_FAMILY[idcode & 0xfff] || "";
}

function targetCore(identity) {
    const cpuid = hexValue(identity?.cpuid);
    return cpuid === null ? "" : CORTEX_M_PARTS[(cpuid >>> 4) & 0xfff] || "";
}

// "STM32F4x · Cortex-M4 · UID …53534C32": enough to tell two boards of one model apart.
function describeTargetIdentity(identity) {
    const known = normalizeTargetIdentity(identity);
    if (!known) return "";
    const idcode = hexValue(known.idcode);
    const model = targetSeries(known) || (idcode === null ? "" : `DEV_ID 0x${(idcode & 0xfff).toString(16)}`);
    return [model, targetCore(known), known.uid ? `UID …${known.uid.slice(-8)}` : ""].filter(Boolean).join(" · ");
}

// "Cortex-M4": the core alone, as a probe's card shows it.
function describeTargetCore(identity) {
    return targetCore(normalizeTargetIdentity(identity));
}

// Two readings are the same chip when every field read both times agrees, revision bits aside, and at least one
// was compared.
function sameTarget(a, b) {
    const left = normalizeTargetIdentity(a);
    const right = normalizeTargetIdentity(b);
    if (!left || !right) return false;
    const compared = FIELDS.filter((field) => left[field] && right[field]);
    return (
        compared.length > 0 && compared.every((field) => fieldKey(field, left[field]) === fieldKey(field, right[field]))
    );
}

// Whether a chip is of the STM32 series the target configuration names: true, false, or null when unknown.
function targetMatchesModel(identity, target) {
    const named = seriesFromTarget(target).toUpperCase();
    const series = Object.keys(STM32_SERIES_CORES).find((name) => name.toUpperCase() === named);
    if (!series) return null;
    const found = targetSeries(identity);
    if (found) return found === series;
    const core = targetCore(identity);
    return core ? STM32_SERIES_CORES[series].includes(core) : null;
}

function targetMismatchError(targetCheck, observed, field) {
    const expected = normalizeTargetIdentity(targetCheck?.expected);
    const params = {
        expected: describeTargetIdentity(expected) || "-",
        actual: describeTargetIdentity(observed) || "-"
    };
    return Object.assign(
        new Error(
            `The target chip differs from the one automatic mode recorded (${params.expected} → ${params.actual})`
        ),
        {
            code: "PROBE_TARGET_MISMATCH",
            category: "user_decision",
            retryable: false,
            i18nKey: "probe.targetMismatch",
            i18nParams: params,
            details: {
                checkId: targetCheck?.checkId || "",
                target: targetCheck?.target || "",
                field,
                expected,
                observed: normalizeTargetIdentity(observed)
            }
        }
    );
}

// The identity each check observed, by check id, for recording after the operation succeeds. Sessions that
// run in a Worker forward their observation to the extension host's copy of this registry.
const observations = new Map();
const MAX_OBSERVATIONS = 32;
const mismatchListeners = new Set();

function reportTargetIdentity(checkId, identity) {
    const known = normalizeTargetIdentity(identity);
    if (!checkId || !known) return;
    observations.delete(checkId);
    observations.set(checkId, known);
    if (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value);
}

function observedTargetIdentity(checkId) {
    return (checkId && observations.get(checkId)) || null;
}

function onTargetMismatch(listener) {
    mismatchListeners.add(listener);
    return () => mismatchListeners.delete(listener);
}

function reportTargetMismatch(error) {
    if (error?.code !== "PROBE_TARGET_MISMATCH") return;
    for (const listener of mismatchListeners) {
        try {
            listener(error);
        } catch {
            // A failed notification must not replace the operation's own error.
        }
    }
}

// Follows one OpenOCD session's output: records the identity it printed and builds the mismatch error.
function targetCheckMonitor(targetCheck) {
    let observed = null;
    let field = "";
    let failure = null;
    return {
        line(text) {
            const identity = parseTargetIdentityLine(text);
            if (identity) {
                observed = identity;
                reportTargetIdentity(targetCheck?.checkId, identity);
                return true;
            }
            const mismatch = String(text).match(MISMATCH_LINE);
            if (mismatch) field = mismatch[1];
            return !!mismatch;
        },
        get observed() {
            return observed;
        },
        get mismatched() {
            return !!field;
        },
        error() {
            if (failure || !targetCheck || !field) return failure;
            failure = targetMismatchError(targetCheck, observed, field);
            reportTargetMismatch(failure);
            return failure;
        }
    };
}

module.exports = {
    normalizeTargetIdentity,
    targetCheckCommand,
    parseTargetIdentityLine,
    withTargetCheck,
    describeTargetIdentity,
    describeTargetCore,
    sameTarget,
    targetMatchesModel,
    targetMismatchError,
    reportTargetIdentity,
    observedTargetIdentity,
    onTargetMismatch,
    reportTargetMismatch,
    targetCheckMonitor
};
