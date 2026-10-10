"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const vscode = require("vscode");

async function verifyTargetDetection(extension, folder) {
    const { detectWorkspace } = require(path.join(extension.extensionPath, "src/autoDetect"));
    const root = fs.mkdtempSync(path.join(folder.uri.fsPath, "probe-rs-targets-"));
    const cargo = path.join(root, ".cargo", "config.toml");
    const launch = path.join(root, ".vscode", "launch.json");
    const ioc = path.join(root, "board.ioc");
    const targets = [
        { label: "nRF52840_xxAA", description: "nRF52 Series" },
        { label: "STM32F407ZG", description: "STM32F4 Series" },
        { label: "STM32H723VG", description: "STM32H7 Series" }
    ];
    try {
        fs.mkdirSync(path.dirname(cargo));
        fs.mkdirSync(path.dirname(launch));
        fs.writeFileSync(cargo, '[target.thumbv7em-none-eabihf]\nrunner = "probe-rs run --chip nRF52840_xxAA"\n');
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, "nRF52840_xxAA");
        fs.unlinkSync(cargo);
        fs.writeFileSync(launch, JSON.stringify({ configurations: [{ chip: "STM32F407ZG" }] }));
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, "STM32F407ZG");
        fs.writeFileSync(ioc, "Mcu.CPN=STM32H723VGT6\nMcu.Name=STM32H723VGTx\n");
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets)).mcu, "");
        assert.equal((await detectWorkspace(vscode, "probe-rs", targets, ioc)).mcu, "STM32H723VG");
        console.log("✓ probe-rs MCU detection: Cargo and launch globs, ambiguous hints and selected ioc priority");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function verifyBreakpoints(provider, session, folder, waitFor, sourceFile) {
    const directory = sourceFile ? null : fs.mkdtempSync(path.join(folder.uri.fsPath, "probe-rs-breakpoints-"));
    const source = sourceFile || path.join(directory, "main.rs");
    if (!sourceFile) fs.writeFileSync(source, "fn main() {\n    let mut counter = 3;\n    counter += 1;\n}\n");
    const sourceBreakpoints = () =>
        vscode.debug.breakpoints.filter((breakpoint) => breakpoint.location?.uri.fsPath === source);
    const update = (params) =>
        provider._handleAgentCall("debug.breakpoints.update", { type: "source", file: source, line: 2, ...params });
    try {
        const document = await vscode.workspace.openTextDocument(source);
        assert.equal(document.languageId, sourceFile ? "cpp" : "rust");
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        // The Extension Host has no other debug extensions. This exercises the
        // source editor's language registration, not only addBreakpoints().
        await vscode.commands.executeCommand("editor.debug.action.toggleBreakpoint");
        await waitFor(() => sourceBreakpoints().length === 1);
        const breakpoint = sourceBreakpoints()[0];
        await waitFor(async () => (await session.getDebugProtocolBreakpoint(breakpoint))?.verified === true);
        await waitFor(() => provider._debugBridge.paused && provider._debugBridge.stopReason === "breakpoint");
        const threadId = provider._debugBridge.threadId;
        const stack = await session.customRequest("stackTrace", { threadId });
        const frame = stack.stackFrames[0];
        assert.equal(frame.source.path, source);
        assert.equal(frame.line, 2);
        const scopes = await session.customRequest("scopes", { frameId: frame.id });
        const localsReference = scopes.scopes.find((scope) => scope.name === "Locals").variablesReference;
        const locals = await session.customRequest("variables", { variablesReference: localsReference });
        assert.equal(locals.variables.find((variable) => variable.name === "counter").value, "3");
        for (const unsupported of [
            { type: "function", function: "main" },
            { condition: "counter > 1" },
            { hitCondition: "2" },
            { logMessage: "counter={counter}" }
        ]) {
            await assert.rejects(update({ action: "add", ...unsupported }), { code: "BREAKPOINT_UNSUPPORTED" });
            assert.equal(sourceBreakpoints().length, 1, "rejected requests preserve the editor's breakpoint");
        }
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        await vscode.commands.executeCommand("editor.debug.action.toggleBreakpoint");
        await waitFor(() => sourceBreakpoints().length === 0);
        const instructions = await session.customRequest("setInstructionBreakpoints", {
            breakpoints: [{ instructionReference: "0x08000104" }]
        });
        assert.equal(instructions.breakpoints[0].verified, true);
        await session.customRequest("setInstructionBreakpoints", { breakpoints: [] });
        const stepped = await provider._handleAgentCall("debug.control", { action: "stepOver" });
        assert.equal(stepped.status.reason, "step");
        const stepStack = await session.customRequest("stackTrace", { threadId });
        assert.equal(stepStack.stackFrames[0].line, 3);
        await assert.rejects(session.customRequest("variables", { variablesReference: localsReference }));
        const continued = await provider._handleAgentCall("debug.control", { action: "continue" });
        assert.equal(continued.status.state, "running");
        console.log(
            "✓ probe-rs source F9, verified hit, stack/locals, instruction breakpoints, step and capability guards"
        );
    } finally {
        vscode.debug.removeBreakpoints(sourceBreakpoints());
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function verifySliderWrites(extension, provider, item, waitFor) {
    const { render } = require(path.join(extension.extensionPath, "test/helpers/render-webview"));
    const view = render(provider.getModernWebviewContent());
    // Exercise the production webview message handler with the already-connected
    // Extension Host provider and DAP process. Avoid replacing the real view's listener.
    const host = Object.create(provider);
    host._messageListener = null;
    host._renderWebview = async () => {};
    host.updateView = async () => {};
    const pending = [];
    const errors = [];
    const replies = [];
    let receive;
    let heldReply;
    let dragged = false;
    let slider;
    host.resolveWebviewView({
        webview: {
            onDidReceiveMessage(handler) {
                receive = handler;
                return { dispose() {} };
            },
            postMessage(message) {
                if (message.type === "writeResult") {
                    replies.push(message);
                    if (replies.length === 1) {
                        heldReply = message;
                        return Promise.resolve(true);
                    }
                }
                view.send(message);
                if (message.type === "liveStatus" && message.writeBlockedReason === "writing" && !dragged) {
                    assert.equal(slider.disabled, false, "a real DAP sidebar write keeps the slider editable");
                    dragged = true;
                    for (let value = 56; value <= 73; value++) {
                        slider.value = String(value);
                        slider.dispatchEvent(new view.window.Event("input"));
                    }
                    slider.dispatchEvent(new view.window.Event("change"));
                }
                return Promise.resolve(true);
            }
        },
        onDidDispose() {}
    });
    view.messages.push = (message) => {
        const length = Array.prototype.push.call(view.messages, message);
        if (["writeVariable", "saveSidebarWrite"].includes(message.type))
            pending.push(Promise.resolve(receive(message)).catch((error) => errors.push(error)));
        return length;
    };
    try {
        view.send({ type: "sidebarWriteList", items: [{ ...item, type: "u32", min: 0, max: 100, value: 44 }] });
        view.send({ type: "liveStatus", ...provider._samplingStatus() });
        slider = view.document.querySelector(".write-slider");
        slider.value = "55";
        slider.dispatchEvent(new view.window.Event("input"));
        await waitFor(() => heldReply);
        assert.equal(dragged, true);
        assert.equal(heldReply.ok, true);
        assert.equal(slider.value, "73", "holding a verified old reply must preserve the newest drag value");
        assert.equal(view.messages.filter((message) => message.type === "writeVariable").length, 1);
        assert.equal(view.document.getElementById("writeFeedback").textContent, "");
        view.send(heldReply);
        await waitFor(() => replies.length === 2 && !view.document.querySelector(".write-input.pending"));
        assert.equal(replies[1].ok, true);
        assert.equal(replies[1].value, 73);
        assert.deepEqual(
            view.messages.filter((message) => message.type === "writeVariable").map((message) => message.value),
            [55, 73],
            "dense input events coalesce into one verified final write through the real host handler"
        );
        const result = await provider._debugBridge.activeSession.customRequest("readMemory", {
            memoryReference: `0x${item.address.toString(16)}`,
            count: 4
        });
        assert.equal(Buffer.from(result.data, "base64").readUInt32LE(0), 73);
        assert.equal(view.document.getElementById("writeFeedback").textContent, "");
        assert.deepEqual(errors, []);
        view.assertHealthy();
        console.log("✓ probe-rs slider: production UI messages, quiet busy input, newest final value and DAP readback");
    } finally {
        await Promise.all(pending);
        host._messageListener.dispose();
        view.close();
    }
}

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    const provider = extension.exports.debugTestProvider;
    const folder = vscode.workspace.workspaceFolders[0];
    await verifyTargetDetection(extension, folder);
    const settings = vscode.workspace.getConfiguration("emberprobe");
    const keys = ["backend", "probeRsPath", "probeRsChip"];
    const previous = keys.map((key) => settings.inspect(key).globalValue);
    const previousElf = provider._context.workspaceState.get("mcu.elfPath");
    const previousList = provider._context.workspaceState.get("mcu.sidebarWatchList");
    const previousWrites = provider._context.workspaceState.get("mcu.sidebarWriteList");
    const previousCheck = provider._probeRsStatusService.check;
    // Node hosts the DAP fixture; emulate only its probe-rs version response.
    provider._probeRsStatusService.check = async (executable) =>
        executable === process.env.EMBERPROBE_E2E_NODE_PATH
            ? { state: "ready", key: "pr.ready", path: executable, params: { version: "0.32.0" } }
            : previousCheck(executable);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-probe-rs-e2e-"));
    const cppDirectory = fs.mkdtempSync(path.join(folder.uri.fsPath, "probe-rs-cpp-"));
    const elf = path.join(extension.extensionPath, "test/fixtures/rust-globals.elf");
    const fixture = path.join(extension.extensionPath, "test/fixtures/fake-probe-rs-adapter.js");
    // The real owned process receives the normal "dap-server" argument. Node
    // interprets this file in cwd, so the production factory needs no test hook.
    fs.writeFileSync(path.join(temp, "dap-server"), `require(${JSON.stringify(fixture)});\n`);
    const waitFor = async (predicate) => {
        const deadline = Date.now() + 15000;
        while (!(await predicate())) {
            assert.ok(Date.now() < deadline, "probe-rs Extension Host event timed out");
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    let session;
    let chipStatus;
    const postChipInfo = provider._postChipInfo;
    provider._postChipInfo = function (status, info) {
        chipStatus = status;
        return postChipInfo.call(this, status, info);
    };
    try {
        await settings.update("backend", "probe-rs", vscode.ConfigurationTarget.Global);
        await settings.update("probeRsPath", process.env.EMBERPROBE_E2E_NODE_PATH, vscode.ConfigurationTarget.Global);
        await settings.update("probeRsChip", "", vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider._refreshElfBindings();
        const parsed = await provider._elfService.ready();
        const gain = parsed.symbols.find((symbol) => symbol.displayName === "rust_globals::GAIN");
        assert.ok(gain);
        await provider._saveWatchList("mcu.sidebarWatchList", [{ ...gain, type: "u32", size: 4 }]);
        const config = {
            name: "probe-rs process ownership E2E",
            type: "emberprobe-probe-rs",
            request: "attach",
            cwd: temp,
            chip: "STM32F407ZG",
            executable: elf,
            __fixtureReadDelayMs: 25
        };
        const download = provider._probeCoordinator.acquire("download");
        try {
            await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_BUSY" });
        } finally {
            download.release();
        }
        assert.equal(await vscode.debug.startDebugging(folder, config), true);
        await waitFor(() => provider._debugBridge.runtimeProbeRs);
        session = provider._debugBridge.activeSession;
        assert.equal(provider._probeCoordinator.isActive("debugServer"), true);
        assert.equal(provider._probeRsAdapters.size, 1);
        const chip = await provider.readChipInfoAction(true);
        assert.equal(chip.core, "Cortex-M4");
        assert.equal(chip.chip, config.chip);
        assert.equal(chip.deviceId, "0x413");
        assert.equal(chip.flashSize, "1024 KiB");
        assert.equal(chip.uid, "0x001D00413134510438373332");
        assert.equal(chip.designer, "STMicroelectronics");
        assert.equal(chip.controlsAvailable, true);
        const fullChipCache = provider._chipInfoService.info;
        assert.deepEqual(await provider._handleAgentCall("chip.read", { sections: [], fields: ["core"] }), {
            core: "Cortex-M4"
        });
        assert.strictEqual(provider._chipInfoService.info, fullChipCache);
        const halted = await provider.controlChipInfoAction("pause");
        assert.equal(halted.targetState, "halted");
        assert.equal(halted.pc, "0x08000100");
        assert.equal(halted.sp, "0x20001000");
        assert.equal(halted.lr, "0xFFFFFFF9");
        const continued = await provider.controlChipInfoAction("continue");
        assert.ok(continued, JSON.stringify(chipStatus));
        assert.equal(continued.targetState, "running");
        const reset = await provider.controlChipInfoAction("reset");
        assert.ok(reset, JSON.stringify(chipStatus));
        assert.equal(reset.targetState, "running");
        assert.equal(provider._probeCoordinator.isActive("debugServer"), true);
        await verifyBreakpoints(provider, session, folder, waitFor);
        await provider.startLiveWatch(undefined, 50, "sidebar", false);
        await waitFor(() => provider._debugBridge.sampleTimes.length >= 40);
        const samplingStats = provider._debugBridge.stats();
        assert.equal(samplingStats.effectiveIntervalMs, 50);
        assert.ok(
            samplingStats.actualHz >= 17,
            `20 Hz sampling with 25 ms DAP latency must include reads in the period: ${JSON.stringify(samplingStats)}`
        );
        console.log(`✓ probe-rs 20 Hz sampling with 25 ms DAP latency: ${samplingStats.actualHz.toFixed(1)} Hz`);
        await provider.startLiveWatch(undefined, 100, "sidebar", false);
        await waitFor(() => provider._debugBridge.canWrite);
        const written = await provider._writeUiVariable(gain.name, 123);
        assert.equal(written.results[0].verified, true);
        await assert.rejects(
            provider._withAgentProbe(({ session: bridge }) =>
                bridge.readOnce([{ name: "MMIO", address: 0x40000000, size: 4 }])
            ),
            { code: "LIVE_ADDRESS_NOT_RAM" }
        );
        await provider._context.workspaceState.update("mcu.elfPath", __filename);
        await assert.rejects(provider._writeUiVariable(gain.name, 1), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider.stopLiveWatch();
        await vscode.debug.stopDebugging(session);
        await waitFor(() => !provider._probeRsAdapters.size && !provider._debugBridge.hasAnySession);
        assert.equal(provider._probeCoordinator.anyActive(), false);
        await settings.update("probeRsChip", config.chip, vscode.ConfigurationTarget.Global);
        const cppSource = path.join(cppDirectory, "app_main.cpp");
        const cppElf = path.join(cppDirectory, "firmware.elf");
        const { buildSourceElf } = require(path.join(extension.extensionPath, "test/helpers/probe-rs-source-fixture"));
        fs.writeFileSync(cppSource, "int main() {\n    unsigned int counter = 3;\n    counter++;\n}\n");
        fs.writeFileSync(cppElf, buildSourceElf(cppSource));
        await provider._context.workspaceState.update("mcu.elfPath", cppElf);
        await provider._refreshElfBindings();
        const cppSymbols = (await provider._elfService.ready()).symbols;
        const gainCpp = cppSymbols.find((symbol) => symbol.name === "GAIN");
        const tuneCpp = cppSymbols.find((symbol) => symbol.name === "TUNE");
        await provider._saveWatchList("mcu.sidebarWatchList", [{ ...gainCpp, type: "u32", size: 4 }]);
        await provider.startLiveWatch(undefined, 100, "sidebar");
        await waitFor(() => provider._debugBridge.runtimeProbeRs);
        assert.equal(provider._debugBridge.activeSession.configuration.__emberprobeWatchOnly, true);
        session = provider._debugBridge.activeSession;
        await waitFor(() => provider._debugBridge.canWrite);
        await provider._saveWatchList("mcu.sidebarWriteList", [{ ...tuneCpp, type: "u32", size: 4, value: 44 }], {
            syncSidebar: false
        });
        assert.equal(
            provider._debugBridge.canWrite,
            false,
            "adding a new write-only variable refreshes the sampling snapshot"
        );
        assert.equal((await provider._writeUiVariable(tuneCpp.name, 44)).results[0].verified, true);
        await verifySliderWrites(extension, provider, tuneCpp, waitFor);
        await verifyBreakpoints(provider, session, folder, waitFor, cppSource);
        console.log(
            "✓ probe-rs automatic sampling: GCC C++ source fallback and immediate write after adding a write-only variable"
        );
        await provider.stopLiveWatch();
        await waitFor(() => !provider._probeRsAdapters.size && !provider._debugBridge.hasAnySession);
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider._refreshElfBindings();
        await provider._saveWatchList("mcu.sidebarWatchList", [{ ...gain, type: "u32", size: 4 }]);
        await provider.startLiveWatch(undefined, 100, "sidebar");
        await waitFor(() => provider._debugBridge.runtimeProbeRs);
        assert.equal(await provider._startProbeRsDebug("attach", folder.uri, false, config), true);
        await waitFor(
            () =>
                provider._debugBridge.runtimeProbeRs &&
                !provider._debugBridge.activeSession.configuration.__emberprobeWatchOnly
        );
        session = provider._debugBridge.activeSession;
        await provider.stopLiveWatch();
        await vscode.debug.stopDebugging(session);
        await waitFor(() => !provider._probeRsAdapters.size && !provider._debugBridge.hasAnySession);
        assert.equal(provider._probeCoordinator.anyActive(), false);
        console.log(
            "✓ native probe-rs F5: owned process, launch chip, runtime RAM guards, ELF rejection and lease release"
        );
    } finally {
        provider._postChipInfo = postChipInfo;
        provider._probeRsStatusService.check = previousCheck;
        await provider.stopLiveWatch();
        if (session) await vscode.debug.stopDebugging(session);
        for (let i = 0; i < keys.length; i++)
            await settings.update(keys[i], previous[i], vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", previousElf);
        await provider._context.workspaceState.update("mcu.sidebarWatchList", previousList);
        await provider._context.workspaceState.update("mcu.sidebarWriteList", previousWrites);
        await provider._refreshElfBindings();
        fs.rmSync(temp, { recursive: true, force: true });
        fs.rmSync(cppDirectory, { recursive: true, force: true });
    }
}

module.exports = { run };
