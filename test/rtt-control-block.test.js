"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const {
    CHANNEL_ENCODINGS,
    CHANNEL_FORMATS,
    AUTO_SCAN_MAX_BYTES,
    MIN_CONTROL_BLOCK_SIZE,
    SCAN_SLICE_BYTES,
    commands,
    normalizeRttSettings,
    parseChannelList,
    resolveControlBlock,
    scanSlices
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

scenario("mixed channel settings are frozen, preserve firmware modes and reject ambiguous selections", () => {
    const input = { channels: [0, { index: 1, mode: "trim" }], pollingIntervalMs: 0 };
    const result = normalizeRttSettings(input);
    const defaults = { format: "text", encoding: "utf-8" };
    assert.deepStrictEqual(result.channels, [
        { index: 0, ...defaults, down: 0 },
        { index: 1, mode: "trim", ...defaults, down: 1 }
    ]);
    assert.strictEqual(result.pollingIntervalMs, 100);
    assert.strictEqual(result.configuredPollingIntervalMs, 0);
    input.channels[1].mode = "block";
    assert.strictEqual(result.channels[1].mode, "trim");
    assert.ok(Object.isFrozen(result.channels[1]));
    assert.strictEqual(normalizeRttSettings().pollingIntervalMs, 10);
    for (const channels of [
        [],
        [1, { index: 1 }],
        [{ index: 0, mode: "unknown" }],
        [{ index: 0, address: 0 }],
        [null],
        [256]
    ])
        assert.throws(() => normalizeRttSettings({ channels }), code("RTT_INVALID_CHANNELS"));
    for (const pollingIntervalMs of [-1, 60001, 1.5, "10"])
        assert.throws(() => normalizeRttSettings({ pollingIntervalMs }), code("RTT_INVALID_INTERVAL"));
});

scenario("channels take a format, an encoding and a down channel, and bad values are refused", () => {
    const { channels, encoding } = normalizeRttSettings({
        encoding: "gbk",
        channels: [0, { index: 1, format: "hex", encoding: "latin1", down: 3 }]
    });
    assert.strictEqual(encoding, "gbk");
    assert.deepStrictEqual(channels, [
        { index: 0, format: "text", encoding: "gbk", down: 0 },
        { index: 1, format: "hex", encoding: "latin1", down: 3 }
    ]);
    for (const settings of [
        { encoding: "koi8-r" },
        { channels: [{ index: 0, format: "json" }] },
        { channels: [{ index: 0, encoding: "utf-16" }] },
        { channels: [{ index: 0, down: 256 }] },
        { channels: [{ index: 0, input: true }] }
    ])
        assert.throws(() => normalizeRttSettings(settings), { code: "RTT_INVALID_CHANNELS" });
});

scenario("the channels schema offers exactly the validated formats and encodings", () => {
    const { contributes } = require("../package.json");
    const { properties } = contributes.configuration.find((entry) => entry.id === "emberprobe.rtt");
    const fields = properties["emberprobe.rtt.channels"].items.oneOf[1].properties;
    assert.deepStrictEqual(fields.format.enum, CHANNEL_FORMATS);
    assert.deepStrictEqual(fields.encoding.enum, CHANNEL_ENCODINGS);
    assert.deepStrictEqual(properties["emberprobe.rtt.encoding"].enum, CHANNEL_ENCODINGS);
});

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
        exact: false,
        more: [{ address: 0x38000000, size: 0x8000 }]
    });
    // Without .bss the largest writable span is taken
    const noBss = sections.filter((s) => !s.name.startsWith(".bss") && !s.name.startsWith(".data"));
    assert.strictEqual(resolveControlBlock({ sections: noBss }).address, 0x38000000);
});

scenario("a control block in its own RAM section is reached after the .bss span", () => {
    // H750_RttTest's axi profiles without the symbol: .bss in DTCM, .rtt_cb in AXI SRAM.
    const block = resolveControlBlock({
        sections: [
            { name: ".bss", addr: 0x20000064, size: 0x248, flags: 0x3 },
            { name: ".rtt_cb", addr: 0x24000000, size: 0x5128, flags: 0x3 }
        ]
    });
    assert.deepStrictEqual(
        scanSlices(block).map((slice) => [slice.address, slice.size]),
        [
            [0x20000064, 0x248],
            [0x24000000, 0x5128]
        ]
    );
    assert.ok(scanSlices(block).every((slice) => !("more" in slice) && slice.source === "sections"));
});

scenario("later section spans join the scan only within the automatic limit", () => {
    const span = (name, addr, size) => ({ name, addr, size, flags: 0x3 });
    const block = resolveControlBlock({
        sections: [
            span(".bss", 0x20000000, 0x1000),
            span(".big", 0x24000000, AUTO_SCAN_MAX_BYTES),
            span(".small", 0x30000000, 0x1000)
        ]
    });
    assert.strictEqual(block.address, 0x20000000);
    assert.deepStrictEqual(block.more, [{ address: 0x30000000, size: 0x1000 }], "the oversized span is left out");
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
    assert.strictEqual(commands.channels(), "rtt channels");
    assert.strictEqual(commands.serverStart(50123, 1), "rtt server start 50123 1");
    assert.strictEqual(commands.serverStop(50123), "rtt server stop 50123");
    assert.throws(() => commands.setup({ address: 0x20000400, size: 8 }), code("RTT_INVALID_RANGE"));
    assert.throws(() => commands.setup({ address: "0x20000400", size: 168 }), code("RTT_INVALID_ADDRESS"));
    assert.throws(() => commands.serverStart(0, 0), code("RTT_INVALID_PORT"));
    assert.throws(() => commands.serverStart(50123, 256), code("RTT_INVALID_CHANNEL"));
    assert.throws(() => commands.serverStart(50123, "0; shutdown"), code("RTT_INVALID_CHANNEL"));
    assert.throws(() => commands.pollingInterval(0), code("RTT_INVALID_INTERVAL"));
});

scenario("the OpenOCD channel listing keeps the real channel numbers", () => {
    // Bundled OpenOCD output: channel 1 is unconfigured (size 0), so OpenOCD omits it and the numbers have a gap.
    const parsed = parseChannelList(
        "Channels: up=3, down=1\nUp-channels:\n0: Terminal 1024 2\n2: Log 512 1\nDown-channels:\n0: Terminal 16 0\n"
    );
    assert.deepStrictEqual(parsed.up, [
        { index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" },
        { index: 2, name: "Log", size: 512, flags: 1, mode: "trim" }
    ]);
    assert.deepStrictEqual(parsed.down, [{ index: 0, name: "Terminal", size: 16, flags: 0, mode: "skip" }]);
});

scenario("channel names come from the firmware and may be empty or contain spaces", () => {
    const parsed = parseChannelList("Up-channels:\r\n0:  64 0\r\n1: Log Out 2 128 0\r\nDown-channels:\r\n");
    assert.deepStrictEqual(
        parsed.up.map((channel) => [channel.index, channel.name, channel.size]),
        [
            [0, "", 64],
            [1, "Log Out 2", 128]
        ]
    );
    assert.deepStrictEqual(parseChannelList("Channels: up=0, down=0\nUp-channels:\nDown-channels:\n"), {
        up: [],
        down: []
    });
});

scenario("an unexpected channel listing is a parse error", () => {
    assert.throws(() => parseChannelList(""), code("RTT_PARSE_ERROR"));
    assert.throws(() => parseChannelList("{\n}\n{\n}\n"), code("RTT_PARSE_ERROR"));
});

scenario("unconfigured channels holding random values are left out of the list", () => {
    const list = parseChannelList(
        "Channels: up=3, down=3\nUp-channels:\n0: Terminal 4096 0\n1: Stream 16384 2\n2:  3039476351 983066642\n" +
            "Down-channels:\n0: Terminal 64 0\n1: StreamIn 64 0"
    );
    assert.deepStrictEqual(
        list.up.map((channel) => channel.name),
        ["Terminal", "Stream"]
    );
    assert.strictEqual(list.down.length, 2);
    assert.strictEqual(parseChannelList("Up-channels:\n0: Small 64 983066642\n").up.length, 0);
});

scenario("scan ranges are searched in overlapping slices that cover the range", () => {
    const exact = { source: "symbol", address: 0x20000000, size: 168, exact: true };
    assert.deepStrictEqual(scanSlices(exact), [exact]);
    const small = { source: "sections", address: 0x20000000, size: SCAN_SLICE_BYTES, exact: false };
    assert.deepStrictEqual(scanSlices(small), [small]);
    const large = { source: "region", address: 0x20000000, size: AUTO_SCAN_MAX_BYTES, exact: false };
    const slices = scanSlices(large);
    assert.strictEqual(slices.length, Math.ceil(AUTO_SCAN_MAX_BYTES / SCAN_SLICE_BYTES));
    assert.strictEqual(slices[0].address, large.address);
    slices.forEach((slice, index) => {
        assert.ok(slice.size >= 16 && slice.size <= SCAN_SLICE_BYTES + 16, "every slice is a valid bounded range");
        if (index)
            assert.strictEqual(
                slice.address + 16,
                slices[index - 1].address + slices[index - 1].size,
                "neighbours overlap by the control block ID"
            );
    });
    assert.strictEqual(slices.at(-1).address + slices.at(-1).size, large.address + large.size);
});
