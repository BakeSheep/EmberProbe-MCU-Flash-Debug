"use strict";
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");
const probeOption = "--select-probe";

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === "--get") out.get = true;
        else if (key === "--probes") out.probes = true;
        else if (key === "--workspace" || key === "--set" || key === probeOption) {
            if (!argv[i + 1]) throw new Error(`Missing value for ${key}`);
            out[key.slice(2)] = argv[++i];
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if ([out.get, out.probes, out.set !== undefined, out["select-probe"] !== undefined].filter(Boolean).length > 1)
        throw new Error("Choose only one of --get, --set, --probes or --select-probe");
    return out;
}

function parseSet(value) {
    const result = {};
    for (const item of String(value || "")
        .split(",")
        .filter(Boolean)) {
        const index = item.indexOf("=");
        if (index < 1) throw new Error(`Invalid assignment: ${item}`);
        result[item.slice(0, index)] = item.slice(index + 1);
    }
    return result;
}

async function main() {
    const opt = args(process.argv.slice(2));
    const workspace = opt.workspace || process.cwd();
    const result = opt["select-probe"]
        ? await call(workspace, "probe.select", { deviceId: opt["select-probe"] })
        : opt.set
          ? await call(workspace, "config.set", { values: parseSet(opt.set) })
          : await call(workspace, opt.probes ? "probe.list" : "config.get", {});
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module)
    main().catch((error) => {
        const operation = process.argv.includes(probeOption)
            ? "probe.select"
            : process.argv.includes("--probes")
              ? "probe.list"
              : process.argv.includes("--set")
                ? "config.set"
                : "config.get";
        writeDiagnostic(error, { operation });
        process.exitCode = 1;
    });
module.exports = { args, parseSet };
