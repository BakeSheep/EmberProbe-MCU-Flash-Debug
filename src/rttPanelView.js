"use strict";
const { STRINGS, t, normalizeLang, jsonForScript } = require("./i18n");
const { loadWebviewAsset } = require("./webviewTemplate");
const rttPanelCss = loadWebviewAsset("rttPanel", "app.css");
const rttPanelRenderer = loadWebviewAsset("rttPanel", "renderer.js");

// The bottom panel's RTT terminal: channel tabs, the output area and the input box below it.
function getRttPanelContent(lang) {
    const L = normalizeLang(lang);
    const tr = (key, params) => t(L, key, params);
    return `<!doctype html><html lang="${L === "zh" ? "zh-CN" : "en"}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';">
<title>${tr("rtt.panel.title")}</title><style>
${rttPanelCss}
</style></head><body>
<div class="tabs" id="tabs" role="tablist" hidden></div>
<div class="output" id="output" role="log" aria-label="${tr("rtt.panel.title")}"><div class="empty" id="empty" data-i18n="rtt.panel.empty">${tr("rtt.panel.empty")}</div><div class="lines" id="lines"></div></div>
<div class="input-error" id="inputError" role="alert" hidden></div>
<form class="input-row" id="inputRow" autocomplete="off"><span class="prompt" aria-hidden="true">›</span><input id="input" type="text" disabled spellcheck="false" placeholder="${tr("rtt.input.notRunning")}" aria-label="${tr("rtt.input.placeholder")}"></form>
<div class="raw-hint" id="rawHint" hidden data-i18n="rtt.panel.rawHint">${tr("rtt.panel.rawHint")}</div>
<script>window.__LANG__=${jsonForScript(L)};window.__I18N__=${jsonForScript(STRINGS)};</script>
<script>
${rttPanelRenderer}
</script></body></html>`;
}

module.exports = { getRttPanelContent };
