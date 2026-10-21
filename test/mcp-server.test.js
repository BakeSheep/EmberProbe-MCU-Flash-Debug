"use strict";
// MCP 服务器进程内连接真实 Agent Bridge（假路由）：确认的接受/拒绝/过期、无 elicitation 回退、
// 确认 ID 不泄露、超时按未知处理、取消转发、roots 变化后重新定位、进度通知与参数校验。
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const {
    ElicitRequestSchema,
    ListRootsRequestSchema,
    CallToolResultSchema
} = require("@modelcontextprotocol/sdk/types.js");
const { AgentService } = require("../src/services/agentService");
const { AgentBridge } = require("../src/agentBridge");
const { BridgeRegistry } = require("../src/services/bridgeRegistry");
const { REGISTRY_DIR } = require("../skills/_emberprobe/bridge-locator");
const flashCommon = require("../skills/_emberprobe/flash-common");
const { createServer } = require("../src/mcp/server");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-server-")));
const storageDir = path.join(base, "storage");
process.env.EMBERPROBE_BRIDGE_REGISTRY = path.join(storageDir, REGISTRY_DIR);
delete process.env.EMBERPROBE_BRIDGE_INSTANCE;
delete process.env.EMBERPROBE_WORKSPACE;

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function startBridge(workspace, handlers) {
    fs.mkdirSync(workspace, { recursive: true });
    const calls = [];
    const wrapped = Object.fromEntries(
        Object.entries(handlers).map(([method, handler]) => [
            method,
            async (params) => {
                calls.push({ method, params });
                return handler(params, calls);
            }
        ])
    );
    const metas = [];
    const service = new AgentService({
        Bridge: AgentBridge,
        workspaceProvider: () => workspace,
        storageDirProvider: () => storageDir,
        registry: new BridgeRegistry({ storageDir, hostApp: "Test Host" }),
        onCall: (_method, _params, meta) => metas.push(meta),
        handlers: wrapped
    });
    await service.start({ legacyPointer: false });
    return { service, calls, metas };
}

async function connect({ elicitation, roots, answer, env = {}, progressIntervalMs } = {}) {
    const server = createServer({ env: { ...env }, cwd: base, progressIntervalMs });
    const capabilities = {};
    if (elicitation) capabilities.elicitation = {};
    if (roots) capabilities.roots = { listChanged: true };
    const client = new Client({ name: "test-client", version: "9.9.9" }, { capabilities });
    const elicitations = [];
    if (elicitation)
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
            elicitations.push(request.params);
            return typeof answer === "function" ? answer(request.params) : answer;
        });
    const state = { roots: roots || [] };
    if (roots)
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
            roots: state.roots.map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) }))
        }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, server, elicitations, state };
}

const workspace = path.join(base, "project");
let confirmations = 0;
const writeHandler = (params) => {
    if (!params.confirmationId)
        return {
            confirmationRequired: true,
            confirmationId: `write-${++confirmations}`,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            question: "Write kp = 0.5?",
            choices: ["once", "workspace"],
            values: [{ name: "kp", address: "0x20000000", current: 0.1, value: 0.5 }]
        };
    if (params.confirmationId === "expired")
        throw Object.assign(new Error("Confirmation expired"), { code: "WRITE_CONFIRMATION_INVALID" });
    return { results: [{ name: "kp", written: 0.5, verified: true }], remember: !!params.remember };
};

(async () => {
    const generation = deferred();
    const bridge = await startBridge(workspace, {
        "config.get": () => ({ workspace }),
        "variables.write": writeHandler,
        "peripherals.write": (params) =>
            params.confirmationId
                ? { verified: true }
                : {
                      confirmationRequired: true,
                      confirmationId: "p-1",
                      question: "Write GPIOA.ODR?",
                      choices: ["once"]
                  },
        "debug.status": () => new Promise((resolve) => setTimeout(() => resolve({ state: "paused" }), 120)),
        "cubemx.execute": () => generation.promise,
        "cubemx.cancel": (params) => {
            generation.resolve({ cancelled: true });
            return { cancelled: 1, params };
        },
        "flash.authorize": (params) =>
            params.elf.endsWith("trusted.elf")
                ? { authorized: true, mode: "workspace", trustedExpiresAt: "2026-10-22T00:00:00.000Z" }
                : {
                      authorized: false,
                      confirmationRequired: true,
                      confirmationId: "flash-1",
                      question: "Program firmware?",
                      choices: ["once", "workspace"]
                  },
        "flash.execute": (params) => ({ code: 0, lines: ["** Programming Finished **"], remember: !!params.remember }),
        "flash.verify": () => ({ code: 0, lines: ["** Verified OK **"] })
    });
    const other = await startBridge(path.join(base, "other"), { "config.get": () => ({ workspace: "other" }) });
    try {
        await scenario("List default toolsets with annotations", async () => {
            const { client } = await connect();
            const { tools } = await client.listTools();
            const names = tools.map((tool) => tool.name);
            assert.ok(names.includes("variables_write") && !names.some((name) => name.startsWith("cubemx_")));
            const write = tools.find((tool) => tool.name === "variables_write");
            assert.strictEqual(write.annotations.destructiveHint, true);
            assert.strictEqual(write.annotations.readOnlyHint, false);
            assert.ok(client.getInstructions().includes("Never guess"));
            await client.close();
        });

        await scenario("Call the Bridge as the MCP channel and resolve the workspace from roots", async () => {
            const { client, state } = await connect({ roots: [workspace] });
            const first = await client.callTool({ name: "config_get", arguments: {} });
            assert.deepStrictEqual(first.structuredContent, { workspace });
            assert.deepStrictEqual(bridge.metas.at(-1), { channel: "mcp", client: "test-client/9.9.9" });
            state.roots = [path.join(base, "other")];
            await client.sendRootsListChanged();
            await new Promise((resolve) => setTimeout(resolve, 20));
            const second = await client.callTool({ name: "config_get", arguments: {} });
            assert.deepStrictEqual(second.structuredContent, { workspace: "other" }, "roots changes re-locate");
            await client.close();
        });

        await scenario("Fall back to the working directory and honor EMBERPROBE_WORKSPACE", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: path.join(workspace, "src") } });
            assert.deepStrictEqual((await client.callTool({ name: "config_get", arguments: {} })).structuredContent, {
                workspace
            });
            await client.close();
            const fallback = await connect();
            const missing = await fallback.client.callTool({ name: "config_get", arguments: {} });
            assert.strictEqual(missing.isError, true);
            assert.strictEqual(missing.structuredContent.error.code, "BRIDGE_UNAVAILABLE");
            assert.strictEqual(missing.structuredContent.type, "diagnostic", "same shape as skill diagnostics");
            await fallback.client.close();
        });

        await scenario("Execute only after the user approves through elicitation", async () => {
            const { client, elicitations } = await connect({
                elicitation: true,
                env: { EMBERPROBE_WORKSPACE: workspace },
                answer: { action: "accept", content: { decision: "once" } }
            });
            const before = bridge.calls.length;
            const result = await client.callTool({
                name: "variables_write",
                arguments: { values: [{ name: "kp", value: 0.5 }] }
            });
            assert.ok(!result.isError);
            assert.deepStrictEqual(result.structuredContent, {
                results: [{ name: "kp", written: 0.5, verified: true }],
                remember: false
            });
            const writes = bridge.calls.slice(before);
            assert.strictEqual(writes.length, 2);
            assert.strictEqual(writes[1].params.confirmationId, writes[0].params.confirmationId ?? "write-1");
            assert.ok(!JSON.stringify(result).includes("write-"), "the confirmation ID never reaches the agent");
            const schema = elicitations[0].requestedSchema.properties.decision;
            assert.deepStrictEqual(schema.enum, ["once", "workspace", "deny"]);
            assert.strictEqual(schema.default, "deny");
            assert.ok(elicitations[0].message.includes("kp @ 0x20000000: 0.1 → 0.5"));
            await client.close();
        });

        await scenario("Remember only when the user picks the workspace choice", async () => {
            const { client } = await connect({
                elicitation: true,
                env: { EMBERPROBE_WORKSPACE: workspace },
                answer: { action: "accept", content: { decision: "workspace" } }
            });
            const result = await client.callTool({
                name: "variables_write",
                arguments: { values: [{ name: "kp", value: 1 }] }
            });
            assert.strictEqual(result.structuredContent.remember, true);
            // Bridge 只给出 once 时不会出现 workspace 选项
            const peripheral = await connect({
                elicitation: true,
                env: { EMBERPROBE_WORKSPACE: workspace },
                answer: (params) => {
                    assert.deepStrictEqual(params.requestedSchema.properties.decision.enum, ["once", "deny"]);
                    return { action: "accept", content: { decision: "workspace" } };
                }
            });
            const denied = await peripheral.client.callTool({
                name: "peripherals_write",
                arguments: { writes: [{ target: "GPIOA.ODR", value: 1 }] }
            });
            assert.strictEqual(denied.structuredContent.error.code, "CONFIRMATION_DENIED", "unoffered choices deny");
            await client.close();
            await peripheral.client.close();
        });

        await scenario("End the operation when the user declines or cancels", async () => {
            for (const answer of [
                { action: "decline" },
                { action: "cancel" },
                { action: "accept", content: { decision: "deny" } }
            ]) {
                const { client } = await connect({
                    elicitation: true,
                    env: { EMBERPROBE_WORKSPACE: workspace },
                    answer
                });
                const before = bridge.calls.length;
                const result = await client.callTool({
                    name: "variables_write",
                    arguments: { values: [{ name: "kp", value: 2 }] }
                });
                assert.strictEqual(result.isError, true);
                assert.strictEqual(result.structuredContent.error.code, "CONFIRMATION_DENIED");
                assert.strictEqual(bridge.calls.length - before, 1, "no second write after a denial");
                await client.close();
            }
        });

        await scenario("Pass expired confirmations through without requesting a new one", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: workspace } });
            const before = bridge.calls.length;
            const result = await client.callTool({
                name: "variables_write",
                arguments: { values: [{ name: "kp", value: 3 }], confirmationId: "expired" }
            });
            assert.strictEqual(result.structuredContent.error.code, "WRITE_CONFIRMATION_INVALID");
            assert.strictEqual(bridge.calls.length - before, 1);
            await client.close();
        });

        await scenario("Return the plan for chat confirmation when elicitation is unavailable", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: workspace } });
            const plan = await client.callTool({
                name: "variables_write",
                arguments: { values: [{ name: "kp", value: 4 }] }
            });
            assert.ok(!plan.isError);
            assert.strictEqual(plan.structuredContent.confirmationRequired, true);
            assert.match(plan.structuredContent.confirmationId, /^write-/);
            assert.ok(plan.structuredContent.nextStep.includes("explicit answer"));
            const done = await client.callTool({
                name: "variables_write",
                arguments: {
                    values: [{ name: "kp", value: 4 }],
                    confirmationId: plan.structuredContent.confirmationId,
                    remember: true
                }
            });
            assert.strictEqual(done.structuredContent.remember, true);
            await client.close();
        });

        await scenario("Report timeouts of state-changing calls as unknown results", async () => {
            const server = createServer({
                env: { EMBERPROBE_WORKSPACE: workspace },
                call: async (_channel, _workspace, method) => {
                    throw Object.assign(new Error("Agent Bridge request timed out"), {
                        code: "BRIDGE_TIMEOUT",
                        details: { method, timeoutMs: 20000, elapsedMs: 20001 }
                    });
                }
            });
            const client = new Client({ name: "timeout", version: "1" });
            const [a, b] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(a), server.connect(b)]);
            const result = await client.callTool({ name: "debug_control", arguments: { action: "pause" } });
            assert.strictEqual(result.structuredContent.error.code, "BRIDGE_TIMEOUT");
            assert.strictEqual(result.structuredContent.error.details.resultUnknown, true);
            assert.strictEqual(result.structuredContent.error.retryable, false);
            await client.close();
        });

        await scenario("Forward cancellation to the Bridge's cancel method", async () => {
            const { client } = await connect({
                env: { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" }
            });
            const controller = new AbortController();
            const pending = client
                .callTool({ name: "cubemx_execute", arguments: { requestId: "r-1" } }, CallToolResultSchema, {
                    signal: controller.signal
                })
                .catch((error) => error);
            while (!bridge.calls.some((call) => call.method === "cubemx.execute"))
                await new Promise((resolve) => setTimeout(resolve, 5));
            controller.abort();
            await pending;
            await generation.promise;
            assert.ok(bridge.calls.some((call) => call.method === "cubemx.cancel"));
            await client.close();
        });

        await scenario("Send elapsed-time progress while waiting for the Bridge", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: workspace }, progressIntervalMs: 20 });
            const progress = [];
            const result = await client.callTool({ name: "debug_status", arguments: {} }, CallToolResultSchema, {
                onprogress: (value) => progress.push(value)
            });
            assert.deepStrictEqual(result.structuredContent, { state: "paused" });
            assert.ok(progress.length >= 1, "at least one progress notification");
            await client.close();
        });

        await scenario("Reject invalid arguments and unknown tools", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: workspace } });
            const before = bridge.calls.length;
            const invalid = await client.callTool({ name: "debug_control", arguments: { action: "erase" } });
            assert.strictEqual(invalid.structuredContent.error.code, "INVALID_PARAMS");
            assert.strictEqual(bridge.calls.length, before);
            await assert.rejects(client.callTool({ name: "cubemx_execute", arguments: {} }), /Unknown tool/);
            await client.close();
        });

        await scenario("Run flash preflight, confirmation and execution", async () => {
            const realPreflight = flashCommon.preflight;
            const elf = path.join(workspace, "app.elf");
            fs.writeFileSync(elf, "elf");
            const trusted = path.join(workspace, "trusted.elf");
            fs.writeFileSync(trusted, "elf");
            const plan = (file) => ({
                ready: true,
                workspace,
                elf: file,
                elfSha256: "ab".repeat(32),
                target: "target/stm32f4x.cfg",
                probe: "interface/stlink.cfg",
                openocd: "openocd",
                transport: "swd",
                probeSerial: "0001A",
                adapterSpeedKhz: 0,
                sources: { probeSerial: "inventory" },
                notes: [],
                diagnostics: []
            });
            try {
                flashCommon.preflight = async (options, deps) => {
                    assert.strictEqual(typeof deps.call, "function", "preflight uses the MCP channel");
                    return options.elf === "not-ready"
                        ? { ...plan(elf), ready: false, notes: ["No probe"] }
                        : plan(options.elf || elf);
                };
                const { client } = await connect({
                    elicitation: true,
                    env: { EMBERPROBE_WORKSPACE: workspace },
                    answer: { action: "accept", content: { decision: "once" } }
                });
                const before = bridge.calls.length;
                const notReady = await client.callTool({ name: "flash_program", arguments: { elf: "not-ready" } });
                assert.strictEqual(notReady.isError, true);
                assert.strictEqual(notReady.structuredContent.type, "preflight");
                assert.strictEqual(bridge.calls.length, before, "no confirmation for a failed preflight");
                const programmed = await client.callTool({ name: "flash_program", arguments: {} });
                assert.ok(!programmed.isError);
                assert.deepStrictEqual(programmed.structuredContent.lines, ["** Programming Finished **"]);
                const execute = bridge.calls.filter((call) => call.method === "flash.execute").at(-1);
                assert.strictEqual(execute.params.confirmationId, "flash-1");
                assert.strictEqual(execute.params.probeSerial, undefined, "inventory serials are not overrides");
                assert.ok(!JSON.stringify(programmed).includes("flash-1"));
                const remembered = await client.callTool({ name: "flash_program", arguments: { elf: trusted } });
                assert.strictEqual(
                    remembered.structuredContent.authorization.trustedExpiresAt,
                    "2026-10-22T00:00:00.000Z"
                );
                assert.strictEqual(bridge.calls.at(-1).params.confirmationId, undefined);
                const verified = await client.callTool({ name: "flash_verify", arguments: {} });
                assert.deepStrictEqual(verified.structuredContent.lines, ["** Verified OK **"]);
                const verify = bridge.calls.at(-1);
                assert.strictEqual(verify.method, "flash.verify");
                assert.strictEqual(verify.params.remember, undefined, "verification never remembers");
                await client.close();
            } finally {
                flashCommon.preflight = realPreflight;
            }
        });
    } finally {
        await bridge.service.dispose();
        await other.service.dispose();
        fs.rmSync(base, { recursive: true, force: true });
    }
    console.log("MCP server tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
