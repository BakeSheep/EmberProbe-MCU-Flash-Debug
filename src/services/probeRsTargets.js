"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const runProbeRsList = promisify(execFile);
const MAX_TARGET_LIST_BYTES = 2 * 1024 * 1024;

function parseProbeRsChipList(output) {
    const text = String(output || "");
    if (Buffer.byteLength(text, "utf8") > MAX_TARGET_LIST_BYTES)
        throw new Error("probe-rs target list exceeds the byte budget");
    const targets = new Map();
    let family = "";
    let variantIndent = -1;
    for (const line of text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
        const value = line.trim();
        if (!value) continue;
        const indent = line.length - line.trimStart().length;
        if (!indent) {
            family = value === "Available chips:" ? "" : value;
            variantIndent = -1;
        } else if (value === "Variants:" && family) {
            variantIndent = indent;
        } else if (variantIndent >= 0 && indent > variantIndent && /^[A-Za-z0-9_.+-]+$/.test(value)) {
            const key = value.toLowerCase();
            if (!targets.has(key)) targets.set(key, { label: value, description: family });
        }
    }
    return [...targets.values()].sort((left, right) => left.label.localeCompare(right.label, "en"));
}

async function listProbeRsTargets(executable, options = {}) {
    try {
        if (!String(executable || "").trim()) throw new Error("Select the probe-rs executable first");
        const { stdout } = await (options.run || runProbeRsList)(executable, ["chip", "list"], {
            windowsHide: true,
            timeout: 10000,
            maxBuffer: MAX_TARGET_LIST_BYTES,
            encoding: "utf8"
        });
        const targets = parseProbeRsChipList(stdout);
        if (!targets.length) throw new Error("probe-rs chip list returned no MCU targets");
        return targets;
    } catch (error) {
        const message = String(error.message || error).slice(0, 2000);
        throw Object.assign(new Error(message), {
            code: "PROBE_RS_TARGET_LIST_FAILED",
            i18nKey: "pr.targetsFailed",
            i18nParams: { error: message }
        });
    }
}

module.exports = { parseProbeRsChipList, listProbeRsTargets, MAX_TARGET_LIST_BYTES };
