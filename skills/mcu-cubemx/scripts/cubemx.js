"use strict";
const path = require("path");
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

function args(argv) {
    const result = {};
    const actions = [
        "generate-candidate",
        "detect",
        "inspect",
        "prepare",
        "execute",
        "permission",
        "reset-permission",
        "cancel"
    ];
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index].replace(/^--/, "");
        if (actions.includes(key)) {
            if (result.action) throw new Error("Choose one operation");
            result.action = key;
        } else if (key === "remember") result.remember = true;
        else if (["workspace", "candidate", "confirm", "output", "changes"].includes(key) && argv[index + 1])
            result[key] = argv[++index];
        else throw new Error("Unknown or incomplete argument: " + argv[index]);
    }
    if (!result.action)
        throw new Error(
            "Choose --detect, --inspect, --prepare, --execute, --permission, --reset-permission or --cancel"
        );
    if ((result.confirm || result.remember) && result.action !== "execute")
        throw new Error("Confirmation applies only to --execute");
    if (result.remember && !result.confirm) throw new Error("--remember requires --confirm");
    if (result.candidate && !["prepare", "execute"].includes(result.action))
        throw new Error("Candidate applies only to preparation and execution");
    if ((result.output || result.changes) && result.action !== "generate-candidate")
        throw new Error("--output and --changes require --generate-candidate");
    if (result.action === "generate-candidate" && !result.output)
        throw new Error("--generate-candidate requires --output");
    return result;
}
async function main() {
    const opt = args(process.argv.slice(2));
    const action =
        opt.action === "generate-candidate"
            ? "candidate"
            : opt.action === "reset-permission"
              ? "permission"
              : opt.action;
    const params = {
        ...(action === "candidate"
            ? {
                  outputPath: path.resolve(opt.workspace || process.cwd(), opt.output),
                  changes: opt.changes ? JSON.parse(opt.changes) : {}
              }
            : {}),
        ...(opt.candidate ? { candidatePath: path.resolve(opt.candidate) } : {}),
        ...(opt.confirm ? { confirmationId: opt.confirm } : {}),
        ...(opt.remember ? { remember: true } : {}),
        ...(action === "permission" ? { action: opt.action === "reset-permission" ? "reset" : "status" } : {})
    };
    const result = await call(
        opt.workspace || process.cwd(),
        "cubemx." + action,
        params,
        action === "execute" ? 360000 : 30000
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}
if (require.main === module)
    main().catch((error) => {
        writeDiagnostic(error, { operation: "cubemx" });
        process.exitCode = 1;
    });
module.exports = { args };
