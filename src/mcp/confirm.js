"use strict";
// Bridge 确认响应 → MCP elicitation。只提供 Bridge 给出的 choices 加 deny，默认 deny；
// 确认 ID 只在服务器内部使用，不返回给 agent。客户端不支持 elicitation 时退回聊天确认：
// 返回计划与确认 ID，由 agent 展示给用户并等待回答后重调。

const PLAN_FIELDS = [
    ["elf", "ELF"],
    ["elfSha256", "ELF SHA-256"],
    ["target", "Target"],
    ["probe", "Probe"],
    ["probeSerial", "Probe serial"],
    ["transport", "Transport"],
    ["adapterSpeedKhz", "Adapter speed (kHz)"],
    ["openocd", "OpenOCD"],
    ["project", "CubeMX project"],
    ["iocPath", "CubeMX .ioc"],
    ["candidatePath", "Candidate .ioc"],
    ["svd", "SVD"]
];
const MAX_ITEMS = 16;

function itemLine(item) {
    if (!item || typeof item !== "object") return String(item);
    const name = item.name || item.target || item.path || item.register || "";
    const address = item.address ? ` @ ${item.address}` : "";
    const from = item.current ?? item.currentValue ?? item.before;
    const to = item.value ?? item.newValue ?? item.after;
    const change = from !== undefined ? `${from} → ${to}` : `${to}`;
    return `${name}${address}: ${change}`;
}

function summary(result) {
    const lines = [String(result.question || "Approve this EmberProbe operation?")];
    for (const [key, label] of PLAN_FIELDS) {
        const value = result[key] ?? result.plan?.[key];
        if (value !== undefined && value !== null && value !== "") lines.push(`${label}: ${value}`);
    }
    for (const key of ["values", "writes", "changes"]) {
        const items = result[key] ?? result.plan?.[key];
        if (!Array.isArray(items) || !items.length) continue;
        lines.push(`${key[0].toUpperCase()}${key.slice(1)}:`);
        for (const item of items.slice(0, MAX_ITEMS)) lines.push(`  - ${itemLine(item)}`);
        if (items.length > MAX_ITEMS) lines.push(`  … ${items.length - MAX_ITEMS} more`);
    }
    if (result.expiresAt) lines.push(`Expires: ${result.expiresAt}`);
    return lines.join("\n");
}

function choicesOf(result) {
    const choices = Array.isArray(result.choices)
        ? result.choices.filter((item) => item === "once" || item === "workspace")
        : [];
    return choices.length ? choices : ["once"];
}

const LABELS = {
    once: "Approve once",
    workspace: "Approve and remember for this workspace (24 hours)",
    deny: "Deny"
};

function elicitationRequest(result) {
    const decisions = [...choicesOf(result), "deny"];
    return {
        mode: "form",
        message: summary(result),
        requestedSchema: {
            type: "object",
            properties: {
                decision: {
                    type: "string",
                    title: "Decision",
                    enum: decisions,
                    enumNames: decisions.map((item) => LABELS[item]),
                    default: "deny"
                }
            },
            required: ["decision"]
        }
    };
}

function withoutConfirmationId(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const { confirmationId: _confirmationId, ...rest } = result;
    return rest;
}

function denied() {
    return Object.assign(new Error("The user did not approve this operation"), {
        code: "CONFIRMATION_DENIED",
        category: "user_decision",
        likelyCause: "The user declined or dismissed the confirmation.",
        retryable: false,
        suggestedActions: ["The operation ended. Do not retry or substitute another tool unless the user asks again."]
    });
}

/**
 * 请求用户确认。返回 { confirmationId, remember } 用于重调；拒绝、取消或关闭时抛出 CONFIRMATION_DENIED。
 * @param {{ elicitInput: Function }} server
 * @param {Record<string, any>} result Bridge 的 confirmationRequired 响应
 */
async function elicit(server, result, options) {
    const answer = await server.elicitInput(elicitationRequest(result), options);
    const decision = answer?.action === "accept" ? answer.content?.decision : "deny";
    if (!choicesOf(result).includes(decision)) throw denied();
    return { confirmationId: result.confirmationId, ...(decision === "workspace" ? { remember: true } : {}) };
}

// 不支持 elicitation 的客户端：返回计划和确认 ID，并写明 agent 必须先得到用户的明确回答。
function pending(result, extra = {}) {
    return {
        ...result,
        ...extra,
        nextStep:
            "Show this plan to the user and wait for an explicit answer. Only after approval, call the same tool again with the same arguments plus confirmationId (and remember: true only if the user chose the workspace option). If the user declines, stop."
    };
}

module.exports = { elicit, elicitationRequest, pending, summary, choicesOf, withoutConfirmationId, denied };
