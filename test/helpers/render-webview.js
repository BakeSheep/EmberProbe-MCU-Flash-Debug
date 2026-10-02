"use strict";
const { JSDOM, VirtualConsole } = require("jsdom");
const assert = require("assert");
function render(html, initialState = {}) {
    let uiState = JSON.parse(JSON.stringify(initialState));
    const messages = [],
        errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => {
        if (error.type !== "css parsing") errors.push(error);
    });
    const dom = new JSDOM(html, {
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
        }
    });
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
