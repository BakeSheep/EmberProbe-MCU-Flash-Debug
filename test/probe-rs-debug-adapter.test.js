"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProbeRsDebugAdapter, MAX_FRAME_BYTES } = require("../src/services/probeRsDebugAdapter");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { DapClient } = require("./hil/probe-rs-h723-smoke");

function frame(message) {
    const body = JSON.stringify(message);
    return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function fixture(options = {}) {
    const coordinator = new ProbeCoordinator();
    const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
            kills++;
            if (options.closeOnKill) this.emit("close", 0);
            return true;
        }
    });
    const messages = [];
    child.stdin.once("finish", () => {
        if (options.closeOnInputEnd) child.emit("close", 0);
    });
    const errors = [];
    const spawns = [];
    let kills = 0;
    let exits = 0;
    let disposed = false;
    const adapter = new ProbeRsDebugAdapter({
        coordinator,
        executable: "probe-rs",
        cwd: process.cwd(),
        emitter: {
            event: () => {},
            fire: (message) => messages.push(message),
            dispose: () => {
                disposed = true;
            }
        },
        resolveSourceLines: options.resolveSourceLines,
        onError: (error) => errors.push(error),
        onExit: () => exits++,
        spawnProcess: (...args) => {
            spawns.push(args);
            assert.equal(coordinator.isActive("debugStart"), true, "ownership precedes spawning");
            if (options.throwSpawn) throw new Error("spawn failed");
            return child;
        },
        exitTimeoutMs: 5,
        startupTimeoutMs: options.startupTimeoutMs || 10000
    });
    return {
        adapter,
        child,
        coordinator,
        messages,
        errors,
        spawns,
        get kills() {
            return kills;
        },
        get exits() {
            return exits;
        },
        get disposed() {
            return disposed;
        }
    };
}

async function verifyBreakpointProcess() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-breakpoint-dap-"));
    const source = path.join(directory, "main.rs");
    const fixture = path.join(__dirname, "fixtures", "fake-probe-rs-adapter.js");
    fs.writeFileSync(path.join(directory, "dap-server"), `require(${JSON.stringify(fixture)});\n`);
    fs.writeFileSync(source, "fn main() {\n    let mut counter = 3;\n    counter += 1;\n}\n");
    const dap = new DapClient(process.execPath, { cwd: directory });
    try {
        const capabilities = await dap.request("initialize", {
            pathFormat: "path",
            linesStartAt1: true,
            columnsStartAt1: true
        });
        assert.equal(capabilities.supportsInstructionBreakpoints, true);
        assert.equal(capabilities.supportsFunctionBreakpoints, undefined);
        await dap.request("attach");
        await dap.request("configurationDone");
        const marker = dap.eventCounter;
        const verified = await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: 2 }] });
        assert.equal(verified.breakpoints[0].verified, true);
        assert.equal((await dap.waitForEvent("stopped", marker)).reason, "breakpoint");
        const stack = await dap.request("stackTrace", { threadId: 1 });
        assert.equal(stack.stackFrames[0].line, 2);
        assert.equal(stack.stackFrames[0].source.path, source);
        const scopes = await dap.request("scopes", { frameId: stack.stackFrames[0].id });
        const reference = scopes.scopes[0].variablesReference;
        const locals = await dap.request("variables", { variablesReference: reference });
        assert.equal(locals.variables[0].value, "3");
        // Wait after the event has already arrived to exercise response/event races.
        assert.equal((await dap.waitForEvent("stopped", marker)).threadId, 1);
        await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [] });
        const instructions = await dap.request("setInstructionBreakpoints", {
            breakpoints: [{ instructionReference: "0x08000104" }]
        });
        assert.equal(instructions.breakpoints[0].verified, true);
        const beforeContinue = dap.eventCounter;
        await dap.request("continue", { threadId: 1 });
        assert.equal((await dap.waitForEvent("stopped", beforeContinue)).reason, "breakpoint");
        const instructionStack = await dap.request("stackTrace", { threadId: 1 });
        assert.equal(instructionStack.stackFrames[0].instructionPointerReference, "0x08000104");
        await dap.request("setInstructionBreakpoints", { breakpoints: [] });
        const beforeStep = dap.eventCounter;
        await dap.request("next", { threadId: 1 });
        assert.equal((await dap.waitForEvent("stopped", beforeStep)).reason, "step");
        await assert.rejects(dap.request("variables", { variablesReference: reference }), /Stale variable/);
        const invalid = await dap.request("setBreakpoints", { source: { path: source }, breakpoints: [{ line: 999 }] });
        assert.equal(invalid.breakpoints[0].verified, false);
        const beforeResume = dap.eventCounter;
        await dap.request("continue", { threadId: 1 });
        assert.equal((await dap.waitForEvent("continued", beforeResume)).threadId, 1);
        await assert.rejects(dap.waitForEvent("stopped", dap.eventCounter, 5), /event timed out/);
        const pendingEvent = dap.waitForEvent("stopped");
        const rejectedOnExit = assert.rejects(pendingEvent, /DAP exited/);
        await dap.close();
        await rejectedOnExit;
        await assert.rejects(dap.waitForEvent("stopped"), /DAP exited/);
        console.log(
            "probe-rs fixture DAP breakpoint hits, paused scopes, stepping, stale references and cleanup passed"
        );
    } finally {
        await dap.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function main() {
    const proxy = fixture({
        closeOnKill: true,
        resolveSourceLines: async () => [{ address: 0x08000100, line: 2, column: 9 }]
    });
    const proxiedRequests = [];
    proxy.child.stdin.on("data", (data) => {
        const request = JSON.parse(data.subarray(data.indexOf("\r\n\r\n") + 4).toString());
        proxiedRequests.push(request);
        const body =
            request.command === "initialize"
                ? { supportsInstructionBreakpoints: true }
                : request.command === "setBreakpoints"
                  ? {
                        breakpoints: request.arguments.breakpoints.map((bp) => ({
                            ...bp,
                            verified: false,
                            message: "No valid breakpoint information found"
                        }))
                    }
                  : { breakpoints: request.arguments.breakpoints.map((bp) => ({ ...bp, id: 19, verified: true })) };
        proxy.child.stdout.write(
            frame({
                type: "response",
                seq: proxiedRequests.length,
                request_seq: request.seq,
                command: request.command,
                success: true,
                body
            })
        );
    });
    proxy.adapter.start();
    proxy.adapter.handleMessage({
        type: "request",
        seq: 41,
        command: "initialize",
        arguments: { pathFormat: "path", linesStartAt1: true }
    });
    assert.equal(proxy.messages[0].request_seq, 41);
    proxy.adapter.handleMessage({
        type: "request",
        seq: 42,
        command: "setBreakpoints",
        arguments: { source: { path: "C:/app.cpp" }, breakpoints: [{ line: 2 }] }
    });
    await proxy.adapter.breakpoints.queue;
    assert.equal(proxy.messages.length, 2, "internal failed source and instruction responses stay hidden from VS Code");
    assert.equal(proxy.messages[1].request_seq, 42);
    assert.equal(proxy.messages[1].body.breakpoints[0].verified, true);
    assert.equal(proxy.messages[1].body.breakpoints[0].line, 2);
    assert.equal(proxy.adapter.internalRequests.size, 0);
    assert.equal(proxy.adapter.clientRequests.size, 0);
    await proxy.adapter.stop();

    const busy = fixture();
    const download = busy.coordinator.acquire("download");
    assert.throws(() => busy.adapter.start(), { code: "PROBE_BUSY" });
    assert.equal(busy.spawns.length, 0);
    download.release();
    const state = busy;
    const { adapter, coordinator, child } = state;
    adapter.start();
    assert.throws(() => adapter.start(), /already/);
    assert.deepEqual(state.spawns[0].slice(0, 2), ["probe-rs", ["dap-server"]]);
    assert.equal(state.spawns[0][2].windowsHide, true);
    assert.throws(() => coordinator.acquire("cpuLoad"), { code: "PROBE_BUSY" });

    const request = { type: "request", seq: 1, command: "initialize", arguments: {} };
    adapter.handleMessage(request);
    assert.equal(child.stdin.read().toString(), frame(request).toString());
    const output = { type: "event", seq: 2, event: "output", body: { output: "中文" } };
    const initialized = { type: "response", seq: 3, command: "initialize", success: true };
    const input = Buffer.concat([frame(output), frame(initialized)]);
    child.stdout.write(input.subarray(0, 13));
    assert.equal(state.messages.length, 0);
    child.stdout.write(input.subarray(13));
    assert.deepEqual(state.messages, [output, initialized]);
    assert.equal(coordinator.isActive("debugStart"), true);
    child.stdout.write(frame({ type: "response", seq: 4, command: "attach", success: true }));
    assert.equal(coordinator.isActive("debugServer"), true);
    assert.equal(coordinator.isActive("debugStart"), false);
    child.stdout.write(frame({ type: "event", seq: 5, event: "terminated" }));
    assert.equal(coordinator.isActive("debugServer"), true, "terminated is not process exit confirmation");
    child.stderr.write("x".repeat(3000));
    assert.equal(adapter.stderr.length, 2000);
    assert.equal(await adapter.stop(), false);
    assert.equal(coordinator.isActive("debugServer"), true, "unconfirmed process exit retains ownership");
    const pendingExit = adapter.waitForExit(100);
    child.emit("close", 0);
    assert.equal(await pendingExit, true);
    assert.equal(coordinator.anyActive(), false);
    assert.equal(state.exits, 1);
    child.emit("close", 0);
    adapter.handleMessage(request);
    assert.equal(state.exits, 1);
    assert.equal(await adapter.stop(), true);
    adapter.dispose();
    await Promise.resolve();
    assert.equal(state.disposed, true);

    const throwing = fixture({ throwSpawn: true });
    assert.throws(() => throwing.adapter.start(), /spawn failed/);
    assert.equal(throwing.coordinator.anyActive(), false);
    const absent = fixture();
    absent.adapter.start();
    delete absent.child.pid;
    absent.child.emit("error", new Error("ENOENT"));
    assert.equal(absent.coordinator.anyActive(), false);

    for (const input of [
        Buffer.from("Content-Length: 0\r\n\r\n"),
        Buffer.from(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`),
        Buffer.from("Content-Length: 1\r\nContent-Length: 1\r\n\r\nx"),
        Buffer.from("Content-Length: 1\r\n\r\nx"),
        Buffer.alloc(8193, 65),
        Buffer.alloc(MAX_FRAME_BYTES + 8193),
        frame({ type: "invalid" })
    ]) {
        const invalid = fixture({ closeOnKill: true });
        invalid.adapter.start();
        invalid.child.stdout.write(input);
        assert.equal(invalid.errors.length, 1);
        assert.equal(invalid.coordinator.anyActive(), false);
        assert.equal(invalid.kills, 1);
    }
    const failedLaunch = fixture({ closeOnKill: true });
    failedLaunch.adapter.start();
    failedLaunch.child.stdout.write(frame({ type: "response", seq: 1, command: "launch", success: false }));
    assert.equal(await failedLaunch.adapter.waitForExit(100), true);
    assert.equal(failedLaunch.coordinator.anyActive(), false);
    const timeout = fixture({ closeOnKill: true, startupTimeoutMs: 5 });
    timeout.adapter.start();
    assert.equal(await timeout.adapter.waitForExit(1000), true);
    assert.match(timeout.errors[0].message, /Timed out/);
    assert.equal(timeout.coordinator.anyActive(), false);
    const cancelled = fixture({ closeOnKill: true });
    cancelled.adapter.start();
    cancelled.adapter.dispose();
    assert.equal(await cancelled.adapter.waitForExit(100), true);
    assert.equal(cancelled.coordinator.anyActive(), false);
    const graceful = fixture({ closeOnInputEnd: true });
    graceful.adapter.start();
    graceful.child.stdout.write(frame({ type: "response", seq: 1, command: "attach", success: true }));
    graceful.adapter.dispose();
    assert.equal(await graceful.adapter.waitForExit(100), true);
    assert.equal(graceful.kills, 0, "normal disconnect must allow USB cleanup before considering a forced kill");
    assert.equal(graceful.coordinator.anyActive(), false);
    await verifyBreakpointProcess();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
