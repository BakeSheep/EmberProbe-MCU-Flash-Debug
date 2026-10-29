"use strict";
const assert = require("assert");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { WatchListStore } = require("../src/services/watchListStore");
const { t } = require("../src/i18n");

const one = [{ name: "only_in_one", type: "u32" }];
const two = [{ name: "only_in_two", type: "f32" }];
function fixture(saved) {
    const values = new Map(
        saved || [
            ["mcu.watchList", one],
            ["mcu.watchList.2", two]
        ]
    );
    const tabs = [];
    function panel(title, viewType = "mainThreadWebview-emberprobe.liveWatch") {
        let disposed;
        const p = {
            title,
            messages: [],
            onDidDispose(fn) {
                disposed = fn;
            },
            onDidChangeViewState() {},
            dispose() {
                tabs.splice(tabs.indexOf(tab), 1);
                disposed?.();
            }
        };
        p.webview = {
            postMessage: (m) => p.messages.push(structuredClone(m)),
            onDidReceiveMessage: (fn) => {
                p.receive = fn;
            }
        };
        const tab = {
            get label() {
                return p.title;
            },
            input: { viewType }
        };
        tabs.push(tab);
        return p;
    }
    const state = {
        get: (key) => values.get(key),
        keys: () => [...values.keys()],
        update: async (key, value) => {
            values.set(key, structuredClone(value));
        }
    };
    const vscode = {
        ViewColumn: { Active: 1 },
        workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
        window: {
            tabGroups: { all: [{ tabs }] },
            createWebviewPanel: (_, title) => panel(title)
        }
    };
    const P = loadProvider(vscode),
        host = Object.create(P.prototype);
    Object.assign(host, {
        _context: { workspaceState: state },
        _livePanels: new Map(),
        _livePanelFocusOrder: 0,
        _webviewAssetRootUri: { fsPath: path.join(os.tmpdir(), "panel-identity-" + randomUUID()) },
        _lang: "zh",
        _liveFrequencyHz: 10,
        _latestSidebarSamples: new Map(),
        _seriesStyleStore: { initialize: async () => {}, styles: {} },
        _invalidateConsumerTypes() {},
        _renderWebview(webview, html) {
            webview.html = html;
        },
        _configureChartHistory() {},
        _samplingStatus: () => ({ running: false }),
        readElfSymbols: () => ({ symbols: [] }),
        _refreshSamplingPlan: async () => {},
        _pruneSampleMap() {},
        _syncSidebarTarget() {},
        _chartBackgroundState: () => ({ type: "chartBackgroundIcon", icon: null }),
        chartBackground: () => ({ ready() {} }),
        _t: (key, params) => t("zh", key, params)
    });
    host._watchLists = new WatchListStore({
        state,
        normalize: (items) => items,
        symbols: () => [],
        onChanged() {},
        onError: assert.fail
    });
    const entry = (p) => [...host._livePanels.values()].find((e) => e.panel === p);
    const ready = async (p) => {
        await p.receive({ type: "ready", panelId: entry(p).panelId });
        assert.ok(!p.messages.some((m) => m.type === "liveError"), "panel initializes without errors");
        return p.messages.findLast((m) => m.type === "watchList")?.items;
    };
    const open = () => {
        host.openLiveWatchPanel();
        return [...host._livePanels.values()].at(-1).panel;
    };
    return { host, values, panel, entry, ready, open };
}

(async () => {
    // A hidden editor has a tab but no deserialized WebviewPanel yet.
    {
        const f = fixture(),
            old = f.panel("波形图 #1"),
            fresh = f.open();
        assert.strictEqual(f.entry(fresh).panelId, 2, "hidden #1 reserves its number before restoration");
        assert.notStrictEqual(old.title, fresh.title);
        f.host.restoreLiveWatchPanel(old, { panelId: 1 });
        assert.deepStrictEqual(await f.ready(old), one);
        assert.deepStrictEqual(await f.ready(fresh), two);
    }
    // Tab inventory is scoped to EmberProbe, supports both host view-type forms and both languages.
    {
        const f = fixture();
        f.panel("Waveform #1", "another.extension");
        const old = f.panel("Waveform #2", "emberprobe.liveWatch");
        const fresh = f.open();
        assert.strictEqual(f.entry(fresh).panelId, 1);
        f.host.restoreLiveWatchPanel(old, { hidden: {} });
        assert.strictEqual(f.entry(old).panelId, 2, "legacy English title recovers the original identity");
        assert.deepStrictEqual(await f.ready(old), two);
    }
    // Even a conflicting legacy number must retain its original watches, not those of the new label.
    {
        const f = fixture(),
            first = f.open(),
            old = f.panel("波形图 #1");
        f.values.set("liveWatch.curveVisibility", { "mcu.watchList": { only_in_one: true } });
        f.values.set("liveWatch.runtimeExpansions", { "mcu.watchList": { only_in_one: ["member"] } });
        f.host.restoreLiveWatchPanel(old, { panelId: 1 });
        assert.strictEqual(f.entry(old).panelId, 2);
        assert.deepStrictEqual(await f.ready(old), one, "renumbering never switches to #2's watches");
        assert.notStrictEqual(
            f.entry(old).watchKey,
            f.entry(first).watchKey,
            "duplicate identities become independent"
        );
        assert.deepStrictEqual(old.messages.find((m) => m.type === "curveVisibility").hidden, { only_in_one: true });
        const key = f.entry(old).watchKey;
        assert.deepStrictEqual(f.values.get("liveWatch.runtimeExpansions")[key], { only_in_one: ["member"] });
        await old.receive({ type: "saveWatch", panelId: 2, items: two });
        assert.deepStrictEqual(f.values.get("mcu.watchList"), one, "editing the copied chart cannot change #1");
        assert.deepStrictEqual(f.values.get(key), two);
        await old.receive({ type: "saveWatch", panelId: 1, items: [] });
        assert.strictEqual(old.messages.at(-1).diagnostic.code, "INVALID_PANEL_ID");
        assert.deepStrictEqual(f.values.get(key), two, "cross-panel messages cannot change the list");
    }
    // Number and storage key stay independent across another restart, even while the chart is hidden.
    {
        const f = fixture(),
            old = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(old, { panelId: 2, watchKey: "mcu.watchList" });
        assert.deepStrictEqual(await f.ready(old), one);
        const view = render(old.webview.html, { panelId: 2, watchKey: "mcu.watchList" });
        let saved;
        try {
            saved = view.getState();
            assert.strictEqual(saved.watchKey, "mcu.watchList", "identity is saved at startup before host messages");
            assert.strictEqual(saved.panelId, 2);
            view.assertHealthy();
        } finally {
            view.close();
        }
        const restarted = fixture(structuredClone([...f.values]));
        const pending = restarted.panel("波形图 #2"),
            fresh = restarted.open();
        assert.strictEqual(restarted.entry(fresh).panelId, 1);
        assert.notStrictEqual(restarted.entry(fresh).watchKey, "mcu.watchList", "hidden #2 still owns #1's storage");
        restarted.host.restoreLiveWatchPanel(pending, saved);
        assert.deepStrictEqual(await restarted.ready(pending), one);
        assert.deepStrictEqual(
            await restarted.ready(fresh),
            [],
            "a new independent chart cannot borrow hidden watches"
        );
    }
    // Two overlapping restore requests may duplicate an identity whose first copy is still being saved.
    {
        const f = fixture();
        f.open();
        const copy = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(copy, { panelId: 1 });
        const next = f.panel("波形图 #3");
        f.host.restoreLiveWatchPanel(next, { panelId: 3, watchKey: f.entry(copy).watchKey });
        assert.deepStrictEqual(await f.ready(copy), one);
        assert.deepStrictEqual(await f.ready(next), one, "copies wait for their source initialization");
        assert.notStrictEqual(f.entry(copy).watchKey, f.entry(next).watchKey);
    }
    // VS Code's initial tab inventory can arrive after the first serializer during activation.
    {
        const f = fixture();
        f.values.set("liveWatch.panelBindings", { 2: "mcu.watchList" });
        const active = f.panel("Waveform #3");
        f.host.restoreLiveWatchPanel(active, { panelId: 3 });
        await f.ready(active);
        assert.strictEqual(f.values.get("liveWatch.panelBindings")[2], "mcu.watchList");
        const next = fixture(structuredClone([...f.values]));
        next.panel("Waveform #2");
        assert.notStrictEqual(next.entry(next.open()).watchKey, "mcu.watchList");
    }
    // Reverse restoration and legacy Chinese titles retain the two independent lists.
    {
        const f = fixture(),
            first = f.panel("波形图 #1"),
            second = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(second, {});
        f.host.restoreLiveWatchPanel(first, null);
        assert.deepStrictEqual(await f.ready(second), two);
        assert.deepStrictEqual(await f.ready(first), one);
        second.dispose();
        assert.strictEqual(f.entry(f.open()).panelId, 2, "closed slots can be reused");
    }
    // A shutdown during an old renumbering can leave the title ahead of the saved panel number.
    {
        const f = fixture(),
            pending = f.panel("波形图 #1"),
            old = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(old, { panelId: 1 });
        assert.strictEqual(f.entry(old).panelId, 2, "restoring cannot steal another hidden tab's visible number");
        assert.deepStrictEqual(await f.ready(old), one);
        assert.notStrictEqual(f.entry(old).watchKey, "mcu.watchList");
        f.host.restoreLiveWatchPanel(pending, { panelId: 1 });
        assert.deepStrictEqual(await f.ready(pending), one);
    }
    // Closing before initialization and reusing the number must not accept late messages from the old tab.
    {
        const f = fixture(),
            closing = f.open();
        const queued = closing.receive({ type: "saveWatch", panelId: 1, items: two });
        closing.dispose();
        const replacement = f.open();
        await queued;
        assert.strictEqual(f.entry(replacement).panelId, 1);
        assert.deepStrictEqual(await f.ready(replacement), one);
        assert.deepStrictEqual(f.values.get("mcu.watchList"), one);
    }
    // Corrupt persisted values cannot read unrelated workspace state or pick an arbitrary old list.
    {
        const f = fixture();
        for (const state of [{ panelId: -1 }, { panelId: Number.MAX_SAFE_INTEGER + 1 }, { watchKey: "mcu.debugger" }]) {
            const old = f.panel("Unknown chart");
            f.host.restoreLiveWatchPanel(old, state);
            assert.deepStrictEqual(await f.ready(old), []);
            assert.ok(Number.isSafeInteger(f.entry(old).panelId));
        }
    }
    console.log("Waveform panel identity, hidden tabs and restore isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
