"use strict";

const assert = require("assert");
const { RuntimeObjectReader } = require("../../src/services/runtimeObjectReader");

async function exerciseRuntimeLayouts(symbols, resolve, sections) {
    const base = 0x20000000;
    const memory = Buffer.alloc(65536);
    const flash = Buffer.alloc(65536);
    const ranges = sections
        .filter((section) => section.flags & 2)
        .map((section) => ({ start: section.addr, end: section.addr + section.size }));
    const read = async (address, size) => {
        const buffer = address >= base ? memory : flash;
        const start = address - (address >= base ? base : 0x08000000);
        return buffer.subarray(start, start + size);
    };
    const write = (address, value, width = 4) => {
        const buffer = address >= base ? memory : flash;
        const start = address - (address >= base ? base : 0x08000000);
        if (width === 1) buffer.writeUInt8(value, start);
        else if (width === 2) buffer.writeUInt16LE(value, start);
        else buffer.writeUInt32LE(value >>> 0, start);
    };
    const heap = symbols.find((symbol) => symbol.name === "testHeap").address;
    for (const name of [
        "text",
        "values",
        "bits",
        "fixed",
        "unique",
        "shared",
        "weak",
        "optional",
        "variant",
        "pair",
        "tuple",
        "linked",
        "forward",
        "deque",
        "ordered",
        "multiMap",
        "set",
        "multiSet",
        "hashed",
        "multiHash",
        "hashSet",
        "hashMultiSet",
        "reference",
        "polymorphic"
    ]) {
        memory.fill(0);
        flash.fill(0);
        const symbol = symbols.find((entry) => entry.name === name || entry.displayName === name);
        assert(symbol, name);
        const graph = resolve(symbol.name);
        assert(graph, "native runtime graph: " + name);
        const item = { name, address: symbol.address, size: symbol.size, runtimeLayout: graph, runtimeRanges: ranges };
        const reader = new RuntimeObjectReader(item, read);
        const object = { address: item.address, type: graph.root };
        const rootType = reader.type(graph.root);
        const field = (path) => reader.path(object, path, true);
        const set = async (path, value) => {
            const target = await field(path);
            write(target.address, value, reader.size(target.type));
        };
        let expected;
        if (name === "text") {
            await set("_M_dataplus._M_p", heap);
            await set("_M_string_length", 3);
            memory.set(Buffer.from("abc"), heap - base);
            expected = [97, 98, 99];
        } else if (name === "values") {
            await set("_M_start", heap);
            await set("_M_finish", heap + 12);
            await set("_M_end_of_storage", heap + 16);
            [11, 22, 33].forEach((value, index) => write(heap + index * 4, value));
            expected = [11, 22, 33];
        } else if (name === "bits") {
            await set("_M_start._M_p", heap);
            await set("_M_start._M_offset", 1);
            await set("_M_finish._M_p", heap);
            await set("_M_finish._M_offset", 4);
            await set("_M_end_of_storage", heap + 4);
            write(heap, 0b1010);
            expected = [1, 0, 1];
        } else if (name === "fixed") {
            const array = await field("_M_elems");
            [1, 2, 3].forEach((value, index) => write(array.address + index * 4, value));
            expected = [1, 2, 3];
        } else if (["unique", "shared", "weak"].includes(name)) {
            if (name === "unique") write((await reader.tupleFields(await field("_M_t")))[0].address, heap);
            else await set("_M_ptr", heap);
            write(heap, 41);
            expected = [41];
            if (name === "weak") {
                const control = await field("_M_refcount._M_pi");
                write(control.address, heap + 64);
                const count = await reader.field(
                    { address: heap + 64, type: reader.type(control.type).target },
                    "_M_use_count"
                );
                write(count.address, 2);
            }
        } else if (name === "optional") {
            await set("_M_engaged", 1);
            await set("_M_value", 53);
            expected = [53];
        } else if (name === "variant") {
            await set("_M_index", 0);
            const union = await field("_M_u");
            write(union.address, 61);
            expected = [61];
        } else if (["pair", "tuple"].includes(name)) {
            const storage = await reader.storage(object);
            write((await storage.at(0)).address, 71);
            write((await storage.at(1)).address, 72);
            expected = [71, 72];
        } else if (name === "deque") {
            for (const [path, value] of Object.entries({
                "_M_start._M_cur": heap,
                "_M_start._M_first": heap,
                "_M_start._M_last": heap + 512,
                "_M_start._M_node": heap + 1024,
                "_M_finish._M_cur": heap + 8,
                "_M_finish._M_first": heap,
                "_M_finish._M_node": heap + 1024,
                _M_map: heap + 1024,
                _M_map_size: 4
            }))
                await set(path, value);
            write(heap + 1024, heap);
            write(heap, 81);
            write(heap + 4, 82);
            expected = [81, 82];
        } else if (name === "reference") {
            write(item.address, heap);
            write(heap, 91);
            expected = [91];
        } else if (name === "polymorphic") {
            const dynamic = graph.dynamicTypes.find((entry) => reader.type(entry.type).typeName === "Derived");
            assert(dynamic, "RTTI vtable identity");
            write(item.address, heap);
            write(heap, dynamic.address + 8);
            write(dynamic.address, 0);
            const derived = { address: heap, type: dynamic.type };
            write((await reader.field(derived, "base")).address, 101);
            write((await reader.field(derived, "value")).address, 102);
            expected = [101, 102];
        } else {
            const kind = rootType.stl;
            const isList = ["list", "forward_list"].includes(kind),
                isHash = kind.startsWith("unordered_"),
                isMap = /map$/.test(kind);
            const node = reader.nodeType(
                isList
                    ? kind === "list"
                        ? /::_List_node</
                        : /::_Fwd_list_node</
                    : isHash
                      ? /::_Hash_node</
                      : /::_Rb_tree_node</,
                isMap ? undefined : rootType.args[0],
                isMap ? rootType.args : null
            );
            const value = { address: heap, type: node };
            const nodeField = async (name) => (await reader.field(value, name)).address;
            let sentinel;
            if (kind === "forward_list") await set("_M_head._M_next", heap);
            else if (kind === "list") {
                sentinel = (await field("_M_node")).address;
                await set("_M_node._M_next", heap);
                await set("_M_node._M_prev", heap);
                await set("_M_node._M_size", 1);
            } else if (isHash) {
                await set("_M_h._M_before_begin._M_nxt", heap);
                await set("_M_h._M_element_count", 1);
            } else {
                sentinel = (await field("_M_t._M_impl._M_header")).address;
                await set("_M_t._M_impl._M_header._M_left", heap);
                await set("_M_t._M_impl._M_node_count", 1);
            }
            if (isList || isHash) write(await nodeField(isHash ? "_M_nxt" : "_M_next"), sentinel || 0);
            else {
                write(await nodeField("_M_parent"), sentinel);
                write(await nodeField("_M_left"), 0);
                write(await nodeField("_M_right"), 0);
            }
            const storage = await reader.field(value, "_M_storage");
            const payload = { address: storage.address, type: isMap ? reader.type(node).args[0] : rootType.args[0] };
            if (isMap) {
                write((await reader.field(payload, "first")).address, 111);
                write((await reader.field(payload, "second")).address, 112);
                expected = [111, 112];
            } else {
                write(payload.address, 113);
                expected = [113];
            }
        }
        const flatten = (tree) =>
            tree.kind === "scalar" ? [tree.value] : (tree.members || tree.elements || []).flatMap(flatten);
        try {
            assert.deepStrictEqual(flatten(await new RuntimeObjectReader(item, read).sample()), expected, name);
        } catch (error) {
            error.message = name + ": " + error.message;
            throw error;
        }
    }
}

module.exports = { exerciseRuntimeLayouts };
