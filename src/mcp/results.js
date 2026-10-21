"use strict";
// 把 Bridge 结果与错误转换成 MCP 工具结果。失败时 structuredContent 与 skill 脚本写到 stderr 的
// diagnostic 同形，由同一个 diagnosticForError 生成；建议动作按 MCP 通道渲染成工具名。
const { diagnosticForError } = require("../../skills/_emberprobe/agent-client");
const { toolForMethod } = require("./tools");

const MAX_TEXT = 60000;

function text(value) {
    const json = JSON.stringify(value);
    if (json.length <= MAX_TEXT) return json;
    return `${json.slice(0, MAX_TEXT)}… [truncated ${json.length - MAX_TEXT} characters; read structuredContent for the full result]`;
}

// structuredContent 必须是对象；数组或标量结果包一层 result。
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

// 已有业务含义的失败（如预检未就绪）原样返回，并标记为错误。
function rejected(value) {
    const content = structured(value);
    return { isError: true, content: [{ type: "text", text: text(content) }], structuredContent: content };
}

module.exports = { success, failure, rejected, structured, MAX_TEXT };
