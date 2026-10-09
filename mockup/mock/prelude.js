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
    var operationStatus = null;

    function applyAvailability() {
        if (!operationStatus) return;
        var availability = operationStatus.availability || {};
        function gate(selector, available) {
            if (typeof available !== "boolean") return;
            document.querySelectorAll(selector).forEach(function (button) {
                if (button.disabled === available) button.disabled = !available;
                var busy = !!operationStatus.operation && !available;
                if (busy && button.getAttribute("aria-busy") !== "true") button.setAttribute("aria-busy", "true");
                if (!busy && button.hasAttribute("aria-busy")) button.removeAttribute("aria-busy");
            });
        }
        gate('[data-command="mcu-vscode.download"]', availability.download);
        gate('[data-command="mcu-vscode.debug"]', availability.debug);
        gate("#chipRead", availability.chipRead);
        gate(".chip-control", availability.chipControl);
        gate("#jlinkDriverChoice", availability.driver);
        gate("#backendSelect", availability.backend);
        gate("#liveToggle, #run, #chartEmpty button", availability.live);
    }

    var observer = new MutationObserver(applyAvailability);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });

    window.addEventListener("message", function (event) {
        if (event.source !== window.parent || event.data?.type !== "mockOperationStatus") return;
        operationStatus = event.data;
        applyAvailability();
    });

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

    window.addEventListener("keydown", function (event) {
        var modified = event.ctrlKey || event.metaKey;
        var key = event.key.toLowerCase();
        if (
            !["F5", "F6", "F10", "F11"].includes(event.key) &&
            !(modified && (["b", "j", "`"].includes(key) || (event.shiftKey && key === "p")))
        )
            return;
        event.preventDefault();
        window.parent.postMessage(
            {
                __emberprobeMockShortcut: true,
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey
            },
            "*"
        );
    });

    function readMeta(name) {
        var value = document.body && document.body.getAttribute(name);
        return value || "";
    }

    window.acquireVsCodeApi = function acquireVsCodeApi() {
        return {
            postMessage: function postMessage(message) {
                try {
                    if (
                        operationStatus &&
                        ["writeVariable", "peripheralReadRequest", "peripheralWriteRequest", "rtosRefresh"].includes(
                            message.type
                        )
                    )
                        message = Object.assign({}, message, { mockEpoch: operationStatus.epoch });
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
