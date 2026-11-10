"use strict";
const { MAX_INPUT_BYTES, MAX_WRITE_BYTES } = require("../services/rttTerminalService");
const { routeFor } = require("./webviewRoutes");

// Message routes of the bottom panel's RTT terminal. A route takes the page ({ host, panel, post, vscode }, where host
// is the MainViewProvider and panel its RttPanelHost) and the message.

const validChannel = (channel) => Number.isSafeInteger(channel) && channel >= 0;

const RTT_PANEL_ROUTES = {
    // The page loaded or reloaded: it gets everything the channels hold, then output as it comes.
    ready: ({ host, panel, post }) => {
        post(host._rttTerminals.panelSnapshot());
        panel.pageReady();
    },
    // A line typed into the input box; the page hears how it ended.
    rttSend: ({ host, post }, message) => {
        const { id, channel, text } = message;
        const valid =
            validChannel(channel) &&
            typeof text === "string" &&
            !/[\x00-\x1f\x7f]/.test(text) &&
            Buffer.byteLength(text, "utf8") <= MAX_INPUT_BYTES;
        const result = valid
            ? host._rttTerminals.sendInput(channel, text)
            : { ok: false, message: host._t("rtt.input.invalid") };
        post({ type: "rttSendResult", id, ok: result.ok, message: result.message });
    },
    // A keystroke in raw mode; only a refusal is reported back.
    rttSendRaw: ({ host, post }, message) => {
        const { channel, data } = message;
        const valid =
            validChannel(channel) &&
            typeof data === "string" &&
            data.length > 0 &&
            Buffer.byteLength(data, "utf8") <= MAX_WRITE_BYTES;
        const result = valid
            ? host._rttTerminals.sendRaw(channel, data)
            : { ok: false, message: host._t("rtt.input.invalid") };
        if (!result.ok) post({ type: "rttInputProblem", channel, message: result.message });
    },
    rttClear: ({ host }, message) => {
        if (validChannel(message.channel)) host._rttTerminals.clearChannel(message.channel);
    }
};

// The message handler of the panel's view. Messages of unknown types are ignored.
function createRttPanelHandler(host, panel, vscode) {
    const page = {
        host,
        panel,
        vscode,
        // Replies go straight to the page, even before it reported ready.
        post: (message) => Promise.resolve(panel._view?.webview.postMessage(message)).catch(() => {})
    };
    return async (message) => {
        const route = routeFor(RTT_PANEL_ROUTES, message);
        if (route) await route(page, message);
    };
}

module.exports = { RTT_PANEL_ROUTES, createRttPanelHandler };
