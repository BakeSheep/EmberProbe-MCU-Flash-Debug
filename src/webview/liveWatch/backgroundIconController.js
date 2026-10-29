"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./backgroundIcon"));
    else root.EmberProbeBackgroundIconController = factory(root.EmberProbeBackgroundIcon);
})(globalThis, function (Icon) {
    function create({ document, post, changed, importFile = Icon.importFile }) {
        let icon = null,
            cache = null,
            latestRequest = 0;
        return {
            receive(message) {
                try {
                    icon = message.icon === null ? null : Icon.validate(message.icon);
                } catch {
                    return;
                }
                cache = null;
                changed();
            },
            async importPng(message) {
                if (!Number.isSafeInteger(message.requestId) || message.requestId <= latestRequest) return;
                const requestId = (latestRequest = message.requestId);
                try {
                    if (
                        typeof message.pngBase64 !== "string" ||
                        message.pngBase64.length > 4 * Math.ceil(Icon.MAX_FILE_BYTES / 3)
                    )
                        throw Object.assign(new Error("size"), { code: "size" });
                    const bytes = Uint8Array.from(atob(message.pngBase64), (c) => c.charCodeAt(0));
                    const value = await importFile(new Blob([bytes], { type: "image/png" }));
                    if (requestId !== latestRequest) return;
                    post({ type: "chartBackgroundIconImported", requestId, icon: value });
                } catch (error) {
                    if (requestId !== latestRequest) return;
                    const errorCode = ["size", "background", "empty"].includes(error.code) ? error.code : "invalid";
                    post({ type: "chartBackgroundIconImported", requestId, errorCode });
                }
            },
            bitmap(style) {
                if (!icon) return null;
                const color = style.getPropertyValue("--vscode-foreground").trim() || "#808080";
                if (!cache || cache.color !== color) cache = { color, bitmap: Icon.tinted(icon, color, document) };
                return cache.bitmap;
            }
        };
    }
    return { create };
});
