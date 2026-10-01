"use strict";

const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

const SIMPLE_ACTIONS = new Map([
    ["--status", ["debug.status", null]],
    ["--select", ["debug.select", null]],
    ["--start", ["debug.start", null]],
    ["--pause", ["debug.control", "pause"]],
    ["--continue", ["debug.control", "continue"]],
    ["--step-over", ["debug.control", "stepOver"]],
    ["--step-in", ["debug.control", "stepIn"]],
    ["--step-out", ["debug.control", "stepOut"]],
    ["--restart", ["debug.control", "restart"]],
    ["--stop", ["debug.control", "stop"]],
    ["--breakpoints", ["debug.breakpoints.list", null]]
]);
const BREAKPOINT_ACTIONS = new Map([
    ["--add-breakpoint", "add"],
    ["--remove-breakpoint", "remove"],
    ["--enable-breakpoint", "enable"],
    ["--disable-breakpoint", "disable"]
]);
const VALUE_OPTIONS = new Set([
    "--workspace",
    "--thread",
    "--session",
    "--group",
    "--core",
    "--source",
    "--line",
    "--column",
    "--function",
    "--condition",
    "--hit-condition",
    "--log-message"
]);

function args(argv) {
    const out = { actions: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (SIMPLE_ACTIONS.has(key)) out.actions.push({ kind: "simple", key });
        else if (BREAKPOINT_ACTIONS.has(key)) out.actions.push({ kind: "breakpoint", key });
        else if (VALUE_OPTIONS.has(key)) {
            if (!argv[index + 1]) throw new Error(`Missing value for ${key}`);
            out[key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = argv[++index];
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (out.actions.length !== 1) throw new Error("Choose exactly one debug or breakpoint action");
    validateThreadOption(out, out.actions[0]);
    validateSelection(out, out.actions[0]);
    return out;
}

function validateThreadOption(opt, selected) {
    if (opt.thread === undefined) return;
    const supportsThread = selected.kind === "simple" && SIMPLE_ACTIONS.get(selected.key)?.[0] === "debug.control";
    if (!supportsThread) throw new Error("--thread can only be used with debug control actions");
    if (!Number.isInteger(Number(opt.thread)) || Number(opt.thread) < 1)
        throw new Error("--thread must be a positive integer");
}

function validateSelection(opt, selected) {
    const hasSelection = opt.session !== undefined || opt.group !== undefined || opt.core !== undefined;
    if (selected.key !== "--select") {
        if (hasSelection) throw new Error("--session, --group and --core require --select");
        return;
    }
    if (!opt.session && !opt.group) throw new Error("--select requires --session or --group");
    if (opt.core !== undefined && (!Number.isInteger(Number(opt.core)) || Number(opt.core) < 0))
        throw new Error("--core must be a zero-based integer");
}

function request(opt) {
    const selected = opt.actions[0];
    validateThreadOption(opt, selected);
    validateSelection(opt, selected);
    if (selected.kind === "simple") {
        const [method, action] = SIMPLE_ACTIONS.get(selected.key);
        return {
            method,
            params:
                method === "debug.select"
                    ? {
                          sessionId: opt.session,
                          serverGroup: opt.group,
                          targetProcessor: opt.core === undefined ? undefined : Number(opt.core)
                      }
                    : action
                      ? { action, threadId: opt.thread === undefined ? undefined : Number(opt.thread) }
                      : {}
        };
    }
    const action = BREAKPOINT_ACTIONS.get(selected.key);
    const hasSource = !!opt.source;
    const hasFunction = !!opt.function;
    if (hasSource === hasFunction) throw new Error("Choose either --source with --line, or --function");
    if (hasSource && opt.line === undefined) throw new Error("--source requires --line");
    return {
        method: "debug.breakpoints.update",
        params: {
            action,
            type: hasSource ? "source" : "function",
            file: opt.source,
            line: opt.line === undefined ? undefined : Number(opt.line),
            column: opt.column === undefined ? undefined : Number(opt.column),
            function: opt.function,
            condition: opt.condition,
            hitCondition: opt.hitCondition,
            logMessage: opt.logMessage
        }
    };
}

async function main() {
    const opt = args(process.argv.slice(2));
    const operation = request(opt);
    const result = await call(opt.workspace || process.cwd(), operation.method, operation.params);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module)
    main().catch((error) => {
        writeDiagnostic(error, { operation: "debug.control" });
        process.exitCode = 1;
    });

module.exports = { args, request, SIMPLE_ACTIONS, BREAKPOINT_ACTIONS };
