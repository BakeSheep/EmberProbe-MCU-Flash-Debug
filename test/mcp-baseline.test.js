"use strict";
// The scripted MCP baseline against the real MCP server and a simulated board behind the Bridge call: phase flow, safety
// stops, value restoration and the runner's hardware gate. Real-board behaviour is recorded separately (test/hil/README.md).
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const flashCommon = require("../skills/_emberprobe/flash-common");
const { createServer } = require("../src/mcp/server");
const { TOOLS } = require("../src/mcp/tools");
const { Baseline, PHASES, createClient, redact, renderReport } = require("./hil/mcp-baseline");
const { parseOptions } = require("./hil/run-mcp-baseline");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-baseline-")));
const elf = path.join(base, "fw.elf");
fs.writeFileSync(elf, "fixture");

const fail = (code, message = code) => Object.assign(new Error(message), { code, retryable: false });

const PROFILE = {
    name: "fixture",
    probe: "jlink.cfg",
    target: "stm32f4x.cfg",
    probeSerial: "1234",
    elf,
    svd: path.join(base, "fw.svd"),
    debug: true,
    variables: { read: ["counter"], write: { name: "gain", value: "1.25" } },
    checks: {
        sampling: { variable: "counter", increasing: true, count: 3, intervalMs: 5 },
        breakpoint: "tick",
        rtosTasks: ["idle"],
        peripherals: {
            read: ["TIM7.PSC"],
            write: { target: "TIM7.PSC", value: "1" },
            reject: [{ target: "TIM7.EGR", value: "1", code: "PERIPHERAL_WRITE_NOT_ALLOWED" }]
        },
        negative: { readOnly: "const_value" }
    }
};

// Models only what the baseline observes. `bugs` are defects a baseline run has to catch.
function board(bugs = {}) {
    const state = {
        gain: 1,
        psc: 7,
        sampling: false,
        debug: "none",
        breakpoints: [],
        remembered: false,
        pending: new Map(),
        flashed: 0,
        verified: 0,
        methods: [],
        nextId: 0
    };
    const config = { mcu: "target/stm32f4x.cfg", debugger: "interface/jlink.cfg", elf, ...bugs.config };
    const plan = (kind, extra) => {
        const confirmationId = `id-${++state.nextId}`;
        state.pending.set(confirmationId, kind);
        return { confirmationRequired: true, confirmationId, question: "Approve?", choices: ["once"], ...extra };
    };
    const consume = (id, kind) => {
        if (state.pending.get(id) !== kind) throw fail(`${kind.toUpperCase()}_CONFIRMATION_INVALID`);
        state.pending.delete(id);
    };
    const write = (params) => {
        const [{ name, value }] = params.values;
        if (name === "const_value") throw fail("VARIABLE_NOT_WRITABLE");
        const apply = () => {
            state.gain = Number(value);
            return { written: [name] };
        };
        if (bugs.fullAccess) return apply();
        if (params.confirmationId) {
            consume(params.confirmationId, "write");
            state.remembered ||= params.remember === true;
            return apply();
        }
        if (bugs.writesOnPlan) apply();
        if (state.remembered) return apply();
        return plan("write", {
            items: [{ name, value }],
            choices: bugs.onceOnly ? ["once"] : ["once", "workspace"]
        });
    };
    const needsAccessSession = () => {
        if (!state.sampling) throw fail("PERIPHERAL_SAMPLING_REQUIRED");
    };
    const peripheralWrite = (params) => {
        const [{ target, value }] = params.writes;
        if (target === "TIM7.EGR") throw fail("PERIPHERAL_WRITE_NOT_ALLOWED");
        if (!params.confirmationId) return plan("peripheral", { writes: [{ target, value }] });
        consume(params.confirmationId, "peripheral");
        state.psc = Number(value);
        return { results: [{ target, verified: true }] };
    };
    const flash = (kind) => (params) => {
        consume(params.confirmationId, kind);
        state[kind === "program" ? "flashed" : "verified"]++;
        return { code: 0 };
    };
    const handlers = {
        "config.get": () => config,
        "config.set": (params) => {
            Object.assign(config, params.values);
            return {};
        },
        "flash.permission": () => ({ scope: "workspace", trusted: false, saved: !!bugs.rememberedFlash }),
        "cubemx.permission": () => ({ trusted: false }),
        "variables.write.permission": (params) => {
            if (params.action === "reset") state.remembered = false;
            return { trusted: false, saved: state.remembered };
        },
        "debug.status": () => ({
            state: state.debug,
            paused: state.debug === "paused",
            threadId: 1,
            session: state.debug === "none" ? null : { id: "s1" }
        }),
        "sampling.status": () => ({ running: state.sampling }),
        "sampling.start": () => {
            state.sampling = true;
            return {};
        },
        "sampling.stop": () => {
            state.sampling = false;
            return {};
        },
        "probe.list": () => ({ probes: [{ serial: "1234", selected: true }] }),
        "rtos.status": () => ({ configured: false }),
        "elf.analyze": () => ({ regions: [] }),
        "peripherals.list": () => ({ peripherals: [] }),
        "cubemx.detect": () => {
            throw fail("CUBEMX_NOT_FOUND");
        },
        "cubemx.status": () => ({ operations: [] }),
        "chip.read": () => ({ cpuid: "0x410FC241" }),
        "fault.read": () => ({ targetState: "running" }),
        "watch.add": () => ({}),
        "variables.exportCsv": () => {
            throw fail("LIVE_PANEL_NOT_OPEN");
        },
        "variables.read": (params) => {
            const values = {};
            const variableErrors = {};
            for (const { name } of params.variables) {
                if (name === "counter") values[name] = { value: 5 };
                else if (name === "gain") values[name] = { value: state.gain };
                else variableErrors[name] = "not found";
            }
            return { values, variableErrors };
        },
        "variables.sample": (params) => ({
            samples: Array.from({ length: params.count }, (_, index) => ({
                values: { counter: { value: index } }
            }))
        }),
        "variables.write": write,
        "peripherals.read": (params) => {
            needsAccessSession();
            return { registers: params.targets.map((item) => ({ path: item, value: state.psc })) };
        },
        "peripherals.write": (params) => {
            needsAccessSession();
            return peripheralWrite(params);
        },
        "debug.start": () => {
            state.debug = "paused";
            return { mode: "attach" };
        },
        "debug.select": () => ({}),
        "debug.inspect": (params) => {
            if (state.debug !== "paused") throw fail("DEBUG_HANDLE_STALE");
            if (params.action === "stack") return { stackFrames: [{ frame: "f1" }] };
            if (params.action === "scopes") return { scopes: [{ reference: "r1" }] };
            return { items: [] };
        },
        "debug.control": ({ action }) => {
            if (action === "stop") state.debug = "none";
            else if (action === "continue") state.debug = state.breakpoints.length ? "paused" : "running";
            else state.debug = "paused";
            return {};
        },
        "debug.breakpoints.list": () => ({ breakpoints: state.breakpoints }),
        "debug.breakpoints.update": (params) => {
            if (params.action === "add") state.breakpoints.push(params.function);
            else state.breakpoints = [];
            return {};
        },
        "rtos.snapshot": () => ({ tasks: [{ name: "idle" }] }),
        "flash.authorize": (params) =>
            plan(params.operation === "flash.execute" ? "program" : "verify", { elf: params.elf }),
        "flash.execute": flash("program"),
        "flash.verify": flash("verify")
    };
    const call = async (_via, _target, method, params) => {
        state.methods.push(method);
        if (!handlers[method]) throw new Error(`Unexpected Bridge method ${method}`);
        return handlers[method](params || {});
    };
    return { state, call };
}

function connector(fake) {
    return async ({ elicit }) => {
        const server = createServer({ env: {}, cwd: base, call: fake.call });
        const client = createClient({ elicit });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        return { client, close: () => client.close() };
    };
}

function run(fake, phases = PHASES, profile = PROFILE) {
    return new Baseline({
        connect: connector(fake),
        profile,
        phases: [...phases],
        sleep: async () => {},
        pollTimeoutMs: 50
    }).run();
}

const named = (report, status) => report.steps.filter((step) => step.status === status).map((step) => step.name);

(async () => {
    const realPreflight = flashCommon.preflight;
    flashCommon.preflight = async () => ({
        ready: true,
        elf,
        elfSha256: "a".repeat(64),
        target: "target/stm32f4x.cfg",
        probe: "interface/jlink.cfg",
        openocd: process.execPath,
        transport: "swd",
        probeSerial: "1234",
        adapterSpeedKhz: 0,
        notes: []
    });
    try {
        await scenario("Pass every phase on a healthy board and restore what was written", async () => {
            const fake = board();
            const report = await run(fake);
            assert.deepStrictEqual(named(report, "failed"), []);
            assert.strictEqual(report.passed, true);
            assert.deepStrictEqual(report.completedPhases, PHASES);
            assert.strictEqual(fake.state.gain, 1);
            assert.strictEqual(fake.state.psc, 7);
            assert.strictEqual(fake.state.debug, "none");
            assert.strictEqual(fake.state.sampling, false);
            assert.strictEqual(fake.state.remembered, false, "the run leaves no remembered permission");
            assert.strictEqual(fake.state.flashed, 1);
            assert.strictEqual(fake.state.verified, 2);
            assert.strictEqual(report.server.name, "emberprobe");
            assert.ok(!JSON.stringify(report).includes('"id-'), "the report contains a confirmation ID");
            const cubemxOnly = report.coverage.notCalled.every((name) => name.startsWith("cubemx_"));
            assert.ok(cubemxOnly, `uncovered tools: ${report.coverage.notCalled}`);
            assert.strictEqual(report.coverage.called.length + report.coverage.notCalled.length, TOOLS.length);
            assert.match(renderReport(report), /Result: PASSED/);
        });

        await scenario("Run the protocol phase without touching the target", async () => {
            const fake = board();
            const report = await run(fake, ["protocol"]);
            assert.strictEqual(report.passed, true);
            for (const method of ["chip.read", "variables.read", "variables.write", "flash.authorize"])
                assert.ok(!fake.state.methods.includes(method), `${method} ran in the protocol phase`);
        });

        await scenario("Stop before hardware when the open workspace is not the profile's board", async () => {
            const fake = board({ config: { mcu: "target/stm32h7x.cfg" } });
            const report = await run(fake);
            assert.strictEqual(report.passed, false);
            assert.match(report.stopped, /config mcu differs/);
            assert.deepStrictEqual(report.completedPhases, []);
            assert.ok(!fake.state.methods.includes("chip.read"));
        });

        await scenario("Stop while a remembered permission would hide the confirmations", async () => {
            const fake = board({ rememberedFlash: true });
            const report = await run(fake);
            assert.match(report.stopped, /flash has a remembered permission/);
            assert.ok(!fake.state.methods.includes("variables.write"));
        });

        await scenario("Fail on a write that ignores denial, restore it and never reach Flash", async () => {
            const fake = board({ writesOnPlan: true });
            const report = await run(fake);
            assert.strictEqual(report.passed, false);
            assert.ok(named(report, "failed").includes("variables_write: denying leaves the target unchanged"));
            assert.strictEqual(fake.state.gain, 1, "the cleanup restores the original value");
            assert.ok(!report.completedPhases.includes("debug"));
            assert.ok(!fake.state.methods.includes("flash.authorize"));
        });

        await scenario("Fail when full Agent access skips the confirmation path", async () => {
            const fake = board({ fullAccess: true });
            const report = await run(fake);
            assert.strictEqual(report.passed, false);
            assert.strictEqual(fake.state.gain, 1);
            assert.strictEqual(fake.state.flashed, 0);
        });

        await scenario("Record a skip when the plan offers one-time approval only", async () => {
            const fake = board({ onceOnly: true });
            const report = await run(fake, ["protocol", "confirm"]);
            assert.strictEqual(report.passed, true);
            assert.ok(named(report, "skipped").includes("24-hour permission"));
            assert.strictEqual(fake.state.remembered, false);
        });

        await scenario("Refuse to run when the write value cannot show a change", async () => {
            const profile = { ...PROFILE, variables: { ...PROFILE.variables, write: { name: "gain", value: "1" } } };
            const report = await run(board(), ["protocol", "confirm"], profile);
            assert.strictEqual(report.passed, false);
            assert.match(report.stopped, /pass --write-value/);
        });

        await scenario("Decline a prompt the running step did not script", async () => {
            const baseline = new Baseline({ connect: connector(board()), profile: PROFILE });
            const answer = baseline.onElicit({ message: "Approve?", requestedSchema: {} });
            assert.deepStrictEqual(answer, { action: "decline" });
        });

        await scenario("Hide confirmation IDs from saved records", () => {
            assert.deepStrictEqual(redact({ plan: { confirmationId: "secret", a: 1 } }), {
                plan: { confirmationId: "(redacted)", a: 1 }
            });
        });

        await scenario("Gate hardware phases and always run the protocol phase first", () => {
            const argv = ["--profile", "fixture", "--workspace", base];
            const options = (extra, env = {}) => parseOptions([...argv, ...extra], env);
            assert.throws(() => options([]), /EMBERPROBE_HIL_CONFIRM/);
            assert.deepStrictEqual(options(["--phases", "protocol"]).phases, ["protocol"]);
            assert.deepStrictEqual(options([], { EMBERPROBE_HIL_CONFIRM: "YES" }).phases, ["protocol", "read"]);
            assert.deepStrictEqual(options(["--phases", "flash,read"], { EMBERPROBE_HIL_CONFIRM: "YES" }).phases, [
                "protocol",
                "read",
                "flash"
            ]);
            assert.throws(() => options(["--phases", "erase"], { EMBERPROBE_HIL_CONFIRM: "YES" }), /Unknown phase/);
            assert.throws(() => parseOptions(["--profile", "fixture", "--workspace", "relative"], {}), /absolute/);
            assert.throws(() => parseOptions(["--workspace", base], {}), /--profile/);
        });
    } finally {
        flashCommon.preflight = realPreflight;
        fs.rmSync(base, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
