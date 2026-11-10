"use strict";

// Scripted MCP baseline: a deterministic MCP client that drives the EmberProbe server through fixed phases, so a failure
// seen later in a harness can be attributed to that client or its model rather than to the tools. Phases that touch a
// board run only through run-mcp-baseline.js, which holds the safety gates. See test/hil/README.md.
const assert = require("assert");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { ElicitRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { TOOLS, listing } = require("../../src/mcp/tools");
const { sameValue } = require("./smoke-profile");

const PHASES = Object.freeze(["protocol", "read", "confirm", "debug", "flash"]);
const DEFAULT_PHASES = Object.freeze(["protocol", "read"]);
const CALL_TIMEOUT_MS = 300000;
const POLL_MS = 200;
const INVALID_ID = "00000000-0000-4000-8000-000000000000";
const MAX_RESULT_TEXT = 4000;

const baseName = (file) =>
    String(file || "")
        .split(/[\\/]/u)
        .pop();

// Records are written to disk, so one-time IDs never reach them even though a used ID has no further value.
function redact(value) {
    return JSON.parse(JSON.stringify(value ?? null, (key, item) => (key === "confirmationId" ? "(redacted)" : item)));
}

function clipped(value) {
    const text = JSON.stringify(redact(value));
    return text.length <= MAX_RESULT_TEXT ? redact(value) : { truncated: true, text: text.slice(0, MAX_RESULT_TEXT) };
}

function createClient({ elicit } = {}) {
    const capabilities = elicit ? { elicitation: {} } : {};
    const client = new Client({ name: "emberprobe-mcp-baseline", version: "1.0.0" }, { capabilities });
    if (elicit) client.setRequestHandler(ElicitRequestSchema, async (request) => elicit(request.params));
    return client;
}

class Stop extends Error {}

class Baseline {
    /**
     * @param {{
     *   connect: (options: { elicit?: Function }) => Promise<{ client: any, close?: Function }>,
     *   profile: Record<string, any>, phases?: string[], log?: (line: string) => void,
     *   sleep?: (ms: number) => Promise<void>, pollTimeoutMs?: number
     * }} options
     */
    constructor(options) {
        this.connect = options.connect;
        this.profile = options.profile;
        this.phases = options.phases || [...DEFAULT_PHASES];
        this.log = options.log || (() => {});
        this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.pollTimeoutMs = options.pollTimeoutMs ?? 20000;
        this.connections = {};
        this.steps = [];
        this.calls = [];
        this.cleanups = [];
        this.elicited = [];
        this.answer = null;
        this.config = {};
    }

    async client(kind = "interactive") {
        this.connections[kind] ||= await this.connect(
            kind === "interactive" ? { elicit: (params) => this.onElicit(params) } : {}
        );
        return this.connections[kind].client;
    }

    // An approval the running step did not script is declined, so an unexpected prompt can never authorize anything.
    onElicit(params) {
        const options = params.requestedSchema?.properties?.decision?.enum || [];
        this.elicited.push({ message: params.message, options });
        const answer = typeof this.answer === "function" ? this.answer(options) : this.answer;
        return answer && answer !== "decline"
            ? { action: "accept", content: { decision: answer } }
            : { action: "decline" };
    }

    async call(tool, args = {}, options = {}) {
        const client = await this.client(options.client);
        const entry = { tool, client: options.client || "interactive", progress: 0 };
        const started = Date.now();
        this.calls.push(entry);
        try {
            const result = await client.callTool({ name: tool, arguments: args }, undefined, {
                timeout: CALL_TIMEOUT_MS,
                resetTimeoutOnProgress: true,
                onprogress: () => {
                    entry.progress++;
                }
            });
            const value = result.structuredContent ?? {};
            entry.isError = !!result.isError;
            entry.code = value.error?.code || "";
            entry.result = clipped(value);
            return { isError: !!result.isError, value, code: entry.code };
        } catch (error) {
            entry.isError = true;
            entry.code = String(error?.code ?? "PROTOCOL_ERROR");
            entry.result = { message: String(error?.message || error) };
            throw error;
        } finally {
            entry.ms = Date.now() - started;
        }
    }

    async ok(tool, args, options) {
        const result = await this.call(tool, args, options);
        assert(!result.isError, `${tool} failed: ${JSON.stringify(clipped(result.value))}`);
        return result.value;
    }

    async fails(tool, args, pattern, options) {
        const result = await this.call(tool, args, options);
        assert(result.isError, `${tool} unexpectedly succeeded`);
        assert.match(result.code || JSON.stringify(result.value), pattern);
        return result;
    }

    async answering(answer, work) {
        this.answer = answer;
        this.elicited = [];
        try {
            return await work();
        } finally {
            this.answer = null;
        }
    }

    prompted(count, text) {
        assert.strictEqual(this.elicited.length, count, `expected ${count} confirmation prompt(s)`);
        if (text) assert(this.elicited[0].message.includes(text), `the prompt does not name ${text}`);
    }

    async step(name, work, { fatal = false } = {}) {
        const entry = { name, status: "passed" };
        const started = Date.now();
        this.steps.push(entry);
        try {
            await work();
            this.log(`ok   ${name}`);
        } catch (error) {
            entry.status = "failed";
            entry.error = String(error?.message || error);
            this.log(`FAIL ${name}: ${entry.error}`);
            if (fatal) throw new Stop(entry.error);
        } finally {
            entry.ms = Date.now() - started;
        }
    }

    skip(name, reason) {
        this.steps.push({ name, status: "skipped", reason });
        this.log(`skip ${name}: ${reason}`);
    }

    async poll(tool, predicate, label) {
        const deadline = Date.now() + this.pollTimeoutMs;
        for (;;) {
            const value = await this.ok(tool);
            if (predicate(value)) return value;
            if (Date.now() >= deadline) throw new Error(`${label}; last status ${JSON.stringify(clipped(value))}`);
            await this.sleep(POLL_MS);
        }
    }

    async readValue(name) {
        const result = await this.ok("variables_read", { variables: [name] });
        assert(result.values?.[name], `${name} was not read: ${JSON.stringify(result.variableErrors || {})}`);
        return result.values[name].value;
    }

    async expectValue(name, expected) {
        const actual = await this.readValue(name);
        assert(sameValue(actual, expected), `${name} is ${actual}, expected ${expected}`);
    }

    async register(target) {
        const result = await this.ok("peripherals_read", { targets: [target] });
        const found = result.registers?.find((item) => item.path.toLowerCase() === target.toLowerCase());
        assert(found, `${target} was not read`);
        return found.value;
    }

    async writeOnce(name, value) {
        await this.answering("once", () => this.ok("variables_write", { values: [{ name, value }] }));
    }

    async writeRegister(target, value) {
        const result = await this.answering("once", () =>
            this.ok("peripherals_write", { writes: [{ target, value }] })
        );
        assert(
            result.results?.every((item) => item.verified),
            `${target} write was not verified`
        );
    }

    async protocol() {
        const { profile } = this;
        const client = await this.client();
        await this.step("server identity and instructions", async () => {
            assert.strictEqual(client.getServerVersion()?.name, "emberprobe");
            assert(client.getServerCapabilities()?.tools, "the server does not offer tools");
            assert(client.getServerCapabilities()?.prompts, "the server does not offer prompts");
            assert.match(client.getInstructions() || "", /EmberProbe/u);
        });
        await this.step("tool catalogue matches the source", async () => {
            const listed = (await client.listTools()).tools;
            const pick = ({ name, title, description, inputSchema, annotations }) => ({
                name,
                title,
                description,
                inputSchema,
                annotations
            });
            assert.deepStrictEqual(
                listed.map(pick),
                TOOLS.map((tool) => pick(listing(tool)))
            );
        });
        await this.step("prompts load", async () => {
            const { prompts } = await client.listPrompts();
            assert(prompts.length > 0, "no prompts listed");
            for (const prompt of prompts) {
                const loaded = await client.getPrompt({ name: prompt.name, arguments: { goal: "baseline" } });
                assert(loaded.messages[0]?.content?.text, `${prompt.name} has no text`);
            }
        });
        await this.step("arguments are validated before the Bridge", async () => {
            await this.fails("variables_read", {}, /INVALID_PARAMS/u);
            await this.fails("debug_inspect", { action: "scopes", frame: 1 }, /INVALID_PARAMS/u);
            await assert.rejects(client.callTool({ name: "__emberprobe_missing", arguments: {} }));
        });
        await this.step(
            "workspace matches the profile",
            async () => {
                this.config = await this.ok("config_get");
                const expected = { mcu: profile.target, debugger: profile.probe, elf: profile.elf };
                for (const [key, value] of Object.entries(expected))
                    assert.strictEqual(baseName(this.config[key]), baseName(value), `config ${key} differs`);
            },
            { fatal: true }
        );
        await this.step(
            "no remembered permission is active",
            async () => {
                for (const kind of ["flash", "variables", "cubemx"]) {
                    const status = await this.ok("permission_get", { kind });
                    const active = status.trusted === true || (status.saved === true && status.expired !== true);
                    assert(!active, `${kind} has a remembered permission; clear it so confirmations are reachable`);
                }
            },
            { fatal: true }
        );
        await this.step(
            "probe is idle",
            async () => {
                assert.strictEqual((await this.ok("debug_status")).state, "none", "stop the debug session first");
                assert((await this.ok("sampling_status")).running !== true, "stop live sampling first");
                assert.strictEqual((await this.ok("rtt_status")).state, "stopped", "stop RTT first");
            },
            { fatal: true }
        );
        await this.step("config_set keeps the value and refuses user-only keys", async () => {
            await this.fails("config_set", { values: { openocdPath: "openocd" } }, /INVALID_PARAMS/u);
            await this.ok("config_set", { values: { elf: this.config.elf } });
            assert.strictEqual((await this.ok("config_get")).elf, this.config.elf);
        });
        await this.step("probe_list finds the configured probe", async () => {
            const probes = await this.ok("probe_list");
            if (profile.probeSerial) assert(JSON.stringify(probes).includes(profile.probeSerial), "probe not found");
        });
        await this.step("tools without target access respond", async () => {
            await this.ok("rtos_status");
            await this.fails("rtt_read", {}, /RTT_NOT_RUNNING/u);
            await this.ok("rtt_control", { action: "stop" });
            await this.ok("elf_analyze", { top: 5 });
            await this.ok("debug_breakpoints_list");
            if (profile.svd) await this.ok("peripherals_list", { query: "RCC" });
            // CubeMX may be absent; these two only have to return a well-formed result or diagnostic.
            for (const tool of ["cubemx_detect", "cubemx_status"]) {
                const result = await this.call(tool);
                assert(!result.isError || result.code, `${tool} failed without a diagnostic`);
            }
        });
    }

    // Without a debug session, peripheral registers are reached through the sampling session.
    async startSampling() {
        this.cleanups.push(() => this.ok("sampling_control", { action: "stop" }));
        await this.ok("watch_add", { variables: [this.profile.variables.read[0]], destination: "sidebar" });
        await this.ok("sampling_control", { action: "start", intervalMs: 50 });
        await this.poll("sampling_status", (status) => status.running === true, "sampling did not start");
    }

    async stopSampling() {
        await this.ok("sampling_control", { action: "stop" });
        await this.poll("sampling_status", (status) => status.running !== true, "sampling did not stop");
    }

    async read() {
        const { profile } = this;
        const names = profile.variables.read;
        await this.step("chip_read", async () => {
            await this.ok("chip_read", { sections: ["identity", "debug"] });
        });
        await this.step("variables_read", async () => {
            const result = await this.ok("variables_read", { variables: names });
            for (const name of names)
                assert(result.values?.[name], `${name} was not read: ${JSON.stringify(result.variableErrors || {})}`);
        });
        await this.step("variables_read reports a missing symbol", async () => {
            const name = "__emberprobe_missing_symbol";
            const result = await this.call("variables_read", { variables: [name] });
            assert(result.isError || result.value.variableErrors?.[name], "a missing symbol was not reported");
        });
        await this.step("variables_sample", async () => {
            const check = profile.checks.sampling || { variable: names[0], count: 5, intervalMs: 50 };
            const { variable, count, intervalMs } = check;
            const { samples = [] } = await this.ok("variables_sample", { variables: [variable], count, intervalMs });
            assert.strictEqual(samples.length, count);
            if (check.increasing) {
                const values = samples.map((sample) => Number(sample.values?.[variable]?.value));
                assert(values.at(-1) > values[0], `${variable} did not increase`);
            }
        });
        await this.step("live sampling starts", () => this.startSampling());
        if (profile.checks.peripherals) {
            await this.step("peripherals_read", async () => {
                const { read } = profile.checks.peripherals;
                const result = await this.ok("peripherals_read", { targets: read });
                assert.strictEqual(result.registers?.length, read.length);
            });
        } else this.skip("peripherals_read", "the profile has no checks.peripherals");
        await this.step("live sampling stops", () => this.stopSampling());
        await this.step("variables_export_csv answers", async () => {
            const result = await this.call("variables_export_csv", { lastSeconds: 5 });
            if (result.isError) assert.strictEqual(result.code, "LIVE_PANEL_NOT_OPEN");
        });
    }

    async variableWrites() {
        const { name, value } = this.profile.variables.write;
        const write = { values: [{ name, value }] };
        const original = await this.readValue(name);
        assert(!sameValue(original, value), `${name} already holds ${value}; pass --write-value with another value`);
        this.cleanups.push(async () => {
            if (!sameValue(await this.readValue(name), original)) await this.writeOnce(name, String(original));
        });
        await this.step("variables_write: denying leaves the target unchanged", async () => {
            await this.answering("deny", () => this.fails("variables_write", write, /CONFIRMATION_DENIED/u));
            this.prompted(1, name);
            await this.expectValue(name, original);
        });
        await this.step("variables_write: dismissing the prompt counts as denial", async () => {
            await this.answering("decline", () => this.fails("variables_write", write, /CONFIRMATION_DENIED/u));
            this.prompted(1);
            await this.expectValue(name, original);
        });
        await this.step("variables_write: chat fallback binds a one-time ID", async () => {
            const options = { client: "chat" };
            const plan = await this.ok("variables_write", write, options);
            assert(plan.confirmationRequired && plan.confirmationId, "the fallback returned no plan and ID");
            assert.match(plan.nextStep || "", /explicit answer/u);
            await this.expectValue(name, original);
            const wrong = { ...write, confirmationId: INVALID_ID };
            await this.fails("variables_write", wrong, /CONFIRMATION_INVALID/u, options);
            const approved = { ...write, confirmationId: plan.confirmationId };
            const executed = await this.ok("variables_write", approved, options);
            assert(!("confirmationId" in executed), "an executed result exposes a confirmation ID");
            await this.expectValue(name, value);
            await this.fails("variables_write", approved, /CONFIRMATION_INVALID/u, options);
        });
        await this.step("variables_write: approving once writes and reads back", async () => {
            await this.writeOnce(name, String(original));
            this.prompted(1, name);
            await this.expectValue(name, original);
        });
        await this.rememberedWrite(name, value, original);
    }

    async rememberedWrite(name, value, original) {
        const write = (next) => ({ values: [{ name, value: next }] });
        let offered = false;
        await this.step("variables_write: 24-hour permission and permission_reset", async () => {
            const choose = (options) => {
                offered = options.includes("workspace");
                return offered ? "workspace" : "deny";
            };
            const first = await this.answering(choose, () => this.call("variables_write", write(value)));
            if (!offered) {
                assert.strictEqual(first.code, "CONFIRMATION_DENIED");
                return;
            }
            assert(!first.isError, `the remembered write failed: ${JSON.stringify(clipped(first.value))}`);
            const status = await this.ok("permission_get", { kind: "variables" });
            assert(status.saved === true && status.expired !== true, "the permission was not remembered");
            await this.answering(null, () => this.ok("variables_write", write(String(original))));
            this.prompted(0);
            await this.expectValue(name, original);
            await this.ok("permission_reset", { kind: "variables" });
            await this.answering("deny", () => this.fails("variables_write", write(value), /CONFIRMATION_DENIED/u));
            this.prompted(1, name);
            await this.expectValue(name, original);
        });
        if (!offered) this.skip("24-hour permission", "this probe or plan offers one-time approval only");
    }

    async peripheralWrites() {
        const { write, reject } = this.profile.checks.peripherals;
        if (write) {
            const { target, value } = write;
            const original = await this.register(target);
            this.cleanups.push(async () => {
                if (!sameValue(await this.register(target), original)) await this.writeRegister(target, original);
            });
            await this.step("peripherals_write: denying leaves the register unchanged", async () => {
                const args = { writes: [{ target, value }] };
                await this.answering("deny", () => this.fails("peripherals_write", args, /CONFIRMATION_DENIED/u));
                this.prompted(1, target);
                assert(sameValue(await this.register(target), original), `${target} changed after a denial`);
            });
            await this.step("peripherals_write: approving once writes and restores", async () => {
                await this.writeRegister(target, value);
                assert(sameValue(await this.register(target), value), `${target} did not take ${value}`);
                await this.writeRegister(target, original);
                assert(sameValue(await this.register(target), original), `${target} was not restored`);
            });
        } else this.skip("peripherals_write", "the profile has no checks.peripherals.write");
        for (const item of reject)
            await this.step(`peripherals_write rejects ${item.target}`, async () => {
                const args = { writes: [{ target: item.target, value: item.value }] };
                await this.answering(null, () => this.fails("peripherals_write", args, new RegExp(item.code, "u")));
                this.prompted(0);
            });
    }

    async confirm() {
        const { variables, checks } = this.profile;
        if (variables.write) await this.variableWrites();
        else this.skip("variables_write", "the profile has no variables.write");
        const { negative } = checks;
        if (negative?.readOnly || negative?.outOfBounds)
            await this.step("variables_write refuses unsafe targets without asking", async () => {
                for (const name of [negative.readOnly, negative.outOfBounds].filter(Boolean)) {
                    const args = { values: [{ name, value: "1" }] };
                    await this.answering(null, () => this.fails("variables_write", args, /./u));
                    this.prompted(0);
                }
            });
        if (checks.peripherals) {
            await this.step("live sampling starts for peripheral access", () => this.startSampling());
            await this.peripheralWrites();
            // Register restores need the sampling session, so they run here, before its own stop cleanup.
            await this.runCleanups();
            await this.step("live sampling stops after peripheral access", () =>
                this.poll("sampling_status", (status) => status.running !== true, "sampling did not stop")
            );
        } else this.skip("peripherals_write", "the profile has no checks.peripherals");
    }

    paused(label = "the target did not pause") {
        return this.poll("debug_status", (status) => status.paused === true, label);
    }

    async control(action, predicate, label) {
        await this.ok("debug_control", { action });
        return this.poll("debug_status", predicate, label);
    }

    async debug() {
        const { checks } = this.profile;
        if (this.profile.debug === false) return this.skip("debug phase", "the profile disables debugging");
        this.cleanups.push(async () => {
            if ((await this.ok("debug_status")).state !== "none") await this.ok("debug_control", { action: "stop" });
        });
        let status;
        await this.step(
            "debug_start attaches without reset or download",
            async () => {
                await this.ok("debug_start", { attach: true });
                status = await this.paused();
            },
            { fatal: true }
        );
        let frame;
        await this.step("debug_inspect walks threads, stack, scopes and variables", async () => {
            await this.ok("debug_select", { sessionId: status.session.id });
            await this.ok("debug_inspect", { action: "threads" });
            const stack = await this.ok("debug_inspect", { action: "stack", threadId: status.threadId, count: 5 });
            frame = stack.stackFrames?.[0]?.frame;
            assert.strictEqual(typeof frame, "string", "stack frames carry no string handle");
            const { scopes = [] } = await this.ok("debug_inspect", { action: "scopes", frame });
            if (scopes[0]?.reference)
                await this.ok("debug_inspect", { action: "variables", reference: scopes[0].reference, count: 10 });
        });
        await this.step("debug_control: a handle expires when the target resumes", async () => {
            await this.control("continue", (next) => next.state === "running", "the target did not resume");
            assert((await this.call("debug_inspect", { action: "scopes", frame })).isError, "a stale handle was used");
        });
        await this.step("debug_control pauses and steps", async () => {
            await this.ok("debug_control", { action: "pause" });
            await this.paused();
            await this.control("stepOver", (next) => next.paused === true, "stepOver did not stop");
        });
        if (checks.breakpoint)
            await this.step("debug_breakpoints_update stops on a function", async () => {
                const change = { type: "function", function: checks.breakpoint };
                await this.ok("debug_breakpoints_update", { action: "add", ...change });
                try {
                    const listed = await this.ok("debug_breakpoints_list");
                    assert(JSON.stringify(listed).includes(checks.breakpoint), "the breakpoint is not listed");
                    await this.ok("debug_control", { action: "continue" });
                    await this.paused("the breakpoint was not hit");
                } finally {
                    await this.ok("debug_breakpoints_update", { action: "remove", ...change });
                }
            });
        else this.skip("debug_breakpoints_update", "the profile has no checks.breakpoint");
        if (checks.rtosTasks)
            await this.step("rtos_snapshot lists the configured tasks", async () => {
                const { tasks = [] } = await this.ok("rtos_snapshot", { includeStackUsage: false });
                const names = tasks.map((task) => task.name);
                for (const task of checks.rtosTasks) assert(names.includes(task), `${task} is not listed`);
            });
        else this.skip("rtos_snapshot", "the profile has no checks.rtosTasks");
        await this.step("debug_control stops the session", async () => {
            await this.control("stop", (next) => next.state === "none", "the session did not stop");
        });
        await this.step("fault_read", async () => {
            assert((await this.ok("fault_read")).targetState, "fault_read returned no target state");
        });
        this.skip("debug_control restart", "resets the target; covered by npm run test:hil:smoke");
        return undefined;
    }

    async flash() {
        const name = baseName(this.config.elf);
        for (const tool of ["flash_verify", "flash_program"])
            await this.step(`${tool}: denying runs nothing`, async () => {
                await this.answering("deny", () => this.fails(tool, {}, /CONFIRMATION_DENIED/u));
                this.prompted(1, name);
            });
        await this.step(
            "flash_verify: approving once compares Flash",
            async () => {
                await this.answering("once", () => this.ok("flash_verify"));
                this.prompted(1, name);
            },
            { fatal: true }
        );
        await this.step("flash_program: approving once programs and verifies", async () => {
            await this.answering("once", () => this.ok("flash_program"));
            this.prompted(1, name);
            await this.answering("once", () => this.ok("flash_verify"));
            await this.ok("chip_read", { sections: ["runtime"] });
        });
    }

    async runCleanups() {
        for (const cleanup of this.cleanups.splice(0).reverse()) {
            try {
                await cleanup();
            } catch (error) {
                this.steps.push({ name: "cleanup", status: "failed", error: String(error?.message || error) });
                this.log(`FAIL cleanup: ${error?.message || error}`);
            }
        }
    }

    async run() {
        const startedAt = new Date().toISOString();
        const completed = [];
        let stopped = "";
        try {
            for (const phase of this.phases) {
                const before = this.steps.length;
                this.log(`== ${phase}`);
                try {
                    await this[phase]();
                } finally {
                    await this.runCleanups();
                }
                completed.push(phase);
                // Later phases raise the stakes, so they never run on top of a failure.
                if (this.steps.slice(before).some((step) => step.status === "failed")) {
                    stopped = `${phase} failed`;
                    break;
                }
            }
        } catch (error) {
            stopped = String(error?.message || error);
            if (!(error instanceof Stop)) this.steps.push({ name: "runner", status: "failed", error: stopped });
        }
        const interactive = this.connections.interactive?.client;
        const called = new Set(this.calls.map((call) => call.tool));
        const report = {
            startedAt,
            finishedAt: new Date().toISOString(),
            profile: this.profile.name,
            server: interactive?.getServerVersion?.() || null,
            requestedPhases: this.phases,
            completedPhases: completed,
            stopped,
            passed: !stopped && this.steps.every((step) => step.status !== "failed"),
            steps: this.steps,
            calls: this.calls,
            coverage: {
                called: TOOLS.map((tool) => tool.name).filter((name) => called.has(name)),
                notCalled: TOOLS.map((tool) => tool.name).filter((name) => !called.has(name))
            }
        };
        for (const connection of Object.values(this.connections)) await connection.close?.();
        return report;
    }
}

function renderReport(report) {
    const count = (status) => report.steps.filter((step) => step.status === status).length;
    const rows = report.steps.map(
        (step) =>
            `| ${step.status} | ${step.name} | ${String(step.error || step.reason || "").replace(/\|/gu, "\\|")} |`
    );
    return [
        `# MCP baseline: ${report.profile}`,
        "",
        `- Result: ${report.passed ? "PASSED" : "FAILED"}${report.stopped ? ` (${report.stopped})` : ""}`,
        `- Server: ${report.server ? `${report.server.name} ${report.server.version}` : "not connected"}`,
        `- Phases requested: ${report.requestedPhases.join(", ")}; completed: ${report.completedPhases.join(", ") || "none"}`,
        `- Steps: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped`,
        `- Time: ${report.startedAt} to ${report.finishedAt}`,
        "",
        "| Status | Step | Detail |",
        "|---|---|---|",
        ...rows,
        "",
        `Tools called (${report.coverage.called.length}): ${report.coverage.called.join(", ") || "none"}`,
        "",
        `Tools not called (${report.coverage.notCalled.length}): ${report.coverage.notCalled.join(", ") || "none"}`,
        ""
    ].join("\n");
}

module.exports = { Baseline, DEFAULT_PHASES, PHASES, createClient, redact, renderReport };
