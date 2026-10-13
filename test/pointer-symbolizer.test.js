"use strict";

const assert = require("assert");
const crypto = require("crypto");
const zlib = require("zlib");
const elf = require("../src/elfSymbols");
const dwarf = require("../src/dwarf");
const { ElfService } = require("../src/services/elfService");
const { PointerSymbolizer, MAX_POINTER_CACHE_ENTRIES } = require("../src/services/pointerSymbolizer");
const { LiveWatchService, buildChartHistoryItems } = require("../src/services/liveWatchService");
const { normalizeWatchList } = require("../src/validation");
const { formatPointer } = require("../src/webview/runtime");
const { loadProvider } = require("./helpers/load-provider");

const metadata = {
    elf: { sha256: "unit" },
    functions: [
        { name: "_Z7handlerv", displayName: "app::handler", address: 0x08000020, size: 0x20 },
        { name: "assembly", address: 0x08000100, size: 0 }
    ],
    symbols: [
        {
            name: "_Z6packet",
            displayName: "app::packet",
            address: 0x20000000,
            size: 64,
            compositeLayout: { kind: "array", elementType: { byteSize: 4 } }
        },
        { name: "object", address: 0x20000100, size: 128 },
        { name: "nested", address: 0x20000110, size: 4 },
        { name: "unknownArray", address: 0x20000200, size: 32, compositeLayout: { kind: "array" } },
        { name: "empty", address: 0x20000300, size: 0 },
        { name: "overflow", address: 0xffffffff, size: 4 },
        { name: "_ZTVN3app6WidgetE", address: 0x08000200, size: 24 },
        { name: "_ZTVComplex", displayName: "vtable for ns::Holder<int>", address: 0x08000240, size: 24 },
        { name: "_ZTV999Bad", address: 0x08000280, size: 16 },
        { name: "_ZTVBad", address: 0x080002a0, size: 16 }
    ],
    memory: {
        sections: [
            { addr: 0x08000000, size: 0x1000, flags: 6 },
            { addr: 0x08002000, size: 0x100, flags: 2 },
            { addr: 0x20000000, size: 0x1000, flags: 3 },
            { addr: 0x20000500, size: 4, flags: 3 },
            { addr: 0x10000000, size: 0x100, flags: 0 },
            { addr: 0xffffffff, size: 8, flags: 3 },
            { addr: 0x20002000, size: 0, flags: 3 }
        ]
    }
};
const symbolizer = new PointerSymbolizer(metadata);
const text = (value, target) => symbolizer.resolve(value, target)?.text;

assert.strictEqual(text(0x08000020, "function"), "→ app::handler");
assert.strictEqual(text(0x08000021, "function"), "→ app::handler", "clear Thumb bit");
assert.strictEqual(text(0x08000025, "function"), "→ app::handler+0x4");
assert.strictEqual(symbolizer.resolve(0x08000040, "function").kind, "region", "function end is exclusive");
assert.strictEqual(text(0x08000104, "function"), "→ assembly+0x4");
assert.strictEqual(symbolizer.resolve(0x08010100, "function").offset, 0x10000, "zero-size function bound");
assert.strictEqual(symbolizer.resolve(0x08010102, "function").kind, "invalid");
assert.strictEqual(symbolizer.resolve(0x08000000, "function").region, "flash", "before the first function");
for (const value of [0x08000020, 0x08000021, 0x08000025, 0x08000040, 0x08000104, 0x08010100, 0x08010102]) {
    const expected = elf.nearestFunction(metadata.functions, value);
    const actual = symbolizer.resolve(value, "function");
    assert.strictEqual(actual.kind === "function" ? actual.name : null, expected?.displayName || null);
    if (expected) assert.strictEqual(actual.offset, expected.offset);
}
const arrayInfo = symbolizer.resolve(0x20000030);
assert.deepStrictEqual(arrayInfo, {
    kind: "data",
    name: "app::packet",
    offset: 48,
    index: 12,
    text: "→ &app::packet[12]"
});
assert.strictEqual(text(0x20000000), "→ &app::packet[0]");
assert.strictEqual(text(0x20000031), "→ &app::packet+0x31", "unaligned array addresses keep a byte offset");
assert.strictEqual(text(0x20000100), "→ &object");
assert.strictEqual(text(0x20000110), "→ &nested", "prefer the closest containing symbol");
assert.strictEqual(text(0x20000120), "→ &object+0x20", "outer symbols remain searchable past a nested symbol");
assert.strictEqual(text(0x20000210), "→ &unknownArray+0x10");
assert.strictEqual(symbolizer.resolve(0x20000040).kind, "region", "data end is exclusive");
assert.strictEqual(symbolizer.resolve(0x20000180).kind, "region");
assert.strictEqual(symbolizer.resolve(0x08000024, "data").kind, "region", "data pointers do not resolve functions");
for (const target of ["data", "void", "incomplete"]) assert.strictEqual(text(0x20000110, target), "→ &nested");
for (const [address, region] of [
    [0x08000010, "flash"],
    [0x08002010, "flash"],
    [0x20000510, "ram"],
    [0x40000000, "peripheral"],
    [0x5fffffff, "peripheral"],
    [0xe0000000, "system"],
    [0xffffffff, "system"]
])
    assert.strictEqual(symbolizer.resolve(address).region, region);
for (const address of [1, 0x10000000, 0x08002100, 0x20001000, 0x60000000, 0xdfffffff])
    assert.strictEqual(symbolizer.resolve(address).kind, "invalid");
assert.strictEqual(symbolizer.resolve(0), null);
assert.strictEqual(symbolizer.resolve(0, "function"), null);
for (const invalid of [-1, 0x100000000, NaN, Infinity, 1.5, "123", null, undefined])
    assert.strictEqual(symbolizer.resolve(invalid), null);
assert.strictEqual(symbolizer.resolve(0x20000100n).text, "→ &object");

assert.strictEqual(symbolizer.resolve(0x08000208, "vtable").dynamicTypeName, "app::Widget");
assert.strictEqual(symbolizer.resolve(0x08000210, "vtable").dynamicTypeName, "app::Widget");
assert.strictEqual(symbolizer.resolve(0x08000248, "vtable").dynamicTypeName, "ns::Holder<int>");
assert.strictEqual(symbolizer.resolve(0x080001fc, "vtable").kind, "region");
assert.strictEqual(symbolizer.resolve(0x08000220, "vtable").kind, "region", "value - 8 must be inside the vtable");
assert.strictEqual(symbolizer.resolve(0x08000288, "vtable").kind, "data", "unknown class names are not invented");
assert.strictEqual(symbolizer.resolve(0x08000208).kind, "data", "vtable interpretation is explicit");

// Verify logarithmic function lookup without timing-dependent performance assertions.
let functionLookups = 0;
const manyFunctions = new Proxy(
    Array.from({ length: 8192 }, (_, index) => ({ name: "fn" + index, address: 0x08000000 + index * 16, size: 16 })),
    {
        get(target, key) {
            if (/^\d+$/.test(String(key))) functionLookups++;
            return target[key];
        }
    }
);
const logarithmic = new PointerSymbolizer({ functions: manyFunctions });
assert.strictEqual(logarithmic.resolve(0x08000000 + 7000 * 16 + 5, "function").text, "→ fn7000+0x4");
assert.ok(functionLookups <= 15, "one binary search, rather than a scan, per uncached pointer");
const accesses = functionLookups;
logarithmic.resolve(0x08000000 + 7000 * 16 + 5, "function");
assert.strictEqual(functionLookups, accesses, "cache hits avoid the index entirely");
const lateCatalog = new PointerSymbolizer(metadata);
const lateAddress = 0x08000308;
assert.strictEqual(lateCatalog.resolve(lateAddress, "vtable").kind, "region");
const graph = {
    types: [{ typeName: "class Dynamic" }, {}],
    dynamicTypes: [
        { address: 0x08000300, size: 20, type: 0 },
        { address: 0xffffffff, size: 20, type: 0 },
        { address: 0x08000400, size: 20, type: 1 }
    ]
};
lateCatalog.addRuntimeLayout(graph);
const dynamicInfo = lateCatalog.resolve(lateAddress, "vtable");
assert.strictEqual(dynamicInfo.dynamicTypeName, "Dynamic");
lateCatalog.addRuntimeLayout(graph);
assert.strictEqual(lateCatalog.resolve(lateAddress, "vtable"), dynamicInfo, "a prepared graph is indexed once");

const lazySymbol = { name: "lateArray", address: 0x20000000, size: 32 };
const lazyResolver = new PointerSymbolizer({ symbols: [lazySymbol] });
assert.strictEqual(lazyResolver.resolve(0x2000000c).text, "→ &lateArray+0xC");
lazySymbol.compositeLayout = { kind: "array", elementType: { byteSize: 4 } };
assert.strictEqual(lazyResolver.resolve(0x2000000c).text, "→ &lateArray[3]", "lazy layouts refresh cached offsets");
lazySymbol.displayName = "app::lateArray";
assert.strictEqual(
    lazyResolver.resolve(0x2000000c).text,
    "→ &app::lateArray[3]",
    "late display names refresh the cache"
);

const cached = symbolizer.resolve(0x20000100);
assert.strictEqual(symbolizer.resolve(0x20000100), cached);
symbolizer.updateElf(metadata);
assert.strictEqual(symbolizer.resolve(0x20000100), cached, "unchanged ELF retains its LRU");
const changed = {
    ...metadata,
    elf: { sha256: "other" },
    symbols: [{ name: "replacement", address: 0x20000100, size: 4 }]
};
symbolizer.updateElf(changed);
assert.strictEqual(symbolizer.cache.size, 0);
assert.strictEqual(text(0x20000100), "→ &replacement");
assert.strictEqual(symbolizer.resolve(0x08000208, "vtable").kind, "region", "old vtables are invalidated");
changed.symbols.push({ name: "streamed", address: 0x20000200, size: 4 });
symbolizer.updateElf(changed);
assert.strictEqual(text(0x20000200), "→ &streamed", "streamed symbols refresh without a hash change");
changed.symbols[0].displayName = "newDisplay";
symbolizer.updateElf(changed, true);
assert.strictEqual(text(0x20000100), "→ &newDisplay", "enriched metadata invalidates annotations");
symbolizer.updateElf(null);
assert.strictEqual(symbolizer.resolve(0x08000010, "function").kind, "invalid");

const bounded = new PointerSymbolizer(metadata, { cacheLimit: 2 });
const first = bounded.resolve(0x20000100);
bounded.resolve(0x20000104);
assert.strictEqual(bounded.resolve(0x20000100), first, "cache hits promote an entry");
bounded.resolve(0x20000108);
assert.ok(bounded.cache.has("data:536871168"));
assert.ok(!bounded.cache.has("data:536871172"), "evict the least recently used entry");
bounded.resolve(0x20000100, "void");
assert.strictEqual(bounded.cache.size, 2, "target kind is part of the key");
const maximum = new PointerSymbolizer(null, { cacheLimit: MAX_POINTER_CACHE_ENTRIES + 100 });
for (let value = 1; value <= MAX_POINTER_CACHE_ENTRIES + 200; value++) maximum.resolve(value);
assert.strictEqual(maximum.cache.size, MAX_POINTER_CACHE_ENTRIES);
assert.strictEqual(new PointerSymbolizer(null, { cacheLimit: NaN }).cacheLimit, MAX_POINTER_CACHE_ENTRIES);
assert.strictEqual(new PointerSymbolizer(null, { cacheLimit: 0 }).cacheLimit, 1);

// Static, runtime and scalar decoding share annotations, with immutable raw identities/values.
const live = new LiveWatchService(elf, new PointerSymbolizer(metadata));
const bytes = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
};
const pointerSpec = { type: "u32", isPointer: true, pointerTarget: "data" };
const scalarMap = new Map([
    ["ptr", pointerSpec],
    ["number", "u32"]
]);
const rawScalar = [{ name: "ptr", bytes: bytes(0x20000110), t: 11 }];
const scalar = live.decodeConsumerSamples(rawScalar, 12, scalarMap, null).scalarSamples[0];
assert.strictEqual(scalar.name, "ptr");
assert.strictEqual(scalar.value, 0x20000110);
assert.strictEqual(scalar.valueText, "0x20000110");
assert.strictEqual(scalar.pointerText, "→ &nested");
assert.strictEqual(scalar.t, 11);
assert.strictEqual(
    live.decodeConsumerSamples([{ name: "ptr", bytes: bytes(0) }], 12, scalarMap).scalarSamples[0].pointerText,
    undefined
);
assert.strictEqual(
    live.decodeConsumerSamples([{ name: "ptr", bytes: null }], 12, scalarMap).scalarSamples[0].valueText,
    null
);
const ordinary = live.decodeConsumerSamples([{ name: "number", bytes: bytes(42) }], 12, scalarMap).scalarSamples[0];
assert.strictEqual(ordinary.value, 42);
assert.strictEqual(ordinary.pointerText, undefined);
const unavailable = live.decodeConsumerSamples([{ name: "ptr", diagnostic: { message: "read failed" } }], 12, scalarMap)
    .scalarSamples[0];
assert.strictEqual(unavailable.valueText, "<unavailable: read failed>");
assert.strictEqual(unavailable.pointerText, undefined);

const runtimeTree = {
    kind: "class",
    members: [{ name: "peer", kind: "scalar", isPointer: true, pointerTarget: "data", value: 0x20000110 }],
    elements: [{ index: 0, isPointer: true, pointerTarget: "function", value: 0x08000025 }]
};
const original = JSON.stringify(runtimeTree);
const runtimeDecoded = live.decodeConsumerSamples([{ name: "runtime", runtimeTree }], 13, new Map([["runtime", ""]]))
    .compositeSamples[0].tree;
assert.strictEqual(runtimeDecoded.members[0].pointerText, "→ &nested");
assert.strictEqual(runtimeDecoded.elements[0].pointerText, "→ app::handler+0x4");
assert.strictEqual(JSON.stringify(runtimeTree), original, "runtime samples are not mutated");
const runtimeScalar = live.decodeConsumerSamples(
    [{ name: "ptr", runtimeTree: { kind: "scalar", isPointer: true, pointerTarget: "function", value: 0x08000021 } }],
    14,
    scalarMap
).scalarSamples[0];
assert.strictEqual(runtimeScalar.pointerText, "→ app::handler");
assert.strictEqual(runtimeScalar.valueText, "0x08000021");
const noSymbols = new LiveWatchService(elf);
assert.strictEqual(noSymbols.decodeConsumerSamples(rawScalar, 12, scalarMap).scalarSamples[0].valueText, "0x20000110");
assert.strictEqual(noSymbols.decodeConsumerSamples(rawScalar, 12, scalarMap).scalarSamples[0].pointerText, undefined);
assert.strictEqual(
    noSymbols.decodeConsumerSamples([{ name: "runtime", runtimeTree }], 13, new Map([["runtime", ""]]))
        .compositeSamples[0].tree.members[0].valueText,
    "0x20000110"
);

const pointerArray = {
    kind: "array",
    byteSize: 4,
    totalElements: 1,
    dimensions: [1],
    elementType: { byteSize: 4, watchType: "u32", isPointer: true, pointerTarget: "data" }
};
const arrayTree = live.decodeConsumerSamples(
    [{ name: "pointers", bytes: bytes(0x20000110) }],
    15,
    null,
    new Map([["pointers", { layout: pointerArray }]])
).compositeSamples[0].tree;
assert.strictEqual(arrayTree.elements[0].pointerText, "→ &nested");
assert.strictEqual(arrayTree.elements[0].value, 0x20000110);
live.setElfResult(changed, true);
assert.strictEqual(
    live.decodeConsumerSamples([{ name: "ptr", bytes: bytes(0x20000100) }], 16, scalarMap).scalarSamples[0].pointerText,
    "→ &newDisplay"
);
const history = new LiveWatchService(elf, new PointerSymbolizer(metadata)).decodeHistorySamples(rawScalar, 17, [
    { name: "ptr", ...pointerSpec }
]);
assert.strictEqual(history[0].pointerText, "→ &nested");
assert.strictEqual(
    normalizeWatchList(
        [{ name: "number", isPointer: true, pointerTarget: "function" }],
        [{ name: "number", address: 0x20000100, size: 4, watchType: "u32" }]
    )[0].isPointer,
    undefined,
    "pointer identity comes from the ELF"
);

// Both committed GCC fixtures, without a compiler, probe or additional target reads.
const fixture = require("./fixtures/pointer-classes/elf.json");
for (const version of [4, 5]) {
    const buffer = zlib.inflateSync(Buffer.from(fixture["dwarf" + version], "base64"));
    const parsed = dwarf.parseDwarf(buffer, { runtime: true });
    const result = elf.parseElfSymbols(buffer);
    result.elf = { sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
    result.memory = elf.parseElfSections(buffer);
    new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
        result,
        parsed.types,
        parsed.layouts,
        parsed.displayNames
    );
    for (const fn of result.functions) fn.displayName = parsed.displayNames.get(fn.name) || fn.name;
    const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
    const handler = result.functions.find((fn) => fn.displayName === "clickHandler");
    const rxBuf = byName.get("rxBuf");
    const motor = byName.get("motor");
    const vtable = byName.get("_ZTV15MotorController");
    const resolver = new PointerSymbolizer(result);
    assert.strictEqual(resolver.resolve(handler.address + 1, "function").text, "→ clickHandler");
    assert.strictEqual(resolver.resolve(rxBuf.address + 12, "data").text, "→ &rxBuf[12]");
    assert.strictEqual(resolver.resolve(vtable.address + 8, "vtable").dynamicTypeName, "MotorController");

    const filtered = { ...result, symbols: result.symbols.filter((symbol) => !elf.isCppRuntimeSymbol(symbol.name)) };
    const service = new LiveWatchService(elf, new PointerSymbolizer(filtered));
    assert.strictEqual(
        service.pointerSymbolizer.resolve(vtable.address + 8, "vtable").dynamicTypeName,
        "MotorController",
        "filtered host results retain the runtime vtable catalog"
    );
    const leaves = elf.expandCompositeLeaves(motor, motor.compositeLayout);
    const motorBytes = Buffer.alloc(motor.size);
    const writeLeaf = (name, value) =>
        motorBytes.writeUInt32LE(value, leaves.find((leaf) => leaf.path === name).address - motor.address);
    writeLeaf("motor.@base0.@base0._vptr.Listener", vtable.address + 8);
    writeLeaf("motor.callback._M_invoker", handler.address + 1);
    writeLeaf("motor.rxBuffer", rxBuf.address + 12);
    const compositeMap = new Map([["motor", { ...motor, layout: motor.compositeLayout }]]);
    const decodedMotor = service.decodeConsumerSamples([{ name: "motor", bytes: motorBytes }], 20, null, compositeMap)
        .compositeSamples[0].tree;
    assert.strictEqual(decodedMotor.dynamicTypeName, "MotorController");
    const vptr = decodedMotor.members
        .find((member) => member.name === "@base0")
        .members.find((member) => member.name === "@base0")
        .members.find((member) => member.name.startsWith("_vptr"));
    assert.strictEqual(vptr.pointerText, "→ MotorController");
    assert.strictEqual(vptr.value, vtable.address + 8);
    assert.strictEqual(
        decodedMotor.members
            .find((member) => member.name === "callback")
            .members.find((member) => member.name === "_M_invoker").pointerText,
        "→ clickHandler"
    );
    assert.strictEqual(decodedMotor.members.find((member) => member.name === "rxBuffer").pointerText, "→ &rxBuf[12]");
    const vptrLeaf = leaves.find((leaf) => leaf.path === "motor.@base0.@base0._vptr.Listener");
    const hidden = { ...vptrLeaf, name: vptrLeaf.path };
    const internal = normalizeWatchList([{ name: "motor.callback._M_invoker" }], result.symbols)[0];
    assert.strictEqual(internal.name, "motor.callback._M_invoker", "saved raw internal paths stay intact");
    assert.strictEqual(internal.isPointer, true);
    assert.strictEqual(internal.pointerTarget, "function");
    assert.strictEqual(hidden.isPointer, true);
    assert.strictEqual(hidden.memberRole, "artificial");
    assert.strictEqual(
        service.decodeConsumerSamples(
            [{ name: hidden.name, bytes: bytes(vtable.address + 8) }],
            20,
            new Map([[hidden.name, hidden]])
        ).scalarSamples[0].pointerText,
        "→ MotorController"
    );

    const historyItems = buildChartHistoryItems([{ ...motor, isComposite: true, runtimeLayout: null }], elf);
    const recorded = service.decodeHistorySamples([{ name: "motor", bytes: motorBytes }], 20, historyItems);
    assert.strictEqual(recorded.find((sample) => sample.name === "motor.rxBuffer").pointerText, "→ &rxBuf[12]");

    const normalized = normalizeWatchList([{ name: "counterPtr" }, { name: "idleHook" }], result.symbols);
    assert.ok(normalized.every((item) => item.isPointer));
    assert.strictEqual(normalized[0].pointerTarget, "data");
    assert.strictEqual(normalized[1].pointerTarget, "function");
    const types = new Map(normalized.map((item) => [item.name, item]));
    const scalarSamples = service.decodeConsumerSamples(
        [
            { name: "counterPtr", bytes: bytes(rxBuf.address + 12) },
            { name: "idleHook", bytes: bytes(handler.address + 1) }
        ],
        21,
        types
    ).scalarSamples;
    assert.strictEqual(scalarSamples[0].value, rxBuf.address + 12);
    assert.strictEqual(scalarSamples[0].valueText, formatPointer(rxBuf.address + 12));
    assert.strictEqual(scalarSamples[0].pointerText, "→ &rxBuf[12]");
    assert.strictEqual(scalarSamples[1].value, handler.address + 1);
    assert.strictEqual(scalarSamples[1].valueText, formatPointer(handler.address + 1));
    assert.strictEqual(scalarSamples[1].pointerText, "→ clickHandler");

    const provider = Object.create(loadProvider().prototype);
    provider._scalarWatchList = (key) => (key === "mcu.sidebarWatchList" ? normalized.slice(0, 1) : normalized);
    provider._context = { workspaceState: { get: () => [{ name: "idleHook", type: "u32" }] } };
    provider._livePanels = new Map([[1, { watchKey: "graph" }]]);
    provider._elfService = { read: () => filtered };
    provider._liveWatchService = service;
    const consumers = provider._consumerTypes();
    assert.strictEqual(consumers.graphs.get("graph").get("counterPtr").isPointer, true);
    assert.strictEqual(consumers.sidebar.get("counterPtr").pointerTarget, "data");
    assert.strictEqual(
        consumers.sidebar.get("idleHook").pointerTarget,
        "function",
        "write-list sampling retains pointer metadata"
    );
    assert.strictEqual(provider.readElfSymbols(), filtered);
    assert.strictEqual(
        service.decodeConsumerSamples([{ name: "idleHook", bytes: bytes(handler.address + 1) }], 22, consumers.sidebar)
            .scalarSamples[0].pointerText,
        "→ clickHandler"
    );
}

console.log("Pointer symbolization tests passed");
