"use strict";
// MCP 工具目录与 Bridge 路由的漂移检查、只读注解来源、schema 严格性与工具集开关。
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { AjvJsonSchemaValidator } = require("@modelcontextprotocol/sdk/validation/ajv-provider.js");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const tools = require("../src/mcp/tools");
const { INSTRUCTIONS } = require("../src/mcp/server");
const { READ_ONLY_METHODS, OBSERVATION_METHODS } = require("../skills/_emberprobe/agent-client");

const routes = Object.keys(createAgentRoutes({}, () => []));
const validator = new AjvJsonSchemaValidator();

(async () => {
    await scenario("Map every tool to existing Bridge routes and every route to a tool", () => {
        const mapped = new Set();
        for (const tool of tools.TOOLS) {
            assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/, `${tool.name} must be snake_case`);
            assert.ok(tools.TOOLSETS.includes(tool.toolset), `${tool.name} has an unknown toolset`);
            for (const method of tool.methods) {
                assert.ok(routes.includes(method), `${tool.name} maps to missing route ${method}`);
                mapped.add(method);
            }
            assert.ok(tool.kind === "flash" || typeof tool.request === "function", `${tool.name} has no request`);
        }
        assert.strictEqual(new Set(tools.TOOLS.map((tool) => tool.name)).size, tools.TOOLS.length);
        for (const method of routes)
            assert.ok(
                mapped.has(method) || tools.EXCLUDED_METHODS.includes(method),
                `route ${method} is neither mapped to an MCP tool nor explicitly excluded`
            );
        for (const method of tools.EXCLUDED_METHODS) assert.ok(routes.includes(method), `stale exclusion ${method}`);
    });

    await scenario("Derive read-only annotations from the shared method sets", () => {
        for (const method of [...READ_ONLY_METHODS, ...OBSERVATION_METHODS])
            assert.ok(routes.includes(method), `method set lists unknown route ${method}`);
        for (const tool of tools.TOOLS) {
            const hints = tools.annotations(tool);
            assert.strictEqual(hints.openWorldHint, false);
            if (tool.methods.every((method) => READ_ONLY_METHODS.has(method)))
                assert.strictEqual(hints.readOnlyHint, true, `${tool.name} only uses retry-safe methods`);
            if (hints.readOnlyHint)
                assert.ok(
                    tool.methods.every((method) => OBSERVATION_METHODS.has(method)),
                    `${tool.name} mutates`
                );
            if (tool.confirm || tool.destructive || tool.mutates)
                assert.strictEqual(hints.readOnlyHint, false, `${tool.name} cannot be read-only`);
        }
        const byName = Object.fromEntries(tools.TOOLS.map((tool) => [tool.name, tools.annotations(tool)]));
        assert.strictEqual(byName.chip_read.readOnlyHint, true);
        assert.strictEqual(byName.chip_read.idempotentHint, false, "hardware reads are not retry-safe");
        assert.strictEqual(byName.permission_get.readOnlyHint, true);
        assert.strictEqual(byName.permission_reset.readOnlyHint, false);
        for (const name of ["flash_program", "variables_write", "peripherals_write", "cubemx_execute", "debug_control"])
            assert.strictEqual(byName[name].destructiveHint, true, `${name} must be destructive`);
        assert.strictEqual(byName.flash_verify.destructiveHint, false);
    });

    await scenario("Reject unknown and malformed arguments before reaching the Bridge", () => {
        for (const tool of tools.TOOLS) {
            assert.strictEqual(tool.inputSchema.type, "object");
            assert.strictEqual(tool.inputSchema.additionalProperties, false, `${tool.name} must reject extra fields`);
            const check = validator.getValidator(tool.inputSchema);
            assert.strictEqual(check({ unexpected: true }).valid, false, `${tool.name} accepted an extra field`);
        }
        const schema = (name) => validator.getValidator(tools.TOOLS.find((tool) => tool.name === name).inputSchema);
        assert.strictEqual(schema("config_set")({ values: { openocdPath: "/tmp/x" } }).valid, false);
        assert.strictEqual(schema("config_set")({ values: { mcu: "target/stm32f4x.cfg" } }).valid, true);
        assert.strictEqual(schema("flash_program")({ transport: "usb" }).valid, false);
        assert.strictEqual(schema("flash_program")({ probeSerial: "0001A" }).valid, true);
        assert.strictEqual(schema("flash_verify")({ remember: true }).valid, false, "verification never remembers");
        assert.strictEqual(schema("variables_read")({ variables: [] }).valid, false);
        assert.strictEqual(schema("variables_read")({ variables: ["tick", { name: "kp", type: "f32" }] }).valid, true);
        assert.strictEqual(schema("debug_control")({ action: "erase" }).valid, false);
        assert.strictEqual(schema("debug_inspect")({ action: "variables", reference: 3, count: 101 }).valid, false);
    });

    await scenario("Translate arguments to Bridge requests", () => {
        const tool = (name) => tools.TOOLS.find((item) => item.name === name);
        // probeSerial 原样传递；写入值统一为字符串
        assert.deepStrictEqual(tool("variables_read").request({ variables: ["tick", { name: "kp", type: "f32" }] }), {
            method: "variables.read",
            params: { variables: [{ name: "tick" }, { name: "kp", type: "f32" }] }
        });
        assert.deepStrictEqual(tool("chip_read").request({ fields: ["pc"] }).params, { sections: [], fields: ["pc"] });
        assert.deepStrictEqual(tool("chip_read").request({}).params, { sections: ["identity"], fields: [] });
        assert.deepStrictEqual(tool("permission_reset").request({ kind: "variables" }), {
            method: "variables.write.permission",
            params: { action: "reset" }
        });
        assert.deepStrictEqual(tool("sampling_control").request({ action: "stop", intervalMs: 50 }), {
            method: "sampling.stop",
            params: {}
        });
        assert.deepStrictEqual(
            tool("peripherals_write").request({ writes: [{ target: "GPIOA.ODR", value: 1 }] }).params,
            {
                writes: [{ target: "GPIOA.ODR", value: "1" }]
            }
        );
        const csv = tool("variables_export_csv").request({ lastSeconds: 10, to: "2026-01-01T00:00:10Z" }).params;
        assert.strictEqual(csv.to - csv.from, 10000);
        assert.throws(() => tool("variables_export_csv").request({ from: "yesterday" }), { code: "INVALID_CSV_RANGE" });
        assert.throws(() => tool("variables_export_csv").request({ from: 1, lastSeconds: 1 }), {
            code: "INVALID_CSV_RANGE"
        });
        const sample = tool("variables_sample").request({ variables: ["x"], count: 3, intervalMs: 1000 });
        assert.strictEqual(sample.timeoutMs, 33000);
        const first = tool("cubemx_execute").request({});
        assert.ok(first.params.requestId, "generation calls carry an idempotency key");
        assert.strictEqual(tool("cubemx_execute").request({ requestId: "r1" }).params.requestId, "r1");
        assert.deepStrictEqual(tool("cubemx_execute").cancel({}), { method: "cubemx.cancel", params: {} });
    });

    await scenario("Expose core and debug by default and CubeMX only on request", () => {
        assert.deepStrictEqual(tools.parseToolsets(""), ["core", "debug"]);
        assert.deepStrictEqual(tools.parseToolsets("core, CubeMX"), ["core", "cubemx"]);
        assert.deepStrictEqual(tools.parseToolsets("all"), ["core", "debug", "cubemx"]);
        assert.deepStrictEqual(tools.parseToolsets("unknown"), []);
        const names = tools.toolsFor(tools.parseToolsets("")).map((tool) => tool.name);
        assert.ok(names.includes("flash_program") && names.includes("debug_status"));
        assert.ok(!names.some((name) => name.startsWith("cubemx_")));
        assert.ok(Buffer.byteLength(INSTRUCTIONS, "utf8") <= 1536, "server instructions stay within 1.5 KB");
    });

    console.log("MCP tool catalog tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
