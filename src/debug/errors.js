"use strict";
const i18n = require("../i18n");

// Errors the adapter shows the user carry a key, so VS Code's debug UI shows them in the language chosen in the
// sidebar. GDB's own messages have none and stay as GDB wrote them.
function debugError(key, message, params) {
    return Object.assign(new Error(message), { i18nKey: "dbg." + key, ...(params ? { i18nParams: params } : {}) });
}

// The extension passes the sidebar's language with each configuration; a session started some other way follows
// VS Code's display language.
function adapterLanguage(configured, env = process.env) {
    if (configured) return i18n.normalizeLang(configured);
    try {
        return i18n.matchVscodeLang(JSON.parse(env.VSCODE_NLS_CONFIG || "{}").locale);
    } catch {
        return i18n.DEFAULT_LANG;
    }
}

function localizeError(error, lang) {
    const key =
        error?.i18nKey ||
        (error?.code && i18n.STRINGS[i18n.DEFAULT_LANG]["err." + error.code] != null ? "err." + error.code : "");
    return key ? i18n.t(lang, key, error.i18nParams) : String(error?.message || error);
}

module.exports = { debugError, adapterLanguage, localizeError };
