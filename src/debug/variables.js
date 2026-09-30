"use strict";

const { quote } = require("./mi");
const { StlDisplay, constValue, indirectType } = require("./stl");

const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const yes = (value) => value === "1" || value === 1;

function pageRange(args, offset = 0) {
    const start = args.start ?? 0;
    const count = args.count ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0 || count > MAX_PAGE_SIZE)
        throw new Error("Variable paging requires a nonnegative start and count <= 1000");
    if (args.filter !== undefined && !["named", "indexed"].includes(args.filter))
        throw new Error("Invalid variable filter");
    const from = offset + start;
    const size = count || PAGE_SIZE;
    if ((from + size) * 2 > 0x7fffffff) throw new Error("Variable paging range overflow");
    return { from, size, implicit: !count };
}

function indexed(item) {
    return ["array", "map"].includes(item.displayhint) || /\[\d+\]$/.test(item.type || "");
}

class DebugVariables {
    constructor(session) {
        this.session = session;
        this.nodes = new Map();
        this.synthetic = new Map();
        this.generation = 0;
        this.stl = new StlDisplay(this);
    }
    reset() {
        this.generation++;
        this.nodes.clear();
        this.synthetic.clear();
        this.stl.reset();
    }
    check(generation) {
        this.session.paused();
        if (generation !== this.generation) throw new Error("Stale debug variable operation; refresh after stopping");
    }
    register(item, root = null, parent = null, readOnly = false) {
        let node = this.nodes.get(item.name);
        if (!node) {
            node = {
                kind: "variable",
                item: { ...item },
                root,
                parent,
                readOnly: readOnly || constValue(item.type),
                locked: !!parent?.locked,
                ref: 0,
                frame: root?.frame
            };
            node.root ||= node;
            if (item.name) this.nodes.set(item.name, node);
        } else {
            Object.assign(node.item, item);
            if (parent) {
                node.parent = parent;
                node.root = root;
                node.frame = root.frame;
                node.readOnly ||= readOnly;
                node.locked ||= parent.locked;
            }
        }
        return node;
    }
    root(item, frame) {
        const node = this.register(item);
        node.frame = frame;
        return node;
    }
    present(node, displayName) {
        const item = node.item;
        const view = node.stl;
        const unavailable = node.unavailable;
        const dynamic = yes(item.dynamic);
        const expandable = unavailable
            ? false
            : view
              ? view.count > 0
              : Number(item.numchild) > 0 ||
                yes(item.has_more) ||
                (dynamic && item.has_more === undefined && item.displayhint !== "string");
        if (expandable && !node.ref) node.ref = this.session.handleFor(node);
        const variable = {
            name: displayName ?? item.exp ?? item.name,
            value: unavailable ? `<unavailable: ${unavailable}>` : (view?.summary ?? item.value ?? ""),
            type: item.type,
            variablesReference: expandable ? node.ref : 0
        };
        if (!unavailable && view) variable[view.indexed ? "indexedVariables" : "namedVariables"] = view.count;
        else if (!dynamic && expandable && Number.isSafeInteger(Number(item.numchild)))
            variable[indexed(item) ? "indexedVariables" : "namedVariables"] = Number(item.numchild);
        if (node.readOnly || view) variable.presentationHint = { attributes: ["readOnly"] };
        return variable;
    }
    descendant(node, parent) {
        for (let current = node.parent; current; current = current.parent) if (current === parent) return true;
        return false;
    }
    dropChildren(parent) {
        for (const names of this.session.variablesByName.values()) {
            for (const [label, node] of names) if (node && this.descendant(node, parent)) names.delete(label);
        }
        for (const [name, node] of this.nodes) {
            if (!this.descendant(node, parent)) continue;
            this.nodes.delete(name);
            this.session.handles.delete(node.ref);
        }
        for (const [key, handle] of this.synthetic) {
            if (handle.parent === parent || this.descendant(handle.parent, parent)) {
                this.session.handles.delete(handle.ref);
                this.synthetic.delete(key);
            }
        }
        // Assignments use live node identity, so old page mappings cannot target recreated children.
    }
    invalidateThread(thread) {
        this.generation++;
        const owned = [];
        for (const [id, handle] of this.session.handles) {
            const frame = handle.frame || (handle.kind === "frame" ? handle : this.session.handles.get(handle.frameId));
            if (frame?.thread === thread) owned.push(id);
        }
        for (const id of owned) {
            this.session.handles.delete(id);
            this.session.variablesByName.delete(id);
        }
        for (const [name, node] of this.nodes) if (node.frame?.thread === thread) this.nodes.delete(name);
        for (const [key, handle] of this.synthetic) if (handle.frame?.thread === thread) this.synthetic.delete(key);
    }
    syntheticHandle(key, value) {
        let handle = this.synthetic.get(key);
        if (!handle) {
            handle = { ...value, frame: value.parent.frame };
            handle.ref = this.session.handleFor(handle);
            this.synthetic.set(key, handle);
        }
        return handle;
    }
    remember(reference, label, node) {
        let names = this.session.variablesByName.get(reference);
        if (!names) this.session.variablesByName.set(reference, (names = new Map()));
        const existing = names.get(label);
        // Duplicate printer labels must never silently redirect an assignment.
        names.set(label, names.has(label) && existing !== node ? null : node);
    }
    async scopeItems(handle, range, generation) {
        const frame = await this.session.selectFrame(handle.frameId);
        this.check(generation);
        if (!handle.locals) {
            const result = await this.session.mi.command("-stack-list-variables --simple-values");
            this.check(generation);
            handle.locals = result.variables || [];
            handle.roots = new Map();
            handle.frame = frame;
        }
        const nodes = [];
        for (const local of handle.locals.slice(range.from, range.from + range.size)) {
            let node = handle.roots.get(local.name);
            if (!node) {
                let item;
                try {
                    item = { ...(await this.session.createVariable(local.name, frame)), exp: local.name };
                } catch (error) {
                    item = {
                        ...local,
                        name: "",
                        exp: local.name,
                        numchild: "0",
                        value: local.value || `<unavailable: ${error.message}>`
                    };
                }
                this.check(generation);
                node = this.root(item, frame);
                handle.roots.set(local.name, node);
            }
            nodes.push(node);
            await this.stl.prepare(node);
        }
        return { nodes, more: range.from + nodes.length < handle.locals.length };
    }
    async children(node, from, size, generation) {
        const context = this.stl.context();
        await this.stl.prepare(node, context);
        if (node.unavailable) throw new Error(`Variable unavailable: ${node.unavailable}`);
        if (node.stl) {
            try {
                return await this.stl.expand(node, from, size, context);
            } catch (error) {
                this.check(generation);
                if (
                    /inaccessible|Cannot access|optimized|unavailable|not available|budget exceeded|Stale|running/i.test(
                        error.message
                    )
                )
                    throw error;
                this.stl.fallback(node, error);
                return this.children(node, from, size, generation);
            }
        }
        const map = node.item.displayhint === "map";
        const factor = map ? 2 : 1;
        const end = (from + size) * factor;
        let result;
        try {
            result = await this.session.mi.command(
                `-var-list-children --all-values ${quote(node.item.name)} ${from * factor} ${end}`
            );
        } catch (error) {
            this.check(generation);
            if (!yes(node.item.dynamic) || node.raw) throw error;
            this.check(generation);
            const info = await this.session.mi.command(`-var-info-num-children ${quote(node.item.name)}`);
            const value = await this.session.mi.command(`-var-evaluate-expression ${quote(node.item.name)}`);
            this.check(generation);
            this.dropChildren(node);
            node.raw = true;
            Object.assign(node.item, {
                dynamic: "0",
                has_more: "0",
                displayhint: undefined,
                numchild: info.numchild,
                value: value.value
            });
            this.session.variableDiagnostic(
                `Variable expansion failed for ${node.item.type}: ${error.message}. Showing raw fields.\n`
            );
            return this.children(node, from, size, generation);
        }
        this.check(generation);
        const items = (result.children || []).map((child) => child.child || child);
        if (items.length > size * factor || (map && items.length % 2))
            throw new Error("GDB returned an invalid or oversized variable page");
        await this.session.mi.command(`-var-set-update-range ${quote(node.item.name)} ${from * factor} ${end}`);
        this.check(generation);
        node.rangeSet = true;
        const total = yes(node.item.dynamic) ? null : Number(node.item.numchild);
        const more = yes(result.has_more) || (total !== null && from + items.length < total);
        if (!items.length && more) throw new Error("GDB variable iterator made no progress");
        const nodes = items.map((item, index) => {
            // Const applies to the pointer/reference itself, not to its referent. Map keys
            // remain locked across dereferences; GDB checks the referent's editability.
            const readOnly = node.locked || (!indirectType(node.item.type) && node.readOnly);
            const child = this.register(item, node.root, node, readOnly || (map && index % 2 === 0));
            child.locked ||= map && index % 2 === 0;
            return child;
        });
        for (const child of nodes) await this.stl.prepare(child, context);
        return { nodes, more, map };
    }
    async variables(args) {
        const handle = this.session.reference(args.variablesReference, null);
        const generation = this.generation;
        const parent = handle.kind === "page" ? handle.parent : handle;
        const filter = args.filter ?? handle.filter;
        const range = pageRange({ ...args, filter }, handle.kind === "page" ? handle.start : 0);
        if (parent.frame && this.session.rtosAware) {
            await this.session.ensureThread(parent.frame.thread);
            this.check(generation);
        }
        if (parent.kind === "entry") {
            if (filter === "indexed") return { variables: [] };
            const variables = parent.nodes.slice(range.from, range.from + range.size).map((node, index) => {
                const label = range.from + index === 0 ? "key" : "value";
                this.remember(args.variablesReference, label, node);
                return this.present(node, label);
            });
            return { variables };
        }
        if (parent.kind === "variable") await this.stl.prepare(parent);
        const isIndexed = parent.kind === "variable" && (parent.stl ? parent.stl.indexed : indexed(parent.item));
        if (filter && filter !== (isIndexed ? "indexed" : "named")) return { variables: [] };
        const result =
            parent.kind === "scope"
                ? await this.scopeItems(parent, range, generation)
                : parent.kind === "variable"
                  ? await this.children(parent, range.from, range.size, generation)
                  : null;
        if (!result) throw new Error("Invalid variable reference");
        const variables = [];
        if (result.map) {
            for (let index = 0; index < result.nodes.length; index += 2) {
                const entry = this.syntheticHandle(`entry:${parent.ref}:${range.from + index / 2}`, {
                    kind: "entry",
                    parent,
                    nodes: result.nodes.slice(index, index + 2)
                });
                entry.nodes = result.nodes.slice(index, index + 2);
                variables.push({
                    name: `[${range.from + index / 2}]`,
                    value: this.present(entry.nodes[0]).value,
                    variablesReference: entry.ref,
                    namedVariables: 2,
                    presentationHint: { kind: "virtual", attributes: ["readOnly"] }
                });
            }
        } else {
            for (const node of result.nodes) {
                const variable = this.present(node);
                this.remember(args.variablesReference, variable.name, node);
                if (parent.ref && parent.ref !== args.variablesReference)
                    this.remember(parent.ref, variable.name, node);
                variables.push(variable);
            }
        }
        if (range.implicit && result.more) {
            const next = range.from + (result.map ? result.nodes.length / 2 : result.nodes.length);
            const page = this.syntheticHandle(`page:${parent.ref}:${next}:${filter || ""}`, {
                kind: "page",
                parent,
                start: next,
                filter
            });
            variables.push({
                name: "More…",
                value: `from ${next}`,
                variablesReference: page.ref,
                presentationHint: { kind: "virtual", attributes: ["readOnly"] }
            });
        }
        return { variables };
    }
    async setVariable(args) {
        this.session.reference(args.variablesReference, null);
        const generation = this.generation;
        const node = this.session.variablesByName.get(args.variablesReference)?.get(args.name);
        if (node?.readOnly || node?.stl) throw new Error("Variable is read only");
        if (!node?.item.name || this.nodes.get(node.item.name) !== node)
            throw new Error("Variable is unavailable, ambiguous, or has not been expanded");
        if (node.frame && this.session.rtosAware) await this.session.ensureThread(node.frame.thread);
        this.check(generation);
        if (
            !/^(?:(?:unsigned|signed|long|short|const|volatile)\s+)*(?:int|char|bool|float|double|long|short|unsigned|signed)\b/.test(
                node.item.type || ""
            ) &&
            !/[\[*]/.test(node.item.type || "")
        ) {
            const context = this.stl.context();
            await this.stl.bindFrame(node, context);
            if (constValue(await this.stl.canonical(node.item, context))) throw new Error("Variable is read only");
        }
        const attributes = await this.session.mi.command(`-var-show-attributes ${quote(node.item.name)}`);
        this.check(generation);
        if ((attributes.attr ?? attributes.status) !== "editable") throw new Error("GDB variable is not editable");
        const result = await this.session.mi.command(`-var-assign ${quote(node.item.name)} ${quote(args.value)}`);
        this.check(generation);
        node.item.value = result.value;
        const formatted = [];
        for (let parent = node.parent; parent; parent = parent.parent) if (parent.stl) formatted.push(parent);
        if (formatted.length) {
            // Synthetic elements are independent real varobjs. Never update an entire container tree.
            for (const parent of formatted.reverse())
                if (this.nodes.get(parent.item.name) === parent) await this.stl.refresh(parent, this.stl.context());
            return { value: result.value, variablesReference: 0 };
        }
        // A root that has never been expanded must not trigger an unbounded dynamic update.
        if (!node.root.rangeSet)
            await this.session.mi.command(`-var-set-update-range ${quote(node.root.item.name)} 0 0`);
        const update = await this.session.mi.command(`-var-update --all-values ${quote(node.root.item.name)}`);
        this.check(generation);
        for (const change of update.changelist || []) {
            const changed = this.nodes.get(change.name);
            if (!changed) continue;
            if (change.type_changed === "true" || ["invalid", "false"].includes(change.in_scope)) {
                this.dropChildren(changed);
                if (change.in_scope !== "true") {
                    changed.item = {
                        ...changed.item,
                        value: "<unavailable>",
                        numchild: "0",
                        dynamic: "0",
                        has_more: "0"
                    };
                    this.nodes.delete(change.name);
                    this.session.handles.delete(changed.ref);
                }
            }
            Object.assign(changed.item, change);
            if (change.new_type) changed.item.type = change.new_type;
            if (change.new_num_children !== undefined) changed.item.numchild = change.new_num_children;
        }
        return { value: result.value, variablesReference: 0 };
    }
}

module.exports = { DebugVariables, pageRange };
