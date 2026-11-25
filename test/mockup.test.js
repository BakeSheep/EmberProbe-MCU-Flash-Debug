"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const vm = require("vm");
const { render } = require("./helpers/render-webview");
const { FakeClock } = require("./helpers/fake-clock");
const { scenario } = require("./helpers/scenario");
const { getModernWebviewContent } = require("../src/modernView");
const { getRttPanelContent } = require("../src/rttPanelView");
const { STRINGS } = require("../src/i18n");
const liveWatchView = require("../src/liveWatchView");
const mockCsv = require("../mockup/mock-csv");
const mockRtt = require("../mockup/mock-rtt");
const mockMcp = require("../mockup/mock-mcp");
const configuration = require("../mockup/mock/configuration");
const sidebarData = require("../mockup/mock/sidebar-data");
const liveData = require("../mockup/mock/livewatch-data");
const { createMockServer } = require("../mockup/serve");
const mockup = path.resolve(__dirname, "../mockup");

function hostEnvironment() {
    const listeners = new Set();
    const jobs = new Map();
    const downloads = [];
    const downloadNames = [];
    let now = 1700000000000;
    let nextId = 0;
    const root = {
        EmberProbeSidebarData: sidebarData,
        EmberProbeLiveWatchData: liveData,
        EmberProbeMockCsv: mockCsv,
        EmberProbeMockHistory: require("../src/services/chartHistoryStore"),
        EmberProbeMockStrings: STRINGS,
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
        TextEncoder,
        TextDecoder,
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
            createElement: () => ({
                click() {
                    downloadNames.push(this.download);
                },
                remove() {}
            }),
            body: { appendChild() {} }
        }
    });
    vm.runInContext(mockRtt.browserSource(), context, { filename: "rtt-formatter.js" });
    vm.runInContext(mockMcp.browserSource(), context, { filename: "mcp-catalog.js" });
    for (const file of [
        "text.js",
        "configuration.js",
        "sampling.js",
        "archive.js",
        "rtt-settings.js",
        "sidebar-host.js",
        "livewatch-host.js",
        "rtt-panel-host.js"
    ])
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
    return { root, frame, deliver, advance, downloads, downloadNames, jobs, time: () => now };
}

function latest(frame, type) {
    return frame.messages.findLast((message) => message.type === type);
}

function testSimulatorAndRegisters() {
    const simulator = sidebarData.createSimulator();
    assert.ok(simulator.write("g_target_rpm", 2000));
    simulator.tick();
    assert.equal(simulator.scalarSamples(["g_target_rpm"], 1)[0].value, 2000);
    assert.ok(simulator.write("g_active_sensor.value.value", 26.5));
    const pointee = simulator.compositeSample("g_active_sensor.value", 1).tree.members[1];
    assert.equal(pointee.value, 26.5);
    assert.equal(pointee.address, 0x20000210);
    assert.equal(simulator.compositeSample("g_sensors", 1).tree.elements[1].members[1].value, 26.5);
    for (let tick = 0; tick < 300; tick++) simulator.tick();
    assert.ok(
        Math.abs(simulator.scalarSamples(["g_motor_rpm"], 1)[0].value - 2000) < 200,
        "the motor follows the target"
    );
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

function testMockUnlimitedPreset() {
    const env = hostEnvironment();
    const frame = env.frame();
    const host = env.root.EmberProbeLiveWatchHost.create(frame, {
        selectBackgroundPng: (done) => done("png-base64")
    });
    try {
        env.deliver(frame, { type: "ready" });
        assert.equal(latest(frame, "chartBackgroundIcon").enabled, true);
        env.deliver(frame, { type: "selectChartBackgroundIcon" });
        assert.equal(latest(frame, "importChartBackgroundIcon").pngBase64, "png-base64");
        env.deliver(frame, { type: "setChartBackgroundEnabled", enabled: false });
        assert.deepStrictEqual(
            { icon: latest(frame, "chartBackgroundIcon").icon, enabled: latest(frame, "chartBackgroundIcon").enabled },
            { icon: null, enabled: false }
        );
        env.deliver(frame, { type: "setChartBackgroundEnabled", enabled: true });
        assert.equal(latest(frame, "chartBackgroundIcon").enabled, true);
        assert.deepStrictEqual(latest(frame, "liveUnlimited"), { type: "liveUnlimited", enabled: false });
        env.deliver(frame, { type: "setUnlimitedSampling", enabled: true });
        assert.strictEqual(latest(frame, "liveUnlimited").enabled, true);
        env.deliver(frame, { type: "setUnlimitedSampling", enabled: false });
        assert.strictEqual(latest(frame, "liveUnlimited").enabled, false);
        assert.strictEqual(latest(frame, "samplingSpeedConfig").adaptive, true);
        env.deliver(frame, { type: "setSamplingSpeed", adaptive: false, speedKhz: 12000 });
        assert.deepStrictEqual(
            {
                adaptive: latest(frame, "samplingSpeedConfig").adaptive,
                khz: latest(frame, "samplingSpeedConfig").samplingAdapterSpeedKhz
            },
            { adaptive: false, khz: 12000 }
        );
        env.deliver(frame, { type: "setSamplingSpeed", adaptive: true });
        assert.strictEqual(latest(frame, "samplingSpeedConfig").adaptive, true);
    } finally {
        host.destroy();
    }
}

function testHostsAndRenderer() {
    const env = hostEnvironment();
    const view = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const sidebar = env.frame((message) => view.send(message));
    const simulator = sidebarData.createSimulator();
    const notices = [];
    const host = env.root.EmberProbeSidebarHost.create(sidebar, { simulator, notify: (event) => notices.push(event) });
    const live = env.frame();
    const liveHost = env.root.EmberProbeLiveWatchHost.create(live, { simulator, getSidebarWatch: host.getWatchList });
    try {
        env.deliver(sidebar, { type: "initCheck" });
        assert.equal(latest(sidebar, "chipInfoStatus").state, "idle");
        assert.equal(latest(sidebar, "chipInfo"), undefined);
        assert.equal(view.document.querySelector("#chipBody .chip-hero"), null);
        const memory = latest(sidebar, "memoryAnalysis").result;
        for (let i = 0; i < 5; i++) {
            env.advance(1);
            env.deliver(sidebar, { type: "memoryRefresh" });
            assert.deepStrictEqual(latest(sidebar, "memoryAnalysis").result, memory, "the same ELF has stable totals");
        }
        env.deliver(sidebar, { type: "writeVariable", name: "g_target_rpm", value: 1, seq: 1 });
        assert.equal(latest(sidebar, "writeResult").key, "sb.writeNeedSampling", "writes need a sampling session");
        assert.equal(latest(sidebar, "liveSample"), undefined, "no value is known before sampling starts");
        env.deliver(sidebar, { type: "liveToggle" });
        assert.equal(latest(sidebar, "liveStatus").mode, "standalone-pending");
        env.advance(400);
        assert.equal(latest(sidebar, "liveStatus").mode, "standalone-sampling");
        assert.equal(latest(sidebar, "liveStatus").frequencyHz, 20);
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
        assert.equal(latest(live, "chartValues").samples.find((sample) => sample.name === "g_target_rpm").value, 2000);
        assert.ok(latest(live, "liveCompositeSample").samples.some((sample) => sample.name === "g_imu"));

        env.deliver(sidebar, { type: "readChipInfo" });
        assert.equal(latest(sidebar, "chipInfoStatus").key, "chip.busyLive", "the chip card needs the probe to itself");
        env.deliver(sidebar, { type: "liveToggle" });
        assert.equal(latest(sidebar, "liveStatus").mode, "stopped");
        assert.equal(latest(sidebar, "liveStatus").canRead, false);
        env.deliver(sidebar, { type: "readChipInfo" });
        env.advance(700);
        assert.equal(latest(sidebar, "chipInfo").info.targetState, "running", "a powered board runs");
        assert.equal(latest(sidebar, "chipInfo").info.haltReason, "");
        env.deliver(sidebar, { type: "chipControl", action: "pause" });
        assert.equal(latest(sidebar, "chipInfoStatus").key, "chip.controlling");
        env.advance(500);
        assert.equal(latest(sidebar, "chipInfo").info.targetState, "halted");
        assert.ok(!notices.some((event) => event.action === "targetState"), "this is no debug session");
        env.deliver(sidebar, { type: "peripheralReadRequest", targets: ["GPIOA.MODER"] });
        assert.equal(latest(sidebar, "peripheralError").code, "PERIPHERAL_SAMPLING_REQUIRED");
        host.setTargetState("halted", { notify: false, line: 105 });
        assert.ok(latest(sidebar, "chipInfo").info.haltReason.includes("105"));
        assert.equal(latest(sidebar, "peripheralDebugStatus").mode, "debug-paused");
        const epoch = latest(sidebar, "peripheralDebugStatus").epoch;
        env.deliver(sidebar, { type: "peripheralReadRequest", targets: ["GPIOA.MODER"] });
        assert.equal(latest(sidebar, "peripheralReadResult").session.epoch, epoch);

        env.deliver(sidebar, { type: "liveToggle" });
        env.advance(200);
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

async function testWatchOriginatedWrites() {
    const env = hostEnvironment();
    const view = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const sidebar = env.frame((message) => view.send(message));
    const simulator = sidebarData.createSimulator();
    const host = env.root.EmberProbeSidebarHost.create(sidebar, { simulator });
    const at = { at: 0 };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
        env.deliver(sidebar, { type: "initCheck" });
        pump(env, sidebar, view, at);
        env.deliver(sidebar, { type: "liveToggle" });
        env.advance(400);
        pump(env, sidebar, view, at);
        const status = latest(sidebar, "liveStatus");
        const sampled = latest(sidebar, "liveSample").samples.find((sample) => sample.name === "g_motor_rpm");
        assert.equal(sampled.writeContext, status.writeContext, "sidebar samples carry the write context");
        assert.equal(sampled.address, 0x20000044);
        assert.equal(sampled.type, "u16");
        await settle();
        const row = view.document.querySelector('[data-breakpoint-path="g_motor_rpm"]');
        assert.ok(row, "the watch row offers the variable menu");
        row.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        const add = view.document.querySelector(".data-breakpoint-menu .watch-write-action");
        assert.equal(add.disabled, false, "a sampled watch variable can join the write list");
        add.click();
        pump(env, sidebar, view, at);
        const card = view.document.querySelector('#writeValues [data-raw-name="g_motor_rpm"]').closest(".write-row");
        assert.equal(card.classList.contains("gated"), false, "the card binds to the current sample context");
        const input = card.querySelector(".write-input");
        input.value = "2000";
        input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
        pump(env, sidebar, view, at);
        assert.equal(latest(sidebar, "writeResult").ok, true);
        assert.equal(simulator.scalarSamples(["g_motor_rpm"], 1)[0].value, 2000);

        // A typed runtime member is written through its sampled address, like the extension's dynamic writes.
        const motorWatch = view.document.querySelector('.av-watch[data-selection-name="g_motor"]');
        assert.ok(motorWatch, "the variable browser lists the runtime object");
        motorWatch.click();
        pump(env, sidebar, view, at);
        env.advance(100);
        pump(env, sidebar, view, at);
        await settle();
        const member = view.document.querySelector('[data-path="g_motor.speed._M_fp"]');
        assert.ok(member, "the expanded runtime object shows its scalar leaf");
        member.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        const addMember = view.document.querySelector(".data-breakpoint-menu .watch-write-action");
        assert.equal(addMember.disabled, false, "the runtime member binds to its sampled address");
        addMember.click();
        pump(env, sidebar, view, at);
        const memberInput = view.document
            .querySelector('#writeValues [data-raw-name="g_motor.speed._M_fp"]')
            .closest(".write-row")
            .querySelector(".write-input");
        memberInput.value = "1234.5";
        memberInput.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
        pump(env, sidebar, view, at);
        assert.equal(latest(sidebar, "writeResult").ok, true);
        assert.equal(simulator.compositeSample("g_motor", 1).tree.members[3].members[0].value, 1234.5);
    } finally {
        host.destroy();
        view.close();
    }
}

// Values made inside the hosts' vm context, compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Delivers what a real page posted since the last call to its mock host.
function pump(env, frame, view, from) {
    const start = from.at;
    from.at = view.messages.length;
    for (const message of view.messages.slice(start)) env.deliver(frame, message);
}

function testCompositeImportAndMembers() {
    const env = hostEnvironment();
    const chartView = render(liveWatchView.getLiveWatchContent({ panelId: 1 }, "zh"));
    const sidebarView = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const chart = env.frame((message) => chartView.send(message));
    const sidebar = env.frame((message) => sidebarView.send(message));
    chart.contentWindow.EmberProbeRuntime = chartView.window.EmberProbeRuntime;
    const sideAt = { at: 0 };
    const chartAt = { at: 0 };
    const host = env.root.EmberProbeSidebarHost.create(sidebar, {
        notify: (event) => {
            if (event.action === "sampling") chartHost.setSampling(event.phase);
        }
    });
    const chartHost = env.root.EmberProbeLiveWatchHost.create(chart, {
        getSidebarWatch: host.getWatchList,
        requestSampling: (running) => (running ? host.startSampling() : host.stopSampling())
    });
    try {
        env.deliver(sidebar, { type: "initCheck" });
        env.deliver(chart, { type: "ready" });
        pump(env, sidebar, sidebarView, sideAt);
        pump(env, chart, chartView, chartAt);
        chartView.document.getElementById("importSidebar").click();
        pump(env, chart, chartView, chartAt);
        assert.ok(latest(chart, "watchList").items.some((item) => item.name === "g_imu"));
        chartView.document.getElementById("run").click();
        pump(env, chart, chartView, chartAt);
        env.advance(500);
        assert.equal(latest(chart, "liveStatus").mode, "standalone-sampling");
        assert.ok(latest(chart, "chartValues").samples.some((item) => item.name === "g_motor_rpm"));
        assert.ok(latest(chart, "chartHistoryStatus").variables.includes("g_imu.accel[0]"));

        const document = sidebarView.document;
        const afterImport = sidebar.messages.length;
        const search = document.getElementById("varSearch");
        document.querySelector("#liveValues .composite .watch-remove").click();
        search.value = "accel";
        search.dispatchEvent(new sidebarView.window.Event("input", { bubbles: true }));
        document.querySelector('.av-watch[data-selection-name="g_imu.accel[0]"]').click();
        pump(env, sidebar, sidebarView, sideAt);
        env.advance(50);
        assert.ok(latest(sidebar, "liveSample").samples.some((sample) => sample.name === "g_imu.accel[0]"));
        assert.ok(!sidebar.messages.slice(afterImport).some((message) => message.type === "liveCompositeSample"));
        sidebarView.assertHealthy();
        chartView.assertHealthy();
    } finally {
        chartHost.destroy();
        host.destroy();
        sidebarView.close();
        chartView.close();
    }
}

function testConfigurationAndSvdCancellation() {
    const env = hostEnvironment();
    const sidebar = env.frame();
    let pick;
    const host = env.root.EmberProbeSidebarHost.create(sidebar, {
        quickPick: (items, _settings, done) => {
            pick = { items, done };
        }
    });
    const execute = (cmd) => env.deliver(sidebar, { type: "executeCommand", cmd: "mcu-vscode." + cmd });
    try {
        execute("selectElf");
        assert.equal(pick.items.length, 2);
        pick.done(pick.items[1]);
        assert.match(latest(sidebar, "memoryAnalysis").result.elf.path, /Release/);
        execute("selectDebugger");
        pick.done(undefined);
        assert.equal(latest(sidebar, "commandCancelled").cmd, "mcu-vscode.selectDebugger");
        execute("selectMcuCore");
        pick.done(pick.items[1]);
        assert.equal(latest(sidebar, "mockConfiguration").rows["mcu-vscode.selectMcuCore"].value, "stm32h7x.cfg");
        execute("selectIoc");
        pick.done(pick.items[1]);
        assert.equal(latest(sidebar, "mockConfiguration").firmware.generator, "cubemx2");
        env.deliver(sidebar, { type: "memorySelectSource" });
        pick.done(pick.items[1]);
        assert.match(latest(sidebar, "memoryAnalysis").result.source.linkerScript, /\.ld$/);
        execute("downloadOfficialSvd");
        env.advance(650);
        assert.equal(latest(sidebar, "svdStatus").state, "downloading");
        env.deliver(sidebar, { type: "cancelSvdDownload" });
        env.advance(5000);
        assert.equal(latest(sidebar, "svdStatus").key, "svd.cancelled");
        assert.equal(latest(sidebar, "commandCancelled").cmd, "mcu-vscode.downloadOfficialSvd");
        execute("downloadOfficialSvd");
        env.advance(2500);
        assert.equal(latest(sidebar, "svdStatus").state, "configured");
    } finally {
        host.destroy();
    }
}

function testRttRawModeAndLog() {
    const env = hostEnvironment();
    const sidebar = env.frame();
    const view = render(getRttPanelContent("zh"));
    const panel = env.frame((message) => view.send(message));
    const files = [];
    const simulator = sidebarData.createSimulator();
    const terminal = env.root.EmberProbeRttPanelHost.create(panel, {
        simulator,
        saveLog: (name, parts) => files.push([name, Buffer.concat(parts.map((part) => Buffer.from(part)))])
    });
    const host = env.root.EmberProbeSidebarHost.create(sidebar, {
        simulator,
        notify: (event) => {
            if (event.action === "rtt") terminal.sync(event);
        }
    });
    const send = (cmd) => env.deliver(sidebar, { type: "executeCommand", cmd: "mcu-vscode." + cmd });
    try {
        const { parse } = env.root.EmberProbeMockRttSettings;
        const settings = parse(
            JSON.stringify({
                "emberprobe.rtt.channels": [0, { index: 1, down: 0, format: "hex" }],
                "emberprobe.rtt.input.mode": "raw",
                "emberprobe.rtt.input.lineEnding": "crlf",
                "emberprobe.rtt.logFile.raw": true,
                "emberprobe.rtt.logFile.maxBytes": 64
            })
        );
        assert.ok(settings);
        assert.equal(parse('{"emberprobe.rtt.channels":[0,{"index":0}]}'), null);
        host.applyRttSettings(settings);
        send("rttSaveLog");
        send("startRtt");
        env.advance(500);
        env.deliver(panel, { type: "ready" });
        const snapshot = latest(panel, "rttPanelSnapshot");
        assert.equal(snapshot.inputMode, "raw");
        assert.match(snapshot.channels[1].text, /74 72 61 63 65/);
        assert.equal(snapshot.channels[1].hasInput, true, "up 1 may use down 0");
        view.document.querySelector('#tabs [data-channel="1"]').click();
        view.document
            .getElementById("output")
            .dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "v", bubbles: true, cancelable: true }));
        const keystroke = view.messages.findLast((message) => message.type === "rttSendRaw");
        assert.equal(keystroke.channel, 1);
        env.deliver(panel, keystroke);
        env.deliver(panel, { type: "rttSendRaw", channel: 1, data: "ersion\r" });
        env.advance(40);
        assert.match(latest(panel, "rttOutput").text, /gcc 13\.3\.1/);
        env.deliver(panel, { type: "rttSendRaw", channel: 1, data: "a".repeat(64) });
        assert.equal(latest(panel, "rttInputProblem").channel, 1);
        send("rttSaveLog");
        assert.ok(files.some(([name, contents]) => name.endsWith(".bin.1") && contents.length === 64));
        assert.match(files.find(([name]) => name.endsWith("-ch1.bin"))[1].toString(), /trace: stream/);
        host.startDebug("attach");
        assert.equal(latest(sidebar, "rttStatus").state, "pending-host");
        env.advance(2200);
        host.setTargetState("halted", { notify: false });
        env.advance(500);
        assert.equal(latest(sidebar, "rttStatus").state, "running");
        view.assertHealthy();
    } finally {
        terminal.destroy();
        host.destroy();
        view.close();
    }
}

function testMcpConnectivityScenarios() {
    for (const outcome of [undefined, "initialize", "tools", "timeout"]) {
        const env = hostEnvironment();
        const side = env.frame();
        const host = env.root.EmberProbeSidebarHost.create(side, { mcpOutcome: outcome });
        try {
            env.deliver(side, { type: "checkMcpConnection" });
            assert.equal(latest(side, "mcpConnection"), undefined);
            env.advance(outcome === "timeout" ? 10000 : 350);
            const result = latest(side, "mcpConnection");
            assert.equal(result.state, outcome ?? "connected");
            if (!outcome) assert.equal(result.toolCount, require("../src/mcp/tools").TOOLS.length);
        } finally {
            host.destroy();
        }
    }
}

function testDebugCoreSelection() {
    const env = hostEnvironment();
    const sidebar = env.frame();
    const host = env.root.EmberProbeSidebarHost.create(sidebar, { debugCores: 2 });
    try {
        host.startDebug("attach");
        env.advance(2200);
        host.setTargetState("halted", { notify: false });
        const primary = latest(sidebar, "rtosDebugStatus");
        assert.equal(primary.sessions.length, 2);
        const core = primary.sessions[1];
        env.deliver(sidebar, { type: "debugSelectSession", sessionId: core.id });
        const selected = latest(sidebar, "rtosDebugStatus");
        assert.equal(selected.sessionId, core.id);
        assert.ok(selected.stopEpoch > primary.stopEpoch);
        env.deliver(sidebar, { type: "rtosRefresh" });
        assert.equal(latest(sidebar, "rtosSnapshot").sessionId, core.id);
        env.deliver(sidebar, { type: "executeCommand", cmd: "mcu-vscode.startRtt" });
        assert.equal(latest(sidebar, "notice").notice.key, "rtt.err.multicore");
    } finally {
        host.destroy();
    }
}

function testRttWithRenderers() {
    const env = hostEnvironment();
    const sidebarView = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const panelView = render(getRttPanelContent("zh"));
    const sidebar = env.frame((message) => sidebarView.send(message));
    const panel = env.frame((message) => panelView.send(message));
    const simulator = sidebarData.createSimulator();
    const picks = [];
    const inputs = [];
    const events = [];
    const panelHost = env.root.EmberProbeRttPanelHost.create(panel, {
        simulator,
        translate: env.root.EmberProbeMockText.create(() => false)
    });
    const host = env.root.EmberProbeSidebarHost.create(sidebar, {
        simulator,
        quickPick: (items, settings, done) => picks.push({ items, settings, done }),
        inputBox: (settings, done) => inputs.push({ settings, done }),
        notify(event) {
            events.push(event);
            if (event.action === "rtt") panelHost.sync(event);
        }
    });
    const sidebarAt = { at: 0 };
    const panelAt = { at: 0 };
    const doc = sidebarView.document;
    const panelDoc = panelView.document;
    const lines = () => panelDoc.getElementById("lines").textContent;
    try {
        env.deliver(sidebar, { type: "initCheck" });
        pump(env, panel, panelView, panelAt);
        assert.equal(latest(panel, "rttPanelSnapshot").channels.length, 0, "the panel starts empty");

        // Before any start the picker lists only the configured channel and says the firmware list is unknown.
        doc.getElementById("rttChannelPick").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        assert.equal(picks.length, 1);
        assert.equal(picks[0].settings.canPickMany, true);
        assert.equal(picks[0].settings.placeHolder, STRINGS.zh["rtt.channelsPlaceholderUnknown"]);
        assert.deepStrictEqual(plain(picks[0].items.map((item) => item.label)), [
            "通道 0",
            STRINGS.zh["rtt.channelOther"]
        ]);
        picks[0].done(undefined);

        doc.getElementById("rttToggle").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        assert.equal(latest(sidebar, "rttStatus").state, "starting");
        env.advance(500);
        const running = latest(sidebar, "rttStatus");
        assert.equal(running.state, "running");
        assert.deepStrictEqual(running.view.selectedChannels, [0]);
        assert.deepStrictEqual(
            running.channels.up.map((channel) => channel.index),
            [0]
        );
        assert.ok(
            events.some((event) => event.action === "rttReveal"),
            "the panel comes forward on start"
        );
        assert.ok(lines().includes("EmberProbe Demo"), "the firmware's banner reaches the panel");
        assert.equal(panelDoc.getElementById("tabs").hidden, true, "one channel shows no tabs");
        env.advance(1000);
        assert.match(lines(), /ctrl: rpm=\d+ target=\d+ temp=/);
        const buffer = latest(sidebar, "rttStatus").buffers[0];
        assert.ok(buffer.receivedBytes > 0 && buffer.rateBytesPerSecond > 0, "the card's counters move");
        assert.ok(doc.querySelector("#rttChannels .rtt-ch-metrics").textContent.includes("48/1024 B"));
        assert.equal(doc.getElementById("noticeRtt").hidden, true, "known occupancy raises no notice");

        // The input box sends a line; the firmware's shell answers it.
        const input = panelDoc.getElementById("input");
        assert.equal(input.disabled, false, "channel 0 has a down buffer");
        input.value = "rpm 1200";
        panelDoc.getElementById("inputRow").dispatchEvent(new panelView.window.Event("submit", { cancelable: true }));
        pump(env, panel, panelView, panelAt);
        assert.equal(latest(panel, "rttSendResult").ok, true);
        assert.ok(lines().includes("> rpm 1200"));
        env.advance(40);
        assert.ok(lines().includes("target rpm = 1200"));
        assert.equal(simulator.scalarSamples(["g_target_rpm"], 1)[0].value, 1200);
        input.value = "x".repeat(80);
        panelDoc.getElementById("inputRow").dispatchEvent(new panelView.window.Event("submit", { cancelable: true }));
        pump(env, panel, panelView, panelAt);
        assert.equal(latest(panel, "rttSendResult").ok, false);
        assert.ok(panelDoc.getElementById("inputError").textContent.includes("63"), "a line must fit the down buffer");

        // Now the firmware's channels are known; picking both restarts RTT with two terminals.
        doc.getElementById("rttChannelPick").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        const pick = picks[1];
        assert.equal(pick.settings.placeHolder, STRINGS.zh["rtt.channelsPlaceholder"]);
        assert.deepStrictEqual(
            plain(pick.items.map((item) => [item.label, item.description || "", item.detail || "", !!item.picked])),
            [
                ["通道 0", "Terminal", "缓冲区 1024 B", true],
                ["通道 1", "Trace", "缓冲区 4096 B", false],
                [STRINGS.zh["rtt.channelOther"], "", "", false]
            ]
        );
        pick.done(pick.items.slice(0, 2));
        assert.equal(latest(sidebar, "rttStatus").state, "starting", "a running attachment restarts");
        assert.equal(doc.getElementById("rttChannelPick").textContent, "通道 0, 1");
        env.advance(500);
        assert.deepStrictEqual(
            latest(sidebar, "rttStatus").channels.up.map((channel) => channel.name),
            ["Terminal", "Trace"]
        );
        assert.equal(panelDoc.getElementById("tabs").hidden, false);
        assert.equal(panelDoc.querySelectorAll("#tabs .tab").length, 2);
        assert.ok(lines().includes(STRINGS.zh["rtt.termStopped"]), "the restart is visible in the transcript");

        // Typed channel numbers come from an input box; an empty set is refused with the extension's notice.
        doc.getElementById("rttChannelPick").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        picks[2].done([picks[2].items.at(-1)]);
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].settings.validate("1, x"), STRINGS.zh["rtt.channelOtherInvalid"]);
        inputs[0].done("0, 5");
        assert.deepStrictEqual(latest(sidebar, "rttStatus").view.selectedChannels, [0, 5]);
        doc.getElementById("rttChannelPick").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        const notListed = picks[3].items.find((item) => item.index === 5);
        assert.equal(notListed.description, STRINGS.zh["rtt.channelNotListed"]);
        picks[3].done([]);
        assert.equal(latest(sidebar, "notice").notice.key, "rtt.channelsNone");
        env.advance(500);

        // The log button names the file it writes in its tooltip, and the next click stops saving.
        doc.getElementById("rttSaveLog").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        const log = latest(sidebar, "rttStatus").view.log;
        assert.equal(log.enabled, true);
        assert.match(log.file, /\/rtt-\d{8}-\d{6}\.log$/);
        assert.ok(doc.getElementById("rttSaveLog").title.includes(log.file));
        assert.equal(doc.getElementById("rttSaveLog").getAttribute("aria-pressed"), "true");
        doc.getElementById("rttSaveLog").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        assert.equal(latest(sidebar, "rttStatus").view.log.file, "");
        assert.equal(doc.getElementById("rttSaveLog").title, STRINGS.zh["rtt.saveLogTitle"]);

        // Timestamps prefix each firmware line with the host time.
        doc.getElementById("rttTimestamps").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        env.advance(1000);
        assert.match(lines(), /\[\d\d:\d\d:\d\d\.\d{3}\] \[I\] ctrl:/);

        // A halted target prints nothing.
        host.startDebug("attach");
        env.advance(2200);
        host.setTargetState("halted", { notify: false, line: 90 });
        const halted = lines();
        env.advance(3000);
        assert.equal(lines(), halted);
        host.setTargetState("running", { notify: false, ended: true });

        // Stop marks each channel; a reload gets the scrollback back, a clear does not.
        doc.getElementById("rttToggle").click();
        pump(env, sidebar, sidebarView, sidebarAt);
        assert.equal(latest(sidebar, "rttStatus").state, "stopped");
        assert.equal(
            latest(panel, "rttPanelStatus").channels.every((channel) => !channel.active),
            true
        );
        panelHost.reload();
        env.deliver(panel, { type: "ready" });
        const snapshot = latest(panel, "rttPanelSnapshot");
        assert.ok(snapshot.channels.find((channel) => channel.index === 0).text.includes("target rpm = 1200"));
        assert.deepStrictEqual(snapshot.history[0], ["rpm 1200"], "a refused line is not remembered");
        env.deliver(panel, { type: "rttClear", channel: 0 });
        env.deliver(panel, { type: "ready" });
        assert.equal(latest(panel, "rttPanelSnapshot").channels.find((channel) => channel.index === 0).text, "");
        sidebarView.assertHealthy();
        panelView.assertHealthy();
    } finally {
        host.destroy();
        panelHost.destroy();
        sidebarView.close();
        panelView.close();
    }
}

async function testDataBreakpointsWithRenderer() {
    const env = hostEnvironment();
    const view = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const sidebar = env.frame((message) => view.send(message));
    const inputs = [];
    const events = [];
    let host = null;
    host = env.root.EmberProbeSidebarHost.create(sidebar, {
        simulator: sidebarData.createSimulator(),
        inputBox: (settings, done) => inputs.push({ settings, done }),
        notify(event) {
            events.push(event);
            if (event.action === "pauseDebug") host.setTargetState("halted", { notify: false, line: 95 });
        }
    });
    const at = { at: 0 };
    const doc = view.document;
    const request = (body) => {
        const status = latest(sidebar, "sidebarDataBreakpoints");
        env.deliver(sidebar, {
            type: "sidebarDataBreakpoint",
            sessionId: status.sessionId,
            epoch: status.epoch,
            generation: latest(sidebar, "sidebarDataBreakpoints").generation,
            requestId: 1000 + sidebar.messages.length,
            ...body
        });
        return sidebar.messages.at(-1);
    };
    const menuButton = (label) =>
        [...doc.querySelectorAll(".data-breakpoint-menu button")].find((button) => button.textContent.includes(label));
    // Rows are decorated by the page's MutationObserver, which runs after the render.
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const openMenu = async (name) => {
        await settle();
        const row = doc.querySelector(`[data-breakpoint-path="${name}"]`);
        assert.ok(row, `${name} is decorated for data breakpoints`);
        row.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        pump(env, sidebar, view, at);
    };
    try {
        env.deliver(sidebar, { type: "initCheck" });
        pump(env, sidebar, view, at);
        await openMenu("g_motor_rpm");
        assert.ok(
            doc.querySelector('[role="menu"]').textContent.includes(STRINGS.zh["sb.dataNoSession"]),
            "outside a debug session the menu explains data breakpoint availability"
        );
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape" }));

        host.startDebug("reset");
        env.advance(2200);
        host.setTargetState("running", { notify: false });
        pump(env, sidebar, view, at);
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").available, true);
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").paused, false);

        // A running target offers only the pause; pausing reopens the menu with the storage resolved.
        await openMenu("g_motor_rpm");
        menuButton(STRINGS.zh["sb.dataPause"]).click();
        pump(env, sidebar, view, at);
        pump(env, sidebar, view, at);
        assert.ok(events.some((event) => event.action === "pauseDebug"));
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").paused, true);
        assert.equal(doc.querySelector(".data-breakpoint-head-meta").textContent, "0x20000044 · 2 字节");
        menuButton(STRINGS.zh["sb.dataWrite"]).click();
        pump(env, sidebar, view, at);
        const mark = doc.querySelector('[data-breakpoint-path="g_motor_rpm"] > .data-breakpoint-mark');
        assert.ok(mark, "the watch row shows the armed watchpoint");
        assert.ok(mark.title.includes(STRINGS.zh["sb.dataWrite"]));
        assert.equal(events.findLast((event) => event.action === "dataBreakpoints").entries.length, 1);

        // Members resolve through the layout; display-only rows cannot be watched.
        request({ action: "info", name: "g_imu.temp" });
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").info.address, "0x20000118");
        request({ action: "info", name: "g_imu.accel[2]" });
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").info.address, "0x20000108");
        request({ action: "info", name: "g_active_sensor" });
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").info.dataId, null);
        request({ action: "info", name: "g_imu" });
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").info.dataId, null, "a struct has no single width");

        // Four comparators: the fifth enabled watchpoint is reported as not set.
        for (const name of ["g_sensor_temp", "g_bus_voltage", "g_error_count", "g_loop_time_us"]) {
            request({ action: "info", name });
            const info = latest(sidebar, "sidebarDataBreakpoints").info;
            request({ action: "add", name, dataId: info.dataId, accessType: "readWrite" });
        }
        let entries = latest(sidebar, "sidebarDataBreakpoints").entries;
        assert.equal(entries.length, 5);
        assert.equal(entries[4].verified, false);
        assert.equal(entries[4].message, STRINGS.zh["debug.dataBreakpointHardware"]);
        request({ action: "enable", id: entries[1].id, enabled: false });
        entries = latest(sidebar, "sidebarDataBreakpoints").entries;
        assert.equal(entries[4].verified, true, "disabling one frees a comparator");

        // The condition comes from VS Code's input box.
        request({ action: "condition", id: entries[0].id, condition: "" });
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].settings.prompt, STRINGS.zh["sb.dataConditionPrompt"]);
        inputs[0].done("g_motor_rpm > 2500");
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").entries[0].condition, "g_motor_rpm > 2500");
        request({ action: "remove", id: entries[4].id });
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").entries.length, 4);

        // A request from an earlier stop is stale.
        const before = latest(sidebar, "sidebarDataBreakpoints");
        host.setTargetState("halted", { notify: false, line: 96, step: true });
        env.deliver(sidebar, {
            type: "sidebarDataBreakpoint",
            action: "remove",
            id: entries[0].id,
            sessionId: before.sessionId,
            epoch: before.epoch,
            generation: before.generation,
            requestId: 9999
        });
        assert.equal(latest(sidebar, "sidebarDataBreakpointError").message, STRINGS.zh["sb.dataStale"]);

        // Running into an armed watchpoint stops the target; removing the watch row removes its watchpoints.
        host.setTargetState("running", { notify: false });
        env.advance(700);
        const hit = events.findLast((event) => event.action === "dataBreakpointHit");
        assert.equal(hit.name, "g_bus_voltage", "a false condition skips the first watchpoint");
        assert.equal(hit.accessType, "readWrite");
        host.setTargetState("halted", { notify: false, line: 97 });
        env.deliver(sidebar, {
            type: "saveSidebarWatch",
            items: ["g_sensor_temp", "g_bus_voltage", "g_imu"].map((name) => sidebarData.watchItem(name))
        });
        assert.ok(!latest(sidebar, "sidebarDataBreakpoints").entries.some((entry) => entry.name === "g_motor_rpm"));
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").entries.length, 3, "other rows keep theirs");

        host.setTargetState("running", { notify: false, ended: true });
        assert.equal(latest(sidebar, "sidebarDataBreakpoints").available, false);
        assert.equal(events.findLast((event) => event.action === "dataBreakpoints").entries.length, 0);
        view.assertHealthy();
    } finally {
        host.destroy();
        view.close();
    }
}

function testTypeShowcase() {
    const simulator = sidebarData.createSimulator();
    simulator.tick();
    const scalars = Object.fromEntries(
        simulator
            .scalarSamples(["g_motor_mode", "g_app_state", "g_active_sensor", "g_on_fault", "g_banner", "g_pending"], 1)
            .map((sample) => [sample.name, sample])
    );
    assert.equal(scalars.g_motor_mode.enumText, "MODE_RUN(1)");
    assert.equal(scalars.g_active_sensor.pointerInfo.name, "g_sensors");
    assert.equal(scalars.g_on_fault.pointerInfo.kind, "function");
    assert.ok(scalars.g_banner.pointerString);
    assert.equal(scalars.g_pending.value, 0);
    assert.ok(sidebarData.layoutResult("g_active_sensor").layout.runtimeLayout, "scalar pointers expand at runtime");
    assert.ok(sidebarData.layoutResult("missing").error);

    const env = hostEnvironment();
    const view = render(getModernWebviewContent({ elf: "Demo.elf" }, "zh"));
    const sidebar = env.frame((message) => view.send(message));
    const host = env.root.EmberProbeSidebarHost.create(sidebar, { simulator });
    try {
        const names = [
            "g_app_state",
            "g_active_sensor",
            "g_on_fault",
            "g_pending",
            "g_motor",
            "g_target_rpm_ref",
            "g_rpm_history",
            "g_speed_limit"
        ];
        env.deliver(sidebar, { type: "saveSidebarWatch", items: names.map((name) => sidebarData.watchItem(name)) });
        env.deliver(sidebar, { type: "initCheck" });
        env.deliver(sidebar, { type: "liveToggle" });
        env.advance(600);
        for (const head of view.document.querySelectorAll("#liveValues .composite:not(.open) .sb-comp-head"))
            head.click();
        const text = view.document.getElementById("liveValues").textContent;
        for (const expected of [".Active / .Ready(3)", "&g_sensors[1]", "fault_handler()", "NULL", '"left-wheel"'])
            assert.ok(text.includes(expected), expected);
        assert.match(text, /已隐藏 \d+ 个内部成员/);
        const card = (name) => view.document.querySelector(`#liveValues [data-reorder-key="${name}"]`).textContent;
        assert.match(card("g_target_rpm_ref"), /uint16_t &1500/);
        assert.match(card("g_rpm_history"), /std::vector<uint16_t>.*1635/);
        assert.match(card("g_speed_limit"), /std::optional<uint16_t>.*2400/);
        view.assertHealthy();
    } finally {
        host.destroy();
        view.close();
    }
}

function testArchive() {
    const env = hostEnvironment();
    const frame = env.frame();
    const host = env.root.EmberProbeLiveWatchHost.create(frame, { archiveMaxBytes: 520 });
    try {
        env.deliver(frame, { type: "samplingArchiveInfo" });
        assert.equal(latest(frame, "samplingArchiveInfo").rows, 0);
        env.deliver(frame, { type: "exportCsv", names: ["g_motor_rpm"] });
        assert.equal(latest(frame, "exportCsvResult").ok, false);
        assert.equal(env.downloads.length, 0, "no empty download is offered");
        env.deliver(frame, { type: "start", items: [sidebarData.watchItem("g_motor_rpm")], frequencyHz: 10 });
        const first = env.time();
        env.advance(200);
        env.deliver(frame, {
            type: "exportCsv",
            names: ["g_motor_rpm"],
            fromMs: first + 100,
            toMs: first + 100,
            fileName: "motor.csv"
        });
        assert.equal(env.downloadNames.at(-1), "motor.csv");
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
        assert.equal(info.firstTimestampMs, first);
        assert.equal(host.isRunning(), false, "acquisition stops at the byte limit");
        env.deliver(frame, { type: "exportCsv", names: ["g_motor_rpm"], fromMs: first + 300, toMs: first + 400 });
        assert.equal(latest(frame, "exportCsvResult").ok, false, "an empty time range does not report success");
        env.deliver(frame, { type: "stop" });
        env.advance(200);
        env.deliver(frame, { type: "samplingArchiveInfo" });
        assert.equal(latest(frame, "samplingArchiveInfo").lastTimestampMs, first + 200);
        env.deliver(frame, { type: "clearSamplingHistory", historyRevision: 1 });
        env.deliver(frame, { type: "start", items: [], frequencyHz: 10 });
        env.advance(100);
        assert.deepStrictEqual(latest(frame, "chartValues").samples, [], "an empty list never restarts old series");
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

function testIndependentChartHistory() {
    const env = hostEnvironment();
    const archive = env.root.EmberProbeMockArchive.create();
    const history = new env.root.EmberProbeMockHistory.ChartHistoryStore();
    const a = env.frame();
    const b = env.frame();
    const first = env.root.EmberProbeLiveWatchHost.create(a, { scope: "a", archive, history });
    const second = env.root.EmberProbeLiveWatchHost.create(b, { scope: "b", archive, history });
    const start = (frame, name) =>
        env.deliver(frame, { type: "start", items: [sidebarData.watchItem(name)], frequencyHz: 20 });
    const status = (frame) => {
        env.deliver(frame, { type: "samplingArchiveInfo" });
        return latest(frame, "samplingArchiveInfo");
    };
    try {
        start(a, "g_motor_rpm");
        start(b, "g_sensor_temp");
        env.advance(100);
        const original = status(a);
        assert.deepStrictEqual(original.variables, ["g_motor_rpm"]);
        assert.deepStrictEqual(status(b).variables, ["g_sensor_temp"]);
        env.deliver(b, { type: "chartFreeze", historyRevision: 0, requestId: 1 });
        const snapshot = latest(b, "chartFreezeResult").snapshotId;
        first.debugSessionChanged("test-core");
        assert.equal(status(a).rows, 0);
        env.advance(50);
        assert.equal(status(a).rows, 1);
        env.deliver(a, { type: "clearSamplingHistory", historyRevision: 2 });
        assert.equal(status(a).rows, 0);
        assert.ok(history.status("b", snapshot).variables.includes("g_sensor_temp"));
        first.debugSessionChanged();
        assert.deepStrictEqual(status(a), original);
    } finally {
        first.destroy();
        second.destroy();
    }
}

function sidebarWithSampling() {
    const env = hostEnvironment();
    const frame = env.frame();
    const simulator = sidebarData.createSimulator();
    const notices = [];
    const host = env.root.EmberProbeSidebarHost.create(frame, { simulator, notify: (event) => notices.push(event) });
    host.sendInitialState();
    const names = ["g_motor_rpm", "g_state", "g_loop_time_us"];
    env.deliver(frame, { type: "saveSidebarWatch", items: names.map((name) => sidebarData.watchItem(name)) });
    env.deliver(frame, { type: "liveToggle" });
    env.advance(400);
    assert.equal(latest(frame, "liveStatus").mode, "standalone-sampling");
    const samples = () => JSON.stringify(latest(frame, "liveSample").samples.map((item) => [item.name, item.value]));
    return { env, frame, simulator, notices, host, samples };
}

function testSamplingFollowsDebugSession() {
    const { env, frame, notices, host, samples } = sidebarWithSampling();
    const mode = () => latest(frame, "liveStatus").mode;
    const sampleCount = () => frame.messages.filter((message) => message.type === "liveSample").length;
    try {
        host.startDebug("attach");
        assert.equal(mode(), "debug-running-waiting");
        assert.equal(latest(frame, "liveStatus").key, "live.debugWaiting");
        assert.equal(latest(frame, "liveStatus").canRead, false);
        const started = sampleCount();
        env.advance(1399);
        assert.equal(sampleCount(), started, "no sample is read while debug starts");
        env.advance(1);
        assert.equal(latest(frame, "commandSuccess").cmd, "mcu-vscode.attachDebug");
        assert.ok(notices.some((event) => event.action === "debugSessionChanged"));
        assert.equal(notices.find((event) => event.action === "debugStart").kind, "attach");

        host.setTargetState("halted", { notify: false, line: 90 });
        assert.equal(mode(), "debug-paused-reading");
        env.advance(120);
        assert.equal(mode(), "debug-paused-ready");
        const frozen = samples();
        const count = sampleCount();
        env.advance(5000);
        assert.equal(sampleCount(), count, "a paused target gets one snapshot per stop");
        env.deliver(frame, { type: "peripheralReadRequest", targets: ["GPIOA.MODER"] });
        const first = JSON.stringify(latest(frame, "peripheralReadResult").registers);
        env.deliver(frame, { type: "peripheralReadRequest", targets: ["GPIOA.MODER"] });
        assert.equal(JSON.stringify(latest(frame, "peripheralReadResult").registers), first, "registers hold");
        assert.equal(samples(), frozen);

        host.setTargetState("halted", { notify: false, line: 91, step: true });
        env.advance(120);
        assert.notEqual(samples(), frozen, "a step lets the target run and takes a new snapshot");
        assert.equal(mode(), "debug-paused-ready");

        host.setTargetState("running", { notify: false });
        assert.equal(mode(), "debug-running-waiting");
        env.advance(150);
        assert.equal(mode(), "debug-running-sampling");
        assert.equal(latest(frame, "liveStatus").source, "openocd");

        host.setTargetState("running", { notify: false, ended: true });
        assert.equal(latest(frame, "liveStatus").key, "live.restoring");
        env.advance(600);
        assert.equal(mode(), "standalone-sampling");
    } finally {
        host.destroy();
    }
}

function testResetStopsBeforeFirmwareRuns() {
    const { env, frame, host } = sidebarWithSampling();
    const value = (name) => latest(frame, "liveSample").samples.find((item) => item.name === name).value;
    try {
        assert.notEqual(value("g_motor_rpm"), 0);
        host.startDebug("reset");
        env.advance(2200);
        host.setTargetState("halted", { notify: false, line: 167 });
        env.advance(120);
        assert.equal(value("g_motor_rpm"), 0, "nothing has run yet at main");
        host.setTargetState("running", { notify: false });
        env.advance(200);
        assert.notEqual(value("g_motor_rpm"), 0);
    } finally {
        host.destroy();
    }
}

function testDownloadRun() {
    const { env, frame, notices, host } = sidebarWithSampling();
    const flash = () => frame.messages.filter((message) => message.type === "notice" && message.area === "flash");
    try {
        env.deliver(frame, { type: "executeCommand", cmd: "mcu-vscode.download" });
        assert.equal(latest(frame, "liveStatus").mode, "stopped", "sampling gives up the probe");
        env.deliver(frame, { type: "executeCommand", cmd: "mcu-vscode.download" });
        assert.equal(flash().at(-1).notice.key, "msg.downloadBusy");
        env.advance(580);
        assert.equal(flash().at(-1).notice.key, "run.flashClock");
        env.advance(380);
        assert.equal(flash().at(-1).notice.message, "开始写入固件");
        env.advance(1500);
        assert.equal(flash().at(-1).notice.key, "run.verifyStart");
        env.advance(740);
        const done = flash().at(-1).notice;
        assert.deepEqual([done.level, done.key], ["success", "msg.downloadSuccess"]);
        assert.ok(flash().every((message) => message.notice.level !== "error"));
        assert.equal(latest(frame, "commandSuccess").cmd, "mcu-vscode.download");
        const log = notices.filter((event) => event.action === "flashLog").flatMap((event) => event.lines);
        assert.equal(log[0].text, "EmberProbe 固件下载");
        assert.ok(log.some((line) => line.text === "→ 目标电压 3.30 V"));
        assert.ok(log.some((line) => line.text === "→ 烧录时钟 15000 kHz"));
        assert.ok(log.some((line) => line.text === "✓ 固件校验通过"));
        const allFlashText = [
            ...log.map((line) => line.text),
            ...flash().map((message) => message.notice.message || "")
        ].join("\n");
        assert.doesNotMatch(
            allFlashText,
            /耗时|已写入|已校验|KiB\/s|正在启动 OpenOCD|EP_FLASH_STAGE=|interface\/|target\//,
            "flash terminal prints real openocdRunner output without fake timing or config prefixes"
        );
        assert.equal(latest(frame, "liveStatus").mode, "standalone-pending", "sampling comes back afterwards");
        env.advance(400);
        assert.equal(latest(frame, "liveStatus").mode, "standalone-sampling");
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
        '<body><i id="statusDot"></i><div id="flashStatus"><span id="statusText"></span></div><div class="primary-actions"><button data-command="debug"></button><button data-command="flash" disabled></button></div></body>'
    );
    try {
        view.window.eval(fs.readFileSync(path.join(mockup, "mock/prelude.js"), "utf8"));
        const [debug, flash] = view.document.querySelectorAll("button");
        const statusText = view.document.getElementById("statusText");
        const flashStatus = view.document.getElementById("flashStatus");
        function send(source, busy, text) {
            view.window.dispatchEvent(
                new view.window.MessageEvent("message", {
                    source,
                    data: { type: "mockDebugPending", busy, text }
                })
            );
        }
        send({}, true, "ignored");
        assert.equal(statusText.textContent, "", "foreign frames cannot update status");
        send(view.window.parent, true, "正在执行");
        assert.equal(flashStatus.dataset.state, "busy");
        assert.equal(statusText.textContent, "正在执行");
        assert.equal(debug.disabled, false, "primary buttons remain clickable during launch");
        assert.equal(flash.disabled, true, "pre-disabled actions remain disabled");
        send(view.window.parent, false, "");
        assert.equal(debug.disabled, false);
        assert.equal(flash.disabled, true);
        view.assertHealthy();
    } finally {
        view.close();
    }
}

function shellHtml() {
    const assets = {
        "csv.js": mockCsv.browserSource(),
        "rtt-formatter.js": mockRtt.browserSource(),
        "mcp-catalog.js": mockMcp.browserSource(),
        "i18n.js": "window.EmberProbeMockStrings = " + JSON.stringify(STRINGS) + ";"
    };
    return fs
        .readFileSync(path.join(mockup, "shell/index.html"), "utf8")
        .replace(/src="(?:sidebar|livewatch|rtt-panel)\.(?:zh|en)\.html"/g, 'src="about:blank"')
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
    // The shell simulates multi-second debug starts with page timers; drive them virtually.
    const clock = new FakeClock();
    const view = render(
        shellHtml(),
        {},
        {
            beforeParse(window) {
                window.setTimeout = (fn, ms, ...args) => clock.schedule(() => fn(...args), ms || 0);
                window.clearTimeout = clock.cancel;
            }
        }
    );
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
        assert.ok(doc.querySelector("#commandCenter .codicon-search"));
        assert.equal(doc.getElementById("sidebar-resizer").parentElement.id, "workbench-body");
        assert.equal(doc.getElementById("panel-resizer").parentElement.id, "main-column");
        assert.ok(doc.querySelector("#problemStatus .codicon-error"));
        assert.ok(doc.querySelector(".status-left #debugSessionStatus"));
        assert.ok(doc.querySelector("#debug-toolbar .codicon-debug-step-over"));
        assert.ok(doc.querySelector('[data-tab="livewatch"].active'));
        assert.equal(doc.getElementById("panel").classList.contains("collapsed"), false);
        assert.equal(doc.getElementById("workbench").classList.contains("nosidebar"), false);
        assert.equal(doc.getElementById("workbench").classList.contains("nopanel"), false);
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.equal(doc.getElementById("navigateBack").disabled, true);
        const initialFrame = doc.getElementById("livewatchFrame").contentWindow;
        doc.querySelector('[data-tab="main.c"]').click();
        doc.getElementById("navigateBack").click();
        assert.ok(doc.querySelector('[data-tab="livewatch"].active'));
        assert.equal(doc.getElementById("livewatchFrame").contentWindow, initialFrame);
        doc.getElementById("navigateForward").click();
        assert.ok(doc.querySelector('[data-tab="main.c"].active'));
        doc.getElementById("toggleSidebar").click();
        assert.equal(doc.getElementById("workbench").classList.contains("nosidebar"), true);
        assert.ok(doc.querySelector("#toggleSidebar .codicon-layout-sidebar-left-off"));
        doc.getElementById("toggleSidebar").click();
        assert.equal(doc.getElementById("workbench").classList.contains("nosidebar"), false);
        assert.ok(doc.querySelector("#toggleSidebar .codicon-layout-sidebar-left"));
        doc.getElementById("togglePanel").click();
        assert.equal(doc.getElementById("workbench").classList.contains("nopanel"), true);
        assert.ok(doc.querySelector("#togglePanel .codicon-layout-panel-off"));
        doc.getElementById("togglePanel").click();
        assert.equal(doc.getElementById("workbench").classList.contains("nopanel"), false);
        assert.ok(doc.querySelector("#togglePanel .codicon-layout-panel"));
        assert.ok(doc.querySelector("#toggleSecondarySidebar .codicon-layout-sidebar-right-off"));
        doc.getElementById("toggleSecondarySidebar").click();
        assert.equal(doc.getElementById("auxiliarybar").hidden, false);
        assert.ok(doc.querySelector("#toggleSecondarySidebar .codicon-layout-sidebar-right"));
        doc.getElementById("toggleSecondarySidebar").click();
        assert.equal(doc.getElementById("auxiliarybar").hidden, true);
        assert.ok(doc.querySelector("#toggleSecondarySidebar .codicon-layout-sidebar-right-off"));
        const frames = [doc.getElementById("sidebarFrame"), doc.getElementById("livewatchFrame")];
        const windows = frames.map((frame) => frame.contentWindow);
        const themeMessages = [[], []];
        frames.forEach((frame, index) => {
            frame.contentWindow.postMessage = (message) => themeMessages[index].push(message);
        });
        assert.equal(doc.documentElement.dataset.mockTheme, "light");
        assert.ok(doc.body.classList.contains("vscode-light"));
        doc.getElementById("manageButton").click();
        assert.equal(doc.getElementById("theme-menu").hidden, false);
        doc.getElementById("themeDark").click();
        assert.equal(doc.documentElement.dataset.mockTheme, "dark");
        assert.ok(doc.body.classList.contains("vscode-dark"));
        assert.equal(doc.getElementById("themeDark").getAttribute("aria-checked"), "true");
        assert.equal(doc.getElementById("theme-menu").hidden, true);
        for (let i = 0; i < frames.length; i++) {
            assert.equal(frames[i].contentWindow, windows[i], "theme changes preserve both hosts and frames");
            assert.equal(themeMessages[i].at(-1).theme, "dark");
        }
        doc.getElementById("themeLight").click();
        assert.equal(doc.documentElement.dataset.mockTheme, "light");
        assert.ok(doc.body.classList.contains("vscode-light"));
        doc.getElementById("debugStartButton").click();
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.equal(doc.getElementById("debugStartButton").disabled, true);
        await clock.advance(2600);
        assert.equal(doc.querySelector(".code-line.active-line").textContent.trim(), "HAL_Init();");
        assert.ok(doc.getElementById("debugSessionName").textContent.includes("EmberProbe"));
        doc.getElementById("dbgContinue").click();
        await clock.advance(500);
        assert.equal(
            doc.querySelector(".code-line.active-line"),
            null,
            "continue runs freely without preset breakpoints"
        );
        assert.ok(doc.getElementById("dbgContinue").querySelector(".codicon-debug-pause"));
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        assert.equal(doc.querySelector(".current-arrow"), null);
        doc.getElementById("dbgContinue").click();
        assert.equal(doc.getElementById("dbgContinue").disabled, true, "pause shows in-flight disable");
        await clock.advance(300);
        assert.equal(doc.getElementById("dbgContinue").disabled, false);
        assert.equal(doc.getElementById("dbgStepOver").disabled, false);
        assert.equal(doc.querySelector(".tab.active").dataset.tab, "tasks.c");
        assert.match(doc.querySelector(".code-line.active-line").textContent, /prvCheckTasksWaitingTermination/);
        doc.getElementById("dbgStepInto").click();
        assert.equal(doc.querySelector(".code-line.active-line"), null, "step clears active highlight while running");
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        await clock.advance(260);
        assert.match(doc.querySelector(".code-line.active-line").textContent, /BaseType_t deleted/);
        assert.match(doc.getElementById("debugCallStack").textContent, /prvCheckTasksWaitingTermination\(\)/);
        doc.getElementById("dbgStepOut").click();
        assert.equal(doc.getElementById("dbgStepOut").disabled, true);
        await clock.advance(260);
        assert.match(doc.querySelector(".code-line.active-line").textContent, /if \(listCURRENT_LIST_LENGTH/);
        doc.querySelector('[data-tab="main.c"]').click();
        doc.querySelector('.gutter-line[data-line="103"]').click();
        doc.getElementById("dbgContinue").click();
        await clock.advance(450);
        assert.equal(doc.querySelector(".code-line.active-line").dataset.line, "103", "continue hits user breakpoint");
        assert.equal(doc.getElementById("debugStartButton").disabled, false);
        const activeGlyph = doc.querySelector(".gutter-line.active .glyph-margin");
        assert.ok(activeGlyph.querySelector(".codicon-debug-stackframe"));
        assert.ok(activeGlyph.querySelector(".breakpoint.codicon-debug-stackframe-dot"));
        doc.getElementById("dbgStepInto").click();
        await clock.advance(260);
        assert.equal(doc.querySelector(".tab.active").dataset.tab, "pid.c", "step into crosses into pid.c");
        assert.match(doc.querySelector(".code-line.active-line").textContent, /float error = setpoint - measured/);
        doc.getElementById("dbgStepOut").click();
        await clock.advance(260);
        assert.equal(doc.querySelector(".tab.active").dataset.tab, "main.c", "step out returns to ControlTask");
        assert.ok(Number(doc.querySelector(".code-line.active-line").dataset.line) > 103);
        doc.getElementById("dbgRestart").click();
        await clock.advance(350);
        assert.equal(doc.querySelector(".code-line.active-line").textContent.trim(), "HAL_Init();");
        doc.querySelector('[data-tab="FreeRTOSConfig.h"]').click();
        assert.ok(doc.getElementById("code").textContent.includes("configUSE_PREEMPTION"));
        assert.ok(!doc.getElementById("code").textContent.includes("pid_update"));
        assert.ok(doc.getElementById("breadcrumbs").textContent.includes("Core›Inc›FreeRTOSConfig.h"));
        assert.equal(doc.querySelector(".code-line.active-line"), null);
        doc.querySelector('.gutter-line[data-line="4"]').click();
        assert.ok(doc.querySelector('.gutter-line[data-line="4"] .breakpoint'));
        assert.ok(doc.getElementById("debugBreakpoints").textContent.includes("FreeRTOSConfig.h:4"));
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
        hostMessage("sidebarFrame", { type: "executeCommand", cmd: "mcu-vscode.openLiveWatch" });
        assert.ok(doc.querySelector('[data-tab="livewatch-2"].active'));
        assert.ok(doc.querySelector('[data-pane="livewatch-2"].active #livewatchFrame-2'));
        doc.querySelector('[data-close="livewatch-2"]').click();
        assert.ok(doc.getElementById("livewatchFrame"), "closing a chart preserves the original frame");
        while (doc.querySelector("[data-close]")) doc.querySelector("[data-close]").click();
        assert.equal(doc.querySelector(".editor-pane.active"), null, "closing all tabs leaves an empty editor");
        assert.equal(
            doc.getElementById("debug-toolbar").classList.contains("hidden"),
            false,
            "closing all tabs keeps the debug toolbar visible while debugging"
        );
        doc.getElementById("dbgStop").click();
        assert.equal(doc.getElementById("dbgStop").disabled, true, "stop waits briefly for teardown");
        assert.equal(doc.getElementById("debug-toolbar").classList.contains("hidden"), false);
        await clock.advance(400);
        assert.equal(doc.getElementById("debug-toolbar").classList.contains("hidden"), true);
        doc.getElementById("debugStartButton").click();
        doc.getElementById("debugStartButton").click();
        assert.equal(doc.querySelector(".editor-pane.active"), null, "waiting leaves the current editor unchanged");
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F5", shiftKey: true, bubbles: true }));
        await clock.advance(2300);
        assert.equal(doc.querySelector(".editor-pane.active"), null, "cancellation preserves the current editor");
        doc.getElementById("debugStartButton").click();
        await clock.advance(2600);
        assert.ok(doc.querySelector('[data-tab="main.c"].active'));
        view.assertHealthy();
    } finally {
        view.close();
    }
}

async function testDefaultFlashAndDebug() {
    const clock = new FakeClock();
    const workbench = render(
        shellHtml(),
        {},
        {
            url: "https://example.test/",
            beforeParse(window) {
                window.setTimeout = (fn, ms, ...args) => clock.schedule(() => fn(...args), ms || 0);
                window.clearTimeout = clock.cancel;
            }
        }
    );
    const sidebar = render(getModernWebviewContent(configuration.defaults, "zh"));
    const doc = workbench.document;
    const sideFrame = doc.getElementById("sidebarFrame").contentWindow;
    const chartFrame = doc.getElementById("livewatchFrame").contentWindow;
    const sideMessages = [];
    const chartMessages = [];
    sideFrame.postMessage = (message) => {
        sideMessages.push(message);
        sidebar.send(message);
    };
    chartFrame.postMessage = (message) => chartMessages.push(message);
    const pumpSidebar = (() => {
        let index = 0;
        return () => {
            for (const message of sidebar.messages.slice(index))
                workbench.window.dispatchEvent(
                    new workbench.window.MessageEvent("message", {
                        source: sideFrame,
                        data: { __emberprobeMock: true, message }
                    })
                );
            index = sidebar.messages.length;
        };
    })();
    const click = (command) => {
        sidebar.document.querySelector(`[data-command="mcu-vscode.${command}"]`).click();
        pumpSidebar();
    };
    const activePane = () => doc.querySelector(".panel-pane.active").dataset.panelPane;
    const currentLine = () => doc.querySelector("#code .active-line");
    const assertStoppedAt = (file, line, text) => {
        assert.equal(doc.querySelector(".tab.active").dataset.tab, file);
        assert.equal(currentLine()?.dataset.line, String(line));
        assert.match(currentLine().textContent, text);
    };
    try {
        pumpSidebar();
        await clock.advance(600);
        assert.equal(doc.documentElement.dataset.mockTheme, "light");
        assert.ok(doc.querySelector(".status-left #debugSessionStatus.hidden"));
        assert.match(doc.getElementById("commandCenter").textContent, /EmberProbeDemo/);
        assert.match(
            sidebar.document.querySelector('[data-command="mcu-vscode.selectElf"] small').textContent,
            /EmberProbeDemo\.elf/
        );
        assert.equal(activePane(), "terminal");
        assert.equal(doc.getElementById("panel").classList.contains("collapsed"), false);
        assert.ok(doc.getElementById("terminalSessions").hidden);
        assert.match(doc.getElementById("terminalPrompt").textContent, /EmberProbeDemo/);
        assert.deepEqual(
            chartMessages.findLast((message) => message.type === "watchList").items.map((item) => item.name),
            liveData.watchList().map((item) => item.name)
        );

        sidebar.document.getElementById("mcuConfigSection").open = true;
        click("selectDebugger");
        [...doc.querySelectorAll("#quickInputList .quick-item")]
            .find((item) => item.textContent.includes("stlink.cfg"))
            .click();
        sidebar.document.getElementById("mcuConfigSection").open = false;
        click("download");
        assert.equal(sideMessages.findLast((message) => message.type === "commandError").cmd, "mcu-vscode.download");
        assert.match(sidebar.document.getElementById("noticeFlash").textContent, /固件下载失败.+未检测到调试器/s);
        assert.equal(sidebar.document.getElementById("mcuConfigSection").open, true);
        assert.equal(sidebar.document.getElementById("probeConfig").open, true);
        assert.ok(doc.getElementById("terminalSessions").hidden);
        [...sidebar.document.querySelectorAll("#connectedProbeList [data-device-id]")]
            .find((item) => item.textContent.includes("CMSIS-DAP"))
            .click();
        pumpSidebar();
        assert.match(sidebar.document.getElementById("mcuConfigSummary").textContent, /STM32F4x · CMSIS-DAP/);
        assert.match(sidebar.document.getElementById("noticeFlash").textContent, /固件下载失败/);

        click("download");
        assert.ok(doc.getElementById("terminalSessions").hidden);
        assert.equal(
            [...sidebar.document.querySelectorAll(".primary-actions button")].every((button) => !button.disabled),
            true,
            "primary actions stay enabled while flashing"
        );
        await clock.advance(580);
        assert.equal(sideMessages.findLast((message) => message.type === "notice").notice.key, "run.flashClock");
        assert.equal(doc.querySelector('[data-terminal-session="flash"]').getAttribute("aria-pressed"), "true");
        assert.match(doc.getElementById("terminalBody").textContent, /CMSIS-DAPv2[\s\S]*202008431041543838597586/);
        assert.equal(doc.querySelector(".tab.active").dataset.tab, "livewatch");
        await clock.advance(3200 - 580);
        const flashText = doc.getElementById("terminalBody").textContent;
        assert.match(
            flashText,
            /EmberProbeDemo\.elf[\s\S]*烧录时钟 10000 kHz[\s\S]*固件校验通过[\s\S]*正在复位目标芯片[\s\S]*固件下载并校验成功[\s\S]*STM32F40x[\s\S]*目标 stm32f4x\.cfg · 探针配置 cmsis-dap\.cfg/
        );
        assert.doesNotMatch(
            flashText,
            /耗时|已写入|已校验|KiB\/s|正在启动 OpenOCD|EP_FLASH_STAGE=|interface\/|target\//
        );
        doc.querySelector('[data-terminal-session="shell"]').click();
        assert.equal(doc.getElementById("terminalPrompt").hidden, false);
        doc.querySelector('[data-terminal-session="flash"]').click();
        assert.equal(doc.getElementById("terminalBody").textContent, flashText);

        click("debug");
        assert.ok(sidebar.document.getElementById("noticeFlash").hidden);
        assert.equal(
            [...sidebar.document.querySelectorAll(".primary-actions button")].every((button) => !button.disabled),
            true,
            "primary actions stay enabled while debug launches"
        );
        await clock.advance(2199);
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.equal(doc.querySelector(".tab.active").dataset.tab, "livewatch");
        await clock.advance(1);
        assert.equal(activePane(), "debug-console");
        assert.ok(doc.querySelector('#sidebar-views [data-view="emberprobe"].active'));
        assert.equal(doc.querySelector(".status-left #debugSessionStatus").classList.contains("hidden"), false);
        assert.equal(doc.body.classList.contains("debugging"), true);
        assert.doesNotMatch(doc.getElementById("debugConsoleBody").textContent, /EmberProbe · 复位调试/);
        assert.match(doc.getElementById("debugConsoleBody").textContent, /halted due to debug-request/);
        assert.match(
            doc.getElementById("debugConsoleBody").textContent,
            /Note: automatically using hardware breakpoints for read-only addresses\./
        );
        assert.equal(currentLine(), null);
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        await clock.advance(320);
        assertStoppedAt("main.c", 156, /HAL_Init/);
        assert.match(
            doc.getElementById("debugConsoleBody").textContent,
            /Temporary breakpoint 1, main \(\).*main\.c:156/
        );
        assert.equal(doc.getElementById("terminalBody").textContent, flashText, "debug logs use a separate panel");

        doc.getElementById("dbgContinue").click();
        await clock.advance(1200);
        assert.equal(currentLine(), null, "continuing runs freely without preset breakpoints");
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        doc.getElementById("dbgContinue").click();
        assert.equal(doc.getElementById("dbgContinue").disabled, true);
        await clock.advance(300);
        assertStoppedAt("tasks.c", 24, /prvCheckTasksWaitingTermination/);
        assert.match(doc.getElementById("debugCallStack").textContent, /prvIdleTask\(\).*tasks\.c:24/);
        assert.match(doc.getElementById("debugConsoleBody").textContent, /SIGINT[\s\S]*tasks\.c:24/);
        doc.getElementById("dbgStepInto").click();
        assert.equal(currentLine(), null);
        await clock.advance(260);
        assertStoppedAt("tasks.c", 11, /BaseType_t deleted/);
        doc.getElementById("dbgStepOut").click();
        assert.equal(currentLine(), null);
        await clock.advance(260);
        assertStoppedAt("tasks.c", 25, /if \(listCURRENT_LIST_LENGTH/);
        doc.getElementById("dbgRestart").click();
        assert.equal(currentLine(), null);
        await clock.advance(350);
        assertStoppedAt("main.c", 156, /HAL_Init/);
        doc.getElementById("dbgStop").click();
        assert.equal(doc.getElementById("dbgStop").disabled, true);
        await clock.advance(400);
        assert.equal(currentLine(), null);
        assert.equal(activePane(), "debug-console");

        click("attachDebug");
        await clock.advance(1520);
        assertStoppedAt("tasks.c", 24, /prvCheckTasksWaitingTermination/);
        assert.ok(doc.querySelector("#dbgStop .codicon-debug-disconnect"));
        assert.doesNotMatch(doc.getElementById("debugConsoleBody").textContent, /Temporary breakpoint/);
        doc.getElementById("dbgContinue").click();
        doc.getElementById("dbgContinue").click();
        await clock.advance(300);
        assertStoppedAt("tasks.c", 24, /prvCheckTasksWaitingTermination/);
        doc.getElementById("dbgStop").click();
        await clock.advance(400);
        assert.equal(currentLine(), null);
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.ok(doc.querySelector(".status-left #debugSessionStatus.hidden"));
        workbench.assertHealthy();
        sidebar.assertHealthy();
    } finally {
        workbench.close();
        sidebar.close();
    }
}

async function testShellRttAndDataBreakpoints() {
    const clock = new FakeClock();
    const view = render(
        shellHtml(),
        {},
        {
            beforeParse(window) {
                window.TextEncoder = TextEncoder;
                window.TextDecoder = TextDecoder;
                window.setTimeout = (fn, ms, ...args) => clock.schedule(() => fn(...args), ms || 0);
                window.clearTimeout = clock.cancel;
                window.setInterval = (fn, ms) => {
                    const id = {};
                    const again = () => {
                        id.timer = clock.schedule(() => {
                            again();
                            fn();
                        }, ms);
                    };
                    again();
                    return id;
                };
                window.clearInterval = (id) => id && clock.cancel(id.timer);
            }
        }
    );
    const doc = view.document;
    const sent = [];
    doc.getElementById("sidebarFrame").contentWindow.postMessage = (message) => sent.push(message);
    const fromSidebar = (message) =>
        view.window.dispatchEvent(
            new view.window.MessageEvent("message", {
                source: doc.getElementById("sidebarFrame").contentWindow,
                data: { __emberprobeMock: true, message }
            })
        );
    const last = (type) => sent.findLast((message) => message.type === type);
    try {
        // The channel picker is VS Code's multi-select quick pick.
        fromSidebar({ type: "executeCommand", cmd: "mcu-vscode.rttSelectChannels" });
        assert.equal(doc.getElementById("quick-input").classList.contains("hidden"), false);
        assert.equal(doc.getElementById("quickInputTitle").textContent, STRINGS.zh["rtt.channelsTitle"]);
        assert.equal(doc.querySelectorAll("#quickInputList .quick-item").length, 2);
        assert.equal(doc.querySelector("#quickInputList .quick-item input").checked, true);
        doc.getElementById("quickInputText").dispatchEvent(
            new view.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        assert.ok(doc.getElementById("quick-input").classList.contains("hidden"));
        assert.equal(last("commandSuccess").cmd, "mcu-vscode.rttSelectChannels");

        // The RTT tab appears with the first start and comes to the front.
        assert.equal(doc.getElementById("rttPanelTab").hidden, true);
        fromSidebar({ type: "executeCommand", cmd: "mcu-vscode.startRtt" });
        await clock.advance(500);
        assert.equal(doc.getElementById("rttPanelTab").hidden, false);
        assert.ok(doc.querySelector('[data-panel-pane="rtt"]').classList.contains("active"));
        assert.equal(doc.getElementById("rttClear").hidden, false);
        doc.querySelector('[data-panel="terminal"]').click();
        assert.equal(doc.getElementById("rttClear").hidden, true);
        fromSidebar({ type: "executeCommand", cmd: "mcu-vscode.stopRtt" });
        assert.equal(doc.getElementById("rttPanelTab").hidden, false, "the tab stays once shown");

        // Sidebar and native breakpoints are managed independently.
        doc.getElementById("debugStartButton").click();
        await clock.advance(2600);
        const status = last("sidebarDataBreakpoints");
        assert.equal(status.paused, true);
        const request = (body) =>
            fromSidebar({
                type: "sidebarDataBreakpoint",
                sessionId: status.sessionId,
                epoch: status.epoch,
                generation: last("sidebarDataBreakpoints").generation,
                requestId: sent.length + 1,
                ...body
            });
        request({ action: "info", name: "g_motor_rpm" });
        request({
            action: "add",
            name: "g_motor_rpm",
            dataId: last("sidebarDataBreakpoints").info.dataId,
            accessType: "write"
        });
        assert.equal(doc.querySelector("#debugBreakpoints .data-breakpoint-row"), null);
        doc.querySelector('#debugVariables [data-var-path="g_motor_rpm"]').dispatchEvent(
            new view.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })
        );
        doc.querySelector("#quickInputList .quick-item").click();
        const row = doc.querySelector('#debugBreakpoints [data-breakpoint-group="native"]');
        assert.ok(row.textContent.includes("g_motor_rpm"));
        assert.ok(row.textContent.includes(STRINGS.zh["sb.dataWrite"]));
        assert.ok(row.querySelector(".codicon-debug-breakpoint-data"));
        row.click();
        assert.ok(doc.querySelector("#debugBreakpoints .data-breakpoint-row.disabled"));
        assert.equal(last("sidebarDataBreakpoints").entries[0].enabled, true);

        // The condition editor is VS Code's input box, validated as the extension does.
        request({ action: "condition", id: last("sidebarDataBreakpoints").entries[0].id });
        assert.equal(doc.getElementById("quickInputText").placeholder, STRINGS.zh["sb.dataConditionPrompt"]);
        doc.getElementById("quickInputText").value = "g_motor_rpm > 0";
        doc.getElementById("quickInputOk").click();
        assert.equal(last("sidebarDataBreakpoints").entries[0].condition, "g_motor_rpm > 0");
        assert.ok(!doc.querySelector("#debugBreakpoints .data-breakpoint-row").textContent.includes("> 0"));

        // Continuing runs into it: the debug console says so and the target stops.
        for (const line of [...doc.querySelectorAll(".gutter-line .breakpoint")]) line.closest(".gutter-line").click();
        doc.getElementById("dbgContinue").click();
        await clock.advance(700);
        assert.ok(doc.getElementById("debugConsoleBody").textContent.includes("数据断点命中: g_motor_rpm"));
        assert.ok(doc.getElementById("dbgContinue").querySelector(".codicon-debug-continue"));
        doc.getElementById("dbgStop").click();
        await clock.advance(400);
        assert.equal(doc.querySelector("#debugBreakpoints .data-breakpoint-row"), null, "the session's rows go");
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
        location: { search: "" },
        localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
        addEventListener: (type, handler) => listeners.set(type, handler)
    };
    try {
        vm.runInNewContext(fs.readFileSync(path.join(mockup, "mock/theme.js"), "utf8"), {
            window: root,
            URLSearchParams,
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
    const view = render(liveWatchView.getLiveWatchContent({}, "zh"));
    try {
        view.send({ type: "watchList", items: liveData.watchList() });
        view.send({ type: "chartValues", samples: [{ name: "g_sensor_temp", value: 36.4, t: 1000 }] });
        view.document.getElementById("freeze").click();
        const request = view.messages.findLast((message) => message.type === "chartFreeze");
        view.send({
            type: "chartFreezeResult",
            requestId: request.requestId,
            historyRevision: request.historyRevision,
            snapshotId: 7,
            revision: 1,
            bounds: { min: 1000, max: 1000 }
        });
        assert.equal(view.window.eval("state").frozen, true);
        view.window.eval("state").dirty = false;
        view.document.body.classList.add("vscode-light");
        await Promise.resolve();
        assert.equal(view.window.eval("state").dirty, true, "changing themes repaints a frozen canvas");
        assert.equal(view.window.eval("state").frozen, true);
        assert.equal(view.window.eval("state").remoteHistory.snapshotId, 7, "theme changes keep the frozen snapshot");
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
    scenario("website language and theme parameters are optional and validated", () => {
        for (const [query, lang, theme] of [
            ["", "zh-CN", "light"],
            ["?lang=en&theme=light", "en", "light"],
            ["?lang=invalid&theme=invalid", "zh-CN", "light"],
            ["?theme=dark", "zh-CN", "dark"]
        ]) {
            const view = render(shellHtml(), {}, { url: "https://example.test/" + query });
            try {
                assert.equal(view.document.documentElement.lang, lang);
                assert.equal(view.document.documentElement.dataset.mockTheme, theme);
                if (lang === "en") {
                    assert.ok(view.document.getElementById("sidebarFrame").src.endsWith("sidebar.en.html"));
                    assert.ok(view.document.getElementById("livewatchFrame").src.endsWith("livewatch.en.html"));
                }
                assert.equal(view.window.localStorage.getItem("emberprobe.mock.theme"), null);
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
    });
    testSimulatorAndRegisters();
    testMockUnlimitedPreset();
    testHostsAndRenderer();
    testCompositeImportAndMembers();
    testConfigurationAndSvdCancellation();
    testMcpConnectivityScenarios();
    testDebugCoreSelection();
    await testWatchOriginatedWrites();
    testTypeShowcase();
    testArchive();
    testReadableArchiveHeaders();
    testIndependentChartHistory();
    testSamplingFollowsDebugSession();
    testResetStopsBeforeFirmwareRuns();
    testDownloadRun();
    testDebugLatency();
    testDebugBusyBridge();
    testRttWithRenderers();
    testRttRawModeAndLog();
    await testDataBreakpointsWithRenderer();
    await testShell();
    await scenario(
        "the default demo uses the selected probe and separates flashing, reset debug and attach lifecycles",
        testDefaultFlashAndDebug
    );
    await testShellRttAndDataBreakpoints();
    testThemeBridge();
    await testFrozenChartTheme();
    await testServer();
    console.log("Mockup regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
