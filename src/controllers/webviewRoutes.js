"use strict";
const { webviewSettings } = require("../services/webviewSettings");

// Message routes of the webview pages, keyed by message type. A route takes the page it serves and the message; the
// page is { host, post, watchKey, vscode }, where host is the MainViewProvider and watchKey the page's watch list.

// Messages both the sidebar and the chart panels send.
const SHARED_ROUTES = {
    getWebviewSettings: ({ post, vscode }) => post(webviewSettings(vscode)),
    copyText: ({ host }, message) => host._copyToClipboard(message.text),
    setLang: ({ host }, message) => {
        host._setLang(message.lang);
        host._postLive({ type: "setLang", lang: host._lang });
    },
    expandLayout: ({ host, post, view, entry }, message) =>
        host._elfView.handleLayoutExpansion(message, post, view || entry),
    resolveCompositeLayout: async ({ host, post }, message) => {
        const { name, version, generation, promote } = message;
        const reply = { type: "compositeLayoutResult", name, version, generation };
        try {
            const layout = await host._elfView.resolveLayout(name, version, {
                generation,
                background: message.background === true && promote !== true
            });
            if (promote !== true) post({ ...reply, layout, ...host._elfView.layoutExpansionSnapshot(name) });
        } catch (error) {
            if (promote !== true) post({ ...reply, error: error.message });
        }
    },
    saveRuntimeExpansions: ({ host, watchKey }, message) => host._saveRuntimeExpansions(watchKey, message.expansions)
};

function isWebviewMessage(message) {
    return !!message && typeof message === "object" && !Array.isArray(message) && typeof message.type === "string";
}

// The route for a webview message, or null for anything that is not a message of a known type.
function routeFor(routes, message) {
    return isWebviewMessage(message) && Object.hasOwn(routes, message.type) ? routes[message.type] : null;
}

module.exports = { SHARED_ROUTES, isWebviewMessage, routeFor };
