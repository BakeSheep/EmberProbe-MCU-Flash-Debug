"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    assert(!vscode.extensions.getExtension("marus25.cortex-debug"), "Cortex-Debug must not be installed");
    const provider = extension.exports.debugTestProvider;
    const folder = vscode.workspace.workspaceFolders[0];
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-dap-"));
    fs.writeFileSync(path.join(temp, "main.c"), "// simulated source\n".repeat(15));
    const suffix = process.platform === "win32" ? ".exe" : "";
    const fakeOpenOcd = path.join(temp, "bin", "openocd" + suffix);
    fs.mkdirSync(path.dirname(fakeOpenOcd), { recursive: true });
    fs.writeFileSync(fakeOpenOcd, "fixture");
    fs.chmodSync(fakeOpenOcd, 0o755);
    for (const file of ["interface/stlink.cfg", "target/stm32f1x.cfg"]) {
        const target = path.join(temp, "openocd", "scripts", file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "# fixture");
    }
    for (const name of ["objdump", "nm"]) {
        fs.writeFileSync(path.join(temp, name + suffix), "fixture");
        fs.chmodSync(path.join(temp, name + suffix), 0o755);
    }
    const originals = new Map();
    const replace = (name, value) => {
        originals.set(name, provider[name]);
        provider[name] = value;
    };
    const keys = ["mcu.debugger", "mcu.mcuCore"];
    const saved = keys.map((key) => provider._context.workspaceState.get(key));
    const disposables = [];
    let session;
    let stopped = 0;
    let serverStops = 0;
    const wait = async (predicate) => {
        const deadline = Date.now() + 15000;
        while (!predicate()) {
            assert(Date.now() < deadline, "Debug event timed out");
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    try {
        await provider._context.workspaceState.update(keys[0], "stlink.cfg");
        await provider._context.workspaceState.update(keys[1], "stm32f1x.cfg");
        replace("_resolveOpenOcdPath", async () => fakeOpenOcd);
        replace("_startManagedDebugServer", async () => {
            provider._managedDebugServer = {
                setSamplingEnabled() {},
                stop: async () => serverStops++,
                waitForIdle: async () => true
            };
            return { gdbTarget: "127.0.0.1:3333" };
        });
        disposables.push(
            vscode.debug.registerDebugAdapterDescriptorFactory("emberprobe", {
                createDebugAdapterDescriptor() {
                    return new vscode.DebugAdapterExecutable(
                        process.execPath,
                        [path.join(extension.extensionPath, "test/fixtures/fake-debug-adapter.js")],
                        { env: { ELECTRON_RUN_AS_NODE: "1" } }
                    );
                }
            })
        );
        disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory("emberprobe", {
                createDebugAdapterTracker() {
                    return {
                        onDidSendMessage: (message) => {
                            if (message.event === "stopped") stopped++;
                        }
                    };
                }
            })
        );
        disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === "emberprobe") session = s;
            })
        );
        disposables.push(
            vscode.debug.onDidTerminateDebugSession((s) => {
                if (s === session) session = null;
            })
        );
        const started = await vscode.debug.startDebugging(folder, {
            type: "emberprobe",
            request: "launch",
            name: "EmberProbe hardware-free E2E",
            executable: __filename,
            cwd: temp,
            gdbPath: process.execPath,
            objdumpPath: path.join(temp, "objdump" + suffix)
        });
        assert(started);
        await wait(() => session && stopped > 0);
        const threads = await session.customRequest("threads", {});
        assert.strictEqual(threads.threads[0].id, 1);
        const stack = await session.customRequest("stackTrace", { threadId: 1 });
        assert.strictEqual(stack.stackFrames[0].name, "main");
        const result = await session.customRequest("evaluate", {
            expression: "counter",
            frameId: stack.stackFrames[0].id
        });
        assert.strictEqual(result.result, "3");
        await vscode.debug.stopDebugging(session);
        await wait(() => !session && serverStops === 1);
        assert(!provider._managedDebugServer);
        console.log("✓ independent EmberProbe F5 session over real DAP and simulated GDB, without Cortex-Debug");
    } finally {
        if (session) await vscode.debug.stopDebugging(session);
        for (const disposable of disposables) disposable.dispose();
        for (const [name, value] of originals) provider[name] = value;
        for (let i = 0; i < keys.length; i++) await provider._context.workspaceState.update(keys[i], saved[i]);
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
module.exports = { run };
