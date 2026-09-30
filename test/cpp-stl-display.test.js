"use strict";

const assert = require("assert");
const { EmberDebugSession } = require("../src/debug/session");
const { templateType, kindOf, constValue, safeType, safePath, integer } = require("../src/debug/stl");
const { StlMi } = require("./fixtures/stl-mi");

function setup(width = 4) {
    const mi = new StlMi(width);
    const session = new EmberDebugSession({ mi });
    session.setRunAsServer(true);
    session.ready = true;
    const output = [];
    session.sendEvent = (event) => output.push(event);
    const evaluate = (expression) => session.handle("evaluate", { expression });
    const expand = (variable, args = {}) =>
        session
            .handle("variables", { variablesReference: variable.variablesReference, ...args })
            .then((value) => value.variables);
    return { mi, session, output, evaluate, expand };
}

function vector(mi, name = "numbers", length = 250, type = "std::vector<int, std::allocator<int> >") {
    const start = mi.item(name + "._M_impl._M_start", "int *", "0x20001000");
    const finish = mi.item(name + "._M_impl._M_finish", "int *", "0x" + (0x20001000 + length * 4).toString(16));
    const end = mi.item(name + "._M_impl._M_end_of_storage", "int *", finish.value);
    const impl = mi.item(name + "._M_impl", "std::_Vector_base<int>::_Vector_impl", "{...}", [start, finish, end]);
    return mi.item(name, type, "{...}", [impl]);
}

(async () => {
    assert.deepStrictEqual(templateType("const class std::map<int, std::vector<std::pair<int, int> > > &").args, [
        "int",
        "std::vector<std::pair<int, int> >"
    ]);
    assert.throws(() => templateType("std::vector<int"), /Incomplete/);
    assert.strictEqual(kindOf("std::__debug::vector<int>"), null);
    assert.strictEqual(kindOf("std::vector<int>*"), null);
    assert(constValue("int const"));
    assert(constValue("const std::vector<int> &"));
    assert(!constValue("std::vector<const int*>"));
    assert(!constValue("const int*"));
    assert(constValue("int* const"));
    assert.throws(() => safeType("int); evil()"));
    assert.throws(() => safePath("getVector()"));
    assert.throws(() => safePath("x;quit"));
    assert.strictEqual(integer("0x1234 <symbol>"), 0x1234n);
    assert.strictEqual(integer("false"), 0n);

    const rawPointers = setup();
    const pointee = rawPointers.mi.item("pointer.value", "int", "7");
    rawPointers.mi.item("pointer", "int * const", "0x20001000", [pointee]);
    const rawPointerView = await rawPointers.evaluate("pointer");
    assert(rawPointerView.presentationHint.attributes.includes("readOnly"));
    assert(
        !(await rawPointers.expand(rawPointerView))[0].presentationHint,
        "const pointer does not make its pointee const"
    );
    await rawPointers.session.handle("setVariable", {
        variablesReference: rawPointerView.variablesReference,
        name: "value",
        value: "8"
    });
    assert.strictEqual(pointee.value, "8");
    rawPointers.mi.item("owner", "const Owner", "{...}", [rawPointers.mi.items.get("pointer")]);
    const owner = await rawPointers.evaluate("owner");
    const member = (await rawPointers.expand(owner))[0];
    assert(member.presentationHint.attributes.includes("readOnly"));
    assert(!(await rawPointers.expand(member))[0].presentationHint);
    pointee.type = "const int";
    await rawPointers.session.clearVariables();
    const readonlyPointer = await rawPointers.evaluate("pointer");
    assert((await rawPointers.expand(readonlyPointer))[0].presentationHint.attributes.includes("readOnly"));
    await assert.rejects(
        rawPointers.session.handle("setVariable", {
            variablesReference: readonlyPointer.variablesReference,
            name: "value",
            value: "9"
        }),
        /read only/
    );

    for (const width of [4, 8]) {
        const { mi, session, evaluate, expand } = setup(width);
        vector(mi);
        const value = await evaluate("numbers");
        assert.strictEqual(value.indexedVariables, 250);
        assert.match(value.result, /length 250/);
        const first = await expand(value);
        const repeated = await expand(value);
        assert.strictEqual(first.at(-1).variablesReference, repeated.at(-1).variablesReference);
        assert.strictEqual(mi.commands.filter((command) => command.startsWith("-var-create")).length, 101);
        const second = await expand(first.at(-1));
        assert.strictEqual(second[0].name, "[100]");
        assert.strictEqual((await expand(second.at(-1))).length, 50);
        assert.deepStrictEqual(await expand(value, { filter: "named" }), []);
        await assert.rejects(expand(value, { count: 1001 }), /1000/);
        await session.handle("setVariable", {
            variablesReference: first.at(-1).variablesReference,
            name: "[100]",
            value: "77"
        });
        assert.strictEqual((await expand(value, { start: 100, count: 1 }))[0].value, "77");
        assert.strictEqual((await expand(first.at(-1)))[0].value, "77", "page references survive element writes");
        assert(!mi.commands.some((command) => /python|visualizer|enable-pretty|var-update/.test(command)));
        await session.clearVariables();
        await assert.rejects(expand(value), /Stale/);
    }

    const alias = setup();
    vector(alias.mi, "alias", 2, "MyVector");
    alias.mi.aliases.set("MyVector", "std::vector<int, std::allocator<int> >");
    assert.strictEqual((await alias.evaluate("alias")).indexedVariables, 2);
    vector(alias.mi, "constant", 2, "const std::vector<int, std::allocator<int> >");
    const constant = await alias.evaluate("constant");
    assert((await alias.expand(constant))[0].presentationHint.attributes.includes("readOnly"));
    await assert.rejects(
        alias.session.handle("setVariable", {
            variablesReference: constant.variablesReference,
            name: "[0]",
            value: "1"
        }),
        /read only/
    );
    alias.session.config.enablePrettyPrinting = false;
    await alias.session.clearVariables();
    assert.strictEqual((await alias.evaluate("alias")).result, "{...}");

    const wrappers = setup();
    const int = (name, value) => wrappers.mi.item(name, "int", String(value));
    const elements = [int("fixed._M_elems.0", 4), int("fixed._M_elems.1", 5)];
    wrappers.mi.item("fixed", "std::array<int, 2>", "{...}", [
        wrappers.mi.item("fixed._M_elems", "int [2]", "{...}", elements)
    ]);
    assert.deepStrictEqual(
        (await wrappers.expand(await wrappers.evaluate("fixed"))).map((item) => item.name),
        ["[0]", "[1]"]
    );
    wrappers.mi.item("pair", "std::pair<int, int>", "{...}", [int("pair.first", 7), int("pair.second", 8)]);
    assert.deepStrictEqual(
        (await wrappers.expand(await wrappers.evaluate("pair"))).map((item) => item.value),
        ["7", "8"]
    );
    wrappers.mi.items.get("pair.first").type = "ReadOnlyAlias";
    wrappers.mi.aliases.set("ReadOnlyAlias", "const int");
    await wrappers.session.clearVariables();
    const aliasPair = await wrappers.evaluate("pair");
    await wrappers.expand(aliasPair);
    await assert.rejects(
        wrappers.session.handle("setVariable", {
            variablesReference: aliasPair.variablesReference,
            name: "first",
            value: "9"
        }),
        /read only/
    );
    const engaged = wrappers.mi.item("present._M_engaged", "bool", "true");
    const payload = wrappers.mi.item("present._M_payload", "std::_Optional_payload<int>", "{...}", [
        engaged,
        int("present._M_value", 23)
    ]);
    wrappers.mi.item("present", "std::optional<int>", "{...}", [payload]);
    assert.strictEqual((await wrappers.expand(await wrappers.evaluate("present")))[0].value, "23");
    engaged.value = "false";
    await wrappers.session.clearVariables();
    assert.strictEqual((await wrappers.evaluate("present")).variablesReference, 0);
    const pointerValue = wrappers.mi.item("shared._M_ptr", "int *", "0x20001000");
    pointerValue.pointee = int("pointee", 19);
    wrappers.mi.item("shared", "std::shared_ptr<int>", "{...}", [pointerValue]);
    assert.strictEqual((await wrappers.expand(await wrappers.evaluate("shared")))[0].value, "19");
    wrappers.mi.items.get("shared").type = "const std::shared_ptr<int>";
    await wrappers.session.clearVariables();
    const constShared = await wrappers.evaluate("shared");
    assert(!(await wrappers.expand(constShared))[0].presentationHint);
    await wrappers.session.handle("setVariable", {
        variablesReference: constShared.variablesReference,
        name: "value",
        value: "20"
    });
    pointerValue.pointee.type = "const int";
    await wrappers.session.clearVariables();
    const constPointee = await wrappers.evaluate("shared");
    assert((await wrappers.expand(constPointee))[0].presentationHint.attributes.includes("readOnly"));
    await assert.rejects(
        wrappers.session.handle("setVariable", {
            variablesReference: constPointee.variablesReference,
            name: "value",
            value: "21"
        }),
        /read only/
    );
    const uniquePointer = wrappers.mi.item("unique._M_t.head._M_head_impl", "int *", "0x20002000");
    uniquePointer.pointee = int("uniquePointee", 17);
    const head = wrappers.mi.item("unique._M_t.head", "std::_Head_base<0, int*, false>", "{...}", [uniquePointer]);
    head.exp = "std::_Head_base<0, int*, false>";
    const tuple = wrappers.mi.item("unique._M_t", "std::tuple<int*, std::default_delete<int>>", "{...}", [head]);
    wrappers.mi.item("unique", "std::unique_ptr<int, std::default_delete<int>>", "{...}", [tuple]);
    assert.strictEqual((await wrappers.expand(await wrappers.evaluate("unique")))[0].value, "17");
    const index = wrappers.mi.item("choice._M_index", "unsigned char", "0");
    const union = wrappers.mi.item("choice._M_u", "std::__detail::__variant::_Variadic_union<int, int>");
    wrappers.mi.item("choice", "std::variant<int, int>", "{...}", [index, union]);
    const branch = Buffer.alloc(8);
    branch.writeInt32LE(29);
    wrappers.mi.allocation(0x20000000, branch);
    assert.strictEqual((await wrappers.expand(await wrappers.evaluate("choice")))[0].value, "29");
    await wrappers.session.clearVariables();
    index.value = "255";
    assert.match((await wrappers.evaluate("choice")).result, /valueless/);
    await wrappers.session.clearVariables();
    index.value = "7";
    assert.strictEqual((await wrappers.evaluate("choice")).result, "{...}");
    wrappers.mi.item("emptyTuple", "std::tuple<>");
    wrappers.mi.item("emptyArray", "std::array<int, 0>");
    for (const name of ["emptyTuple", "emptyArray"])
        assert.strictEqual((await wrappers.evaluate(name)).variablesReference, 0);
    const tupleHead = wrappers.mi.item("tuple.head", "std::_Head_base<0, int, false>", "{...}", [
        int("tuple.head._M_head_impl", 8)
    ]);
    tupleHead.exp = "std::_Head_base<0, int, false>";
    wrappers.mi.item("tuple", "std::tuple<int>", "{...}", [tupleHead]);
    assert.strictEqual((await wrappers.expand(await wrappers.evaluate("tuple")))[0].value, "8");
    for (const name of ["start", "finish"]) {
        const address = wrappers.mi.item(
            `bits._M_${name}._M_p`,
            "unsigned long *",
            name === "start" ? "0x20002000" : "0x20002018"
        );
        const bitOffset = wrappers.mi.item(`bits._M_${name}._M_offset`, "unsigned int", name === "start" ? "0" : "13");
        wrappers.mi.item(`bits._M_${name}`, "std::_Bit_iterator", "{...}", [address, bitOffset]);
    }
    const storage = wrappers.mi.item("bits._M_end_of_storage", "unsigned long *", "0x2000201c");
    wrappers.mi.item("bits", "std::vector<bool, std::allocator<bool>>", "{...}", [
        wrappers.mi.items.get("bits._M_start"),
        wrappers.mi.items.get("bits._M_finish"),
        storage
    ]);
    const bitBytes = Buffer.alloc(28, 255);
    bitBytes[12] &= ~16;
    wrappers.mi.allocation(0x20002000, bitBytes);
    const bits = await wrappers.evaluate("bits");
    assert.strictEqual(bits.indexedVariables, 205);
    assert.strictEqual((await wrappers.expand(bits, { start: 100, count: 1 }))[0].value, "false");
    assert.deepStrictEqual(await wrappers.expand(bits, { start: 300, count: 1 }), []);

    const strings = setup();
    const pointer = strings.mi.item("text._M_dataplus._M_p", "char *", "0x20001000");
    const length = strings.mi.item("text._M_string_length", "unsigned int", "400");
    const data = strings.mi.item("text._M_dataplus", "std::string::_Alloc_hider", "{...}", [pointer]);
    strings.mi.item(
        "text",
        "std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >",
        "{...}",
        [data, length]
    );
    strings.mi.allocation(0x20001000, Buffer.concat([Buffer.from("a\0b"), Buffer.alloc(397, 120)]));
    const text = await strings.evaluate("text");
    assert.match(text.result, /a\\u0000b/);
    assert.match(text.result, /length 400/);
    assert(strings.mi.commands.some((command) => command.endsWith(" 256")));
    const stl = strings.session.variableStore.stl;
    await assert.rejects(stl.memory(0xfffffff0n, 32, stl.context()), /overflow/);
    await assert.rejects(stl.memory(0n, 65537, stl.context()), /budget/);
    await assert.rejects(stl.memory(0n, 1, stl.context()), /Cannot access/);
    const context = stl.context();
    context.steps = 4096;
    assert.throws(() => stl.step(context), /sequentially/);

    for (const failure of ["missing", "big-endian", "capacity", "depth", "budget"]) {
        const test = setup();
        const item = vector(test.mi, "bad", 2);
        if (failure === "missing") ((item.children = []), (item.numchild = "0"));
        if (failure === "big-endian") test.mi.little = false;
        if (failure === "capacity") test.mi.items.get("bad._M_impl._M_end_of_storage").value = "0x20001000";
        if (failure === "budget") item.numchild = "129";
        if (failure === "depth") {
            let nested = item;
            for (let index = 0; index < 13; index++) {
                const next = test.mi.item(`layer${index}`, "std::wrapper");
                next.exp = "_M_impl";
                nested.children = [next];
                nested.numchild = "1";
                nested = next;
            }
        }
        assert.strictEqual((await test.evaluate("bad")).result, "{...}");
    }

    const map = setup();
    map.mi.offsets.set("_M_t._M_impl._M_header", 256);
    const left = map.mi.item("ordered._M_header._M_left", "std::_Rb_tree_node_base *", "0x20000200");
    const header = map.mi.item("ordered._M_header", "std::_Rb_tree_node_base", "{...}", [left], 0x20000100n);
    const size = map.mi.item("ordered._M_node_count", "unsigned int", "2");
    map.mi.item("ordered", "std::map<int, int>", "{...}", [header, size]);
    const bytes = Buffer.alloc(512);
    bytes.writeUInt32LE(0x20000100, 4);
    bytes.writeUInt32LE(0x20000300, 12);
    bytes.writeInt32LE(1, 16);
    bytes.writeInt32LE(11, 20);
    bytes.writeUInt32LE(0x20000200, 260);
    bytes.writeInt32LE(2, 272);
    bytes.writeInt32LE(22, 276);
    map.mi.allocation(0x20000200, bytes);
    const ordered = await map.evaluate("ordered");
    const entries = await map.expand(ordered, { start: 1, count: 1 });
    assert.strictEqual(entries[0].name, "[1]");
    const pair = await map.expand(entries[0]);
    assert.deepStrictEqual(
        pair.map((item) => item.value),
        ["2", "22"]
    );
    await assert.rejects(
        map.session.handle("setVariable", {
            variablesReference: entries[0].variablesReference,
            name: "key",
            value: "3"
        }),
        /read only/
    );
    const badView = {
        kind: "unordered_map",
        linkOffsets: { _M_nxt: 0n },
        cursors: new Map([[0, 0x20000200n]]),
        addresses: new Map(),
        seen: new Set()
    };
    bytes.writeUInt32LE(0x20000200, 0);
    await assert.rejects(
        map.session.variableStore.stl.mapAddress(badView, 1, map.session.variableStore.stl.context()),
        /Cycle/
    );

    const hash = setup();
    const firstNode = hash.mi.item("hash._M_before_begin._M_nxt", "std::__detail::_Hash_node_base *", "0x20003000");
    const before = hash.mi.item("hash._M_before_begin", "std::__detail::_Hash_node_base", "{...}", [firstNode]);
    const hashtable = hash.mi.item("hash._M_h", "std::_Hashtable<int, std::_Hashtable_traits<false, false, true>>");
    hashtable.children = [before, hash.mi.item("hash._M_element_count", "unsigned int", "2")];
    hashtable.numchild = "2";
    hash.mi.item("hash", "std::unordered_map<int, int>", "{...}", [hashtable]);
    const hashBytes = Buffer.alloc(64);
    hashBytes.writeUInt32LE(0x20003020, 0);
    hashBytes.writeInt32LE(3, 16);
    hashBytes.writeInt32LE(33, 20);
    hashBytes.writeInt32LE(4, 48);
    hashBytes.writeInt32LE(44, 52);
    hash.mi.allocation(0x20003000, hashBytes);
    const hashValue = await hash.evaluate("hash");
    assert.match(hashValue.result, /unordered_map length 2/);
    const hashPage = await hash.expand(hashValue, { start: 1, count: 1 });
    assert.deepStrictEqual(
        (await hash.expand(hashPage[0])).map((value) => value.value),
        ["4", "44"]
    );
    hashBytes.writeUInt32LE(0x20003000, 0);
    await hash.session.clearVariables();
    const corruptHash = await hash.evaluate("hash");
    await hash.expand(corruptHash);
    assert(hash.output.some((event) => event.body?.output?.includes("Cycle")));

    const walking = setup();
    const chain = Buffer.alloc(5001 * 4);
    for (let index = 0; index < 5000; index++) chain.writeUInt32LE(0x21000000 + (index + 1) * 4, index * 4);
    walking.mi.allocation(0x21000000, chain);
    const walkView = {
        kind: "unordered_map",
        linkOffsets: { _M_nxt: 0n },
        cursors: new Map([[0, 0x21000000n]]),
        addresses: new Map(),
        seen: new Set()
    };
    const display = walking.session.variableStore.stl;
    await assert.rejects(display.mapAddress(walkView, 4500, display.context()), /sequentially/);
    assert.strictEqual(await display.mapAddress(walkView, 4095, display.context()), 0x21000000n + 4095n * 4n);
    assert.strictEqual(await display.mapAddress(walkView, 4500, display.context()), 0x21000000n + 4500n * 4n);

    const rtos = setup();
    vector(rtos.mi);
    rtos.session.rtosAware = true;
    rtos.session.threads = new Set([2, 3]);
    const frame = rtos.session.handleFor({ kind: "frame", thread: 2, level: 1 });
    const root = await rtos.session.handle("evaluate", { expression: "numbers", frameId: frame });
    await rtos.session.handle("stackTrace", { threadId: 3 });
    await rtos.expand(root, { count: 1 });
    assert(rtos.mi.commands.includes("-thread-select 2"));
    assert(rtos.mi.commands.some((command) => /^-var-create --thread 2 --frame 1/.test(command)));
    rtos.session.variableStore.invalidateThread(2);
    await assert.rejects(rtos.expand(root), /Stale/);

    // Assigning inside a nested container must refresh only the innermost one. Refreshing an outer
    // container drops every reference the client still holds for the levels in between.
    const nested = setup();
    const pairFirst = nested.mi.item("elem.first", "const int", "1");
    const pairSecond = nested.mi.item("elem.second", "int", "2");
    const pairItem = nested.mi.item("elem", "std::pair<int, int>", "{...}", [pairFirst, pairSecond]);
    const nestedStart = nested.mi.item("nested._M_impl._M_start", "std::pair<int, int> *", "0x20004000");
    nestedStart.pointee = pairItem;
    const nestedFinish = nested.mi.item("nested._M_impl._M_finish", "std::pair<int, int> *", "0x20004004");
    const nestedStorage = nested.mi.item("nested._M_impl._M_end_of_storage", "std::pair<int, int> *", "0x20004004");
    const nestedImpl = nested.mi.item("nested._M_impl", "std::_Vector_impl", "{...}", [
        nestedStart,
        nestedFinish,
        nestedStorage
    ]);
    nested.mi.item("nested", "std::vector<std::pair<int, int> >", "{...}", [nestedImpl]);
    const outer = await nested.evaluate("nested");
    assert.match(outer.result, /vector length 1/);
    const nestedElements = await nested.expand(outer);
    assert.strictEqual(nestedElements[0].name, "[0]");
    assert.deepStrictEqual(
        (await nested.expand(nestedElements[0])).map((field) => `${field.name}=${field.value}`),
        ["first=1", "second=2"]
    );
    nested.mi.commands.length = 0;
    await nested.session.handle("setVariable", {
        variablesReference: nestedElements[0].variablesReference,
        name: "second",
        value: "42"
    });
    assert.deepStrictEqual(
        nested.mi.commands.filter((command) => command.startsWith("-var-delete")),
        [],
        "the outer container's element varobjs must survive; refreshing it would drop the client's references"
    );
    assert.deepStrictEqual(
        (await nested.expand(nestedElements[0])).map((field) => `${field.name}=${field.value}`),
        ["first=1", "second=42"],
        "the element row the client is still showing must stay resolvable"
    );
    assert.strictEqual((await nested.expand(outer))[0].name, "[0]");

    const plain = setup();
    const plainField = plain.mi.item("plainElement.x", "int", "1");
    const plainItem = plain.mi.item("plainElement", "Plain", "{...}", [plainField]);
    vector(plain.mi, "plainVector", 1, "std::vector<Plain>");
    plain.mi.items.get("plainVector._M_impl._M_start").pointee = plainItem;
    const plainOuter = await plain.evaluate("plainVector");
    const plainElement = (await plain.expand(plainOuter))[0];
    await plain.expand(plainElement);
    plain.mi.commands.length = 0;
    for (const value of ["42", "43"]) {
        await plain.session.handle("setVariable", {
            variablesReference: plainElement.variablesReference,
            name: "x",
            value
        });
        assert.strictEqual((await plain.expand(plainElement))[0].value, value);
        assert.strictEqual((await plain.expand(plainOuter))[0].variablesReference, plainElement.variablesReference);
    }
    assert(!plain.mi.commands.some((command) => command.startsWith("-var-delete")));
    // A real relocation must still invalidate the old address-backed element.
    const replacement = plain.mi.item("replacement", "Plain", "{...}", [plain.mi.item("replacement.x", "int", "9")]);
    const relocated = plain.mi.items.get("plainVector._M_impl._M_start");
    relocated.value = "0x20005000";
    relocated.pointee = replacement;
    plain.mi.items.get("plainVector._M_impl._M_finish").value = "0x20005004";
    plain.mi.items.get("plainVector._M_impl._M_end_of_storage").value = "0x20005004";
    const plainNode = plain.session.variableStore.nodes.get("plainVector");
    await plain.session.variableStore.stl.refresh(plainNode, plain.session.variableStore.stl.context(plainNode.frame));
    await assert.rejects(plain.expand(plainElement), /Stale/);
    assert(plain.mi.commands.includes('-var-delete "plainElement"'));
    const replacementElement = (await plain.expand(plainOuter))[0];
    assert.strictEqual((await plain.expand(replacementElement))[0].value, "9");
    await plain.session.clearVariables();
    await assert.rejects(plain.expand(replacementElement), /Stale/);

    await map.session.handle("setVariable", {
        variablesReference: entries[0].variablesReference,
        name: "value",
        value: "42"
    });
    assert.strictEqual((await map.expand(entries[0]))[1].value, "42");
    const refreshedEntry = (await map.expand(ordered, { start: 1, count: 1 }))[0];
    assert.strictEqual(refreshedEntry.variablesReference, entries[0].variablesReference);
    assert.strictEqual((await map.expand(refreshedEntry))[1].value, "42");

    const unrelated = setup();
    vector(unrelated.mi);
    unrelated.session.rtosAware = true;
    unrelated.session.threads = new Set([2, 3]);
    const pinnedFrame = unrelated.session.handleFor({ kind: "frame", thread: 2, level: 0 });
    const pinned = await unrelated.session.handle("evaluate", { expression: "numbers", frameId: pinnedFrame });
    // A cached task exits during STL materialization on a different live task.
    const otherFrame = unrelated.session.handleFor({ kind: "frame", thread: 3, level: 0 });
    unrelated.mi.onCommand = (command) => {
        if (command.startsWith("-var-create")) unrelated.session.forgetThread(3);
    };
    assert.strictEqual((await unrelated.expand(pinned, { count: 1 }))[0].name, "[0]");
    assert(!unrelated.session.handles.has(otherFrame));
    unrelated.mi.onCommand = (command) => {
        if (command.startsWith("-var-evaluate-expression")) {
            unrelated.session.forgetThread(2);
            unrelated.session.confirmThread(2);
        }
    };
    await assert.rejects(unrelated.expand(pinned, { count: 1 }), /Stale/);
    unrelated.session.variableStore.invalidateThread(2);
    await assert.rejects(unrelated.expand(pinned), /Stale/);

    const creating = setup();
    vector(creating.mi);
    creating.session.rtosAware = true;
    creating.session.threads.add(2);
    const creatingFrame = { thread: 2, level: 0 };
    creating.mi.onCommand = (command) => {
        if (command.startsWith("-var-create")) {
            creating.session.forgetThread(2);
            creating.session.confirmThread(2);
        }
    };
    await assert.rejects(creating.session.createVariable("numbers", creatingFrame), /Stale/);
    assert(
        !creating.session.variableStore.nodes.has("numbers"),
        "a dead task's pending create must not register a node"
    );

    const selecting = setup();
    selecting.session.rtosAware = true;
    selecting.session.threads.add(2);
    const selectingFrame = selecting.session.handleFor({ kind: "frame", thread: 2, level: 0 });
    selecting.mi.onCommand = (command) => {
        if (command === "-thread-select 2") selecting.session.forgetThread(2);
    };
    await assert.rejects(selecting.session.selectFrame(selectingFrame), /Stale/);
    assert.strictEqual(selecting.session.selectedFrame, undefined, "an exited task must not become the selected frame");

    const stale = setup();
    vector(stale.mi);
    stale.mi.onCommand = (command) => {
        if (command.startsWith("-var-evaluate-expression"))
            stale.session.onRecord({ kind: "*", class: "running", data: {} });
    };
    await assert.rejects(stale.evaluate("numbers"), /paused|Stale/);
    console.log("Built-in STL ARM32/64 layout, alias, budgets, paging, writes, maps and RTOS tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
