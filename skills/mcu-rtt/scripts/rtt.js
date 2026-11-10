"use strict";

const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

const READ_OPTIONS = {
    "--channel": ["channel", 0, 255],
    "--generation": ["generation", 0, Number.MAX_SAFE_INTEGER],
    "--cursor": ["cursor", 0, Number.MAX_SAFE_INTEGER],
    "--max-bytes": ["maxBytes", 1, 65536]
};

function args(argv) {
    const result = { workspace: process.cwd(), params: {} };
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
        seen.add(key);
        if (["--status", "--start", "--stop", "--read"].includes(key)) {
            if (result.method) throw new Error("Choose exactly one of --status, --start, --stop, or --read");
            result.method = `rtt.${key.slice(2)}`;
        } else if (key === "--workspace" || key === "--encoding" || Object.hasOwn(READ_OPTIONS, key)) {
            const value = argv[++index];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
            if (key === "--workspace") result.workspace = value;
            else if (key === "--encoding") {
                if (value !== "utf8" && value !== "base64") throw new Error("--encoding must be utf8 or base64");
                result.params.encoding = value;
            } else {
                const [name, min, max] = READ_OPTIONS[key];
                const number = Number(value);
                if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
                    throw new Error(`${key} must be an integer from ${min} to ${max}`);
                result.params[name] = number;
            }
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!result.method) throw new Error("Choose exactly one of --status, --start, --stop, or --read");
    if (result.method !== "rtt.read" && Object.keys(result.params).length)
        throw new Error("Read options require --read");
    return result;
}

async function main() {
    const request = args(process.argv.slice(2));
    const result = await call(request.workspace, request.method, request.params);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module)
    main().catch((error) => {
        writeDiagnostic(error, { operation: "rtt" });
        process.exitCode = 1;
    });

module.exports = { args };
