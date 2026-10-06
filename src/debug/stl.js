"use strict";

const { quote } = require("./mi");

const MEMORY_LIMIT = 65536;
const WALK_LIMIT = 4096;
const FIELD_LIMIT = 128;
const MAX_DEPTH = 12;
const TIME_LIMIT_MS = 15000;
const ORDERED_KINDS = new Set(["map", "multimap", "set", "multiset"]);
const HASH_KINDS = new Set(["unordered_map", "unordered_multimap", "unordered_set", "unordered_multiset"]);
const MAP_KINDS = new Set(["map", "multimap", "unordered_map", "unordered_multimap"]);
const TYPE_LINE = /(?:^|\n)type = ([^\r\n]+)/;

function templateType(input) {
    const type = String(input)
        .replace(/\b(class|struct|volatile)\s+/g, "")
        .replace(/^const\s+/, "")
        .replace(/\s*[&]+$/, "")
        .trim();
    const opening = type.indexOf("<");
    if (opening < 0) return { name: type, args: [] };
    let depth = 0,
        start = opening + 1;
    const args = [];
    for (let index = start; index < type.length; index++) {
        const char = type[index];
        if (char === "<") depth++;
        else if (char === ">") {
            if (!depth) {
                const last = type.slice(start, index).trim();
                if (last) args.push(last);
                return { name: type.slice(0, opening).trim(), args };
            }
            depth--;
        } else if (char === "," && !depth) {
            args.push(type.slice(start, index).trim());
            start = index + 1;
        }
    }
    throw new Error("Incomplete C++ template type");
}

function integer(value) {
    if (value === "true") return 1n;
    if (value === "false") return 0n;
    const match = String(value).match(/^\s*(-?(?:0x[\da-f]+|\d+))(?=\s|$)/i);
    if (!match) throw new Error(`Invalid STL field: ${value}`);
    return BigInt(match[1]);
}

function count(value) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid STL length");
    return Number(value);
}

function safeType(type) {
    if (!/^[\w\s:<>,*&]+$/.test(type) || type.length > 8192) throw new Error("Unsupported C++ type expression");
    return type.replace(/\b(class|struct)\s+/g, "");
}

function castType(type) {
    const safe = safeType(type);
    return /[<:]/.test(safe) ? `'${safe}'` : safe;
}

function safePath(expression) {
    const unquoted = String(expression || "")
        // A file-qualified static has a quoted source path, not a quoted C++ type.
        .replace(/^'(?:\\.|[^'\\])*'::/, "__file::")
        .replace(/'([^']*)'/g, (_match, type) => safeType(type));
    if (
        !expression ||
        expression.length > 16384 ||
        !/^[\w\s:$*.<>,&()[\]+-]+$/.test(unquoted) ||
        /\+\+|--/.test(unquoted) ||
        /\b\w+\s*\(/.test(unquoted)
    )
        throw new Error("STL display requires a side-effect-free variable path");
    return expression;
}

function gdbVariablePath(expression) {
    // MI's by-value base casts lose lvalue storage and can break virtual-base lookup.
    return safePath(String(expression || "").replace(/\(\s*(class|struct|union)\s+([\w\s:<>,]+)\)/g, "($1 $2 &)"));
}

function kindOf(type) {
    if (/\*\s*(?:const)?\s*$/.test(type)) return null;
    const parsed = templateType(type);
    if (/std::(?:__debug|__\d+)::/.test(parsed.name)) return null;
    const match = parsed.name.match(
        /^std::(?:__cxx11::)?(basic_string|vector|array|pair|tuple|map|multimap|set|multiset|unordered_map|unordered_multimap|unordered_set|unordered_multiset|list|forward_list|deque|unique_ptr|shared_ptr|weak_ptr|optional|variant)$/
    );
    return match ? { kind: match[1], args: parsed.args, type: safeType(type) } : null;
}

function outerType(type) {
    let depth = 0,
        outer = "";
    for (const char of String(type)) {
        if (char === "<") depth++;
        else if (char === ">") depth--;
        else if (!depth) outer += char;
    }
    return outer;
}

function constValue(type) {
    const outer = outerType(type);
    // const T* permits assigning the pointer; T* const does not.
    return /\bconst\b/.test(outer.includes("*") ? outer.slice(outer.lastIndexOf("*") + 1) : outer);
}

function indirectType(type) {
    return /[*&]/.test(outerType(type));
}

// Every target and layout condition this module reports is a plain Error. A TypeError, RangeError
// or a non-Error throw is a defect here, and degrading it to raw fields would hide it behind a
// single console line.
function isInternalError(error) {
    return (
        !(error instanceof Error) ||
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError
    );
}

function storageIdentity(view) {
    // Values and summaries may change after an element write; only storage changes invalidate handles.
    const fields = view.fields || view.tuple;
    return JSON.stringify([
        view.info.type,
        view.count,
        view.address?.toString(),
        view.elementSize?.toString(),
        view.bitOffset,
        view.wordSize,
        view.branch,
        view.pointeeType,
        view.first?.toString(),
        view.sentinel?.toString(),
        view.valueOffset?.toString(),
        view.array?.name,
        view.value?.name,
        fields ? [...fields].map(([label, item]) => [label, item.name, item.type]) : null
    ]);
}

class StlDisplay {
    constructor(store) {
        this.store = store;
        this.session = store.session;
        this.types = new Map();
        this.constants = new Map();
    }
    reset() {
        this.types.clear();
        this.constants.clear();
    }
    context(frame) {
        return {
            generation: this.store.snapshot(frame),
            bytes: 0,
            steps: 0,
            fields: 0,
            deadline: Date.now() + TIME_LIMIT_MS
        };
    }
    async command(command, context) {
        this.store.check(context.generation);
        if (Date.now() > context.deadline) throw new Error("STL time budget exceeded (15 seconds)");
        const result = await this.session.mi.command(command);
        this.store.check(context.generation);
        return result;
    }
    async bindFrame(node, context) {
        if (!node.frame) return;
        if ((this.session.threadAware ?? this.session.rtosAware) && context.generation.thread === undefined) {
            const snapshot = this.store.snapshot(node.frame);
            context.generation.thread = snapshot.thread;
            context.generation.threadGeneration = snapshot.threadGeneration;
        }
        const frameKey = `${node.frame.thread}:${node.frame.level}`;
        if (
            this.session.selectedFrame?.thread === node.frame.thread &&
            this.session.selectedFrame?.level === node.frame.level
        ) {
            context.frameKey = frameKey;
            return;
        }
        if (this.session.threadAware ?? this.session.rtosAware) await this.session.ensureThread(node.frame.thread);
        await this.command(`-thread-select ${node.frame.thread}`, context);
        await this.command(`-stack-select-frame ${node.frame.level}`, context);
        this.session.selectedFrame = node.frame;
        context.frameKey = frameKey;
    }
    async evaluate(expression, context) {
        return integer((await this.command(`-data-evaluate-expression ${quote(expression)}`, context)).value);
    }
    async path(item, context) {
        return gdbVariablePath(
            (await this.command(`-var-info-path-expression ${quote(item.name)}`, context)).path_expr
        );
    }
    async canonical(item, context) {
        const key = `${context.frameKey || ""}:${item.type}`;
        if (this.types.has(key)) return this.types.get(key);
        // Fully expanded MI types need no expression evaluation. In particular,
        // ARM GDB can expose inherited members through a by-value base cast.
        if (kindOf(item.type)) return safeType(item.type);
        const expression = await this.path(item, context);
        const resolved = (command) => this.session.captureConsole(() => this.command(command, context));
        let match = (await resolved(`-interpreter-exec console ${quote(`whatis /r ${expression}`)}`)).match(TYPE_LINE);
        if (!match) throw new Error("GDB did not resolve the C++ type");
        if (
            !kindOf(match[1]) &&
            !/[\[*]|^(?:unsigned |signed |long |short )*(?:int|char|bool|float|double)\b/.test(match[1])
        ) {
            const expanded = (await resolved(`-interpreter-exec console ${quote(`ptype /r ${expression}`)}`)).match(
                TYPE_LINE
            );
            if (expanded) match = expanded;
        }
        match[1] = match[1].split(" [with ")[0].split(" {")[0].split(" : ")[0].trim();
        this.types.set(key, match[1]);
        return match[1];
    }
    async constant(expression, context) {
        const key = `${context.frameKey || ""}:${expression}`;
        if (!this.constants.has(key)) this.constants.set(key, await this.evaluate(expression, context));
        return this.constants.get(key);
    }
    async size(type, context) {
        const value = await this.constant(`sizeof(${castType(type)})`, context);
        if (value <= 0n || value > 0x100000000n) throw new Error("Invalid C++ element size");
        return value;
    }
    async offset(type, member, context) {
        if (!/^[\w.]+$/.test(member)) throw new Error("Invalid STL member path");
        const objectType = type.replace(/^(?:const|volatile)\s+/, "").replace(/\s+(?:const|volatile)$/, "");
        return this.constant(`(unsigned long long)&((${castType(objectType)}*)0)->${member}`, context);
    }
    async address(item, context) {
        return this.evaluate(`(unsigned long long)&(${await this.path(item, context)})`, context);
    }
    async elementExpression(type, address, context) {
        const width = await this.size("void*", context);
        const size = await this.size(type, context);
        if (![4n, 8n].includes(width) || address <= 0n || address + size > 1n << (width * 8n))
            throw new Error("STL element address overflow or null pointer");
        return `*((${castType(type)}*)0x${address.toString(16)})`;
    }
    async memory(address, length, context) {
        const bits = (await this.size("void*", context)) * 8n;
        if (![32n, 64n].includes(bits) || address < 0n || address + BigInt(length) > 1n << bits)
            throw new Error("STL memory address overflow");
        if (!Number.isSafeInteger(length) || length < 0 || context.bytes + length > MEMORY_LIMIT)
            throw new Error("STL memory budget exceeded (64 KiB)");
        context.bytes += length;
        if (!length) return Buffer.alloc(0);
        const result = await this.command(`-data-read-memory-bytes 0x${address.toString(16)} ${length}`, context);
        let cursor = address;
        const buffers = [];
        for (const segment of result.memory || []) {
            if (integer(segment.begin) !== cursor || !/^(?:[\da-f]{2})*$/i.test(segment.contents || ""))
                throw new Error("STL memory is inaccessible or incomplete");
            const bytes = Buffer.from(segment.contents, "hex");
            cursor += BigInt(bytes.length);
            buffers.push(bytes);
        }
        const bytes = Buffer.concat(buffers);
        if (bytes.length !== length) throw new Error("STL memory is inaccessible or incomplete");
        return bytes;
    }
    async pointer(address, context) {
        const width = count(await this.size("void*", context));
        const bytes = await this.memory(address, width, context);
        return width === 4 ? BigInt(bytes.readUInt32LE()) : bytes.readBigUInt64LE();
    }
    async raw(item, from, size, context) {
        const result = await this.command(
            `-var-list-children --all-values ${quote(item.name)} ${from} ${from + size}`,
            context
        );
        const items = (result.children || []).map((entry) => entry.child || entry);
        if (items.length > size) throw new Error("Oversized raw STL field page");
        return items;
    }
    async fields(item, names, context) {
        const found = new Map();
        const queue = [{ item, depth: 0 }];
        while (queue.length && found.size < names.length) {
            const current = queue.shift();
            if (current.depth >= MAX_DEPTH) throw new Error("STL field depth limit exceeded");
            const total = Number(current.item.numchild);
            if (!Number.isSafeInteger(total) || total < 0 || context.fields + total > FIELD_LIMIT)
                throw new Error("STL field probe budget exceeded");
            const children = await this.raw(current.item, 0, total, context);
            context.fields += children.length;
            for (const child of children) {
                if (names.includes(child.exp)) {
                    if (!found.has(child.exp)) found.set(child.exp, child);
                } else if (Number(child.numchild) && this.wrapper(child))
                    queue.push({ item: child, depth: current.depth + 1 });
            }
        }
        for (const name of names) if (!found.has(name)) throw new Error(`Unsupported STL layout: missing ${name}`);
        return found;
    }
    wrapper(item) {
        return (
            ["public", "private", "protected", "<anonymous union>"].includes(item.exp) ||
            /^std::/.test(item.exp) ||
            /^_M_(impl|t|h|dataplus|payload|storage)$/.test(item.exp)
        );
    }
    async number(item, context) {
        // Re-evaluate physical fields after an assignment; do not reuse an old header value.
        return integer((await this.command(`-var-evaluate-expression ${quote(item.name)}`, context)).value);
    }
    async materialize(parent, label, expression, context, readOnly = false, propagateConst = true) {
        parent.stl.elements ||= new Map();
        let node = parent.stl.elements.get(label);
        if (!node) {
            let item;
            try {
                item = await this.session.createVariable(expression, parent.frame);
            } catch (error) {
                error.message += ` (STL element expression: ${expression})`;
                throw error;
            }
            this.store.check(context.generation);
            node = this.store.register(
                item,
                parent.root,
                parent,
                parent.locked || (propagateConst && parent.readOnly) || readOnly
            );
            node.ownsVariable = true;
            node.locked ||= readOnly;
            node.item.exp = label;
            parent.stl.elements.set(label, node);
        } else
            node.item.value = (await this.command(`-var-evaluate-expression ${quote(node.item.name)}`, context)).value;
        await this.prepare(node, context);
        return node;
    }
    async physical(parent, label, item, context, readOnly = false) {
        // Cached map payloads and tuple fields can hold pre-assignment MI values.
        const value = (await this.command(`-var-evaluate-expression ${quote(item.name)}`, context)).value;
        const node = this.store.register(
            { ...item, value, exp: label },
            parent.root,
            parent,
            parent.readOnly || readOnly
        );
        node.locked ||= readOnly;
        await this.prepare(node, context);
        return node;
    }
    async prepare(node, context = this.context(node.frame)) {
        if (
            node.stlAttempted ||
            node.raw ||
            (this.session.config.effectivePrettyPrintingMode ??
                this.session.config.prettyPrintingMode ??
                (this.session.config.enablePrettyPrinting === false ? "raw" : "builtin")) !== "builtin" ||
            !node.item.name ||
            !node.item.type
        )
            return;
        node.stlAttempted = true;
        const input = node.item.type || "";
        // GDB exposes function/vtable pointers and ordinary arrays as structured
        // varobjs too. They cannot be STL owners and need no type/path probes.
        if (/[\[*]/.test(outerType(input))) return;
        if (/^(?:const )?(?:struct|union)\s*\{/.test(input)) return;
        if (!Number(node.item.numchild) && !/std::/.test(input)) return;
        const previousFields = context.fields;
        context.fields = 0;
        try {
            await this.bindFrame(node, context);
            const type = await this.canonical(node.item, context);
            node.readOnly ||= constValue(type);
            const info = kindOf(type);
            if (!info && /std::(?:__debug|__\d+)::/.test(type))
                throw new Error("Unverified STL namespace or debug ABI");
            if (!info) return;
            if (this.endian === undefined) {
                const output = await this.session.captureConsole(() =>
                    this.command(`-interpreter-exec console ${quote("show endian")}`, context)
                );
                this.endian = /little endian/i.test(output) ? "little" : "unsupported";
            }
            if (this.endian !== "little") throw new Error("Only verified little-endian STL layouts are supported");
            node.stl = await this.describe(node, info, context);
        } catch (error) {
            this.store.check(context.generation);
            if (isInternalError(error)) throw error;
            if (/(?:memory|time) budget exceeded/i.test(error.message)) {
                node.stlAttempted = false;
                throw error;
            }
            if (
                /inaccessible|Cannot access|optimized|unavailable|not available|not located in memory/i.test(
                    error.message
                )
            )
                node.unavailable = error.message;
            else this.fallback(node, error);
        } finally {
            context.fields = previousFields;
        }
    }
    fallback(node, error) {
        this.store.dropChildren(node);
        delete node.stl;
        node.raw = true;
        this.session.variableDiagnostic(
            `Built-in STL display unavailable for ${node.item.type}: ${error.message}. Showing raw fields.\n`
        );
    }
    async describe(node, info, context) {
        const { kind, args } = info;
        const view = {
            kind,
            info,
            indexed:
                ["basic_string", "vector", "array", "tuple", "list", "forward_list", "deque"].includes(kind) ||
                ORDERED_KINDS.has(kind) ||
                HASH_KINDS.has(kind),
            count: 0,
            summary: "",
            elements: new Map()
        };
        if (kind === "basic_string") {
            if (args[0] !== "char" || !info.type.includes("__cxx11"))
                throw new Error("Only the libstdc++ C++11 char string ABI is supported");
            const fields = await this.fields(node.item, ["_M_p", "_M_string_length"], context);
            view.address = await this.number(fields.get("_M_p"), context);
            view.count = count(await this.number(fields.get("_M_string_length"), context));
            if (!view.address && view.count) throw new Error("Corrupt string data pointer");
            const bytes = await this.memory(view.address, Math.min(view.count, 256), context);
            view.summary = `${JSON.stringify(bytes.toString("utf8"))}${view.count > 256 ? "…" : ""} (length ${view.count})`;
            return view;
        }
        if (kind === "vector") {
            const fields = await this.fields(node.item, ["_M_start", "_M_finish", "_M_end_of_storage"], context);
            const start = fields.get("_M_start"),
                finish = fields.get("_M_finish");
            if (args[0] === "bool") {
                const begin = await this.fields(start, ["_M_p", "_M_offset"], context);
                const end = await this.fields(finish, ["_M_p", "_M_offset"], context);
                view.address = await this.number(begin.get("_M_p"), context);
                const endAddress = await this.number(end.get("_M_p"), context);
                view.bitOffset = count(await this.number(begin.get("_M_offset"), context));
                const endBit = await this.number(end.get("_M_offset"), context);
                const wordType = safeType(begin.get("_M_p").type).replace(/\s*\*\s*$/, "");
                view.wordSize = count(await this.size(wordType, context));
                if (
                    ![4, 8].includes(view.wordSize) ||
                    (endAddress - view.address) % BigInt(view.wordSize) ||
                    view.bitOffset >= view.wordSize * 8 ||
                    endBit < 0n ||
                    endBit >= BigInt(view.wordSize * 8)
                )
                    throw new Error("Corrupt vector<bool> bit offset");
                view.count = count((endAddress - view.address) * 8n + endBit - BigInt(view.bitOffset));
                view.bits = true;
            } else {
                view.address = await this.number(start, context);
                const end = await this.number(finish, context);
                view.elementSize = await this.size(args[0], context);
                if ((end - view.address) % view.elementSize) throw new Error("Corrupt vector element alignment");
                view.count = count((end - view.address) / view.elementSize);
            }
            const storage = await this.number(fields.get("_M_end_of_storage"), context);
            if (!view.bits && (storage - view.address) % view.elementSize)
                throw new Error("Corrupt vector storage alignment");
            const capacity = view.bits ? (storage - view.address) * 8n : (storage - view.address) / view.elementSize;
            if (capacity < BigInt(view.count) || (!view.address && capacity))
                throw new Error("Corrupt vector capacity");
            view.summary = `vector length ${view.count}, capacity ${count(capacity)}`;
            return view;
        }
        if (kind === "array") {
            if (!/^\d+$/.test(args[1])) throw new Error("Unsupported array extent");
            view.count = count(BigInt(args[1]));
            if (view.count) {
                view.array = (await this.fields(node.item, ["_M_elems"], context)).get("_M_elems");
                if (Number(view.array.numchild) !== view.count) throw new Error("Array layout mismatch");
            }
            view.summary = `array length ${view.count}`;
            return view;
        }
        if (kind === "pair") {
            view.fields = await this.fields(node.item, ["first", "second"], context);
            view.count = 2;
            view.summary = "pair";
            return view;
        }
        if (kind === "tuple") {
            view.tuple = await this.tuple(node.item, context);
            view.count = args.length;
            if (view.tuple.size !== view.count) throw new Error("Unsupported tuple storage layout");
            view.summary = `tuple length ${view.count}`;
            return view;
        }
        if (kind === "list" || kind === "forward_list") return this.linked(node, view, context);
        if (kind === "deque") return this.deque(node, view, context);
        if (kind === "weak_ptr") {
            const fields = await this.fields(node.item, ["_M_ptr", "_M_refcount"], context);
            const control = (await this.fields(fields.get("_M_refcount"), ["_M_pi"], context)).get("_M_pi");
            view.address = await this.number(fields.get("_M_ptr"), context);
            const owner = await this.number(control, context);
            let references = 0n;
            if (owner)
                references = await this.number(
                    (await this.fields(control, ["_M_use_count"], context)).get("_M_use_count"),
                    context
                );
            if (references < 0n) throw new Error("Corrupt weak_ptr owner count");
            view.pointeeType = safeType(args[0]);
            view.count = references > 0n && view.address ? 1 : 0;
            view.summary = view.count
                ? `weak_ptr 0x${view.address.toString(16)} (use_count ${references})`
                : "weak_ptr expired";
            return view;
        }
        if (kind === "unique_ptr" || kind === "shared_ptr") {
            let pointer;
            if (kind === "shared_ptr") pointer = (await this.fields(node.item, ["_M_ptr"], context)).get("_M_ptr");
            else {
                const storage = (await this.fields(node.item, ["_M_t"], context)).get("_M_t");
                pointer = (await this.tuple(storage, context)).get(0);
                if (!pointer) throw new Error("Unsupported unique_ptr storage layout");
            }
            const pointerType = /\*\s*(?:const)?\s*$/.test(pointer.type)
                ? pointer.type
                : await this.canonical(pointer, context);
            if (!/\*\s*(?:const)?\s*$/.test(pointerType)) throw new Error("Fancy pointers are not supported");
            view.address = await this.number(pointer, context);
            view.pointeeType = safeType(args[0]);
            await this.size(view.pointeeType, context);
            view.count = view.address ? 1 : 0;
            view.summary = `${kind} ${view.address ? `0x${view.address.toString(16)}` : "nullptr"}`;
            return view;
        }
        if (kind === "optional") {
            const engaged = (await this.fields(node.item, ["_M_engaged"], context)).get("_M_engaged");
            const value = await this.number(engaged, context);
            if (![0n, 1n].includes(value)) throw new Error("Corrupt optional discriminator");
            view.count = Number(value);
            if (view.count) view.value = (await this.fields(node.item, ["_M_value"], context)).get("_M_value");
            view.summary = view.count ? "optional engaged" : "optional empty";
            return view;
        }
        if (kind === "variant") {
            const fields = await this.fields(node.item, ["_M_index", "_M_u"], context);
            const index = await this.number(fields.get("_M_index"), context);
            const indexSize = await this.size(fields.get("_M_index").type, context);
            if (![1n, 2n, 4n, 8n].includes(indexSize)) throw new Error("Unsupported variant index layout");
            if (index === -1n || index === (1n << (indexSize * 8n)) - 1n) {
                view.summary = "variant valueless_by_exception";
                return view;
            }
            if (index < 0n || index >= BigInt(args.length)) throw new Error("Corrupt variant discriminator");
            view.branch = Number(index);
            view.address = (await this.address(node.item, context)) + (await this.offset(info.type, "_M_u", context));
            // Every alternative starts at the union address, including non-trivial storage.
            await this.size(args[view.branch], context);
            view.count = 1;
            view.summary = `variant index ${view.branch}: ${args[view.branch]}`;
            return view;
        }
        return this.associative(node, view, context);
    }
    async tuple(item, context) {
        const found = new Map();
        const queue = [{ item, depth: 0 }];
        while (queue.length) {
            const current = queue.shift();
            if (current.depth >= MAX_DEPTH || context.fields + Number(current.item.numchild) > FIELD_LIMIT)
                throw new Error("Tuple layout probe budget exceeded");
            const children = await this.raw(current.item, 0, Number(current.item.numchild), context);
            context.fields += children.length;
            const head = current.item.exp?.match(/^std::_Head_base<(\d+),/);
            if (head) {
                let value = children.find((child) => child.exp === "_M_head_impl");
                if (!value) {
                    try {
                        value = (await this.fields(current.item, ["_M_head_impl"], context)).get("_M_head_impl");
                    } catch (error) {
                        this.store.check(context.generation);
                        if (!/^Unsupported STL layout/.test(error.message)) throw error;
                        value = children.find((child) => !["public", "private", "protected"].includes(child.exp));
                    }
                }
                if (value) found.set(Number(head[1]), value);
            } else {
                for (const child of children)
                    if (Number(child.numchild) && this.wrapper(child))
                        queue.push({ item: child, depth: current.depth + 1 });
            }
        }
        return found;
    }
    async linked(node, view, context) {
        const forward = view.kind === "forward_list";
        const headerName = forward ? "_M_head" : "_M_node";
        const header = (await this.fields(node.item, [headerName], context)).get(headerName);
        const first = (await this.fields(header, ["_M_next"], context)).get("_M_next");
        view.first = await this.number(first, context);
        view.linkName = "_M_next";
        view.linked = true;
        const baseType = safeType(first.type.replace(/\s*\*\s*$/, ""));
        view.linkOffsets = { _M_next: await this.offset(baseType, "_M_next", context) };
        view.sentinel = forward
            ? 0n
            : (await this.address(node.item, context)) +
              (await this.offset(view.info.type, "_M_impl._M_node", context));
        view.valueOffset = await this.offset(
            `std::${forward ? "_Fwd_list_node" : "_List_node"}<${safeType(view.info.args[0])}>`,
            "_M_storage._M_storage",
            context
        );
        if (forward) {
            const seen = new Set();
            let address = view.first;
            while (address) {
                this.step(context);
                if (seen.has(address.toString())) throw new Error("Cycle in forward_list");
                seen.add(address.toString());
                address = await this.pointer(address + view.linkOffsets._M_next, context);
            }
            view.count = seen.size;
        } else
            view.count = count(
                await this.number((await this.fields(header, ["_M_size"], context)).get("_M_size"), context)
            );
        if (view.count && (!view.first || view.first === view.sentinel))
            throw new Error("Corrupt linked container head");
        view.cursors = new Map([[0, view.first]]);
        view.addresses = new Map();
        view.seen = new Set();
        view.summary = `${view.kind} length ${view.count}`;
        return view;
    }
    async deque(node, view, context) {
        const iterators = await this.fields(node.item, ["_M_start", "_M_finish"], context);
        const decode = async (item) => {
            const fields = await this.fields(item, ["_M_cur", "_M_first", "_M_last", "_M_node"], context);
            const values = {};
            for (const [name, field] of fields) values[name] = await this.number(field, context);
            return values;
        };
        const start = await decode(iterators.get("_M_start")),
            end = await decode(iterators.get("_M_finish"));
        view.elementSize = await this.size(view.info.args[0], context);
        view.width = await this.size("void*", context);
        const blockBytes = start._M_last - start._M_first;
        if (
            ![4n, 8n].includes(view.width) ||
            !start._M_node ||
            end._M_node < start._M_node ||
            (end._M_node - start._M_node) % view.width ||
            blockBytes <= 0n ||
            blockBytes % view.elementSize ||
            end._M_last - end._M_first !== blockBytes ||
            start._M_cur < start._M_first ||
            start._M_cur >= start._M_last ||
            end._M_cur < end._M_first ||
            end._M_cur >= end._M_last ||
            (start._M_cur - start._M_first) % view.elementSize ||
            (end._M_cur - end._M_first) % view.elementSize
        )
            throw new Error("Corrupt deque iterator layout");
        if (
            (await this.pointer(start._M_node, context)) !== start._M_first ||
            (await this.pointer(end._M_node, context)) !== end._M_first
        )
            throw new Error("Deque map does not match its iterators");
        view.address = start._M_cur;
        view.startNode = start._M_node;
        view.finishNode = end._M_node;
        view.blockSize = blockBytes / view.elementSize;
        view.startOffset = (start._M_cur - start._M_first) / view.elementSize;
        view.count = count(
            ((end._M_node - start._M_node) / view.width) * view.blockSize +
                (end._M_cur - end._M_first) / view.elementSize -
                view.startOffset
        );
        view.summary = `deque length ${view.count}`;
        return view;
    }
    async associative(node, view, context) {
        const { kind, args } = view.info;
        view.map = MAP_KINDS.has(kind);
        view.associative = true;
        const pair = view.map ? `std::pair<${safeType(args[0])} const, ${safeType(args[1])}>` : safeType(args[0]);
        if (ORDERED_KINDS.has(kind)) {
            const fields = await this.fields(node.item, ["_M_header", "_M_node_count"], context);
            view.count = count(await this.number(fields.get("_M_node_count"), context));
            if (!view.count) return { ...view, summary: `${kind} length 0` };
            view.sentinel =
                (await this.address(node.item, context)) +
                (await this.offset(view.info.type, "_M_t._M_impl._M_header", context));
            const header = await this.fields(fields.get("_M_header"), ["_M_left"], context);
            view.first = await this.number(header.get("_M_left"), context);
            view.baseType = safeType(fields.get("_M_header").type);
            view.linkOffsets = {};
            for (const name of ["_M_left", "_M_right", "_M_parent"])
                view.linkOffsets[name] = await this.offset(view.baseType, name, context);
            view.nodeType = `std::_Rb_tree_node<${pair}>`;
        } else {
            const fields = await this.fields(node.item, ["_M_before_begin", "_M_element_count"], context);
            view.count = count(await this.number(fields.get("_M_element_count"), context));
            if (!view.count) return { ...view, summary: `${kind} length 0` };
            const first = await this.fields(fields.get("_M_before_begin"), ["_M_nxt"], context);
            view.first = await this.number(first.get("_M_nxt"), context);
            const hashtable = (await this.fields(node.item, ["_M_h"], context)).get("_M_h");
            // GDB may preserve _Hashtable typedefs; its physical base types expose the policy.
            const bases = await this.raw(hashtable, 0, Math.min(Number(hashtable.numchild), FIELD_LIMIT), context);
            const hash = [hashtable.type, ...bases.map((base) => base.type || base.exp)]
                .join(" ")
                .match(/_Hashtable_traits<\s*(true|false|0|1),/);
            if (!hash) throw new Error("Unknown unordered_map hash node policy");
            view.baseType = safeType(fields.get("_M_before_begin").type);
            view.linkOffsets = { _M_nxt: await this.offset(view.baseType, "_M_nxt", context) };
            view.nodeType = `std::__detail::_Hash_node<${pair}, ${["true", "1"].includes(hash[1]) ? "true" : "false"}>`;
        }
        view.valueOffset = await this.offset(view.nodeType, "_M_storage._M_storage", context);
        view.pairType = pair;
        view.cursors = new Map([[0, view.first]]);
        view.addresses = new Map();
        view.seen = new Set();
        if (view.count && (!view.first || view.first === view.sentinel)) throw new Error("Corrupt map head");
        view.summary = `${kind} length ${view.count}`;
        return view;
    }
    step(context) {
        if (++context.steps > WALK_LIMIT)
            throw new Error("STL traversal budget exceeded; load preceding pages sequentially");
    }
    async successor(view, address, context) {
        const link = (pointer, name) => this.pointer(pointer + view.linkOffsets[name], context);
        this.step(context);
        if (view.linked) return link(address, view.linkName);
        if (HASH_KINDS.has(view.kind)) return link(address, "_M_nxt");
        let current = await link(address, "_M_right");
        if (current) {
            const visited = new Set();
            while (current) {
                this.step(context);
                if (visited.has(current.toString())) throw new Error("Cycle in map tree");
                visited.add(current.toString());
                const left = await link(current, "_M_left");
                if (!left) return current;
                current = left;
            }
        }
        current = address;
        const visited = new Set();
        let parent = await link(current, "_M_parent");
        while (parent !== view.sentinel) {
            this.step(context);
            if (!parent || visited.has(parent.toString())) throw new Error("Cycle or invalid parent in map tree");
            visited.add(parent.toString());
            if (current !== (await link(parent, "_M_right"))) return parent;
            current = parent;
            parent = await link(current, "_M_parent");
        }
        return view.sentinel;
    }
    async mapAddress(view, index, context) {
        if (view.addresses.has(index)) return view.addresses.get(index);
        let ordinal = 0;
        for (const candidate of view.cursors.keys()) if (candidate <= index && candidate > ordinal) ordinal = candidate;
        let address = view.cursors.get(ordinal);
        while (ordinal <= index) {
            if (!address || address === view.sentinel) throw new Error("Map iterator ended before declared length");
            if (!view.addresses.has(ordinal)) {
                if (view.seen.has(address.toString())) throw new Error("Cycle in map node chain");
                view.seen.add(address.toString());
                view.addresses.set(ordinal, address);
            }
            const next = await this.successor(view, address, context);
            view.cursors.set(ordinal + 1, next);
            if (ordinal === index) return address;
            address = next;
            ordinal++;
        }
    }
    async expand(node, from, size, context) {
        await this.bindFrame(node, context);
        const view = node.stl;
        const end = Math.min(view.count, from + size);
        const nodes = [];
        if (view.kind === "array") {
            const items = from < end ? await this.raw(view.array, from, end - from, context) : [];
            for (let index = 0; index < items.length; index++)
                nodes.push(await this.physical(node, `[${from + index}]`, items[index], context));
        } else if (view.kind === "pair" || view.kind === "tuple") {
            for (let index = from; index < end; index++) {
                const label = view.kind === "pair" ? ["first", "second"][index] : `[${index}]`;
                nodes.push(
                    await this.physical(
                        node,
                        label,
                        view.kind === "pair" ? view.fields.get(label) : view.tuple.get(index),
                        context
                    )
                );
            }
        } else if (view.kind === "optional") {
            if (from < end) nodes.push(await this.physical(node, "value", view.value, context));
        } else if (["unique_ptr", "shared_ptr", "weak_ptr"].includes(view.kind)) {
            if (from < end)
                nodes.push(
                    await this.materialize(
                        node,
                        "value",
                        await this.elementExpression(view.pointeeType, view.address, context),
                        context,
                        false,
                        false
                    )
                );
        } else if (view.kind === "variant") {
            if (from < end)
                nodes.push(
                    await this.materialize(
                        node,
                        "value",
                        await this.elementExpression(view.info.args[view.branch], view.address, context),
                        context
                    )
                );
        } else if (view.bits) {
            if (from >= end) return { nodes, more: false, map: false };
            const begin = Math.floor((view.bitOffset + from) / 8);
            const bytes = await this.memory(
                view.address + BigInt(begin),
                Math.ceil((view.bitOffset + end) / 8) - begin,
                context
            );
            for (let index = from; index < end; index++) {
                const bit = view.bitOffset + index;
                nodes.push({
                    kind: "variable",
                    item: {
                        name: "",
                        exp: `[${index}]`,
                        type: "bool",
                        value: String(!!(bytes[Math.floor(bit / 8) - begin] & (1 << (bit % 8)))),
                        numchild: "0"
                    },
                    readOnly: true
                });
            }
        } else if (view.linked || view.kind === "deque") {
            for (let index = from; index < end; index++) {
                let address;
                if (view.linked) address = (await this.mapAddress(view, index, context)) + view.valueOffset;
                else {
                    const ordinal = BigInt(view.startOffset) + BigInt(index);
                    const block = BigInt(view.startNode) + (ordinal / BigInt(view.blockSize)) * BigInt(view.width);
                    if (block > view.finishNode) throw new Error("Deque element exceeds its map");
                    address =
                        (await this.pointer(block, context)) +
                        (ordinal % BigInt(view.blockSize)) * BigInt(view.elementSize);
                }
                nodes.push(
                    await this.materialize(
                        node,
                        `[${index}]`,
                        await this.elementExpression(view.info.args[0], address, context),
                        context
                    )
                );
            }
        } else if (view.associative) {
            for (let index = from; index < end; index++) {
                const address = (await this.mapAddress(view, index, context)) + view.valueOffset;
                if (!view.map) {
                    nodes.push(
                        await this.materialize(
                            node,
                            `[${index}]`,
                            await this.elementExpression(view.pairType, address, context),
                            context,
                            true
                        )
                    );
                    continue;
                }
                const pair = await this.materialize(
                    node,
                    `entry:${index}`,
                    await this.elementExpression(view.pairType, address, context),
                    context
                );
                if (!pair.stl || pair.stl.kind !== "pair") throw new Error("Unsupported map payload layout");
                nodes.push(await this.physical(node, "key", pair.stl.fields.get("first"), context, true));
                nodes.push(await this.physical(node, "value", pair.stl.fields.get("second"), context));
            }
        } else {
            for (let index = from; index < end; index++) {
                const expression = await this.elementExpression(
                    view.kind === "basic_string" ? "char" : view.info.args[0],
                    view.address + BigInt(index) * (view.elementSize || 1n),
                    context
                );
                nodes.push(await this.materialize(node, `[${index}]`, expression, context));
            }
        }
        return { nodes, map: !!view.map, more: end < view.count };
    }
    async refresh(node, context) {
        if (!node.stl) return;
        const previous = node.stl;
        const owned = [...this.store.nodes.values()].filter(
            (child) => child.ownsVariable && this.store.descendant(child, node)
        );
        delete node.stl;
        node.stlAttempted = false;
        await this.prepare(node, context);
        if (node.stl && storageIdentity(previous) === storageIdentity(node.stl)) {
            node.stl.elements = previous.elements;
            return;
        }
        this.store.dropChildren(node);
        for (const child of owned) {
            await this.command(`-var-delete ${quote(child.item.name)}`, context);
            this.session.varObjects.delete(child.item.name);
        }
    }
}

module.exports = {
    StlDisplay,
    templateType,
    kindOf,
    constValue,
    indirectType,
    integer,
    safeType,
    safePath,
    gdbVariablePath,
    isInternalError,
    MEMORY_LIMIT,
    WALK_LIMIT
};
