"use strict";
const os = require("os");

function redact(value) {
    let text = value.slice(0, 8000);
    const home = os.homedir();
    for (const prefix of [home, home.replace(/\\/g, "/")]) {
        if (prefix.length > 3) text = text.split(prefix).join("<home>");
    }
    return text.replace(/\b(token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
}

const FIELDS = [
    "code",
    "category",
    "stage",
    "likelyCause",
    "suggestedActions",
    "retryable",
    "details",
    "i18nKey",
    "i18nParams"
];

// Plain bounded data survives worker structured cloning; Error custom fields do not.
function boundedData(value, depth = 0) {
    if (depth > 6 || value === undefined || typeof value === "function") return undefined;
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundedData(entry, depth + 1));
    if (typeof value !== "object") return undefined;
    return Object.fromEntries(
        Object.entries(value)
            .slice(0, 100)
            .filter(([key]) => !/token|password|secret|authorization|environment/i.test(key))
            .map(([key, entry]) => [key, boundedData(entry, depth + 1)])
    );
}

function serializeError(error) {
    const result = { message: redact(String(error?.message || error || "Unknown error")) };
    for (const field of FIELDS) {
        if (error?.[field] !== undefined) result[field] = boundedData(error[field]);
    }
    return result;
}

function deserializeError(value) {
    return Object.assign(new Error(value?.message || "Unknown error"), serializeError(value));
}

module.exports = { serializeError, deserializeError };
