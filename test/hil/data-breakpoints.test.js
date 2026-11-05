"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { waitFor } = require("../helpers/wait");

// Match every ELF load image in internal Flash before using its variable addresses.
async function verifyFlash(session, elf, directory) {
    assert.strictEqual(elf.readUInt32LE(0), 0x464c457f, "Not an ELF");
    assert.strictEqual(elf[4], 1, "Only ELF32 is accepted by this board test");
    assert.strictEqual(elf[5], 1, "Only little-endian firmware is accepted");
    const offset = elf.readUInt32LE(28);
    const size = elf.readUInt16LE(42);
    const count = elf.readUInt16LE(44);
    let verifiedBytes = 0;
    const segments = [];
    for (let i = 0; i < count; i++) {
        const at = offset + size * i;
        if (elf.readUInt32LE(at) !== 1) continue;
        const address = elf.readUInt32LE(at + 12);
        const length = elf.readUInt32LE(at + 16);
        const fileOffset = elf.readUInt32LE(at + 4);
        if (!length || address < 0x08000000 || address + length > 0x10000000) continue;
        assert(length <= 4 * 1024 * 1024 && fileOffset + length <= elf.length, "Invalid Flash load image");
        for (let start = 0; start < length; start += 4096) {
            const bytes = Math.min(4096, length - start);
            const result = await session.customRequest("readMemory", {
                memoryReference: `0x${(address + start).toString(16)}`,
                count: bytes
            });
            const actual = Buffer.from(result.data || "", "base64");
            const expected = elf.subarray(fileOffset + start, fileOffset + start + bytes);
            if (!actual.equals(expected))
                fs.writeFileSync(
                    path.join(directory, `data-breakpoints-flash-${(address + start).toString(16)}.bin`),
                    actual
                );
            assert(
                actual.equals(expected),
                `ELF/board mismatch at 0x${(address + start).toString(16)}; no variable tests performed`
            );
            verifiedBytes += bytes;
        }
        segments.push({ address: `0x${address.toString(16)}`, length });
    }
    assert(verifiedBytes > 0, "No internal Flash segment was checked");
    return { verifiedBytes, segments };
}

async function screenshot(port, directory, prepare) {
    const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })
    ).json();
    const target = targets.find((item) => item.type === "page" && /workbench/i.test(item.url));
    assert(target, "VS Code workbench CDP target missing");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error("Workbench CDP connection timed out"));
        }, 10000);
        socket.addEventListener(
            "open",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
        socket.addEventListener(
            "error",
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
            { once: true }
        );
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
        const result = JSON.parse(event.data);
        const waiter = pending.get(result.id);
        if (!waiter) return;
        pending.delete(result.id);
        clearTimeout(waiter.timer);
        if (result.error) waiter.reject(new Error(result.error.message));
        else waiter.resolve(result.result);
    });
    const command = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Workbench CDP ${method} timed out`));
            }, 10000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });
    try {
        let failure;
        try {
            if (prepare) await prepare(command);
        } catch (error) {
            failure = error;
        }
        const image = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const file = path.join(directory, "data-breakpoints-board.png");
        fs.writeFileSync(file, Buffer.from(image.data, "base64"));
        const text = await command("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
        fs.writeFileSync(path.join(directory, "data-breakpoints-board-ui.txt"), text.result.value);
        if (failure) throw failure;
        return { file, text: text.result.value };
    } finally {
        socket.close();
    }
}

async function chooseDataBreakpoint(command, expression) {
    const observe = async (query) =>
        (
            await command("Runtime.evaluate", {
                expression: `new Promise(resolve => {
            const query = ${query};
            const observer = new MutationObserver(check);
            const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, 8000);
            function check() {
                const result = query();
                if (result) { observer.disconnect(); clearTimeout(timer); resolve(result); }
            }
            observer.observe(document.body, { childList: true, subtree: true, attributes: true });
            check();
        })`,
                returnByValue: true,
                awaitPromise: true
            })
        ).result.value;
    const position = await observe(`() => {
        const row = [...document.querySelectorAll('.debug-watch .monaco-list-row')]
            .find(node => node.innerText.includes(${JSON.stringify(expression)}));
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return rect.height ? { x: rect.x + 80, y: rect.y + rect.height / 2 } : null;
    }`);
    assert(position, "Watch expression was not rendered");
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "right", clickCount: 1, ...position });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "right", clickCount: 1, ...position });
    const menuPosition = await observe(`() => {
        const item = [...document.querySelectorAll('.monaco-menu .action-label')]
            .find(node => /Break (?:on Value Change|When Value Changes)/.test(node.textContent));
        if (!item || item.closest('.action-item')?.classList.contains('disabled')) return null;
        const rect = item.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }`);
    assert(menuPosition, "Variable context menu did not offer a write data breakpoint");
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...menuPosition });
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...menuPosition });
    await command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...menuPosition
    });
    await command("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13
    });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

async function run() {
    const profile = JSON.parse(process.env.EMBERPROBE_DATA_BP_PROFILE || "null");
    assert(profile && process.env.EMBERPROBE_HIL_CONFIRM === "YES", "Explicit board authorization required");
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    const call = (method, params = {}) => provider._agentService.call(method, params);
    const directory = path.join(extension.extensionPath, "test-results");
    fs.mkdirSync(directory, { recursive: true });
    const reportFile = path.join(directory, "data-breakpoints-board.json");
    const elf = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, profile.elfRelative);
    const bytes = fs.readFileSync(elf);
    const report = {
        startedAt: new Date().toISOString(),
        platform: process.platform,
        profile,
        elfSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        steps: [],
        output: [],
        effects: { flashed: false, reset: false, variablesWritten: false }
    };
    const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    const step = async (name, action) => {
        const entry = { name, startedAt: new Date().toISOString() };
        report.steps.push(entry);
        const started = Date.now();
        try {
            entry.result = await action();
            entry.ok = true;
            console.log(`ok ${name} (${Date.now() - started} ms)`);
            return entry.result;
        } catch (error) {
            entry.ok = false;
            entry.error = error.message;
            entry.debugStatus = await call("debug.status").catch((failure) => ({ error: failure.message }));
            entry.openocdLog = provider.debugLaunch.managedServer?.runtime?.server?.logTail?.slice(-120);
            throw error;
        } finally {
            entry.ms = Date.now() - started;
            save();
        }
    };
    let session;
    let stopped = false;
    let stopCount = 0;
    let dataResponseCount = 0;
    let lastDataBreakpoints;
    let lastStop;
    let thread;
    let originallyRunning = false;
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory("emberprobe", {
        createDebugAdapterTracker(current) {
            session = current;
            return {
                onDidSendMessage(message) {
                    if (message.event === "stopped") {
                        stopped = true;
                        stopCount++;
                        lastStop = message.body;
                        thread = message.body.threadId;
                    }
                    if (message.type === "response" && message.command === "dataBreakpointInfo") {
                        (report.infoResponses ||= []).push(message);
                    }
                    if (message.type === "response" && message.command === "setDataBreakpoints") {
                        dataResponseCount++;
                        lastDataBreakpoints = message.body?.breakpoints;
                    }
                    if (message.event === "continued") stopped = false;
                    if (message.event === "output") report.output.push(message.body.output);
                }
            };
        }
    });
    const request = (command, args = {}) => session.customRequest(command, args);
    const continueToHit = async (id) => {
        const before = stopCount;
        await request("continue", { threadId: thread });
        await waitFor(() => stopCount > before, "No data breakpoint hit within 15 s", 15000);
        assert.strictEqual(lastStop.reason, "data breakpoint", JSON.stringify(lastStop));
        assert(lastStop.hitBreakpointIds?.includes(id), JSON.stringify(lastStop));
        return { ...lastStop };
    };
    const clear = () => request("setDataBreakpoints", { breakpoints: [] });
    try {
        await step("configure", async () => {
            const config = vscode.workspace.getConfiguration("emberprobe");
            await config.update("openocdPath", profile.openocd, vscode.ConfigurationTarget.Workspace);
            await config.update("armToolchainPath", path.dirname(profile.gdb), vscode.ConfigurationTarget.Workspace);
            await call("config.set", {
                values: {
                    elf: profile.elfRelative,
                    debugger: profile.probe,
                    mcu: profile.target,
                    transport: "swd",
                    adapterSpeedKhz: profile.adapterSpeedKhz || 4000,
                    rtos: ""
                }
            });
            await provider._connectedProbes
                .selection()
                .set({ probe: profile.probe, probeSerial: profile.probeSerial, source: "user" });
        });
        const probes = await step("probe.list", () => call("probe.list"));
        report.probes = probes;
        const chip = await step("chip.read", () => call("chip.read", { sections: ["identity", "runtime"] }));
        report.chip = chip;
        originallyRunning = chip.targetState === "running";
        await step("attach.no-reset", async () => {
            assert(
                await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
                    type: "emberprobe",
                    request: "attach",
                    name: "EmberProbe hardware data breakpoint acceptance",
                    executable: elf,
                    gdbPath: profile.gdb,
                    rtos: "",
                    prettyPrintingMode: "builtin"
                })
            );
            await waitFor(() => session && stopped, "Attach did not pause the board", 30000);
            assert(thread, "Attach did not identify the stopped thread");
            return call("debug.status");
        });
        await step("firmware.read-only-match", () => verifyFlash(session, bytes, directory));
        // Exercise the UI before rapid custom DAP cycles can leave its selected frame behind.
        if (profile.cdpPort)
            await step("ui.context-menu.write", async () => {
                await vscode.commands.executeCommand("workbench.view.debug");
                await vscode.commands.executeCommand("debug.addToWatchExpressions", {
                    variable: { evaluateName: profile.checks[0].expression }
                });
                const before = dataResponseCount;
                report.screenshot = await screenshot(profile.cdpPort, directory, async (command) => {
                    await chooseDataBreakpoint(command, profile.checks[0].expression);
                    await waitFor(() => dataResponseCount > before, "UI did not set a data breakpoint", 10000);
                    const bp = lastDataBreakpoints?.find((item) => item.verified);
                    assert(bp, JSON.stringify(lastDataBreakpoints));
                    const stopsBefore = stopCount;
                    await vscode.commands.executeCommand("workbench.action.debug.continue");
                    await waitFor(() => stopCount > stopsBefore, "UI breakpoint did not hit", 15000);
                    assert.strictEqual(lastStop.reason, "data breakpoint");
                    assert(lastStop.hitBreakpointIds?.includes(bp.id), JSON.stringify(lastStop));
                    report.uiHit = lastStop;
                    const ready = await command("Runtime.evaluate", {
                        expression: `new Promise(resolve => {
                            const observer = new MutationObserver(check);
                            const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, 8000);
                            function check() {
                                if (!document.body.innerText.includes('Data breakpoint:')) return;
                                observer.disconnect(); clearTimeout(timer);
                                requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
                            }
                            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
                            check();
                        })`,
                        awaitPromise: true,
                        returnByValue: true
                    });
                    assert(ready.result.value, "Workbench did not render the data breakpoint stop");
                });
                await clear();
                return report.uiHit;
            });
        for (const check of profile.checks) {
            for (const accessType of check.accessTypes) {
                await step(`watch.${check.expression}.${accessType}`, async () => {
                    let args = { name: check.expression };
                    if (check.member !== undefined) {
                        const value = await request("evaluate", { expression: check.expression });
                        const children = await request("variables", { variablesReference: value.variablesReference });
                        const child = Number.isInteger(check.member)
                            ? children.variables[check.member]
                            : children.variables.find((child) => child.name === check.member);
                        assert(child, JSON.stringify(children));
                        args = { name: child.name, variablesReference: value.variablesReference };
                    }
                    const info = await request("dataBreakpointInfo", args);
                    assert(info.dataId, info.description);
                    const result = await request("setDataBreakpoints", {
                        breakpoints: [{ dataId: info.dataId, accessType }]
                    });
                    const bp = result.breakpoints[0];
                    assert(bp.verified, bp.message);
                    report.lastWatch = {
                        expression: check.expression,
                        accessType,
                        info,
                        breakpoint: bp,
                        valueBefore: await request("evaluate", { expression: check.expression })
                    };
                    save();
                    const hits = [];
                    for (let i = 0; i < (check.rounds || 2); i++) hits.push(await continueToHit(bp.id));
                    const stack = await request("stackTrace", { threadId: thread, levels: 5 });
                    assert(stack.stackFrames.length > 0);
                    if (!report.screenshot && profile.cdpPort) {
                        await vscode.commands.executeCommand("workbench.view.debug");
                        await vscode.commands.executeCommand("debug.addToWatchExpressions", {
                            variable: { evaluateName: check.expression }
                        });
                        report.screenshot = await screenshot(profile.cdpPort, directory);
                    }
                    await clear();
                    return { info, breakpoint: bp, hits, stack: stack.stackFrames };
                });
            }
        }
        await step("disable.reenable.condition", async () => {
            const info = await request("dataBreakpointInfo", { name: profile.checks[0].expression });
            const spec = { dataId: info.dataId, accessType: "write", condition: `${profile.checks[0].expression} > 0` };
            const first = await request("setDataBreakpoints", { breakpoints: [spec] });
            assert(first.breakpoints[0].verified, first.breakpoints[0].message);
            await clear();
            const before = stopCount;
            await request("continue", { threadId: thread });
            const running = await call("debug.status");
            assert(running.state === "running" || running.running, JSON.stringify(running));
            await request("pause");
            await waitFor(() => stopCount > before, "Pause did not complete", 10000);
            const second = await request("setDataBreakpoints", { breakpoints: [spec] });
            assert(second.breakpoints[0].verified, second.breakpoints[0].message);
            const hit = await continueToHit(second.breakpoints[0].id);
            await clear();
            return { running, hit };
        });
        await step("unavailable.aggregate", async () => {
            const info = await request("dataBreakpointInfo", { name: profile.aggregate });
            assert.strictEqual(info.dataId, null);
            return info;
        });
        report.passed = true;
    } catch (error) {
        report.passed = false;
        report.error = error.message;
        throw error;
    } finally {
        await step("cleanup", async () => {
            if (!session) return { attached: false };
            try {
                const status = await call("debug.status");
                if (status.state === "running" || status.running) {
                    await request("pause");
                    await waitFor(() => stopped, "Cleanup could not pause target", 10000);
                }
                if (report.error && stopped) {
                    try {
                        report.failureSnapshot = {
                            stack: await request("stackTrace", { threadId: thread, levels: 8 }),
                            dwt: await request("readMemory", { memoryReference: "0xe0001000", count: 96 }),
                            ...(report.lastWatch
                                ? { valueAfter: await request("evaluate", { expression: report.lastWatch.expression }) }
                                : {})
                        };
                    } catch (error) {
                        report.failureSnapshot = { error: error.message };
                    }
                }
                await clear();
                if (originallyRunning && stopped) await request("continue", { threadId: thread });
            } finally {
                await vscode.debug.stopDebugging(session);
                report.cleanupStatus = await call("debug.status");
            }
            return { originallyRunning, debug: report.cleanupStatus };
        })
            .catch((error) => {
                report.passed = false;
                report.cleanupError = error.message;
                if (!report.error) throw error;
            })
            .finally(() => {
                tracker.dispose();
                report.finishedAt = new Date().toISOString();
                save();
            });
    }
    console.log("✓ Real-board data breakpoints passed; no firmware download, reset or variable write");
}

module.exports = { run };
