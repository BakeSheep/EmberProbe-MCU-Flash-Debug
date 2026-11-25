/*
 * Injected into every generated webview page (sidebar / live watch) before the
 * real renderer scripts run. It provides the small slice of the VS Code webview
 * API that the renderers use and forwards commands to the mock host page.
 */
(function () {
    "use strict";

    var persisted = {};

    function updateConfiguration({ rows, firmware, notSelected }) {
        for (const [command, item] of Object.entries(rows)) {
            const node = document.querySelector(`[data-command="${command}"] .row-copy > small`);
            if (!node) continue;
            node.textContent = item.value || notSelected;
            node.title = item.title;
            if (item.value) delete node.dataset.i18n;
            else node.dataset.i18n = "common.notSelected";
        }
        const card = document.querySelector(".cubemx-config-row");
        if (!card) return;
        const label = card.querySelector(".cubemx-firmware-label");
        label.dataset.i18n = label.dataset.i18nTitle = firmware.labelKey;
        label.textContent = label.title = firmware.label;
        const pack = card.querySelector(".cubemx-package");
        if (pack) {
            pack.hidden = firmware.hidden === true;
            pack.title = [firmware.vendor, firmware.name].filter(Boolean).join("::");
            pack.querySelector(".cubemx-package-name").textContent = firmware.name;
            pack.querySelector(".cubemx-current-version").textContent = firmware.versions.join(", ");
        }
    }

    window.addEventListener("message", function (event) {
        if (event.source !== window.parent || !event.data) return;
        if (event.data.type === "mockConfiguration") return updateConfiguration(event.data);
        if (event.data.type !== "mockDebugPending") return;
        if (event.data.busy) {
            const status = document.getElementById("statusText");
            const flashStatus = document.getElementById("flashStatus");
            const statusDot = document.getElementById("statusDot");
            if (status && event.data.text) status.textContent = event.data.text;
            if (flashStatus) flashStatus.dataset.state = "busy";
            if (statusDot) statusDot.className = "status-dot";
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
                return persisted;
            },
            setState: function setState(next) {
                persisted = next && typeof next === "object" ? next : {};
            }
        };
    };
})();
