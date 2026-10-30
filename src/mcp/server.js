"use strict";
// EmberProbe MCP server (stdio). Like the skill scripts it is only an Agent Bridge client: it validates schemas, maps
// confirmation interactions and converts results and diagnostics. Authentication, confirmation ID checks, input
// validation and hardware locking stay in the extension process.
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListToolsRequestSchema,
    RootsListChangedNotificationSchema,
    ErrorCode,
    McpError
} = require("@modelcontextprotocol/sdk/types.js");
const { AjvJsonSchemaValidator } = require("@modelcontextprotocol/sdk/validation/ajv-provider.js");
const { callVia } = require("../../skills/_emberprobe/agent-client");
const flashCommon = require("../../skills/_emberprobe/flash-common");
const tools = require("./tools");
const results = require("./results");
const confirm = require("./confirm");
const prompts = require("./prompts");

const INSTRUCTIONS = [
    "EmberProbe drives a real MCU through the EmberProbe VS Code extension. Rules for every tool:",
    "- Never guess the MCU target, probe, ELF or probe serial. Ask the user or report what is missing.",
    "- Sensitive tools (flash_program, flash_verify, variables_write, peripherals_write, cubemx_execute, cubemx_start) need the user's approval of the returned plan. Approval must come from the user, never from you. Use remember only when the user chose the workspace option.",
    "- After a timeout or an unknown result, query the matching status tool (debug_status, variables_read, config_get, cubemx_status) before deciding; never resend a state-changing call automatically.",
    "- The probe has a single owner. Stop sampling or debugging before flashing; PROBE_BUSY means wait or ask.",
    "- Do not bypass these tools by running OpenOCD, GDB or CubeMX yourself.",
    "- On failure read error.code, retryable and details; the suggested actions are more specific than guesses."
].join("\n");

function readVersion() {
    for (const file of [path.join(__dirname, "..", "package.json"), path.join(__dirname, "..", "..", "package.json")]) {
        try {
            const value = JSON.parse(fs.readFileSync(file, "utf8"));
            if (value.name === "emberprobe") return String(value.version);
        } catch {
            /* try the next layout */
        }
    }
    return "0.0.0";
}

function rootPath(uri) {
    try {
        return uri.startsWith("file:") ? fileURLToPath(uri) : "";
    } catch {
        return "";
    }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, call?: typeof callVia, progressIntervalMs?: number }} [options]
 */
function createServer(options = {}) {
    const env = options.env || process.env;
    const bridgeCall = options.call || callVia;
    const toolsets = tools.parseToolsets(env.EMBERPROBE_MCP_TOOLSETS);
    const enabled = tools.toolsFor(toolsets);
    const enabledPrompts = prompts.promptsFor(toolsets);
    const byName = new Map(enabled.map((tool) => [tool.name, tool]));
    const validator = new AjvJsonSchemaValidator();
    const validators = new Map(enabled.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)]));
    const server = new Server(
        { name: "emberprobe", title: "EmberProbe", version: readVersion() },
        { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS }
    );
    let roots = null;

    function channel() {
        const client = server.getClientVersion();
        return {
            name: "mcp",
            client: client ? `${client.name}/${client.version}` : "",
            instance: env.EMBERPROBE_BRIDGE_INSTANCE || undefined
        };
    }

    // Workspace lookup: EMBERPROBE_WORKSPACE > MCP roots (first file: root) > cwd.
    async function workspace() {
        if (env.EMBERPROBE_WORKSPACE) return env.EMBERPROBE_WORKSPACE;
        if (server.getClientCapabilities()?.roots) {
            roots ||= server
                .listRoots()
                .then((value) => value.roots.map((root) => rootPath(root.uri)).filter(Boolean))
                .catch(() => []);
            const list = await roots;
            if (list.length) return list[0];
        }
        return options.cwd || process.cwd();
    }
    server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
        roots = null;
    });

    async function approve(result, extra) {
        if (!server.getClientCapabilities()?.elicitation) return null;
        const expires = Date.parse(result.expiresAt || "");
        const timeout = Number.isFinite(expires) ? Math.max(30000, Math.min(15 * 60000, expires - Date.now())) : 300000;
        try {
            return await confirm.elicit(server, result, { signal: extra.signal, timeout });
        } catch (error) {
            if (error?.code === "CONFIRMATION_DENIED") throw error;
            // A failed, timed-out or cancelled prompt counts as not approved and the operation does not run.
            throw Object.assign(confirm.denied(), { details: { reason: String(error?.message || error) } });
        }
    }

    async function runConfirmable(tool, args, call, target, extra) {
        const request = tool.request(args, { workspace: target });
        const params = { ...request.params };
        const execute = async (approval) =>
            results.success(
                confirm.withoutConfirmationId(await call(request.method, { ...params, ...approval }, request.timeoutMs))
            );
        if (args.confirmationId)
            return execute({ confirmationId: args.confirmationId, ...(args.remember ? { remember: true } : {}) });
        // Most methods answer an ID-less call with their own plan. A tool with `plan` (CubeMX generation)
        // asks a separate method for it, because its method only consumes a confirmation.
        const planned = tool.plan?.(params);
        const first = planned
            ? await call(planned.method, planned.params, planned.timeoutMs)
            : await call(request.method, params, request.timeoutMs);
        // Without a required confirmation the method already ran, or a remembered permission covers the plan.
        if (!first?.confirmationRequired) return planned ? execute({}) : results.success(first);
        const plan = planned ? { ...planned.context, ...first } : first;
        const approval = await approve(plan, extra);
        if (!approval)
            return results.success(confirm.pending(plan, params.requestId ? { requestId: params.requestId } : {}));
        return execute(approval);
    }

    async function runFlash(tool, args, call, target, extra) {
        const program = tool.operation === "flash.execute";
        const plan = await flashCommon.preflight(
            {
                workspace: target,
                elf: args.elf,
                target: args.target,
                probe: args.probe,
                transport: args.transport,
                "probe-serial": args.probeSerial,
                "adapter-speed-khz": args.adapterSpeedKhz
            },
            { call: (_workspace, method, params, timeoutMs) => call(method, params, timeoutMs) }
        );
        // Preflight not ready: report diagnostics and notes directly without asking for confirmation.
        if (!plan.ready) return results.rejected({ ok: false, type: "preflight", ...plan });
        if (
            !fs.existsSync(plan.elf) ||
            !flashCommon.isSafeCfgPath(plan.target) ||
            !flashCommon.isSafeCfgPath(plan.probe)
        )
            return results.rejected({ ok: false, type: "preflight", ...plan, notes: [...plan.notes, "Unsafe plan"] });
        const identity = {
            elf: plan.elf,
            elfSha256: plan.elfSha256,
            target: plan.target,
            probe: plan.probe,
            openocd: plan.openocd,
            transport: plan.transport,
            probeSerial: flashCommon.probeSerialOverride(plan),
            adapterSpeedKhz: plan.adapterSpeedKhz
        };
        const execute = async (approval) => {
            const executed = await call(tool.operation, { ...identity, ...approval }, 150000);
            const value = { preflight: plan, ...confirm.withoutConfirmationId(executed) };
            return Number.isInteger(executed?.code) && executed.code !== 0
                ? results.rejected(value)
                : results.success(value);
        };
        if (args.confirmationId)
            return execute({
                confirmationId: args.confirmationId,
                ...(program && args.remember ? { remember: true } : {})
            });
        const authorization = await call("flash.authorize", { ...identity, operation: tool.operation });
        // With a 24-hour workspace authorization in place, run directly and include trustedExpiresAt in the result.
        if (program && authorization?.authorized === true)
            return execute({}).then((value) => {
                value.structuredContent.authorization = authorization;
                return value;
            });
        if (!authorization?.confirmationRequired) return results.success({ preflight: plan, authorization });
        const approval = await approve({ ...identity, ...authorization }, extra);
        if (!approval) return results.success(confirm.pending({ preflight: plan, ...authorization }));
        return execute(program ? approval : { confirmationId: approval.confirmationId });
    }

    async function run(tool, args, extra) {
        const target = await workspace();
        const via = channel();
        const call = (method, params, timeoutMs) => bridgeCall(via, target, method, params, timeoutMs);
        const onAbort = () => {
            const cancel = tool.cancel?.(args);
            if (cancel) call(cancel.method, cancel.params || {}, 20000).catch(() => {});
        };
        extra.signal?.addEventListener("abort", onAbort, { once: true });
        try {
            if (tool.kind === "flash") return await runFlash(tool, args, call, target, extra);
            if (tool.confirm) return await runConfirmable(tool, args, call, target, extra);
            const request = tool.request(args, { workspace: target });
            const value = await call(request.method, request.params || {}, request.timeoutMs);
            return results.success(tool.result ? tool.result(value) : value);
        } catch (error) {
            return results.failure(error, tool.methods.at(-1));
        } finally {
            extra.signal?.removeEventListener("abort", onAbort);
        }
    }

    // The Bridge is request/response only, so progress notifications with just the elapsed time are sent at a fixed
    // interval while waiting, so the client does not consider the call stalled.
    async function withProgress(extra, work) {
        const progressToken = extra?._meta?.progressToken;
        if (progressToken === undefined) return work();
        const started = Date.now();
        const timer = setInterval(() => {
            const seconds = Math.round((Date.now() - started) / 1000);
            extra
                .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: seconds, message: `Waiting for EmberProbe (${seconds}s)` }
                })
                .catch(() => {});
        }, options.progressIntervalMs || 5000);
        try {
            return await work();
        } finally {
            clearInterval(timer);
        }
    }

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: enabled.map(tools.listing) }));
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: enabledPrompts.map(prompts.listing) }));
    server.setRequestHandler(GetPromptRequestSchema, (request) => {
        const prompt = enabledPrompts.find((item) => item.name === request.params.name);
        if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
        const goal = String(request.params.arguments?.goal || "").trim();
        return {
            description: prompt.description,
            messages: [{ role: "user", content: { type: "text", text: prompts.promptText(prompt, goal) } }]
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const tool = byName.get(request.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
        const args = request.params.arguments || {};
        const checked = validators.get(tool.name)(args);
        if (!checked.valid)
            return results.failure(
                Object.assign(new Error(`Invalid arguments for ${tool.name}: ${checked.errorMessage}`), {
                    code: "INVALID_PARAMS",
                    category: "input",
                    retryable: false
                }),
                tool.methods.at(-1)
            );
        return withProgress(extra, () => run(tool, args, extra));
    });
    return server;
}

async function main() {
    // stdout carries only the MCP protocol; any unexpected log goes to stderr.
    console.log = console.error;
    console.info = console.error;
    const server = createServer();
    await server.connect(new StdioServerTransport());
}

if (require.main === module)
    main().catch((error) => {
        process.stderr.write(`EmberProbe MCP server failed: ${error?.stack || error}\n`);
        process.exit(1);
    });

module.exports = { createServer, INSTRUCTIONS, main };
