"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveProbeRsDebugConfiguration } = require("../../src/services/probeRsConfiguration");
const { DapClient } = require("./probe-rs-h723-smoke");

async function main() {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES for this dedicated-board breakpoint test");
    for (const key of ["ELF", "CHIP", "SOURCE", "LINE"])
        if (!process.env[`EMBERPROBE_HIL_${key}`]) throw new Error(`Set EMBERPROBE_HIL_${key}`);
    const elf = path.resolve(process.env.EMBERPROBE_HIL_ELF);
    const source = path.resolve(process.env.EMBERPROBE_HIL_SOURCE);
    const line = Number(process.env.EMBERPROBE_HIL_LINE);
    const sourceInfo = fs.statSync(source);
    assert.ok(
        sourceInfo.isFile() && sourceInfo.size <= 4 * 1024 * 1024,
        "Provide a source file within the 4 MiB budget"
    );
    assert.ok(Number.isSafeInteger(line) && line > 0, "Breakpoint lines are positive, 1-based integers");
    assert.ok(line <= fs.readFileSync(source, "utf8").split("\n").length, "Breakpoint line is outside the source file");
    const config = resolveProbeRsDebugConfiguration(
        { request: "attach", executable: elf, wireProtocol: "Swd" },
        { uri: { fsPath: path.dirname(elf) } },
        elf,
        {
            chip: process.env.EMBERPROBE_HIL_CHIP,
            probe: process.env.EMBERPROBE_HIL_PROBE || "",
            speed: Number(process.env.EMBERPROBE_HIL_SPEED || 2000)
        }
    );
    const dap = new DapClient(process.env.EMBERPROBE_HIL_PROBE_RS || "probe-rs");
    const sourceArgs = { source: { path: source }, sourceModified: false };
    let attached = false;
    let instructionSupported = false;
    let threadId;
    let report;
    let failure;
    const stopped = async (after, reason) => {
        const event = await dap.waitForEvent("stopped", after);
        assert.equal(event.reason, reason);
        assert.ok(Number.isInteger(event.threadId) && event.threadId >= 0, "Expected the stopped core's thread ID");
        threadId = event.threadId;
        return event;
    };
    try {
        const capabilities = await dap.request("initialize", {
            clientID: "emberprobe-breakpoint-hil",
            adapterID: "probe-rs",
            pathFormat: "path",
            linesStartAt1: true,
            columnsStartAt1: true,
            supportsMemoryReferences: true
        });
        instructionSupported = capabilities.supportsInstructionBreakpoints === true;
        await dap.request("attach", config, 30000);
        attached = true;
        await dap.request("configurationDone");
        const beforeBreakpoint = dap.eventCounter;
        const response = await dap.request("setBreakpoints", { ...sourceArgs, breakpoints: [{ line }] });
        const breakpoint = response.breakpoints?.[0];
        assert.equal(breakpoint?.verified, true, breakpoint?.message || "Source breakpoint was not verified");
        await stopped(beforeBreakpoint, "breakpoint");
        const stack = await dap.request("stackTrace", { threadId, startFrame: 0, levels: 8 });
        const frame = stack.stackFrames?.[0];
        assert.ok(frame?.source?.path && frame.line > 0, "Expected a source location for the stopped frame");
        assert.equal(
            Number(frame.instructionPointerReference),
            Number(breakpoint.instructionReference),
            "The stopped address must match the verified source breakpoint"
        );
        const scopes = await dap.request("scopes", { frameId: frame.id });
        const scope = scopes.scopes?.find((item) => /register/i.test(item.name)) || scopes.scopes?.[0];
        assert.ok(scope?.variablesReference > 0, "Expected an inspectable paused scope");
        const variables = await dap.request("variables", { variablesReference: scope.variablesReference, count: 16 });
        assert.ok(Array.isArray(variables.variables), "Expected paused variables or registers");
        await dap.request("setBreakpoints", { ...sourceArgs, breakpoints: [] });
        let instructionHit = false;
        if (instructionSupported) {
            assert.ok(breakpoint.instructionReference, "Expected the source breakpoint's instruction address");
            const instruction = await dap.request("setInstructionBreakpoints", {
                breakpoints: [{ instructionReference: breakpoint.instructionReference }]
            });
            assert.equal(instruction.breakpoints?.[0]?.verified, true, "Instruction breakpoint was not verified");
            const beforeContinue = dap.eventCounter;
            await dap.request("continue", { threadId });
            await stopped(beforeContinue, "breakpoint");
            const instructionStack = await dap.request("stackTrace", { threadId, startFrame: 0, levels: 1 });
            assert.equal(
                Number(instructionStack.stackFrames?.[0]?.instructionPointerReference),
                Number(breakpoint.instructionReference),
                "The stopped address must match the verified instruction breakpoint"
            );
            instructionHit = true;
            await dap.request("setInstructionBreakpoints", { breakpoints: [] });
        }
        const beforeStep = dap.eventCounter;
        await dap.request("next", { threadId, granularity: "statement" });
        await stopped(beforeStep, "step");
        const steppedStack = await dap.request("stackTrace", { threadId, startFrame: 0, levels: 2 });
        assert.ok(steppedStack.stackFrames?.length, "Expected a stack after stepping");
        const beforeResume = dap.eventCounter;
        await dap.request("continue", { threadId });
        await dap.waitForEvent("continued", beforeResume);
        report = {
            chip: config.chip,
            probe: config.probe || "unique",
            elf,
            source,
            requestedLine: line,
            actualLine: breakpoint.line,
            instructionReference: breakpoint.instructionReference,
            stoppedFrame: { name: frame.name, file: frame.source.path, line: frame.line },
            scope: scope.name,
            variableCount: variables.variables.length,
            instructionHit,
            steppedFrame: steppedStack.stackFrames[0],
            resumed: true
        };
    } catch (error) {
        failure = error;
    } finally {
        const cleanupErrors = [];
        if (attached) {
            for (const [command, args] of [
                ["setBreakpoints", { ...sourceArgs, breakpoints: [] }],
                ...(instructionSupported ? [["setInstructionBreakpoints", { breakpoints: [] }]] : [])
            ]) {
                try {
                    await dap.request(command, args, 3000);
                } catch (error) {
                    cleanupErrors.push(error.message);
                }
            }
            const lastState = dap.events.findLast((entry) => ["stopped", "continued"].includes(entry.message.event));
            if (lastState?.message.event === "stopped") {
                try {
                    await dap.request("continue", { threadId: lastState.message.body.threadId }, 3000);
                } catch (error) {
                    cleanupErrors.push(error.message);
                }
            }
        }
        try {
            await dap.close();
        } catch (error) {
            cleanupErrors.push(error.message);
        }
        if (cleanupErrors.length) {
            const cleanupError = new Error(`Breakpoint cleanup failed: ${cleanupErrors.join("; ")}`);
            failure = failure
                ? new AggregateError([failure, cleanupError], "Breakpoint test and cleanup failed")
                : cleanupError;
        }
    }
    if (failure) throw failure;
    console.log(JSON.stringify({ ...report, processExitConfirmed: true }));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
