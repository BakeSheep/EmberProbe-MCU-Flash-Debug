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
    function runtimeWatchEntry(name, symbol, segments = []) {
        const graph = symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout;
        if (!graph) return null;
        const unwrap = (id) => {
            for (let depth = 0; depth < 32; depth++) {
                const type = graph.types[id];
                if (!type) return null;
                if (type.kind !== "alias") return type;
                id = type.target;
            }
            return null;
        };
        const rootType = unwrap(graph.root);
        if (!rootType) return null;
        // Aggregates containing STL use semantic reads too. Their unrelated raw pointers
        // stay as address values; only paths through STL may chase target storage.
        const hasPointerTypes = (graph.types || []).some(
            (entry) => entry?.kind === "pointer" || entry?.kind === "reference"
        );
        const hasContainers = runtimeContainsContainer(graph, graph.root);
        if (hasPointerTypes && !hasContainers) return null;
        if (segments.some((segment) => segment?.kind === "dereference")) return null;
        const field = (type, name) => runtimeFieldType(graph, type, name);
        const inherits = (type, base, seen = new Set()) => {
            if (!type || seen.has(type)) return false;
            if (type === base) return true;
            seen.add(type);
            return (type.fields || []).some((entry) => entry.isBase && inherits(unwrap(entry.type), base, seen));
        };
        const member = (type, name) => {
            const known = field(type, name);
            if (known) return known;
            if (!type?.fields?.some((entry) => entry.name.startsWith("_vptr"))) return null;
            const candidates = (graph.dynamicTypes || [])
                .map((entry) => unwrap(entry.type))
                .filter((entry) => inherits(entry, type))
                .map((entry) => field(entry, name))
                .filter(Boolean);
            return candidates.length &&
                candidates.every(
                    (entry) =>
                        entry.kind === candidates[0].kind &&
                        entry.typeName === candidates[0].typeName &&
                        entry.watchType === candidates[0].watchType &&
                        entry.byteSize === candidates[0].byteSize
                )
                ? candidates[0]
                : null;
        };
        let type = rootType;
        let enteredContainer = !!rootType.stl;
        for (const segment of segments) {
            if (!type) return null;
            if (["pointer", "reference"].includes(type.kind) && !enteredContainer) return null;
            if (type.kind === "reference") type = unwrap(type.target);
            if (type?.kind === "pointer") {
                type = unwrap(type.target);
                if (segment.kind === "dereference" || (segment.kind === "member" && segment.name === "value")) continue;
            } else if (segment.kind === "dereference") return null;
            if (type?.stl) {
                enteredContainer = true;
                if (segment.kind === "index" || (segment.kind === "member" && segment.name === "value")) {
                    if (segment.kind === "index" && (!Number.isSafeInteger(segment.index) || segment.index < 0))
                        return null;
                    const named = ["unique_ptr", "shared_ptr", "weak_ptr", "optional", "variant"].includes(type.stl);
                    if ((segment.kind === "index" && named) || (segment.kind === "member" && !named)) return null;
                    if (/map$/.test(type.stl)) {
                        const pairs = graph.types.filter(
                            (entry) =>
                                entry.stl === "pair" &&
                                entry.args?.length === 2 &&
                                entry.args.every(
                                    (id, index) => unwrap(id)?.typeName === unwrap(type.args[index])?.typeName
                                )
                        );
                        type =
                            pairs.length &&
                            pairs.every(
                                (entry) => entry.typeName === pairs[0].typeName && entry.byteSize === pairs[0].byteSize
                            )
                                ? pairs[0]
                                : null;
                    } else if (type.stl === "tuple") type = unwrap(type.args?.[segment.index]);
                    else if (type.stl === "variant") {
                        const alternatives = type.args.map(unwrap);
                        type = alternatives.every((entry) => entry?.watchType === alternatives[0]?.watchType)
                            ? alternatives[0]
                            : null;
                    } else type = unwrap(type.args?.[0]);
                } else if (type.stl === "pair" && ["first", "second"].includes(segment.name))
                    type = unwrap(type.args[segment.name === "first" ? 0 : 1]);
                else return null;
            } else if (segment.kind === "index" && type?.kind === "array") {
                if (!Number.isSafeInteger(segment.index) || segment.index < 0 || segment.index >= type.count)
                    return null;
                type = unwrap(type.target);
            } else if (segment.kind === "member") type = member(type, segment.name);
            else return null;
        }
        if (type?.stl) enteredContainer = true;
        const rawPointer = !enteredContainer && ["pointer", "reference"].includes(type?.kind);
        if (type?.kind === "reference" && !rawPointer) type = unwrap(type.target);
        if (!type || type.kind === "unavailable" || (type.kind === "scalar" && !type.watchType)) return null;
        return {
            name,
            address: symbol.address,
            size: symbol.size,
            type: rawPointer ? "u32" : type.watchType || "",
            isComposite: !rawPointer && type.kind !== "scalar",
            compositeLayout: symbol.compositeLayout || null,
            runtimeLayout: graph,
            runtimeSegments: segments,
            ...(hasContainers && !enteredContainer ? { runtimeStaticPointers: true } : {}),
            ...(symbol.displayName && symbol.name === name ? { displayName: symbol.displayName } : {})
        };
    }
    function runtimeGraph(symbol) {
        return symbol?.runtimeLayout || symbol?.compositeLayout?.runtimeLayout || null;
    }
    function runtimeType(graph, id) {
        for (let depth = 0; graph && depth < 32; depth++) {
            const type = graph.types?.[id];
            if (!type || type.kind !== "alias") return type || null;
            id = type.target;
        }
        return null;
    }
    function runtimeContainsContainer(graph, id, seen = new Set(), depth = 0) {
        const type = runtimeType(graph, id);
        if (!type || seen.has(type) || depth > 32) return false;
        if (type.stl) return true;
        seen.add(type);
        if (type.kind === "array") return runtimeContainsContainer(graph, type.target, seen, depth + 1);
        // Pointers are storage values here, not owned nested objects.
        return (
            ["class", "union"].includes(type.kind) &&
            (type.fields || []).some((field) => runtimeContainsContainer(graph, field.type, seen, depth + 1))
        );
    }
    function runtimeFieldType(graph, type, name, seen = new Set(), depth = 0) {
        if (!type || seen.has(type) || depth > 12) return null;
        const direct = (type.fields || []).filter((field) => field.name === name);
        if (direct.length) return direct.length === 1 ? runtimeType(graph, direct[0].type) : null;
        const next = new Set(seen).add(type);
        const inherited = (type.fields || [])
            .filter((field) => field.isBase || field.name === "?")
            .map((field) => runtimeFieldType(graph, runtimeType(graph, field.type), name, next, depth + 1))
            .filter(Boolean);
        return inherited.length === 1 ? inherited[0] : null;
    }
    // A rejected semantic path must never become a raw STL storage watch.
    function requiresRuntimePath(symbol, segments = []) {
        const graph = runtimeGraph(symbol);
        let type = runtimeType(graph, graph?.root);
        for (const segment of segments) {
            if (type?.stl) return true;
            if (segment.kind === "member") type = runtimeFieldType(graph, type, segment.name);
            else if (["index", "range", "all"].includes(segment.kind) && type?.kind === "array")
                type = runtimeType(graph, type.target);
            else return false;
        }
        return !!type && runtimeContainsContainer(graph, graph.types.indexOf(type));
    }
    function runtimeSelection(symbol, tree) {
        const graph = runtimeGraph(symbol);
        if (!runtimeContainsContainer(graph, graph?.root)) return null;
        const entries = [];
        const add = (segments) => {
            const suffix = segments.map((s) => (s.kind === "index" ? `[${s.index}]` : `.${s.name}`)).join("");
            const entry = runtimeWatchEntry(symbol.name + suffix, symbol, segments);
            if (entry && suffix && !entries.some((item) => item.path === entry.name))
                entries.push({ ...entry, path: entry.name, label: suffix, typeName: entry.type });
        };
        const walkTree = (node, segments, depth = 0) => {
            if (!node || node.unavailable || depth > 12 || entries.length >= 200) return;
            if (Object.prototype.hasOwnProperty.call(node, "value")) add(segments);
            else {
                if (segments.length && requiresRuntimePath(symbol, segments)) add(segments);
                for (const member of node.members || [])
                    walkTree(
                        member,
                        member.name === "?" || /^@base\d+$/.test(member.name)
                            ? segments
                            : [...segments, { kind: "member", name: member.name }],
                        depth + 1
                    );
                for (const element of node.elements || [])
                    walkTree(element, [...segments, { kind: "index", index: element.index }], depth + 1);
            }
        };
        const walkType = (id, segments, depth = 0) => {
            const type = runtimeType(graph, id);
            if (!type || depth > 12 || entries.length >= 200) return;
            if (type.stl && segments.length) add(segments);
            if (["scalar", "pointer", "reference"].includes(type.kind)) return add(segments);
            if (["unique_ptr", "shared_ptr", "weak_ptr", "optional"].includes(type.stl)) {
                const path = [...segments, { kind: "member", name: "value" }];
                add(path);
                return walkType(type.args?.[0], path, depth + 1);
            }
            if (type.stl === "variant") return add([...segments, { kind: "member", name: "value" }]);
            if (type.stl === "pair") {
                ["first", "second"].forEach((name, index) =>
                    walkType(type.args?.[index], [...segments, { kind: "member", name }], depth + 1)
                );
            } else if (type.stl === "tuple") {
                (type.args || []).forEach((id, index) =>
                    walkType(id, [...segments, { kind: "index", index }], depth + 1)
                );
            } else if (type.stl === "array" || type.kind === "array") {
                const array = type.stl
                    ? runtimeType(graph, type.fields?.find((f) => f.name === "_M_elems")?.type)
                    : type;
                for (let index = 0; index < Math.min(array?.count || 0, 16); index++)
                    walkType(array.target, [...segments, { kind: "index", index }], depth + 1);
            } else if (!type.stl) {
                for (const field of type.fields || []) {
                    if (field.name.startsWith("_vptr")) continue;
                    walkType(
                        field.type,
                        field.isBase || field.name === "?"
                            ? segments
                            : [...segments, { kind: "member", name: field.name }],
                        depth + 1
                    );
                }
            }
        };
        if (tree) walkTree(tree, []);
        else walkType(graph.root, []);
        return { entries, sampled: !!tree };
    }
    // Values change each sample; only changes to rows or their target addresses need new DOM.
    function runtimeTreeShape(tree) {
        const shape = (node) =>
            node
                ? [
                      node.kind,
                      node.name,
                      node.index,
                      node.type,
                      node.typeName,
                      node.address,
                      Object.prototype.hasOwnProperty.call(node, "value"),
                      node.unavailable,
                      node.members?.map(shape),
                      node.elements?.map(shape)
                  ]
                : null;
        return JSON.stringify(shape(tree));
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
        runtimeWatchEntry,
        runtimeGraph,
        requiresRuntimePath,
        runtimeSelection,
        runtimeTreeShape,
        liveState
    };
});
