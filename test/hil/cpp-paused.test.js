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
    const config = vscode.workspace.getConfiguration("emberprobe");
    if (process.env.CPP_BOARD_OPENOCD)
        await config.update("openocdPath", process.env.CPP_BOARD_OPENOCD, vscode.ConfigurationTarget.Workspace);
    if (process.env.CPP_BOARD_TRANSPORT)
        await config.update("transport", process.env.CPP_BOARD_TRANSPORT, vscode.ConfigurationTarget.Workspace);
    if (process.env.CPP_BOARD_PROBE_SERIAL)
        await config.update("probeSerial", process.env.CPP_BOARD_PROBE_SERIAL, vscode.ConfigurationTarget.Workspace);
    if (process.env.CPP_BOARD_ADAPTER_SPEED_KHZ)
        await config.update(
            "adapterSpeedKhz",
            Number(process.env.CPP_BOARD_ADAPTER_SPEED_KHZ),
            vscode.ConfigurationTarget.Workspace
        );
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
        openocd: process.env.CPP_BOARD_OPENOCD || "openocd",
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
        if (process.env.CPP_BOARD_RTOS !== "FreeRTOS")
            assert(report.values["app::g_sensorOwner"].children[0].variablesReference > 0);
        report.values["app::g_sensorOwner"].pointee = (
            await session.customRequest("variables", {
                variablesReference: report.values["app::g_sensorOwner"].children[0].variablesReference,
                count: 100
            })
        ).variables;
        if (process.env.CPP_BOARD_RTOS === "FreeRTOS") {
            const names = new Set(report.threads.map((item) => item.name));
            for (const expected of [
                "defaultTask",
                "imuProducer",
                "controlTask",
                "protocolTx",
                "protocolRx",
                "rtosMonitor",
                "dynamicTask"
            ])
                assert(names.has(expected), `Missing FreeRTOS task: ${expected}`);
            const debugValue = await evaluate("g_appDebug");
            const debugChildren = await session.customRequest("variables", {
                variablesReference: debugValue.variablesReference,
                count: 200
            });
            assert(
                debugChildren.variables.some((item) => item.name === "delete_dynamic_task"),
                "g_appDebug controls were not expanded"
            );
            await session.customRequest("setVariable", {
                variablesReference: debugValue.variablesReference,
                name: "delete_dynamic_task",
                value: "1"
            });
            const nested = await evaluate("app::g_nestedTrend");
            report.values["app::g_nestedTrend"] = nested;
            assert.match(nested.result, /vector length 2/);
            const nestedRows = await session.customRequest("variables", {
                variablesReference: nested.variablesReference,
                count: 10
            });
            assert(nestedRows.variables[0]?.variablesReference > 0, "Nested vector element did not expand");
            const nestedElement = await session.customRequest("variables", {
                variablesReference: nestedRows.variables[0].variablesReference,
                count: 10
            });
            const nestedBefore = nestedElement.variables.find((item) => item.name === "[1]")?.value;
            await session.customRequest("setVariable", {
                variablesReference: nestedRows.variables[0].variablesReference,
                name: "[1]",
                value: "9.5"
            });
            const nestedAfter = await session.customRequest("variables", {
                variablesReference: nestedRows.variables[0].variablesReference,
                count: 10
            });
            const nestedAfterValue = nestedAfter.variables.find((item) => item.name === "[1]")?.value || "";
            report.values["app::g_nestedTrend[0][1]"] = { before: nestedBefore, after: nestedAfterValue };
            assert(/9\.5/.test(nestedAfterValue), `Nested STL write was not retained: ${nestedAfterValue}`);
            const dynamicThread = report.threads.find((item) => item.name === "dynamicTask");
            await session.customRequest("continue", { threadId: thread });
            await new Promise((resolve) => setTimeout(resolve, 800));
            await session.customRequest("pause", {});
            const afterDelete = await session.customRequest("threads", {});
            report.threadsAfterDelete = afterDelete.threads;
            assert(!afterDelete.threads.some((item) => item.name === "dynamicTask"), "dynamicTask was not deleted");
            await assert.rejects(
                session.customRequest("next", { threadId: dynamicThread.id }),
                /DEBUG_TASK_EXITED|no longer exists|thread/i
            );
        }
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
