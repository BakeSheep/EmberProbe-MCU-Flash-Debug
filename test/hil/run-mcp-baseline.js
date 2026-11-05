"use strict";

// Runs the scripted MCP baseline over stdio against the Agent Bridge of an open EmberProbe window. The protocol phase
// does not open the probe; every other phase needs EMBERPROBE_HIL_CONFIRM=YES because the script answers confirmations
// itself. See test/hil/README.md.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const { Baseline, DEFAULT_PHASES, PHASES, createClient, renderReport } = require("./mcp-baseline");
const { loadConfig, resolveProfile, splitList } = require("./smoke-profile");

const root = path.resolve(__dirname, "../..");

function invalid(message) {
    return Object.assign(new Error(message), { code: "HIL_MCP_BASELINE_CONFIG_INVALID" });
}

function parseOptions(argv, env = process.env) {
    const { values } = parseArgs({
        args: argv,
        options: {
            profile: { type: "string" },
            workspace: { type: "string" },
            phases: { type: "string" },
            config: { type: "string" },
            server: { type: "string" },
            output: { type: "string" },
            "write-value": { type: "string" }
        }
    });
    if (!values.profile) throw invalid("--profile is required");
    if (!values.workspace || !path.isAbsolute(values.workspace))
        throw invalid("--workspace must be the absolute path open in the EmberProbe window");
    const phases = values.phases ? splitList(values.phases) : [...DEFAULT_PHASES];
    for (const phase of phases) if (!PHASES.includes(phase)) throw invalid(`Unknown phase: ${phase}`);
    if (!phases.length) throw invalid("--phases is empty");
    if (phases.some((phase) => phase !== "protocol") && env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw invalid(
            `Phases ${phases.join(",")} use real hardware; set EMBERPROBE_HIL_CONFIRM=YES on a dedicated board`
        );
    // The protocol phase checks the workspace, permissions and idle probe that every later phase relies on.
    const ordered = PHASES.filter((phase) => phases.includes(phase) || phase === "protocol");
    return {
        profile: values.profile,
        workspace: values.workspace,
        phases: ordered,
        config: path.resolve(values.config || env.EMBERPROBE_SMOKE_CONFIG || path.join(__dirname, "smoke.local.json")),
        server: path.resolve(values.server || path.join(root, "dist", "mcp-server.js")),
        output: path.resolve(values.output || path.join(root, "test-results", "mcp-baseline", values.profile)),
        writeValue: values["write-value"]
    };
}

function stdioConnector(options) {
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    return async ({ elicit }) => {
        const client = createClient({ elicit });
        await client.connect(
            new StdioClientTransport({
                command: process.execPath,
                args: [options.server],
                cwd: options.workspace,
                env: { ...process.env, EMBERPROBE_WORKSPACE: options.workspace },
                stderr: "inherit"
            })
        );
        return { client, close: () => client.close() };
    };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseOptions(argv);
    if (!fs.existsSync(options.server)) throw invalid(`${options.server} is missing; run npm run bundle first`);
    const profile = resolveProfile(loadConfig(options.config), options.profile);
    if (options.writeValue !== undefined && profile.variables.write) profile.variables.write.value = options.writeValue;
    const baseline = new Baseline({
        connect: stdioConnector(options),
        profile,
        phases: options.phases,
        log: (line) => console.log(line)
    });
    const report = await baseline.run();
    report.serverSha256 = crypto.createHash("sha256").update(fs.readFileSync(options.server)).digest("hex");
    fs.mkdirSync(options.output, { recursive: true });
    const stamp = report.startedAt.replace(/[:.]/gu, "-");
    const base = path.join(options.output, stamp);
    fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(`${base}.md`, renderReport(report));
    console.log(`${report.passed ? "PASSED" : "FAILED"}: ${base}.md`);
    return report.passed ? 0 : 1;
}

if (require.main === module)
    main().then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(error?.message || error);
            process.exitCode = 2;
        }
    );

module.exports = { main, parseOptions };
