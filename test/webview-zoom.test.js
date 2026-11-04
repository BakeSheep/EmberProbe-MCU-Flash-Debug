"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { scenario } = require("./helpers/scenario");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { createSidebarHandler } = require("../src/controllers/sidebarRoutes");
const { createLivePanelHandler } = require("../src/controllers/livePanelRoutes");
const { broadcastWebviewSettings } = require("../src/services/webviewSettings");
const pageZoom = require("../src/webview/pageZoom");

function wheel(page, target, options = {}) {
    const event = new page.window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -100,
        ctrlKey: true,
        ...options
    });
    target.dispatchEvent(event);
    page.assertHealthy();
    return event;
}

(async () => {
    await scenario("Both page routes read the editor setting and updates reach all open pages", async () => {
        let enabled = false;
        const sidebar = [],
            first = [],
            second = [];
        const vscode = {
            workspace: {
                getConfiguration: (section) => {
                    assert.strictEqual(section, "editor");
                    return {
                        get: (key, fallback) => {
                            assert.strictEqual(key, "mouseWheelZoom");
                            assert.strictEqual(fallback, false);
                            return enabled;
                        }
                    };
                }
            }
        };
        const entry = { panelId: 1, post: (message) => first.push(message) };
        const host = {
            _webviewView: { webview: { postMessage: (message) => sidebar.push(message) } },
            _livePanels: new Map([
                [1, entry],
                [2, { post: (message) => second.push(message) }]
            ])
        };
        await createSidebarHandler(host, host._webviewView, vscode)({ type: "getWebviewSettings" });
        await createLivePanelHandler(host, entry, vscode)({ type: "getWebviewSettings", panelId: 1 });
        assert.deepStrictEqual(sidebar, [{ type: "webviewSettings", mouseWheelZoom: false }]);
        assert.deepStrictEqual(first, sidebar);
        enabled = true;
        broadcastWebviewSettings(host, vscode);
        for (const posts of [sidebar, first, second])
            assert.deepStrictEqual(posts.at(-1), { type: "webviewSettings", mouseWheelZoom: true });
        host._webviewView = null;
        enabled = "true";
        broadcastWebviewSettings(host, vscode);
        assert.strictEqual(second.at(-1).mouseWheelZoom, false, "only boolean true enables zoom");
    });

    for (const [name, html, targetId] of [
        ["sidebar", getModernWebviewContent({}, "en"), "writeValues"],
        ["waveform", getLiveWatchContent({ panelId: 1 }, "en"), "chart"]
    ]) {
        scenario(`${name} gates local zoom, captures before controls and preserves page state`, () => {
            const page = render(html);
            try {
                const target = page.document.getElementById(targetId),
                    root = page.document.documentElement;
                let received = 0;
                target.addEventListener("wheel", () => received++);
                assert.ok(page.messages.some((message) => message.type === "getWebviewSettings"));
                wheel(page, target);
                assert.strictEqual(root.style.zoom, "1", "disabled by default");
                assert.strictEqual(received, 1);
                page.send({ type: "webviewSettings", mouseWheelZoom: true });
                wheel(page, target, { ctrlKey: false });
                assert.strictEqual(root.style.zoom, "1", "ordinary wheels retain their behavior");
                assert.strictEqual(received, 2);
                assert.strictEqual(wheel(page, target).defaultPrevented, true);
                assert.strictEqual(received, 2, "zoom never reaches waveform or write handlers");
                assert.strictEqual(root.style.zoom, "1.1");
                assert.strictEqual(page.getState().pageZoom, 1.1);
                assert.strictEqual(
                    page.messages.some((message) => message.type === "webviewZoom"),
                    false
                );
                assert.ok(parseFloat(root.style.getPropertyValue("--emberprobe-vh")) < page.window.innerHeight / 100);
                wheel(page, target, { deltaY: 100 });
                assert.strictEqual(root.style.zoom, "1");
                for (let i = 0; i < 30; i++) wheel(page, target);
                assert.strictEqual(root.style.zoom, "2", "upper bound");
                for (let i = 0; i < 30; i++) wheel(page, target, { deltaY: 100 });
                assert.strictEqual(root.style.zoom, "0.5", "lower bound");
                page.send({ type: "webviewSettings", mouseWheelZoom: false });
                wheel(page, target);
                assert.strictEqual(root.style.zoom, "0.5", "setting changes take effect immediately");
                assert.strictEqual(received, 3);
                if (name === "sidebar") page.document.getElementById("langToggle").click();
                else page.document.getElementById("sideToggle").click();
                assert.strictEqual(page.getState().pageZoom, 0.5, "other state saves preserve zoom");
                const restored = render(html, page.getState());
                try {
                    restored.assertHealthy();
                    assert.strictEqual(restored.document.documentElement.style.zoom, "0.5");
                } finally {
                    restored.close();
                }
                page.assertHealthy();
            } finally {
                page.close();
            }
        });
    }

    scenario("Wheel units, small deltas, platform modifiers, independent pages and disposal", () => {
        const page = render(
            getModernWebviewContent({}, "en"),
            {},
            {
                beforeParse: (window) => Object.defineProperty(window.navigator, "platform", { value: "MacIntel" })
            }
        );
        const other = render(getLiveWatchContent({}, "en"));
        try {
            const root = page.document.documentElement;
            page.send({ type: "webviewSettings", mouseWheelZoom: true });
            wheel(page, root, { ctrlKey: false, metaKey: true, deltaY: -2, deltaMode: 1 });
            assert.strictEqual(root.style.zoom, "1");
            wheel(page, root, { ctrlKey: false, metaKey: true, deltaY: -2, deltaMode: 1 });
            assert.strictEqual(root.style.zoom, "1.1");
            wheel(page, root, { deltaY: 1, deltaMode: 2 });
            assert.strictEqual(root.style.zoom, "1");
            for (const options of [{ altKey: true }, { shiftKey: true }, { deltaY: 0, deltaX: -100 }])
                assert.strictEqual(wheel(page, root, options).defaultPrevented, false);
            assert.strictEqual(other.document.documentElement.style.zoom, "1");
            other.send({ type: "webviewSettings", mouseWheelZoom: true });
            assert.strictEqual(
                wheel(other, other.document.body, { ctrlKey: false, metaKey: true }).defaultPrevented,
                false
            );
            const dom = new JSDOM("<main></main>");
            try {
                const state = {};
                const dispose = pageZoom.create({ target: dom.window, state, saved: NaN, save() {} });
                dom.window.dispatchEvent(
                    new dom.window.MessageEvent("message", {
                        data: { type: "webviewSettings", mouseWheelZoom: true }
                    })
                );
                dispose();
                dom.window.dispatchEvent(new dom.window.WheelEvent("wheel", { ctrlKey: true, deltaY: -100 }));
                assert.strictEqual(state.pageZoom.factor, 1);
            } finally {
                dom.window.close();
            }
        } finally {
            page.close();
            other.close();
        }
    });

    scenario("Zoomed rectangles and viewport coordinates stay in layout pixels", () => {
        const dom = new JSDOM("<main></main>");
        try {
            const doc = dom.window.document;
            doc.documentElement.style.zoom = "2";
            const main = doc.querySelector("main");
            main.getBoundingClientRect = () => ({
                left: 20,
                right: 420,
                top: 40,
                bottom: 240,
                width: 400,
                height: 200
            });
            assert.deepStrictEqual(pageZoom.rect(main), {
                left: 10,
                right: 210,
                top: 20,
                bottom: 120,
                width: 200,
                height: 100
            });
            assert.strictEqual(pageZoom.coordinate(140, doc) - pageZoom.rect(main).top, 50);
            assert.deepStrictEqual(pageZoom.point({ clientX: 220, clientY: 140 }, main), { x: 100, y: 50 });
            assert.strictEqual(pageZoom.viewport(dom.window).width, dom.window.innerWidth / 2);
        } finally {
            dom.window.close();
        }
    });
    console.log("Webview mouse wheel zoom tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
