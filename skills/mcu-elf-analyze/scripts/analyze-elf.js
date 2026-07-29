"use strict";
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!["--workspace", "--top"].includes(key)) throw new Error(`Unknown argument: ${key}`);
        if (!argv[i + 1]) throw new Error(`Missing value for ${key}`);
        out[key.slice(2)] = argv[++i];
    }
    return out;
}

async function main() {
    const opt = args(process.argv.slice(2));
    const params = {};
    if (opt.top !== undefined) {
        const top = Number(opt.top);
        if (!Number.isInteger(top) || top < 1) throw new Error(`--top must be a positive integer: ${opt.top}`);
        params.top = top;
    }
    const result = await call(opt.workspace || process.cwd(), "elf.analyze", params);
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module) main().catch(error => {
    writeDiagnostic(error, { operation: "elf.analyze" });
    process.exitCode = 1;
});
module.exports = { args };
