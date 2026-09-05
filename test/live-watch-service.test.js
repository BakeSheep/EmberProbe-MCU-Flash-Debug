"use strict";
const assert = require("assert");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { buildActiveReadPlan } = require("../src/services/liveWatchService");
const { nextLivePanelId } = require("../src/services/liveWatchService");
const { selectFocusedPanel } = require("../src/services/liveWatchService");
const { selectPausedDebugReadSession } = require("../src/services/liveWatchService");
const { filterRuntimeRamPlan } = require("../src/services/liveWatchService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        const liveService = new LiveWatchService({
            decodeValue: (bytes, type) => `${type}:${bytes[0]}`,
            decodeValueText: (_bytes, type) => (type === "u32" ? "7" : null),
            decodeComposite: () => ({ kind: "struct" }),
            decodeBitfieldValue: () => ({ value: 3, valueText: null })
        });
        const decoded = liveService.decodeConsumerSamples(
            [
                { name: "counter", bytes: [7] },
                { name: "sensor", bytes: [1, 2] }
            ],
            123,
            new Map([["counter", "u32"]]),
            new Map([["sensor", { layout: { kind: "struct" } }]]),
            new Map()
        );
        assert.strictEqual(decoded.scalarSamples[0].value, "u32:7");
        assert.strictEqual(decoded.scalarSamples[0].valueText, "7");
        assert.strictEqual(decoded.compositeSamples[0].tree.kind, "struct");
        const perPanelLatest = new Map();
        const perPanel = liveService.decodeConsumerSamples(
            [{ name: "counter", bytes: [9] }],
            456,
            new Map([["counter", "u64"]]),
            new Map(),
            perPanelLatest
        );
        assert.strictEqual(perPanel.scalarSamples[0].value, "u64:9");
        assert.strictEqual(perPanelLatest.get("counter").t, 456);
        const pausedReadCalls = [];
        const pausedDebugBridge = {
            agentStatus: () => ({ state: "paused" }),
            readPausedItems: async (items) => {
                pausedReadCalls.push(items);
                return [{ name: items[0].name, bytes: Uint8Array.from([9]) }];
            }
        };
        const pausedDebugSession = selectPausedDebugReadSession(pausedDebugBridge);
        assert.deepStrictEqual(
            [...(await pausedDebugSession.readOnce([{ name: "counter", address: 0x20000000, size: 1 }]))[0].bytes],
            [9]
        );
        assert.strictEqual(pausedReadCalls.length, 1);
        pausedDebugBridge.agentStatus = () => ({ state: "running" });
        assert.strictEqual(
            selectPausedDebugReadSession(pausedDebugBridge),
            null,
            "running debug targets must never be paused implicitly for Agent reads"
        );
        assert.strictEqual(
            nextLivePanelId(
                new Map([
                    [1, {}],
                    [3, {}]
                ])
            ),
            2,
            "closed panel slots should be reused"
        );
        assert.strictEqual(
            selectFocusedPanel([
                { panelId: 1, focusOrder: 2 },
                { panelId: 2, focusOrder: 8 }
            ]).panelId,
            2
        );
        const mergedPlan = buildActiveReadPlan(
            [
                [{ name: "counter", address: 0x20000000, type: "u16" }],
                [{ name: "counter", address: 0x20000000, type: "u64" }],
                [
                    {
                        name: "sensor",
                        address: 0x20000010,
                        size: 12,
                        isComposite: true,
                        compositeLayout: { kind: "struct" }
                    }
                ]
            ],
            {
                typeByteLength: (type) => (type === "u64" ? 8 : 2),
                expandCompositeLeaves: () => [
                    { address: 0x20000010, size: 4 },
                    { address: 0x20000018, size: 4 }
                ]
            }
        );
        assert.deepStrictEqual(mergedPlan, [
            { name: "counter", address: 0x20000000, size: 8 },
            { name: "sensor", address: 0x20000010, size: 12, isComposite: true }
        ]);
        assert.deepStrictEqual(
            buildActiveReadPlan([[{ name: "counter", address: 0x20000000, type: "u16" }]], {
                typeByteLength: () => 2,
                expandCompositeLeaves: () => []
            }),
            [{ name: "counter", address: 0x20000000, size: 2 }],
            "closing the wider consumer should immediately shrink the merged plan"
        );
        const runtimeRam = filterRuntimeRamPlan(
            [
                { name: "data", address: 0x20000000, size: 4 },
                { name: "boundary", address: 0x2000000c, size: 4 },
                { name: "cross", address: 0x2000000e, size: 4 },
                { name: "flash", address: 0x08000000, size: 4 },
                { name: "overflow", address: 0xffffffff, size: 2 }
            ],
            [
                { name: ".data", addr: 0x20000000, size: 0x10, flags: 3 },
                { name: ".text", addr: 0x08000000, size: 0x100, flags: 2 }
            ]
        );
        assert.deepStrictEqual(
            runtimeRam.allowed.map((item) => item.name),
            ["data", "boundary"]
        );
        assert.deepStrictEqual(
            runtimeRam.denied.map((item) => item.name),
            ["cross", "flash", "overflow"]
        );
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
