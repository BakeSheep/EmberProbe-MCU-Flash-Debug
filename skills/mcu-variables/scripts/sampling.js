"use strict";

const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

function args(argv) {
    const result = { workspace: process.cwd(), params: {} };
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
        seen.add(key);
        if (["--start", "--stop", "--status"].includes(key)) {
            if (result.method) throw new Error("Choose exactly one of --start, --stop, or --status");
            result.method = `sampling.${key.slice(2)}`;
        } else if (key === "--workspace" || key === "--interval") {
            const value = argv[++index];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
            if (key === "--workspace") result.workspace = value;
            else {
                const intervalMs = Number(value);
                if (!Number.isInteger(intervalMs) || intervalMs < 20 || intervalMs > 10000)
                    throw new Error("--interval must be an integer from 20 to 10000 milliseconds");
                result.params.intervalMs = intervalMs;
            }
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!result.method) throw new Error("Choose exactly one of --start, --stop, or --status");
    if (result.params.intervalMs !== undefined && result.method !== "sampling.start")
        throw new Error("--interval requires --start");
    return result;
}

async function main() {
    const request = args(process.argv.slice(2));
    const result = await call(request.workspace, request.method, request.params);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module)
    main().catch((error) => {
        writeDiagnostic(error, { operation: "sampling" });
        process.exitCode = 1;
    });

module.exports = { args };
