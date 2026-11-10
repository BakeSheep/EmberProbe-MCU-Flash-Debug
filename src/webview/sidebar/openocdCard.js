"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeOpenocdCard = factory();
})(globalThis, function () {
    // The OpenOCD environment banner in the sidebar's global notice area: checking and preparing show progress,
    // anything but ready stays as an actionable notice. The renderer owns the notice areas, so the card only
    // renders the state and caches the visible fields for a rebuilt view.
    function create({ api, uiState, setNotice, clearNotice }) {
        let last = uiState.sidebarStatus?.openocd || null;
        function render(message) {
            const m = message || last;
            if (!m) return;
            last = m;
            uiState.sidebarStatus ||= {};
            const { state, key, params, message: text } = m;
            uiState.sidebarStatus.openocd = { state, key, params, message: text };
            api?.setState?.(uiState);
            const k = m.state || "checking",
                busy = k === "checking" || k === "preparing";
            if (k === "ready") return clearNotice("global", "openocd");
            const action = (labelKey, name, primary) => ({
                label: { key: labelKey },
                primary,
                message: { type: "openocdAction", action: name }
            });
            setNotice("global", "openocd", {
                level: busy ? "info" : k === "missing" ? "warning" : "error",
                busy,
                title: { key: "sb.openocdEnv" },
                text: m.key ? { key: m.key, params: m.params } : m.message || { key: "oc.checking" },
                actions: busy ? [] : [action("sb.selectPath", "select", true), action("sb.recheck", "check")],
                dismissible: false
            });
        }
        return {
            render() {
                render(last);
            },
            onStatus(message) {
                render(message || {});
            }
        };
    }
    return { create };
});
