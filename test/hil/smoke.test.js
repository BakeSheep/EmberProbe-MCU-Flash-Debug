"use strict";

// Extension Host half of run-smoke.js. Every operation goes through the Agent Bridge dispatcher, so
// flash and write requests keep their two-stage confirmation; the runner supplies each confirmation.
// Optional profile checks (sampling, breakpoints, RTOS, peripherals, negative cases) run only when configured.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { sameValue } = require("./smoke-profile");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "HIL_STEP_TIMEOUT" })),
                ms
            );
        })
    ]).finally(() => clearTimeout(timer));
}

function summarize(error) {
    return { message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
}

async function run() {
    const profile = JSON.parse(process.env.EMBERPROBE_SMOKE_PROFILE || "null");
    assert(profile, "EMBERPROBE_SMOKE_PROFILE is required");
    const checks = profile.checks || {};
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    const agent = provider._agentService;
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const elf = path.join(folder, profile.elfRelative);
    const elfSha256 = crypto.createHash("sha256").update(fs.readFileSync(elf)).digest("hex");
    const directory = path.join(extension.extensionPath, "test-results");
    const file = path.join(directory, `hil-smoke-${process.platform}-${profile.name}.json`);
    const report = {
        profile: profile.name,
        platform: process.platform,
        elf: profile.elf,
        elfSha256,
        repeat: profile.repeat || 1,
        startedAt: new Date().toISOString(),
        steps: []
    };
    const save = () => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
    };
    const call = (method, params = {}) => agent.call(method, params);
    const step = async (name, action, timeoutMs = 30000) => {
        const entry = { name, startedAt: new Date().toISOString() };
        report.steps.push(entry);
        const started = Date.now();
        try {
            entry.result = await withTimeout(Promise.resolve().then(action), timeoutMs, name);
            entry.ok = true;
            console.log(`  ok   ${name} (${Date.now() - started} ms)`);
            return entry.result;
        } catch (error) {
            entry.ok = false;
            entry.error = summarize(error);
            // Run-control failures are only diagnosable with the state and stop reason at that moment.
            if (/^(debug|attach|breakpoint|rtos|peripherals|runtime)\./u.test(name))
                entry.debugStatus = await call("debug.status").catch((statusError) => summarize(statusError));
            console.log(`  FAIL ${name}: ${error.code || ""} ${error.message}`);
            throw error;
        } finally {
            entry.ms = Date.now() - started;
            save();
        }
    };
    const waitState = async (accept, timeoutMs = 30000) => {
        const deadline = Date.now() + timeoutMs;
        let status;
        do {
            status = await call("debug.status");
            if (accept(status)) return status;
            await sleep(200);
        } while (Date.now() < deadline);
        throw Object.assign(new Error(`Debug state stayed ${status.state} (${status.reason || "no reason"})`), {
            code: "HIL_DEBUG_STATE"
        });
    };
    const control = async (action, accept) => {
        await call("debug.control", { action });
        return waitState(accept);
    };
    const pausedAfter = (action) => control(action, (next) => next.paused);
    const readValue = async (name) => (await call("variables.read", { variables: [name] })).values?.[name]?.value;
    const readAll = async () => {
        const result = await call("variables.read", { variables: profile.variables.read });
        for (const name of profile.variables.read)
            assert(result.values?.[name], `${name} was not read: ${JSON.stringify(result.variableErrors || {})}`);
        return { source: result.source, values: result.values, firmwareConsistency: result.firmwareConsistency };
    };
    const confirmedWrite = async (name, value) => {
        const plan = await call("variables.write", { values: [{ name, value }] });
        assert(plan.confirmationRequired && plan.confirmationId, "variables.write did not request confirmation");
        const result = await call("variables.write", {
            values: [{ name, value }],
            confirmationId: plan.confirmationId
        });
        const readback = await readValue(name);
        assert(sameValue(readback, value), `${name} read back ${readback}, expected ${value}`);
        return { result, readback, confirmationId: plan.confirmationId };
    };
    // Reads the original value, writes the profile value, verifies it and restores the original.
    const writeRoundTrip = async () => {
        const { name, value } = profile.variables.write;
        const original = await readValue(name);
        assert(original !== undefined && typeof original !== "object", `${name} has no scalar value to restore`);
        const written = await confirmedWrite(name, value);
        const restored = await confirmedWrite(name, String(original));
        return { original, written, restored };
    };
    // A rejection must come from validation, before any confirmation or hardware access.
    const rejected = async (promise, pattern) => {
        let outcome;
        try {
            outcome = await promise;
        } catch (error) {
            assert(pattern.test(error.code || ""), `expected ${pattern}, got ${error.code || ""}: ${error.message}`);
            return { code: error.code, message: error.message };
        }
        assert.fail(`request was not rejected: ${JSON.stringify(outcome).slice(0, 300)}`);
    };
    const flash = async (operation) => {
        const plan = await call("flash.authorize", { elf, elfSha256, operation });
        assert(plan.confirmationRequired && plan.confirmationId, `${operation} did not request confirmation`);
        const result = await call(operation, { elf, elfSha256, confirmationId: plan.confirmationId });
        assert.strictEqual(result.verified, true, `${operation} failed: ${result.detail || "unverified"}`);
        return {
            verified: result.verified,
            elfSha256: result.elfSha256,
            ...(result.programming ? { programming: result.programming } : {}),
            lines: result.lines
        };
    };
    // Launch runs to the entry breakpoint; pausing early would stop before main and leave that
    // breakpoint to be hit by a later continue.
    const pausedAtEntry = async () => {
        await waitState((next) => next.state === "paused" || next.state === "running");
        let status = await waitState((next) => next.paused, 20000).catch(() => call("debug.status"));
        if (!status.paused) status = await pausedAfter("pause");
        return status;
    };
    const fault = async () => {
        const result = await call("fault.read");
        assert(result.targetState, "fault.read returned no target state");
        assert.strictEqual(result.faultDetected, false, `fault detected: ${JSON.stringify(result.faults)}`);
        return result;
    };
    const breakpoint = (action) =>
        call("debug.breakpoints.update", { action, type: "function", function: checks.breakpoint });
    const register = (result, target) =>
        result.registers.find((item) => item.path.toLowerCase() === target.toLowerCase());

    // One full debug session; repeated with --repeat to expose intermittent run-control failures.
    const debugRound = async (suffix) => {
        await step(
            `debug.start${suffix}`,
            async () => ({ started: await call("debug.start"), status: await pausedAtEntry() }),
            90000
        );
        await step(`debug.stepOver${suffix}`, () => pausedAfter("stepOver"));
        await step(`debug.stepIn${suffix}`, () => pausedAfter("stepIn"));
        await step(`debug.stepOut${suffix}`, () => pausedAfter("stepOut"));
        await step(`debug.inspect${suffix}`, async () => {
            const status = await call("debug.status");
            const stack = await call("debug.inspect", { action: "stack", threadId: status.threadId, count: 10 });
            assert(stack.stackFrames?.length, "no stack frames");
            const scopes = await call("debug.inspect", { action: "scopes", frame: stack.stackFrames[0].frame });
            assert(scopes.scopes?.length, "no scopes for the top frame");
            const variables = await call("debug.inspect", {
                action: "variables",
                reference: scopes.scopes[0].reference
            });
            return { top: stack.stackFrames[0].name, scopes: scopes.scopes.map((scope) => scope.name), variables };
        });
        await step(`debug.variables.read${suffix}`, readAll);
        if (profile.variables.write) await step(`debug.variables.write${suffix}`, writeRoundTrip, 60000);
        if (checks.breakpoint) {
            await step(`breakpoint.hit${suffix}`, async () => {
                await breakpoint("add");
                await call("debug.control", { action: "continue" });
                const status = await waitState((next) => next.paused && next.reason === "breakpoint", 15000);
                const stack = await call("debug.inspect", { action: "stack", threadId: status.threadId, count: 5 });
                const top = stack.stackFrames?.[0]?.name || "";
                assert(top.includes(checks.breakpoint), `stopped in ${top}, expected ${checks.breakpoint}`);
                return { status, top };
            });
            await step(`breakpoint.disabled${suffix}`, async () => {
                await breakpoint("disable");
                await control("continue", (next) => next.state === "running");
                await sleep(1500);
                const status = await call("debug.status");
                assert.strictEqual(status.state, "running", `disabled breakpoint still stopped (${status.reason})`);
                await pausedAfter("pause");
                const listed = await breakpoint("remove");
                assert(
                    !listed.breakpoints.some((item) => item.function === checks.breakpoint),
                    "breakpoint was not removed"
                );
                return { status };
            });
        }
        await step(`debug.continue${suffix}`, () => control("continue", (next) => next.state === "running"));
        await step(`debug.running.read${suffix}`, async () => {
            await sleep(500);
            const status = await call("debug.status");
            assert.strictEqual(
                status.state,
                "running",
                `target stopped after continue (${status.reason || "no reason"})`
            );
            return { status, ...(await readAll()) };
        });
        if (profile.variables.write) await step(`runtime.write${suffix}`, runtimeWrite, 60000);
        await step(`debug.pause${suffix}`, () => pausedAfter("pause"));
        // RTOS tasks and clocked peripherals exist only once the firmware has run past its init code.
        if (checks.rtosTasks)
            await step(`rtos.snapshot${suffix}`, async () => {
                const snapshot = await call("rtos.snapshot", { includeStackUsage: false });
                const kernel = JSON.stringify({ ...snapshot.kernel, diagnostics: snapshot.diagnostics });
                assert(snapshot.kernel?.supported, `RTOS kernel not detected: ${kernel}`);
                const names = (snapshot.tasks || []).map((task) => task.name);
                for (const name of checks.rtosTasks)
                    assert(names.includes(name), `missing task ${name} in [${names}] (kernel ${kernel})`);
                return {
                    kernel: snapshot.kernel,
                    tasks: snapshot.tasks.map(({ name, state, priority }) => ({ name, state, priority }))
                };
            });
        if (checks.peripherals) await peripheralChecks(suffix);
        await step(
            `debug.restart${suffix}`,
            async () => {
                await call("debug.control", { action: "restart" });
                return pausedAtEntry();
            },
            60000
        );
        await step(`debug.stop${suffix}`, () => control("stop", (next) => next.state === "none"));
    };
    async function peripheralChecks(suffix) {
        const { read, write, reject } = checks.peripherals;
        await step(`peripherals.read${suffix}`, async () => {
            const result = await call("peripherals.read", { targets: read });
            for (const target of read) assert(register(result, target), `${target} was not read`);
            return result.registers.map(({ path: name, value }) => ({ name, value }));
        });
        if (write)
            await step(`peripherals.write${suffix}`, async () => {
                const original = register(
                    await call("peripherals.read", { targets: [write.target] }),
                    write.target
                ).value;
                const apply = async (value) => {
                    const plan = await call("peripherals.write", { writes: [{ target: write.target, value }] });
                    assert(
                        plan.confirmationRequired && plan.confirmationId,
                        "peripherals.write did not request confirmation"
                    );
                    const result = await call("peripherals.write", {
                        writes: [{ target: write.target, value }],
                        confirmationId: plan.confirmationId
                    });
                    assert(
                        result.results?.every((item) => item.verified),
                        "peripheral write was not verified"
                    );
                    return result.results;
                };
                return { original, written: await apply(write.value), restored: await apply(original) };
            });
        if (reject.length)
            await step(`peripherals.reject${suffix}`, async () => {
                const outcomes = [];
                for (const item of reject)
                    outcomes.push(
                        await rejected(
                            call("peripherals.write", { writes: [{ target: item.target, value: item.value }] }),
                            new RegExp(`^${item.code}$`, "u")
                        )
                    );
                return outcomes;
            });
    }
    // Running writes need live sampling of the managed OpenOCD session and aligned 32-bit targets.
    async function runtimeWrite() {
        const { name } = profile.variables.write;
        await call("watch.add", { variables: [name], destination: "sidebar" });
        await call("sampling.start", { intervalMs: 50 });
        try {
            const deadline = Date.now() + 15000;
            let sampling;
            do {
                sampling = await call("sampling.status");
                if (sampling.mode === "debug-running-sampling" && sampling.canWrite) break;
                await sleep(200);
            } while (Date.now() < deadline);
            assert(
                sampling.mode === "debug-running-sampling" && sampling.canWrite,
                `sampling not writable: ${sampling.mode}`
            );
            const result = await writeRoundTrip();
            assert.strictEqual((await call("debug.status")).state, "running", "a running write stopped the target");
            return { mode: sampling.mode, ...result };
        } finally {
            await call("sampling.stop");
        }
    }

    try {
        await step("configure", async () => {
            const config = vscode.workspace.getConfiguration("emberprobe");
            // openocdPath is deliberately not settable through the Bridge; set it like a user would.
            await config.update("openocdPath", profile.openocd, vscode.ConfigurationTarget.Workspace);
            await config.update("armToolchainPath", profile.toolchain, vscode.ConfigurationTarget.Workspace);
            return call("config.set", {
                values: {
                    elf: profile.elfRelative,
                    debugger: profile.probe,
                    mcu: profile.target,
                    transport: profile.transport,
                    probeSerial: profile.probeSerial,
                    adapterSpeedKhz: profile.adapterSpeedKhz,
                    rtos: profile.rtos,
                    ...(profile.svdRelative ? { svd: profile.svdRelative } : {})
                }
            });
        });
        await step("probe.list", () => call("probe.list"));
        await step("chip.read", async () => {
            const info = await call("chip.read", { sections: ["identity", "debug"] });
            assert(info.cpuid || info.deviceId || info.chip, "chip.read returned no identity");
            return info;
        });
        await step("flash.execute", () => flash("flash.execute"), 180000);
        await step("flash.verify", () => flash("flash.verify"), 180000);
        await step("fault.read", fault);
        await step("variables.read", readAll);
        if (profile.variables.write) await step("variables.write", writeRoundTrip, 60000);
        if (checks.sampling)
            await step(
                "variables.sample",
                async () => {
                    const { variable, count, intervalMs, increasing } = checks.sampling;
                    const result = await call("variables.sample", { variables: [variable], count, intervalMs });
                    const samples = result.samples || [];
                    assert.strictEqual(samples.length, count, `expected ${count} samples, got ${samples.length}`);
                    const times = samples.map((sample) => sample.timestamp);
                    assert(
                        times.every((time, index) => !index || time >= times[index - 1]),
                        "timestamps went backwards"
                    );
                    const span = times.at(-1) - times[0];
                    assert(span >= (count - 1) * intervalMs * 0.5, `samples spanned only ${span} ms`);
                    const values = samples.map((sample) => sample.values?.[variable]?.value);
                    if (increasing)
                        assert(Number(values.at(-1)) > Number(values[0]), `${variable} did not increase: ${values}`);
                    return { source: result.source, span, first: values[0], last: values.at(-1) };
                },
                120000
            );
        if (checks.negative)
            await step(
                "negative",
                async () => {
                    const outcomes = {
                        unknownSymbol: await rejected(
                            call("variables.write", { values: [{ name: "__emberprobe_missing_symbol", value: "1" }] }),
                            /^VARIABLE_NOT_FOUND$/u
                        ),
                        flashDigestMismatch: await rejected(
                            call("flash.authorize", { elf, elfSha256: "0".repeat(64), operation: "flash.execute" }),
                            /^ELF_CHANGED_DURING_FLASH_CONFIRMATION$/u
                        ),
                        flashWithoutConfirmation: await rejected(
                            call("flash.execute", { elf, elfSha256 }),
                            /^FLASH_CONFIRMATION_REQUIRED$/u
                        )
                    };
                    const { readOnly, outOfBounds } = checks.negative;
                    if (readOnly)
                        outcomes.readOnly = await rejected(
                            call("variables.write", { values: [{ name: readOnly, value: "1" }] }),
                            /WRITE_NOT_ALLOWED/u
                        );
                    if (outOfBounds)
                        outcomes.outOfBounds = await rejected(
                            call("variables.write", { values: [{ name: outOfBounds, value: "1" }] }),
                            /INVALID_VARIABLE_PATH|VARIABLE_NOT_FOUND|UNSUPPORTED_VARIABLE|WRITE_NOT_ALLOWED/u
                        );
                    if (profile.variables.write) {
                        // Rewriting the current value is harmless even if a consumed confirmation were accepted.
                        const { name } = profile.variables.write;
                        const current = String(await readValue(name));
                        const { confirmationId } = await confirmedWrite(name, current);
                        outcomes.confirmationReuse = await rejected(
                            call("variables.write", { values: [{ name, value: current }], confirmationId }),
                            /^WRITE_CONFIRMATION_INVALID$/u
                        );
                    }
                    return outcomes;
                },
                120000
            );
        if (profile.debug) {
            const rounds = profile.repeat || 1;
            for (let round = 1; round <= rounds; round++) await debugRound(rounds > 1 ? ` #${round}` : "");
            if (profile.variables.write) {
                // Attach must neither reset nor reload: a marker written before attaching must survive.
                const { name, value } = profile.variables.write;
                let original;
                await step(
                    "attach.prepare",
                    async () => {
                        original = await readValue(name);
                        return confirmedWrite(name, value);
                    },
                    60000
                );
                await step(
                    "attach.start",
                    async () => {
                        await provider.commandHandlers["mcu-vscode.attachDebug"]();
                        let status = await waitState((next) => next.state === "paused" || next.state === "running");
                        if (!status.paused) status = await pausedAfter("pause");
                        return status;
                    },
                    90000
                );
                await step(
                    "attach.verify",
                    async () => {
                        const marker = await readValue(name);
                        assert(
                            sameValue(marker, value),
                            `attach lost the marker: ${name}=${marker}, expected ${value}`
                        );
                        return { marker, restored: await confirmedWrite(name, String(original)) };
                    },
                    60000
                );
                await step("attach.stop", () => control("stop", (next) => next.state === "none"));
            }
            // The probe must be free again once the debug session has gone.
            await step("chip.read.afterDebug", () => call("chip.read", { sections: ["runtime"] }));
            await step("fault.read.afterDebug", fault);
        }
        report.passed = true;
    } catch (error) {
        report.passed = false;
        report.error = summarize(error);
        throw error;
    } finally {
        try {
            await call("sampling.stop").catch(() => {});
            const status = await call("debug.status");
            if (status.state !== "none") {
                await withTimeout(call("debug.control", { action: "stop" }), 20000, "debug cleanup");
                report.cleanup = "debug stopped";
            }
            if (checks.breakpoint) await breakpoint("remove").catch(() => {});
        } catch (error) {
            report.cleanupError = summarize(error);
        }
        report.finishedAt = new Date().toISOString();
        save();
    }
}

module.exports = { run };
