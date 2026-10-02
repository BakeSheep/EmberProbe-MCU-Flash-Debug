"use strict";

const { quote } = require("./mi");
const { StlDisplay, constValue, indirectType, isInternalError, safePath, gdbVariablePath } = require("./stl");

const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const yes = (value) => value === "1" || value === 1;
const visibilityGroup = (item) =>
    !item.type && !yes(item.dynamic) && /^(public|private|protected)$/.test(item.exp || "");

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
        this.threadGenerations = new Map();
        this.stl = new StlDisplay(this);
    }
    reset() {
        this.generation++;
        this.threadGenerations.clear();
        this.nodes.clear();
        this.synthetic.clear();
        this.stl.reset();
    }
    async printerOperation(command, generation) {
        let result;
        let output = "";
        if ((this.session.config.effectivePrettyPrintingMode ?? this.session.config.prettyPrintingMode) === "gdb") {
            output = await this.session.captureConsole(async () => {
                result = await this.session.mi.command(command);
            });
        } else result = await this.session.mi.command(command);
        this.check(generation);
        const failure = /Python Exception|Error (?:occurred )?in Python|Error while executing Python/i.test(output)
            ? new Error(output.trim().slice(0, 1024))
            : null;
        return { result, failure };
    }
    async rawFallback(node, error, generation) {
        this.check(generation);
        await this.session.mi.command(`-var-set-visualizer ${quote(node.item.name)} None`);
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
    }
    snapshot(frame) {
        const thread = this.session.rtosAware ? frame?.thread : undefined;
        return { generation: this.generation, thread, threadGeneration: this.threadGenerations.get(thread) || 0 };
    }
    check(snapshot) {
        this.session.checkRequest?.();
        this.session.paused();
        if (
            snapshot.generation !== this.generation ||
            snapshot.threadGeneration !== (this.threadGenerations.get(snapshot.thread) || 0)
        )
            throw new Error("Stale debug variable operation; refresh after stopping");
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
            name: displayName ?? node.label ?? item.exp ?? item.name,
            value: unavailable ? `<unavailable: ${unavailable}>` : (view?.summary ?? item.value ?? ""),
            type: item.type,
            variablesReference: expandable ? node.ref : 0
        };
        if (!unavailable && view) variable[view.indexed ? "indexedVariables" : "namedVariables"] = view.count;
        else if (!dynamic && expandable && Number.isSafeInteger(Number(item.numchild)))
            variable[indexed(item) ? "indexedVariables" : "namedVariables"] = Number(item.numchild);
        if (node.readOnly || view) variable.presentationHint = { attributes: ["readOnly"] };
        if (visibilityGroup(item)) {
            variable.value = `${Number(item.numchild) || 0} members`;
            variable.presentationHint = { kind: "virtual", attributes: ["readOnly"] };
        } else if (visibilityGroup(node.parent?.item || {})) {
            variable.presentationHint = { ...variable.presentationHint, visibility: node.parent.item.exp };
        }
        if (node.expression) variable.evaluateName = node.expression;
        if (node.memoryReference) variable.memoryReference = node.memoryReference;
        return variable;
    }
    async metadata(node, context = this.stl.context(node.frame)) {
        if (node.metadataReady || !node.item.name || node.unavailable || visibilityGroup(node.item)) return;
        const generation = this.snapshot(node.frame);
        try {
            if (!node.expression) {
                const path = await this.session.mi.command(`-var-info-path-expression ${quote(node.item.name)}`);
                this.check(generation);
                if (path.path_expr) {
                    node.expression = gdbVariablePath(path.path_expr);
                }
            }
            if (node.expression) {
                const expression = safePath(node.expression);
                // Varobjs retain their frame, but expression evaluation uses GDB's current frame.
                await this.stl.bindFrame(node, context);
                const result = await this.session.mi.command(
                    `-data-evaluate-expression ${quote(`(unsigned long long)&(${expression})`)}`
                );
                this.check(generation);
                const match = String(result.value).match(/^\s*(0x[\da-f]+|\d+)(?=\s|$)/i);
                if (match && BigInt(match[1]) > 0n) node.memoryReference = `0x${BigInt(match[1]).toString(16)}`;
            }
        } catch (error) {
            this.check(generation);
            if (isInternalError(error)) throw error;
            // Computed values, bitfields and optimized objects legitimately have no address.
        }
        node.metadataReady = true;
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
        // Invalidate only this task's operations, including a create still awaiting its first node.
        this.threadGenerations.set(thread, (this.threadGenerations.get(thread) || 0) + 1);
        const owned = [];
        for (const [id, handle] of this.session.handles) {
            const frame = handle.frame || (handle.kind === "frame" ? handle : this.session.handles.get(handle.frameId));
            if (frame?.thread === thread) owned.push(id);
        }
        const nodes = [];
        for (const [name, node] of this.nodes) if (node.frame?.thread === thread) nodes.push(name);
        const synthetic = [];
        for (const [key, handle] of this.synthetic) if (handle.frame?.thread === thread) synthetic.push(key);
        for (const id of owned) {
            this.session.handles.delete(id);
            this.session.variablesByName.delete(id);
        }
        for (const name of nodes) this.nodes.delete(name);
        for (const key of synthetic) this.synthetic.delete(key);
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
    async scopeItems(handle, range, generation, context = this.stl.context(handle.frame)) {
        const frame = await this.session.selectFrame(handle.frameId);
        this.check(generation);
        context.frameKey = `${frame.thread}:${frame.level}`;
        if (!handle.locals) {
            if (["globals", "statics"].includes(handle.scopeKind)) {
                handle.locals = await this.session.symbolDirectory.variables(handle.scopeKind, frame.file);
            } else {
                const result = await this.session.mi.command("-stack-list-variables --simple-values");
                handle.locals = result.variables || [];
            }
            this.check(generation);
            handle.roots = new Map();
            handle.frame = frame;
        }
        const nodes = [];
        for (const local of handle.locals.slice(range.from, range.from + range.size)) {
            let node = handle.roots.get(local.name);
            if (!node) {
                let item;
                try {
                    if (local.expression === null)
                        throw new Error("Symbol image/source identity is ambiguous; no safe expression is available");
                    item = {
                        ...(await this.session.createVariable(local.expression || local.name, frame)),
                        exp: local.name
                    };
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
            await this.stl.prepare(node, context);
            await this.metadata(node, context);
        }
        return { nodes, more: range.from + nodes.length < handle.locals.length };
    }
    async children(node, from, size, generation, context = this.stl.context(node.frame)) {
        await this.stl.prepare(node, context);
        if (node.unavailable) throw new Error(`Variable unavailable: ${node.unavailable}`);
        if (node.stl) {
            try {
                return await this.stl.expand(node, from, size, context);
            } catch (error) {
                this.check(generation);
                if (isInternalError(error)) throw error;
                if (
                    /inaccessible|Cannot access|optimized|unavailable|not available|budget exceeded|Stale|running/i.test(
                        error.message
                    )
                )
                    throw error;
                this.stl.fallback(node, error);
                return this.children(node, from, size, generation, context);
            }
        }
        const map = node.item.displayhint === "map";
        const factor = map ? 2 : 1;
        const end = (from + size) * factor;
        let result;
        try {
            const operation = await this.printerOperation(
                `-var-list-children --all-values ${quote(node.item.name)} ${from * factor} ${end}`,
                generation
            );
            if (operation.failure) throw operation.failure;
            result = operation.result;
        } catch (error) {
            this.check(generation);
            if (isInternalError(error)) throw error;
            if (!yes(node.item.dynamic) || node.raw) throw error;
            await this.rawFallback(node, error, generation);
            return this.children(node, from, size, generation, context);
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
            if (!map && !yes(node.item.dynamic) && !item.exp)
                child.label = `<anonymous ${/^union\b/.test(item.type || "") ? "union" : "member"} ${from + index}>`;
            child.locked ||= map && index % 2 === 0;
            return child;
        });
        for (const child of nodes) await this.stl.prepare(child, context);
        return { nodes, more, map };
    }
    async variables(args) {
        const handle = this.session.reference(args.variablesReference, null);
        const parent = handle.kind === "page" ? handle.parent : handle;
        const generation = this.snapshot(parent.frame || this.session.handles.get(parent.frameId));
        const context = this.stl.context(parent.frame || this.session.handles.get(parent.frameId));
        const filter = args.filter ?? handle.filter;
        const range = pageRange({ ...args, filter }, handle.kind === "page" ? handle.start : 0);
        if (parent.kind === "scope" && parent.scopeKind === "registers") {
            if (filter === "indexed") return { variables: [] };
            return this.registers(parent, range, generation);
        }
        if (parent.frame && this.session.rtosAware) {
            await this.session.ensureThread(parent.frame.thread);
            this.check(generation);
        }
        if (parent.kind === "entry") {
            if (filter === "indexed") return { variables: [] };
            for (const node of parent.nodes.slice(range.from, range.from + range.size))
                await this.metadata(node, context);
            const variables = parent.nodes.slice(range.from, range.from + range.size).map((node, index) => {
                const label = range.from + index === 0 ? "key" : "value";
                this.remember(args.variablesReference, label, node);
                return this.present(node, label);
            });
            return { variables };
        }
        if (parent.kind === "variable") await this.stl.prepare(parent, context);
        this.check(generation);
        const isIndexed = parent.kind === "variable" && (parent.stl ? parent.stl.indexed : indexed(parent.item));
        if (filter && filter !== (isIndexed ? "indexed" : "named")) return { variables: [] };
        const result =
            parent.kind === "scope"
                ? await this.scopeItems(parent, range, generation, context)
                : parent.kind === "variable"
                  ? await this.children(parent, range.from, range.size, generation, context)
                  : null;
        if (!result) throw new Error("Invalid variable reference");
        this.check(generation);
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
                await this.metadata(node, context);
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
        const handle = this.session.reference(args.variablesReference, null);
        const parent = handle.kind === "page" ? handle.parent : handle;
        if (parent.kind === "scope" && parent.scopeKind === "registers") return this.setRegister(parent, args);
        const node = this.session.variablesByName.get(args.variablesReference)?.get(args.name);
        const generation = this.snapshot(node?.frame);
        if (node?.readOnly || node?.stl || visibilityGroup(node?.item || {})) throw new Error("Variable is read only");
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
            const context = this.stl.context(node.frame);
            await this.stl.bindFrame(node, context);
            if (constValue(await this.stl.canonical(node.item, context))) throw new Error("Variable is read only");
        }
        const attributes = await this.session.mi.command(`-var-show-attributes ${quote(node.item.name)}`);
        this.check(generation);
        if ((attributes.attr ?? attributes.status) !== "editable") throw new Error("GDB variable is not editable");
        const result = await this.session.mi.command(`-var-assign ${quote(node.item.name)} ${quote(args.value)}`);
        this.check(generation);
        node.item.value = result.value;
        let container = null;
        for (let parent = node.parent; parent; parent = parent.parent)
            if (parent.stl) {
                container = parent;
                break;
            }
        if (container) {
            // Re-read the nearest container's display without discarding references to unchanged storage.
            if (this.nodes.get(container.item.name) === container)
                await this.stl.refresh(container, this.stl.context(container.frame));
            this.check(generation);
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
    async registers(handle, range, generation) {
        await this.session.selectFrame(handle.frameId);
        this.check(generation);
        if (!handle.registerNames) {
            const result = await this.session.mi.command("-data-list-register-names");
            this.check(generation);
            handle.registerNames = (result["register-names"] || [])
                .map((name, number) => ({ name, number }))
                .filter((item) => typeof item.name === "string" && item.name);
            handle.registers = new Map();
        }
        const names = handle.registerNames.slice(range.from, range.from + range.size);
        if (!names.length) return { variables: [] };
        const result = await this.session.mi.command(
            `-data-list-register-values x ${names.map((item) => item.number).join(" ")}`
        );
        this.check(generation);
        const values = new Map((result["register-values"] || []).map((item) => [Number(item.number), item.value]));
        const variables = names.map((item) => {
            handle.registers.set(item.name, item.number);
            return {
                name: item.name,
                value: values.get(item.number) ?? "<unavailable>",
                evaluateName: `$${item.name}`,
                variablesReference: 0
            };
        });
        if (range.implicit && range.from + names.length < handle.registerNames.length) {
            const next = range.from + names.length;
            const page = this.syntheticHandle(`registers:${handle.ref}:${next}`, {
                kind: "page",
                parent: handle,
                start: next
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
    async setRegister(handle, args) {
        const number = handle.registers?.get(args.name);
        if (!Number.isInteger(number)) throw new Error("Register is unavailable or has not been expanded");
        if (typeof args.value !== "string" || !args.value.trim()) throw new Error("Provide a register value");
        const generation = this.snapshot(handle.frame);
        await this.session.selectFrame(handle.frameId);
        this.check(generation);
        const evaluated = await this.session.mi.command(`-data-evaluate-expression ${quote(args.value)}`);
        this.check(generation);
        const match = String(evaluated.value).match(/^\s*(-?(?:0x[\da-f]+|\d+))(?=\s|$)/i);
        if (!match) throw new Error("Register value must evaluate to an integer");
        await this.session.mi.command(`-data-write-register-values x ${number} ${match[1]}`);
        this.check(generation);
        const result = await this.session.mi.command(`-data-list-register-values x ${number}`);
        this.check(generation);
        const value = (result["register-values"] || []).find((item) => Number(item.number) === number)?.value;
        await this.session.clearVariables({ defer: true });
        return { value: value ?? evaluated.value, variablesReference: 0 };
    }
}

module.exports = { DebugVariables, pageRange };
