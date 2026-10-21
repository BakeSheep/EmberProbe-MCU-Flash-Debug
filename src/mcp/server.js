"use strict";
// EmberProbe MCP 服务器（stdio）。它和 skill 脚本一样只是 Agent Bridge 的客户端：只做 schema 校验、
// 确认交互映射和结果/诊断转换；鉴权、确认 ID 校验、输入校验与硬件互斥都留在扩展进程内。
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
    CallToolRequestSchema,
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
    const enabled = tools.toolsFor(tools.parseToolsets(env.EMBERPROBE_MCP_TOOLSETS));
    const byName = new Map(enabled.map((tool) => [tool.name, tool]));
    const validator = new AjvJsonSchemaValidator();
    const validators = new Map(enabled.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)]));
    const server = new Server(
        { name: "emberprobe", title: "EmberProbe", version: readVersion() },
        { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
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

    // 工作区定位：EMBERPROBE_WORKSPACE > MCP roots（第一个 file: 根）> cwd。
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
            // 弹窗失败、超时或被取消都按未批准处理，操作不会执行。
            throw Object.assign(confirm.denied(), { details: { reason: String(error?.message || error) } });
        }
    }

    async function runConfirmable(tool, args, call, extra) {
        const request = tool.request(args);
        const params = { ...request.params };
        if (args.confirmationId) {
            const final = await call(
                request.method,
                {
                    ...params,
                    confirmationId: args.confirmationId,
                    ...(args.remember ? { remember: true } : {})
                },
                request.timeoutMs
            );
            return results.success(confirm.withoutConfirmationId(final));
        }
        const first = await call(request.method, params, request.timeoutMs);
        if (!first?.confirmationRequired) return results.success(first);
        const approval = await approve(first, extra);
        if (!approval)
            return results.success(confirm.pending(first, params.requestId ? { requestId: params.requestId } : {}));
        const final = await call(request.method, { ...params, ...approval }, request.timeoutMs);
        return results.success(confirm.withoutConfirmationId(final));
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
        // 预检未就绪：直接报告 diagnostics 和 notes，不进入确认。
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
        // 已有 24 小时工作区授权时直接执行，结果中带 trustedExpiresAt。
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
            if (tool.confirm) return await runConfirmable(tool, args, call, extra);
            const request = tool.request(args);
            return results.success(await call(request.method, request.params || {}, request.timeoutMs));
        } catch (error) {
            return results.failure(error, tool.methods.at(-1));
        } finally {
            extra.signal?.removeEventListener("abort", onAbort);
        }
    }

    // Bridge 只有请求/响应：等待期间按固定间隔发送只含已耗时的进度通知，避免客户端判定无响应。
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
    // stdout 只承载 MCP 协议；任何意外的日志都转到 stderr。
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
