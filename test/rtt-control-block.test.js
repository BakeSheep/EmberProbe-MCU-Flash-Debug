"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const {
    AUTO_SCAN_MAX_BYTES,
    MIN_CONTROL_BLOCK_SIZE,
    commands,
    parseChannelList,
    parseRttListening,
    resolveControlBlock,
    splitTclList
} = require("../src/rttControlBlock");

const code = (expected) => (error) => error.code === expected;
const rttSymbol = { name: "_SEGGER_RTT", address: 0x20000400, size: 168 };
const sections = [
    { name: ".text", addr: 0x08000000, size: 0x4000, flags: 0x6 },
    { name: ".data", addr: 0x20000000, size: 0x100, flags: 0x3 },
    { name: ".bss", addr: 0x20000100, size: 0x2000, flags: 0x3 },
    { name: "._user_heap_stack", addr: 0x20002100, size: 0x600, flags: 0x3 },
    { name: ".sram4", addr: 0x38000000, size: 0x8000, flags: 0x3 },
    { name: ".debug_info", addr: 0, size: 0x9000, flags: 0 }
];

scenario("configured address wins over the ELF symbol", () => {
    assert.deepStrictEqual(
        resolveControlBlock({ settings: { controlBlockAddress: "0x24000000" }, symbols: [rttSymbol] }),
        {
            source: "address",
            address: 0x24000000,
            size: MIN_CONTROL_BLOCK_SIZE,
            exact: true
        }
    );
    assert.strictEqual(resolveControlBlock({ settings: { controlBlockAddress: 4096 } }).address, 4096);
});

scenario("ELF symbol gives the exact control block", () => {
    assert.deepStrictEqual(resolveControlBlock({ symbols: [{ name: "counter", address: 0x20000000 }, rttSymbol] }), {
        source: "symbol",
        address: 0x20000400,
        size: 168,
        exact: true
    });
    // A symbol without st_size still covers the minimal control block
    const block = resolveControlBlock({ symbols: [{ name: "_SEGGER_RTT", address: 0x20000400, size: 0 }] });
    assert.strictEqual(block.size, MIN_CONTROL_BLOCK_SIZE);
});

scenario("symbol names are case-sensitive and duplicates are rejected", () => {
    const block = resolveControlBlock({ symbols: [{ name: "_segger_rtt", address: 0x20000400 }], sections });
    assert.strictEqual(block.source, "sections");
    assert.throws(
        () =>
            resolveControlBlock({
                symbols: [
                    { name: "_SEGGER_RTT", elfName: "_SEGGER_RTT", address: 0x20000400, addressAmbiguous: true },
                    {
                        name: "a.c::_SEGGER_RTT",
                        elfName: "_SEGGER_RTT",
                        address: 0x20000800,
                        displayName: "a.c::_SEGGER_RTT"
                    }
                ]
            }),
        code("RTT_CONTROL_BLOCK_AMBIGUOUS")
    );
});

scenario("search range setting is used without a symbol", () => {
    assert.deepStrictEqual(
        resolveControlBlock({ settings: { searchRange: { address: "0x20000000", size: "0x20000" } }, sections }),
        { source: "range", address: 0x20000000, size: 0x20000, exact: false }
    );
    assert.throws(
        () => resolveControlBlock({ settings: { searchRange: { address: "0x20000000", size: 8 } } }),
        code("RTT_INVALID_RANGE")
    );
    assert.throws(
        () => resolveControlBlock({ settings: { searchRange: { address: "0x20000000", size: 0x2000000 } } }),
        code("RTT_SCAN_RANGE_TOO_LARGE")
    );
});

scenario("writable ELF sections next to .bss are scanned as one range", () => {
    assert.deepStrictEqual(resolveControlBlock({ sections }), {
        source: "sections",
        address: 0x20000000,
        size: 0x2700,
        exact: false
    });
    // Without .bss the largest writable span is taken
    const noBss = sections.filter((s) => !s.name.startsWith(".bss") && !s.name.startsWith(".data"));
    assert.strictEqual(resolveControlBlock({ sections: noBss }).address, 0x38000000);
});

scenario("linker RAM region is the last fallback and the automatic scan is bounded", () => {
    const regions = [
        { name: "FLASH", origin: 0x08000000, capacity: 0x20000, type: "flash" },
        { name: "RAM", origin: 0x20000000, capacity: 0x5000, type: "ram" }
    ];
    assert.deepStrictEqual(resolveControlBlock({ regions }), {
        source: "region",
        address: 0x20000000,
        size: 0x5000,
        exact: false
    });
    const huge = [{ name: "SDRAM", origin: 0xc0000000, capacity: AUTO_SCAN_MAX_BYTES * 8, type: "ram" }];
    assert.throws(() => resolveControlBlock({ regions: huge }), code("RTT_SCAN_RANGE_TOO_LARGE"));
    assert.throws(() => resolveControlBlock({}), code("RTT_CONTROL_BLOCK_UNKNOWN"));
});

scenario("invalid addresses are rejected", () => {
    for (const value of ["0x100000000", "-1", "20000000h", "0x", 1.5, "0x2000 0000"])
        assert.throws(
            () => resolveControlBlock({ settings: { controlBlockAddress: value } }),
            code("RTT_INVALID_ADDRESS")
        );
    assert.throws(
        () => resolveControlBlock({ settings: { controlBlockAddress: "0xFFFFFFF0" } }),
        code("RTT_INVALID_ADDRESS")
    );
    // Empty settings mean "not configured"
    assert.strictEqual(
        resolveControlBlock({ settings: { controlBlockAddress: "" }, symbols: [rttSymbol] }).source,
        "symbol"
    );
});

scenario("OpenOCD commands are built from validated values", () => {
    assert.strictEqual(commands.setup({ address: 0x20000400, size: 168 }), 'rtt setup 0x20000400 168 "SEGGER RTT"');
    assert.strictEqual(commands.start(), "rtt start");
    assert.strictEqual(commands.stop(), "rtt stop");
    assert.strictEqual(commands.pollingInterval(10), "rtt polling_interval 10");
    assert.strictEqual(commands.channelList(), "rtt channellist");
    assert.strictEqual(commands.serverStart(50123, 1), "rtt server start 50123 1");
    assert.strictEqual(commands.serverStop(50123), "rtt server stop 50123");
    assert.throws(() => commands.setup({ address: 0x20000400, size: 8 }), code("RTT_INVALID_RANGE"));
    assert.throws(() => commands.setup({ address: "0x20000400", size: 168 }), code("RTT_INVALID_ADDRESS"));
    assert.throws(() => commands.serverStart(0, 0), code("RTT_INVALID_PORT"));
    assert.throws(() => commands.serverStart(50123, 256), code("RTT_INVALID_CHANNEL"));
    assert.throws(() => commands.serverStart(50123, "0; shutdown"), code("RTT_INVALID_CHANNEL"));
    assert.throws(() => commands.pollingInterval(0), code("RTT_INVALID_INTERVAL"));
});

scenario("Tcl list splitting handles braces, quotes and escapes", () => {
    assert.deepStrictEqual(splitTclList('a {b {c d}} "e \\"f\\"" {}'), ["a", "b {c d}", 'e "f"', ""]);
    assert.throws(() => splitTclList("{a"), code("RTT_PARSE_ERROR"));
    assert.throws(() => splitTclList('"a'), code("RTT_PARSE_ERROR"));
});

scenario("rtt channellist result is parsed into up and down channels", () => {
    const parsed = parseChannelList(
        "up {{name Terminal size 1024 flags 2} {name {} size 0 flags 0} {name Log size 512 flags 1}} " +
            "down {{name Terminal size 16 flags 0}}"
    );
    assert.deepStrictEqual(parsed.up, [
        { index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" },
        { index: 1, name: "", size: 0, flags: 0, mode: "skip" },
        { index: 2, name: "Log", size: 512, flags: 1, mode: "trim" }
    ]);
    assert.deepStrictEqual(parsed.down, [{ index: 0, name: "Terminal", size: 16, flags: 0, mode: "skip" }]);
    assert.deepStrictEqual(parseChannelList(""), { up: [], down: [] });
    // Unknown keys from newer OpenOCD are ignored
    assert.strictEqual(parseChannelList("up {{name A size 8 flags 0 extra x}} down {}").up[0].name, "A");
});

scenario("RTT server listening lines give the port", () => {
    assert.strictEqual(parseRttListening("Info : Listening on port 50123 for rtt connections"), 50123);
    assert.strictEqual(parseRttListening("Info : Listening on port 6666 for tcl connections"), null);
    assert.strictEqual(parseRttListening(undefined), null);
});
