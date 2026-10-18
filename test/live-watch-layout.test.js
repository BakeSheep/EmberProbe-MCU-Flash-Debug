"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const runtime = require("../src/webview/runtime");

const view = render(
    getLiveWatchContent({}, "en"),
    { sideHeight: 220 },
    {
        beforeParse(window) {
            window.innerWidth = 600;
        }
    }
);
try {
    const { document, window } = view;
    const layout = document.getElementById("layout");
    const pane = document.getElementById("valuePane");
    const splitter = document.getElementById("sideSplitter");
    layout.getBoundingClientRect = () => ({ width: window.innerWidth, height: 600 });
    pane.getBoundingClientRect = () => ({
        width: parseFloat(layout.style.getPropertyValue("--side-width")),
        height: parseFloat(layout.style.getPropertyValue("--side-height"))
    });
    const captures = new Set();
    splitter.setPointerCapture = (id) => captures.add(id);
    splitter.hasPointerCapture = (id) => captures.has(id);
    splitter.releasePointerCapture = (id) => captures.delete(id);
    const pointer = (type, x, y, id = 1, button = 0) => {
        const event = new window.MouseEvent(type, { clientX: x, clientY: y, button, cancelable: true });
        Object.defineProperty(event, "pointerId", { value: id });
        splitter.dispatchEvent(event);
    };
    const key = (value) => splitter.dispatchEvent(new window.KeyboardEvent("keydown", { key: value }));
    window.applySideLayout();
    assert.ok(document.getElementById("addBtn").closest(".sampling-tools"), "typed names can be added by pointer");
    assert.strictEqual(layout.style.getPropertyValue("--side-height"), "220px");
    assert.strictEqual(splitter.getAttribute("aria-orientation"), "horizontal");
    pointer("pointerdown", 0, 220, 1, 2);
    assert.strictEqual(captures.size, 0, "ignore secondary mouse buttons");
    pointer("pointerdown", 0, 220);
    pointer("pointermove", 0, 300, 2);
    assert.strictEqual(layout.style.getPropertyValue("--side-height"), "220px", "ignore other pointers");
    pointer("pointermove", 0, 300);
    assert.strictEqual(layout.style.getPropertyValue("--side-height"), "300px");
    pointer("pointermove", 0, 900);
    assert.strictEqual(layout.style.getPropertyValue("--side-height"), "431px", "reserve space for the chart");
    pointer("pointerup", 0, 900);
    assert.strictEqual(view.getState().sideHeight, 431);
    assert.strictEqual(captures.size, 0);
    assert(!splitter.classList.contains("dragging"));
    key("ArrowUp");
    assert.strictEqual(view.getState().sideHeight, 421);
    key("ArrowLeft");
    assert.strictEqual(view.getState().sideHeight, 421, "use keys for the active orientation");
    pointer("pointerdown", 0, 421);
    pointer("pointermove", 0, -900);
    pointer("pointercancel", 0, -900);
    assert.strictEqual(view.getState().sideHeight, 100);
    pointer("pointermove", 0, 400);
    assert.strictEqual(view.getState().sideHeight, 100, "cancel removes drag listeners");
    document.getElementById("sideToggle").click();
    assert(layout.classList.contains("side-collapsed"));
    assert.strictEqual(splitter.tabIndex, -1);
    document.getElementById("sideToggle").click();
    assert.strictEqual(splitter.tabIndex, 0);
    window.innerWidth = 1200;
    window.applySideLayout();
    assert.strictEqual(splitter.getAttribute("aria-orientation"), "vertical");
    pointer("pointerdown", 260, 0);
    pointer("pointermove", 350, 0);
    pointer("lostpointercapture", 350, 0);
    assert.strictEqual(view.getState().sideWidth, 350);
    key("ArrowRight");
    assert.strictEqual(view.getState().sideWidth, 360);
    assert.strictEqual(view.getState().sideHeight, 100, "wide and stacked dimensions are independent");

    const card = document.getElementById("elfDiagnostics");
    runtime.renderElfDiagnostics(card, ["<script>bad()</script>", "warning", "warning", null], "", "ELF diagnostics");
    assert(!card.hidden);
    assert.strictEqual(card.querySelector("details").open, false);
    assert.strictEqual(card.querySelector("summary").textContent, "ELF diagnostics");
    assert.strictEqual(card.querySelectorAll(".elf-warning").length, 2);
    assert.strictEqual(card.querySelector("script"), null);
    card.querySelector("details").open = true;
    runtime.renderElfDiagnostics(card, [], "failure", "ELF 解析诊断");
    assert(card.querySelector("details").open, "keep manual expansion when diagnostics or language update");
    assert.strictEqual(card.querySelector(".elf-error").textContent, "failure");
    runtime.renderElfDiagnostics(card, [], "", "ELF diagnostics");
    assert(card.hidden);
    runtime.renderElfDiagnostics(card, ["new ELF"], "", "ELF diagnostics");
    assert.strictEqual(card.querySelector("details").open, false, "new diagnostic cards start collapsed");
    view.assertHealthy();
} finally {
    view.close();
}
console.log("Live-watch responsive splitter and collapsible diagnostics tests passed");

const columnsView = render(
    getLiveWatchContent({}, "en"),
    {},
    {
        beforeParse(window) {
            window.innerWidth = 600;
        }
    }
);
try {
    const { document, window } = columnsView;
    const items = ["first", "tree", "third", "fourth", "fifth"].map((name, index) => ({
        name,
        address: 0x20000000 + index * 4,
        type: "u32",
        size: 4
    }));
    Object.assign(items[1], {
        isComposite: true,
        typeName: "Settings",
        compositeLayout: {
            kind: "struct",
            members: [{ name: "gain", offset: 0, byteSize: 4, watchType: "u32" }]
        }
    });
    columnsView.send({ type: "watchList", items });
    const box = document.getElementById("vars");
    const pane = document.getElementById("valuePane");
    const names = (container) =>
        Array.from(
            container.querySelectorAll(".var-card"),
            (card) => card.querySelector(".var-name, .comp-name").textContent
        );
    const stacks = Array.from(box.children);
    assert.deepStrictEqual(names(stacks[0]), ["first", "third", "fifth"]);
    assert.deepStrictEqual(names(stacks[1]), ["tree", "fourth"]);
    const first = stacks[0].children[0];
    const third = stacks[0].children[1];
    const tree = stacks[1].children[0];
    const fourth = stacks[1].children[1];
    tree.querySelector(".comp-head").click();
    assert(tree.classList.contains("open"));
    assert.deepStrictEqual(Array.from(box.children), stacks, "expansion does not rebuild either column");
    assert.strictEqual(first.nextElementSibling, third, "the next left card follows the scalar directly");
    const focus = third.querySelector(".curve-toggle");
    focus.focus();
    pane.scrollTop = 40;
    const resize = (width) => {
        window.innerWidth = width;
        window.dispatchEvent(new window.Event("resize"));
    };
    resize(559);
    assert.deepStrictEqual(
        names(box),
        items.map((item) => item.name),
        "single-column DOM follows watch order"
    );
    assert(!box.querySelector(".var-column"));
    assert.strictEqual(document.activeElement, focus, "keep focus while moving the same card nodes");
    assert.strictEqual(pane.scrollTop, 40);
    assert(tree.classList.contains("open"), "responsive changes preserve manual tree expansion");
    resize(560);
    assert.strictEqual(box.querySelectorAll(".var-column").length, 2);
    assert.strictEqual(first.nextElementSibling, third);
    assert.strictEqual(document.activeElement, focus);
    resize(760);
    assert.strictEqual(box.querySelectorAll(".var-column").length, 2);
    resize(761);
    assert.deepStrictEqual(
        names(box),
        items.map((item) => item.name)
    );
    assert(!box.querySelector(".var-column"));
    resize(600);
    columnsView.send({ type: "liveSample", samples: [{ name: "first", value: 7, t: 1000 }] });
    assert.strictEqual(first.querySelector(".var-value").textContent, "7", "moved value cells still update");
    fourth.querySelector(".remove").click();
    assert.strictEqual(document.getElementById("count").textContent, "4");
    assert.deepStrictEqual(names(box.children[0]), ["first", "third"]);
    assert.deepStrictEqual(names(box.children[1]), ["tree", "fifth"]);
    columnsView.send({ type: "watchList", items: [] });
    assert(box.querySelector(".empty"));
    assert(!box.classList.contains("independent-columns"));
    assert(!box.querySelector(".var-column"));
    resize(550);
    columnsView.assertHealthy();
} finally {
    columnsView.close();
}
console.log("Independent variable columns, responsive order, focus and live updates passed");
