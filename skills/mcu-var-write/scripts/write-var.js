"use strict";
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (["--remember", "--reset-permission"].includes(key)) out[key.slice(2)] = true;
        else if (["--workspace", "--set", "--confirm"].includes(key)) {
            if (!argv[i + 1]) throw new Error(`Missing value for ${key}`);
            out[key.slice(2)] = argv[++i];
        } else throw new Error(`Unknown argument: ${key}`);
    }
    return out;
}

// 解析 --set 的 name=value 对（逗号分隔）；变量名可含路径语法（sensor.x / buf[0]）
function parseSet(text) {
    const values = [];
    for (const part of String(text || "").split(",").map(s => s.trim()).filter(Boolean)) {
        const eq = part.indexOf("=");
        if (eq <= 0 || eq === part.length - 1) throw new Error(`Invalid assignment (expected name=value): ${part}`);
        const name = part.slice(0, eq).trim();
        const rawValue = part.slice(eq + 1).trim();
        const value = Number(rawValue);
        if (!Number.isFinite(value)) throw new Error(`Value is not a number: ${part}`);
        values.push({ name, value });
    }
    if (!values.length) throw new Error("--set requires at least one name=value pair");
    return values;
}

async function main() {
    const opt = args(process.argv.slice(2));
    const workspace = opt.workspace || process.cwd();
    if (opt["reset-permission"]) {
        if (opt.set || opt.confirm || opt.remember) throw new Error("--reset-permission cannot be combined with write arguments");
        const result = await call(workspace, "variables.write.permission", { action: "reset" });
        process.stdout.write(JSON.stringify(result) + "\n");
        return;
    }
    if (!opt.set) throw new Error("--set is required");
    if (opt.remember && !opt.confirm) throw new Error("--remember requires --confirm <confirmationId>");
    const values = parseSet(opt.set);
    const result = await call(workspace, "variables.write", {
        values,
        confirmationId: opt.confirm,
        remember: !!opt.remember
    });
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module) main().catch(error => {
    writeDiagnostic(error, { operation: process.argv.includes("--reset-permission") ? "variables.write.permission" : "variables.write" });
    process.exitCode = 1;
});
module.exports = { args, parseSet };
