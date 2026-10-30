"use strict";
// Bridge confirmation response -> MCP elicitation. Offers only the Bridge's choices plus deny, defaulting to deny; the
// confirmation ID stays inside the server and is never returned to the agent. Clients without elicitation fall back to
// chat confirmation: the plan and confirmation ID are returned for the agent to show the user and call again after the
// answer.

// Plan fields as the Bridge returns them: flash plans, write plans (elf/connection), peripheral plans (svd)
// and CubeMX plans (ioc/output/tool). File identities are { path, sha256 } objects.
const PLAN_FIELDS = [
    ["elf", "ELF"],
    ["elfSha256", "ELF SHA-256"],
    ["target", "Target"],
    ["probe", "Probe"],
    ["probeSerial", "Probe serial"],
    ["transport", "Transport"],
    ["adapterSpeedKhz", "Adapter speed (kHz)"],
    ["openocd", "OpenOCD"],
    ["connection", "Connection"],
    ["svd", "SVD"],
    ["project", "CubeMX project"],
    ["output", "CubeMX project"],
    ["ioc", "CubeMX .ioc"],
    ["iocPath", "CubeMX .ioc"],
    ["candidatePath", "Candidate .ioc"],
    ["tool", "STM32CubeMX"]
];
// Write plans list their targets under `items`; CubeMX plans under `changes`.
const ITEM_LISTS = [
    ["items", "Writes"],
    ["values", "Values"],
    ["writes", "Writes"],
    ["changes", "Changes"]
];
const MAX_ITEMS = 16;
const MAX_VALUE = 200;

function clip(text) {
    return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

function valueText(value) {
    if (value === null) return "(unset)";
    return clip(typeof value === "object" ? JSON.stringify(value) : String(value));
}

function fieldText(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "object") return clip(String(value));
    if (typeof value.path === "string") return clip(value.path);
    if (typeof value.executable === "string")
        return clip(value.version ? `${value.executable} (${value.version})` : value.executable);
    if (value.kind === "dap") return `debugger session ${value.sessionId || "(unknown)"}`;
    if (value.kind === "openocd")
        return clip(
            [value.target, value.probe && `via ${value.probe}`, value.probeSerial && `serial ${value.probeSerial}`]
                .filter(Boolean)
                .join(" ")
        );
    return valueText(value);
}

const first = (...values) => values.find((value) => value !== undefined);

function itemLine(item) {
    if (!item || typeof item !== "object") return valueText(item);
    const name = item.register || item.name || item.target || item.key || item.path || "";
    const address = item.address ? ` @ ${item.address}` : "";
    const type = typeof item.type === "string" && item.type ? ` (${item.type})` : "";
    const from = first(item.current, item.currentValue, item.before, item.previous);
    const to =
        item.action === "deleted"
            ? "(deleted)"
            : valueText(first(item.value, item.newValue, item.after, item.written, item.requested));
    // A peripheral write names the register; the fields the user asked for follow it.
    const requested = Array.isArray(item.requested)
        ? ` [${item.requested.map((entry) => `${entry.target} = ${entry.value}`).join(", ")}]`
        : "";
    return `${name}${address}${type}: ${from !== undefined ? `${valueText(from)} → ${to}` : to}${clip(requested)}`;
}

function summary(result) {
    const lines = [String(result.question || "Approve this EmberProbe operation?")];
    for (const [key, label] of PLAN_FIELDS) {
        const value = result[key] ?? result.plan?.[key];
        const text = fieldText(value);
        if (text) lines.push(`${label}: ${text}`);
        // A file identity carries its digest unless the plan also reports it as its own field.
        const digest = value && typeof value === "object" && typeof value.sha256 === "string" ? value.sha256 : "";
        if (digest && !(result[`${key}Sha256`] ?? result.plan?.[`${key}Sha256`]))
            lines.push(`${label} SHA-256: ${digest}`);
    }
    for (const [key, label] of ITEM_LISTS) {
        const items = result[key] ?? result.plan?.[key];
        if (!Array.isArray(items) || !items.length) continue;
        lines.push(`${label}:`);
        const shown = items.slice(0, MAX_ITEMS);
        for (const item of shown) lines.push(`  - ${itemLine(item)}`);
        const reported = key === "changes" ? result.changesSummary?.total : undefined;
        const total = Number.isInteger(reported) && reported > items.length ? reported : items.length;
        if (total > shown.length) lines.push(`  … ${total - shown.length} more`);
        if (key === "changes" && result.changesSummary?.truncated && result.changesSummary.diffPath)
            lines.push(`  Full diff: ${result.changesSummary.diffPath}`);
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
 * Asks the user to confirm. Returns { confirmationId, remember } for the repeated call; throws CONFIRMATION_DENIED on
 * deny, cancel or close.
 * @param {{ elicitInput: Function }} server
 * @param {Record<string, any>} result the Bridge's confirmationRequired response
 */
async function elicit(server, result, options) {
    const answer = await server.elicitInput(elicitationRequest(result), options);
    const decision = answer?.action === "accept" ? answer.content?.decision : "deny";
    if (!choicesOf(result).includes(decision)) throw denied();
    return { confirmationId: result.confirmationId, ...(decision === "workspace" ? { remember: true } : {}) };
}

// Clients without elicitation: return the plan and confirmation ID, stating that the agent must get an explicit answer
// from the user first.
function pending(result, extra = {}) {
    return {
        ...result,
        ...extra,
        nextStep:
            "Show this plan to the user and wait for an explicit answer. Only after approval, call the same tool again with the same arguments plus confirmationId (and remember: true only if the user chose the workspace option). If the user declines, stop."
    };
}

module.exports = { elicit, elicitationRequest, pending, summary, choicesOf, withoutConfirmationId, denied };
