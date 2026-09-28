"use strict";

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
function invalid(message) {
    return Object.assign(new Error(message), { code: "INVALID_SVD_DERIVATION" });
}
function merge(base, override) {
    if (
        !base ||
        typeof base !== "object" ||
        !override ||
        typeof override !== "object" ||
        Array.isArray(base) ||
        Array.isArray(override)
    )
        return override === undefined ? base : override;
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
    return result;
}

// Resolve before dimension expansion. Qualified references never fall back to a
// sibling with the same short name. Inherited descendants acquire the new scope.
function resolveSvdDerivation(device) {
    const index = new Map();
    const cache = new Map();
    const active = new Set();
    function children(node, kind) {
        if (kind === "device") return [["peripheral", node.peripherals, "peripheral"]];
        if (kind === "peripheral")
            return [
                ["register", node.registers, "register"],
                ["cluster", node.registers, "cluster"]
            ];
        if (kind === "cluster")
            return [
                ["register", node, "register"],
                ["cluster", node, "cluster"]
            ];
        if (kind === "register") return [["field", node.fields, "field"]];
        return [];
    }
    function register(node, kind, scope, depth = 0) {
        if (depth > 64 || index.size >= 100000) throw invalid("SVD derivation budget exceeded");
        const name = String(node?.name || "").trim();
        if (!name || name.includes(".")) throw invalid("Invalid SVD element name");
        const key = [...scope, name].join(".");
        if (index.has(key.toLowerCase())) throw invalid(`Duplicate SVD path: ${key}`);
        const entry = { node, kind, scope, key };
        index.set(key.toLowerCase(), entry);
        for (const [childKind, container, property] of children(node, kind))
            for (const child of array(container?.[property])) register(child, childKind, [...scope, name], depth + 1);
        return entry;
    }
    for (const node of array(device.peripherals?.peripheral)) register(node, "peripheral", []);
    function lookup(key) {
        const normalized = key.toLowerCase();
        if (index.has(normalized)) return index.get(normalized);
        const parts = key.split(".");
        for (let length = parts.length - 1; length > 0; length--) {
            const parent = index.get(parts.slice(0, length).join(".").toLowerCase());
            if (parent && !active.has(parent)) {
                resolve(parent);
                if (index.has(normalized)) return index.get(normalized);
            }
        }
        throw invalid(`Unknown SVD derivedFrom target: ${key}`);
    }
    function resolve(entry) {
        if (cache.has(entry)) return cache.get(entry);
        if (active.has(entry) || active.size >= 128) throw invalid(`Cyclic SVD derivation: ${entry.key}`);
        active.add(entry);
        let node = entry.node;
        const reference = String(node["@_derivedFrom"] || "").trim();
        if (reference) {
            const key = reference.includes(".") ? reference : [...entry.scope, reference].join(".");
            const base = lookup(key);
            if (base.kind !== entry.kind) throw invalid(`Incompatible SVD derivedFrom target: ${key}`);
            node = merge(resolve(base), node);
        }
        node = { ...node };
        delete node["@_derivedFrom"];
        const groups = children(node, entry.kind);
        // Copy containers before replacing their arrays; never mutate the base.
        if (node.registers) node.registers = { ...node.registers };
        if (node.fields) node.fields = { ...node.fields };
        for (const [kind, container, property] of groups) {
            const entries = array(container?.[property]).map((child) => {
                const key = `${entry.key}.${child.name}`.toLowerCase();
                return index.get(key) || register(child, kind, entry.key.split("."));
            });
            const resolved = entries.map(resolve);
            const output =
                entry.kind === "peripheral" ? node.registers : entry.kind === "register" ? node.fields : node;
            if (output && resolved.length) output[property] = resolved;
        }
        active.delete(entry);
        cache.set(entry, node);
        return node;
    }
    return {
        ...device,
        peripherals: {
            ...device.peripherals,
            peripheral: array(device.peripherals?.peripheral).map((node) => resolve(lookup(String(node.name))))
        }
    };
}

module.exports = { resolveSvdDerivation };
