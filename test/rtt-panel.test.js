"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { render } = require("./helpers/render-webview");
const { createScreen, styleClasses } = require("../src/webview/rttPanel/ansi");
const { getRttPanelContent } = require("../src/rttPanelView");
const { RttPanelHost, CONTEXT_KEY, CONTAINER_COMMAND } = require("../src/services/rttPanelHost");
const { RTT_PANEL_ROUTES, createRttPanelHandler } = require("../src/controllers/rttPanelRoutes");
const { MAX_WRITE_BYTES } = require("../src/services/rttTerminalService");

const textOf = (screen) => screen.text();

function runningStatus(overrides = {}) {
    return {
        type: "rttPanelStatus",
        state: "running",
        inputMode: "line",
        history: {},
        channels: [{ index: 0, name: "Terminal", active: true, hasInput: true }],
        ...overrides
    };
}

(async () => {
    await scenario("the screen keeps text, CR overwrites and erases in line", () => {
        const screen = createScreen();
        screen.write("hello\r\nwor");
        screen.write("ld\r\n");
        assert.strictEqual(textOf(screen), "hello\nworld\n");
        screen.write("progress 10%\rprogress 100%\r\n");
        assert.strictEqual(screen.text().split("\n")[2], "progress 100%");
        screen.write("abcdef\r\x1b[2Kxy\r\n");
        assert.strictEqual(screen.text().split("\n")[3], "xy");
        screen.write("abcdef\x1b[3G\x1b[K\r\n");
        assert.strictEqual(screen.text().split("\n")[4], "ab");
        screen.write("abcdef\x1b[4G\x1b[1K\r\n");
        assert.strictEqual(screen.text().split("\n")[5], "    ef");
        screen.write("ab\bc\tz\r\n");
        assert.strictEqual(screen.text().split("\n")[6], "ac      z");
    });

    await scenario("SGR styles group into segments and map to classes", () => {
        const screen = createScreen();
        screen.write("\x1b[1;31mred\x1b[0m plain \x1b[92;44mgreen\x1b[39;49m\x1b[2;3;4mx\x1b[22;23;24m\r\n");
        const runs = screen.segments(0);
        assert.deepStrictEqual(
            runs.map((run) => run.text),
            ["red", " plain ", "green", "x"]
        );
        assert.deepStrictEqual(styleClasses(runs[0].style).classes, ["fg-1", "bold"]);
        assert.deepStrictEqual(styleClasses(runs[1].style), { classes: [], inline: {} });
        assert.deepStrictEqual(styleClasses(runs[2].style).classes, ["fg-10", "bg-4"]);
        assert.deepStrictEqual(styleClasses(runs[3].style).classes, ["dim", "italic", "underline"]);
        screen.write("\x1b[38;5;196ma\x1b[48;2;1;2;3mb\x1b[38;5;3mc\x1b[7md\x1b[27;0m\x1b[7me\x1b[m\r\n");
        const extended = screen.segments(1).map((run) => styleClasses(run.style));
        assert.deepStrictEqual(extended[0].inline, { color: "rgb(255, 0, 0)" });
        assert.deepStrictEqual(extended[1].inline, { color: "rgb(255, 0, 0)", backgroundColor: "rgb(1, 2, 3)" });
        assert.deepStrictEqual(extended[2].classes, ["fg-3"]);
        assert.deepStrictEqual(
            extended[3],
            { classes: ["bg-3"], inline: { color: "rgb(1, 2, 3)" } },
            "inverse swaps the colors"
        );
        assert.deepStrictEqual(extended[4].classes, ["fg-inverse", "bg-inverse"]);
        screen.write("\x1b[38;5;240mg\x1b[38;9mh\x1b[0m\r\n");
        const grey = screen.segments(2).map((run) => styleClasses(run.style));
        assert.deepStrictEqual(grey[0].inline, { color: "rgb(88, 88, 88)" });
        assert.deepStrictEqual(grey[1], { classes: [], inline: {} }, "an unknown color form resets it");
    });

    await scenario("escape sequences split across writes are joined and others are dropped", () => {
        const screen = createScreen();
        screen.write("a\x1b[3");
        screen.write("1mb\x1b");
        screen.write("[0m\x1b]0;title\x07c\x1b]2;t\x1b\\d\x1b7e\x1b[2J\x1b[Hf\r\n");
        assert.strictEqual(screen.text(), "abcdef\n");
        assert.deepStrictEqual(styleClasses(screen.segments(0)[1].style).classes, ["fg-1"]);
        screen.write("\x1b[" + "1;".repeat(80));
        screen.write("g\r\n");
        assert.ok(screen.text().endsWith("g\n"), "a runaway sequence is dropped, not held forever");
        screen.write("\x1b]unterminated\x1b");
        screen.write("\\h😀\r\n");
        assert.ok(screen.text().endsWith("h😀\n"));
    });

    await scenario("the screen drops its oldest rows past the line limit and reports what changed", () => {
        const screen = createScreen({ maxLines: 3 });
        assert.deepStrictEqual(screen.write("1\n2\n"), { dropped: 0, from: 0 });
        assert.deepStrictEqual(screen.write("3\n4"), { dropped: 1, from: 1 });
        assert.strictEqual(screen.text(), "2\n3\n4");
        assert.strictEqual(screen.droppedTotal, 1);
        assert.deepStrictEqual(screen.write("5"), { dropped: 0, from: 2 });
        screen.clear();
        assert.strictEqual(screen.text(), "");
    });

    await scenario("the panel page lists channels, shows output and sends lines", () => {
        const view = render(getRttPanelContent("en"));
        try {
            const doc = view.document;
            assert.deepStrictEqual(view.messages[0], { type: "ready" });
            const input = doc.getElementById("input");
            assert.strictEqual(input.disabled, true);
            assert.match(input.placeholder, /RTT is running/);
            assert.strictEqual(doc.getElementById("empty").hidden, false);
            view.send({
                ...runningStatus({ history: { 0: ["first", "second"] } }),
                type: "rttPanelSnapshot",
                channels: [
                    { index: 0, name: "Terminal", active: true, hasInput: true, text: "boot\r\n\x1b[31mred\x1b[0m\r\n" }
                ]
            });
            assert.strictEqual(doc.getElementById("tabs").hidden, true, "one channel needs no tabs");
            assert.strictEqual(doc.getElementById("empty").hidden, true);
            const rows = [...doc.querySelectorAll("#lines .line")].map((row) => row.textContent);
            assert.deepStrictEqual(rows, ["boot", "red", ""]);
            assert.strictEqual(doc.querySelector("#lines .fg-1").textContent, "red");
            view.send({ type: "rttOutput", channel: 0, text: "more\r\n" });
            assert.strictEqual(doc.querySelectorAll("#lines .line")[2].textContent, "more");
            view.send({ type: "rttOutput", channel: 9, text: "ignored" });
            view.send({ type: "rttOutput", channel: 0, text: 5 });

            assert.strictEqual(input.disabled, false);
            input.value = "hello";
            doc.getElementById("inputRow").dispatchEvent(new view.window.Event("submit", { cancelable: true }));
            assert.deepStrictEqual(view.messages.at(-1), { type: "rttSend", id: 1, channel: 0, text: "hello" });
            assert.strictEqual(input.disabled, true, "one line at a time");
            view.send({ type: "rttSendResult", id: 7, ok: true });
            assert.strictEqual(input.value, "hello", "a stale result is ignored");
            view.send({ type: "rttSendResult", id: 1, ok: false, message: "write failed" });
            assert.strictEqual(input.value, "hello", "a refused line stays in the box");
            assert.strictEqual(doc.getElementById("inputError").textContent, "write failed");
            input.dispatchEvent(new view.window.Event("input"));
            assert.strictEqual(doc.getElementById("inputError").hidden, true, "editing clears the error");
            const key = (name, extra = {}) =>
                input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: name, bubbles: true, ...extra }));
            key("ArrowUp");
            assert.strictEqual(input.value, "second");
            key("ArrowUp");
            key("ArrowUp");
            assert.strictEqual(input.value, "first");
            key("ArrowDown");
            key("ArrowDown");
            assert.strictEqual(input.value, "hello", "Down past the newest line restores the draft");
            key("ArrowDown");
            key("ArrowUp", { isComposing: true });
            assert.strictEqual(input.value, "hello", "arrows during IME composition belong to the IME");
            doc.getElementById("inputRow").dispatchEvent(new view.window.Event("submit", { cancelable: true }));
            view.send({ type: "rttSendResult", id: 2, ok: true });
            assert.strictEqual(input.value, "");
            view.send(runningStatus({ state: "stopped", channels: [{ index: 0, name: "Terminal", active: false }] }));
            assert.strictEqual(input.disabled, true);
            assert.match(input.placeholder, /RTT is running/);
            view.assertHealthy();
        } finally {
            view.close();
        }
    });

    await scenario("several channels get tabs, unread marks and their own screens", () => {
        const view = render(getRttPanelContent("zh"));
        try {
            const doc = view.document;
            const channels = [
                { index: 0, name: "Terminal", active: true, hasInput: true },
                { index: 2, name: "", active: true, hasInput: false }
            ];
            view.send(runningStatus({ channels }));
            const tabs = () => [...doc.querySelectorAll("#tabs .tab")];
            assert.strictEqual(doc.getElementById("tabs").hidden, false);
            assert.deepStrictEqual(
                tabs().map((tab) => tab.textContent),
                ["#0 Terminal", "#2"]
            );
            view.send({ type: "rttOutput", channel: 2, text: "log line\r\n" });
            assert.ok(tabs()[1].classList.contains("unread"));
            tabs()[1].click();
            assert.strictEqual(view.window.eval("state").selected, 2);
            assert.deepStrictEqual(view.getState(), { selected: 2 }, "the selection survives a page reload");
            assert.strictEqual(doc.querySelector("#lines .line").textContent, "log line");
            assert.ok(!tabs()[1].classList.contains("unread"));
            assert.strictEqual(doc.getElementById("input").disabled, true, "no down buffer, no input");
            assert.match(doc.getElementById("input").placeholder, /down/);
            view.send({ type: "rttOutput", channel: 0, text: "a\r\n" });
            view.send({ type: "rttOutput", channel: 0, text: "b\r\n" });
            assert.ok(tabs()[0].classList.contains("unread"));
            view.send(runningStatus({ channels: [{ ...channels[0], active: false }] }));
            assert.strictEqual(view.window.eval("state").selected, 0, "a vanished channel hands the view over");
            assert.strictEqual(doc.getElementById("tabs").hidden, true);
            assert.deepStrictEqual(
                [...doc.querySelectorAll("#lines .line")].map((row) => row.textContent),
                ["a", "b", ""]
            );
            view.send({ type: "rttClearRequest" });
            assert.deepStrictEqual(view.messages.at(-1), { type: "rttClear", channel: 0 });
            assert.strictEqual(doc.querySelectorAll("#lines .line").length, 1);
            view.send(runningStatus({ channels: [] }));
            assert.strictEqual(doc.getElementById("empty").hidden, false);
            const count = view.messages.length;
            view.send({ type: "rttClearRequest" });
            assert.strictEqual(view.messages.length, count, "nothing to clear without a channel");
            view.assertHealthy();
        } finally {
            view.close();
        }
    });

    await scenario("raw mode sends keystrokes from the output area", () => {
        const view = render(getRttPanelContent("en"));
        try {
            const doc = view.document;
            view.send(runningStatus({ inputMode: "raw" }));
            const output = doc.getElementById("output");
            assert.strictEqual(doc.getElementById("inputRow").hidden, true);
            assert.strictEqual(doc.getElementById("rawHint").hidden, false);
            assert.strictEqual(output.tabIndex, 0);
            const press = (key, extra = {}) =>
                output.dispatchEvent(
                    new view.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })
                );
            const sent = () =>
                view.messages.filter((message) => message.type === "rttSendRaw").map((message) => message.data);
            press("a");
            press("Enter");
            press("Backspace");
            press("ArrowUp");
            press("c", { ctrlKey: true });
            press("Shift");
            press("F5");
            press("x", { altKey: true });
            press("ArrowLeft", { ctrlKey: true });
            press("b", { isComposing: true });
            press("中");
            output.dispatchEvent(new view.window.CompositionEvent("compositionend", { data: "你好" }));
            assert.deepStrictEqual(sent(), ["a", "\r", "\x7f", "\x1b[A", "\x03", "中", "你好"]);
            assert.deepStrictEqual(view.messages.at(-1), { type: "rttSendRaw", channel: 0, data: "你好" });
            view.send({ type: "rttInputProblem", channel: 0, message: "too long" });
            assert.strictEqual(doc.getElementById("inputError").textContent, "too long");
            view.send({ type: "rttInputProblem", channel: 3, message: "other" });
            assert.strictEqual(doc.getElementById("inputError").textContent, "too long");
            view.send(runningStatus({ inputMode: "line" }));
            press("z");
            assert.strictEqual(sent().length, 7, "line mode leaves keys in the output area alone");
            view.send(runningStatus({ state: "pending-host", inputMode: "raw" }));
            press("z");
            assert.strictEqual(sent().length, 7, "no raw input while RTT is paused");
            view.assertHealthy();
        } finally {
            view.close();
        }
    });

    await scenario("the host shows the tab once, reveals it and posts only to a ready page", async () => {
        const commands = [];
        const vscode = {
            commands: { executeCommand: async (...args) => commands.push(args) }
        };
        const renders = [];
        const host = {
            language: "en",
            _context: { extensionUri: "ext" },
            _webviewAssetRootUri: "assets",
            _renderWebview: (webview, html, scope) => renders.push({ webview, html, scope }),
            _rttTerminals: { panelSnapshot: () => ({ type: "rttPanelSnapshot", channels: [] }) }
        };
        const panel = new RttPanelHost(host, { vscode });
        await panel.ensureVisible();
        await panel.ensureVisible();
        assert.deepStrictEqual(commands, [["setContext", CONTEXT_KEY, true]]);
        await panel.reveal(true);
        assert.deepStrictEqual(commands.at(-1), [CONTAINER_COMMAND], "an unresolved view opens through its container");
        panel.post({ type: "rttOutput" }); // No view yet: dropped.
        panel.clear();
        panel.languageChanged();

        const posted = [];
        let listener = null;
        let disposeView = null;
        const shows = [];
        const view = {
            webview: {
                postMessage: async (message) => posted.push(message),
                onDidReceiveMessage: (handler) => {
                    listener = handler;
                    return { dispose: () => (listener = null) };
                }
            },
            show: (preserveFocus) => shows.push(preserveFocus),
            onDidDispose: (handler) => (disposeView = handler)
        };
        panel.resolveWebviewView(view);
        assert.deepStrictEqual(view.webview.options, { enableScripts: true, localResourceRoots: ["ext", "assets"] });
        assert.strictEqual(renders.at(-1).scope, "rttPanel");
        assert.match(renders.at(-1).html, /RTT Terminal/);
        panel.post({ type: "rttOutput", channel: 0, text: "early" });
        assert.deepStrictEqual(posted, [], "the page is not ready yet");
        await listener({ type: "ready" });
        await listener({ type: "unknown" });
        await listener(null);
        assert.deepStrictEqual(posted, [{ type: "rttPanelSnapshot", channels: [] }]);
        panel.post({ type: "rttOutput", channel: 0, text: "late" });
        panel.clear();
        assert.deepStrictEqual(posted.slice(1), [
            { type: "rttOutput", channel: 0, text: "late" },
            { type: "rttClearRequest" }
        ]);
        await panel.reveal(false);
        assert.deepStrictEqual(shows, [false]);
        host.language = "zh";
        panel.languageChanged();
        assert.match(renders.at(-1).html, /RTT 终端/);
        panel.post({ type: "rttOutput" });
        assert.strictEqual(posted.length, 3, "a page rebuilt in another language waits for its ready again");
        disposeView();
        assert.strictEqual(listener, null);
        panel.post({ type: "rttOutput" });
        assert.strictEqual(posted.length, 3);
    });

    await scenario("panel routes validate raw keys and clear requests", async () => {
        const raw = [];
        const cleared = [];
        const replies = [];
        const host = {
            _t: (key) => key,
            _rttTerminals: {
                sendRaw: (channel, data) => {
                    raw.push([channel, data]);
                    return data === "bad" ? { ok: false, message: "refused" } : { ok: true };
                },
                clearChannel: (channel) => cleared.push(channel)
            }
        };
        const handle = createRttPanelHandler(host, { _view: { webview: { postMessage: (m) => replies.push(m) } } }, {});
        await handle({ type: "rttSendRaw", channel: 0, data: "a" });
        await handle({ type: "rttSendRaw", channel: 0, data: "bad" });
        for (const invalid of [
            { channel: -1, data: "a" },
            { channel: 0, data: "" },
            { channel: 0, data: 3 },
            { channel: 0, data: "x".repeat(MAX_WRITE_BYTES + 1) }
        ])
            await handle({ type: "rttSendRaw", ...invalid });
        assert.deepStrictEqual(raw, [
            [0, "a"],
            [0, "bad"]
        ]);
        assert.deepStrictEqual(replies[0], { type: "rttInputProblem", channel: 0, message: "refused" });
        assert.strictEqual(replies.length, 5);
        assert.ok(replies.slice(1).every((reply) => reply.message === "rtt.input.invalid"));
        await handle({ type: "rttClear", channel: 2 });
        await handle({ type: "rttClear", channel: "2" });
        assert.deepStrictEqual(cleared, [2]);
        assert.deepStrictEqual(Object.keys(RTT_PANEL_ROUTES).sort(), ["ready", "rttClear", "rttSend", "rttSendRaw"]);
        // A view that is gone must not break a reply.
        await createRttPanelHandler(host, {}, {})({ type: "rttSendRaw", channel: 0, data: "bad" });
    });

    console.log("RTT panel tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
