"use strict";

// Scene definitions for website/capture/record.js. `window` is the display size in CSS pixels. `steps` holds the
// start time of each numbered step on the page, so its length must match the step list in website/content.js.
// Operations use selectors, never visible text, so both languages run the same script.

const command = (name) => `[data-command="mcu-vscode.${name}"]`;

// The line the control loop stops at, with a breakpoint in mock/shell-data.js.
const BREAKPOINT_LINE = 103;
const gutterLine = (line) => `#gutter .gutter-line[data-line="${line}"]`;

// A panel on the page: only the sidebar is shown, wide enough to fill a cell of the tools grid. The phone version
// is a second pass at a narrower sidebar.
const PANEL = {
    window: { width: 900, height: 470, sidebar: 588 },
    crop: [48, 36, 588, 408],
    compact: { window: { width: 600, height: 470, sidebar: 420 }, crop: [48, 36, 420, 408] }
};

async function showFile(session, name) {
    await session.page.evaluate((file) => {
        const tabs = [...document.querySelectorAll(".tab")];
        tabs.find((tab) => tab.textContent.trim().startsWith(file)).click();
    }, name);
    await session.page.clock.runFor(300);
}

// Brings a section of the sidebar to the top of its panel.
async function scrollTo(session, id) {
    await session.sb.evaluate((target) => document.getElementById(target).scrollIntoView({ block: "start" }), id);
    await session.page.clock.runFor(100);
}

// The debugger start opens VS Code's Run and Debug view; the recordings stay on the EmberProbe panel.
async function backToEmberProbe(session) {
    await session.page.evaluate(() => {
        const items = [...document.querySelectorAll(".activity-item[data-view]")];
        items.find((item) => /ember|mcu/i.test(item.dataset.view)).click();
    });
    await session.page.clock.runFor(100);
}

const setValue = (selector, value) => (session) =>
    session.sb.evaluate(
        ([target, next]) => {
            const element = document.querySelector(target);
            element.value = next;
            element.dispatchEvent(new Event("change", { bubbles: true }));
        },
        [selector, value]
    );

const startSampling = (session) => session.sb.evaluate(() => document.getElementById("liveToggle").click());

const chartWindow = (session, seconds) =>
    session.lw.evaluate((value) => {
        const span = document.getElementById("timeWindow");
        span.value = value;
        span.dispatchEvent(new Event("change", { bubbles: true }));
    }, seconds);

const scenes = {
    // The homepage's first image: a still of the full editor without a cursor.
    hero: {
        still: true,
        window: { width: 1200, height: 660, sidebar: 320 },
        poster: 10,
        cursor: [760, 560],
        narrow: [652, 142, 548, 426],
        async prepare(session, { pump, openSections }) {
            await openSections(session, ["liveValuesSection"]);
            await session.lw.evaluate(() => {
                const span = document.getElementById("timeWindow");
                span.value = "10";
                span.dispatchEvent(new Event("change", { bubbles: true }));
                document.getElementById("run").click();
                document.getElementById("norm").click();
            });
            await session.sb.evaluate(() => document.getElementById("watchFold").click());
            await pump(session, 11000);
        },
        operations: [
            { at: 2.4, to: "#liveValuesSection input[type=range]", move: 0.7, press: true },
            { at: 3.4, to: "#liveValuesSection input[type=range]", point: [0.8, 0.5], move: 0.9, release: true }
        ]
    },
    config: {
        window: { width: 800, height: 560, sidebar: 440 },
        duration: 12,
        poster: 11,
        cursor: [640, 420],
        narrow: [48, 36, 440, 460],
        steps: [0, 2.6, 7.4],
        async prepare(session, { openSections }) {
            await openSections(session, ["mcuConfigSection", "probeConfig"]);
            await showFile(session, "main.c");
        },
        operations: [
            { at: 1.2, to: command("autoDetect"), move: 0.9, click: true },
            { at: 3.6, to: "#connectedProbeRefresh", move: 0.9, click: true },
            // After the notice has closed: it moves the list.
            { at: 6.4, to: "#connectedProbeList .probe-card:nth-child(2) .probe-card-main", move: 0.8, click: true },
            {
                at: 8.2,
                to: "#connectedProbeList .probe-card:nth-child(2) select",
                move: 0.9,
                run: setValue("#connectedProbeList .probe-card:nth-child(2) select", "winusb")
            }
        ]
    },
    flash: {
        window: { width: 800, height: 560, sidebar: 300 },
        duration: 9,
        poster: 7,
        cursor: [520, 300],
        narrow: [48, 30, 300, 300],
        steps: [0, 1.3, 2.8, 4.8],
        async prepare(session, { openSections }) {
            await openSections(session, ["flashDebugSection"]);
            await showFile(session, "main.c");
        },
        operations: [
            { at: 1.2, to: command("download"), move: 0.8, click: true },
            { at: 2.4, on: "page", to: "#terminalBody", point: [0.7, 0.8], move: 0.8 },
            // Every message is the real sequence; only the waits inside the write and the verify are skipped.
            { at: 3.6, skip: 4900 },
            { at: 4.6, skip: 300 }
        ]
    },
    debug: {
        window: { width: 800, height: 560, sidebar: 300 },
        duration: 15,
        poster: 8,
        cursor: [520, 420],
        narrow: [348, 36, 452, 460],
        steps: [0, 2, 5.4, 11],
        async prepare(session, { openSections }) {
            await openSections(session, ["flashDebugSection"]);
            await showFile(session, "main.c");
            await session.page.evaluate((line) => {
                document.querySelector(`#gutter .gutter-line[data-line="${line}"]`).click();
                document.querySelector(`#gutter .gutter-line[data-line="${line}"]`).scrollIntoView({ block: "center" });
            }, BREAKPOINT_LINE);
            await session.page.clock.runFor(100);
        },
        operations: [
            { at: 1.2, on: "page", to: gutterLine(BREAKPOINT_LINE), move: 0.9, click: true },
            // The firmware download and the GDB start are shortened; the stop at main() is real.
            { at: 2.8, to: command("debug"), move: 0.9, click: true },
            { at: 3.4, skip: 2300, run: backToEmberProbe },
            { at: 6, on: "page", to: "#dbgContinue", move: 0.9, click: true },
            { at: 7.8, on: "page", to: "#dbgStepOver", move: 0.8, click: true },
            { at: 9, on: "page", to: "#dbgStepOver", move: 0.3, click: true },
            { at: 10.6, on: "page", to: "#dbgStop", move: 0.8, click: true },
            { at: 11.8, to: command("attachDebug"), move: 0.8, click: true },
            { at: 12.4, skip: 2300, run: backToEmberProbe }
        ]
    },
    variables: {
        window: { width: 800, height: 560, sidebar: 460 },
        duration: 14,
        poster: 13,
        cursor: [660, 420],
        narrow: [48, 36, 460, 480],
        steps: [0, 3.4, 5.8, 7.8],
        async prepare(session, { openSections }) {
            await openSections(session, ["liveValuesSection", "variableBrowser"]);
            await showFile(session, "main.c");
            await scrollTo(session, "liveValuesSection");
            // A short list, with the variable this scene adds not on it yet.
            await session.sb.evaluate(() => {
                document.querySelector('.av-write[data-selection-name="g_target_rpm"]').click();
                document.querySelector('.av-watch[data-selection-name="g_bus_voltage"]').click();
                document.querySelector('.av-watch[data-selection-name="g_imu"]').click();
            });
            await session.page.clock.runFor(100);
        },
        operations: [
            { at: 1.4, to: "#varSearch", move: 0.9, click: true, type: "target" },
            { at: 4, to: '#availableVars .av-watch[data-selection-name="g_target_rpm"]', move: 0.8, click: true },
            { at: 5, to: '#availableVars .av-write[data-selection-name="g_target_rpm"]', move: 0.5, click: true },
            { at: 6.6, to: "#liveToggle", move: 0.8, click: true },
            {
                at: 8.6,
                to: '.write-row[data-reorder-key="g_target_rpm"] .write-input',
                move: 0.8,
                click: true,
                key: "Control+a",
                type: "2400"
            },
            { at: 9.6, key: "Enter" }
        ]
    },
    waveform: {
        window: { width: 1200, height: 640, sidebar: 300 },
        query: "&unlimited=1",
        // Moving curves across the whole frame: the default quality exceeds the size limit.
        crf: 32,
        duration: 16,
        poster: 5,
        cursor: [900, 520],
        narrow: [348, 36, 852, 560],
        steps: [0, 5, 6.6, 9.2],
        async prepare(session, { pump, openSections }) {
            await openSections(session, ["liveValuesSection"]);
            await chartWindow(session, "10");
            await session.lw.evaluate(() => {
                document.getElementById("run").click();
                document.getElementById("norm").click();
            });
            await pump(session, 11000);
        },
        operations: [
            { at: 1, on: "lw", to: "#frequencyToggle", move: 0.8, click: true },
            { at: 2.2, on: "lw", to: "#frequencyPreset", point: [0.1, 0.5], move: 0.7, press: true },
            { at: 3.2, on: "lw", to: "#frequencyPreset", point: [1, 0.5], move: 0.9, release: true },
            { at: 4.2, on: "lw", to: "#addName", move: 0.6, click: true },
            { at: 5.6, on: "lw", to: "#freeze", move: 0.9, click: true },
            { at: 7, on: "lw", to: "#chartFromRange", point: [0.37, 0.5], move: 0.8, press: true },
            { at: 8, on: "lw", to: "#chartFromRange", point: [0.12, 0.5], move: 0.9, release: true },
            { at: 9.6, on: "lw", to: "#export", move: 0.8, click: true },
            { at: 12.6, on: "lw", to: "#exportApply", move: 1, click: true }
        ]
    },
    sampling: {
        window: { width: 1200, height: 640, sidebar: 300 },
        // Moving curves across the whole frame: the default quality exceeds the size limit.
        crf: 32,
        duration: 16,
        poster: 8,
        cursor: [900, 520],
        narrow: [348, 36, 852, 560],
        steps: [0, 2.2, 10.4],
        async prepare(session, { pump, openSections }) {
            await openSections(session, ["flashDebugSection", "liveValuesSection"]);
            await chartWindow(session, "10");
            await session.lw.evaluate(() => {
                document.getElementById("run").click();
                document.getElementById("norm").click();
            });
            // Without the default breakpoint the target keeps running after Continue.
            await showFile(session, "main.c");
            await session.page.evaluate((line) => {
                document.querySelector(`#gutter .gutter-line[data-line="${line}"]`).click();
            }, BREAKPOINT_LINE);
            await session.page.evaluate(() => document.querySelectorAll(".tab")[2].click());
            await pump(session, 11000);
        },
        operations: [
            { at: 1.6, to: command("attachDebug"), move: 0.8, click: true },
            { at: 2.4, skip: 2300, run: backToEmberProbe },
            { at: 4.2, on: "page", to: "#dbgContinue", move: 0.9, click: true },
            { at: 5.4, on: "page", to: () => document.querySelectorAll(".tab")[2], move: 0.8, click: true },
            { at: 10.2, on: "page", to: "#dbgContinue", move: 0.9, click: true },
            { at: 12.4, on: "page", to: "#dbgStepOver", move: 0.7, click: true },
            { at: 14, on: "page", to: "#dbgStepOver", move: 0.3, click: true }
        ]
    },
    agent: {
        window: { width: 800, height: 560, sidebar: 440 },
        duration: 10,
        poster: 9,
        cursor: [640, 420],
        narrow: [48, 36, 440, 460],
        steps: [0, 3, 6.4],
        async prepare(session, { openSections }) {
            await openSections(session, ["agentConfigSection", "mcpClientsSection"]);
            await showFile(session, "main.c");
        },
        operations: [
            { at: 1.2, to: '[data-client="gemini"] .agent-install', move: 0.9, click: true },
            { at: 3.4, to: '[data-client="codex"] [data-action="upgrade"]', move: 0.8, click: true },
            { at: 6.8, to: "#agentFullAccess", move: 0.9 }
        ]
    },
    peripheral: {
        ...PANEL,
        duration: 9,
        poster: 8,
        cursor: [420, 380],
        steps: [0],
        async prepare(session, { openSections, pump }) {
            await openSections(session, ["peripheralSection"]);
            await startSampling(session);
            await pump(session, 800);
            await scrollTo(session, "peripheralSection");
        },
        operations: [
            {
                at: 1.2,
                to: () =>
                    [...document.querySelectorAll(".peripheral-name")].find((name) => name.textContent === "TIM2"),
                move: 0.9,
                click: true
            },
            {
                at: 4,
                to: () =>
                    [...document.querySelectorAll(".peripheral-register")]
                        .find((row) => /\bCR1\b/.test(row.textContent))
                        .querySelector(".peripheral-disclosure"),
                move: 0.8,
                click: true
            }
        ]
    },
    rtos: {
        ...PANEL,
        duration: 8,
        poster: 7,
        cursor: [420, 380],
        steps: [0],
        async prepare(session, { openSections }) {
            await session.sb.evaluate((target) => document.querySelector(target).click(), command("debug"));
            await session.page.clock.runFor(2300);
            await backToEmberProbe(session);
            await session.page.evaluate(() => document.getElementById("dbgContinue").click());
            await session.page.clock.runFor(600);
            await openSections(session, ["rtosSection"]);
            await scrollTo(session, "rtosSection");
        },
        operations: [
            { at: 1.4, to: "#rtosRefresh", move: 0.9, click: true },
            { at: 3.4, to: ".rtos-task-row:nth-child(2) td:nth-child(2)", move: 0.8, click: true }
        ]
    },
    memory: {
        ...PANEL,
        duration: 6,
        poster: 5,
        cursor: [420, 380],
        steps: [0],
        async prepare(session, { openSections }) {
            await openSections(session, ["memoryAnalysisSection"]);
            await scrollTo(session, "memoryAnalysisSection");
        },
        operations: [
            { at: 1.2, to: "#memoryRefresh", move: 0.9, click: true },
            { at: 3, to: ".memory-region:nth-of-type(2)", move: 0.8 },
            { at: 4.2, to: ".memory-region:nth-of-type(3)", move: 0.6 }
        ]
    },
    chip: {
        ...PANEL,
        duration: 7,
        poster: 6,
        cursor: [420, 380],
        steps: [0],
        async prepare(session, { openSections }) {
            await openSections(session, ["chipInfoSection"]);
            await scrollTo(session, "chipInfoSection");
        },
        operations: [
            { at: 1.2, to: "#chipRead", move: 0.9, click: true },
            { at: 3.4, to: "#chipMore summary", move: 0.8, click: true },
            { at: 4.8, run: (session) => scrollTo(session, "chipMore") }
        ]
    }
};

module.exports = { scenes };
