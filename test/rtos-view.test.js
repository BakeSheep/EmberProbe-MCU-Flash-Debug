"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { RtosViewService } = require("../src/services/rtosViewService");
const { create } = require("../src/webview/sidebar/rtos");

(async () => {
    let resolveRead,
        calls = 0;
    const session = {
        id: "native",
        type: "emberprobe",
        customRequest: async (command, args) => {
            assert.strictEqual(command, "emberprobe.rtosSnapshot");
            assert.strictEqual(args.includeStackUsage, true, "default refresh includes stack usage");
            calls++;
            return new Promise((resolve) => {
                resolveRead = resolve;
            });
        }
    };
    const bridge = {
        activeSession: session,
        paused: true,
        stopEpoch: 1,
        transitionKind: "",
        assertUniqueSession: () => bridge.activeSession,
        agentStatus: () => ({ session, epoch: bridge.stopEpoch, state: bridge.paused ? "paused" : "running" })
    };
    const service = new RtosViewService(bridge);
    const first = service.refresh(),
        second = service.refresh();
    assert.strictEqual(calls, 1);
    resolveRead({ body: { tasks: [] } });
    assert.strictEqual((await first).stopEpoch, 1);
    await second;
    const stale = service.refresh();
    bridge.stopEpoch++;
    resolveRead({ tasks: [] });
    await assert.rejects(stale, /Stale/);
    bridge.paused = false;
    await assert.rejects(service.refresh(), /Pause/);
    bridge.paused = true;
    session.type = "cortex-debug";
    await assert.rejects(service.refresh(), /native/);
    assert.strictEqual(service.status().supported, false);

    const dom = new JSDOM(
        '<details id="rtosSection"><select id="rtosSession" hidden></select><table><tbody id="rtosTasks"></tbody></table><input id="rtosFilter"><select id="rtosSort"><option value="name">Name</option><option value="priority">Priority</option></select><button id="rtosRefresh"></button></details>'
    );
    global.document = dom.window.document;
    const sent = [];
    const uiState = {};
    const view = create({
        api: { postMessage: (message) => sent.push(message), setState: () => {} },
        t: (key) => key,
        uiState
    });
    const status = { state: "paused", sessionId: "native", stopEpoch: 1, supported: true };
    view.onDebug(status);
    assert.strictEqual(sent.length, 0, "collapsed panel does no target reads");
    const section = document.getElementById("rtosSection");
    section.open = true;
    section.dispatchEvent(new dom.window.Event("toggle"));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].includeStackUsage, true, "automatic refresh scans task stacks");
    view.onDebug(status);
    assert.strictEqual(sent.length, 1, "one automatic refresh per stop");
    const snapshot = {
        ...status,
        tasks: [
            { name: "<script>bad()</script>", state: "running", priority: 1, tcbAddress: "0x20000000", stack: {} },
            {
                name: "Worker",
                state: "ready",
                priority: 3,
                tcbAddress: "0x20000100",
                stack: { fillEstimate: { complete: true, usedPercent: 37.5 } }
            }
        ]
    };
    view.onSnapshot(snapshot);
    assert.strictEqual(document.querySelectorAll("tbody tr").length, 2);
    assert.strictEqual(document.querySelector("tbody tr").children.length, 5, "details disclosure is included");
    assert.strictEqual(document.querySelectorAll("tbody tr")[1].lastChild.textContent, "37.5%");
    assert.strictEqual(document.querySelectorAll("script").length, 0, "task names are text");
    document.querySelector(".rtos-task-row td:nth-child(2)").click();
    assert.strictEqual(document.querySelectorAll(".rtos-task-details").length, 1, "clicking a name expands details");
    const items = document.querySelectorAll(".rtos-detail-item");
    assert.ok(items.length > 1);
    for (const item of items) {
        assert.strictEqual(item.children.length, 2, "each detail groups its label and value for internal separators");
        assert.strictEqual(item.firstChild.tagName, "DT");
        assert.strictEqual(item.lastChild.tagName, "DD");
    }
    document.querySelector(".rtos-disclosure").click();
    assert.strictEqual(document.querySelectorAll(".rtos-task-details").length, 0, "triangle toggles once via the row");
    document.querySelector(".rtos-task-row td:last-child").click();
    assert.strictEqual(document.querySelectorAll(".rtos-task-details").length, 1, "stack cell also expands details");
    document.querySelector(".rtos-task-details dd").click();
    assert.strictEqual(
        document.querySelectorAll(".rtos-task-details").length,
        1,
        "detail data stays open when clicked"
    );
    document.querySelector(".rtos-task-row").click();
    assert.strictEqual(document.querySelectorAll(".rtos-task-details").length, 0);
    for (const kernelState of ["not-started", "no-tasks"]) {
        view.onSnapshot({ ...status, kernel: { state: kernelState }, tasks: [], partial: false });
        assert.strictEqual(document.getElementById("rtosStatus"), null, "no status description below the filter");
        assert.strictEqual(document.querySelectorAll("tbody tr").length, 0);
    }
    view.onSnapshot({ ...snapshot, partial: true, diagnostics: ["corrupt list"], kernel: { state: "running" } });
    assert(document.getElementById("rtosTasks").title.includes("corrupt list"));
    view.onSnapshot(snapshot);
    document.getElementById("rtosFilter").value = "worker";
    document.getElementById("rtosFilter").dispatchEvent(new dom.window.Event("input"));
    assert.strictEqual(document.querySelectorAll("tbody tr").length, 1);
    assert(document.querySelector("tbody").textContent.includes("37.5%"));
    view.onDebug({ ...status, state: "running", stopEpoch: 2 });
    assert.strictEqual(document.querySelectorAll("tbody tr").length, 1, "running retains the snapshot");
    assert(document.getElementById("rtosRefresh").disabled);
    view.onSnapshot({ ...snapshot, tasks: [] });
    assert.strictEqual(view.state.snapshot, snapshot, "late replies cannot overwrite a retained snapshot");
    view.onDebug({ ...status, stopEpoch: 3 });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].includeStackUsage, true, "a new stop refreshes stack usage automatically");
    view.onError({ ...status, stopEpoch: 3, message: "partial read failed" });
    assert(document.getElementById("rtosRefresh").title.includes("partial read failed"));
    document.getElementById("rtosRefresh").click();
    assert.strictEqual(sent.length, 3, "manual refresh can retry the same stop");
    assert.strictEqual(sent[2].includeStackUsage, true);
    view.onDebug({ state: "none", sessionId: "", stopEpoch: 4, supported: false });
    assert.strictEqual(view.state.snapshot, snapshot, "ending debug retains the last snapshot");
    assert.strictEqual(document.querySelectorAll("tbody tr").length, 1);
    assert(document.getElementById("rtosRefresh").disabled);
    const retainedState = JSON.parse(JSON.stringify(uiState));
    const sessions = [
        { id: "native", name: "<script>name()</script>", serverGroup: "dual", targetProcessor: 0 },
        { id: "second", name: "CPU 1", serverGroup: "dual", targetProcessor: 1 }
    ];
    view.onDebug({ ...status, stopEpoch: 3, sessions });
    const picker = document.getElementById("rtosSession");
    assert(!picker.hidden);
    assert.strictEqual(picker.options.length, 3);
    assert.strictEqual(picker.value, "native");
    assert.strictEqual(document.querySelectorAll("script").length, 0);
    picker.value = "second";
    picker.dispatchEvent(new dom.window.Event("change"));
    assert.deepStrictEqual(sent.at(-1), { type: "debugSelectSession", sessionId: "second" });
    view.onDebug({ ...status, sessionId: "second", stopEpoch: 4, sessions });
    assert.strictEqual(view.state.snapshot, null, "switching core clears the old task table");
    view.onSnapshot({ ...snapshot, stopEpoch: 3 });
    assert.strictEqual(view.state.snapshot, null, "another core's late result is ignored");
    view.onDebug({ ...status, sessionId: "second", stopEpoch: 4, sessions: sessions.slice(1) });
    assert(picker.hidden);
    const restored = create({
        api: { postMessage: () => {}, setState: () => {} },
        t: (key) => key,
        uiState: retainedState
    });
    restored.onDebug({ state: "none", sessionId: "", stopEpoch: 0, supported: false });
    assert.deepStrictEqual(restored.state.snapshot, snapshot, "recreated webviews restore the final snapshot");
    delete global.document;
    dom.window.close();
    console.log("RTOS view pause policy, request coalescing, stale snapshots, filtering and text safety passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
