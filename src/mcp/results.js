"use strict";
// Converts Bridge results and errors into MCP tool results. On failure structuredContent has the same shape as the
// diagnostic skill scripts write to stderr, produced by the same diagnosticForError; suggested actions are rendered as
// tool names for the MCP channel.
const { diagnosticForError } = require("../../skills/_emberprobe/agent-client");
const { toolForMethod } = require("./tools");

const MAX_TEXT = 60000;

function text(value) {
    const json = JSON.stringify(value);
    if (json.length <= MAX_TEXT) return json;
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

module.exports = { success, failure, rejected, structured, MAX_TEXT };
