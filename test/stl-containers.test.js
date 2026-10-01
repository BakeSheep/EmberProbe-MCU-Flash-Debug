"use strict";
const assert = require("assert");
const { EmberDebugSession } = require("../src/debug/session");
const { StlMi } = require("./fixtures/stl-mi");

function setup(width) {
    const mi = new StlMi(width),
        session = new EmberDebugSession({ mi });
    session.setRunAsServer(true);
    session.ready = true;
    session.sendEvent = () => {};
    return {
        mi,
        session,
        evaluate: (expression) => session.handle("evaluate", { expression }),
        expand: (item, args = {}) =>
            session
                .handle("variables", { variablesReference: item.variablesReference, ...args })
                .then((result) => result.variables)
    };
}
function pointer(bytes, offset, value, width) {
    if (width === 8) bytes.writeBigUInt64LE(BigInt(value), offset);
    else bytes.writeUInt32LE(value, offset);
}

(async () => {
    for (const width of [4, 8])
        for (const forward of [false, true]) {
            const { mi, session, evaluate, expand } = setup(width);
            const name = forward ? "forward" : "linked",
                sentinel = forward ? 0 : 0x20000040;
            const next = mi.item(`${name}.header._M_next`, "std::_List_node_base *", "0x20001000");
            const size = mi.item(`${name}.header._M_size`, "unsigned long", "3");
            const header = mi.item(
                `${name}.${forward ? "_M_head" : "_M_node"}`,
                "std::_List_node_header",
                "{...}",
                forward ? [next] : [next, size]
            );
            mi.item(name, `std::${forward ? "forward_list" : "list"}<int>`, "{...}", [header]);
            mi.offsets.set("_M_next", 0);
            mi.offsets.set("_M_impl._M_node", 64);
            mi.offsets.set("_M_storage._M_storage", width * (forward ? 1 : 2));
            for (let index = 0; index < 3; index++) {
                const block = Buffer.alloc(32);
                pointer(block, 0, index === 2 ? sentinel : 0x20001000 + (index + 1) * 256, width);
                block.writeInt32LE(index + 10, width * (forward ? 1 : 2));
                mi.allocation(0x20001000 + index * 256, block);
            }
            const root = await evaluate(name);
            assert.deepStrictEqual(
                (await expand(root)).map((item) => item.value),
                ["10", "11", "12"]
            );
            assert.strictEqual((await expand(root, { start: 2, count: 1 }))[0].value, "12");
            const context = session.variableStore.stl.context();
            context.deadline = Date.now() - 1;
            await assert.rejects(session.variableStore.stl.command("-thread-info", context), /time budget/);
            if (forward) {
                const cycle = setup(width);
                const field = cycle.mi.item("bad.head._M_next", "std::_Fwd_list_node_base *", "0x20001000");
                const head = cycle.mi.item("bad._M_head", "std::_Fwd_list_node_base", "{...}", [field]);
                cycle.mi.item("bad", "std::forward_list<int>", "{...}", [head]);
                cycle.mi.offsets.set("_M_next", 0);
                const block = Buffer.alloc(32);
                pointer(block, 0, 0x20001000, width);
                cycle.mi.allocation(0x20001000, block);
                await cycle.evaluate("bad");
                assert(
                    cycle.session.variableStore.nodes.get("bad").raw,
                    "cycles fall back without unbounded traversal"
                );
            }
        }
    for (const width of [4, 8]) {
        const { mi, evaluate, expand } = setup(width);
        const iterator = (name, base, cursor, map) =>
            mi.item(name, "std::_Deque_iterator<int, int&, int*>", "{...}", [
                mi.item(name + "._M_first", "int*", `0x${base.toString(16)}`),
                mi.item(name + "._M_last", "int*", `0x${(base + 16).toString(16)}`),
                mi.item(name + "._M_cur", "int*", `0x${cursor.toString(16)}`),
                mi.item(name + "._M_node", "int**", `0x${map.toString(16)}`)
            ]);
        mi.item("deque", "std::deque<int>", "{...}", [
            iterator("deque._M_start", 0x20001000, 0x20001004, 0x20002000),
            iterator("deque._M_finish", 0x20001100, 0x20001108, 0x20002000 + width)
        ]);
        const map = Buffer.alloc(width * 2);
        pointer(map, 0, 0x20001000, width);
        pointer(map, width, 0x20001100, width);
        mi.allocation(0x20002000, map);
        for (const [address, start] of [
            [0x20001000, 0],
            [0x20001100, 4]
        ]) {
            const block = Buffer.alloc(16);
            for (let index = 0; index < 4; index++) block.writeInt32LE(index + start, index * 4);
            mi.allocation(address, block);
        }
        const root = await evaluate("deque");
        assert.strictEqual(root.indexedVariables, 5);
        assert.deepStrictEqual(
            (await expand(root)).map((item) => item.value),
            ["1", "2", "3", "4", "5"]
        );
    }
    const weak = setup(4);
    const field = weak.mi.item("weak._M_ptr", "int*", "0x20001000");
    const use = weak.mi.item("weak.control._M_use_count", "int", "0");
    const control = weak.mi.item("weak.refcount._M_pi", "std::_Sp_counted_base*", "0x20002000", [use]);
    const ref = weak.mi.item("weak._M_refcount", "std::__weak_count", "{...}", [control]);
    weak.mi.item("weak", "std::weak_ptr<int>", "{...}", [field, ref]);
    const expired = await weak.evaluate("weak");
    assert.strictEqual(expired.variablesReference, 0);
    assert.match(expired.result, /expired/);
    for (const width of [4, 8])
        for (const kind of [
            "map",
            "multimap",
            "set",
            "multiset",
            "unordered_map",
            "unordered_multimap",
            "unordered_set",
            "unordered_multiset"
        ]) {
            const hash = kind.startsWith("unordered_"),
                map = kind.includes("map");
            const { mi, evaluate, expand } = setup(width);
            mi.offsets.set("_M_storage._M_storage", width * 4);
            let children;
            if (hash) {
                const next = mi.item("owner.before._M_nxt", "std::__detail::_Hash_node_base *", "0x20001000");
                const before = mi.item("owner._M_before_begin", "std::__detail::_Hash_node_base", "{...}", [next]);
                const length = mi.item("owner._M_element_count", "unsigned long", "2");
                const table = mi.item(
                    "owner._M_h",
                    "std::_Hashtable<int, std::__detail::_Hashtable_traits<true, false, true> >",
                    "{...}",
                    [before, length]
                );
                children = [table];
                mi.offsets.set("_M_nxt", 0);
            } else {
                const left = mi.item("owner.header._M_left", "std::_Rb_tree_node_base *", "0x20001000");
                const header = mi.item("owner._M_header", "std::_Rb_tree_node_base", "{...}", [left]);
                children = [header, mi.item("owner._M_node_count", "unsigned long", "2")];
                for (const [field, offset] of [
                    ["_M_parent", width],
                    ["_M_left", width * 2],
                    ["_M_right", width * 3],
                    ["_M_t._M_impl._M_header", 64]
                ])
                    mi.offsets.set(field, offset);
            }
            mi.item("owner", `std::${kind}<int${map ? ", int" : ""}>`, "{...}", children);
            for (let index = 0; index < 2; index++) {
                const bytes = Buffer.alloc(width * 4 + 8);
                if (hash) pointer(bytes, 0, index ? 0 : 0x20001100, width);
                else {
                    pointer(bytes, width, index ? 0x20001000 : 0x20000040, width);
                    pointer(bytes, width * 3, index ? 0 : 0x20001100, width);
                }
                bytes.writeInt32LE(index + 1, width * 4);
                bytes.writeInt32LE(index + 11, width * 4 + 4);
                mi.allocation(0x20001000 + index * 256, bytes);
            }
            const root = await evaluate("owner"),
                items = await expand(root);
            assert.strictEqual(items.length, 2, kind);
            if (map) {
                const pair = await expand(items[0]);
                assert.deepStrictEqual(
                    pair.map((item) => item.value),
                    ["1", "11"]
                );
                assert(pair[0].presentationHint.attributes.includes("readOnly"));
            } else {
                assert.deepStrictEqual(
                    items.map((item) => item.value),
                    ["1", "2"]
                );
                assert(items.every((item) => item.presentationHint.attributes.includes("readOnly")));
            }
        }
    console.log("STL list/forward_list/deque ARM32/64 boundaries, cycles, time budgets and expired weak owners passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
