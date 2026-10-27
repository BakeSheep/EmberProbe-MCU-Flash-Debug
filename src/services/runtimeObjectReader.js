"use strict";

const elf = require("../elfSymbols");
const { MAX_COMPOSITE_DEPTH, MAX_TYPE_ALIASES } = require("../dwarf/layoutLimits");
const { formatPointer } = require("../webview/runtime");
const { elementPath, flatMember, memberPath, summaryShown } = require("./runtimeExpansion");

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

function pointerFailureReason(code) {
    return (
        {
            LIVE_ADDRESS_NOT_RAM: "not-ram",
            LIVE_MEMORY_UNAVAILABLE: "memory-unavailable",
            LIVE_POINTER_CYCLE: "cycle",
            LIVE_READ_BUDGET_EXCEEDED: "expansion-budget"
        }[code] || code.slice(5).toLowerCase().replace(/_/g, "-")
    );
}

class RuntimeObjectReader {
    // `frozen`: the target is halted for the whole read (the guard enforces it), so memory cannot
    // change underneath and descriptors need no second read. `cache` may then be shared by every
    // reader of the same halted snapshot.
    constructor(
        item,
        read,
        guard = () => {},
        budget = { bytes: 0, commands: 0, deadline: Date.now() + 1000 },
        options = {}
    ) {
        this.item = item;
        this.graph = item.runtimeLayout;
        this.readRaw = read;
        this.guard = guard;
        this.budget = budget;
        this.frozen = !!options.frozen;
        this.cache = this.frozen && Array.isArray(options.cache) ? options.cache : [];
        this.descriptors = new Map();
        this.verificationBudget = { bytes: 0, commands: 0 };
        this.pointerExpansionStopped = false;
        this.nodes = 0;
        // Paths the waveform view opened (see runtimeExpansion.js); absent reads the whole object.
        this.expanded = Array.isArray(item.runtimeExpanded) ? new Set(item.runtimeExpanded) : null;
    }
    opened(path) {
        return !this.expanded || this.expanded.has(path);
    }
    type(id) {
        for (let depth = 0; depth < MAX_TYPE_ALIASES; depth++) {
            const type = this.graph.types[id];
            if (!type) throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime type is unavailable");
            if (type.kind !== "alias") return { ...type, id };
            id = type.target;
        }
        throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime type aliases form a cycle");
    }
    size(id) {
        const type = this.type(id);
        if (type.unobservable)
            throw Object.assign(
                failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime type is unavailable: " + type.unobservable),
                { unobservable: type.unobservable }
            );
        const size = type.byteSize || (type.kind === "array" ? type.count * this.size(type.target) : 0);
        if (!Number.isSafeInteger(size) || size <= 0 || size > 65536)
            throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime object size is unavailable or oversized");
        return size;
    }
    async memory(address, size, fresh = false, descriptor = false) {
        if (this.frozen) descriptor = false;
        this.guard();
        if (Date.now() > this.budget.deadline)
            throw failure("LIVE_READ_BUDGET_EXCEEDED", "Runtime object time budget exceeded");
        if (
            !Number.isSafeInteger(address) ||
            address <= 0 ||
            !Number.isSafeInteger(size) ||
            size <= 0 ||
            address + size > 0x100000000 ||
            !this.item.runtimeRanges?.some((range) => address >= range.start && address + size <= range.end)
        )
            throw failure("LIVE_ADDRESS_NOT_RAM", "Runtime object points outside verified ELF memory ranges");
        const cached =
            !fresh &&
            this.cache.find(
                (entry) => address >= entry.address && address + size <= entry.address + entry.bytes.length
            );
        const previous = descriptor ? this.descriptors.get(address) : null;
        // Every descriptor needs a fresh read at the end, even when its initial bytes were cached.
        const verificationBytes = this.verificationBudget.bytes + (descriptor ? size - (previous?.length || 0) : 0);
        const verificationCommands = this.verificationBudget.commands + (descriptor && !previous ? 1 : 0);
        if (
            this.budget.bytes + (cached ? 0 : size) + verificationBytes > 4096 ||
            this.budget.commands + (cached ? 0 : 1) + verificationCommands > 32
        )
            throw failure("LIVE_READ_BUDGET_EXCEEDED", "Runtime object exceeds 4096 bytes / 32 reads per cycle");
        let bytes;
        if (cached) bytes = cached.bytes.subarray(address - cached.address, address - cached.address + size);
        else {
            this.budget.bytes += size;
            this.budget.commands++;
            bytes = Buffer.from((await this.readRaw(address, size)) || []);
            this.guard();
            if (bytes.length !== size)
                throw failure("LIVE_MEMORY_UNAVAILABLE", "Runtime object memory read was incomplete");
            if (!fresh) this.cache.push({ address, bytes });
        }
        if (descriptor) {
            this.descriptors.set(address, bytes);
            this.verificationBudget.bytes = verificationBytes;
            this.verificationBudget.commands = verificationCommands;
        }
        return bytes;
    }
    async word(address, descriptor = false, signed = false) {
        const bytes = await this.memory(address, 4, false, descriptor);
        return signed ? bytes.readInt32LE() : bytes.readUInt32LE();
    }
    async expression(address, expression) {
        const stack = [address];
        const bytes = Buffer.from(expression || []);
        const cursor = { p: 0 };
        let steps = 0;
        while (cursor.p < bytes.length && ++steps <= 32) {
            const op = bytes[cursor.p++];
            if (op === 0x12)
                stack.push(stack.at(-1)); // dup
            else if (op === 0x06)
                stack.push(await this.word(stack.pop(), true)); // deref
            else if (op === 0x10) stack.push(require("../dwarf/binary").readULEB(bytes, cursor));
            else if (op === 0x11) stack.push(require("../dwarf/binary").readSLEB(bytes, cursor));
            else if (op === 0x23) stack.push(stack.pop() + require("../dwarf/binary").readULEB(bytes, cursor));
            else if (op === 0x22 || op === 0x1c) {
                const right = stack.pop(),
                    left = stack.pop();
                stack.push(op === 0x22 ? left + right : left - right);
            } else throw failure("LIVE_LAYOUT_UNSUPPORTED", "Unsupported runtime DWARF member expression");
            if (stack.length > 16 || stack.some((value) => !Number.isSafeInteger(value)))
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime DWARF expression stack");
        }
        if (stack.length !== 1 || cursor.p !== bytes.length)
            throw failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime DWARF member expression");
        return stack[0];
    }
    async field(object, name, depth = 0, internal = false) {
        if (depth > MAX_COMPOSITE_DEPTH)
            throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime member lookup depth exceeded");
        const type = this.type(object.type);
        const direct = type.fields?.filter((field) => field.name === name) || [];
        if (direct.length === 1) return this.member(object, direct[0]);
        if (direct.length > 1) throw failure("LIVE_LAYOUT_UNSUPPORTED", "Ambiguous runtime member " + name);
        const matches = [];
        for (const field of type.fields || []) {
            if (
                !field.isBase &&
                field.name !== "?" &&
                (!internal || !["class", "union"].includes(this.type(field.type).kind))
            )
                continue;
            try {
                matches.push(await this.field(await this.member(object, field), name, depth + 1, internal));
            } catch (error) {
                if (error.code !== "LIVE_MEMBER_MISSING") throw error;
            }
        }
        if (matches.length !== 1)
            throw failure(
                matches.length ? "LIVE_LAYOUT_UNSUPPORTED" : "LIVE_MEMBER_MISSING",
                "Runtime member unavailable: " + name
            );
        return matches[0];
    }
    async member(object, field) {
        const unavailable = field.unobservable || this.type(field.type).unobservable;
        if (unavailable)
            throw Object.assign(failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime member is unavailable: " + unavailable), {
                unobservable: unavailable
            });
        const type = this.type(object.type);
        const offset = field.dataBitOffset !== undefined ? Math.floor(field.dataBitOffset / 8) : field.offset;
        const address = Number.isSafeInteger(offset)
            ? object.address + offset
            : field.expression
              ? await this.expression(object.address, field.expression)
              : type.kind === "union"
                ? object.address
                : null;
        if (address === null) throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime member location is unavailable");
        return { address, type: field.type, field };
    }
    async path(object, path, internal = false) {
        for (const name of path.split(".")) object = await this.field(object, name, 0, internal);
        return object;
    }
    async pointer(object) {
        return this.word(object.address, true);
    }
    async number(object, descriptor = false) {
        const type = this.type(object.type);
        const bytes = await this.memory(object.address, this.size(object.type), false, descriptor);
        const value = elf.decodeValue(bytes, type.watchType);
        if (!Number.isSafeInteger(value) || value < 0)
            throw failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime discriminator");
        return value;
    }
    nodeType(pattern, valueType, mapArgs) {
        const valueName = valueType === undefined ? null : this.type(valueType).typeName;
        const candidates = this.graph.types
            .map((type, id) => ({ ...type, id }))
            .filter(
                (type) =>
                    type.kind === "class" &&
                    pattern.test(type.typeName) &&
                    type.args?.length > 0 &&
                    (!valueName || this.type(type.args?.[0]).typeName === valueName) &&
                    (!mapArgs ||
                        (this.type(type.args?.[0]).args?.length >= 2 &&
                            this.type(type.args?.[0])
                                .args.slice(0, 2)
                                .every((id, index) => this.type(id).typeName === this.type(mapArgs[index]).typeName)))
            );
        const unique = new Map(
            candidates.map((type) => [
                JSON.stringify([
                    type.typeName,
                    type.byteSize,
                    type.fields?.map((field) => [field.name, field.offset, this.type(field.type).typeName])
                ]),
                type
            ])
        );
        if (unique.size === 1) return unique.values().next().value.id;
        if (candidates.length !== 1)
            throw failure(
                "LIVE_LAYOUT_UNSUPPORTED",
                `Runtime STL node type is unavailable or ambiguous: ${pattern} (${candidates.length})`
            );
        return candidates[0].id;
    }
    async tupleFields(object, depth = 0, fields = []) {
        if (depth > MAX_COMPOSITE_DEPTH)
            throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime tuple layout depth exceeded");
        const node = this.type(object.type);
        for (const member of node.fields || []) {
            if (member.name === "_M_head_impl") {
                const index = node.typeName.match(/_Head_base<(\d+),/);
                if (index) fields[Number(index[1])] = await this.member(object, member);
            } else if (member.isBase || ["class", "union"].includes(this.type(member.type).kind))
                await this.tupleFields(await this.member(object, member), depth + 1, fields);
        }
        return fields;
    }
    async dereference(object, dynamic = true) {
        const type = this.type(object.type);
        if (!["pointer", "reference"].includes(type.kind)) return object;
        const address = await this.pointer(object);
        if (!address) throw failure("LIVE_NULL_POINTER", "Runtime pointer is null");
        object = { address, type: type.target };
        return dynamic ? this.dynamic(object) : object;
    }
    async dynamic(object) {
        const type = this.type(object.type);
        if (type.kind !== "class" || !type.fields?.some((field) => field.name.startsWith("_vptr"))) return object;
        const field = type.fields.find((field) => field.name.startsWith("_vptr"));
        const pointer = await this.word((await this.member(object, field)).address, true);
        const entries =
            this.graph.dynamicTypes?.filter(
                (entry) => pointer >= entry.address + 8 && pointer < entry.address + entry.size
            ) || [];
        if (entries.length !== 1)
            throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime dynamic type has no verified vtable identity");
        const offset = await this.word(pointer - 8, true, true);
        return { address: object.address + offset, type: entries[0].type };
    }
    async storage(object) {
        const type = this.type(object.type);
        const kind = type.stl;
        if (!kind) return null;
        const field = (name) => this.path(object, name, true);
        const pointer = async (name) => this.pointer(await field(name));
        const number = async (name) => this.number(await field(name), true);
        if (kind === "basic_string") {
            if (this.type(type.args[0]).typeName !== "char" || !type.typeName.startsWith("std::__cxx11::"))
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime string requires the libstdc++ C++11 char ABI");
            const start = await pointer("_M_dataplus._M_p"),
                count = await number("_M_string_length");
            return {
                count,
                element: type.args[0],
                at: async (index) => ({ address: start + index, type: type.args[0] })
            };
        }
        if (kind === "vector") {
            const startField = await field("_M_start");
            if (this.type(startField.type).kind !== "pointer") {
                const start = await this.pointer(await this.field(startField, "_M_p"));
                const firstBit = await this.number(await this.field(startField, "_M_offset"), true);
                const finishField = await field("_M_finish");
                const finish = await this.pointer(await this.field(finishField, "_M_p"));
                const finalBit = await this.number(await this.field(finishField, "_M_offset"), true);
                const capacity = await pointer("_M_end_of_storage");
                const count = (finish - start) * 8 + finalBit - firstBit;
                if (firstBit >= 32 || finalBit >= 32 || finish < start || capacity < finish || count < 0)
                    throw failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime vector<bool> descriptor");
                return {
                    count,
                    at: async (index) => ({
                        address: start + Math.floor((firstBit + index) / 8),
                        type: type.args[0],
                        field: { bitSize: 1, bitOffset: (firstBit + index) % 8 }
                    })
                };
            }
            const start = await this.pointer(startField),
                finish = await pointer("_M_finish"),
                capacity = await pointer("_M_end_of_storage");
            const size = this.size(type.args[0]);
            if (
                finish < start ||
                capacity < finish ||
                (finish - start) % size ||
                (capacity - start) % size ||
                (!start && finish)
            )
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime vector descriptor");
            return {
                count: (finish - start) / size,
                element: type.args[0],
                at: async (index) => ({ address: start + index * size, type: type.args[0] })
            };
        }
        if (kind === "array") {
            const values = await field("_M_elems");
            const array = this.type(values.type);
            return {
                count: array.count,
                element: array.target,
                at: async (index) => ({ address: values.address + index * this.size(array.target), type: array.target })
            };
        }
        if (["unique_ptr", "shared_ptr", "weak_ptr"].includes(kind)) {
            let value;
            if (kind === "unique_ptr") value = (await this.tupleFields(await field("_M_t")))[0];
            else value = await field("_M_ptr");
            if (!value || this.type(value.type).kind !== "pointer")
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Unsupported runtime smart-pointer layout");
            const address = await this.pointer(value);
            let count = address ? 1 : 0;
            if (kind === "weak_ptr") {
                const control = await field("_M_refcount._M_pi");
                const ownerAddress = await this.pointer(control);
                count =
                    ownerAddress &&
                    (await this.number(
                        await this.field(
                            { address: ownerAddress, type: this.type(control.type).target },
                            "_M_use_count"
                        ),
                        true
                    )) > 0
                        ? count
                        : 0;
            }
            return { count, named: true, at: async () => this.dynamic({ address, type: type.args[0] }) };
        }
        if (kind === "optional") {
            const count = await number("_M_engaged");
            if (count > 1) throw failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime optional discriminator");
            return { count, named: true, at: async () => field("_M_value") };
        }
        if (kind === "variant") {
            const index = await number("_M_index");
            if (index === 255 || index === 65535 || index === 0xffffffff) return { count: 0, named: true };
            if (index >= type.args.length)
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime variant discriminator");
            const union = await field("_M_u");
            return { count: 1, named: true, at: async () => ({ address: union.address, type: type.args[index] }) };
        }
        if (["pair", "tuple"].includes(kind)) {
            const fields = kind === "tuple" ? await this.tupleFields(object) : [];
            if (kind === "pair") fields.push(await field("first"), await field("second"));
            if (fields.length !== type.args.length || fields.some((entry) => !entry))
                throw failure(
                    "LIVE_LAYOUT_UNSUPPORTED",
                    `Runtime tuple layout is incomplete: ${type.typeName} (${fields.length}/${type.args.length})`
                );
            return {
                count: fields.length,
                labels: kind === "pair" ? ["first", "second"] : null,
                at: async (index) => fields[index]
            };
        }
        if (kind === "deque") {
            const start = await field("_M_start"),
                finish = await field("_M_finish");
            const startPointer = await this.pointer(await this.field(start, "_M_cur"));
            const first = await this.pointer(await this.field(start, "_M_first"));
            const last = await this.pointer(await this.field(start, "_M_last"));
            const startNode = await this.pointer(await this.field(start, "_M_node"));
            const finishPointer = await this.pointer(await this.field(finish, "_M_cur"));
            const finishFirst = await this.pointer(await this.field(finish, "_M_first"));
            const finishNode = await this.pointer(await this.field(finish, "_M_node"));
            const map = await pointer("_M_map"),
                mapCount = await number("_M_map_size");
            const width = this.size(type.args[0]),
                blockBytes = last - first;
            if (
                blockBytes <= 0 ||
                blockBytes % width ||
                startPointer < first ||
                startPointer >= last ||
                finishPointer < finishFirst ||
                finishPointer >= finishFirst + blockBytes ||
                startNode < map ||
                finishNode < startNode ||
                finishNode >= map + mapCount * 4 ||
                (finishNode - startNode) % 4
            )
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime deque descriptor");
            const count =
                (((finishNode - startNode) / 4) * blockBytes + finishPointer - finishFirst - (startPointer - first)) /
                width;
            if (!Number.isSafeInteger(count) || count < 0)
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime deque length");
            return {
                count,
                at: async (index) => {
                    const offset = startPointer - first + index * width;
                    const block = startNode + Math.floor(offset / blockBytes) * 4;
                    const address = await this.word(block, true);
                    return { address: address + (offset % blockBytes), type: type.args[0] };
                }
            };
        }
        if (
            [
                "list",
                "forward_list",
                "map",
                "multimap",
                "set",
                "multiset",
                "unordered_map",
                "unordered_multimap",
                "unordered_set",
                "unordered_multiset"
            ].includes(kind)
        ) {
            const isList = ["list", "forward_list"].includes(kind);
            const isHash = kind.startsWith("unordered_");
            const isMap = /map$/.test(kind);
            const node = this.nodeType(
                isList
                    ? kind === "list"
                        ? /::_List_node</
                        : /::_Fwd_list_node</
                    : isHash
                      ? /::_Hash_node</
                      : /::_Rb_tree_node</,
                isMap ? undefined : type.args[0],
                isMap ? type.args : null
            );
            const nodeInfo = this.type(node);
            const payloadType = isMap ? nodeInfo.args[0] : type.args[0];
            let first, sentinel, count;
            if (kind === "forward_list") {
                sentinel = (await field("_M_head")).address;
                first = await pointer("_M_head._M_next");
            } else if (kind === "list") {
                sentinel = (await field("_M_node")).address;
                first = await pointer("_M_node._M_next");
                try {
                    count = await number("_M_node._M_size");
                } catch (error) {
                    if (error.code !== "LIVE_MEMBER_MISSING") throw error;
                }
            } else if (isHash) {
                first = await pointer("_M_h._M_before_begin._M_nxt");
                count = await number("_M_h._M_element_count");
            } else {
                sentinel = (await field("_M_t._M_impl._M_header")).address;
                first = await pointer("_M_t._M_impl._M_header._M_left");
                count = await number("_M_t._M_impl._M_node_count");
            }
            const nodes = [];
            const seen = new Set();
            let current = first;
            const advance = async (address) => {
                const object = { address, type: node };
                if (isList || isHash) return this.pointer(await this.field(object, isHash ? "_M_nxt" : "_M_next"));
                let right = await this.pointer(await this.field(object, "_M_right"));
                if (right) {
                    let depth = 0;
                    while (right) {
                        if (++depth > 32) throw failure("LIVE_POINTER_CYCLE", "Cycle in runtime STL tree");
                        const left = await this.pointer(await this.field({ address: right, type: node }, "_M_left"));
                        if (!left) return right;
                        right = left;
                    }
                }
                let child = address;
                for (let depth = 0; depth < 32; depth++) {
                    const parent = await this.pointer(await this.field({ address: child, type: node }, "_M_parent"));
                    if (parent === sentinel) return sentinel;
                    if (!parent) throw failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime STL parent");
                    const parentRight = await this.pointer(
                        await this.field({ address: parent, type: node }, "_M_right")
                    );
                    if (parentRight !== child) return parent;
                    child = parent;
                }
                throw failure("LIVE_POINTER_CYCLE", "Cycle in runtime STL parent chain");
            };
            const at = async (index) => {
                while (nodes.length <= index) {
                    if (!current || current === sentinel || seen.has(current) || nodes.length >= 256)
                        throw failure("LIVE_POINTER_CYCLE", "Runtime STL chain ended early or contains a cycle");
                    seen.add(current);
                    nodes.push(current);
                    current = await advance(current);
                }
                const object = { address: nodes[index], type: node };
                let storage;
                try {
                    storage = await this.field(object, "_M_storage");
                } catch (error) {
                    if (error.code !== "LIVE_MEMBER_MISSING") throw error;
                    storage = await this.field(object, isList ? "_M_data" : "_M_value_field");
                }
                return { address: storage.address, type: payloadType };
            };
            if (count === undefined) {
                while (current && current !== sentinel) {
                    await at(nodes.length);
                }
                count = nodes.length;
            }
            if (!Number.isSafeInteger(count) || count < 0)
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime STL node count");
            return { count, at };
        }
        throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime STL layout is not available: " + kind);
    }
    async select(object, segments) {
        for (let index = 0; index < segments.length; index++) {
            const segment = segments[index];
            const type = this.type(object.type);
            if (["pointer", "reference"].includes(type.kind)) {
                object = await this.dereference(object);
                if (type.kind === "pointer" && (segment.kind === "dereference" || segment.name === "value")) continue;
            } else if (segment.kind === "dereference")
                throw failure("LIVE_MEMBER_MISSING", "Runtime path dereferences a non-pointer");
            const current = this.type(object.type);
            const storage = await this.storage(object);
            if (storage) {
                const position =
                    segment.kind === "index"
                        ? segment.index
                        : storage.named && segment.name === "value"
                          ? 0
                          : storage.labels?.indexOf(segment.name);
                if (!Number.isSafeInteger(position) || position < 0 || position >= storage.count)
                    throw failure("LIVE_MEMBER_MISSING", "Runtime container index is out of range");
                object = await storage.at(position);
            } else if (segment.kind === "member") object = await this.field(object, segment.name);
            else if (segment.kind === "index" && current.kind === "array" && segment.index < current.count)
                object = { address: object.address + segment.index * this.size(current.target), type: current.target };
            else throw failure("LIVE_MEMBER_MISSING", "Runtime path is not a single typed member");
        }
        return object;
    }
    async tree(
        object,
        depth = 0,
        ancestors = new Set(),
        followPointers = !this.item.runtimeStaticPointers,
        maxNodes = 256,
        path = "",
        open = true
    ) {
        const key = object.type + ":" + object.address;
        if (ancestors.has(key)) throw failure("LIVE_POINTER_CYCLE", "Runtime pointer graph contains a cycle");
        if (depth > MAX_COMPOSITE_DEPTH || this.nodes >= maxNodes)
            return {
                kind: "unavailable",
                unobservable: depth > MAX_COMPOSITE_DEPTH ? "depth-limit" : "expansion-budget"
            };
        this.nodes++;
        try {
            const next = new Set(ancestors).add(key);
            let type = this.type(object.type);
            if (type.unobservable)
                return { kind: "unavailable", typeName: type.typeName, unobservable: type.unobservable };
            const branchBudget = (remaining) =>
                this.nodes + Math.max(0, Math.floor((maxNodes - this.nodes) / remaining));
            const unavailable = () => ({
                kind: "unavailable",
                typeName: type.typeName,
                unobservable: "expansion-budget"
            });
            if (["pointer", "reference"].includes(type.kind)) {
                const pointerValue = await this.pointer(object);
                const identity = {
                    typeName: type.typeName || type.kind,
                    isPointer: true,
                    pointerTarget: type.pointerTarget,
                    address: object.address,
                    valueText: formatPointer(pointerValue)
                };
                const leaf = (reason = undefined) => ({
                    kind: "scalar",
                    type: "u32",
                    ...identity,
                    value: pointerValue,
                    ...(reason ? { unavailable: reason } : {})
                });
                if (!followPointers || !pointerValue) return leaf();
                if (["void", "function", "incomplete"].includes(type.pointerTarget)) return leaf("opaque-pointee");
                if (this.pointerExpansionStopped) return leaf("expansion-budget");
                try {
                    const target = this.type(type.target);
                    if (
                        target.unobservable ||
                        !["scalar", "class", "union", "array", "pointer", "reference"].includes(target.kind) ||
                        (target.kind === "scalar" && !target.watchType)
                    )
                        return leaf("opaque-pointee");
                    // A closed pointer keeps its address; its target is read once the view opens it.
                    if (!this.opened(path)) return { ...leaf(), collapsed: true };
                    const value = await this.tree(
                        await this.dereference(object),
                        depth + 1,
                        next,
                        followPointers,
                        maxNodes,
                        type.kind === "reference" ? path : path + ".value",
                        true
                    );
                    if (value.kind === "unavailable") return leaf(value.unobservable || "opaque-pointee");
                    if (type.kind === "reference") return value;
                    return {
                        kind: "class",
                        ...identity,
                        pointerValue,
                        members: [{ name: "value", ...value }]
                    };
                } catch (error) {
                    if (!error.code?.startsWith("LIVE_")) throw error;
                    if (error.code === "LIVE_READ_BUDGET_EXCEEDED") this.pointerExpansionStopped = true;
                    return leaf(pointerFailureReason(error.code));
                }
            }
            if (
                !open &&
                (type.stl || ["array", "class", "union"].includes(type.kind)) &&
                !summaryShown(type.stdSummary, type.stl)
            )
                return type.kind === "array"
                    ? {
                          kind: "array",
                          typeName: type.typeName,
                          totalElements: type.count,
                          elements: [],
                          collapsed: true
                      }
                    : { kind: type.kind, typeName: type.typeName, members: [], collapsed: true };
            if (type.byteSize && type.byteSize <= 256) await this.memory(object.address, type.byteSize);
            const storage = await this.storage(object);
            if (storage) {
                const count = Math.min(storage.count, 100);
                if (this.nodes + count > maxNodes) return unavailable();
                this.nodes += count;
                const values = [];
                for (let index = 0; index < count; index++) {
                    const name = storage.labels?.[index] || "value";
                    const child = storage.named || storage.labels ? memberPath(path, name) : elementPath(path, index);
                    values.push({
                        index,
                        name,
                        ...(await this.tree(
                            await storage.at(index),
                            depth + 1,
                            next,
                            true,
                            branchBudget(count - index),
                            child,
                            this.opened(child)
                        ))
                    });
                }
                const truncated = values.some((value) => value.unobservable || value.truncated);
                return storage.named || storage.labels
                    ? {
                          kind: "class",
                          typeName: type.typeName,
                          ...(type.stdSummary ? { stdSummary: type.stdSummary } : {}),
                          members: values,
                          partial: count < storage.count,
                          ...(truncated ? { truncated: true } : {})
                      }
                    : {
                          kind: "array",
                          typeName: type.typeName,
                          totalElements: storage.count,
                          elements: values,
                          partial: count < storage.count,
                          ...(truncated ? { truncated: true } : {})
                      };
            }
            if (type.kind === "array") {
                const count = Math.min(type.count, 100);
                if (this.nodes + count > maxNodes) return unavailable();
                this.nodes += count;
                const elements = [];
                for (let index = 0; index < count; index++)
                    elements.push({
                        index,
                        ...(await this.tree(
                            { address: object.address + index * this.size(type.target), type: type.target },
                            depth + 1,
                            next,
                            followPointers,
                            branchBudget(count - index),
                            elementPath(path, index),
                            this.opened(elementPath(path, index))
                        ))
                    });
                return {
                    kind: "array",
                    typeName: type.typeName,
                    totalElements: type.count,
                    elements,
                    partial: type.count > 100,
                    ...(elements.some((element) => element.unobservable || element.truncated)
                        ? { truncated: true }
                        : {})
                };
            }
            if (["class", "union"].includes(type.kind)) {
                const fields = (type.fields || []).filter((field) => !field.name.startsWith("_vptr"));
                if (this.nodes + fields.length > maxNodes) return unavailable();
                this.nodes += fields.length;
                const objects = new Map();
                // Reserve sibling pointer descriptors before an optional expansion can consume their read budget.
                for (const field of fields) {
                    const fieldType = this.type(field.type);
                    if (field.unobservable || fieldType.unobservable) continue;
                    const member = await this.member(object, field);
                    objects.set(field, member);
                    if (["pointer", "reference"].includes(fieldType.kind)) await this.pointer(member);
                }
                const members = [];
                let remaining = fields.length;
                for (const field of fields) {
                    const code = field.unobservable || this.type(field.type).unobservable;
                    if (code) {
                        members.push({
                            name: field.name,
                            ...(field.memberRole ? { memberRole: field.memberRole } : {}),
                            kind: "unavailable",
                            unobservable: code
                        });
                        remaining--;
                        continue;
                    }
                    const child = memberPath(path, field.name);
                    members.push({
                        name: field.name,
                        ...(field.memberRole ? { memberRole: field.memberRole } : {}),
                        ...(await this.tree(
                            objects.get(field),
                            depth + 1,
                            next,
                            followPointers,
                            branchBudget(remaining--),
                            child,
                            flatMember(field.name, field.memberRole) || this.opened(child)
                        ))
                    });
                }
                return {
                    kind: type.kind,
                    typeName: type.typeName,
                    ...(type.stdSummary ? { stdSummary: type.stdSummary } : {}),
                    members,
                    ...(members.some((member) => member.unobservable || member.truncated) ? { truncated: true } : {})
                };
            }
            if (type.kind !== "scalar" || !type.watchType)
                throw failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime scalar type is unavailable");
            const bytes = await this.memory(object.address, this.size(object.type));
            const bits = object.field?.bitSize;
            const decoded = bits
                ? elf.decodeBitfieldValue(bytes, type.watchType, object.field.bitOffset || 0, bits)
                : {
                      value: elf.decodeValue(bytes, type.watchType),
                      valueText: elf.decodeValueText(bytes, type.watchType)
                  };
            return {
                kind: "scalar",
                type: type.watchType,
                typeName: type.typeName,
                address: object.address,
                ...decoded,
                ...(type.enumInfo ? { enumText: elf.enumValueText(decoded, type.enumInfo) } : {})
            };
        } catch (error) {
            if (["depth-limit", "expansion-budget", "type-cycle"].includes(error.unobservable))
                return { kind: "unavailable", unobservable: error.unobservable };
            throw error;
        }
    }
    // A dereferenced char shows up to 32 bytes of the string it starts. The read stays
    // inside one verified memory range and within the per-cycle budget.
    async stringPreview(object) {
        const type = this.type(object.type);
        if (type.kind !== "scalar" || !["u8", "i8"].includes(type.watchType) || !/\bchar\b/.test(type.typeName || ""))
            return null;
        const range = this.item.runtimeRanges?.find(
            (entry) => object.address >= entry.start && object.address < entry.end
        );
        if (!range) throw failure("LIVE_ADDRESS_NOT_RAM", "Runtime object points outside verified ELF memory ranges");
        const bytes = await this.memory(object.address, Math.min(32, range.end - object.address));
        const end = bytes.indexOf(0);
        const text = bytes
            .subarray(0, end < 0 ? bytes.length : end)
            .toString("latin1")
            .replace(/[\x00-\x1f\x7f-\xff"\\]/g, (char) =>
                char === '"' || char === "\\" ? "\\" + char : "\\x" + char.charCodeAt(0).toString(16).padStart(2, "0")
            );
        return {
            kind: "scalar",
            type: type.watchType,
            typeName: type.typeName,
            address: object.address,
            value: type.watchType === "i8" ? bytes.readInt8(0) : bytes[0],
            valueText: '"' + text + '"' + (end < 0 ? "\u2026" : ""),
            stringPreview: true
        };
    }
    root(object) {
        return this.tree(object, 0, new Set(), !this.item.runtimeStaticPointers, 256, "", this.opened(""));
    }
    async sample() {
        const object = await this.select(
            await this.dynamic({ address: this.item.address, type: this.graph.root }),
            this.item.runtimeSegments || []
        );
        const tree = (this.item.derefPath && (await this.stringPreview(object))) || (await this.root(object));
        for (const [address, original] of this.descriptors) {
            this.verificationBudget.bytes -= original.length;
            this.verificationBudget.commands--;
            const actual = await this.memory(address, original.length, true);
            if (!actual.equals(original))
                throw failure("LIVE_OBJECT_CHANGED", "Runtime object storage changed during sampling");
        }
        return tree;
    }
}

module.exports = { RuntimeObjectReader };
