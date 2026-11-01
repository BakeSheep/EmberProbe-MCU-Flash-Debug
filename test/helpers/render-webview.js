"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const { JSDOM, VirtualConsole } = require("jsdom");
const assert = require("assert");
const { WEBVIEW_ROOT, rendererPrelude } = require("../../src/webviewTemplate");

// The views inline each page script as one block of concatenated files. Coverage cannot map code in an inline block
// back to its source, so render() runs a known block file by file instead, each under its own name. One compiled
// script per file is shared by every page that runs it.
const PAGE_SCRIPTS = [
    ...["sidebar", "liveWatch"].map((area) => [...rendererPrelude(area), [area, "renderer.js"]]),
    [["liveWatch", "viewport.js"]]
].map((files) => {
    const sources = files.map(([dir, name]) => path.join(WEBVIEW_ROOT, dir, name));
    const texts = sources.map((file) => fs.readFileSync(file, "utf8"));
    // Matches how loadWebviewAsset joins a renderer's prelude.
    const text = texts.length > 1 ? texts.slice(0, -1).join("\n") + "\n" + texts.at(-1) : texts[0];
    let compiled;
    return {
        text,
        scripts: () =>
            (compiled ??= sources.map(
                (file, index) => new vm.Script(texts[index], { filename: pathToFileURL(file).href })
            ))
    };
});

// Takes the known page script blocks out of the markup, in document order. They must be the last scripts on the page,
// since they run once parsing is done.
function splitPageScripts(html) {
    const found = [];
    for (const page of PAGE_SCRIPTS) {
        const at = html.indexOf(page.text);
        if (at < 0) continue;
        const open = html.lastIndexOf("<script", at);
        const close = html.indexOf("</script>", at + page.text.length);
        const before = html.slice(html.indexOf(">", open) + 1, at);
        const after = html.slice(at + page.text.length, close);
        if (open < 0 || close < 0 || before.trim() || after.trim()) continue;
        found.push({ page, start: open, end: close + "</script>".length });
    }
    found.sort((a, b) => a.start - b.start);
    let markup = html;
    for (const { start, end } of [...found].reverse()) markup = markup.slice(0, start) + markup.slice(end);
    if (found.length && markup.indexOf("<script", found[0].start) >= 0)
        throw new Error("render(): an inline script follows the page scripts, which run after parsing");
    return { markup, pages: found.map(({ page }) => page) };
}

function render(html, initialState = {}, options = {}) {
    let uiState = JSON.parse(JSON.stringify(initialState));
    const messages = [],
        errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => {
        if (error.type !== "css parsing") errors.push(error);
    });
    const { markup, pages } = splitPageScripts(String(html));
    const dom = new JSDOM(markup, {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
            window.acquireVsCodeApi = () => ({
                postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))),
                getState: () => JSON.parse(JSON.stringify(uiState)),
                setState: (state) => {
                    uiState = JSON.parse(JSON.stringify(state));
                }
            });
            window.ResizeObserver = class {
                observe() {}
                disconnect() {}
            };
            window.requestAnimationFrame = () => 1;
            window.cancelAnimationFrame = () => {};
            window.HTMLCanvasElement.prototype.getContext = () =>
                new Proxy(
                    {},
                    {
                        get: (_target, key) =>
                            key === "measureText"
                                ? (text) => ({ width: String(text).length * 7 })
                                : key === "createLinearGradient"
                                  ? () => ({ addColorStop() {} })
                                  : () => {}
                    }
                );
            // A FakeClock in options.clock drives the page's timeouts instead of real time.
            if (options.clock) {
                window.setTimeout = (fn, ms = 0, ...args) => options.clock.schedule(() => fn(...args), ms);
                window.clearTimeout = (id) => options.clock.cancel(id);
            }
            // Lets a test replace window globals (e.g. timers) before page scripts run.
            if (options.beforeParse) options.beforeParse(window);
        }
    });
    const context = dom.getInternalVMContext();
    // Like the inline block it replaces, a page script stops at its first uncaught error.
    for (const page of pages) {
        try {
            for (const script of page.scripts()) script.runInContext(context);
        } catch (error) {
            errors.push(error);
        }
    }
    return {
        window: dom.window,
        document: dom.window.document,
        messages,
        getState: () => JSON.parse(JSON.stringify(uiState)),
        send(message) {
            dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
            assert.deepStrictEqual(errors, []);
        },
        assertHealthy() {
            assert.deepStrictEqual(errors, []);
        },
        close() {
            dom.window.close();
        }
    };
}
module.exports = { render };
