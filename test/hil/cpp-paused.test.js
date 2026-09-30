"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    await provider._context.workspaceState.update("mcu.debugger", process.env.CPP_BOARD_PROBE);
    await provider._context.workspaceState.update("mcu.mcuCore", process.env.CPP_BOARD_TARGET);
    let session,
        stopped = false;
    const output = [];
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory("emberprobe", {
        createDebugAdapterTracker(current) {
            session = current;
            return {
                onDidSendMessage(message) {
                    if (message.event === "stopped") {
                        stopped = true;
                        thread = message.body.threadId;
                    }
                    if (message.event === "continued") stopped = false;
                    if (message.event === "output") output.push(message.body.output);
                }
            };
        }
    });
    const report = {
        executable: process.env.CPP_BOARD_ELF,
        gdb: process.env.CPP_BOARD_GDB,
        rtos: process.env.CPP_BOARD_RTOS || "",
        values: {},
        output: ""
    };
    const resolveOpenOcd = provider._resolveOpenOcdPath;
    const startServer = provider._startManagedDebugServer;
    provider._resolveOpenOcdPath = async (...args) => {
        const executable = await resolveOpenOcd.apply(provider, args);
        report.openocd = executable;
        return executable;
    };
    provider._startManagedDebugServer = async (...args) => {
        try {
            return await startServer.apply(provider, args);
        } catch (error) {
            report.serverError = { message: error.message, code: error.code, details: error.details };
            throw error;
        }
    };
    const directory = path.join(extension.extensionPath, "test-results");
    let thread;
    try {
        assert(
            await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
                type: "emberprobe",
                request: "attach",
                name: "EmberProbe read-only C++ board acceptance",
                executable: process.env.CPP_BOARD_ELF,
                gdbPath: process.env.CPP_BOARD_GDB,
                rtos: process.env.CPP_BOARD_RTOS || "",
                enablePrettyPrinting: true
            })
        );
        const deadline = Date.now() + 30000;
        while (!stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        assert(stopped, "Board attach did not stop: " + output.join(""));
        const threads = await session.customRequest("threads", {});
        report.threads = threads.threads;
        thread = threads.threads[0].id;
        // These are globals: unwinding a busy RTOS idle stack is not required to inspect their contents.
        const evaluate = (expression) => session.customRequest("evaluate", { expression });
        for (const name of ["app::g_statusText", "app::g_trend", "app::g_sensorOwner"]) {
            const value = await evaluate(name);
            report.values[name] = value;
            assert(!/unavailable|^\{/.test(value.result), `${name} fell back: ${value.result}`);
            if (value.variablesReference)
                report.values[name].children = (
                    await session.customRequest("variables", {
                        variablesReference: value.variablesReference,
                        count: 100
                    })
                ).variables;
        }
        assert.match(report.values["app::g_statusText"].result, /length \d+/);
        assert.match(report.values["app::g_trend"].result, /vector length \d+/);
        assert.match(report.values["app::g_sensorOwner"].result, /unique_ptr 0x/);
        assert(report.values["app::g_trend"].children.length > 0);
        assert(report.values["app::g_trend"].children.every((value) => /^\[\d+\]$/.test(value.name)));
        assert.strictEqual(report.values["app::g_sensorOwner"].children[0].name, "value");
        assert(report.values["app::g_sensorOwner"].children[0].variablesReference > 0);
        report.values["app::g_sensorOwner"].pointee = (
            await session.customRequest("variables", {
                variablesReference: report.values["app::g_sensorOwner"].children[0].variablesReference,
                count: 100
            })
        ).variables;
        assert(!/Built-in STL display unavailable/.test(output.join("")), "STL expansion fell back");
        report.passed = true;
        console.log("✓ H750 ordinary ARM GDB: string, vector and unique_ptr over managed DAP passed");
    } catch (error) {
        report.error = error.message;
        throw error;
    } finally {
        report.output = output.join("");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "cpp-board.json"), JSON.stringify(report, null, 2));
        try {
            if (session) {
                try {
                    if (stopped && thread) await session.customRequest("continue", { threadId: thread });
                } finally {
                    await vscode.debug.stopDebugging(session);
                }
            }
        } finally {
            tracker.dispose();
            provider._resolveOpenOcdPath = resolveOpenOcd;
            provider._startManagedDebugServer = startServer;
        }
    }
}

module.exports = { run };
