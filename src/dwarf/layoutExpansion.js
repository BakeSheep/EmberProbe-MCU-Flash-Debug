"use strict";

const crypto = require("crypto");
const { EXPANSION_TYPE_REF } = require("./types");

const LAYOUT_HANDLE_PATTERN = /^layout:([a-f0-9]{32}):([A-Za-z0-9_-]{1,172}):([a-f0-9]{64})$/;

function createLayoutExpansion(resolver) {
    const scope = crypto.randomBytes(16).toString("hex");
    const secret = crypto.randomBytes(32);
    const signature = (payload) =>
        crypto
            .createHmac("sha256", secret)
            .update(scope + ":" + payload)
            .digest();
    const handle = (ref) => {
        const payload = Buffer.from(JSON.stringify(ref)).toString("base64url");
        return "layout:" + scope + ":" + payload + ":" + signature(payload).toString("hex");
    };
    // Attach handles only after same-name candidate comparison. Internal references
    // never cross the Worker boundary and handles cannot affect layout identity.
    const annotate = (layout) => {
        if (!layout) return layout;
        const copy = { ...layout };
        if (
            ["depth-limit", "expansion-budget"].includes(layout.unobservable) &&
            layout[EXPANSION_TYPE_REF] !== undefined
        )
            copy.expansionHandle = handle(layout[EXPANSION_TYPE_REF]);
        if (layout.members) copy.members = layout.members.map(annotate);
        if (layout.elementType) copy.elementType = annotate(layout.elementType);
        if (layout.compositeLayout) copy.compositeLayout = annotate(layout.compositeLayout);
        return copy;
    };
    const expand = (token) => {
        const match = typeof token === "string" && token.length <= 280 && token.match(LAYOUT_HANDLE_PATTERN);
        if (!match)
            throw Object.assign(new Error("Invalid layout expansion handle"), { code: "INVALID_LAYOUT_HANDLE" });
        if (match[1] !== scope)
            throw Object.assign(new Error("Layout expansion handle belongs to an old ELF"), {
                code: "STALE_LAYOUT_HANDLE"
            });
        if (!crypto.timingSafeEqual(signature(match[2]), Buffer.from(match[3], "hex")))
            throw Object.assign(new Error("Invalid layout expansion signature"), { code: "INVALID_LAYOUT_HANDLE" });
        let ref;
        try {
            ref = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
        } catch {
            throw Object.assign(new Error("Invalid layout expansion reference"), { code: "INVALID_LAYOUT_HANDLE" });
        }
        if (!(Number.isSafeInteger(ref) && ref >= 0) && !(typeof ref === "string" && ref.length <= 128))
            throw Object.assign(new Error("Invalid layout expansion reference"), { code: "INVALID_LAYOUT_HANDLE" });
        return annotate(resolver.expandType(ref));
    };
    return { annotate, expand };
}

module.exports = { createLayoutExpansion, LAYOUT_HANDLE_PATTERN };
