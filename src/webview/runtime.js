"use strict";
(function (root, factory) {
    const runtime = factory();
    if (typeof module === "object" && module.exports) module.exports = runtime;
    else root.EmberProbeRuntime = runtime;
})(typeof globalThis === "object" ? globalThis : this, function () {
    const SUPPORTED_TYPES = ["u8", "i8", "u16", "i16", "u32", "i32", "f32", "u64", "i64", "f64"];
    const WIDTHS = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 };
    function typeByteLength(type) {
        return WIDTHS[type] || 4;
    }
    function defaultType(size) {
        return size === 1 ? "u8" : size === 2 ? "u16" : size === 8 ? "u64" : "u32";
    }
    function variableBaseName(name) {
        let depth = 0;
        for (let index = 0; index < name.length; index++) {
            if (name[index] === "<") depth++;
            else if (name[index] === ">") depth--;
            else if (!depth && (name[index] === "." || name[index] === "[")) {
                const suffix = name.slice(index).match(/^\.\d+(?=\.|\[|$)/);
                if (suffix) index += suffix[0].length - 1;
                else return name.slice(0, index);
            }
        }
        return name;
    }
    function variableDisplayName(item, symbols) {
        const name = item.name || "";
        const lookup = (key) =>
            typeof symbols?.get === "function" ? symbols.get(key) : symbols?.find((symbol) => symbol.name === key);
        const direct = lookup(name);
        if (direct?.displayName) return direct.displayName;
        const baseName = variableBaseName(name);
        const base = lookup(baseName);
        if (baseName !== name && base?.displayName) return base.displayName + name.slice(baseName.length);
        return item.displayName || name;
    }
    function renderVariableName(element, name, rawName = name) {
        let depth = 0;
        let split = 0;
        for (let index = 0; index < name.length; index++) {
            if (name[index] === "<" || name[index] === "[") depth++;
            else if (name[index] === ">" || name[index] === "]") depth--;
            else if (!depth && name[index] === ".") split = index + 1;
            else if (!depth && name.slice(index, index + 2) === "::") split = ++index + 1;
        }
        element.textContent = "";
        element.classList.toggle("qualified-name", split > 0 && split < name.length);
        if (split > 0 && split < name.length) {
            const prefix = element.ownerDocument.createElement("span");
            prefix.className = "variable-name-prefix";
            prefix.textContent = name.slice(0, split);
            const leaf = element.ownerDocument.createElement("span");
            leaf.className = "variable-name-leaf";
            leaf.textContent = name.slice(split);
            element.append(prefix, leaf);
        } else element.textContent = name;
        element.title = name === rawName ? name : `${name}\n${rawName}`;
        element.setAttribute("aria-label", name);
    }
    function translate(tables, language, key, params) {
        const table = tables[language] || tables.zh || {};
        const value = table[key] ?? tables.zh?.[key] ?? key;
        return String(value).replace(/{([a-zA-Z0-9_]+)}/g, (_match, name) =>
            params?.[name] != null ? String(params[name]) : ""
        );
    }
    function liveState(previous, message) {
        return {
            running:
                typeof message.intentEnabled === "boolean"
                    ? message.intentEnabled
                    : typeof message.running === "boolean"
                      ? message.running
                      : !!previous.running,
            canRead: typeof message.canRead === "boolean" ? message.canRead : !!previous.canRead,
            canWrite: typeof message.canWrite === "boolean" ? message.canWrite : !!previous.canWrite,
            fresh:
                message.source === "dap"
                    ? message.snapshotReady === true
                    : message.source === "openocd" && message.canRead === true
        };
    }
    return {
        SUPPORTED_TYPES,
        typeByteLength,
        defaultType,
        variableBaseName,
        variableDisplayName,
        renderVariableName,
        translate,
        liveState
    };
});
