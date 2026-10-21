"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const scalar = (name, index) => ({ name, address: 0x20000000 + index * 4, size: 4, type: "u32" });
const composite = {
    name: "plant",
    address: 0x20001000,
    size: 4,
    type: "u32",
    isComposite: true,
    typeName: "Plant",
    compositeLayout: { kind: "struct", members: [{ name: "gain", offset: 0, byteSize: 4, watchType: "u32" }] }
};

function harness(view, container) {
    const { window } = view;
    const captures = new Set();
    container.setPointerCapture = (id) => captures.add(id);
    container.hasPointerCapture = (id) => captures.has(id);
    container.releasePointerCapture = (id) => captures.delete(id);
    const cards = () => Array.from(container.querySelectorAll("[data-reorder-key]"));
    // Cards are laid out by logical position: `column` splits them into stacks the way the chart does.
    const layout = (columns = 1) => {
        const order = harness.order ? harness.order() : cards().map((card) => card.dataset.reorderKey);
        order.forEach((name, index) => {
            const card = cards().find((node) => node.dataset.reorderKey === name);
            const column = index % columns;
            const row = Math.floor(index / columns);
            card.getBoundingClientRect = () => ({
                left: column * 200,
                right: column * 200 + 180,
                top: row * 40,
                bottom: row * 40 + 30,
                width: 180,
                height: 30
            });
        });
    };
    const pointer = (target, type, x, y, id = 1) => {
        const event = new window.MouseEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            bubbles: true,
            cancelable: true
        });
        Object.defineProperty(event, "pointerId", { value: id });
        target.dispatchEvent(event);
    };
    const handle = (name) =>
        cards()
            .find((card) => card.dataset.reorderKey === name)
            .querySelector(".reorder-handle");
    const drag = (name, x, y, options = {}) => {
        const start = handle(name);
        pointer(start, "pointerdown", 2, 2);
        pointer(window, "pointermove", x, y);
        if (options.during) options.during();
        if (options.cancel) {
            window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return;
        }
        pointer(window, "pointerup", x, y);
    };
    const key = (name, value) =>
        handle(name).dispatchEvent(new window.KeyboardEvent("keydown", { key: value, altKey: true, bubbles: true }));
    return { cards, layout, pointer, handle, drag, key, captures };
}

const keys = (cards) => cards.map((card) => card.dataset.reorderKey);
const lastSaved = (view, type) => view.messages.findLast((message) => message.type === type);

// Sidebar watch and write lists.
{
    const view = render(getModernWebviewContent({}, "en"));
    try {
        const { document } = view;
        const watchBox = document.getElementById("liveValues");
        const writeBox = document.getElementById("writeValues");
        const items = [scalar("alpha", 0), scalar("beta", 1), composite, scalar("plant.gain", 3), scalar("gamma", 4)];
        view.send({ type: "sidebarWatchList", items });
        const watch = harness(view, watchBox);
        assert.deepStrictEqual(
            keys(watch.cards()),
            ["alpha", "beta", "plant", "gamma"],
            "member entries are not cards"
        );
        const handle = watch.handle("alpha");
        assert.strictEqual(handle.tagName, "BUTTON");
        assert.match(handle.getAttribute("aria-label"), /^Drag to reorder alpha/);

        watch.layout();
        watch.drag("alpha", 10, 105);
        assert.deepStrictEqual(
            lastSaved(view, "saveSidebarWatch").items.map((item) => item.name),
            ["beta", "plant", "plant.gain", "alpha", "gamma"],
            "dropping on the lower half of a composite lands after it and its members"
        );
        assert.deepStrictEqual(keys(watch.cards()), ["beta", "plant", "alpha", "gamma"]);
        assert(!watchBox.querySelector(".reorder-dragging, .reorder-drop-before, .reorder-drop-after"));
        assert.strictEqual(watch.captures.size, 0, "pointer capture is released");

        watch.layout();
        watch.drag("plant", 10, 145);
        assert.deepStrictEqual(
            lastSaved(view, "saveSidebarWatch").items.map((item) => item.name),
            ["beta", "alpha", "gamma", "plant", "plant.gain"],
            "a composite moves together with its members"
        );

        // A re-render from the host mid-drag keeps the drag alive; Escape cancels without saving.
        const saves = view.messages.filter((message) => message.type === "saveSidebarWatch").length;
        watch.layout();
        watch.drag("gamma", 10, 5, {
            during: () => {
                assert(watchBox.querySelector('[data-reorder-key="gamma"]').classList.contains("reorder-dragging"));
                assert(watchBox.querySelector('[data-reorder-key="beta"]').classList.contains("reorder-drop-before"));
                view.send({ type: "sidebarWatchList", items: lastSaved(view, "saveSidebarWatch").items });
                watch.layout();
                assert(
                    watchBox.querySelector('[data-reorder-key="gamma"]').classList.contains("reorder-dragging"),
                    "drag marks survive a re-render"
                );
            }
        });
        assert.deepStrictEqual(
            lastSaved(view, "saveSidebarWatch").items.map((item) => item.name),
            ["gamma", "beta", "alpha", "plant", "plant.gain"]
        );
        watch.layout();
        watch.drag("alpha", 10, 5, { cancel: true });
        assert.strictEqual(view.messages.filter((message) => message.type === "saveSidebarWatch").length, saves + 1);
        assert(!watchBox.querySelector(".reorder-dragging"), "Escape clears the drag");
        watch.pointer(view.window, "pointerup", 10, 5);
        assert.strictEqual(view.messages.filter((message) => message.type === "saveSidebarWatch").length, saves + 1);

        // A click on the handle without movement does nothing.
        watch.pointer(watch.handle("beta"), "pointerdown", 2, 2);
        watch.pointer(view.window, "pointerup", 3, 3);
        assert.strictEqual(view.messages.filter((message) => message.type === "saveSidebarWatch").length, saves + 1);

        // Keyboard moves keep focus on the moved card's handle.
        watch.handle("beta").focus();
        watch.key("beta", "ArrowDown");
        assert.deepStrictEqual(keys(watch.cards()), ["gamma", "alpha", "beta", "plant"]);
        assert.strictEqual(document.activeElement, watch.handle("beta"));
        watch.key("gamma", "ArrowUp");
        assert.deepStrictEqual(keys(watch.cards()), ["gamma", "alpha", "beta", "plant"], "the first card stays first");

        view.send({ type: "sidebarWriteList", items: [scalar("w1", 0), scalar("w2", 1), scalar("w3", 2)] });
        const write = harness(view, writeBox);
        assert.deepStrictEqual(keys(write.cards()), ["w1", "w2", "w3"]);
        assert(write.cards().every((card) => card.classList.contains("write-row")));
        write.layout();
        write.drag("w3", 10, 2);
        assert.deepStrictEqual(
            lastSaved(view, "saveSidebarWrite").items.map((item) => item.name),
            ["w3", "w1", "w2"]
        );
        write.handle("w1").focus();
        write.key("w1", "ArrowDown");
        assert.deepStrictEqual(
            lastSaved(view, "saveSidebarWrite").items.map((item) => item.name),
            ["w3", "w2", "w1"]
        );
        assert.strictEqual(document.activeElement, write.handle("w1"));
        view.assertHealthy();
    } finally {
        view.close();
    }
}

// Chart sidebar cards, including the alternating two-column layout.
{
    const view = render(
        getLiveWatchContent({}, "en"),
        {},
        {
            beforeParse(window) {
                window.innerWidth = 600;
            }
        }
    );
    try {
        const { document, window } = view;
        const box = document.getElementById("vars");
        const items = ["first", "second", "third", "fourth"].map(scalar);
        view.send({ type: "watchList", items });
        assert.strictEqual(box.querySelectorAll(".var-column").length, 2);
        const chart = harness(view, box);
        // Logical (watch) order, not DOM order, decides positions in the alternating columns.
        harness.order = () => ["first", "second", "third", "fourth"];
        chart.layout(2);
        harness.order = null;
        // "fourth" is drawn right of "third" (column 1, row 1); drop it on the top half of "second".
        chart.drag("fourth", 210, 2);
        assert.deepStrictEqual(
            lastSaved(view, "saveWatch").items.map((item) => item.name),
            ["first", "fourth", "second", "third"]
        );
        // The host echoes the list back; keyboard moves follow watch order across columns.
        view.send({ type: "watchList", items: lastSaved(view, "saveWatch").items });
        chart.handle("first").focus();
        chart.key("first", "ArrowDown");
        assert.deepStrictEqual(
            lastSaved(view, "saveWatch").items.map((item) => item.name),
            ["fourth", "first", "second", "third"]
        );
        assert.strictEqual(document.activeElement, chart.handle("first"));
        view.send({ type: "watchList", items: lastSaved(view, "saveWatch").items });
        assert.strictEqual(document.activeElement, chart.handle("first"), "focus survives the host echo");
        const card = box.querySelector('[data-reorder-key="first"]');
        assert(card.classList.contains("var-card"));
        assert.strictEqual(card.firstElementChild.className, "reorder-handle");
        window.innerWidth = 900;
        window.dispatchEvent(new window.Event("resize"));
        assert.deepStrictEqual(keys(chart.cards()), ["fourth", "first", "second", "third"]);
        view.assertHealthy();
    } finally {
        view.close();
    }
}

console.log("Card drag reorder in watch, write and chart lists passed");
