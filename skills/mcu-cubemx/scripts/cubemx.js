"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { call, writeDiagnostic } = require("../../_emberprobe/agent-client");

const REQUEST_TTL_MS = 15 * 60 * 1000;
const REQUEST_STORE_RELATIVE = path.join(".emberprobe-cubemx-audit", "cubemx-requests.json");
const DEEP_GUARANTEE =
    "Deep check proves regenerability consistency under current tools. Does not verify build or hardware behavior.";

function args(argv) {
    const result = {};
    const actions = [
        "generate-candidate",
        "detect",
        "inspect",
        "prepare",
        "execute",
        "start",
        "status",
        "check",
        "permission",
        "reset-permission",
        "cancel"
    ];
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index].replace(/^--/, "");
        if (actions.includes(key)) {
            if (result.action) throw new Error("Choose one operation");
            result.action = key;
        } else if (["remember", "deep", "full"].includes(key)) {
            result[key] = true;
        } else if (
            [
                "workspace",
                "candidate",
                "confirm",
                "output",
                "changes",
                "changes-file",
                "deletions",
                "prefix",
                "operation-id",
                "request-id"
            ].includes(key) &&
            argv[index + 1] !== undefined
        ) {
            result[key] = argv[++index];
        } else {
            throw new Error("Unknown or incomplete argument: " + argv[index]);
        }
    }
    if (!result.action)
        throw new Error(
            "Choose --detect, --inspect, --prepare, --execute, --start, --status, --check, --permission, --reset-permission or --cancel"
        );
    if ((result.confirm || result.remember) && !["execute", "start"].includes(result.action))
        throw new Error("Confirmation applies only to --execute or --start");
    if (result.remember && !result.confirm) throw new Error("--remember requires --confirm");
    if (result.candidate && !["prepare", "execute", "start"].includes(result.action))
        throw new Error("Candidate applies only to preparation, start and execution");
    if (
        (result.output || result.changes || result["changes-file"] || result.deletions) &&
        result.action !== "generate-candidate"
    )
        throw new Error("--output, --changes, --changes-file and --deletions require --generate-candidate");
    if (result.action === "generate-candidate" && !result.output)
        throw new Error("--generate-candidate requires --output");
    if (result.changes && result["changes-file"])
        throw new Error("--changes and --changes-file are mutually exclusive");
    if (result["operation-id"] && !["status", "cancel"].includes(result.action))
        throw new Error("--operation-id applies only to --status or --cancel");
    if (result.deep && result.action !== "check") throw new Error("--deep applies only to --check");
    if (result.prefix && result.action !== "inspect") throw new Error("--prefix applies only to --inspect");
    return result;
}

function requestFingerprint(action, params) {
    return crypto
        .createHash("sha256")
        .update(
            JSON.stringify({
                action,
                candidatePath: params.candidatePath || "",
                confirmationId: params.confirmationId || "",
                remember: !!params.remember
            })
        )
        .digest("hex")
        .slice(0, 32);
}

function loadRequestRecords(workspace) {
    try {
        return JSON.parse(fs.readFileSync(path.join(workspace, REQUEST_STORE_RELATIVE), "utf8"));
    } catch {
        return {};
    }
}

function saveRequestRecords(workspace, records) {
    try {
        const file = path.join(workspace, REQUEST_STORE_RELATIVE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(records, null, 2), "utf8");
    } catch {
        // Request persistence only enables retry deduplication; never block the operation on it.
    }
}

// A request ID must survive the process that created it: when a bridge call is lost after the
// operation started, re-running the same command reuses the persisted ID, and the service-side
// dedup returns the original operation instead of generating again.
function resolveRequestId(workspace, action, params, now = Date.now(), ttlMs = REQUEST_TTL_MS) {
    const fingerprint = requestFingerprint(action, params);
    const records = loadRequestRecords(workspace);
    const entry = records[fingerprint];
    if (entry && typeof entry.requestId === "string" && typeof entry.createdAt === "number") {
        if (now - entry.createdAt < ttlMs) return entry.requestId;
    }
    const requestId = "req_" + now.toString(36) + "_" + crypto.randomBytes(4).toString("hex");
    const fresh = {};
    for (const [key, value] of Object.entries(records)) {
        if (value && typeof value.createdAt === "number" && now - value.createdAt < ttlMs) fresh[key] = value;
    }
    fresh[fingerprint] = { requestId, createdAt: now };
    saveRequestRecords(workspace, fresh);
    return requestId;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The service runs deep checks as queryable background operations. Poll the operation record so
// the CLI still answers with one JSON result; on a lost call the agent can query --status with
// the operation ID instead of re-running CubeMX.
async function pollDeepCheck(workspace, started) {
    if (!started || started.status !== "in_progress") return started; // legacy synchronous response
    const deadline = Date.now() + 330000; // stay inside the 360000 ms bridge budget
    let record = started;
    while (Date.now() < deadline) {
        await sleep(3000);
        record = await call(workspace, "cubemx.status", { operationId: started.operationId }, 30000);
        if (record.status === "succeeded") {
            if (!record.result) throw new Error("Deep check completed without a result record");
            return { mode: "deep", operationId: started.operationId, ...record.result, guarantee: DEEP_GUARANTEE };
        }
        if (record.status === "failed" || record.status === "cancelled" || record.status === "interrupted") {
            throw Object.assign(new Error(record.error?.message || record.diagnostic || "Deep check did not complete"), {
                code: record.error?.code || "CUBEMX_GENERATION_FAILED",
                details: record.error?.details
            });
        }
    }
    throw Object.assign(
        new Error(
            `Deep check ${started.operationId} is still running; query cubemx.status --operation-id ${started.operationId} instead of re-running`
        ),
        { code: "CUBEMX_STILL_RUNNING", retryable: false }
    );
}

async function main() {
    const opt = args(process.argv.slice(2));
    const action =
        opt.action === "generate-candidate"
            ? "candidate"
            : opt.action === "reset-permission"
              ? "permission"
              : opt.action;

    const workspace = opt.workspace || process.cwd();
    const methodName = "cubemx." + action;

    const caps = await call(workspace, "capabilities", {}, 10000).catch(() => null);
    if (caps?.methods && !caps.methods.includes(methodName)) {
        throw Object.assign(
            new Error(
                `EmberProbe Agent Bridge method '${methodName}' is not supported by the current extension version. Please update EmberProbe.`
            ),
            { code: "UPGRADE_REQUIRED", retryable: false }
        );
    }

    let params = {};
    if (action === "candidate") {
        params = {
            outputPath: path.resolve(workspace, opt.output),
            ...(opt["changes-file"] ? { changesFile: path.resolve(workspace, opt["changes-file"]) } : {}),
            ...(opt.changes ? { changes: JSON.parse(opt.changes) } : {}),
            ...(opt.deletions ? { deletions: JSON.parse(opt.deletions) } : {})
        };
    } else if (action === "inspect") {
        params = {
            summary: !opt.full,
            full: !!opt.full,
            ...(opt.prefix ? { prefix: opt.prefix } : {})
        };
    } else if (action === "prepare") {
        params = {
            summary: !opt.full,
            full: !!opt.full,
            ...(opt.candidate ? { candidatePath: path.resolve(workspace, opt.candidate) } : {})
        };
    } else if (action === "execute" || action === "start") {
        params = {
            ...(opt.candidate ? { candidatePath: path.resolve(workspace, opt.candidate) } : {}),
            ...(opt.confirm ? { confirmationId: opt.confirm } : {}),
            ...(opt.remember ? { remember: true } : {})
        };
        const requestId = opt["request-id"] || resolveRequestId(workspace, action, params);
        params.requestId = requestId;
    } else if (action === "status") {
        params = {
            ...(opt["operation-id"] ? { operationId: opt["operation-id"] } : {})
        };
    } else if (action === "cancel") {
        params = {
            ...(opt["operation-id"] ? { operationId: opt["operation-id"] } : {})
        };
    } else if (action === "check") {
        params = {
            mode: opt.deep ? "deep" : "quick"
        };
    } else if (action === "permission") {
        params = {
            action: opt.action === "reset-permission" ? "reset" : "status"
        };
    }

    const timeoutMs = action === "execute" || (action === "check" && opt.deep) ? 360000 : 30000;
    let result = await call(workspace, methodName, params, timeoutMs);
    if (action === "check" && opt.deep) result = await pollDeepCheck(workspace, result);
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (require.main === module)
    main().catch((error) => {
        writeDiagnostic(error, { operation: "cubemx" });
        process.exitCode = 1;
    });

module.exports = { args, resolveRequestId, requestFingerprint, pollDeepCheck };
