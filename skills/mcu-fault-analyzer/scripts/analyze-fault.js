"use strict";
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!["--workspace"].includes(key)) throw new Error(`Unknown argument: ${key}`);
        if (!argv[i + 1]) throw new Error(`Missing value for ${key}`);
        out[key.slice(2)] = argv[++i];
    }
    return out;
}

async function main() {
    const opt = args(process.argv.slice(2));
    const result = await call(opt.workspace || process.cwd(), "fault.read", {});
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module) main().catch(error => {
    writeDiagnostic(error, { operation: "fault.read" });
    process.exitCode = 1;
});
module.exports = { args };
