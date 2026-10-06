/*
 * Injected into every generated webview page (sidebar / live watch) before the
 * real renderer scripts run. It provides the small slice of the VS Code webview
 * API that the renderers use and forwards commands to the mock host page.
 */
(function () {
    "use strict";

    var persisted = {};
    var seeded = false;
    var pendingButtons = [];

    window.addEventListener("message", function (event) {
        if (event.source !== window.parent || !event.data || event.data.type !== "mockDebugPending") return;
        if (event.data.busy) {
            if (pendingButtons.length) return;
            document.querySelectorAll(".primary-actions [data-command]").forEach(function (button) {
                pendingButtons.push({ button: button, disabled: button.disabled });
                button.disabled = true;
                button.setAttribute("aria-busy", "true");
            });
        } else {
            pendingButtons.forEach(function (item) {
                item.button.disabled = item.disabled;
                item.button.removeAttribute("aria-busy");
            });
            pendingButtons = [];
        }
    });

    function readMeta(name) {
        var value = document.body && document.body.getAttribute(name);
        return value || "";
    }

    window.acquireVsCodeApi = function acquireVsCodeApi() {
        return {
            postMessage: function postMessage(message) {
                try {
                    window.parent.postMessage(
                        {
                            __emberprobeMock: true,
                            page: readMeta("data-mock-page"),
                            lang: readMeta("data-mock-lang"),
                            message: message
                        },
                        "*"
                    );
                } catch (error) {
                    /* The mock shell is optional; ignore detached frames. */
                }
            },
            getState: function getState() {
                if (!seeded) {
                    if (readMeta("data-mock-page") === "sidebar") persisted.rtosExpanded = true;
                    if (readMeta("data-mock-page") === "livewatch") persisted.sideWidth = 280;
                    seeded = true;
                }
                return persisted;
            },
            setState: function setState(next) {
                persisted = next && typeof next === "object" ? next : {};
            }
        };
    };
})();
