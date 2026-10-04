"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const c = require("../src/dwarf/constants");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const { buildCompositeLayouts, buildVariableTypes } = require("../src/dwarf/types");
const { ElfService } = require("../src/services/elfService");
const { buildActiveReadPlan, LiveWatchService } = require("../src/services/liveWatchService");
const { normalizeWatchList } = require("../src/validation");
const { loadProvider } = require("./helpers/load-provider");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { buildDwarfElf } = require("./helpers/elf-fixture");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

function memberExpressionElf(expression) {
    const info = Buffer.concat([
        Buffer.from([0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 1, 2, expression.length]),
        Buffer.from(expression),
        Buffer.from([0])
    ]);
    info.writeUInt32LE(info.length - 4);
    const abbrev = Buffer.from([1, 0x11, 1, 0, 0, 2, 0x0d, 0, 0x38, 0x18, 0, 0, 0]);
    return buildDwarfElf(info, abbrev, {
        machine: 0,
        layout: { type: 0, version: 0, tableAlignment: 1 }
    });
}
assert.strictEqual(parseDwarfInternal(memberExpressionElf([0x23, 0])).dies.get(12).memberOffset, 0);
assert.strictEqual(parseDwarfInternal(memberExpressionElf([0x23, 0x80, 1])).dies.get(12).memberOffset, 128);
for (const expression of [[0x23], [0x23, 0x80], [0x23, 0, 0x06], [0x12, 0x06], [0x23, ...Array(9).fill(0xff), 0x01]]) {
    const member = parseDwarfInternal(memberExpressionElf(expression)).dies.get(12);
    assert.strictEqual(member.memberOffset, undefined);
    assert.strictEqual(member.memberLocationUnsupported, true);
}

// Use real GCC DWARF output without requiring a compiler or connected board in CI.
const fixtures = require("./fixtures/cpp-review/elf.json");
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-cpp-review-"));
try {
    for (const version of [4, 5]) {
        const buffer = zlib.inflateSync(Buffer.from(fixtures[`dwarf${version}`], "base64"));
        const parsed = dwarf.parseDwarf(buffer);
        assert.deepStrictEqual(parsed.diagnostics, []);
        const result = elf.parseElfSymbols(buffer);
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
            result,
            parsed.types,
            parsed.layouts,
            parsed.displayNames
        );
        const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
        const file = path.join(temporary, `dwarf${version}.elf`);
        fs.writeFileSync(file, buffer);
        result.elf = { path: file };
        const Provider = loadProvider();
        const provider = Object.create(Provider.prototype);
        provider.readElfSymbols = () => result;
        const write = (name) => provider._agentWritePlan([{ name, value: 1 }], { refreshSymbols: false });
        const bytesOf = (name) => {
            const symbol = byName.get(name);
            const section = elf
                .parseElfSections(buffer)
                .sections.find(
                    (section) => symbol.address >= section.addr && symbol.address < section.addr + section.size
                );
            const offset = section.offset + symbol.address - section.addr;
            return buffer.subarray(offset, offset + symbol.size);
        };

        assert.deepStrictEqual(
            parsed.layouts.get("plain").members.map((member) => member.name),
            ["x"]
        );
        assert.throws(() => write("plain.shared"), { code: "INVALID_VARIABLE_PATH" });
        assert.strictEqual(write("Plain::shared").items[0].address, byName.get("_ZN5Plain6sharedE").address);
        assert.strictEqual(
            write("Holder<int>::object.x").items[0].address,
            byName.get("_ZN6HolderIiE6objectE").address
        );
        assert.deepStrictEqual(
            parsed.layouts.get("inlinePacket").members.map((member) => member.name),
            ["value"]
        );
        assert.ok(parsed.layouts.get("virtualObject").members[0].unobservable);
        assert.strictEqual(write("virtualObject.own").items.length, 1);

        for (const name of ["reference", "rvalueReference", "memberPointer", "methodPointer"]) {
            assert.strictEqual(byName.get(name).hasDwarfWriteType, false);
            assert.throws(() => write(name), { code: "WRITE_NOT_ALLOWED" });
        }
        assert.strictEqual(byName.get("methodPointer").watchType, "u64", "ARM member function pointers occupy 8 bytes");
        assert.throws(() => write("refbox.ref"), { code: "WRITE_NOT_ALLOWED" });
        assert.strictEqual(write("refbox.own").items.length, 1);
        for (const name of ["readonlyRoot.nested.value", "readonlyRoot.values[0]", "readonlyRoot.values[1]"])
            assert.throws(() => write(name), { code: "WRITE_NOT_ALLOWED" });

        assert.deepStrictEqual(
            elf.decodeComposite(bytesOf("bits"), parsed.layouts.get("bits")).members.map((member) => member.value),
            [1, 2, 3]
        );
        assert.deepStrictEqual(
            elf.decodeComposite(bytesOf("packed"), parsed.layouts.get("packed")).members.map((member) => member.value),
            [3, -2]
        );
        const watch = normalizeWatchList([{ name: "packed.b" }], result.symbols);
        const plan = buildActiveReadPlan([watch], elf);
        assert.strictEqual(plan[0].size, 1, "a packed bitfield must not read past its containing object");
        const decoded = new LiveWatchService(elf).decodeConsumerSamples(
            [{ name: watch[0].name, bytes: bytesOf("packed") }],
            1,
            new Map([[watch[0].name, watch[0]]]),
            null,
            new Map()
        );
        assert.strictEqual(decoded.scalarSamples[0].value, -2);
        assert.throws(() => write("packed.b"), { code: "UNSUPPORTED_VARIABLE" });
        assert.deepStrictEqual(
            elf.decodeComposite(bytesOf("utfbox"), parsed.layouts.get("utfbox")).members.map((member) => member.value),
            [90, 90]
        );
        const anon = byName.get("anon");
        assert.strictEqual(
            elf.expandCompositeLeaves(anon, anon.compositeLayout, elf.parseMemberPath("anon.a"))[0].address,
            anon.address
        );
        assert.strictEqual(
            elf.navigateCompositeTree(
                elf.decodeComposite(bytesOf("anon"), anon.compositeLayout),
                elf.parseMemberPath("anon.a")
            ).value,
            7
        );
    }
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}

// Equal outer names and sizes do not make conflicting CU definitions interchangeable.
const dies = new Map([
    [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
    [10, { tag: c.DW_TAG_structure_type, name: "Same", byteSize: 8 }],
    [11, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 }],
    [20, { tag: c.DW_TAG_structure_type, name: "Same", byteSize: 8 }],
    [21, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 4 }]
]);
const parsed = {
    dies,
    childrenMap: new Map([
        [10, [11]],
        [20, [21]]
    ]),
    variables: [
        { name: "state", typeRef: 10 },
        { name: "state", typeRef: 20 }
    ]
};
assert.strictEqual(buildCompositeLayouts(parsed).has("state"), false);
dies.set(30, { tag: c.DW_TAG_structure_type, name: "UnknownLocation", byteSize: 4 });
dies.set(31, { tag: c.DW_TAG_member, name: "value", typeRef: 1 });
parsed.childrenMap.set(30, [31]);
parsed.variables = [{ name: "unknown", typeRef: 30 }];
assert.deepStrictEqual(
    elf.expandCompositeLeaves(
        { name: "unknown", size: 4, address: 0x20000000 },
        buildCompositeLayouts(parsed).get("unknown")
    ),
    []
);

// Array element constness must survive layout construction, including explicit index paths.
dies.set(40, { tag: c.DW_TAG_const_type, typeRef: 1 });
dies.set(41, { tag: c.DW_TAG_array_type, typeRef: 40 });
dies.set(42, { tag: c.DW_TAG_subrange_type, subrangeCount: 2 });
parsed.childrenMap.set(41, [42]);
parsed.variables = [{ name: "array", typeRef: 41 }];
assert.strictEqual(buildVariableTypes(parsed).get("array").isConst, true);
const array = buildCompositeLayouts(parsed).get("array");
const arraySymbol = { name: "array", size: 8, address: 0x20000000 };
assert.ok(elf.expandCompositeLeaves(arraySymbol, array).every((leaf) => leaf.isConst));
assert.strictEqual(elf.expandCompositeLeaves(arraySymbol, array, elf.parseMemberPath("array[1]"))[0].isConst, true);

const scalar = { name: "value", offset: 0, byteSize: 4, watchType: "i32" };
const innermost = { kind: "union", byteSize: 4, members: [scalar] };
const anonymous = {
    kind: "struct",
    byteSize: 4,
    members: [{ name: "", offset: 0, byteSize: 4, compositeLayout: innermost }]
};
const root = {
    kind: "struct",
    byteSize: 8,
    isConst: true,
    members: [{ name: "", offset: 4, byteSize: 4, compositeLayout: anonymous }]
};
const rootSymbol = { name: "root", size: 8, address: 0x20000000 };
assert.strictEqual(
    elf.expandCompositeLeaves(rootSymbol, root, elf.parseMemberPath("root.value"))[0].address,
    0x20000004
);
assert.strictEqual(elf.expandCompositeLeaves(rootSymbol, root, elf.parseMemberPath("root.value"))[0].isConst, true);
assert.strictEqual(
    elf.navigateCompositeTree(elf.decodeComposite([0, 0, 0, 0, 7, 0, 0, 0], root), elf.parseMemberPath("root.value"))
        .value,
    7
);
const ambiguous = { ...root, members: [...root.members, { ...root.members[0], offset: 0 }] };
assert.deepStrictEqual(elf.expandCompositeLeaves(rootSymbol, ambiguous, elf.parseMemberPath("root.value")), []);
assert.strictEqual(
    elf.navigateCompositeTree(
        elf.decodeComposite([0, 0, 0, 0, 7, 0, 0, 0], ambiguous),
        elf.parseMemberPath("root.value")
    ),
    null
);
assert.strictEqual(elf.parseMemberPath("name+1"), null);
assert.ok(elf.parseMemberPath("ns::Holder<std::array<std::array<int, 2>, 3>>::object.value"));

// The UI must use the same promoted anonymous paths and bitfield metadata as the backend.
const symbol = { ...rootSymbol, isComposite: true, compositeLayout: root };
const sidebar = render(getModernWebviewContent({}, "en"));
try {
    sidebar.send({ type: "availableVariables", symbols: [symbol] });
    sidebar.document.querySelector(".available-row.comp .av-arrow").click();
    assert.strictEqual(sidebar.document.querySelector(".available-row.leaf .av-write").disabled, true);
    assert.strictEqual(sidebar.window.sbCollectLeaves(root, "root", rootSymbol.address)[0].path, "root.value");
    sidebar.send({ type: "sidebarWatchList", items: [symbol] });
    assert.strictEqual(sidebar.document.querySelector(".sb-mname").title, "root.value");
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}
const graph = render(getLiveWatchContent({ panelId: 1 }, "en"));
try {
    graph.send({ type: "watchList", items: [symbol] });
    assert.strictEqual(graph.document.querySelector(".member-name").title, "root.value");
    assert.strictEqual(graph.window.collectLeaves(root, "root", rootSymbol.address)[0].path, "root.value");
    graph.assertHealthy();
} finally {
    graph.close();
}
(async () => {
    const workerTemporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-cpp-worker-"));
    const file = path.join(workerTemporary, "types.elf");
    fs.writeFileSync(file, zlib.inflateSync(Buffer.from(fixtures.dwarf5, "base64")));
    const service = new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "test",
        fs,
        crypto,
        elfSymbols: elf,
        dwarf,
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.resolve(__dirname, "../src/elfWorker.js")
    });
    try {
        const result = await service.ready();
        const readonly = result.symbols.find((symbol) => symbol.displayName === "readonlyRoot");
        assert.ok(readonly?.isConst, "the worker must bind internal-linkage C++ globals by unique static address");
        const layout = await service.layout(readonly.name);
        assert.ok(elf.expandCompositeLeaves(readonly, layout).every((leaf) => leaf.isConst));
        assert.strictEqual(result.symbols.find((symbol) => symbol.name === "methodPointer").watchType, "u64");
    } finally {
        service.invalidate();
        fs.rmSync(workerTemporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    console.log("C++ review regressions passed (real ARM DWARF4/5, writes, sampling, webviews and worker)");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
