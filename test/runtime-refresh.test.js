"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

function clock(view) {
    let now = 10000;
    let nextId = 0;
    const timers = new Map();
    view.window.Date.now = () => now;
    view.window.setTimeout = (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { callback, deadline: now + delay });
        return id;
    };
    view.window.clearTimeout = (id) => timers.delete(id);
    return (elapsed) => {
        now += elapsed;
        for (const [id, timer] of timers) {
            if (timer.deadline > now) continue;
            timers.delete(id);
            timer.callback();
        }
    };
}

const runtimeItem = {
    name: "values",
    address: 0x20000000,
    size: 12,
    isComposite: true,
    compositeLayout: { kind: "class", typeName: "std::vector<int>", members: [] },
    runtimeLayout: { root: 0, types: [] }
};
const scalarItem = { name: "tick", address: 0x20000020, size: 4, type: "u32" };
const element = (value, index = 0, address = 0x20000100 + index * 4) => ({
    kind: "scalar",
    name: "value",
    index,
    type: "i32",
    address,
    value
});
const array = (...elements) => ({ kind: "array", elements });
const sample = (tree) => ({ type: "liveCompositeSample", samples: [{ name: "values", tree }] });

for (const [label, html, listType, selector] of [
    ["sidebar", getModernWebviewContent({}, "en"), "sidebarWatchList", ".sb-mval"],
    ["chart", getLiveWatchContent({}, "en"), "watchList", ".member-value"]
]) {
    const view = render(html);
    const advance = clock(view);
    try {
        view.send({ type: listType, items: [runtimeItem, scalarItem] });
        view.send(sample(array(element(42))));
        const cell = view.document.querySelector(selector);
        assert.strictEqual(cell.textContent, "42", `${label}: first runtime sample is populated immediately`);
        const button = view.document.querySelector(".member-row .curve-toggle");
        button?.focus();

        // The host delivers scalars first, then composites; neither may blank valid rows.
        advance(25);
        view.send({ type: "liveSample", samples: [{ name: "tick", value: 7, t: 10025 }] });
        view.send(sample(array(element(43))));
        assert.strictEqual(view.document.querySelector(selector), cell, `${label}: values reuse existing rows`);
        assert.strictEqual(cell.textContent, "42", `${label}: a throttled sample keeps the last displayed value`);
        if (button) assert.strictEqual(view.document.activeElement, button, "sampling retains member button focus");
        advance(75);
        assert.strictEqual(cell.textContent, "43", `${label}: the scheduled refresh uses the latest value`);

        view.send(sample(array(element(44))));
        view.send(sample(array(element(45))));
        assert.strictEqual(cell.textContent, "43");
        advance(100);
        assert.strictEqual(cell.textContent, "45", `${label}: repeated samples coalesce without blanking`);

        view.send(sample(array(element(46), element(47, 1))));
        const grown = [...view.document.querySelectorAll(selector)];
        assert.deepStrictEqual(
            grown.map((node) => node.textContent),
            ["46", "47"]
        );
        view.send(sample(array(element(48))));
        assert.strictEqual(view.document.querySelectorAll(selector).length, 1);
        assert.strictEqual(view.document.querySelector(selector).textContent, "48");
        assert.strictEqual(view.window.eval("compCells['values[1]']"), undefined, "shrinking removes cached cells");

        // Address changes must also rebuild handlers that add members to a chart.
        const beforeMove = view.document.querySelector(selector);
        view.send(sample(array(element(49, 0, 0x20000200))));
        assert.notStrictEqual(view.document.querySelector(selector), beforeMove);
        assert.strictEqual(view.document.querySelector(selector).textContent, "49");
        if (button) {
            view.document.querySelector(".member-row .curve-toggle").click();
            const saved = view.messages.findLast((message) => message.type === "saveWatch");
            assert.strictEqual(saved.items.find((item) => item.name === "values[0]").address, 0x20000200);
        }

        const wide = { ...element(null), type: "u64", valueText: "18446744073709551615" };
        view.send(sample(array(wide)));
        assert.strictEqual(view.document.querySelector(selector).textContent, wide.valueText);
        view.send(sample({ kind: "class", members: [], unavailable: "Read budget exceeded" }));
        assert.strictEqual(view.document.querySelectorAll(selector).length, 0);
        assert.ok(view.document.body.textContent.includes("Read budget exceeded"));
        assert.strictEqual(view.window.eval("compCells['values[0]']"), undefined);
        view.send(sample(array(element(50))));
        assert.strictEqual(view.document.querySelector(selector).textContent, "50", "valid samples recover directly");
        view.send(sample(array()));
        assert.strictEqual(view.document.querySelectorAll(selector).length, 0);
        view.send(sample(array(element(null))));
        assert.strictEqual(view.document.querySelector(selector).textContent, "—", "unavailable leaves stay honest");

        const staticItem = {
            ...runtimeItem,
            runtimeLayout: undefined,
            compositeLayout: {
                kind: "struct",
                members: [{ name: "count", offset: 0, byteSize: 4, watchType: "u32" }]
            }
        };
        view.send({ type: listType, items: [staticItem] });
        assert.deepStrictEqual(Object.keys(view.window.eval("runtimeBodies")), []);
        view.send(sample({ kind: "struct", members: [{ name: "count", value: 99 }] }));
        advance(100);
        assert.strictEqual(
            view.document.querySelector(selector).textContent,
            "99",
            "static layout updates visible DOM"
        );
        view.send({ type: listType, items: [] });
        assert.deepStrictEqual(Object.keys(view.window.eval("runtimeBodies")), []);
        view.send({ type: listType, items: [runtimeItem] });
        view.send(sample(array(element(100))));
        assert.strictEqual(view.document.querySelector(selector).textContent, "100", "re-added runtime watch updates");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

const sidebar = render(getModernWebviewContent({}, "en"));
const advance = clock(sidebar);
try {
    sidebar.send({ type: "liveStatus", source: "openocd", running: true, canRead: true, canWrite: true });
    sidebar.send({ type: "sidebarWatchList", items: [scalarItem] });
    sidebar.send({ type: "sidebarWriteList", items: [{ ...scalarItem, value: 17, min: 0, max: 100 }] });
    const input = sidebar.document.querySelector(".write-input");
    for (const value of [17, null, undefined, NaN, Infinity]) {
        sidebar.send({ type: "liveSample", samples: [{ name: "tick", value }] });
        advance(100);
        assert.strictEqual(input.value, "17", "invalid samples never substitute zero for the current write value");
    }
    assert.strictEqual(sidebar.document.querySelector(".value-number").textContent, "—");
    sidebar.send({ type: "liveSample", samples: [{ name: "tick", value: 0 }] });
    advance(100);
    assert.strictEqual(input.value, "0", "a valid zero still updates the write control");
    sidebar.send({ type: "liveSample", samples: [{ name: "tick", value: 19 }] });
    advance(100);
    assert.strictEqual(input.value, "19", "successful sampling recovers after invalid values");
    input.focus();
    input.value = "23";
    sidebar.send({ type: "liveSample", samples: [{ name: "tick", value: 20 }] });
    advance(100);
    assert.strictEqual(input.value, "23", "sampling preserves an active edit");
    assert.ok(
        !sidebar.messages.some((message) => message.type === "writeVariable"),
        "display updates never write hardware"
    );
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}

console.log("Runtime sampling refresh, layout changes, focus retention and invalid write values passed");
