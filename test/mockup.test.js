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
    for (const file of ["sidebar-host.js", "livewatch-host.js"])
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

        env.deliver(sidebar, { type: "chipControl", action: "reset" });
        assert.equal(notices.at(-1).state, "running");
        env.deliver(sidebar, { type: "readChipInfo" });
        env.advance(700);
        assert.equal(latest(sidebar, "chipInfo").info.targetState, "running");
        env.deliver(sidebar, { type: "chipControl", action: "pause" });
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
        "csv.js": `window.EmberProbeMockCsv = { buildCsv: ${csvTools.buildCsv}, csvDataRowCount: ${csvTools.csvDataRowCount} };`
    };
    return fs
        .readFileSync(path.join(mockup, "shell/index.html"), "utf8")
        .replace(/src="(?:sidebar|livewatch)\.(?:zh|en)\.html"/g, 'src="about:blank"')
        .replace(/<script src="([^"]+)"><\/script>/g, (_match, name) => {
            const directory = name.startsWith("shell") ? "shell" : "mock";
            const source = assets[name] || fs.readFileSync(path.join(mockup, directory, name), "utf8");
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
        assert.ok(doc.getElementById("emberprobeStatus").textContent.includes("正在执行"));
        await new Promise((resolve) => view.window.setTimeout(resolve, 2300));
        assert.equal(doc.getElementById("debugStartButton").disabled, false);
        const activeGlyph = doc.querySelector(".gutter-line.active .glyph-margin");
        assert.ok(activeGlyph.querySelector(".codicon-debug-stackframe"));
        assert.ok(activeGlyph.querySelector(".breakpoint.codicon-debug-stackframe-dot"));
        doc.getElementById("dbgContinue").click();
        assert.ok(doc.getElementById("dbgContinue").querySelector(".codicon-debug-pause"));
        assert.equal(doc.getElementById("dbgStepOver").disabled, true);
        assert.equal(doc.querySelector(".current-arrow"), null);
        doc.getElementById("dbgContinue").click();
        assert.equal(doc.getElementById("dbgStepOver").disabled, false);
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
        await new Promise((resolve) => view.window.setTimeout(resolve, 2300));
        assert.equal(doc.querySelector(".editor-pane.active"), null, "cancellation preserves the current editor");
        doc.getElementById("debugStartButton").click();
        await new Promise((resolve) => view.window.setTimeout(resolve, 2300));
        assert.ok(doc.querySelector('[data-tab="main.c"].active'));
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
    testSimulatorAndRegisters();
    testHostsAndRenderer();
    testArchive();
    testReadableArchiveHeaders();
    testDebugLatency();
    testDebugBusyBridge();
    await testShell();
    testThemeBridge();
    await testFrozenChartTheme();
    await testServer();
    console.log("Mockup regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
