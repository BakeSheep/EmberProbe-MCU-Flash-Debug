"use strict";

const assert = require("assert");
const { JSDOM } = require("jsdom");
const { render } = require("./helpers/render-webview");
const { fixture } = require("./helpers/layout-expansion-fixture");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const runtime = require("../src/webview/runtime");
const { t } = require("../src/i18n");

for (const language of ["en", "zh"]) {
    for (const sidebar of [true, false]) {
        const page = render(sidebar ? getModernWebviewContent({}, language) : getLiveWatchContent({}, language));
        const doc = page.document;
        const listType = sidebar ? "sidebarWatchList" : "watchList";
        const cards = () => [...doc.querySelectorAll(sidebar ? "#liveValues > .value-row" : "#vars .var-card")];
        const bodyOf = (card) => card.querySelector(sidebar ? ".sb-body" : ".comp-body");
        const footerOf = (card) =>
            sidebar ? card.lastElementChild : card.querySelector(".comp-content").lastElementChild;
        const translate = (key) => t(language, key);
        try {
            const f = fixture();
            const name = "_ZN3lab11g_wrapped40E";
            const symbol = {
                ...f.symbol,
                name,
                displayName: "lab::g_wrapped40",
                compositeLayout: { ...f.layout, truncated: true }
            };
            const prefix = sidebar ? "availableVariables" : "variablesList";
            page.send({ type: prefix + "Reset", version: "v1", generation: 7 });
            page.send({ type: prefix + "Chunk", version: "v1", symbols: [symbol] });
            page.send({ type: listType, items: [symbol, { ...symbol, name: "second", displayName: "second" }] });
            assert.strictEqual(cards().length, 2);
            for (const card of cards()) {
                const footer = footerOf(card);
                assert(footer.matches(".variable-notices.notice-area"));
                assert(!bodyOf(card).contains(footer), "a collapsed body must not hide the footer");
                assert(!footer.hidden);
                assert(footer.querySelector(".notice--warning .notice-icon"));
                assert(footer.textContent.includes(translate("lw.layoutPartial")));
                assert.strictEqual(footer.querySelectorAll(".layout-expand").length, 2);
                assert(!footer.querySelector(".notice-close"), "persistent state cannot be dismissed");
                assert(!bodyOf(card).querySelector(".notice"), "nested messages belong in the footer");
            }
            assert(!footerOf(cards()[0]).textContent.includes("_ZN"));
            const requestButton = footerOf(cards()[0]).querySelector(".layout-expand");
            requestButton.click();
            const request = page.messages.findLast((message) => message.type === "expandLayout");
            assert.strictEqual(request.name, name);
            assert.strictEqual(request.path, name + "[0].a.b");
            assert(footerOf(cards()[0]).querySelector(".notice--info.notice--busy"));
            assert(!footerOf(cards()[1]).querySelector(".notice--busy"), "card loading states are independent");
            page.send({ ...request, type: "layoutExpansionResult", code: "INVALID_LAYOUT_HANDLE" });
            assert(footerOf(cards()[0]).querySelector(".notice--error"));
            assert(!footerOf(cards()[1]).querySelector(".notice--error"));

            // Runtime refreshes replace transient state; unknown raw failures stay in diagnostic details.
            const object = {
                name: "object",
                displayName: "lab::object",
                isComposite: true,
                address: 0x20000000,
                size: 4,
                compositeLayout: { kind: "class", members: [] },
                runtimeLayout: {
                    root: 1,
                    types: [
                        { kind: "scalar", watchType: "u32", byteSize: 4 },
                        { kind: "class", byteSize: 4, fields: [{ name: "value", type: 0, offset: 0 }] }
                    ]
                }
            };
            page.send({ type: listType, items: [object] });
            const footer = () => footerOf(cards()[0]);
            assert(footer().textContent.includes(translate("lw.waitSamples")));
            const sample = (tree) => page.send({ type: "liveCompositeSample", samples: [{ name: "object", tree }] });
            const leaf = { kind: "scalar", name: "value", type: "u32", value: 2 };
            for (const [reason, level, key] of [
                ["opaque-pointee", "warning", "lw.pointeeOpaque"],
                ["not-ram", "warning", "lw.pointeeNotRam"],
                ["memory-unavailable", "error", "lw.pointeeMemoryUnavailable"],
                ["cycle", "error", "lw.pointeeCycle"],
                ["expansion-budget", "warning", "lw.layoutExpansionBudget"],
                ["unknown internal reason _ZNraw", "error", "lw.pointeeUnavailable"]
            ]) {
                sample({ kind: "class", members: [{ ...leaf, unavailable: reason }] });
                assert.strictEqual(footer().querySelectorAll(".notice").length, 1, "old states do not accumulate");
                assert(footer().querySelector(".notice--" + level));
                assert(footer().querySelector(".notice-text").textContent.includes(translate(key)));
                assert(!footer().textContent.includes(translate("lw.waitSamples")));
            }
            const copy = footer().querySelector(".notice-copy");
            copy.click();
            assert(page.messages.at(-1).text.includes("unknown internal reason _ZNraw"));
            const otherLanguage = language === "en" ? "zh" : "en";
            page.send({ type: "setLang", lang: otherLanguage });
            assert(
                footer().querySelector(".notice-text").textContent.includes(t(otherLanguage, "lw.pointeeUnavailable"))
            );
            page.send({ type: "setLang", lang: language });
            sample({ kind: "class", truncated: true, members: [leaf] });
            assert(footer().textContent.includes(translate("lw.layoutPartial")));
            sample({ kind: "class", members: [leaf] });
            assert(footer().hidden, "healthy snapshots clear the partial-layout warning");
            assert.strictEqual(footer().children.length, 0);

            // Equal-sized nested arrays get independent pagination actions at the footer.
            const array = {
                kind: "array",
                totalElements: 17,
                byteSize: 68,
                elementType: { byteSize: 4, watchType: "u32" }
            };
            page.send({
                type: listType,
                items: [
                    {
                        name: "arrays",
                        isComposite: true,
                        compositeLayout: {
                            kind: "class",
                            members: [
                                { name: "a", compositeLayout: array },
                                { name: "b", compositeLayout: array }
                            ]
                        }
                    }
                ]
            });
            assert.strictEqual(footer().querySelectorAll(".array-more").length, 2);
            footer().querySelector(".array-more .notice-action").click();
            assert.strictEqual(footer().querySelectorAll(".array-more").length, 1);
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
}

// The footer is the existing component for every level, including success.
{
    const dom = new JSDOM("<div id='root'></div><div id='footer'></div>");
    const root = dom.window.document.getElementById("root");
    const footer = dom.window.document.getElementById("footer");
    runtime.createVariableNotices(root, (key) => key, footer);
    for (const level of ["info", "warning", "error", "success"])
        runtime.renderVariableNotice(root, { level, text: level, sticky: true }, (key) => key);
    assert.strictEqual(footer.querySelectorAll(".notice-icon").length, 4);
    assert.strictEqual(footer.querySelectorAll(".notice-close").length, 0);
    const child = dom.window.document.createElement("div");
    // Pointees render detached, before their host is inserted beside the pointer row.
    child.variableNoticeParent = root;
    runtime.resetVariableNotices(child, (key) => key);
    runtime.renderVariableNotice(child, { level: "warning", text: "child warning" }, (key) => key);
    const grandchild = dom.window.document.createElement("div");
    grandchild.variableNoticeParent = child;
    runtime.resetVariableNotices(grandchild, (key) => key);
    runtime.renderVariableNotice(grandchild, { level: "info", text: "nested status" }, (key) => key);
    assert.strictEqual(footer.querySelectorAll(".notice").length, 6);
    assert.strictEqual(child.children.length, 0, "pointee messages use the owning card footer");
    runtime.resetVariableNotices(child, (key) => key);
    assert.strictEqual(footer.querySelectorAll(".notice").length, 4, "a pointee refresh clears its subtree only");
    dom.window.close();
}
console.log("Variable card notice severity, footer placement, loading, refresh, names, language and actions passed");
