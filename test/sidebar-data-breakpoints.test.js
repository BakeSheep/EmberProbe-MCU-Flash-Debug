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
            Object.defineProperty(view.document.documentElement, "clientWidth", { value: 260 });
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
            let menu = view.document.querySelector('[role="menu"]');
            Object.defineProperty(menu, "offsetWidth", { value: 220 });
            view.send({
                ...status,
                requestId: request.requestId,
                action: "info",
                info: {
                    dataId: "storage",
                    accessTypes: ["write", "read", "readWrite"]
                }
            });
            assert(menu);
            assert.strictEqual(menu.style.left, "28px", "leave 12px before the page's scrollbar");
            assert.strictEqual(menu.style.getPropertyValue("--data-breakpoint-menu-width"), "244px");
            assert.strictEqual(menu.querySelectorAll('[role="menuitemradio"]').length, 3);
            assert.strictEqual(menu.querySelector(".data-breakpoint-choice svg"), null);
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
            assert.ok(!menu.textContent.includes("已设置"));
            const breakpointCard = menu.querySelector('[role="group"][aria-label="数据断点"]');
            const options = [...breakpointCard.querySelectorAll('[role="menuitemradio"]')];
            assert.deepStrictEqual(
                options.map((option) => option.getAttribute("aria-checked")),
                ["false", "true", "false"]
            );
            assert(options[1].querySelector(".data-breakpoint-choice svg"));
            assert.deepStrictEqual(
                options.map((option) => option.disabled),
                [true, false, true]
            );
            assert.deepStrictEqual(
                [...options[1].parentElement.querySelectorAll(".data-breakpoint-tool")].map(
                    (button) => button.textContent
                ),
                ["禁用数据断点", "编辑条件…", "删除数据断点"]
            );
            assert.strictEqual(menu.querySelectorAll(".data-breakpoint-tool").length, 3);
            assert.strictEqual(menu.querySelector(".data-breakpoint-note:not(.watch-write-note)"), null);
            menu.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
            assert.strictEqual(view.document.activeElement.textContent, "删除数据断点");
            menu.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            assert.strictEqual(view.document.activeElement, row);
            const openWith = (entry) => {
                open();
                view.send({
                    ...status,
                    requestId: view.messages.at(-1).requestId,
                    info: { dataId: "storage", accessTypes: ["read"] },
                    entries: [entry]
                });
                return view.document.querySelectorAll('[role="menuitemradio"]')[1];
            };
            openWith(entry).click();
            assert.strictEqual(view.messages.at(-1).action, "enable");
            assert.strictEqual(view.messages.at(-1).id, entry.id);
            assert.strictEqual(view.messages.at(-1).enabled, false);
            const unchecked = openWith({ ...entry, enabled: false, verified: false });
            assert.strictEqual(unchecked.getAttribute("aria-checked"), "false");
            unchecked.click();
            assert.strictEqual(view.messages.at(-1).action, "enable");
            assert.strictEqual(view.messages.at(-1).enabled, true);
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
    await scenario("disabled entries stay manageable beside their trigger and scrolling closes the menu", async () => {
        const view = render(getModernWebviewContent({}, "en"));
        try {
            const entry = {
                id: "1",
                name: "counter",
                accessType: "write",
                enabled: false,
                verified: false,
                dataId: "storage",
                condition: "counter > 5"
            };
            const status = {
                type: "sidebarDataBreakpoints",
                sessionId: "one",
                epoch: 1,
                available: true,
                paused: true,
                entries: [entry]
            };
            const info = { dataId: "storage", accessTypes: ["write", "read", "readWrite"] };
            view.send({ type: "sidebarWatchList", items: [{ name: "counter", type: "u32" }] });
            await Promise.resolve();
            view.send(status);
            const row = view.document.querySelector('[data-breakpoint-path="counter"]');
            const menu = () => view.document.querySelector(".data-breakpoint-menu");
            const open = () => {
                row.dispatchEvent(new view.window.MouseEvent("contextmenu", { bubbles: true }));
                return view.messages.at(-1).requestId;
            };
            view.send({ ...status, requestId: open(), info });
            const choice = menu().querySelector('[role="menuitemradio"]');
            assert.strictEqual(choice.getAttribute("aria-checked"), "false");
            assert.strictEqual(choice.querySelector(".data-breakpoint-choice svg"), null);
            assert.match(choice.parentElement.parentElement.textContent, /Disabled · counter > 5/);
            assert.strictEqual(choice.nextElementSibling.firstElementChild.textContent, "Enable Data Breakpoint");
            choice.nextElementSibling.firstElementChild.click();
            assert.deepStrictEqual(
                {
                    action: view.messages.at(-1).action,
                    id: view.messages.at(-1).id,
                    enabled: view.messages.at(-1).enabled
                },
                { action: "enable", id: "1", enabled: true }
            );
            for (const deltaY of [-75, 75]) {
                const requestId = open();
                const wheel = new view.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
                (deltaY < 0 ? menu() : row).dispatchEvent(wheel);
                assert.strictEqual(menu(), null);
                assert.strictEqual(wheel.defaultPrevented, false, "leave scrolling available");
                view.send({ ...status, requestId, info });
                assert.strictEqual(menu(), null, "a delayed storage lookup cannot reopen the menu");
            }
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
            view.document.querySelector('[role="menu"] button:not(.watch-write-action)').click();
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
            view.document.querySelector('[role="menu"] button:not(.watch-write-action)').click();
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
            view.document.querySelector('[role="menu"] button:not(.watch-write-action)').click();
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
            const cards = [...view.document.querySelectorAll('[role="menu"] > [role="group"]')];
            assert.deepStrictEqual(
                cards.map((card) => card.getAttribute("aria-label")),
                ["Write List", "Data Breakpoints"]
            );
            const writeAction = cards[0].querySelector(".watch-write-action");
            assert.strictEqual(cards[0].querySelector(".data-breakpoint-card-title"), null);
            assert.strictEqual(writeAction.disabled, true);
            assert.strictEqual(cards[0].querySelector(".watch-write-note").textContent, writeAction.title);
            assert.match(cards[1].querySelector(".data-breakpoint-note").textContent, /^Select an available/);
            assert.strictEqual(cards[1].querySelector(".watch-write-action, .watch-write-note"), null);
        } finally {
            view.close();
        }
    });
    console.log("sidebar data breakpoint tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
