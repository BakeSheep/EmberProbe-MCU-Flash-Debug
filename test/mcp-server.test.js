"use strict";
// In-process MCP server against a real Agent Bridge: confirmation accept/decline/expiry, fallback without elicitation,
// confirmation IDs never leak, timeouts treated as unknown, cancellation forwarding, relocation after roots change,
// progress notifications and argument validation. Sensitive routes use the real authorization, flash, peripheral,
// CubeMX and debug check services, and confirmation messages render from the Bridge's real response shape.
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const YAML = require("yaml");
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
const { normalizeFileIdentity } = require("../skills/_emberprobe/file-identity");
const { createServer } = require("../src/mcp/server");
const { configSnippet, launcherSource } = require("../src/services/mcpRegistration");
const { WriteAuthorization, writeConnectionIdentity } = require("../src/writeAuthorization");
const { PeripheralWriteAuthorization } = require("../src/peripheralWriteAuthorization");
const { FlashAuthorization } = require("../src/flashAuthorization");
const { FirmwareRecord } = require("../src/services/firmwareRecord");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { SvdPeripheralService } = require("../src/services/svdPeripheralService");
const { CubeMxService } = require("../src/services/cubemxService");
const { parseIoc } = require("../src/services/cubemxProject");
const { AgentDebugInspection } = require("../src/services/agentDebugInspection");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { encodeValue, decodeValue, decodeValueText } = require("../src/elfSymbols");
const { minimalElf } = require("./helpers/elf-fixture");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-server-")));
const storageDir = path.join(base, "storage");
process.env.EMBERPROBE_BRIDGE_REGISTRY = path.join(storageDir, REGISTRY_DIR);
delete process.env.EMBERPROBE_BRIDGE_INSTANCE;
delete process.env.EMBERPROBE_WORKSPACE;

function memoryStorage() {
    const values = new Map();
    return {
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }
    };
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

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
fs.mkdirSync(workspace, { recursive: true });
let confirmations = 0;

// variables.write: the plan and the confirmation response come from the real WriteAuthorization, composed
// the way MainViewProvider._writeAgentVariables answers ({ ...authorization.response, ...consistency }).
const firmware = { path: path.join(workspace, "app.elf"), sha256: "cd".repeat(32) };
const writeAuthorization = new WriteAuthorization(memoryStorage(), { createId: () => `write-${++confirmations}` });
function writePlan(values) {
    return {
        elfResult: { elf: firmware },
        connection: writeConnectionIdentity({
            probe: "interface/stlink.cfg",
            target: "target/stm32f4x.cfg",
            transport: "swd",
            probeSerial: "0001A",
            openocd: "openocd"
        }),
        items: values.map((request, index) => {
            const bytes = encodeValue(request.value, "f32");
            return {
                requestedName: request.name,
                name: request.name,
                address: 0x20000000 + index * 4,
                type: "f32",
                size: 4,
                bytes,
                value: decodeValue(bytes, "f32"),
                valueText: decodeValueText(bytes, "f32")
            };
        })
    };
}
async function writeHandler(params) {
    const plan = writePlan(params.values);
    const consistency = { firmwareConsistency: new FirmwareRecord(null).check(firmware) };
    const authorization = writeAuthorization.authorize(plan, {
        confirmationId: params.confirmationId,
        remember: params.remember
    });
    if (!authorization.authorized) return { ...authorization.response, ...consistency };
    const permission = authorization.remember
        ? { mode: "workspace", ...(await writeAuthorization.trustWorkspace(plan)), remembered: true }
        : { mode: authorization.mode, trusted: writeAuthorization.isTrusted(plan) };
    return {
        source: "active-sampling",
        elf: firmware,
        results: plan.items.map((item) => ({ name: item.requestedName, written: item.value, verified: true })),
        halted: false,
        ...consistency,
        permission
    };
}

// peripherals.write: the real SvdPeripheralService plans, confirms and verifies against a paused fake target.
const svdPath = path.join(workspace, "device.svd");
const SVD = `<?xml version="1.0"?>
<device><name>TEST</name><size>32</size><peripherals><peripheral><name>GPIOA</name>
<baseAddress>0x40020000</baseAddress><registers><register><name>ODR</name><addressOffset>0x14</addressOffset>
<access>read-write</access><fields><field><name>ODR5</name><bitOffset>5</bitOffset><bitWidth>1</bitWidth></field>
</fields></register></registers></peripheral></peripherals></device>`;
fs.writeFileSync(svdPath, SVD);
const registers = new Map([[0x40020014, Buffer.from([0x01, 0, 0, 0])]]);
const peripherals = new SvdPeripheralService({
    loadBoundSvd: async () => ({ path: svdPath }),
    authorization: new PeripheralWriteAuthorization({ createId: () => `p-${++confirmations}` }),
    debugBridge: {
        activeSession: { id: "debug-1" },
        assertPausedAccess() {},
        agentStatus: () => ({ state: "paused", epoch: 3, session: { id: "debug-1" } }),
        readPausedMemory: async (address, count) =>
            Uint8Array.from((registers.get(address) || Buffer.alloc(count)).subarray(0, count)),
        writePausedMemory: async (address, bytes) => {
            registers.set(address, Buffer.from(bytes));
            return { bytesWritten: bytes.length };
        }
    }
});

// flash.authorize/execute/verify: the real AgentFlashService with OpenOCD and the probe replaced.
const elfFile = path.join(workspace, "app.elf");
fs.writeFileSync(elfFile, minimalElf());
const elfDigest = sha256(fs.readFileSync(elfFile));
const flashRuns = [];
const flash = new AgentFlashService({
    getConfig: () => ({ openocdPath: process.execPath }),
    coordinator: new ProbeCoordinator(),
    authorization: new FlashAuthorization({ storage: memoryStorage(), createId: () => `flash-${++confirmations}` }),
    isDebugActive: () => false,
    resolveLaunch: (executable) => ({ executable }),
    check: async () => ({ compatible: true, version: "test" }),
    prepare: async (request) => ({ ...request, probeSerial: "0001A" }),
    run: async (options) => {
        flashRuns.push(options);
        // Programming also verifies; only flash.verify reports through the EP_VERIFY marker.
        const verify = options.buildCommands().join("\n").includes("EP_VERIFY");
        if (verify) options.onLine("EP_VERIFY OK");
        return {
            exitCode: 0,
            openocdTail: [verify ? "EP_VERIFY OK" : "** Programming Finished **"],
            commands: options.buildCommands()
        };
    }
});

// cubemx.*: the real CubeMxService on a workspace project; only the CubeMX process is replaced.
const IOC = [
    "Mcu.Name=STM32F407VGTx",
    "MxCube.Version=6.12.0",
    "ProjectManager.ProjectName=demo",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
    "ProjectManager.UnderRoot=true",
    "USART2.BaudRate=9600",
    ""
].join("\n");
const cubeProject = path.join(workspace, "cube");
const ioc = path.join(cubeProject, "demo.ioc");
fs.mkdirSync(cubeProject, { recursive: true });
fs.writeFileSync(ioc, IOC);
fs.writeFileSync(path.join(cubeProject, "main.c"), "baud=9600;\n");
fs.writeFileSync(path.join(cubeProject, "app.c"), "business code\n");
let cubeGate = null;
const cube = new CubeMxService({
    platform: "win32",
    storage: memoryStorage(),
    storageDir: path.join(base, "cubemx-storage"),
    stagingDir: path.join(base, "cubemx-stage"),
    config: () => ({ iocPath: ioc }),
    roots: () => [workspace],
    installation: async () => ({ executable: "STM32CubeMX.exe", version: "6.12.0" }),
    run: async (_tool, directory, name, options) => {
        if (cubeGate) await cubeGate(options.signal);
        const values = parseIoc(await fs.promises.readFile(path.join(directory, name), "utf8"));
        await fs.promises.writeFile(path.join(directory, "main.c"), `baud=${values["USART2.BaudRate"]};\n`);
        return { log: "generated" };
    }
});
// Candidates live in the workspace but outside the generated project directory.
const candidates = path.join(workspace, "candidates");
fs.mkdirSync(candidates, { recursive: true });
const candidate = (baud) => {
    const file = path.join(candidates, `candidate-${baud}.ioc`);
    fs.writeFileSync(file, IOC.replace("USART2.BaudRate=9600", `USART2.BaudRate=${baud}`));
    return file;
};
const currentBaud = () => parseIoc(fs.readFileSync(ioc, "utf8"))["USART2.BaudRate"];

// debug.inspect: the real AgentDebugInspection over a paused native session.
const dapCalls = [];
const debugBridge = new DebugSessionBridge({ trackSessions: false });
debugBridge.sessions.set("core-0", {
    id: "core-0",
    type: "emberprobe",
    async customRequest(command, params) {
        dapCalls.push({ command, params });
        if (command === "threads") return { body: { threads: [{ id: 7, name: "Worker" }] } };
        if (command === "stackTrace") return { stackFrames: [{ id: 0, name: "app_main", line: 42 }], totalFrames: 1 };
        if (command === "scopes") return { scopes: [{ name: "Locals", variablesReference: 10, expensive: false }] };
        if (command === "variables")
            return { variables: [{ name: "count", type: "int", value: "3", variablesReference: 0 }] };
        throw new Error(`Unexpected DAP command ${command}`);
    }
});
debugBridge.paused = true;
debugBridge.stopEpoch = 1;
const inspection = new AgentDebugInspection(debugBridge);

(async () => {
    const bridge = await startBridge(workspace, {
        "config.get": () => ({ workspace }),
        "variables.write": writeHandler,
        "peripherals.write": (params) => peripherals.write(params),
        "debug.status": () => new Promise((resolve) => setTimeout(() => resolve({ state: "paused" }), 120)),
        "debug.inspect": (params) => inspection.inspect(params),
        "cubemx.candidate": (params) => cube.generateCandidate(params),
        "cubemx.prepare": (params) => cube.prepare(params),
        "cubemx.execute": (params) => cube.execute(params),
        "cubemx.start": (params) => cube.start(params),
        "cubemx.cancel": (params) => cube.cancel(params),
        "flash.authorize": (params) => flash.authorize(params),
        "flash.execute": (params) => flash.execute(params),
        "flash.verify": (params) => flash.execute(params, true)
    });
    const other = await startBridge(path.join(base, "other"), { "config.get": () => ({ workspace: "other" }) });
    const callsSince = (before) => bridge.calls.slice(before).map((call) => call.method);
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

        await scenario("Launch exported Antigravity and DSH configurations over stdio without roots", async () => {
            const launcher = path.join(base, "external-client-launcher.js");
            fs.writeFileSync(launcher, launcherSource(require.resolve("../src/mcp/server")));
            const spec = {
                command: process.execPath,
                args: [launcher],
                env: {
                    ELECTRON_RUN_AS_NODE: "1",
                    EMBERPROBE_MCP_TOOLSETS: "core",
                    EMBERPROBE_BRIDGE_REGISTRY: process.env.EMBERPROBE_BRIDGE_REGISTRY
                }
            };
            for (const name of ["antigravity", "dsh"]) {
                const snippet = configSnippet(name, spec, process.platform, workspace);
                const config =
                    name === "antigravity"
                        ? JSON.parse(snippet).mcpServers.emberprobe
                        : YAML.parse(snippet)[0].insert[0].config;
                const client = new Client({ name: `test-${name}`, version: "1.0.0" }, { capabilities: {} });
                const transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args,
                    env: config.env,
                    cwd: base
                });
                try {
                    await client.connect(transport);
                    const tools = await client.listTools();
                    assert.ok(tools.tools.some((tool) => tool.name === "config_get"));
                    assert.ok(
                        !tools.tools.some((tool) => tool.name === "debug_start"),
                        "toolset selection is preserved"
                    );
                    const result = await client.callTool({ name: "config_get", arguments: {} });
                    assert.ok(!result.isError, JSON.stringify(result));
                    assert.deepStrictEqual(result.structuredContent, { workspace });
                } finally {
                    await client.close();
                    await transport.close();
                }
            }
        });

        await scenario("Execute a variable write only after the user approves its items", async () => {
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
            assert.deepStrictEqual(result.structuredContent.results, [{ name: "kp", written: 0.5, verified: true }]);
            assert.deepStrictEqual(result.structuredContent.permission, { mode: "once", trusted: false });
            const writes = bridge.calls.slice(before);
            assert.strictEqual(writes.length, 2);
            assert.strictEqual(writes[0].params.confirmationId, undefined);
            assert.match(writes[1].params.confirmationId, /^write-\d+$/);
            assert.ok(!JSON.stringify(result).includes("write-"), "the confirmation ID never reaches the agent");
            const schema = elicitations[0].requestedSchema.properties.decision;
            assert.deepStrictEqual(schema.enum, ["once", "workspace", "deny"]);
            assert.strictEqual(schema.default, "deny");
            const message = elicitations[0].message;
            assert.ok(message.includes(`ELF: ${firmware.path}`), message);
            assert.ok(message.includes(`ELF SHA-256: ${firmware.sha256}`), message);
            assert.ok(message.includes("Connection: target/stm32f4x.cfg via interface/stlink.cfg serial 0001A"));
            assert.ok(message.includes("Writes:\n  - kp @ 0x20000000 (f32): 0.5"), message);
            assert.ok(!message.includes("[object Object]"), message);
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
            assert.strictEqual(result.structuredContent.permission.remembered, true);
            await writeAuthorization.reset();
            // With only once from the Bridge there is no workspace option
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
                arguments: { writes: [{ target: "GPIOA.ODR.ODR5", value: 1 }] }
            });
            assert.strictEqual(denied.structuredContent.error.code, "CONFIRMATION_DENIED", "unoffered choices deny");
            assert.deepStrictEqual([...registers.get(0x40020014)], [0x01, 0, 0, 0], "a denied write never runs");
            await client.close();
            await peripheral.client.close();
        });

        await scenario("Show the SVD, register and requested fields before a peripheral write", async () => {
            const { client, elicitations } = await connect({
                elicitation: true,
                env: { EMBERPROBE_WORKSPACE: workspace },
                answer: { action: "accept", content: { decision: "once" } }
            });
            const result = await client.callTool({
                name: "peripherals_write",
                arguments: { writes: [{ target: "GPIOA.ODR.ODR5", value: 1 }] }
            });
            assert.ok(!result.isError, JSON.stringify(result.structuredContent));
            assert.strictEqual(result.structuredContent.results[0].readBack, "0x00000021");
            const message = elicitations[0].message;
            assert.ok(message.includes(`SVD: ${svdPath}`), message);
            assert.ok(message.includes(`SVD SHA-256: ${sha256(SVD)}`), message);
            assert.ok(
                message.includes("Writes:\n  - GPIOA.ODR @ 0x40020014: 0x00000001 → 0x00000021 [GPIOA.ODR.ODR5 = 1]"),
                message
            );
            assert.ok(!message.includes("[object Object]"), message);
            const { confirmationId } = bridge.calls.at(-1).params;
            assert.match(confirmationId, /^p-\d+$/);
            assert.ok(!JSON.stringify(result).includes(confirmationId), "the confirmation ID never reaches the agent");
            await client.close();
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
            assert.deepStrictEqual(plan.structuredContent.items, [
                { name: "kp", address: "0x20000000", type: "f32", value: 4 }
            ]);
            assert.ok(plan.structuredContent.nextStep.includes("explicit answer"));
            const done = await client.callTool({
                name: "variables_write",
                arguments: {
                    values: [{ name: "kp", value: 4 }],
                    confirmationId: plan.structuredContent.confirmationId,
                    remember: true
                }
            });
            assert.strictEqual(done.structuredContent.permission.remembered, true);
            await writeAuthorization.reset();
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
            // Suggested actions point at MCP tools rather than CLI arguments
            const advice = result.structuredContent.error.suggestedActions.join("\n");
            assert.ok(advice.includes("debug_status") && !advice.includes("--status"));
            assert.deepStrictEqual(result.structuredContent.error.actions, [{ method: "debug.status" }]);
            await client.close();
        });

        await scenario("Plan CubeMX generation with cubemx.prepare and ask before executing", async () => {
            const env = { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" };
            const { client, elicitations } = await connect({
                elicitation: true,
                env,
                answer: { action: "accept", content: { decision: "once" } }
            });
            const candidatePath = candidate(115200);
            // A prepare result never carries an ID the agent could use to skip the user's approval.
            const prepared = await client.callTool({ name: "cubemx_prepare", arguments: { candidatePath } });
            assert.ok(!prepared.isError, JSON.stringify(prepared.structuredContent));
            assert.strictEqual(prepared.structuredContent.confirmationRequired, true);
            assert.strictEqual(prepared.structuredContent.confirmationId, undefined);
            assert.ok(prepared.structuredContent.nextStep.includes("cubemx_execute"));
            assert.strictEqual(prepared.structuredContent.changes[0].requested, "115200");

            const before = bridge.calls.length;
            const result = await client.callTool({ name: "cubemx_execute", arguments: { candidatePath } });
            assert.ok(!result.isError, JSON.stringify(result.structuredContent));
            assert.strictEqual(result.structuredContent.generated, true);
            assert.deepStrictEqual(callsSince(before), ["cubemx.prepare", "cubemx.execute"]);
            const [plan, execution] = bridge.calls.slice(before);
            assert.strictEqual(plan.params.candidateHash, sha256(fs.readFileSync(candidatePath)));
            assert.ok(execution.params.confirmationId, "execution consumes the prepared confirmation");
            assert.ok(!JSON.stringify(result).includes(execution.params.confirmationId));
            assert.strictEqual(currentBaud(), "115200");
            assert.strictEqual(fs.readFileSync(path.join(cubeProject, "main.c"), "utf8"), "baud=115200;\n");
            const message = elicitations[0].message;
            assert.deepStrictEqual(elicitations[0].requestedSchema.properties.decision.enum, [
                "once",
                "workspace",
                "deny"
            ]);
            assert.ok(message.includes(`CubeMX .ioc: ${ioc}`), message);
            assert.ok(message.includes(`Candidate .ioc: ${candidatePath}`), message);
            assert.ok(message.includes("STM32CubeMX: STM32CubeMX.exe (6.12.0)"), message);
            assert.ok(message.includes("Changes:\n  - USART2.BaudRate: 9600 → 115200"), message);
            assert.ok(!message.includes("[object Object]"), message);
            await client.close();
        });

        await scenario("Leave the .ioc untouched when the user declines CubeMX generation", async () => {
            const { client } = await connect({
                elicitation: true,
                env: { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" },
                answer: { action: "accept", content: { decision: "deny" } }
            });
            const before = bridge.calls.length;
            for (const name of ["cubemx_execute", "cubemx_start"]) {
                const result = await client.callTool({ name, arguments: { candidatePath: candidate(4800) } });
                assert.strictEqual(result.structuredContent.error.code, "CONFIRMATION_DENIED");
            }
            assert.deepStrictEqual(callsSince(before), ["cubemx.prepare", "cubemx.prepare"]);
            assert.strictEqual(currentBaud(), "115200");
            await client.close();
        });

        await scenario("Return the CubeMX plan for chat confirmation without elicitation", async () => {
            const { client } = await connect({
                env: { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" }
            });
            const candidatePath = candidate(57600);
            const before = bridge.calls.length;
            const pending = await client.callTool({ name: "cubemx_execute", arguments: { candidatePath } });
            assert.ok(!pending.isError, JSON.stringify(pending.structuredContent));
            assert.deepStrictEqual(callsSince(before), ["cubemx.prepare"]);
            const plan = pending.structuredContent;
            assert.strictEqual(plan.confirmationRequired, true);
            assert.ok(plan.confirmationId && plan.requestId && plan.nextStep.includes("explicit answer"));
            assert.strictEqual(plan.candidatePath, candidatePath);
            assert.strictEqual(plan.changes[0].requested, "57600");
            assert.strictEqual(currentBaud(), "115200", "nothing runs before the user answers");
            const done = await client.callTool({
                name: "cubemx_execute",
                arguments: { candidatePath, confirmationId: plan.confirmationId, requestId: plan.requestId }
            });
            assert.ok(!done.isError, JSON.stringify(done.structuredContent));
            assert.strictEqual(bridge.calls.at(-1).params.confirmationId, plan.confirmationId);
            assert.strictEqual(currentBaud(), "57600");
            await client.close();
        });

        await scenario("Resolve relative CubeMX paths against the workspace, not the server's cwd", async () => {
            // The client launched the server from `base`; the workspace is a different directory.
            const { client } = await connect({
                env: { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" }
            });
            const relative = path.join("candidates", "relative.ioc");
            const absolute = path.join(candidates, "relative.ioc");
            const written = await client.callTool({
                name: "cubemx_candidate",
                arguments: { outputPath: relative, changes: { "USART2.BaudRate": "230400" } }
            });
            assert.ok(!written.isError, JSON.stringify(written.structuredContent));
            assert.strictEqual(bridge.calls.at(-1).params.outputPath, absolute);
            assert.ok(fs.readFileSync(absolute, "utf8").includes("USART2.BaudRate=230400"));
            assert.ok(!fs.existsSync(path.join(base, relative)), "nothing is written under the server's cwd");

            const prepared = await client.callTool({ name: "cubemx_prepare", arguments: { candidatePath: relative } });
            assert.ok(!prepared.isError, JSON.stringify(prepared.structuredContent));
            assert.strictEqual(bridge.calls.at(-1).params.candidatePath, absolute);
            assert.strictEqual(prepared.structuredContent.changes[0].requested, "230400");

            const before = bridge.calls.length;
            const pending = await client.callTool({ name: "cubemx_execute", arguments: { candidatePath: relative } });
            assert.ok(!pending.isError, JSON.stringify(pending.structuredContent));
            assert.deepStrictEqual(callsSince(before), ["cubemx.prepare"]);
            assert.strictEqual(bridge.calls.at(-1).params.candidateHash, sha256(fs.readFileSync(absolute)));
            assert.strictEqual(pending.structuredContent.candidatePath, absolute);
            assert.strictEqual(currentBaud(), "57600", "nothing runs before the user answers");
            await client.close();
        });

        await scenario("Generate without asking again under a remembered CubeMX permission", async () => {
            const decisions = ["workspace"];
            const { client, elicitations } = await connect({
                elicitation: true,
                env: { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" },
                answer: () => ({ action: "accept", content: { decision: decisions.shift() || "deny" } })
            });
            const remembered = await client.callTool({
                name: "cubemx_execute",
                arguments: { candidatePath: candidate(38400) }
            });
            assert.ok(!remembered.isError, JSON.stringify(remembered.structuredContent));
            assert.strictEqual(bridge.calls.at(-1).params.remember, true);
            const before = bridge.calls.length;
            const started = await client.callTool({
                name: "cubemx_start",
                arguments: { candidatePath: candidate(19200) }
            });
            assert.ok(!started.isError, JSON.stringify(started.structuredContent));
            assert.strictEqual(elicitations.length, 1, "a remembered permission skips the dialog");
            assert.deepStrictEqual(callsSince(before), ["cubemx.prepare", "cubemx.start"]);
            assert.strictEqual(bridge.calls.at(-1).params.confirmationId, undefined);
            await cube.activeExecutions.get(started.structuredContent.operationId);
            assert.strictEqual(currentBaud(), "19200");
            await client.close();
        });

        await scenario("Forward cancellation to the Bridge's cancel method", async () => {
            const { client } = await connect({
                env: { EMBERPROBE_WORKSPACE: workspace, EMBERPROBE_MCP_TOOLSETS: "cubemx" }
            });
            let entered;
            const running = new Promise((resolve) => {
                entered = resolve;
            });
            cubeGate = (signal) =>
                new Promise((_resolve, reject) => {
                    entered();
                    signal.addEventListener("abort", () => reject(new Error("CubeMX cancelled")), { once: true });
                });
            const controller = new AbortController();
            const pending = client
                .callTool({ name: "cubemx_execute", arguments: { requestId: "r-1" } }, CallToolResultSchema, {
                    signal: controller.signal
                })
                .catch((error) => error);
            await running;
            controller.abort();
            await pending;
            while (cube.jobs.size) await new Promise((resolve) => setTimeout(resolve, 5));
            cubeGate = null;
            assert.ok(bridge.calls.some((call) => call.method === "cubemx.cancel"));
            await client.close();
        });

        await scenario("Inspect a paused session with the Bridge's string handles", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: workspace } });
            const stack = await client.callTool({
                name: "debug_inspect",
                arguments: { action: "stack", threadId: 7 }
            });
            assert.ok(!stack.isError, JSON.stringify(stack.structuredContent));
            const frame = stack.structuredContent.stackFrames[0].frame;
            assert.strictEqual(typeof frame, "string");
            const scopes = await client.callTool({ name: "debug_inspect", arguments: { action: "scopes", frame } });
            assert.ok(!scopes.isError, JSON.stringify(scopes.structuredContent));
            assert.strictEqual(dapCalls.at(-1).params.frameId, 0);
            const variables = await client.callTool({
                name: "debug_inspect",
                arguments: { action: "variables", reference: scopes.structuredContent.scopes[0].reference, count: 5 }
            });
            assert.ok(!variables.isError, JSON.stringify(variables.structuredContent));
            assert.deepStrictEqual(dapCalls.at(-1).params, {
                variablesReference: 10,
                start: 0,
                count: 5,
                filter: undefined
            });
            assert.strictEqual(variables.structuredContent.variables[0].value, "3");
            const before = bridge.calls.length;
            const numeric = await client.callTool({ name: "debug_inspect", arguments: { action: "scopes", frame: 0 } });
            assert.strictEqual(numeric.structuredContent.error.code, "INVALID_PARAMS", "DAP integers are not handles");
            assert.strictEqual(bridge.calls.length, before);
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

        await scenario("Serve workflow prompts built from the bundled skills", async () => {
            const { client } = await connect({ env: { EMBERPROBE_WORKSPACE: workspace } });
            const { prompts } = await client.listPrompts();
            assert.deepStrictEqual(
                prompts.map((prompt) => prompt.name),
                ["flash", "fault_triage", "variable_debug", "rtos_inspect"]
            );
            const flashPrompt = await client.getPrompt({ name: "flash", arguments: { goal: "Flash build/app.elf" } });
            const text = flashPrompt.messages[0].content.text;
            assert.ok(text.startsWith("Task: Flash build/app.elf"));
            assert.ok(text.includes("`scripts/program.js` → flash_program") && text.includes("# MCU Flash"));
            await assert.rejects(client.getPrompt({ name: "cubemx_generate" }), /Unknown prompt/);
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
            const plan = (file) => ({
                ready: true,
                workspace,
                elf: file,
                elfSha256: elfDigest,
                target: "target/stm32f4x.cfg",
                probe: "interface/stlink.cfg",
                openocd: process.execPath,
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
                        ? { ...plan(elfFile), ready: false, notes: ["No probe"] }
                        : plan(options.elf || elfFile);
                };
                const decisions = ["once", "workspace", "once"];
                const { client, elicitations } = await connect({
                    elicitation: true,
                    env: { EMBERPROBE_WORKSPACE: workspace },
                    answer: () => ({ action: "accept", content: { decision: decisions.shift() || "deny" } })
                });
                const before = bridge.calls.length;
                const notReady = await client.callTool({ name: "flash_program", arguments: { elf: "not-ready" } });
                assert.strictEqual(notReady.isError, true);
                assert.strictEqual(notReady.structuredContent.type, "preflight");
                assert.strictEqual(bridge.calls.length, before, "no confirmation for a failed preflight");

                const programmed = await client.callTool({ name: "flash_program", arguments: {} });
                assert.ok(!programmed.isError, JSON.stringify(programmed.structuredContent));
                assert.strictEqual(programmed.structuredContent.verified, true);
                assert.deepStrictEqual(programmed.structuredContent.lines, ["** Programming Finished **"]);
                const execute = bridge.calls.filter((call) => call.method === "flash.execute").at(-1);
                assert.match(execute.params.confirmationId, /^flash-\d+$/);
                assert.strictEqual(execute.params.probeSerial, undefined, "inventory serials are not overrides");
                assert.ok(!JSON.stringify(programmed).includes(execute.params.confirmationId));
                const message = elicitations[0].message;
                // The Bridge binds the confirmation to the normalized file identity, which is what the user sees.
                assert.ok(message.includes(`ELF: ${normalizeFileIdentity(elfFile)}`), message);
                assert.ok(message.includes(`ELF SHA-256: ${elfDigest}`), message);
                assert.ok(message.includes("Target: target/stm32f4x.cfg"), message);
                assert.ok(message.includes("Probe serial: 0001A"), message);
                assert.ok(!message.includes("[object Object]"), message);

                const remember = await client.callTool({ name: "flash_program", arguments: {} });
                assert.ok(!remember.isError, JSON.stringify(remember.structuredContent));
                assert.strictEqual(bridge.calls.at(-1).params.remember, true);
                const remembered = await client.callTool({ name: "flash_program", arguments: {} });
                assert.strictEqual(typeof remembered.structuredContent.authorization.trustedExpiresAt, "string");
                assert.strictEqual(bridge.calls.at(-1).params.confirmationId, undefined);
                assert.strictEqual(elicitations.length, 2, "a remembered permission skips the dialog");

                const verified = await client.callTool({ name: "flash_verify", arguments: {} });
                assert.strictEqual(verified.structuredContent.verified, true);
                const verify = bridge.calls.at(-1);
                assert.strictEqual(verify.method, "flash.verify");
                assert.strictEqual(verify.params.remember, undefined, "verification never remembers");
                assert.strictEqual(flashRuns.length, 4);
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
