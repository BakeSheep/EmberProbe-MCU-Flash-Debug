"use strict";
// Runtime object cards stay stable while the target runs: a pointer rewritten mid-sample withholds
// only its own subtree, transient whole-object misses show the last consistent tree for a moment,
// one webview batch never carries two states of one variable, and the sidebar reads only what it opened.
const assert = require("assert");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { RuntimeSampleHold, HOLD_MS, HOLD_FAILURES } = require("../src/services/runtimeSampleHold");
const { getModernWebviewContent } = require("../src/modernView");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");

const base = 0x20000000;
const types = [
    { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
    { kind: "class", typeName: "Node", byteSize: 4, fields: [{ name: "v", offset: 0, type: 0 }] },
    { kind: "pointer", typeName: "Node *", target: 1, byteSize: 4, pointerTarget: "data" },
    {
        kind: "class",
        typeName: "Holder",
        byteSize: 12,
        fields: [
            { name: "focus", offset: 0, type: 2 },
            { name: "other", offset: 4, type: 2 },
            { name: "marker", offset: 8, type: 0 }
        ]
    }
];
const memory = Buffer.alloc(256);
memory.writeUInt32LE(base + 32, 0);
memory.writeUInt32LE(base + 48, 4);
memory.writeInt32LE(99, 8);
memory.writeInt32LE(1, 32);
memory.writeInt32LE(2, 40);
memory.writeInt32LE(3, 48);
const ranges = [{ start: base, end: base + memory.length }];
const member = (tree, name) => tree.members.find((entry) => entry.name === name);

// Like the firmware's rotating `pointers.focus`: the word at `address` moves to `next` after the first read.
function flipping(address, next) {
    let hits = 0;
    return async (start, size) => {
        const bytes = Buffer.from(memory.subarray(start - base, start - base + size));
        if (start <= address && start + size >= address + 4 && ++hits > 1) bytes.writeUInt32LE(next, address - start);
        return bytes;
    };
}
const sample = (item, read) =>
    new RuntimeObjectReader({ ...item, runtimeRanges: ranges }, read, () => {}, {
        bytes: 0,
        commands: 0,
        deadline: Date.now() + 1000
    }).sample();

(async () => {
    // Reader: a member pointer rewritten during the sample withholds that pointer only.
    const holder = { name: "h", address: base, size: 12, runtimeLayout: { root: 3, types } };
    const stable = await sample(holder, flipping(base + 0x80, 0));
    assert.strictEqual(member(member(member(stable, "focus"), "value"), "v").value, 1);
    const flipped = await sample(holder, flipping(base, base + 40));
    assert.strictEqual(member(flipped, "focus").unavailableCode, "LIVE_OBJECT_CHANGED");
    assert.strictEqual(member(flipped, "focus").unavailable, "changing");
    assert.deepStrictEqual(member(flipped, "focus").members, []);
    assert.strictEqual(member(member(member(flipped, "other"), "value"), "v").value, 3, "siblings keep values");
    assert.strictEqual(member(flipped, "marker").value, 99);
    // The root's own descriptor still fails the whole object.
    const rootPointer = { name: "p", address: base, size: 4, runtimeLayout: { root: 2, types } };
    await assert.rejects(sample(rootPointer, flipping(base, base + 40)), { code: "LIVE_OBJECT_CHANGED" });

    // Hold: transient whole-object failures show the last tree, marked stale, for a bounded time.
    let now = 0;
    const hold = new RuntimeSampleHold({ now: () => now });
    const tree = (value) => ({
        kind: "class",
        typeName: "H",
        members: [
            { name: "p", kind: "class", isPointer: true, members: [{ name: "value", kind: "scalar", value }] },
            { name: "m", kind: "scalar", value: value * 10 }
        ]
    });
    const good = (t, value = 1) => ({ name: "h", runtimeTree: tree(value), t });
    const failed = (t, code = "LIVE_OBJECT_CHANGED", extra = {}) => ({
        name: "h",
        diagnostic: { code, message: code, ...extra },
        t
    });
    const scalar = { name: "x", value: 5, t: 0 };
    const passthrough = [scalar];
    assert.strictEqual(hold.apply(passthrough, 0), passthrough, "samples without runtime trees are untouched");
    const first = good(0);
    assert.strictEqual(hold.apply([first], 0)[0], first);
    for (let i = 1; i <= HOLD_FAILURES; i++) {
        now = i * 10;
        const [held] = hold.apply([failed(now)], now);
        assert.strictEqual(held.stale, true);
        assert.strictEqual(held.runtimeTree.stale, true);
        assert.strictEqual(held.diagnostic, undefined);
        assert.strictEqual(member(held.runtimeTree, "m").value, 10);
        // A re-delivered sample (same time) does not count again.
        assert.strictEqual(hold.apply([failed(now)], now)[0].stale, true);
    }
    now = 100;
    const past = failed(now);
    assert.strictEqual(hold.apply([past], now)[0], past, "a longer streak reaches the views");
    // A recovered object holds again; a held tree expires after HOLD_MS.
    hold.apply([good(200)], (now = 200));
    now = 200 + HOLD_MS + 1;
    const late = failed(now);
    assert.strictEqual(hold.apply([late], now)[0], late);
    // Deadline overruns are transient, plan budget overruns and other codes are not.
    hold.apply([good(5000)], (now = 5000));
    assert.strictEqual(
        hold.apply([failed(5010, "LIVE_READ_BUDGET_EXCEEDED", { reason: "deadline" })], (now = 5010))[0].stale,
        true
    );
    const budget = failed(5020, "LIVE_READ_BUDGET_EXCEEDED");
    assert.strictEqual(hold.apply([budget], (now = 5020))[0], budget);
    hold.apply([good(6000)], (now = 6000));
    const notRam = failed(6010, "LIVE_ADDRESS_NOT_RAM");
    assert.strictEqual(hold.apply([notRam], (now = 6010))[0], notRam);
    const afterPersistent = failed(6020);
    assert.strictEqual(hold.apply([afterPersistent], (now = 6020))[0], afterPersistent, "state was dropped");

    // Hold: a member withheld as changing shows its last value, marked stale.
    const changingTree = () => ({
        ...tree(2),
        members: [
            {
                name: "p",
                kind: "class",
                typeName: "Node *",
                members: [],
                unavailable: "changing",
                unavailableCode: "LIVE_OBJECT_CHANGED"
            },
            { name: "m", kind: "scalar", value: 20 }
        ]
    });
    hold.reset();
    const unheld = hold.apply([{ name: "h", runtimeTree: changingTree(), t: 7000 }], (now = 7000))[0];
    assert.strictEqual(member(unheld.runtimeTree, "p").unavailable, "changing", "nothing earlier to show");
    hold.apply([good(7010)], (now = 7010));
    const spliced = hold.apply([{ name: "h", runtimeTree: changingTree(), t: 7020 }], (now = 7020))[0];
    assert.deepStrictEqual(member(spliced.runtimeTree, "p"), { ...tree(1).members[0], stale: true });
    assert.strictEqual(member(spliced.runtimeTree, "m").value, 20, "fresh siblings are kept");
    assert.strictEqual(spliced.runtimeTree.stale, undefined);
    now = 7020 + HOLD_MS + 1;
    const expired = hold.apply([{ name: "h", runtimeTree: changingTree(), t: now }], now)[0];
    assert.strictEqual(member(expired.runtimeTree, "p").unavailable, "changing", "a member held too long shows why");
    hold.reset("h");
    const cleared = failed(now + 1);
    assert.strictEqual(hold.apply([cleared], now + 1)[0], cleared);

    // Batches: one message carries the latest state of each composite.
    const Provider = loadProvider({});
    const p = Object.create(Provider.prototype);
    const posted = [];
    const entry = { ready: true, post: (message) => posted.push(message) };
    p._livePanels = new Map([[1, entry]]);
    p._liveIntervalMs = 10;
    p._probeCoordinator = { isActive: (name) => name === "liveWatch" };
    p._chartHistory = null;
    const sidebarPosted = [];
    p._webviewView = { webview: { postMessage: (message) => sidebarPosted.push(message) } };
    for (const [t, value] of [
        [1, "good"],
        [2, "error"]
    ]) {
        p._postWebviewBatch(entry, [], [{ name: "h", tree: { value } }], t);
        p._postSidebarBatch([], [{ name: "h", tree: { value } }], t);
    }
    p._flushPendingWebviewSamples();
    for (const messages of [posted, sidebarPosted]) {
        const composites = messages.filter((message) => message.type === "liveCompositeSample");
        assert.strictEqual(composites.length, 1);
        assert.deepStrictEqual(composites[0].samples, [{ name: "h", tree: { value: "error" } }]);
    }

    // Sidebar: runtime cards read only what they opened.
    const symbol = { name: "g", address: base, size: 12, isComposite: true, runtimeLayout: { root: 3, types } };
    const state = new Map([["liveWatch.runtimeExpansions", { "mcu.sidebarWatchList": { g: ["", ".focus"] } }]]);
    p._context = {
        workspaceState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) }
    };
    p._livePanels = new Map();
    p._scalarWatchList = (key) => (key === "mcu.sidebarWatchList" ? [symbol] : []);
    p._runtimeReadRanges = (plan) => plan;
    p.readElfSymbols = () => {
        throw new Error("no ELF");
    };
    p._pointerExpandedOnly = true;
    assert.deepStrictEqual(p._activeReadPlan()[0].runtimeExpanded, ["", ".focus"]);
    p._pointerExpandedOnly = false;
    assert.strictEqual(p._activeReadPlan()[0].runtimeExpanded, undefined, "off reads the whole object");

    const view = render(getModernWebviewContent({}, "en"));
    try {
        const sent = () => view.messages.filter((message) => message.type === "saveRuntimeExpansions");
        assert.strictEqual(sent().length, 0, "nothing is sent before the host's list");
        view.send({ type: "sidebarWatchList", items: [symbol] });
        assert.deepStrictEqual(sent().at(-1).expansions, { g: [] });
        view.document.querySelector(".value-row.composite > .sb-comp-head").click();
        assert.deepStrictEqual(sent().at(-1).expansions, { g: [""] });
        const opened = await sample({ ...symbol, runtimeExpanded: [""] }, flipping(base + 0x80, 0));
        assert.strictEqual(member(opened, "focus").collapsed, true);
        view.send({ type: "liveCompositeSample", samples: [{ name: "g", tree: opened, t: 1 }] });
        const toggle = view.document.querySelector('.pointer-toggle[data-path="g.focus"]');
        assert.ok(toggle, "a closed pointer keeps its disclosure");
        toggle.click();
        assert.deepStrictEqual(sent().at(-1).expansions, { g: ["", ".focus"] });
        const count = sent().length;
        view.send({ type: "liveCompositeSample", samples: [{ name: "g", tree: opened, t: 2 }] });
        assert.strictEqual(sent().length, count, "unchanged expansions are not resent");
        // Members past the cycle's read budget share one notice and keep their rows without a value.
        const budget = { unavailable: "expansion-budget", unavailableCode: "LIVE_READ_BUDGET_EXCEEDED" };
        const unread = {
            ...opened,
            members: opened.members.map((entry) =>
                entry.name === "focus"
                    ? entry
                    : entry.name === "marker"
                      ? { ...entry, value: null, ...budget }
                      : { name: entry.name, kind: "class", typeName: "Node *", members: [], ...budget }
            )
        };
        view.send({ type: "liveCompositeSample", samples: [{ name: "g", tree: unread, t: 3 }] });
        const card = view.document.querySelector(".value-row.composite");
        const notices = [...card.querySelectorAll(".notice")].filter((node) =>
            node.textContent.includes("exceed the read budget")
        );
        assert.strictEqual(notices.length, 1, "one read-budget notice per card");
        assert.ok(card.textContent.includes("marker"), "an unread scalar keeps its row");
        assert.ok(!/\b(null|NaN|undefined)\b/.test(card.textContent), card.textContent);
        view.assertHealthy();
    } finally {
        view.close();
    }

    console.log("Runtime sample stability tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
