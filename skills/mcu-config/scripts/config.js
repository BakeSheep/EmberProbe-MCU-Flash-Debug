"use strict";
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === "--get") out.get = true;
        else if (key === "--workspace" || key === "--set") {
            if (!argv[i + 1]) throw new Error(`Missing value for ${key}`);
            out[key.slice(2)] = argv[++i];
        } else throw new Error(`Unknown argument: ${key}`);
    }
    return out;
}

function parseSet(value) {
    const result = {};
    for (const item of String(value || "").split(",").filter(Boolean)) {
        const index = item.indexOf("=");
        if (index < 1) throw new Error(`Invalid assignment: ${item}`);
        result[item.slice(0, index)] = item.slice(index + 1);
    }
    return result;
}

async function main() {
    const opt = args(process.argv.slice(2));
    const workspace = opt.workspace || process.cwd();
    const result = opt.set
        ? await call(workspace, "config.set", { values: parseSet(opt.set) })
        : await call(workspace, "config.get", {});
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module) main().catch(error => {
    writeDiagnostic(error, { operation: process.argv.includes("--set") ? "config.set" : "config.get" });
    process.exitCode = 1;
});
module.exports = { args, parseSet };
