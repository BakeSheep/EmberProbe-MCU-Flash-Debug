"use strict";

const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

const READ_OPTIONS = {
    "--channel": ["channel", 0, 255],
    "--generation": ["generation", 0, Number.MAX_SAFE_INTEGER],
    "--cursor": ["cursor", 0, Number.MAX_SAFE_INTEGER],
    "--max-bytes": ["maxBytes", 1, 65536]
};
const ACTIONS = ["--status", "--start", "--stop", "--read", "--write", "--permission", "--reset-permission"];
const ACTION_METHODS = {
    "--permission": ["rtt.input.permission", { action: "status" }],
    "--reset-permission": ["rtt.input.permission", { action: "reset" }]
};
const WRITE_VALUES = ["--text", "--data-base64", "--line-ending", "--confirm"];
const LINE_ENDINGS = ["configured", "lf", "crlf", "cr", "none"];
const CHOOSE = `Choose exactly one of ${ACTIONS.join(", ")}`;

function args(argv) {
    const result = { workspace: process.cwd(), params: {} };
    const seen = new Set();
    let action;
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
        seen.add(key);
        if (ACTIONS.includes(key)) {
            if (action) throw new Error(CHOOSE);
            action = key;
        } else if (key === "--remember") result.params.remember = true;
        else if (
            key === "--workspace" ||
            key === "--encoding" ||
            WRITE_VALUES.includes(key) ||
            Object.hasOwn(READ_OPTIONS, key)
        ) {
            const value = argv[++index];
            // Text may legitimately start with "--"; every other value may not.
            if (value === undefined || (key !== "--text" && (!value || value.startsWith("--"))))
                throw new Error(`Missing value for ${key}`);
            if (key === "--workspace") result.workspace = value;
            else if (key === "--encoding") {
                if (value !== "utf8" && value !== "base64") throw new Error("--encoding must be utf8 or base64");
                result.params.encoding = value;
            } else if (key === "--text") result.params.text = value;
            else if (key === "--data-base64") result.params.dataBase64 = value;
            else if (key === "--confirm") result.params.confirmationId = value;
            else if (key === "--line-ending") {
                if (!LINE_ENDINGS.includes(value))
                    throw new Error(`--line-ending must be one of ${LINE_ENDINGS.join(", ")}`);
                result.params.lineEnding = value;
            } else {
                const [name, min, max] = READ_OPTIONS[key];
                const number = Number(value);
                if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
                    throw new Error(`${key} must be an integer from ${min} to ${max}`);
                result.params[name] = number;
            }
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!action) throw new Error(CHOOSE);
    const keys = Object.keys(result.params);
    const readKeys = ["channel", "generation", "cursor", "maxBytes", "encoding"];
    const writeKeys = ["channel", "text", "dataBase64", "lineEnding", "confirmationId", "remember"];
    if (action === "--read") {
        if (keys.some((key) => !readKeys.includes(key))) throw new Error("Write options require --write");
    } else if (action === "--write") {
        if (keys.some((key) => !writeKeys.includes(key))) throw new Error("Read options require --read");
        if ((result.params.text === undefined) === (result.params.dataBase64 === undefined))
            throw new Error("--write needs exactly one of --text or --data-base64");
        if (result.params.lineEnding !== undefined && result.params.text === undefined)
            throw new Error("--line-ending applies to --text only");
        if (result.params.remember && !result.params.confirmationId)
            throw new Error("--remember requires --confirm <confirmationId>");
    } else if (keys.length) throw new Error("Read options require --read; write options require --write");
    [result.method, result.params] = ACTION_METHODS[action] || [`rtt.${action.slice(2)}`, result.params];
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
