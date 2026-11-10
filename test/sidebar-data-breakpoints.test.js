"use strict";

const assert = require("assert");
const { SidebarDataBreakpoints } = require("../src/services/sidebarDataBreakpoints");
const { SIDEBAR_ROUTES } = require("../src/controllers/sidebarRoutes");
const { scenario } = require("./helpers/scenario");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

function serviceFixture() {
    const calls = [],
        messages = [];
    const session = {
        id: "one",
        type: "emberprobe",
        async customRequest(command, args) {
            calls.push({ command, args });
            if (session.hook) await session.hook(args);
            return { entries: session.entries || [], generation: "[0,0]", info: { dataId: "storage" } };
        }
    };
    const bridge = {
        activeSession: session,
        paused: true,
        stopEpoch: 1,
        inspectionEpoch: 1,
        assertUniqueSession() {
            return this.activeSession;
        },
        assertPausedAccess() {
            assert(this.paused);
        },
        async control(action) {
            assert.strictEqual(action, "pause");
            this.paused = true;
            this.stopEpoch++;
        }
    };
    const host = {
        _t: (key) => key,
        _elfService: { generation: 1 },
        readElfSymbols: () => ({
            symbols: [
                { name: "counter", watchType: "u32", size: 4, address: 0x20000000 },
                { name: "large", isComposite: true, size: 24 }
            ]
        }),
        _webviewView: { webview: { postMessage: (message) => messages.push(message) } },
        _watchLists: { read: () => [{ name: "counter" }] }
    };
    const vscode = {
        window: {
            showInputBox: async (options) => {
                assert(options.validateInput("x".repeat(1025)));
                assert(options.validateInput("x\n"));
                assert.strictEqual(options.validateInput("counter > 1"), null);
                return vscode.input;
            }
        }
    };
    const service = new SidebarDataBreakpoints({ host, bridge, vscode });
    const request = (args) =>
        service.request({ sessionId: session.id, epoch: bridge.stopEpoch, requestId: 1, ...args });
    return { service, bridge, session, host, vscode, calls, messages, request };
}

(async () => {
    await scenario("sidebar service validates storage and pins the selected session and stop", async () => {
        const f = serviceFixture();
        await f.request({ action: "info", name: "counter", address: "0xdeadbeef" });
        assert.strictEqual(f.calls[0].args.name, "counter");
        assert.strictEqual(f.calls[0].args.address, undefined);
        await assert.rejects(f.request({ action: "info", name: "large" }), /dataUnsupported/);
        await assert.rejects(f.request({ action: "info", name: "counter()" }), /dataUnsupported/);
        await assert.rejects(f.request({ action: "allDelete" }), /dataUnsupported/);
        await assert.rejects(f.request({ action: "list", sessionId: "two" }), /dataStale/);
        await assert.rejects(f.request({ action: "list", epoch: 0 }), /dataStale/);
        f.bridge.replBusy = true;
        await assert.rejects(f.request({ action: "list" }), /dataNoSession/);
        f.bridge.replBusy = false;
        f.session.type = "cppdbg";
        await assert.rejects(f.request({ action: "list" }), /dataNoSession/);
    });
    await scenario("condition cancellation and state changes never send stale mutations", async () => {
        const f = serviceFixture();
        await f.request({ action: "condition", id: "1" });
        assert(f.messages.at(-1).cancelled);
        assert.strictEqual(f.calls.length, 0);
        f.vscode.input = "counter > 1";
        await f.request({ action: "condition", id: "1" });
        assert.strictEqual(f.calls.at(-1).args.condition, "counter > 1");
        f.vscode.window.showInputBox = async () => {
            f.bridge.stopEpoch++;
            return "true";
        };
        await assert.rejects(f.request({ action: "condition", id: "1" }), /dataStale/);
        const count = f.messages.length;
        f.session.hook = async () => {
            f.bridge.inspectionEpoch++;
        };
        await assert.rejects(f.request({ action: "info", name: "counter" }), /dataStale/);
        assert.strictEqual(f.messages.length, count);
        f.vscode.window.showInputBox = async () => {
            const order = f.calls.length;
            await f.request({ action: "list" });
            assert.strictEqual(f.calls.length, order + 1, "an open input box never blocks other requests");
            return "true";
        };
        f.session.hook = null;
        await f.request({ action: "condition", id: "1" });
    });
    await scenario("overlapping requests are queued in order instead of rejected", async () => {
        const f = serviceFixture();
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const order = [];
        f.session.hook = async (args) => {
            order.push(args.action);
            if (args.action === "info") await gate;
        };
        const info = f.request({ action: "info", name: "counter" });
        const list = f.request({ action: "list" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(order, ["info"], "the second request waits for the first");
        release();
        await Promise.all([info, list]);
        assert.deepStrictEqual(order, ["info", "list"]);
        f.session.hook = async () => {
            throw new Error("adapter failed");
        };
        await assert.rejects(f.request({ action: "list" }), /adapter failed/);
        f.session.hook = null;
        await f.request({ action: "list" });
    });
    await scenario("sidebar pause leaves the target paused; watch removal never pauses the target", async () => {
        const f = serviceFixture();
        f.bridge.paused = false;
        await f.request({ action: "pause" });
        assert(f.bridge.paused);
        assert.strictEqual(f.calls.length, 0);
        f.session.entries = [{ name: "counter" }];
        f.bridge.paused = false;
        f.bridge.control = async () => assert.fail("watch removal must not pause the target");
        await f.service.pruneWatchList([]);
        assert.strictEqual(f.bridge.paused, false);
        assert.deepStrictEqual(f.calls.at(-1).args.names, ["counter"]);
        assert.strictEqual(f.calls.at(-1).args.action, "removeNames");
        f.session.hook = async (args) => {
            if (args.action === "removeNames") throw new Error("delete denied");
        };
        await assert.rejects(f.service.pruneWatchList([]), /delete denied/);
        f.service.changed();
        assert(f.messages.at(-1).invalidated);
        const count = f.messages.length;
        f.service.adapterMessage(
            { id: "other" },
            { type: "event", event: "emberprobe.sidebarDataBreakpointsChanged", body: {} }
        );
        assert.strictEqual(f.messages.length, count);
        f.service.adapterMessage(f.session, {
            type: "event",
            event: "emberprobe.sidebarDataBreakpointsChanged",
            body: { entries: [] }
        });
        assert.strictEqual(f.messages.length, count + 1);
    });
    await scenario("failed watch cleanup restores the sidebar list and reports the failure", async () => {
        const posted = [];
        const host = {
            _saveWatchList: async () => {
                throw new Error("delete denied");
            },
            _syncSidebarTarget: () => posted.push("restored")
        };
        await SIDEBAR_ROUTES.saveSidebarWatch({ host, post: (message) => posted.push(message) }, { items: [] });
        assert.strictEqual(posted[0], "restored");
        assert.strictEqual(posted[1].type, "sidebarDataBreakpointError");
        await SIDEBAR_ROUTES.sidebarDataBreakpoint({ host, post: (message) => posted.push(message) }, {});
        assert.strictEqual(posted.at(-1).type, "sidebarDataBreakpointError");
    });
    await scenario("watch removal never pauses a newly selected session after a delayed list reply", async () => {
        const f = serviceFixture();
        f.bridge.paused = false;
        f.session.entries = [{ name: "counter" }];
        let pauses = 0;
        f.bridge.control = async () => {
            pauses++;
        };
        f.session.hook = async () => {
            f.bridge.activeSession = { id: "two", type: "emberprobe" };
        };
        await assert.rejects(f.service.pruneWatchList([]), /dataStale/);
        assert.strictEqual(pauses, 0);
        assert.strictEqual(f.calls.length, 1);
    });
    await scenario("variable menu handles paused creation, marks, keyboard navigation and stale replies", async () => {
        const view = render(getModernWebviewContent({}, "zh"));
        try {
            const status = {
                type: "sidebarDataBreakpoints",
                sessionId: "one",
                epoch: 1,
                available: true,
                paused: true,
                generation: "[0,0]",
                entries: []
            };
            view.send({ type: "sidebarWatchList", items: [{ name: "counter", type: "u32", address: 0x20000000 }] });
            // Rows are decorated by the list observer after each render.
            await Promise.resolve();
            view.send(status);
            const row = view.document.querySelector('[data-breakpoint-path="counter"]');
            const open = () =>
                row.dispatchEvent(
                    new view.window.MouseEvent("contextmenu", {
                        bubbles: true,
                        cancelable: true,
                        clientX: 9000,
                        clientY: 9000
                    })
                );
            open();
            const request = view.messages.at(-1);
            assert.strictEqual(request.action, "info");
            view.send({
                ...status,
                requestId: request.requestId,
                action: "info",
                info: {
                    dataId: "storage",
                    accessTypes: ["write", "read", "readWrite"]
                }
            });
            let menu = view.document.querySelector('[role="menu"]');
            assert(menu);
            assert.strictEqual(menu.querySelectorAll("button:not(:disabled)").length, 3);
            menu.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
            assert.strictEqual(view.document.activeElement.textContent, "读取时中断");
            view.document.activeElement.click();
            assert.strictEqual(view.messages.at(-1).accessType, "read");
            assert.strictEqual(view.document.querySelector('[role="menu"]'), null);
            const entry = {
                id: "1",
                name: "counter",
                accessType: "read",
                enabled: true,
                verified: true,
                dataId: "storage",
                condition: "",
                description: "0x20000000"
            };
            view.send({ ...status, entries: [entry] });
            assert(row.querySelector(".data-breakpoint-mark"));
            row.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
            const next = view.messages.at(-1);
            view.send({
                ...status,
                requestId: next.requestId,
                info: { dataId: "storage", accessTypes: ["read"] },
                entries: [entry]
            });
            menu = view.document.querySelector('[role="menu"]');
            assert([...menu.querySelectorAll("button")].some((button) => button.textContent === "编辑条件…"));
            assert.strictEqual(menu.querySelector(".data-breakpoint-note"), null);
            menu.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
            assert.strictEqual(view.document.activeElement.textContent, "删除数据断点");
            menu.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            assert.strictEqual(view.document.activeElement, row);
            open();
            const late = view.messages.at(-1);
            view.send({ ...status, sessionId: "two", epoch: 2, entries: [] });
            view.send({ ...status, requestId: late.requestId, info: { dataId: "old" } });
            assert.strictEqual(view.document.querySelector('[role="menu"]'), null);
            assert.strictEqual(row.querySelector(".data-breakpoint-mark"), null);
            view.assertHealthy();
        } finally {
            view.close();
        }
    });
    await scenario("variable menus display readable names while breakpoint requests keep raw paths", async () => {
        const view = render(getModernWebviewContent({}, "zh"));
        try {
            const root = "_ZN3app5g_pidE";
            view.send({
                type: "sidebarWatchList",
                items: [
                    { name: "_ZN3app7counterE", displayName: "app::counter", type: "u32" },
                    {
                        name: root,
                        displayName: "app::g_pid",
                        isComposite: true,
                        address: 0x20000000,
                        compositeLayout: {
                            kind: "class",
                            members: [{ name: "integral_", offset: 4, watchType: "f32" }]
                        }
                    },
                    { name: "counter", type: "u32" }
                ]
            });
            await Promise.resolve();
            const status = {
                type: "sidebarDataBreakpoints",
                sessionId: "one",
                epoch: 1,
                available: true,
                paused: false,
                entries: []
            };
            view.send(status);
            const member = view.document.querySelector(`[data-breakpoint-path="${root}.integral_"]`);
            member.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true }));
            const title = () => view.document.querySelector(".data-breakpoint-head-name").textContent;
            assert.strictEqual(title(), "app::g_pid.integral_");
            view.document.querySelector('[role="menu"] button').click();
            const pause = view.messages.at(-1);
            view.send({ ...status, epoch: 2, paused: true });
            view.send({ ...status, epoch: 2, paused: true, requestId: pause.requestId });
            const info = view.messages.at(-1);
            assert.strictEqual(info.action, "info");
            assert.strictEqual(info.name, root + ".integral_");
            assert.strictEqual(title(), "app::g_pid.integral_");
            view.send({
                ...status,
                epoch: 2,
                paused: true,
                requestId: info.requestId,
                info: { dataId: "storage", accessTypes: ["write"] }
            });
            assert.strictEqual(title(), "app::g_pid.integral_");
            view.document.querySelector('[role="menu"] button').click();
            assert.strictEqual(view.messages.at(-1).action, "add");
            assert.strictEqual(view.messages.at(-1).name, root + ".integral_");
            for (const [name, label] of [
                ["_ZN3app7counterE", "app::counter"],
                ["counter", "counter"]
            ]) {
                const row = view.document.querySelector(`[data-breakpoint-path="${name}"]`);
                row.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
                assert.strictEqual(title(), label);
                assert.strictEqual(view.messages.at(-1).name, name);
            }
            view.assertHealthy();
        } finally {
            view.close();
        }
    });
    await scenario("running menu pauses first, then queries storage; unsupported variables explain why", async () => {
        const view = render(getModernWebviewContent({}, "en"));
        try {
            const status = {
                type: "sidebarDataBreakpoints",
                sessionId: "one",
                epoch: 1,
                available: true,
                paused: false,
                entries: []
            };
            view.send({ type: "sidebarWatchList", items: [{ name: "counter", type: "u32" }] });
            await Promise.resolve();
            view.send(status);
            const row = view.document.querySelector('[data-breakpoint-path="counter"]');
            row.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true }));
            view.document.querySelector('[role="menu"] button').click();
            const pause = view.messages.at(-1);
            assert.strictEqual(pause.action, "pause");
            view.send({ ...status, epoch: 2, paused: true });
            view.send({ ...status, epoch: 2, paused: true, requestId: pause.requestId, action: "pause" });
            const info = view.messages.at(-1);
            assert.strictEqual(info.action, "info");
            view.send({
                type: "sidebarDataBreakpointError",
                requestId: info.requestId,
                message: "Unsupported storage"
            });
            assert(view.document.querySelector('[role="menu"]').textContent.includes("Unsupported storage"));
            view.document.body.dispatchEvent(new view.window.MouseEvent("pointerdown", { bubbles: true }));
            assert.strictEqual(view.document.querySelector('[role="menu"]'), null);
            view.send({ ...status, available: false, sessionId: null });
            row.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true }));
            assert(view.document.querySelector('[role="menu"]').textContent.includes("Select an available"));
        } finally {
            view.close();
        }
    });
    console.log("sidebar data breakpoint tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
