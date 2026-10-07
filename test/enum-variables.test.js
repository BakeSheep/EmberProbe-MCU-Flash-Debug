"use strict";

const assert = require("assert");
const c = require("../src/dwarf/constants");
const { buildVariableTypes, buildCompositeLayouts } = require("../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const { createFormReader } = require("../src/dwarf/forms");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { ElfService } = require("../src/services/elfService");
const { normalizeWatchList } = require("../src/validation");
const elf = require("../src/elfSymbols");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { loadProvider } = require("./helpers/load-provider");
const { buildElf32 } = require("./helpers/elf-fixture");

const parsed = {
    dies: new Map([
        [1, { tag: c.DW_TAG_base_type, encoding: c.DW_ATE_unsigned, byteSize: 4 }],
        [2, { tag: c.DW_TAG_enumeration_type, name: "State", qualifiedTypeName: "app::State", byteSize: 1 }],
        [3, { tag: c.DW_TAG_enumerator, name: "Error", qualifiedName: "app::State::Error", constantValue: -1 }],
        [4, { tag: c.DW_TAG_enumerator, name: "Active", qualifiedName: "app::State::Active", constantValue: 3 }],
        [5, { tag: c.DW_TAG_enumerator, name: "Alias", qualifiedName: "app::State::Alias", constantValue: 3 }],
        [6, { tag: c.DW_TAG_typedef, name: "StateAlias", typeRef: 2 }],
        [7, { tag: c.DW_TAG_const_type, typeRef: 6 }],
        [8, { tag: c.DW_TAG_volatile_type, typeRef: 7 }],
        [10, { tag: c.DW_TAG_structure_type, name: "Packet", byteSize: 2 }],
        [11, { tag: c.DW_TAG_member, name: "state", typeRef: 2, memberOffset: 0 }],
        [12, { tag: c.DW_TAG_member, name: "bits", typeRef: 2, memberOffset: 1, bitSize: 3, dataBitOffset: 8 }],
        [20, { tag: c.DW_TAG_array_type, typeRef: 6 }],
        [21, { tag: c.DW_TAG_subrange_type, subrangeCount: 2 }],
        [30, { tag: c.DW_TAG_enumeration_type, name: "Tiny", byteSize: 1, typeRef: 1 }],
        [31, { tag: c.DW_TAG_enumerator, name: "Three", constantValue: 3 }],
        [40, { tag: c.DW_TAG_pointer_type, typeRef: 30, byteSize: 4 }],
        [41, { tag: c.DW_TAG_pointer_type, typeRef: 2, byteSize: 4 }],
        [50, { tag: c.DW_TAG_enumeration_type, name: "Wide", byteSize: 8, encoding: c.DW_ATE_unsigned }],
        [51, { tag: c.DW_TAG_enumerator, name: "Maximum", constantValue: { integer64: "18446744073709551615" } }],
        [60, { tag: c.DW_TAG_enumeration_type, name: "Unknown", byteSize: 1 }]
    ]),
    childrenMap: new Map([
        [2, [3, 4, 5]],
        [10, [11, 12]],
        [20, [21]],
        [30, [31]],
        [50, [51]]
    ]),
    variables: [
        { name: "state", typeRef: 2 },
        { name: "alias", typeRef: 8 },
        { name: "packet", typeRef: 10 },
        { name: "states", typeRef: 20 },
        { name: "pointer", typeRef: 40 },
        { name: "signedPointer", typeRef: 41 },
        { name: "wide", typeRef: 50 },
        { name: "unknown", typeRef: 60 }
    ]
};

(async () => {
    const types = buildVariableTypes(parsed);
    assert.strictEqual(types.get("state").watchType, "i8", "negative legacy members determine signed reads");
    assert.strictEqual(types.get("state").enumEncodingInferred, true);
    assert.deepStrictEqual(types.get("alias").enumInfo, types.get("state").enumInfo);
    assert.strictEqual(types.get("alias").isConst, true);
    const layouts = buildCompositeLayouts(parsed);
    const symbols = [
        { name: "state", size: 1, address: 0x20000000 },
        { name: "unknown", size: 1, address: 0x20000001 }
    ];
    new ElfService({ elfSymbols: elf, t: (key) => key })._enrich({ symbols }, types);
    assert.strictEqual(symbols[0].hasDwarfWriteType, false, "inferred encoding must not authorize writes");
    assert.strictEqual(symbols[1].watchType, "", "unknown enum must not fall back to unsigned");
    assert.throws(() => elf.resolveVariableRequests(symbols, [{ name: "unknown" }]), {
        code: "UNSUPPORTED_VARIABLE_TYPE"
    });
    const watched = normalizeWatchList([{ name: "state", type: "u8", enumInfo: { entries: [] } }], symbols);
    assert.strictEqual(watched[0].type, "i8", "stale or forged watch metadata must use the ELF enum type");
    assert.strictEqual(watched[0].enumInfo, types.get("state").enumInfo);
    const service = new LiveWatchService(elf);
    const decode = (value, type, enumInfo) =>
        service.decodeConsumerSamples(
            [{ name: "state", bytes: elf.encodeValue(value, type) }],
            1,
            new Map([["state", { type, enumInfo }]]),
            null
        ).scalarSamples[0];
    const negative = decode(-1, "i8", types.get("state").enumInfo);
    assert.strictEqual(negative.enumText, ".Error(-1)");
    assert.strictEqual(negative.value, -1);
    assert.strictEqual(negative.valueText, null);
    assert.strictEqual(decode(3, "i8", types.get("state").enumInfo).enumText, ".Active / .Alias(3)");
    assert.strictEqual(
        decode(3, "i8", { entries: [{ name: "app::State::Active", value: "3" }] }).enumText,
        ".Active(3)"
    );
    assert.strictEqual(types.get("state").enumInfo.entries[1].name, "app::State::Active");
    assert.strictEqual(decode(7, "i8", types.get("state").enumInfo).enumText, null, "unknown values remain numeric");
    const wide = decode("18446744073709551615", "u64", types.get("wide").enumInfo);
    assert.strictEqual(wide.enumText, "Maximum(18446744073709551615)");
    assert.strictEqual(wide.valueText, "18446744073709551615");
    const packet = elf.decodeComposite([255, 7], layouts.get("packet"));
    assert.strictEqual(packet.members[0].enumText, negative.enumText);
    assert.strictEqual(packet.members[1].enumText, negative.enumText, "signed enum bitfields retain names");
    const array = elf.decodeComposite([255, 3], layouts.get("states"));
    assert.strictEqual(array.elements[0].enumText, negative.enumText);
    const leaf = elf.expandCompositeLeaves({ name: "packet", address: 0x20000000, size: 2 }, layouts.get("packet"))[0];
    assert.strictEqual(leaf.enumEncodingInferred, true);
    assert.deepStrictEqual(leaf.enumInfo, types.get("state").enumInfo);
    const normalizedLeaf = normalizeWatchList(
        [{ name: "packet.state" }],
        [{ name: "packet", address: 0x20000000, size: 2, isComposite: true, compositeLayout: layouts.get("packet") }]
    );
    assert.deepStrictEqual(normalizedLeaf[0].enumInfo, leaf.enumInfo);
    const packetSymbol = {
        name: "packet",
        address: 0x20000000,
        size: 2,
        isComposite: true,
        compositeLayout: layouts.get("packet")
    };
    const Provider = loadProvider(
        {},
        {
            fs: {
                readFileSync: () =>
                    buildElf32({ sections: [{ name: ".data", flags: 3, addr: 0x20000000, data: [255, 7] }] })
            }
        }
    );
    const provider = Object.create(Provider.prototype);
    provider.readElfSymbols = () => ({ elf: { path: "enum-fixture.elf" }, symbols: [symbols[0], packetSymbol] });
    for (const name of ["state", "packet.state"])
        assert.throws(() => provider._agentWritePlan([{ name, value: 3 }], { refreshSymbols: false }), {
            code: "WRITE_TYPE_UNKNOWN"
        });
    const history = service.decodeHistorySamples([{ name: "packet", bytes: [255, 7] }], 1, [
        { ...leaf, name: leaf.path, parentName: "packet", parentAddress: 0x20000000 }
    ]);
    assert.strictEqual(history[0].enumText, negative.enumText);

    for (const [name, bytes, expected] of [
        ["pointer", [3], "Three(3)"],
        ["signedPointer", [255], negative.enumText]
    ]) {
        const graph = createRuntimeLayoutResolver(parsed)(name);
        const target = graph.types[graph.root].target;
        assert.strictEqual(graph.types[target].byteSize, 1);
        assert.strictEqual(graph.types[target].watchType, name === "pointer" ? "u8" : "i8");
        const reader = new RuntimeObjectReader(
            { runtimeLayout: graph, runtimeRanges: [{ start: 0x20000000, end: 0x20000001 }] },
            async () => Buffer.from(bytes)
        );
        const tree = await reader.tree({ address: 0x20000000, type: target });
        assert.strictEqual(tree.enumText, expected);
        assert.strictEqual(
            service.decodeConsumerSamples([{ name, runtimeTree: tree }], 1, new Map([[name, "i8"]]), null)
                .scalarSamples[0].enumText,
            expected
        );
    }

    // Exact signed/unsigned LEB constants, including the endpoints and malformed inputs.
    const leb = (number, signed) => {
        const result = [];
        let value = BigInt(number);
        for (;;) {
            const byte = Number(value & 127n);
            value >>= 7n;
            const done = signed ? (value === 0n && !(byte & 64)) || (value === -1n && !!(byte & 64)) : value === 0n;
            result.push(byte | (done ? 0 : 128));
            if (done) return Buffer.from(result);
        }
    };
    for (const [value, signed] of [
        [18446744073709551615n, false],
        [-9223372036854775808n, true],
        [-1n, true],
        [3n, false]
    ]) {
        const read = createFormReader({ buf: leb(value, signed) });
        const result = read({ p: 0 }, signed ? 0x0d : 0x0f, { exactInteger: true });
        assert.strictEqual(String(result.integer64 ?? result), String(value));
    }
    for (const bytes of [Buffer.from([128]), Buffer.alloc(10, 255), leb(1n << 64n, false)])
        assert.throws(() => createFormReader({ buf: bytes })({ p: 0 }, 0x0f, { exactInteger: true }));
    const oversized = { ...parsed, childrenMap: new Map(parsed.childrenMap), dies: new Map(parsed.dies) };
    oversized.childrenMap.set(
        2,
        Array.from({ length: 1025 }, () => 3)
    );
    assert.throws(() => buildVariableTypes(oversized), { code: "DWARF_BUDGET_EXCEEDED" });
    oversized.childrenMap.set(2, [3]);
    oversized.dies.set(3, { tag: c.DW_TAG_enumerator, name: "bad", constantValue: 0.5 });
    assert.strictEqual(buildVariableTypes(oversized).get("state").enumInfo, undefined);

    for (const [html, watchMessage, sampleMessage] of [
        [getModernWebviewContent({}, "en"), "sidebarWatchList", "liveSample"],
        [getLiveWatchContent({ panelId: 1, backendHistory: true }, "en"), "watchList", "chartValues"]
    ]) {
        const ui = render(html);
        const selector = watchMessage === "watchList" ? ".var-value" : "[data-value-name=state]";
        try {
            ui.send({ type: watchMessage, items: [{ ...symbols[0], type: "i8" }] });
            ui.send({ type: sampleMessage, samples: [negative] });
            assert.strictEqual(ui.document.querySelector(selector).textContent, negative.enumText);
            ui.send({ type: watchMessage, items: [{ ...symbols[0], type: "i8" }] });
            assert.strictEqual(
                ui.document.querySelector(selector).textContent,
                negative.enumText,
                "rerender preserves enum names"
            );
            const unsafe = { ...negative, enumText: "<img src=x onerror=alert(1)> (-1)" };
            ui.window.eval("lastValueRefresh = 0");
            ui.send({ type: sampleMessage, samples: [unsafe] });
            assert.strictEqual(ui.document.querySelector(selector).textContent, unsafe.enumText);
            assert.strictEqual(ui.document.querySelector(selector + " img"), null);
            ui.window.eval("lastValueRefresh = 0");
            ui.send({ type: sampleMessage, samples: [{ ...negative, value: 7, enumText: null }] });
            assert.strictEqual(ui.document.querySelector(selector).textContent, "7");
            ui.send({ type: watchMessage, items: [packetSymbol] });
            ui.window.eval("lastValueRefresh = 0");
            ui.send({ type: "liveCompositeSample", samples: [{ name: "packet", tree: packet }] });
            const memberSelector = watchMessage === "watchList" ? ".member-value" : ".sb-mval";
            assert.strictEqual(ui.document.querySelector(memberSelector).textContent, negative.enumText);
            if (watchMessage === "sidebarWatchList") {
                ui.send({ type: "availableVariables", symbols: [packetSymbol] });
                ui.document.querySelector(".available-row.comp .av-arrow").click();
                assert.strictEqual(ui.document.querySelector(".available-row.leaf .av-write").disabled, true);
            }
        } finally {
            ui.close();
        }
    }
    console.log("Enum values, aliases, legacy signedness, runtime widths and webview display passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
