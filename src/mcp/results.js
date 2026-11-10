"use strict";
// Converts Bridge results and errors into MCP tool results. On failure structuredContent has the same shape as the
// diagnostic skill scripts write to stderr, produced by the same diagnosticForError; suggested actions are rendered as
// tool names for the MCP channel.
const { diagnosticForError } = require("../../skills/_emberprobe/agent-client");
const { toolForMethod } = require("./tools");

const MAX_TEXT = 60000;

// Copy of value with every array cut to its first `items` entries and every string to `chars` characters;
// each cut is marked with what was left out.
function shorten(value, items, chars) {
    if (typeof value === "string")
        return value.length > chars ? `${value.slice(0, chars)}… [${value.length - chars} more characters]` : value;
    if (Array.isArray(value)) {
        const kept = value.slice(0, items).map((item) => shorten(item, items, chars));
        if (value.length > items) kept.push(`… ${value.length - items} more items`);
        return kept;
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item, items, chars)]));
}

// Most clients hand the model only this text, so an oversized result is shortened into valid JSON (arrays
// and strings tightened step by step) instead of being cut mid-value. structuredContent keeps the full result.
function text(value) {
    const json = JSON.stringify(value);
    if (json.length <= MAX_TEXT) return json;
    const note = `Shortened from ${json.length} characters: entries marked … were left out. structuredContent holds the full result; narrow the request to see the rest here.`;
    for (let items = 256, chars = 4096; items >= 1; items >>= 1, chars = Math.max(64, chars >> 1)) {
        const shortened = JSON.stringify({ textTruncated: note, ...shorten(value, items, chars) });
        if (shortened.length <= MAX_TEXT) return shortened;
    }
    return `${json.slice(0, MAX_TEXT)}… [truncated ${json.length - MAX_TEXT} characters; read structuredContent for the full result]`;
}

// structuredContent must be an object; array or scalar results are wrapped in result.
function structured(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
}

function success(value) {
    const content = structured(value);
    return { content: [{ type: "text", text: text(content) }], structuredContent: content };
}

function failure(error, operation) {
    const diagnostic = diagnosticForError(error, { operation, render: { channel: "mcp", method: toolForMethod } });
    return { isError: true, content: [{ type: "text", text: text(diagnostic) }], structuredContent: diagnostic };
}

// Failures with a domain meaning (such as an unready preflight) are returned as is and marked as errors.
function rejected(value) {
    const content = structured(value);
    return { isError: true, content: [{ type: "text", text: text(content) }], structuredContent: content };
}

module.exports = { success, failure, rejected, structured, text, MAX_TEXT };
