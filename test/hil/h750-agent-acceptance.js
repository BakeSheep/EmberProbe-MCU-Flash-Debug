"use strict";

// Opt-in real-board acceptance. Writes and restarts require the user's dedicated HIL authorization.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const workspace = process.env.H750_WORKSPACE;
const directory = process.env.H750_RESULTS;
if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES" || !workspace || !directory)
    throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES, H750_WORKSPACE and H750_RESULTS for a dedicated H750 board");
const { call, diagnosticForError } = require(path.join(workspace, ".agents/skills/_emberprobe/agent-client"));
const report = { startedAt: new Date().toISOString(), workspace, operations: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(directory, { recursive: true });
const save = () => fs.writeFileSync(path.join(directory, "agent-acceptance.json"), JSON.stringify(report, null, 2));

async function request(label, method, params = {}) {
    const operation = { label, method, params, startedAt: new Date().toISOString() };
    report.operations.push(operation);
    try {
        const result = await call(workspace, method, params, 60000);
        operation.result = result;
        console.log(`${label}: OK`);
        return result;
    } catch (error) {
        operation.diagnostic = diagnosticForError(error, { operation: method });
        console.log(`${label}: ${error.code || error.message}`);
        throw error;
    } finally {
        save();
    }
}

async function rejected(label, method, params, pattern) {
    await assert.rejects(request(label, method, params), (error) => pattern.test(error.code || error.message));
}

async function write(label, method, params) {
    const plan = await request(`${label}-plan`, method, params);
    if (!plan.confirmationRequired) return plan;
    assert(plan.confirmationId, "Missing one-time confirmation ID");
    if (method === "variables.write") {
        const status = await request(`${label}-status-before-execute`, "debug.status");
        if (status.state !== "none" && !status.paused) {
            await request(`${label}-pause-before-execute`, "debug.control", { action: "pause" });
            await statusPaused(`${label}-paused-before-execute`);
        }
    }
    return request(`${label}-execute`, method, { ...params, confirmationId: plan.confirmationId });
}

async function statusPaused(label) {
    let result;
    for (let count = 0; count < 20; count++) {
        result = await call(workspace, "debug.status", {});
        if (result.paused) break;
        await sleep(200);
    }
    report.operations.push({ label, method: "debug.status", result });
    save();
    assert(result.paused, `${label}: target did not pause`);
}

async function runFor(label, duration) {
    const debugState = await request(`${label}-debug-status`, "debug.status");
    if (debugState.state === "none") {
        await sleep(duration);
        return;
    }
    await request(`${label}-continue`, "debug.control", { action: "continue" });
    await sleep(duration);
    const status = await request(`${label}-running-status`, "debug.status");
    assert.strictEqual(status.state, "running");
    await request(`${label}-pause`, "debug.control", { action: "pause" });
}

const observed = [
    "produced",
    "consumed",
    "queue_drops",
    "protocol_crc_errors",
    "protocol_format_errors",
    "run_state",
    "state_transitions",
    "producer_pauses",
    "fault_code",
    "free_heap_bytes",
    "producer_stack_words",
    "consumer_stack_words",
    "monitor_stack_words"
].map((name) => `g_appDebug.${name}`);

async function snapshot(label) {
    const result = await request(label, "variables.read", { variables: observed });
    return Object.fromEntries(Object.entries(result.values).map(([name, value]) => [name.split(".")[1], value.value]));
}

async function debugAcceptance() {
    assert.strictEqual((await request("initial-debug-status", "debug.status")).state, "none");
    await request("sampling-stop-before-debug", "sampling.stop");
    await request("debug-launch", "debug.start");
    await statusPaused("main-entry-paused");
    await request("step-over", "debug.control", { action: "stepOver" });
    await request("step-in", "debug.control", { action: "stepIn" });
    await request("step-out", "debug.control", { action: "stepOut" });
    await runFor("initialize-rtos", 1500);
    const baseline = await snapshot("baseline");
    assert(baseline.produced > 0 && baseline.consumed > 0 && baseline.free_heap_bytes > 0);
    const peripheral = await request("peripherals-read-initialized", "peripherals.read", {
        targets: ["GPIOE.GPIO_ODR", "GPIOE.GPIO_MODER", "TIM7.PSC", "TIM7.CNT", "RCC.C1_APB1LENR"]
    });
    const psc = peripheral.registers.find((item) => item.path === "TIM7.PSC").value;
    await write("peripheral-legal-write", "peripherals.write", { writes: [{ target: "TIM7.PSC", value: "1" }] });
    await write("peripheral-restore", "peripherals.write", { writes: [{ target: "TIM7.PSC", value: psc }] });
    await rejected(
        "peripheral-write-only-rejected",
        "peripherals.write",
        { writes: [{ target: "TIM7.EGR", value: "1" }] },
        /PERIPHERAL_WRITE_NOT_ALLOWED/
    );
    await rejected(
        "peripheral-width-rejected",
        "peripherals.write",
        { writes: [{ target: "GPIOE.GPIO_ODR.OD5", value: "2" }] },
        /INVALID_PERIPHERAL_WRITE_VALUE/
    );
    await request("debug-stop-before-agent-write", "debug.control", { action: "stop" });
    assert.strictEqual((await request("debug-status-before-agent-write", "debug.status")).state, "none");
    await request("write-permission", "variables.write.permission", { action: "status" });
    await write("ram-write", "variables.write", {
        values: [
            { name: "g_appDebug.command_gain", value: "1.25" },
            { name: "g_appDebug.history[0]", value: "-2.5" }
        ]
    });
    const written = await request("ram-readback", "variables.read", {
        variables: ["g_appDebug.command_gain", "g_appDebug.history[0]"]
    });
    assert.strictEqual(written.values["g_appDebug.command_gain"].value, 1.25);
    assert(Number.isFinite(written.values["g_appDebug.history[0]"].value), "history[0] readback was not numeric");
    await write("ram-restore", "variables.write", { values: [{ name: "g_appDebug.command_gain", value: "1" }] });
    await rejected(
        "ram-bounds-rejected",
        "variables.write",
        { values: [{ name: "g_appDebug.history[99]", value: "1" }] },
        /INVALID_VARIABLE_PATH|VARIABLE_NOT_FOUND|UNSUPPORTED_VARIABLE/
    );
    await rejected(
        "flash-write-rejected",
        "variables.write",
        { values: [{ name: "uxTopUsedPriority", value: "1" }] },
        /WRITE_NOT_ALLOWED|WRITE_CONST|READ_ONLY/
    );
    await rejected(
        "unknown-write-rejected",
        "variables.write",
        { values: [{ name: "not_a_symbol", value: "1" }] },
        /VARIABLE_NOT_FOUND/
    );
    for (const [control, metric] of [
        ["inject_drop", "queue_drops"],
        ["inject_bad_crc", "protocol_crc_errors"],
        ["inject_bad_length", "protocol_format_errors"],
        ["inject_fault", "run_state"],
        ["pause_producer", "producer_pauses"]
    ]) {
        const before = await snapshot(`${control}-before`);
        await write(`${control}-enable`, "variables.write", {
            values: [{ name: `g_appDebug.${control}`, value: "1" }]
        });
        await runFor(control, 1400);
        const after = await snapshot(`${control}-after`);
        if (control === "inject_fault") assert.strictEqual(after.run_state, 3);
        else assert(after[metric] > before[metric], `${metric} did not change`);
        await write(`${control}-clear`, "variables.write", { values: [{ name: `g_appDebug.${control}`, value: "0" }] });
        await runFor(`${control}-recovery`, 1400);
        const recovered = await snapshot(`${control}-recovered`);
        if (control === "inject_fault" || control === "pause_producer") assert.strictEqual(recovered.run_state, 2);
    }
    await request("fault-read", "fault.read");
    await request("debug-relaunch-for-breakpoints", "debug.start");
    await statusPaused("paused-for-breakpoints");
    await request("breakpoint-add", "debug.breakpoints.update", {
        action: "add",
        type: "function",
        function: "AppRtos_OnTim7Elapsed"
    });
    await request("breakpoint-list", "debug.breakpoints.list");
    await request("breakpoint-disable", "debug.breakpoints.update", {
        action: "disable",
        type: "function",
        function: "AppRtos_OnTim7Elapsed"
    });
    await request("breakpoint-enable", "debug.breakpoints.update", {
        action: "enable",
        type: "function",
        function: "AppRtos_OnTim7Elapsed"
    });
    await request("breakpoint-remove", "debug.breakpoints.update", {
        action: "remove",
        type: "function",
        function: "AppRtos_OnTim7Elapsed"
    });
    await request("debug-restart", "debug.control", { action: "restart" });
    await request("debug-status-after-restart", "debug.status");
    await request("debug-stop", "debug.control", { action: "stop" });
    assert.strictEqual((await request("debug-status-after-stop", "debug.status")).state, "none");
}

async function main() {
    await request("config", "config.get");
    await request("probes", "probe.list");
    try {
        await debugAcceptance();
        report.passed = true;
    } finally {
        try {
            const status = await call(workspace, "debug.status", {});
            if (status.state !== "none") await call(workspace, "debug.control", { action: "stop" });
        } catch (error) {
            report.cleanupError = diagnosticForError(error, { operation: "debug.cleanup" });
        }
    }
}

main()
    .catch((error) => {
        report.error = diagnosticForError(error, { operation: "H750 acceptance" });
        process.exitCode = 1;
    })
    .finally(() => {
        report.finishedAt = new Date().toISOString();
        save();
    });
