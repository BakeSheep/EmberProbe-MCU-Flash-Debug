"use strict";
// Drift checks between the MCP tool catalog and Bridge routes, read-only annotation sources, schema strictness and
// tool categories.
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AjvJsonSchemaValidator } = require("@modelcontextprotocol/sdk/validation/ajv-provider.js");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const tools = require("../src/mcp/tools");
const results = require("../src/mcp/results");
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
        assert.strictEqual(schema("debug_start")({ attach: "yes" }).valid, false);
        assert.strictEqual(schema("debug_start")({ attach: true }).valid, true);
        const debugStart = tools.TOOLS.find((tool) => tool.name === "debug_start");
        assert.deepStrictEqual(debugStart.request({ attach: true }), {
            method: "debug.start",
            params: { attach: true }
        });
        assert.deepStrictEqual(debugStart.request({}), { method: "debug.start", params: {} });
        assert.strictEqual(schema("debug_inspect")({ action: "variables", reference: "h", count: 101 }).valid, false);
        // The Bridge issues string handles; DAP integers must be rejected before reaching it.
        assert.strictEqual(schema("debug_inspect")({ action: "variables", reference: 3 }).valid, false);
        assert.strictEqual(schema("debug_inspect")({ action: "scopes", frame: 0 }).valid, false);
        assert.strictEqual(schema("debug_inspect")({ action: "scopes", frame: crypto.randomUUID() }).valid, true);
        assert.strictEqual(schema("debug_inspect")({ action: "variables", reference: "" }).valid, false);
    });

    await scenario("Plan CubeMX generation through cubemx.prepare and keep its confirmation ID from the agent", () => {
        const tool = (name) => tools.TOOLS.find((item) => item.name === name);
        for (const name of ["cubemx_start", "cubemx_execute"]) {
            assert.strictEqual(tool(name).confirm, true);
            const request = tool(name).request({});
            assert.deepStrictEqual(tool(name).plan(request.params), {
                method: "cubemx.prepare",
                params: { summary: true, full: false },
                timeoutMs: 30000,
                context: {}
            });
            const candidate = tool(name).plan({ candidatePath: "/ws/next.ioc", candidateHash: "ab", requestId: "r" });
            assert.deepStrictEqual(candidate.params, {
                summary: true,
                full: false,
                candidatePath: "/ws/next.ioc",
                candidateHash: "ab"
            });
            assert.deepStrictEqual(candidate.context, { candidatePath: "/ws/next.ioc" });
        }
        // Every confirm tool either returns its own plan or names the method that does.
        for (const item of tools.TOOLS.filter((entry) => entry.confirm && entry.kind !== "flash"))
            assert.ok(
                item.plan || !item.name.startsWith("cubemx_"),
                `${item.name} consumes a confirmation it cannot issue`
            );
        const prepared = tool("cubemx_prepare").result({
            ioc: "/ws/demo.ioc",
            changes: [],
            confirmationRequired: true,
            confirmationId: "secret",
            expiresAt: "2026-01-01T00:00:00.000Z",
            choices: ["once", "workspace", "deny"],
            question: "Allow?"
        });
        assert.deepStrictEqual(Object.keys(prepared).sort(), ["changes", "confirmationRequired", "ioc", "nextStep"]);
        assert.ok(prepared.nextStep.includes("cubemx_execute"));
        const trusted = { ioc: "/ws/demo.ioc", confirmationRequired: false, mode: "workspace" };
        assert.strictEqual(tool("cubemx_prepare").result(trusted), trusted);
    });

    await scenario("Route CubeMX2 operations, queries and candidate hashes", () => {
        const tool = (name) => tools.TOOLS.find((item) => item.name === name);
        const operations = [{ command: "peripherals enable", args: { peripheral: "USART1", override: true } }];
        assert.deepStrictEqual(tool("cubemx_query").request({ operations }), {
            method: "cubemx.query",
            params: { operations },
            timeoutMs: 360000
        });
        assert.ok(READ_ONLY_METHODS.has("cubemx.query"));
        const schema = (name) => validator.getValidator(tool(name).inputSchema);
        assert.strictEqual(schema("cubemx_query")({ operations }).valid, true);
        for (const args of [
            {},
            { operations: [] },
            { operations: [{ args: {} }] },
            { operations: [{ command: "x", extra: 1 }] }
        ])
            assert.strictEqual(schema("cubemx_query")(args).valid, false, JSON.stringify(args));
        assert.strictEqual(
            schema("cubemx_query")({ operations: [{ command: "x", args: { a: { b: 1 } } }] }).valid,
            false
        );
        const prepare = tool("cubemx_prepare").request({ operations }, {});
        assert.deepStrictEqual(prepare, {
            method: "cubemx.prepare",
            params: { summary: true, full: false, operations },
            timeoutMs: 360000
        });
        assert.strictEqual(tool("cubemx_prepare").request({}, {}).timeoutMs, 30000);
        const candidateHash = "a".repeat(64);
        const prepared = tool("cubemx_prepare").result({
            generator: "cubemx2",
            ioc: "/ws/c593.ioc2",
            candidateHash,
            confirmationId: "secret",
            question: "Allow?"
        });
        assert.strictEqual(prepared.confirmationId, undefined);
        assert.strictEqual(prepared.candidateHash, candidateHash);
        assert.ok(prepared.nextStep.includes(candidateHash));
        for (const name of ["cubemx_start", "cubemx_execute"]) {
            assert.strictEqual(schema(name)({ candidateHash }).valid, true);
            assert.strictEqual(schema(name)({ candidateHash: "ABC" }).valid, false);
            const request = tool(name).request({ candidateHash, requestId: "r" });
            assert.deepStrictEqual(request.params, { candidateHash, requestId: "r" });
            assert.deepStrictEqual(tool(name).plan(request.params).params, {
                summary: true,
                full: false,
                candidateHash
            });
        }
    });

    await scenario("Translate arguments to Bridge requests", () => {
        const tool = (name) => tools.TOOLS.find((item) => item.name === name);
        // probeSerial passes through unchanged; write values are always strings
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

    await scenario("Map the debugger, target and watch-list tools to their Bridge requests", () => {
        const tool = (name) => tools.TOOLS.find((item) => item.name === name);
        const valid = (name, args) => validator.getValidator(tool(name).inputSchema)(args).valid;
        assert.deepStrictEqual(tool("debug_start").request({}), { method: "debug.start", params: {} });
        assert.deepStrictEqual(tool("debug_start").request({ attach: true }).params, { attach: true });
        assert.ok(!valid("debug_start", { attach: "yes" }));
        assert.deepStrictEqual(tool("target_control").request({ action: "reset" }), {
            method: "target.control",
            params: { action: "reset" }
        });
        assert.ok(!valid("target_control", { action: "erase" }));
        assert.ok(valid("memory_read", { address: "0x20000000", length: 4096 }));
        assert.ok(valid("memory_read", { address: 536870912 }));
        assert.ok(!valid("memory_read", { address: "0x20000000", length: 4097 }));
        assert.ok(!valid("memory_read", { length: 4 }));
        assert.ok(valid("debug_evaluate", { expression: "sensor.x" }));
        assert.ok(!valid("debug_evaluate", { expression: "" }));
        assert.deepStrictEqual(tool("watch_remove").request({ variables: ["x"] }).params, {
            variables: ["x"],
            destination: "sidebar"
        });
        const hints = Object.fromEntries(tools.TOOLS.map((item) => [item.name, tools.annotations(item)]));
        for (const name of ["debug_evaluate", "memory_read", "variables_list", "watch_list"])
            assert.strictEqual(hints[name].readOnlyHint, true, `${name} only reads`);
        assert.strictEqual(hints.watch_remove.readOnlyHint, false);
        assert.strictEqual(hints.target_control.destructiveHint, true);
        const names = tools.TOOLS.map((item) => item.name);
        for (const name of [
            "target_control",
            "variables_list",
            "watch_list",
            "watch_remove",
            "memory_read",
            "debug_evaluate"
        ])
            assert.ok(names.includes(name), name);
        assert.deepStrictEqual(
            ["memory_read", "debug_evaluate"].map((name) => tool(name).toolset),
            ["debug", "debug"]
        );
    });

    await scenario("Refuse samples that outlast the client call budget", () => {
        const sample = tools.TOOLS.find((item) => item.name === "variables_sample");
        assert.strictEqual(sample.request({ variables: ["x"], count: 1000, intervalMs: 1500 }).timeoutMs, 1530000);
        assert.throws(
            () => sample.request({ variables: ["x"], count: 1000, intervalMs: 1501 }),
            (error) =>
                error.code === "SAMPLE_DURATION_TOO_LONG" &&
                error.retryable === false &&
                error.details.maxDurationMs === 1500000 &&
                error.suggestedActions.some((action) => action.includes("variables_export_csv"))
        );
    });

    await scenario("Write chart CSV into the workspace and keep only small exports inline", () => {
        const csvTool = tools.TOOLS.find((item) => item.name === "variables_export_csv");
        const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-csv-")));
        const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-csv-outside-")));
        try {
            const context = { workspace };
            const metadata = { panelId: 1, names: ["x"], rowCount: 2, historyTruncated: false };
            const small = { ...metadata, csv: "time,x\n1,2\n" };
            assert.deepStrictEqual(csvTool.result(small, {}, context), small, "a small export stays inline");

            const written = csvTool.result(small, { outputPath: "exports/run.csv" }, context);
            const output = path.join(workspace, "exports", "run.csv");
            assert.deepStrictEqual(written, { ...metadata, output, bytes: 11 });
            assert.strictEqual(fs.readFileSync(output, "utf8"), small.csv);

            const large = { ...metadata, csv: "x\n".repeat(20000) };
            const omitted = csvTool.result(large, {}, context);
            assert.strictEqual(omitted.csv, undefined, "a large export never goes inline");
            assert.strictEqual(omitted.csvOmitted, true);
            assert.strictEqual(omitted.bytes, 40000);
            assert.ok(omitted.nextStep.includes("outputPath"));

            const params = { to: 0, lastSeconds: 1 };
            assert.ok(csvTool.request({ ...params, outputPath: "run.csv" }, context).params);
            for (const outputPath of [path.join(outside, "run.csv"), "../run.csv", "."])
                assert.throws(() => csvTool.request({ ...params, outputPath }, context), {
                    code: "PATH_OUTSIDE_WORKSPACE"
                });
            let linked = false;
            try {
                fs.symlinkSync(outside, path.join(workspace, "link"), "junction");
                linked = true;
            } catch {
                // Symlinks may be unavailable to unprivileged users; the relative-path cases above still run.
            }
            if (linked)
                assert.throws(() => csvTool.request({ ...params, outputPath: "link/run.csv" }, context), {
                    code: "PATH_OUTSIDE_WORKSPACE"
                });
            assert.deepStrictEqual(fs.readdirSync(outside), [], "nothing is written outside the workspace");
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    await scenario("Shorten oversized text into valid JSON and keep small results unchanged", () => {
        assert.strictEqual(results.text({ a: [1, 2] }), '{"a":[1,2]}');
        const samples = Array.from({ length: 5000 }, (_, index) => ({ t: index, values: { x: index * 1.5 } }));
        const value = { count: 5000, samples, log: "y".repeat(100000) };
        const full = results.success(value);
        assert.strictEqual(full.structuredContent, value, "structuredContent keeps the full result");
        const text = full.content[0].text;
        assert.ok(text.length <= results.MAX_TEXT, `${text.length}`);
        const parsed = JSON.parse(text);
        assert.match(parsed.textTruncated, /structuredContent holds the full result/);
        assert.strictEqual(parsed.count, 5000);
        assert.deepStrictEqual(parsed.samples[0], samples[0]);
        assert.match(parsed.samples.at(-1), /^… \d+ more items$/);
        assert.match(parsed.log, /more characters\]$/);
    });

    await scenario("Include core, debug and CubeMX tools in the catalog", () => {
        const names = tools.TOOLS.map((tool) => tool.name);
        assert.ok(names.includes("flash_program") && names.includes("debug_status"));
        assert.ok(names.includes("cubemx_execute"));
        assert.ok(Buffer.byteLength(INSTRUCTIONS, "utf8") <= 1536, "server instructions stay within 1.5 KB");
    });

    console.log("MCP tool catalog tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
