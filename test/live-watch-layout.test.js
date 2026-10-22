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
    assert.strictEqual(document.getElementById("addBtn"), null);
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

    // Title bar actions: switch the style and close the panel.
    const head = document.getElementById("panelHandle");
    const mode = document.getElementById("panelMode");
    const close = document.getElementById("panelClose");
    assert.strictEqual(mode.closest(".side-head"), head);
    assert.strictEqual(close.closest(".side-head"), head);
    assert.strictEqual(mode.getAttribute("aria-pressed"), "false");
    assert.strictEqual(mode.title, "Float as a card over the chart");
    assert.strictEqual(head.tabIndex, -1, "the docked title bar is not a drag handle");
    assert.strictEqual(pane.style.cssText, "", "the docked sidebar is sized by the grid");
    close.click();
    assert(layout.classList.contains("side-collapsed"));
    assert.strictEqual(view.getState().sideCollapsed, true);
    assert.strictEqual(
        document.activeElement,
        document.getElementById("sideToggle"),
        "focus moves to the reopen button"
    );
    document.getElementById("sideToggle").click();
    assert(!layout.classList.contains("side-collapsed"));

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
console.log("Live-watch docked sidebar, title bar actions and collapsible diagnostics tests passed");

const floatingView = render(
    getLiveWatchContent({}, "en"),
    { panelMode: "floating", valuePanel: { x: 12, y: 40, w: 280, h: null } },
    {
        beforeParse(window) {
            window.innerWidth = 900;
        }
    }
);
try {
    const view = floatingView;
    const { document, window } = view;
    const layout = document.getElementById("layout");
    const pane = document.getElementById("valuePane");
    const head = document.getElementById("panelHandle");
    const handle = (edge) => pane.querySelector(`.float-resize[data-edge="${edge}"]`);
    let bounds = { width: 900, height: 600 };
    layout.getBoundingClientRect = () => bounds;
    const captures = new Set();
    for (const target of [head, ...pane.querySelectorAll(".float-resize")]) {
        target.setPointerCapture = (id) => captures.add(id);
        target.hasPointerCapture = (id) => captures.has(id);
        target.releasePointerCapture = (id) => captures.delete(id);
    }
    const pointer = (target, type, x, y, id = 1, button = 0) => {
        const event = new window.MouseEvent(type, { clientX: x, clientY: y, button, cancelable: true });
        Object.defineProperty(event, "pointerId", { value: id });
        target.dispatchEvent(event);
    };
    const key = (target, value, shiftKey = false) =>
        target.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, shiftKey, cancelable: true }));
    const rect = () => ["left", "top", "width", "height"].map((name) => parseFloat(pane.style[name]));
    const resizeLayout = (width, height) => {
        bounds = { width, height };
        window.dispatchEvent(new window.Event("resize"));
    };
    window.applySideLayout();
    const mode = document.getElementById("panelMode");
    assert(layout.classList.contains("panel-floating"));
    assert.strictEqual(document.getElementById("sideSplitter").tabIndex, -1, "the splitter is idle while floating");
    assert.strictEqual(mode.getAttribute("aria-pressed"), "true");
    assert.strictEqual(mode.title, "Dock as a sidebar");
    assert.strictEqual(head.tabIndex, 0);
    assert.strictEqual(pane.querySelectorAll(".float-resize").length, 8, "every edge and corner resizes");
    assert.deepStrictEqual(rect(), [12, 40, 280, 360], "restore the saved floating geometry");
    // Title bar buttons keep their own pointer and key events.
    const bubbling = (target, type, init) => {
        const event = new window.MouseEvent(type, {
            clientX: 0,
            clientY: 0,
            button: 0,
            bubbles: true,
            cancelable: true,
            ...init
        });
        Object.defineProperty(event, "pointerId", { value: 9 });
        target.dispatchEvent(event);
    };
    bubbling(mode, "pointerdown");
    assert(!pane.classList.contains("dragging"), "pressing a title bar button does not drag the card");
    mode.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    assert.deepStrictEqual(rect(), [12, 40, 280, 360], "arrow keys on a button do not move the card");

    pointer(head, "pointerdown", 100, 50, 1, 2);
    assert.strictEqual(captures.size, 0, "ignore secondary mouse buttons");
    pointer(head, "pointerdown", 100, 50);
    assert(pane.classList.contains("dragging"));
    pointer(head, "pointermove", 300, 300, 2);
    assert.deepStrictEqual(rect(), [12, 40, 280, 360], "ignore other pointers");
    pointer(head, "pointermove", 150, 80);
    assert.deepStrictEqual(rect(), [62, 70, 280, 360]);
    pointer(head, "pointermove", 3000, 3000);
    assert.deepStrictEqual(rect(), [612, 232, 280, 360], "the card stays inside the chart area");
    pointer(head, "pointerup", 3000, 3000);
    assert.strictEqual(captures.size, 0);
    assert(!pane.classList.contains("dragging"));
    assert.deepStrictEqual(view.getState().valuePanel, {
        x: 612,
        y: 232,
        w: 280,
        h: 360,
        dockRight: true,
        dockBottom: true
    });
    resizeLayout(700, 500);
    assert.deepStrictEqual(rect(), [412, 132, 280, 360], "a card docked to the edges follows them");
    key(head, "ArrowLeft");
    assert.deepStrictEqual(rect(), [402, 132, 280, 360]);
    assert.strictEqual(view.getState().valuePanel.dockRight, false, "moving away from the edge undocks it");
    key(head, "ArrowUp", true);
    assert.strictEqual(view.getState().valuePanel.y, 82);

    pointer(handle("w"), "pointerdown", 0, 0);
    pointer(handle("w"), "pointermove", -100, 0);
    assert.deepStrictEqual(rect(), [302, 82, 380, 360], "the west edge keeps the east edge in place");
    pointer(handle("w"), "pointermove", 500, 0);
    assert.deepStrictEqual(rect(), [462, 82, 220, 360], "respect the minimum width");
    pointer(handle("w"), "pointercancel", 500, 0);
    pointer(handle("w"), "pointermove", -100, 0);
    assert.deepStrictEqual(rect(), [462, 82, 220, 360], "cancel removes drag listeners");
    assert.strictEqual(view.getState().valuePanel.w, 220);

    pointer(handle("n"), "pointerdown", 0, 0);
    pointer(handle("n"), "pointermove", 0, -500);
    pointer(handle("n"), "lostpointercapture", 0, -500);
    assert.deepStrictEqual(rect(), [462, 8, 220, 434], "the north edge stops at the top margin");
    pointer(handle("se"), "pointerdown", 0, 0);
    pointer(handle("se"), "pointermove", 900, 900);
    pointer(handle("se"), "pointerup", 900, 900);
    assert.deepStrictEqual(rect(), [462, 8, 230, 484], "the corner resizes both axes up to the margins");
    key(handle("se"), "ArrowLeft", true);
    key(handle("se"), "ArrowUp");
    assert.deepStrictEqual(rect(), [462, 8, 220, 474], "keys resize from the focusable corner");

    resizeLayout(300, 200);
    assert.deepStrictEqual(rect(), [72, 8, 220, 184], "small views shrink and shift the card");
    resizeLayout(700, 500);
    assert.deepStrictEqual(rect(), [462, 8, 220, 474], "larger views restore the preferred geometry");

    document.getElementById("sideToggle").click();
    assert(layout.classList.contains("side-collapsed"));
    assert.strictEqual(view.getState().sideCollapsed, true);
    document.getElementById("sideToggle").click();
    assert(!layout.classList.contains("side-collapsed"));
    mode.click();
    assert(!layout.classList.contains("panel-floating"));
    assert.strictEqual(pane.style.cssText, "", "docking drops the card geometry from the sidebar");
    assert.strictEqual(view.getState().panelMode, "docked");
    assert.strictEqual(view.getState().valuePanel.w, 220, "the card geometry is kept for later");
    pointer(head, "pointerdown", 100, 50);
    assert(!pane.classList.contains("dragging"), "the docked title bar does not drag");
    mode.click();
    assert.strictEqual(view.getState().panelMode, "floating");
    assert.deepStrictEqual(rect(), [462, 8, 220, 474], "floating again restores the card");

    view.assertHealthy();
} finally {
    floatingView.close();
}
console.log("Live-watch floating value card tests passed");

const restoredView = render(getLiveWatchContent({}, "en"), {
    panelMode: "floating",
    valuePanel: { x: 40, y: 60, w: 320, h: 200, dockRight: false, dockBottom: true }
});
try {
    const { document } = restoredView;
    const pane = document.getElementById("valuePane");
    document.getElementById("layout").getBoundingClientRect = () => ({ width: 800, height: 500 });
    restoredView.window.applySideLayout();
    assert.deepStrictEqual(
        ["left", "top", "width", "height"].map((name) => parseFloat(pane.style[name])),
        [40, 292, 320, 200],
        "restore saved geometry and bottom docking"
    );
    restoredView.assertHealthy();
} finally {
    restoredView.close();
}
console.log("Live-watch floating value card state restore passed");

const columnsView = render(getLiveWatchContent({}, "en"), {});
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
    let paneWidth = 520;
    document.getElementById("valuePane").getBoundingClientRect = () => ({ width: paneWidth, height: 400 });
    columnsView.send({ type: "watchList", items });
    const box = document.getElementById("vars");
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
    box.scrollTop = 40;
    const resize = (width) => {
        paneWidth = width;
        window.dispatchEvent(new window.Event("resize"));
    };
    resize(479);
    assert.deepStrictEqual(
        names(box),
        items.map((item) => item.name),
        "single-column DOM follows watch order"
    );
    assert(!box.querySelector(".var-column"));
    assert.strictEqual(document.activeElement, focus, "keep focus while moving the same card nodes");
    assert.strictEqual(box.scrollTop, 40);
    assert(tree.classList.contains("open"), "responsive changes preserve manual tree expansion");
    resize(480);
    assert.strictEqual(box.querySelectorAll(".var-column").length, 2, "wide cards show two columns");
    assert.strictEqual(first.nextElementSibling, third);
    assert.strictEqual(document.activeElement, focus);
    document.getElementById("sideToggle").click();
    resize(0);
    assert.strictEqual(box.querySelectorAll(".var-column").length, 2, "a collapsed card keeps its columns");
    paneWidth = 300;
    document.getElementById("sideToggle").click();
    assert(!box.querySelector(".var-column"), "showing the card rearranges it for its width");
    resize(1200);
    assert.strictEqual(box.querySelectorAll(".var-column").length, 2);
    resize(300);
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
    assert.deepStrictEqual(names(box.children[0]), ["first", "third", "fifth"], "removal keeps other cards in place");
    assert.deepStrictEqual(names(box.children[1]), ["tree"]);
    columnsView.send({ type: "watchList", items: [] });
    assert(box.querySelector(".empty"));
    assert(!box.classList.contains("independent-columns"));
    assert(!box.querySelector(".var-column"));
    resize(400);
    columnsView.assertHealthy();
} finally {
    columnsView.close();
}
console.log("Independent variable columns, responsive order, focus and live updates passed");
