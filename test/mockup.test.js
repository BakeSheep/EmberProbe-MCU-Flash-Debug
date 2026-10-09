"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const vm = require("vm");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const csvTools = require("../src/liveWatchView");
const sidebarData = require("../mockup/mock/sidebar-data");
const liveData = require("../mockup/mock/livewatch-data");
const operationOutput = require("../mockup/mock/operation-output");
const { createMockServer } = require("../mockup/serve");
const mockup = path.resolve(__dirname, "../mockup");

function hostEnvironment() {
    const listeners = new Set();
    const jobs = new Map();
    const downloads = [];
    let now = 1700000000000;
    let nextId = 0;
    const root = {
        EmberProbeSidebarData: sidebarData,
        EmberProbeLiveWatchData: liveData,
        EmberProbeMockOutput: operationOutput,
        EmberProbeMockCsv: csvTools,
        addEventListener: (_type, handler) => listeners.add(handler),
        removeEventListener: (_type, handler) => listeners.delete(handler)
    };
    function schedule(fn, delay = 0, repeat = false) {
        const id = ++nextId;
        jobs.set(id, { fn, at: now + delay, delay, repeat });
        return id;
    }
    const context = vm.createContext({
        window: root,
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        setTimeout: (fn, delay) => schedule(fn, delay),
        clearTimeout: (id) => jobs.delete(id),
        setInterval: (fn, delay) => schedule(fn, delay, true),
        clearInterval: (id) => jobs.delete(id),
        Blob: class {
            constructor(parts) {
                this.text = parts.join("");
            }
        },
        URL: {
            createObjectURL: (blob) => {
                downloads.push(blob.text);
                return "blob:mock-download";
            },
            revokeObjectURL() {}
        },
        document: {
            createElement: () => ({ click() {}, remove() {} }),
            body: { appendChild() {} }
        }
    });
    for (const file of ["coordinator.js", "sidebar-host.js", "livewatch-host.js"])
        vm.runInContext(fs.readFileSync(path.join(mockup, "mock", file), "utf8"), context, { filename: file });
    function frame(onSend) {
        const messages = [];
        return {
            messages,
            contentWindow: {
                postMessage(message) {
                    const copy = JSON.parse(JSON.stringify(message));
                    messages.push(copy);
                    if (onSend) onSend(copy);
                }
            }
        };
    }
    function deliver(target, message, source = target.contentWindow) {
        for (const listener of listeners) listener({ source, data: { __emberprobeMock: true, message } });
    }
    function advance(ms) {
        const end = now + ms;
        let runs = 0;
        while (true) {
            const pending = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at);
            if (!pending.length) break;
            assert.ok(++runs < 10000, "mock timer loop must be bounded");
            const [id, job] = pending[0];
            now = job.at;
            if (!job.repeat) jobs.delete(id);
            else job.at += job.delay;
            job.fn();
        }
        now = end;
    }
    return { root, frame, deliver, advance, downloads, jobs, time: () => now };
}

function latest(frame, type) {
    return frame.messages.findLast((message) => message.type === type);
}

function testOperationLifecycle() {
    const env = hostEnvironment();
    const simulator = sidebarData.createSimulator();
    const coordinator = env.root.EmberProbeMockCoordinator.create({ simulator });
    const sidebar = env.frame();
    const live = env.frame();
    const host = env.root.EmberProbeSidebarHost.create(sidebar, { simulator, coordinator });
    const chart = env.root.EmberProbeLiveWatchHost.create(live, { simulator, coordinator });
    const execute = (cmd) => env.deliver(sidebar, { type: "executeCommand", cmd });
    try {
        env.deliver(sidebar, { type: "initCheck" });
        env.deliver(live, { type: "ready" });
        assert.equal(latest(sidebar, "liveStatus").canWrite, false, "idle is not a writable DAP snapshot");
        assert.equal(latest(sidebar, "rtosDebugStatus").state, "none", "idle has no invented debug session");
        env.deliver(sidebar, { type: "liveToggle" });
        env.deliver(live, { type: "start", items: liveData.watchList(), frequencyHz: 30 });
        assert.equal(latest(sidebar, "liveStatus").source, "openocd");
        execute("mcu-vscode.download");
        assert.equal(latest(sidebar, "liveStatus").canRead, false);
        assert.equal(latest(live, "liveStatus").canRead, false, "flash suspends both consumers");
        execute("mcu-vscode.download");
        execute("mcu-vscode.debug");
        assert.equal(host.isDebugStarting(), false, "debug cannot start during flash");
        env.advance(4900);
        assert.equal(
            sidebar.messages.filter((m) => m.type === "commandSuccess" && m.cmd === "mcu-vscode.download").length,
            1
        );
        assert.equal(latest(sidebar, "liveStatus").canWrite, true);
        assert.equal(latest(live, "liveStatus").canRead, true, "flash restores requested sampling");
        execute("mcu-vscode.debug");
        env.advance(2200);
        assert.equal(latest(sidebar, "rtosDebugStatus").state, "paused");
        assert.equal(latest(live, "liveStatus").source, "dap");
        const frozen = latest(sidebar, "liveSample").samples.map(({ name, value }) => ({ name, value }));
        env.advance(300);
        assert.deepStrictEqual(
            latest(sidebar, "liveSample").samples.map(({ name, value }) => ({ name, value })),
            frozen
        );
        const epoch = latest(sidebar, "peripheralDebugStatus").epoch;
        host.setTargetState("running", { notify: false });
        assert.equal(latest(sidebar, "liveStatus").source, "openocd");
        assert.equal(latest(sidebar, "liveStatus").canWrite, false, "running debug samples are read-only");
        assert.ok(latest(sidebar, "peripheralDebugStatus").epoch > epoch);
        env.deliver(sidebar, { type: "writeVariable", name: "g_target_rpm", value: 1900, seq: 42 });
        assert.equal(latest(sidebar, "writeResult").ok, false);
        execute("mcu-vscode.download");
        assert.equal(latest(sidebar, "commandError").cmd, "mcu-vscode.download");
        assert.equal(latest(sidebar, "commandError").key, "msg.debugBusyForDownload");
        host.stopDebug();
        assert.equal(latest(sidebar, "rtosDebugStatus").state, "none");
        assert.equal(latest(sidebar, "liveStatus").canWrite, true, "stopping debug restores standalone sampling");
        env.deliver(sidebar, { type: "liveToggle" });
        env.deliver(live, { type: "stop" });
        env.deliver(sidebar, { type: "writeVariable", name: "g_target_rpm", value: 1900, seq: 43 });
        assert.equal(latest(sidebar, "writeResult").ok, false, "stopped consumers cannot write");
    } finally {
        host.destroy();
        chart.destroy();
    }
}

function testSvdCancellation() {
    const env = hostEnvironment();
    const frame = env.frame();
    const host = env.root.EmberProbeSidebarHost.create(frame);
    const command = { type: "executeCommand", cmd: "mcu-vscode.downloadOfficialSvd" };
    try {
        env.deliver(frame, command);
        env.advance(400);
        env.deliver(frame, { type: "cancelSvdDownload" });
        const cancelled = frame.messages.length;
        env.advance(3000);
        assert.equal(frame.messages.length, cancelled, "cancelled SVD callbacks cannot revive progress or success");
        env.deliver(frame, command);
        env.deliver(frame, command);
        env.advance(2500);
        assert.equal(frame.messages.filter((m) => m.type === "commandSuccess" && m.cmd === command.cmd).length, 1);
        env.deliver(frame, command);
        host.destroy();
        assert.equal(env.jobs.size, 0, "destroy clears every pending host task");
    } finally {
        host.destroy();
    }
}

function testConcurrentChipRefresh() {
    for (const mode of [
        "idle",
        "sampling",
        "flash",
        "debug-starting",
        "debug-paused",
        "debug-running",
        "cpu",
        "driver"
    ]) {
        const env = hostEnvironment();
        const simulator = sidebarData.createSimulator();
        const coordinator = env.root.EmberProbeMockCoordinator.create({ simulator });
        const frame = env.frame();
        const chartFrame = env.frame();
        const notices = [];
        const host = env.root.EmberProbeSidebarHost.create(frame, {
            simulator,
            coordinator,
            notify: (event) => notices.push(event)
        });
        const chart = env.root.EmberProbeLiveWatchHost.create(chartFrame, { simulator, coordinator });
        try {
            env.deliver(frame, { type: "initCheck" });
            env.deliver(chartFrame, { type: "ready" });
            env.advance(500);
            if (mode === "sampling") {
                host.startSampling();
                env.deliver(chartFrame, { type: "start", items: liveData.watchList(), frequencyHz: 30 });
            }
            if (mode === "flash") {
                host.download();
                env.advance(550);
            }
            if (mode.startsWith("debug")) {
                host.startDebug();
                if (mode !== "debug-starting") env.advance(2200);
                if (mode === "debug-running") host.setTargetState("running");
            }
            if (mode === "cpu") env.deliver(frame, { type: "cpuLoadStart" });
            if (mode === "driver") env.deliver(frame, { type: "selectProbeDriver", driver: "segger" });
            const before = coordinator.snapshot();
            const chipReadAt = latest(frame, "chipInfo").info.readAt;
            const chipReads = frame.messages.filter(
                (message) => message.type === "chipInfoStatus" && message.state === "ready"
            ).length;
            const samples = chartFrame.messages.filter((message) => message.type === "liveSample").length;
            assert.equal(latest(frame, "mockOperationStatus").availability.chipRead, true, mode);
            env.deliver(frame, { type: "readChipInfo" });
            env.deliver(frame, { type: "readChipInfo" });
            assert.equal(coordinator.snapshot().operation, before.operation, mode + " preserves the current owner");
            assert.equal(coordinator.snapshot().epoch, before.epoch, mode + " preserves the stop generation");
            assert.equal(
                latest(frame, "mockOperationStatus").availability.chipRead,
                false,
                "only the pending refresh is disabled"
            );
            env.advance(700);
            assert.equal(latest(frame, "chipInfoStatus").state, "ready", mode);
            assert.equal(coordinator.snapshot().operation, before.operation, mode);
            assert.equal(latest(frame, "chipInfo").info.deviceId, operationOutput.connection.deviceId);
            assert.ok(latest(frame, "chipInfo").info.readAt > chipReadAt);
            assert.equal(
                latest(frame, "chipInfo").info.targetState,
                coordinator.snapshot().target,
                "read completes with current target state"
            );
            assert.equal(latest(frame, "mockOperationStatus").availability.chipRead, true, mode);
            if (mode !== "flash")
                assert.equal(coordinator.snapshot().epoch, before.epoch, "read alone does not invalidate snapshots");
            if (mode === "sampling") {
                assert.equal(latest(frame, "liveStatus").canRead, true);
                assert.ok(chartFrame.messages.filter((message) => message.type === "liveSample").length > samples);
            }
            assert.equal(
                frame.messages.filter((message) => message.type === "chipInfoStatus" && message.state === "ready")
                    .length,
                chipReads + 1,
                mode + " repeated read clicks are deduplicated"
            );
            assert.ok(!notices.some((event) => event.panel === "output"), "chip reads do not create Output content");
        } finally {
            host.destroy();
            chart.destroy();
        }
    }
    const env = hostEnvironment();
    const frame = env.frame();
    const notices = [];
    const host = env.root.EmberProbeSidebarHost.create(frame, { notify: (event) => notices.push(event) });
    env.deliver(frame, { type: "readChipInfo" });
    host.destroy();
    const count = notices.length;
    env.advance(3000);
    assert.equal(notices.length, count, "destroyed refresh cannot publish completion later");
}

function testDriverSelection() {
    const env = hostEnvironment();
    const simulator = sidebarData.createSimulator();
    const coordinator = env.root.EmberProbeMockCoordinator.create({ simulator });
    const frame = env.frame();
    const live = env.frame();
    const notices = [];
    const host = env.root.EmberProbeSidebarHost.create(frame, {
        simulator,
        coordinator,
        notify: (event) => notices.push(event)
    });
    const chart = env.root.EmberProbeLiveWatchHost.create(live, { simulator, coordinator });
    const select = (driver) => env.deliver(frame, { type: "selectProbeDriver", driver });
    try {
        host.sendInitialState();
        env.deliver(live, { type: "ready" });
        env.advance(500);
        assert.equal(latest(frame, "probeDriverChoice").driver, "winusb");
        assert.equal(latest(frame, "probeDriverSwitch").busy, false);
        const initialEpoch = coordinator.snapshot().epoch;
        for (const invalid of [undefined, "", "SEGGER", "unknown", {}]) {
            select(invalid);
            assert.equal(latest(frame, "commandError").code, "PROBE_DRIVER_INVALID_CHOICE");
            assert.equal(latest(frame, "probeDriverChoice").driver, "winusb");
            assert.equal(env.jobs.size, 0, "invalid choices cannot schedule a driver change");
        }
        select("winusb");
        assert.equal(coordinator.snapshot().epoch, initialEpoch, "the confirmed choice is a no-op");
        assert.equal(env.jobs.size, 0);
        select("segger");
        assert.equal(coordinator.snapshot().operation, "driver");
        assert.equal(latest(frame, "probeDriverChoice").driver, "winusb", "requested is not yet confirmed");
        assert.equal(latest(frame, "probeDriverSwitch").busy, true);
        assert.equal(latest(frame, "probeDriverStatus").state, "restoring");
        assert.equal(latest(frame, "mockOperationStatus").availability.chipRead, true);
        const pendingJobs = env.jobs.size;
        select("segger");
        assert.equal(latest(frame, "commandError").code, "PROBE_BUSY");
        assert.equal(env.jobs.size, pendingJobs, "duplicate requests cannot create another driver task");
        env.advance(899);
        assert.equal(coordinator.snapshot().driver, "winusb");
        env.advance(1);
        assert.equal(coordinator.snapshot().driver, "segger");
        assert.equal(coordinator.snapshot().operation, null);
        assert.equal(latest(frame, "probeDriverChoice").driver, "segger");
        assert.equal(latest(frame, "probeDriverSwitch").busy, false);
        assert.ok(
            frame.messages.some((message) => message.type === "probeDriverStatus" && message.state === "restored")
        );
        assert.equal(latest(frame, "probeDriverStatus").state, "error");
        assert.ok(latest(frame, "probeDriverStatus").message.includes("WinUSB"));
        assert.ok(notices.some((event) => event.action === "toast" && event.icon === "warning"));
        const availability = latest(frame, "mockOperationStatus").availability;
        for (const name of ["download", "debug", "chipRead", "chipControl", "live"])
            assert.equal(availability[name], false, name + " requires WinUSB");
        assert.equal(availability.driver, true, "unsupported drivers must still allow recovery");
        assert.equal(latest(frame, "cpuLoad").canStart, false);
        assert.equal(latest(live, "mockOperationStatus").availability.live, false);
        const unsupportedEpoch = coordinator.snapshot().epoch;
        const rejected = [
            [{ type: "executeCommand", cmd: "mcu-vscode.download" }, "commandError"],
            [{ type: "executeCommand", cmd: "mcu-vscode.debug" }, "commandError"],
            [{ type: "liveToggle" }, "liveError"],
            [{ type: "readChipInfo" }, "chipInfoStatus"],
            [{ type: "chipControl", action: "reset" }, "chipInfoStatus"],
            [{ type: "cpuLoadStart" }, "commandError"]
        ];
        for (const [message, response] of rejected) {
            env.deliver(frame, message);
            assert.equal(latest(frame, response).code, "PROBE_DRIVER_UNSUPPORTED", message.type);
        }
        env.deliver(live, { type: "start", items: liveData.watchList(), frequencyHz: 30 });
        assert.equal(latest(live, "liveError").code, "PROBE_DRIVER_UNSUPPORTED");
        assert.equal(latest(live, "liveStatus").canRead, false);
        assert.equal(coordinator.snapshot().epoch, unsupportedEpoch);
        assert.equal(env.jobs.size, 0, "unsupported operations cannot create success callbacks");
        assert.ok(!notices.some((event) => event.action === "operationOutput"));
        host.sendInitialState();
        assert.equal(latest(frame, "probeDriverChoice").driver, "segger", "initialization replays confirmed state");
        assert.equal(latest(frame, "chipInfoStatus").key, "probe.driverUnsupported");
        env.advance(500);
        select("winusb");
        assert.equal(latest(frame, "probeDriverChoice").driver, "segger");
        assert.equal(latest(frame, "probeDriverStatus").state, "installing");
        assert.equal(latest(frame, "mockOperationStatus").availability.chipRead, false);
        env.advance(900);
        assert.equal(latest(frame, "probeDriverChoice").driver, "winusb");
        assert.equal(latest(frame, "probeDriverStatus").state, "ready");
        assert.equal(latest(frame, "mockOperationStatus").availability.download, true);
        assert.equal(latest(frame, "mockOperationStatus").availability.chipRead, true);
        assert.equal(latest(live, "liveStatus").running, false, "recovering a driver does not start sampling");
    } finally {
        host.destroy();
        chart.destroy();
    }
    for (const mode of ["sampling", "flash", "debug-starting", "debug-paused", "cpu"]) {
        const env = hostEnvironment();
        const simulator = sidebarData.createSimulator();
        const coordinator = env.root.EmberProbeMockCoordinator.create({ simulator });
        const frame = env.frame();
        const host = env.root.EmberProbeSidebarHost.create(frame, { simulator, coordinator });
        try {
            if (mode === "sampling") host.startSampling();
            if (mode === "flash") host.download();
            if (mode.startsWith("debug")) {
                host.startDebug();
                if (mode === "debug-paused") env.advance(2200);
            }
            if (mode === "cpu") env.deliver(frame, { type: "cpuLoadStart" });
            const before = coordinator.snapshot();
            env.deliver(frame, { type: "selectProbeDriver", driver: "segger" });
            assert.equal(latest(frame, "commandError").code, "PROBE_BUSY", mode);
            assert.deepStrictEqual(coordinator.snapshot(), before, mode + " keeps its owner and driver");
            assert.equal(latest(frame, "probeDriverChoice").driver, "winusb");
            assert.equal(latest(frame, "probeDriverSwitch").busy, false);
        } finally {
            host.destroy();
        }
    }
    const cancelled = hostEnvironment();
    const cancelledFrame = cancelled.frame();
    const cancelledHost = cancelled.root.EmberProbeSidebarHost.create(cancelledFrame);
    cancelled.deliver(cancelledFrame, { type: "selectProbeDriver", driver: "segger" });
    cancelledHost.destroy();
    const count = cancelledFrame.messages.length;
    cancelled.advance(2000);
    assert.equal(cancelledFrame.messages.length, count, "destroyed driver tasks cannot publish a confirmed choice");
}

function testDynamicOperationOutput() {
    const { parseLine } = require("../src/openocdRunner");
    for (const step of operationOutput.download.steps) assert.deepStrictEqual(step.event, parseLine(step.raw));
    const env = hostEnvironment();
    const frame = env.frame();
    const notices = [];
    const host = env.root.EmberProbeSidebarHost.create(frame, { notify: (event) => notices.push(event) });
    const terminalText = () =>
        notices
            .filter((event) => event.panel === "terminal")
            .flatMap((event) => event.lines)
            .map((line) => line.text)
            .join("\n");
    try {
        host.sendInitialState();
        assert.equal(terminalText(), "");
        host.download();
        host.download();
        assert.ok(terminalText().includes("EmberProbe 固件下载"));
        assert.ok(!terminalText().includes("开始写入固件"));
        env.advance(3600);
        assert.ok(terminalText().includes("→ ** Verify Started **"));
        assert.ok(!terminalText().includes("固件校验通过"), "verification cannot complete early");
        env.advance(1200);
        const lines = terminalText();
        const events = operationOutput.download.steps.map((step) => step.line.text);
        let previous = -1;
        for (const text of events.concat("✓ 固件下载并校验成功")) {
            const index = lines.indexOf(text);
            assert.ok(index > previous, text + " follows the real parser order");
            previous = index;
        }
        assert.ok(lines.includes("  探针 J-Link V9 compiled May  7 2021 16:26:12"));
        assert.ok(lines.includes("  目标 stm32f4x.cfg · 探针配置 jlink.cfg"));
        assert.equal(
            frame.messages.filter(
                (message) => message.type === "commandSuccess" && message.cmd === "mcu-vscode.download"
            ).length,
            1
        );
        host.download();
        env.advance(4800);
        assert.equal(
            terminalText().split("✓ 固件下载并校验成功").length - 1,
            2,
            "shared terminal retains sequential operation history"
        );
        host.download();
        env.advance(400);
        host.destroy();
        const count = notices.length;
        env.advance(5000);
        assert.equal(notices.length, count, "disposed flash cannot emit a success summary");
    } finally {
        host.destroy();
    }
}

function testCpuOwnershipAndStoppedIntent() {
    const env = hostEnvironment();
    const simulator = sidebarData.createSimulator();
    const coordinator = env.root.EmberProbeMockCoordinator.create({ simulator });
    const frame = env.frame();
    const live = env.frame();
    const host = env.root.EmberProbeSidebarHost.create(frame, { simulator, coordinator });
    const chart = env.root.EmberProbeLiveWatchHost.create(live, { simulator, coordinator });
    try {
        env.deliver(frame, { type: "initCheck" });
        env.deliver(live, { type: "ready" });
        assert.equal(latest(frame, "cpuLoad").canStart, true);
        env.deliver(frame, { type: "cpuLoadStart" });
        assert.equal(latest(frame, "cpuLoad").ownsProbe, true);
        assert.equal(latest(live, "mockOperationStatus").availability.live, false);
        env.deliver(live, { type: "start", items: liveData.watchList(), frequencyHz: 30 });
        env.deliver(frame, { type: "liveToggle" });
        host.download();
        host.startDebug();
        env.deliver(frame, { type: "readChipInfo" });
        env.deliver(frame, { type: "selectProbeDriver", driver: "winusb" });
        assert.equal(coordinator.snapshot().operation, "cpuLoad", "all hardware entry points respect CPU ownership");
        assert.equal(host.isDebugStarting(), false);
        assert.equal(latest(live, "liveStatus").running, false);
        env.advance(10300);
        const summary = latest(frame, "cpuLoad");
        assert.equal(summary.state, "running");
        assert.ok(summary.workloadPercent > 0 && summary.workloadPercent < 100);
        env.deliver(frame, { type: "cpuLoadStop" });
        assert.equal(coordinator.snapshot().operation, null);
        assert.equal(latest(frame, "cpuLoad").canStart, true);
        env.deliver(frame, { type: "liveToggle" });
        env.deliver(frame, { type: "cpuLoadStart" });
        assert.equal(latest(frame, "cpuLoad").ownsProbe, false, "CPU cannot take a sampling lease");
        env.deliver(live, { type: "start", items: liveData.watchList(), frequencyHz: 30 });
        host.download();
        const archived = latest(live, "liveSample").t;
        env.advance(500);
        assert.equal(latest(live, "liveSample").t, archived, "flash cannot append fictitious samples");
        env.deliver(frame, { type: "liveToggle" });
        env.deliver(live, { type: "stop" });
        env.deliver(live, { type: "start", items: liveData.watchList(), frequencyHz: 30 });
        assert.equal(latest(live, "liveStatus").running, false, "a new consumer cannot start during flash");
        env.advance(4400);
        assert.equal(latest(frame, "liveStatus").running, false);
        assert.equal(latest(live, "liveStatus").running, false, "explicit stop cancels automatic restoration");
        assert.equal(latest(frame, "cpuLoad").canStart, true);
        env.deliver(frame, { type: "readChipInfo" });
        env.deliver(frame, { type: "cpuLoadStart" });
        assert.equal(coordinator.snapshot().operation, "cpuLoad", "chip refresh does not take the probe lease");
        env.advance(700);
        assert.equal(latest(frame, "chipInfoStatus").state, "ready");
        env.deliver(frame, { type: "cpuLoadStop" });
        host.startDebug();
        env.deliver(frame, { type: "cpuLoadStart" });
        assert.equal(coordinator.snapshot().operation, "debugStart");
        env.advance(2200);
        env.deliver(frame, { type: "cpuLoadStart" });
        assert.equal(latest(frame, "cpuLoad").canStart, false, "paused debug still owns the probe");
    } finally {
        host.destroy();
        chart.destroy();
    }
}

function testStopGenerationAndTaskCleanup() {
    const env = hostEnvironment();
    const frame = env.frame();
    const host = env.root.EmberProbeSidebarHost.create(frame);
    const original = sidebarData.peripheralReadResult(["GPIOA.MODER"], false).registers[0].value;
    try {
        env.deliver(frame, { type: "initCheck" });
        env.deliver(frame, { type: "liveToggle" });
        host.startDebug();
        env.advance(2200);
        const epoch = latest(frame, "peripheralDebugStatus").epoch;
        env.deliver(frame, { type: "peripheralWriteRequest", target: "GPIOA.MODER", value: "0", mockEpoch: epoch });
        const reads = frame.messages.filter((m) => m.type === "peripheralReadResult").length;
        host.setTargetState("running");
        host.setTargetState("halted");
        env.advance(60);
        assert.equal(
            frame.messages.filter((m) => m.type === "peripheralReadResult").length,
            reads,
            "old write readback cannot cross stop generations"
        );
        env.deliver(frame, { type: "writeVariable", name: "g_target_rpm", value: 2500, seq: 5, mockEpoch: epoch });
        assert.equal(latest(frame, "writeResult").ok, false, "a late scalar write cannot cross stop generations");
        env.deliver(frame, { type: "rtosRefresh", mockEpoch: epoch });
        assert.equal(latest(frame, "rtosError").type, "rtosError");
    } finally {
        sidebarData.peripheralWriteResult("GPIOA.MODER", original);
        host.destroy();
    }
    for (const message of [
        { type: "executeCommand", cmd: "mcu-vscode.download" },
        { type: "executeCommand", cmd: "mcu-vscode.debug" },
        { type: "executeCommand", cmd: "mcu-vscode.downloadOfficialSvd" },
        { type: "executeCommand", cmd: "mcu-vscode.manageAgentSkills" },
        { type: "readChipInfo" },
        { type: "selectProbeDriver", driver: "segger" },
        { type: "cpuLoadStart" }
    ]) {
        const env = hostEnvironment();
        const frame = env.frame();
        const host = env.root.EmberProbeSidebarHost.create(frame);
        env.deliver(frame, message);
        assert.ok(env.jobs.size > 0);
        host.destroy();
        const count = frame.messages.length;
        assert.equal(env.jobs.size, 0, `${message.type} releases its pending callbacks`);
        host.startSampling();
        host.stopDebug();
        assert.equal(host.setTargetState("halted"), false, "detached shell callbacks cannot change the target");
        assert.equal(env.jobs.size, 0, "a destroyed host cannot restart sampling");
        env.advance(20000);
        assert.equal(frame.messages.length, count);
        host.destroy();
    }
}

function testSimulatorAndRegisters() {
    const simulator = sidebarData.createSimulator();
    assert.ok(simulator.write("g_target_rpm", 2000));
    simulator.tick();
    assert.equal(simulator.scalarSamples(["g_target_rpm"], 1)[0].value, 2000);
    for (const [name, value] of [
        ["missing", 1],
        ["g_temp_limit", 40],
        ["g_target_rpm", -1],
        ["g_target_rpm", 65536],
        ["g_target_rpm", 1.5],
        ["g_pid_kp", Infinity],
        ["g_motor_enabled", 2]
    ])
        assert.equal(simulator.write(name, value), false, `${name} must reject ${value}`);
    assert.deepStrictEqual(simulator.scalarSamples(["missing", "g_imu"], 1), []);

    const read = () => sidebarData.peripheralReadResult(["GPIOA.MODER"], false).registers[0].value;
    const original = read();
    try {
        const result = sidebarData.peripheralWriteResult("GPIOA.MODER.MODER1", "1");
        assert.equal(result.type, "peripheralWriteResult");
        assert.equal(read(), ((original & ~(3 << 2)) | (1 << 2)) >>> 0, "field writes preserve unrelated bits");
        const saved = read();
        for (const [target, value] of [
            ["GPIOA.MODER.MODER1", "4"],
            ["GPIOA.MODER", "-1"],
            ["GPIOA.MODER.missing", "1"],
            ["GPIOA.IDR", "1"],
            ["missing.REG", "1"]
        ]) {
            assert.equal(sidebarData.peripheralWriteResult(target, value).type, "peripheralError");
            assert.equal(read(), saved);
        }
        assert.equal(sidebarData.peripheralWriteResult("GPIOA.MODER", "0xffffffff").type, "peripheralWriteResult");
        assert.equal(read(), 0xffffffff, "full-width unsigned values remain intact");
    } finally {
        sidebarData.peripheralWriteResult("GPIOA.MODER", original);
    }
}

function testHostsAndRenderer() {
    const env = hostEnvironment();
    const view = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const sidebar = env.frame((message) => view.send(message));
    const simulator = sidebarData.createSimulator();
    const coordinator = env.root.EmberProbeMockCoordinator.create({ simulator });
    const notices = [];
    const host = env.root.EmberProbeSidebarHost.create(sidebar, {
        simulator,
        coordinator,
        notify: (event) => notices.push(event)
    });
    const live = env.frame();
    const liveHost = env.root.EmberProbeLiveWatchHost.create(live, {
        simulator,
        coordinator,
        getSidebarWatch: host.getWatchList
    });
    try {
        env.deliver(sidebar, { type: "initCheck" });
        assert.equal(view.document.querySelector("#writeValues .write-input").disabled, true);
        env.deliver(sidebar, { type: "liveToggle" });
        const memory = latest(sidebar, "memoryAnalysis").result;
        assert.equal(memory.ram.estimated, false);
        assert.ok(!view.document.getElementById("memoryBody").textContent.includes("估计"));
        for (let i = 0; i < 5; i++) {
            env.advance(1);
            env.deliver(sidebar, { type: "memoryRefresh" });
            assert.deepStrictEqual(latest(sidebar, "memoryAnalysis").result, memory, "the same ELF has stable totals");
        }
        const slider = view.document.querySelector("#writeValues input[type=range]");
        assert.equal(slider.min, "0");
        assert.equal(slider.max, "3000");
        assert.equal(
            view.document.querySelector("#writeValues .write-input").value,
            "1500",
            "write-only items receive initial values"
        );
        const messageIndex = view.messages.length;
        const input = view.document.querySelector("#writeValues .write-input");
        input.value = "2000";
        input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
        for (const message of view.messages.slice(messageIndex)) env.deliver(sidebar, message);
        assert.equal(latest(sidebar, "writeResult").ok, true);
        assert.equal(view.document.querySelector("#writeValues .write-input").value, "2000");
        env.deliver(sidebar, { type: "writeVariable", name: "g_target_rpm", value: -1, seq: 5 });
        assert.equal(latest(sidebar, "writeResult").ok, false);
        env.deliver(sidebar, { type: "writeVariable", name: "g_pid_ki", value: 2, seq: 6 });
        assert.equal(latest(sidebar, "writeResult").ok, false, "writes are bound to the selected write list");

        env.deliver(sidebar, {
            type: "saveSidebarWatch",
            items: [sidebarData.watchItem("g_bus_current"), sidebarData.watchItem("g_imu")]
        });
        env.deliver(live, { type: "importSidebarWatch", items: liveData.watchList() });
        assert.equal(latest(live, "watchList").items.length, 5);
        assert.equal(latest(live, "sidebarImportResult").added, 2);
        env.deliver(live, { type: "importSidebarWatch", items: latest(live, "watchList").items });
        assert.equal(latest(live, "sidebarImportResult").added, 0, "repeated imports are idempotent");
        const list = latest(live, "watchList").items.concat(sidebarData.watchItem("g_target_rpm"));
        env.deliver(live, { type: "start", items: list, frequencyHz: 30 });
        assert.equal(latest(live, "liveSample").samples.find((sample) => sample.name === "g_target_rpm").value, 2000);
        assert.ok(latest(live, "liveCompositeSample").samples.some((sample) => sample.name === "g_imu"));

        env.deliver(sidebar, { type: "liveToggle" });
        env.deliver(live, { type: "stop" });
        env.deliver(sidebar, { type: "chipControl", action: "reset" });
        assert.equal(notices.at(-1).state, "running");
        env.deliver(sidebar, { type: "readChipInfo" });
        env.advance(700);
        assert.equal(latest(sidebar, "chipInfo").info.targetState, "running");
        env.deliver(sidebar, { type: "chipControl", action: "pause" });
        host.startDebug();
        env.advance(2200);
        const epoch = latest(sidebar, "peripheralDebugStatus").epoch;
        env.deliver(sidebar, { type: "peripheralReadRequest", targets: ["GPIOA.MODER"] });
        assert.equal(latest(sidebar, "peripheralReadResult").session.epoch, epoch);
        host.setTargetState("halted", { notify: false, line: 105 });
        assert.ok(latest(sidebar, "chipInfo").info.haltReason.includes("105"));
        assert.ok(latest(sidebar, "peripheralDebugStatus").epoch > epoch);

        env.deliver(sidebar, { type: "liveToggle" });
        env.advance(100);
        assert.ok(latest(sidebar, "liveSample").samples.some((sample) => sample.name === "g_pid_kp"));
        const count = sidebar.messages.length;
        env.deliver(sidebar, { type: "liveToggle" }, {});
        assert.equal(sidebar.messages.length, count, "foreign frames cannot issue host commands");
        view.assertHealthy();
    } finally {
        host.destroy();
        liveHost.destroy();
        view.close();
    }
}

function testArchive() {
    const env = hostEnvironment();
    const frame = env.frame();
    const host = env.root.EmberProbeLiveWatchHost.create(frame, { archiveLimit: 3 });
    try {
        env.deliver(frame, { type: "samplingArchiveInfo" });
        assert.equal(latest(frame, "samplingArchiveInfo").rows, 0);
        env.deliver(frame, { type: "exportCsv", names: ["g_motor_rpm"] });
        assert.equal(latest(frame, "exportCsvResult").ok, false);
        assert.equal(env.downloads.length, 0, "no empty download is offered");
        env.deliver(frame, { type: "start", items: liveData.watchList(), frequencyHz: 10 });
        const first = env.time();
        env.advance(200);
        env.deliver(frame, { type: "exportCsv", names: ["g_motor_rpm"], fromMs: first + 100, toMs: first + 100 });
        const csv = env.downloads.at(-1);
        assert.ok(csv.startsWith("\uFEFFtime,g_motor_rpm\r\n"));
        assert.ok(csv.includes(new Date(first + 100).toISOString()));
        assert.equal(latest(frame, "exportCsvResult").rowCount, 1);
        assert.equal(latest(frame, "exportCsvResult").seriesCount, 1);
        env.advance(200);
        env.deliver(frame, { type: "samplingArchiveInfo" });
        const info = latest(frame, "samplingArchiveInfo");
        assert.equal(info.rows, 3, "archive memory is bounded");
        assert.equal(info.limitReached, true);
        assert.equal(info.firstTimestampMs, first + 200);
        env.deliver(frame, { type: "exportCsv", names: ["g_motor_rpm"], fromMs: first, toMs: first + 100 });
        assert.equal(latest(frame, "exportCsvResult").ok, false, "an empty time range does not report success");
        const localCsv = csvTools.buildCsv(["g_sensor_temp"], [[{ t: first, v: -2.5 }]]);
        env.deliver(frame, { type: "exportCsv", source: "snapshot", names: ["g_sensor_temp"], csv: localCsv });
        assert.equal(env.downloads.at(-1), localCsv, "snapshot/retained exports preserve the renderer's CSV");
        env.deliver(frame, { type: "stop" });
        env.advance(200);
        env.deliver(frame, { type: "samplingArchiveInfo" });
        assert.equal(latest(frame, "samplingArchiveInfo").lastTimestampMs, first + 400);
        env.deliver(frame, { type: "start", items: [], frequencyHz: 10 });
        env.advance(100);
        assert.deepStrictEqual(latest(frame, "liveSample").samples, [], "an empty list never restarts old series");
    } finally {
        host.destroy();
    }
}

function testReadableArchiveHeaders() {
    const env = hostEnvironment();
    const frame = env.frame();
    frame.contentWindow.EmberProbeRuntime = require("../src/webview/runtime");
    const rawName = "_ZL3pwr.data_.bus_voltage_v";
    const readable = "pwr.data_.bus_voltage_v";
    const host = env.root.EmberProbeLiveWatchHost.create(frame, {
        simulator: {
            tick() {},
            scalarSamples(names, t) {
                return names.map((name) => ({ name, value: 11.4875, t }));
            },
            compositeSample() {}
        }
    });
    try {
        env.deliver(frame, { type: "start", items: [{ name: rawName, displayName: readable }], frequencyHz: 30 });
        env.deliver(frame, { type: "samplingArchiveInfo" });
        const info = latest(frame, "samplingArchiveInfo");
        assert.deepStrictEqual(info.variables, [rawName]);
        assert.strictEqual(info.displayNames[rawName], readable);
        env.deliver(frame, { type: "exportCsv", names: [rawName] });
        assert.strictEqual(
            env.downloads.at(-1),
            `\uFEFFtime,${readable}\r\n${new Date(env.time()).toISOString()},11.4875\r\n`
        );
    } finally {
        host.destroy();
    }
}

function testDebugLatency() {
    const env = hostEnvironment();
    const notices = [];
    const frame = env.frame();
    const host = env.root.EmberProbeSidebarHost.create(frame, { notify: (event) => notices.push(event) });
    const command = { type: "executeCommand", cmd: "mcu-vscode.debug" };
    try {
        host.sendInitialState();
        env.deliver(frame, command, {});
        assert.equal(host.isDebugStarting(), false, "foreign frames cannot start debug");
        env.deliver(frame, command);
        assert.equal(host.isDebugStarting(), true);
        assert.equal(latest(frame, "mockDebugPending").busy, true);
        env.advance(600);
        assert.equal(latest(frame, "initSuccess"), undefined, "initialization must not erase the pending status");
        assert.equal(latest(frame, "openocdProgress").key, "sb.executing");
        assert.ok(frame.messages.filter((m) => m.type === "openocdProgress").every((m) => m.stage));
        env.deliver(frame, command);
        env.advance(1599);
        assert.equal(latest(frame, "commandSuccess"), undefined, "debug does not complete early");
        assert.ok(!notices.some((event) => event.action === "targetState" || event.action === "debugStart"));
        env.advance(1);
        assert.equal(latest(frame, "commandSuccess").cmd, command.cmd);
        assert.equal(latest(frame, "mockDebugPending").busy, false);
        assert.equal(
            notices.filter((event) => event.action === "debugStart").length,
            1,
            "duplicate clicks share one wait"
        );
        host.stopDebug();
        host.startDebug();
        env.advance(1000);
        assert.equal(host.cancelDebugStart(), true);
        assert.equal(host.cancelDebugStart(), false);
        env.advance(5000);
        assert.equal(
            notices.filter((event) => event.action === "debugStart").length,
            1,
            "cancel prevents late completion"
        );
        host.startDebug();
        host.destroy();
        env.advance(5000);
        assert.equal(
            notices.filter((event) => event.action === "debugStart").length,
            1,
            "detached hosts cannot complete"
        );
    } finally {
        host.destroy();
    }
}

function testDebugBusyBridge() {
    const view = render(
        '<body><div class="primary-actions"><button data-command="debug"></button><button data-command="flash" disabled></button></div></body>'
    );
    try {
        view.window.eval(fs.readFileSync(path.join(mockup, "mock/prelude.js"), "utf8"));
        const [debug, flash] = view.document.querySelectorAll("button");
        function send(source, busy) {
            view.window.dispatchEvent(
                new view.window.MessageEvent("message", {
                    source,
                    data: { type: "mockDebugPending", busy }
                })
            );
        }
        send({}, true);
        assert.equal(debug.disabled, false, "foreign frames cannot lock buttons");
        send(view.window.parent, true);
        send(view.window.parent, true);
        assert.equal(debug.disabled, true);
        assert.equal(debug.getAttribute("aria-busy"), "true");
        send(view.window.parent, false);
        assert.equal(debug.disabled, false);
        assert.equal(flash.disabled, true, "completion preserves an already disabled action");
        assert.equal(debug.hasAttribute("aria-busy"), false);
        view.assertHealthy();
    } finally {
        view.close();
    }
}

async function testOperationAvailabilityBridge() {
    const view = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    try {
        view.window.eval(fs.readFileSync(path.join(mockup, "mock/prelude.js"), "utf8"));
        function send(source, availability) {
            view.window.dispatchEvent(
                new view.window.MessageEvent("message", {
                    source,
                    data: { type: "mockOperationStatus", operation: "download", epoch: 42, availability }
                })
            );
        }
        const button = view.document.querySelector('[data-command="mcu-vscode.download"]');
        send({}, { download: false });
        assert.equal(button.disabled, false, "foreign frames cannot change operation availability");
        send(view.window.parent, { download: false, debug: false, chipRead: true, chipControl: false, live: true });
        assert.equal(button.disabled, true);
        assert.equal(
            view.document.getElementById("chipRead").disabled,
            false,
            "chip refresh stays available during flash"
        );
        assert.ok([...view.document.querySelectorAll(".chip-control")].every((control) => control.disabled));
        assert.equal(
            view.document.getElementById("liveToggle").disabled,
            false,
            "an active consumer can stop during flash"
        );
        button.disabled = false;
        view.document.getElementById("chipRead").disabled = true;
        await Promise.resolve();
        assert.equal(button.disabled, true, "renderer cooldowns cannot undo the operation lock");
        assert.equal(
            view.document.getElementById("chipRead").disabled,
            false,
            "CPU and driver renderer locks cannot disable concurrent refresh"
        );
        send(view.window.parent, { chipRead: false, chipControl: false });
        assert.equal(
            view.document.getElementById("chipRead").disabled,
            true,
            "a pending refresh disables its own button"
        );
        const messages = [];
        view.window.parent.postMessage = (message) => messages.push(message);
        view.window.acquireVsCodeApi().postMessage({ type: "writeVariable", name: "g_target_rpm", value: 2000 });
        assert.equal(messages[0].message.mockEpoch, 42, "writes are stamped with the displayed stop generation");
        const shortcut = new view.window.KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
        view.document.getElementById("liveToggle").dispatchEvent(shortcut);
        assert.equal(shortcut.defaultPrevented, true, "F5 in a webview must not refresh the browser");
        assert.equal(messages.at(-1).__emberprobeMockShortcut, true);
        assert.equal(messages.at(-1).key, "F5");
        const count = messages.length;
        view.document
            .getElementById("liveToggle")
            .dispatchEvent(
                new view.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
            );
        assert.equal(messages.length, count, "local webview editing keys stay local");
        send(view.window.parent, { download: true, debug: true, chipRead: true, chipControl: true, live: true });
        assert.equal(button.disabled, false, "completion unlocks controls");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

async function testDriverRendererBridge() {
    const view = render(getModernWebviewContent({ debugger: "J-Link · SWD", showJlinkDriverChoice: true }, "zh"));
    const env = hostEnvironment();
    const frame = env.frame((message) =>
        view.window.dispatchEvent(
            new view.window.MessageEvent("message", { source: view.window.parent, data: message })
        )
    );
    const host = env.root.EmberProbeSidebarHost.create(frame);
    try {
        view.window.eval(fs.readFileSync(path.join(mockup, "mock/prelude.js"), "utf8"));
        host.sendInitialState();
        env.advance(500);
        await Promise.resolve();
        const driver = view.document.getElementById("jlinkDriverChoice");
        const busy = view.document.getElementById("jlinkDriverBusy");
        const chipRead = view.document.getElementById("chipRead");
        const download = view.document.querySelector('[data-command="mcu-vscode.download"]');
        assert.equal(driver.hidden, false, "the real driver selector is visible");
        assert.equal(driver.value, "winusb");
        assert.equal(driver.disabled, false);
        assert.equal(busy.hidden, true);
        assert.equal(view.document.getElementById("mcuConfigSection").open, true);
        driver.value = "segger";
        driver.dispatchEvent(new view.window.Event("change"));
        assert.equal(driver.value, "winusb", "the renderer retains the confirmed choice while switching");
        env.deliver(frame, view.messages.at(-1));
        await Promise.resolve();
        assert.equal(driver.disabled, true);
        assert.equal(busy.hidden, false);
        assert.equal(chipRead.disabled, false, "the demo keeps supported chip refresh available during switching");
        env.advance(900);
        await Promise.resolve();
        assert.equal(driver.value, "segger");
        assert.equal(driver.disabled, false, "recovery remains available");
        assert.equal(busy.hidden, true);
        assert.equal(chipRead.disabled, true);
        assert.equal(download.disabled, true);
        assert.equal(view.document.getElementById("liveToggle").disabled, true);
        driver.value = "winusb";
        driver.dispatchEvent(new view.window.Event("change"));
        env.deliver(frame, view.messages.at(-1));
        env.advance(900);
        await Promise.resolve();
        assert.equal(driver.value, "winusb");
        assert.equal(chipRead.disabled, false);
        assert.equal(download.disabled, false);
        host.startSampling();
        await Promise.resolve();
        assert.equal(driver.disabled, true, "sampling disables driver changes");
        env.deliver(frame, { type: "selectProbeDriver", driver: "segger" });
        await Promise.resolve();
        assert.equal(driver.value, "winusb", "rejected driver changes restore the confirmed selection");
        assert.equal(driver.disabled, true, "busy responses cannot undo the sampling lock");
        assert.equal(busy.hidden, true);
        view.assertHealthy();
    } finally {
        host.destroy();
        view.close();
    }
}

function shellHtml() {
    const assets = {
        "operation-output.js": "window.EmberProbeMockOutput = " + JSON.stringify(operationOutput) + ";",
        "csv.js": `window.EmberProbeMockCsv = { buildCsv: ${csvTools.buildCsv}, csvDataRowCount: ${csvTools.csvDataRowCount} };`
    };
    return fs
        .readFileSync(path.join(mockup, "shell/index.html"), "utf8")
        .replace(/src="(?:sidebar|livewatch)\.(?:zh|en)\.html"/g, 'src="about:blank"')
        .replace(/<script src="([^"]+)"><\/script>/g, (_match, name) => {
            const directory = name.startsWith("shell") ? "shell" : "mock";
            const source =
                name === "chart-history.js"
                    ? "(function(root){" +
                      fs
                          .readFileSync(path.join(mockup, "../src/services/chartHistoryStore.js"), "utf8")
                          .replace("module.exports =", "root.EmberProbeMockHistory =") +
                      "})(window);"
                    : assets[name] || fs.readFileSync(path.join(mockup, directory, name), "utf8");
            return `<script>${source}</script>`;
        });
}

async function testShell() {
    const view = render(shellHtml());
    const doc = view.document;
    function hostMessage(frameId, message) {
        view.window.dispatchEvent(
            new view.window.MessageEvent("message", {
                source: doc.getElementById(frameId).contentWindow,
                data: { __emberprobeMock: true, message }
            })
        );
    }
    try {
        assert.ok(doc.querySelector('[data-view="explorer"] .codicon-files'));
        assert.ok(doc.querySelector('[data-view="debug"] .codicon-debug-alt'));
        assert.ok(doc.querySelector("#problemStatus .codicon-error"));
        assert.ok(doc.querySelector("#debug-toolbar .codicon-debug-step-over"));
        assert.ok(doc.querySelector('[data-tab="livewatch"].active'));
        assert.ok(doc.getElementById("panel").classList.contains("collapsed"));
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.equal(doc.querySelector('.view[data-view="debug"]'), null);
        assert.ok(!doc.body.textContent.includes("launch.json"));
        for (const button of doc.querySelectorAll(".activity-item[data-view]")) {
            button.click();
            assert.equal(doc.querySelector("#sidebar-views .view.active").dataset.view, "emberprobe");
            assert.equal(button.disabled, button.dataset.view !== "emberprobe");
        }
        assert.equal(doc.getElementById("terminalBody").textContent, "", "idle does not claim an unstarted download");
        assert.equal(doc.getElementById("debugConsoleBody").textContent, "", "idle has no invented session output");
        assert.equal(doc.getElementById("navigateBack").disabled, true);
        const initialFrame = doc.getElementById("livewatchFrame").contentWindow;
        doc.querySelector('[data-tab="main.c"]').click();
        doc.getElementById("navigateBack").click();
        assert.ok(doc.querySelector('[data-tab="livewatch"].active'));
        assert.equal(doc.getElementById("livewatchFrame").contentWindow, initialFrame);
        doc.getElementById("navigateForward").click();
        assert.ok(doc.querySelector('[data-tab="main.c"].active'));
        doc.getElementById("toggleSecondarySidebar").click();
        assert.equal(doc.getElementById("auxiliarybar").hidden, false);
        doc.getElementById("toggleSecondarySidebar").click();
        assert.equal(doc.getElementById("auxiliarybar").hidden, true);
        const frames = [doc.getElementById("sidebarFrame"), doc.getElementById("livewatchFrame")];
        const windows = frames.map((frame) => frame.contentWindow);
        const themeMessages = [[], []];
        frames.forEach((frame, index) => {
            frame.contentWindow.postMessage = (message) => themeMessages[index].push(message);
        });
        doc.getElementById("manageButton").click();
        assert.equal(doc.getElementById("theme-menu").hidden, false);
        doc.getElementById("themeLight").click();
        assert.equal(doc.documentElement.dataset.mockTheme, "light");
        assert.ok(doc.body.classList.contains("vscode-light"));
        assert.equal(doc.getElementById("theme-menu").hidden, true);
        for (let i = 0; i < frames.length; i++) {
            assert.equal(frames[i].contentWindow, windows[i], "theme changes preserve both hosts and frames");
            assert.equal(themeMessages[i].at(-1).theme, "light");
        }
        doc.getElementById("themeDark").click();
        assert.equal(doc.documentElement.dataset.mockTheme, "dark");
        assert.ok(doc.body.classList.contains("vscode-dark"));
        assert.equal(doc.getElementById("themeDark").getAttribute("aria-checked"), "true");
        hostMessage("sidebarFrame", { type: "executeCommand", cmd: "mcu-vscode.debug" });
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.equal(themeMessages[0].findLast((m) => m.type === "mockOperationStatus").availability.debug, false);
        assert.ok(doc.getElementById("debugConsoleBody").textContent.includes("Reading symbols from"));
        assert.ok(!doc.getElementById("debugConsoleBody").textContent.includes("Breakpoint 1"));
        assert.ok(doc.getElementById("emberprobeStatus").textContent.includes("正在执行"));
        await new Promise((resolve) => view.window.setTimeout(resolve, 2300));
        assert.equal(
            doc.querySelector("#sidebar-views .view.active").dataset.view,
            "emberprobe",
            "debug cannot replace the sidebar"
        );
        assert.ok(doc.getElementById("debugConsoleBody").textContent.includes("Breakpoint 1, ControlTask"));
        const activeGlyph = doc.querySelector(".gutter-line.active .glyph-margin");
        assert.ok(activeGlyph.querySelector(".codicon-debug-stackframe"));
        assert.ok(activeGlyph.querySelector(".breakpoint.codicon-debug-stackframe-dot"));
        doc.getElementById("dbgContinue").click();
        assert.ok(doc.getElementById("dbgContinue").querySelector(".codicon-debug-pause"));
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        assert.equal(doc.querySelector(".current-arrow"), null);
        assert.equal(doc.getElementById("debugCallStack"), null);
        const debugText = doc.getElementById("debugConsoleBody").textContent;
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F5", bubbles: true }));
        assert.equal(
            doc.getElementById("debugConsoleBody").textContent,
            debugText,
            "F5 does not launch another running session"
        );
        doc.getElementById("commandCenter").click();
        doc.getElementById("paletteInput").value = "下载程序";
        doc.getElementById("paletteInput").dispatchEvent(new view.window.Event("input"));
        doc.querySelector("#paletteList [data-index]").click();
        assert.equal(themeMessages[0].at(-1).type, "commandError", "palette download uses the same debug exclusion");
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F6", bubbles: true }));
        assert.equal(doc.getElementById("dbgStepOver").disabled, false);
        function frameShortcut(source, key, modifiers) {
            view.window.dispatchEvent(
                new view.window.MessageEvent("message", {
                    source,
                    data: { __emberprobeMockShortcut: true, key, ...modifiers }
                })
            );
        }
        frameShortcut({}, "F5");
        assert.equal(doc.getElementById("dbgStepOver").disabled, false, "foreign windows cannot resume debugging");
        frameShortcut(doc.getElementById("sidebarFrame").contentWindow, "F5");
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        frameShortcut(doc.getElementById("livewatchFrame").contentWindow, "F6");
        assert.equal(
            doc.getElementById("dbgStepOver").disabled,
            false,
            "chart shortcuts use the shared debug controls"
        );
        frameShortcut(doc.getElementById("livewatchFrame").contentWindow, "P", { ctrlKey: true, shiftKey: true });
        assert.equal(doc.getElementById("command-palette").classList.contains("hidden"), false);
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const initialLine = Number(doc.querySelector(".code-line.active-line").dataset.line);
        doc.getElementById("dbgStepOver").click();
        const second = Number(doc.querySelector(".code-line.active-line").dataset.line);
        assert.ok(second > initialLine, "stepping advances despite host state notification");
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F11", bubbles: true }));
        assert.ok(Number(doc.querySelector(".code-line.active-line").dataset.line) > second);
        const third = Number(doc.querySelector(".code-line.active-line").dataset.line);
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F11", shiftKey: true, bubbles: true }));
        assert.ok(Number(doc.querySelector(".code-line.active-line").dataset.line) > third);
        doc.querySelector('[data-tab="FreeRTOSConfig.h"]').click();
        assert.ok(doc.getElementById("code").textContent.includes("configUSE_PREEMPTION"));
        assert.ok(!doc.getElementById("code").textContent.includes("pid_update"));
        assert.ok(doc.getElementById("breadcrumbs").textContent.includes("Core›Inc›FreeRTOSConfig.h"));
        assert.equal(doc.querySelector(".code-line.active-line"), null);
        doc.querySelector('.gutter-line[data-line="4"]').click();
        assert.ok(doc.querySelector('.gutter-line[data-line="4"] .breakpoint'));
        doc.querySelector('[data-tab="main.c"]').click();
        assert.equal(
            doc.querySelector('.gutter-line[data-line="4"] .breakpoint'),
            null,
            "breakpoints are file-specific"
        );
        doc.querySelector('.gutter-line[data-line="103"]').click();
        assert.equal(doc.querySelector('.gutter-line[data-line="103"] .breakpoint'), null);
        doc.querySelector('.gutter-line[data-line="103"]').click();
        assert.ok(doc.querySelector('.gutter-line[data-line="103"] .breakpoint'));
        for (const id of ["sidebarFrame", "livewatchFrame"]) {
            const frame = doc.getElementById(id);
            const contentWindow = frame.contentWindow;
            hostMessage(id, { type: "setLang", lang: "en" });
            assert.equal(frame.contentWindow, contentWindow, "language changes keep the frame alive");
            assert.equal(frame.getAttribute("src"), "about:blank");
        }
        while (doc.querySelector("[data-close]")) doc.querySelector("[data-close]").click();
        assert.equal(doc.querySelector(".editor-pane.active"), null, "closing all tabs leaves an empty editor");
        doc.getElementById("dbgStop").click();
        hostMessage("sidebarFrame", { type: "executeCommand", cmd: "mcu-vscode.debug" });
        hostMessage("sidebarFrame", { type: "executeCommand", cmd: "mcu-vscode.debug" });
        assert.equal(doc.querySelector(".editor-pane.active"), null, "waiting leaves the current editor unchanged");
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F5", shiftKey: true, bubbles: true }));
        await new Promise((resolve) => view.window.setTimeout(resolve, 2300));
        assert.equal(doc.querySelector(".editor-pane.active"), null, "cancellation preserves the current editor");
        assert.ok(
            !doc.getElementById("debugConsoleBody").textContent.includes("Breakpoint 1"),
            "cancelled startup cannot emit a later stop"
        );
        hostMessage("sidebarFrame", { type: "executeCommand", cmd: "mcu-vscode.debug" });
        await new Promise((resolve) => view.window.setTimeout(resolve, 2300));
        assert.ok(doc.querySelector('[data-tab="main.c"].active'));
        doc.getElementById("dbgStop").click();
        hostMessage("sidebarFrame", { type: "executeCommand", cmd: "mcu-vscode.download" });
        const terminalBody = doc.getElementById("terminalBody");
        assert.equal(doc.getElementById("terminalName").textContent, "EmberProbe OpenOCD");
        assert.ok(!terminalBody.textContent.includes("固件下载并校验成功"));
        hostMessage("sidebarFrame", { type: "readChipInfo" });
        await new Promise((resolve) => view.window.setTimeout(resolve, 750));
        assert.equal(
            doc.querySelector(".panel-pane.active").dataset.panelPane,
            "terminal",
            "chip refresh preserves the download terminal"
        );
        assert.equal(themeMessages[0].findLast((m) => m.type === "chipInfoStatus").state, "ready");
        assert.equal(doc.getElementById("outputChannel"), null, "no invented EmberProbe Output channels");
        assert.equal(doc.getElementById("outputBody").textContent, "", "operations leave Output empty");
        await new Promise((resolve) => view.window.setTimeout(resolve, 4150));
        assert.ok(terminalBody.textContent.includes("→ 适配器时钟 2000 kHz"));
        assert.ok(terminalBody.textContent.includes("✓ 固件下载并校验成功"));
        assert.equal(doc.querySelector("#sidebar-views .view.active").dataset.view, "emberprobe");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

function testThemeBridge() {
    const view = render("<body></body>");
    const listeners = new Map();
    const values = new Map([["emberprobe.mock.theme", "light"]]);
    const parent = { postMessage() {} };
    const root = {
        parent,
        localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
        addEventListener: (type, handler) => listeners.set(type, handler)
    };
    try {
        vm.runInNewContext(fs.readFileSync(path.join(mockup, "mock/theme.js"), "utf8"), {
            window: root,
            document: view.document
        });
        assert.equal(root.EmberProbeMockTheme.current(), "light", "a saved theme survives a new page");
        const deliver = (source, theme) =>
            listeners.get("message")({ source, data: { __emberprobeMockTheme: true, theme } });
        deliver({}, "dark");
        assert.equal(root.EmberProbeMockTheme.current(), "light", "foreign frames cannot override the theme");
        deliver(parent, "invalid");
        assert.equal(root.EmberProbeMockTheme.current(), "light");
        deliver(parent, "dark");
        assert.equal(view.document.documentElement.dataset.mockTheme, "dark");
        assert.ok(view.document.body.classList.contains("vscode-dark"));
        root.EmberProbeMockTheme.apply("dark", true);
        assert.equal(values.get("emberprobe.mock.theme"), "dark");
        root.localStorage = {
            setItem() {
                throw new Error("storage disabled");
            }
        };
        assert.equal(root.EmberProbeMockTheme.apply("light", true), true);
    } finally {
        view.close();
    }
}

async function testFrozenChartTheme() {
    const view = render(csvTools.getLiveWatchContent({}, "zh"));
    try {
        view.send({ type: "watchList", items: liveData.watchList() });
        view.send({ type: "liveSample", t: 1000, samples: [{ name: "g_sensor_temp", value: 36.4, t: 1000 }] });
        view.document.getElementById("freeze").click();
        assert.equal(view.window.frozen, true);
        const history = JSON.stringify(view.window.data);
        view.window.dirty = false;
        view.document.body.classList.add("vscode-light");
        await Promise.resolve();
        assert.equal(view.window.dirty, true, "changing themes repaints a frozen canvas");
        assert.equal(view.window.frozen, true);
        assert.equal(JSON.stringify(view.window.data), history, "theme changes keep recorded chart data");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

async function testServer() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mockup-"));
    const root = path.join(directory, "dist");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(directory, "dist-secret"));
    fs.writeFileSync(path.join(root, "index.html"), "mock page");
    fs.writeFileSync(path.join(directory, "dist-secret/secret.txt"), "private");
    const server = createMockServer(root);
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        function request(url) {
            return new Promise((resolve, reject) => {
                http.get({ host: "127.0.0.1", port: server.address().port, path: url }, (response) => {
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk) => {
                        body += chunk;
                    });
                    response.on("end", () => resolve({ status: response.statusCode, body }));
                    response.on("error", reject);
                }).on("error", reject);
            });
        }
        for (const url of ["/%", "/%E0%A4%A", "/%00"]) assert.equal((await request(url)).status, 400);
        for (const url of ["/../dist-secret/secret.txt", "/..%2foutside.txt", "/missing.js"])
            assert.equal((await request(url)).status, 404);
        assert.deepStrictEqual(
            await request("/?cache=1"),
            { status: 200, body: "mock page" },
            "server survives invalid requests"
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

(async () => {
    testOperationLifecycle();
    testSvdCancellation();
    testConcurrentChipRefresh();
    testDriverSelection();
    testDynamicOperationOutput();
    testCpuOwnershipAndStoppedIntent();
    testStopGenerationAndTaskCleanup();
    testSimulatorAndRegisters();
    testHostsAndRenderer();
    testArchive();
    testReadableArchiveHeaders();
    testDebugLatency();
    testDebugBusyBridge();
    await testOperationAvailabilityBridge();
    await testDriverRendererBridge();
    await testShell();
    testThemeBridge();
    await testFrozenChartTheme();
    await testServer();
    console.log("Mockup regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
