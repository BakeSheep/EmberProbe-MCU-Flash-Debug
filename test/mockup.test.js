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
    for (const file of ["text.js", "sidebar-host.js", "livewatch-host.js", "rtt-panel-host.js"])
        vm.runInContext(fs.readFileSync(path.join(mockup, "mock", file), "utf8"), context, { filename: file });
    function frame(onSend) {
        const messages = [];
        return {
            messages,
            contentWindow: {
                // The real page provides collectLeaves; composite curves are not charted by these host checks.
                collectLeaves: () => [],
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
    const host = env.root.EmberProbeLiveWatchHost.create(frame, {});
    try {
        env.deliver(frame, { type: "ready" });
        assert.deepStrictEqual(latest(frame, "liveUnlimited"), { type: "liveUnlimited", enabled: false });
        env.deliver(frame, { type: "setUnlimitedSampling", enabled: true });
        assert.strictEqual(latest(frame, "liveUnlimited").enabled, true);
        env.deliver(frame, { type: "setUnlimitedSampling", enabled: false });
        assert.strictEqual(latest(frame, "liveUnlimited").enabled, false);
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

// Values made inside the hosts' vm context, compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Delivers what a real page posted since the last call to its mock host.
function pump(env, frame, view, from) {
    const start = from.at;
    from.at = view.messages.length;
    for (const message of view.messages.slice(start)) env.deliver(frame, message);
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
            doc.querySelector(".data-breakpoint-head-meta").textContent.includes(STRINGS.zh["sb.dataNoSession"]),
            "outside a debug session the menu says why it is empty"
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
        assert.equal(hit.name, "g_motor_rpm");
        assert.equal(hit.accessType, "write");
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
        const names = ["g_app_state", "g_active_sensor", "g_on_fault", "g_pending", "g_motor"];
        env.deliver(sidebar, { type: "saveSidebarWatch", items: names.map((name) => sidebarData.watchItem(name)) });
        env.deliver(sidebar, { type: "initCheck" });
        env.deliver(sidebar, { type: "liveToggle" });
        env.advance(600);
        const text = view.document.getElementById("liveValues").textContent;
        for (const expected of [".Active / .Ready(3)", "&g_sensors[1]", "fault_handler()", "NULL", '"left-wheel"'])
            assert.ok(text.includes(expected), expected);
        assert.match(text, /已隐藏 \d+ 个内部成员/);
        view.assertHealthy();
    } finally {
        host.destroy();
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
        assert.equal(info.firstTimestampMs, first + 200);
        env.deliver(frame, { type: "exportCsv", names: ["g_motor_rpm"], fromMs: first, toMs: first + 100 });
        assert.equal(latest(frame, "exportCsvResult").ok, false, "an empty time range does not report success");
        env.deliver(frame, { type: "stop" });
        env.advance(200);
        env.deliver(frame, { type: "samplingArchiveInfo" });
        assert.equal(latest(frame, "samplingArchiveInfo").lastTimestampMs, first + 400);
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
        env.advance(2199);
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
        env.advance(1559);
        assert.equal(flash().at(-1).notice.key, "run.flash");
        env.advance(1);
        assert.equal(flash().at(-1).notice.message, "开始写入固件");
        env.advance(6200);
        assert.equal(flash().at(-1).notice.params.bytes, 917504);
        env.advance(1340);
        const done = flash().at(-1).notice;
        assert.deepEqual([done.level, done.key], ["success", "msg.downloadSuccess"]);
        assert.ok(flash().every((message) => message.notice.level !== "error"));
        assert.equal(latest(frame, "commandSuccess").cmd, "mcu-vscode.download");
        const log = notices.filter((event) => event.action === "flashLog").flatMap((event) => event.lines);
        assert.equal(log[0].text, "EmberProbe 固件下载");
        assert.ok(log.some((line) => line.text === "→ 目标电压 3.30 V"));
        assert.ok(log.some((line) => line.text === "✓ 固件校验通过"));
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

function shellHtml() {
    const assets = {
        "csv.js": mockCsv.browserSource(),
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
        assert.ok(doc.querySelector("#problemStatus .codicon-error"));
        assert.ok(doc.querySelector("#debug-toolbar .codicon-debug-step-over"));
        assert.ok(doc.querySelector('[data-tab="livewatch"].active'));
        assert.ok(doc.getElementById("panel").classList.contains("collapsed"));
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
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
        doc.getElementById("debugStartButton").click();
        assert.ok(doc.getElementById("debug-toolbar").classList.contains("hidden"));
        assert.equal(doc.getElementById("debugStartButton").disabled, true);
        await clock.advance(2300);
        assert.equal(doc.querySelector(".code-line.active-line").textContent.trim(), "HAL_Init();");
        assert.ok(doc.getElementById("debugSessionName").textContent.includes("EmberProbe"));
        doc.getElementById("dbgContinue").click();
        await clock.advance(450);
        assert.equal(doc.querySelector(".code-line.active-line").dataset.line, "103", "continue hits the breakpoint");
        assert.equal(doc.getElementById("debugStartButton").disabled, false);
        const activeGlyph = doc.querySelector(".gutter-line.active .glyph-margin");
        assert.ok(activeGlyph.querySelector(".codicon-debug-stackframe"));
        assert.ok(activeGlyph.querySelector(".breakpoint.codicon-debug-stackframe-dot"));
        doc.querySelector('.gutter-line[data-line="103"]').click();
        doc.getElementById("dbgContinue").click();
        assert.ok(doc.getElementById("dbgContinue").querySelector(".codicon-debug-pause"));
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        assert.equal(doc.querySelector(".current-arrow"), null);
        doc.getElementById("dbgContinue").click();
        assert.equal(doc.getElementById("dbgStepOver").disabled, false);
        doc.querySelector('.gutter-line[data-line="103"]').click();
        const initialLine = Number(doc.querySelector(".code-line.active-line").dataset.line);
        doc.getElementById("dbgStepOver").click();
        const second = Number(doc.querySelector(".code-line.active-line").dataset.line);
        assert.ok(second > initialLine, "stepping advances despite host state notification");
        doc.getElementById("dbgStepInto").click();
        assert.ok(Number(doc.querySelector(".code-line.active-line").dataset.line) > second);
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
        while (doc.querySelector("[data-close]")) doc.querySelector("[data-close]").click();
        assert.equal(doc.querySelector(".editor-pane.active"), null, "closing all tabs leaves an empty editor");
        doc.getElementById("debugStartButton").click();
        doc.getElementById("debugStartButton").click();
        assert.equal(doc.querySelector(".editor-pane.active"), null, "waiting leaves the current editor unchanged");
        doc.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F5", shiftKey: true, bubbles: true }));
        await clock.advance(2300);
        assert.equal(doc.querySelector(".editor-pane.active"), null, "cancellation preserves the current editor");
        doc.getElementById("debugStartButton").click();
        await clock.advance(2300);
        assert.ok(doc.querySelector('[data-tab="main.c"].active'));
        view.assertHealthy();
    } finally {
        view.close();
    }
}

async function testShellRttAndDataBreakpoints() {
    const clock = new FakeClock();
    const view = render(
        shellHtml(),
        {},
        {
            beforeParse(window) {
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

        // A sidebar data breakpoint is listed in the Breakpoints view; its checkbox toggles it.
        doc.getElementById("debugStartButton").click();
        await clock.advance(2300);
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
        const row = doc.querySelector("#debugBreakpoints .data-breakpoint-row");
        assert.ok(row.textContent.includes("g_motor_rpm"));
        assert.ok(row.textContent.includes(STRINGS.zh["sb.dataWrite"]));
        assert.ok(row.querySelector(".codicon-debug-breakpoint-data"));
        row.click();
        assert.ok(doc.querySelector("#debugBreakpoints .data-breakpoint-row.disabled"));
        assert.equal(last("sidebarDataBreakpoints").entries[0].enabled, false);
        doc.querySelector("#debugBreakpoints .data-breakpoint-row").click();

        // The condition editor is VS Code's input box, validated as the extension does.
        request({ action: "condition", id: last("sidebarDataBreakpoints").entries[0].id });
        assert.equal(doc.getElementById("quickInputText").placeholder, STRINGS.zh["sb.dataConditionPrompt"]);
        doc.getElementById("quickInputText").value = "g_motor_rpm > 2500";
        doc.getElementById("quickInputOk").click();
        assert.equal(last("sidebarDataBreakpoints").entries[0].condition, "g_motor_rpm > 2500");
        assert.ok(doc.querySelector("#debugBreakpoints .data-breakpoint-row").textContent.includes("> 2500"));

        // Continuing runs into it: the debug console says so and the target stops.
        for (const line of [...doc.querySelectorAll(".gutter-line .breakpoint")]) line.closest(".gutter-line").click();
        doc.getElementById("dbgContinue").click();
        await clock.advance(700);
        assert.ok(doc.getElementById("debugConsoleBody").textContent.includes("数据断点命中: g_motor_rpm"));
        assert.ok(doc.getElementById("dbgContinue").querySelector(".codicon-debug-continue"));
        doc.getElementById("dbgStop").click();
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
            ["", "zh-CN", "dark"],
            ["?lang=en&theme=light", "en", "light"],
            ["?lang=invalid&theme=invalid", "zh-CN", "dark"]
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
    testTypeShowcase();
    testArchive();
    testReadableArchiveHeaders();
    testSamplingFollowsDebugSession();
    testResetStopsBeforeFirmwareRuns();
    testDownloadRun();
    testDebugLatency();
    testDebugBusyBridge();
    testRttWithRenderers();
    await testDataBreakpointsWithRenderer();
    await testShell();
    await testShellRttAndDataBreakpoints();
    testThemeBridge();
    await testFrozenChartTheme();
    await testServer();
    console.log("Mockup regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
