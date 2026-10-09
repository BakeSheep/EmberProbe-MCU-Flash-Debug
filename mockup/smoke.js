/*
 * Smoke test for the generated mock: loads the real sidebar / live-watch
 * renderers in jsdom, feeds them the same messages as the mock hosts and
 * asserts that key UI regions render without script errors.
 *
 * Usage: node mockup/smoke.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const dist = path.join(__dirname, "dist");
const sidebarData = require("./mock/sidebar-data.js");
const liveWatchData = require("./mock/livewatch-data.js");

if (!fs.existsSync(path.join(dist, "index.html"))) {
    console.error("mockup/dist is missing. Run `node mockup/build.js` first.");
    process.exit(1);
}

const failures = [];
function check(label, condition) {
    if (condition) {
        console.log(`  ok  ${label}`);
    } else {
        failures.push(label);
        console.error(`FAIL  ${label}`);
    }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadPage(file, beforeParse) {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(`jsdomError: ${error.message}`));
    virtualConsole.on("error", (...args) => errors.push(`console.error: ${args.join(" ")}`));
    const dom = new JSDOM(fs.readFileSync(path.join(dist, file), "utf8"), {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        url: "file:///" + path.join(dist, file).replace(/\\/g, "/"),
        virtualConsole,
        beforeParse(window) {
            if (beforeParse) beforeParse(window);
        }
    });
    return { dom, errors };
}

function push(window, payload) {
    window.dispatchEvent(new window.MessageEvent("message", { data: payload }));
}

function fakeCanvas(window) {
    window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    if (!window.matchMedia)
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const makeContext = function () {
        const store = { canvas: this };
        const noop = () => {};
        return new Proxy(store, {
            get(target, prop) {
                if (prop === "measureText") return () => ({ width: 12 });
                if (prop === "createLinearGradient" || prop === "createRadialGradient")
                    return () => ({ addColorStop: noop });
                if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
                if (prop in target) return target[prop];
                return noop;
            },
            set(target, prop, value) {
                target[prop] = value;
                return true;
            }
        });
    };
    window.HTMLCanvasElement.prototype.getContext = makeContext;
}

async function testSidebar() {
    console.log("sidebar.zh.html");
    const { dom, errors } = loadPage("sidebar.zh.html");
    const { window } = dom;
    await sleep(120);

    const send = (message) => push(window, message);
    send({
        type: "backendStatus",
        backend: "openocd",
        state: "ready",
        key: "oc.readyVer",
        params: { version: "0.12.0" }
    });
    send({ type: "skillStatus", state: "installed", busy: false, scopes: { workspace: { state: "installed" } } });
    send({ type: "availableVariablesReset", version: sidebarData.VERSION, warnings: [] });
    send({ type: "availableVariablesChunk", version: sidebarData.VERSION, symbols: sidebarData.SYMBOLS });
    send({ type: "availableVariablesDone", version: sidebarData.VERSION, total: sidebarData.SYMBOLS.length });
    send({
        type: "availableVariableTypes",
        version: sidebarData.VERSION,
        symbols: sidebarData.SYMBOLS.map((symbol) => ({
            name: symbol.name,
            displayName: symbol.displayName,
            typeName: symbol.typeName,
            watchType: symbol.watchType,
            isComposite: symbol.isComposite,
            hasRuntimeLayout: false,
            hasDwarfWriteType: !!symbol.hasDwarfWriteType
        }))
    });
    send({ type: "availableTypesDone", version: sidebarData.VERSION });
    send({ type: "sidebarWatchList", items: sidebarData.sidebarWatchList(), resetValues: true });
    send({ type: "sidebarWriteList", items: sidebarData.sidebarWriteList() });
    send(sidebarData.memoryAnalysis());
    send({ type: "svdStatus", state: "configured", path: sidebarData.SVD_PATH, key: "svd.configured" });
    send({ type: "chipInfo", info: sidebarData.chipInfo().info });
    send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
    send(sidebarData.rtosDebugStatus("paused", 1));
    send({ type: "peripheralDebugStatus", state: "paused", epoch: 1, canRead: true, canWrite: true });
    send({
        type: "liveStatus",
        running: true,
        canRead: true,
        canWrite: true,
        source: "dap",
        snapshotReady: true,
        key: "sb.sampling"
    });
    await sleep(80);

    const doc = window.document;
    check("backend card hidden when ready", doc.getElementById("backendCard").hidden === true);
    check("skill toggle enabled", doc.getElementById("skillStatus").disabled === false);
    check("variable browser rows", doc.querySelectorAll("#availableVars .available-row").length >= 25);
    check("watch list rows", doc.querySelectorAll("#liveValues .value-row").length === 4);
    check("write list rows", doc.querySelectorAll("#writeValues .write-row").length === 2);
    check("memory summary", !!doc.querySelector("#memoryBody .memory-summary"));
    check("chip hero", !!doc.querySelector("#chipBody .chip-hero"));
    check("svd configured", (doc.getElementById("svdStatus") || {}).className === "svd-status ok");

    const t = Date.now();
    const simulator = sidebarData.createSimulator();
    simulator.tick();
    send({
        type: "liveSample",
        samples: simulator.scalarSamples(["g_sensor_temp", "g_motor_rpm", "g_bus_voltage"], t),
        t
    });
    const composite = simulator.compositeSample("g_imu", t);
    send({ type: "liveCompositeSample", samples: [composite], t });
    await sleep(200);
    const valueTexts = Array.from(doc.querySelectorAll("#liveValues .value-row")).map((row) => row.textContent);
    check(
        "live values updated",
        valueTexts.some((text) => /\d/.test(text) && !/—/.test(text))
    );

    send(sidebarData.peripheralCatalog());
    send(sidebarData.peripheralRegisters("GPIOA"));
    send(sidebarData.peripheralReadResult(["GPIOA.MODER", "GPIOA.IDR"], false));
    await sleep(60);
    check("peripheral groups rendered", doc.querySelectorAll("#peripheralTree .peripheral-group").length >= 5);

    send(sidebarData.rtosSnapshot(1));
    await sleep(40);
    check("rtos tasks rendered", doc.querySelectorAll("#rtosTasks .rtos-task-row").length === 6);

    check("no sidebar script errors", errors.length === 0);
    if (errors.length) console.error(errors.join("\n"));
    window.close();
}

async function testLiveWatch() {
    console.log("livewatch.zh.html");
    const { dom, errors } = loadPage("livewatch.zh.html", fakeCanvas);
    const { window } = dom;
    await sleep(150);

    const send = (message) => push(window, message);
    send({ type: "seriesStyles", styles: liveWatchData.seriesStyles });
    send({ type: "watchList", items: liveWatchData.watchList(), resetValues: true });
    send({ type: "variablesListReset", version: liveWatchData.VERSION, warnings: [] });
    send({ type: "variablesListChunk", version: liveWatchData.VERSION, symbols: liveWatchData.SYMBOLS });
    send({ type: "variablesListDone", version: liveWatchData.VERSION, total: liveWatchData.SYMBOLS.length });
    send({
        type: "variableTypes",
        version: liveWatchData.VERSION,
        symbols: liveWatchData.SYMBOLS.map((symbol) => ({
            name: symbol.name,
            typeName: symbol.typeName,
            watchType: symbol.watchType
        }))
    });
    send({ type: "variableTypesDone", version: liveWatchData.VERSION });
    send({ type: "liveFrequency", frequencyHz: 30, intervalMs: 33 });
    send({
        type: "liveStatus",
        running: true,
        canRead: true,
        canWrite: true,
        source: "dap",
        snapshotReady: true,
        key: "sb.sampling",
        actualHz: 30
    });
    send({
        type: "samplingArchiveInfo",
        rows: 100,
        variables: ["g_sensor_temp"],
        firstTimestampMs: Date.now() - 10000,
        lastTimestampMs: Date.now()
    });
    await sleep(80);

    const doc = window.document;
    check("watch cards rendered", doc.querySelectorAll("#vars .var-card").length === 3);
    check("run button shows stop", doc.getElementById("run").textContent.trim().length > 0);

    const simulator = sidebarData.createSimulator();
    for (let i = 0; i < 5; i++) {
        simulator.tick();
        send({
            type: "liveSample",
            samples: simulator.scalarSamples(["g_sensor_temp", "g_motor_rpm", "g_bus_voltage"], Date.now()),
            t: Date.now()
        });
        await sleep(30);
    }
    await sleep(200);
    check("value pane updated", doc.querySelectorAll("#vars .var-value").length === 3);
    check("no live-watch script errors", errors.length === 0);
    if (errors.length) console.error(errors.join("\n"));
    window.close();
}

function testShellAssets() {
    console.log("index.html assets");
    const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    const refs = [];
    const regex = /(?:src|href)="([^"]+)"/g;
    let match;
    while ((match = regex.exec(html))) if (!/^https?:/.test(match[1])) refs.push(match[1]);
    const missing = refs.filter((ref) => !fs.existsSync(path.join(dist, ref)));
    check(`all ${refs.length} shell asset references exist`, missing.length === 0);
    if (missing.length) console.error("missing:", missing.join(", "));
    check("shell references generated sidebar page", refs.includes("sidebar.zh.html"));
    check("shell references generated live-watch page", refs.includes("livewatch.zh.html"));
}

async function testShell() {
    console.log("index.html shell behaviour");
    const shellData = require("./shell/shell-data.js");
    let html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    html = html.replace(/src="(?:sidebar|livewatch)\.(?:zh|en)\.html"/g, 'src="about:blank"');
    html = html.replace(
        /<script src="([^"]+)"><\/script>/g,
        (match, src) => `<script>${fs.readFileSync(path.join(dist, src), "utf8")}</script>`
    );
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(`jsdomError: ${error.message}`));
    virtualConsole.on("error", (...args) => errors.push(`console.error: ${args.join(" ")}`));
    const dom = new JSDOM(html, {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        url: "file:///" + path.join(dist, "index.html").replace(/\\/g, "/"),
        virtualConsole
    });
    const { window } = dom;
    await sleep(900);

    const doc = window.document;
    const lineCount = shellData.FILES["main.c"].content.split("\n").length;
    check("editor lines rendered", doc.querySelectorAll("#code .code-line").length === lineCount);
    check("gutter lines rendered", doc.querySelectorAll("#gutter .gutter-line").length === lineCount);
    check("tabs rendered", doc.querySelectorAll(".tab").length === 4);
    check("waveform is initially active", !!doc.querySelector('[data-tab="livewatch"].active'));
    check("panel initially hidden", doc.getElementById("panel").classList.contains("collapsed"));
    check("no initial execution highlight", !doc.querySelector(".code-line.active-line"));
    check("breakpoint marker", !!doc.querySelector("#gutter .breakpoint"));
    check("debug toolbar initially hidden", doc.getElementById("debug-toolbar").classList.contains("hidden"));
    check("run and debug sidebar removed", !doc.querySelector('.view[data-view="debug"]'));
    check("no launch configuration placeholder", !doc.body.textContent.includes("launch.json"));
    check("no download output before an operation", doc.getElementById("terminalBody").textContent === "");
    check("problems rendered", doc.querySelectorAll("#problemsList .problem-row").length === 2);
    check("status bar shows connection", doc.getElementById("emberprobeStatus").textContent.includes("已连接"));

    doc.getElementById("commandCenter").click();
    await sleep(30);
    check("command palette opens", !doc.getElementById("command-palette").classList.contains("hidden"));
    check("palette lists commands", doc.querySelectorAll("#paletteList .palette-item").length >= 10);
    doc.getElementById("paletteInput").value = "实时";
    doc.getElementById("paletteInput").dispatchEvent(new window.Event("input"));
    await sleep(20);
    check("palette filters commands", doc.querySelectorAll("#paletteList .palette-item").length >= 1);
    doc.getElementById("command-palette").dispatchEvent(new window.Event("click", { bubbles: true }));

    doc.querySelector('.activity-item[data-view="explorer"]').click();
    await sleep(20);
    check(
        "sidebar stays on EmberProbe",
        doc.querySelector('.view[data-view="emberprobe"]').classList.contains("active")
    );
    check("other activity views are locked", doc.querySelector('.activity-item[data-view="debug"]').disabled);
    doc.querySelector('.activity-item[data-view="emberprobe"]').click();

    doc.getElementById("dbgStop").click();
    await sleep(20);
    check("stop hides debug toolbar", doc.getElementById("debug-toolbar").classList.contains("hidden"));
    const execute = (cmd) =>
        window.dispatchEvent(
            new window.MessageEvent("message", {
                source: doc.getElementById("sidebarFrame").contentWindow,
                data: { __emberprobeMock: true, message: { type: "executeCommand", cmd } }
            })
        );
    execute("mcu-vscode.debug");
    await sleep(20);
    check("debug waits before showing the toolbar", doc.getElementById("debug-toolbar").classList.contains("hidden"));
    check(
        "debug output follows startup",
        doc.getElementById("debugConsoleBody").textContent.includes("Reading symbols from")
    );
    execute("mcu-vscode.debug");
    await sleep(2300);
    check("start shows debug toolbar", !doc.getElementById("debug-toolbar").classList.contains("hidden"));
    check(
        "debug keeps EmberProbe visible",
        doc.querySelector('.view[data-view="emberprobe"]').classList.contains("active")
    );

    check("no shell script errors", errors.length === 0);
    if (errors.length) console.error(errors.join("\n"));
    window.close();
}

(async function main() {
    await testSidebar();
    await testLiveWatch();
    testShellAssets();
    await testShell();
    if (failures.length) {
        console.error(`\n${failures.length} check(s) failed.`);
        process.exit(1);
    }
    console.log("\nAll smoke checks passed.");
})();
