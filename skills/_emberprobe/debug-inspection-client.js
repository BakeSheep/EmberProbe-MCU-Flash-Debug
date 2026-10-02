"use strict";

const { call, writeDiagnostic } = require("./agent-client");

function args(argv, rtos = false) {
    const actions = new Set(["--threads", "--stack", "--scopes", "--variables"]);
    if (rtos) {
        actions.add("--status");
        actions.add("--snapshot");
    }
    const values = new Set(["--workspace", "--thread", "--frame", "--reference", "--start", "--count", "--filter"]);
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (actions.has(key)) {
            if (out.action) throw new Error("Choose exactly one inspection action");
            out.action = key.slice(2);
        } else if (rtos && key === "--no-stack-usage") out.includeStackUsage = false;
        else if (values.has(key)) {
            if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${key}`);
            if (out[key.slice(2)] !== undefined) throw new Error(`Duplicate option: ${key}`);
            out[key.slice(2)] = argv[++i];
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!out.action) throw new Error("Choose exactly one inspection action");
    const allowed = {
        threads: [],
        stack: ["thread", "start", "count"],
        scopes: ["frame"],
        variables: ["reference", "start", "count", "filter"],
        status: [],
        snapshot: ["includeStackUsage"]
    };
    for (const key of Object.keys(out))
        if (!["workspace", "action", ...allowed[out.action]].includes(key))
            throw new Error(`${key} cannot be used with --${out.action}`);
    const required = { stack: "thread", scopes: "frame", variables: "reference" }[out.action];
    if (required && !out[required]) throw new Error(`--${out.action} requires --${required}`);
    /** @type {Array<[string, number, number]>} */
    const ranges = [
        ["thread", 1, Number.MAX_SAFE_INTEGER],
        ["start", 0, 100000],
        ["count", 1, 100]
    ];
    for (const [key, min, max] of ranges) {
        if (out[key] === undefined) continue;
        const value = Number(out[key]);
        if (!Number.isSafeInteger(value) || value < min || value > max)
            throw new Error(`--${key} must be an integer from ${min} to ${max}`);
        out[key] = value;
    }
    if (out.filter !== undefined && !["named", "indexed"].includes(out.filter))
        throw new Error("--filter must be named or indexed");
    return out;
}

function request(opt) {
    if (opt.action === "status") return { method: "rtos.status", params: {} };
    if (opt.action === "snapshot")
        return { method: "rtos.snapshot", params: { includeStackUsage: opt.includeStackUsage !== false } };
    const { workspace: _workspace, thread, ...params } = opt;
    if (thread !== undefined) params.threadId = thread;
    return { method: "debug.inspect", params };
}

async function main(rtos = false) {
    let method = rtos ? "rtos.snapshot" : "debug.inspect";
    try {
        const opt = args(process.argv.slice(2), rtos);
        const operation = request(opt);
        method = operation.method;
        const result = await call(opt.workspace || process.cwd(), method, operation.params);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        writeDiagnostic(error, { operation: method });
        process.exitCode = 1;
    }
}

module.exports = { args, request, main };
