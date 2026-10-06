"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { loadProvider } = require("./helpers/load-provider");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { runtimeWatchEntry } = require("../src/services/runtimeWatch");
const { normalizeWatchList } = require("../src/validation");

(async () => {
    const runtimeItem = {
        name: "values",
        address: 0x20000000,
        size: 12,
        isComposite: true,
        typeName: "std::vector<int>",
        compositeLayout: {
            kind: "class",
            members: [{ name: "staticField", offset: 0, byteSize: 4, watchType: "u32" }]
        },
        runtimeLayout: { root: 1, types: [] }
    };
    const runtimeSample = {
        name: "values",
        tree: { members: [{ name: "value", value: 42, type: "i32" }] }
    };

    const sidebar = render(getModernWebviewContent({}, "en"));
    try {
        sidebar.send({ type: "sidebarWatchList", items: [runtimeItem] });
        sidebar.send({ type: "liveCompositeSample", samples: [runtimeSample] });
        const cell = sidebar.document.querySelector('.sb-mname[title="values.value"]');
        assert.ok(cell, "sidebar should render runtime members when a static layout is also present");
        assert.strictEqual(cell.parentElement.querySelector(".sb-mval").textContent, "42");
        assert.strictEqual(sidebar.document.querySelector('.sb-mname[title="values.staticField"]'), null);
        sidebar.assertHealthy();
    } finally {
        sidebar.close();
    }

    const graph = render(getLiveWatchContent({ panelId: 1 }, "en"));
    try {
        graph.send({ type: "watchList", items: [runtimeItem] });
        graph.send({ type: "liveCompositeSample", samples: [runtimeSample] });
        const cell = graph.document.querySelector('.member-name[title="values.value"]');
        assert.ok(cell, "live watch should render runtime members when a static layout is also present");
        assert.strictEqual(cell.closest(".member-row").querySelector(".member-value").textContent, "42");
        assert.strictEqual(graph.document.querySelector('.member-name[title="values.staticField"]'), null);
        graph.assertHealthy();
    } finally {
        graph.close();
    }

    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    provider._runtimeRamCache = null;
    provider.readElfSymbols = () => {
        throw new Error("No ELF selected");
    };
    const emptyPlan = [];
    const scalarPlan = [{ name: "counter", address: 0x20000000, size: 4, type: "u32" }];
    assert.strictEqual(provider._runtimeReadRanges(emptyPlan), emptyPlan);
    assert.strictEqual(provider._runtimeReadRanges(scalarPlan), scalarPlan);
    assert.throws(
        () => provider._runtimeReadRanges([{ name: "values", runtimeLayout: { root: 1 } }]),
        /No ELF selected/,
        "runtime objects must still require verified ELF memory ranges"
    );
    provider.readElfSymbols = () => ({
        elf: { sha256: "verified-elf", path: "C:\\does-not-exist\\firmware.elf" },
        memory: {
            sections: [{ name: ".data", addr: 0x20000000, size: 0x100, flags: 3 }]
        }
    });
    const ranged = provider._runtimeReadRanges([
        { name: "values", address: 0x20000000, size: 12, runtimeLayout: { root: 1 } }
    ]);
    assert.deepStrictEqual(ranged[0].runtimeRanges, [{ start: 0x20000000, end: 0x20000100 }]);

    const pointerMemory = Buffer.alloc(8);
    pointerMemory.writeUInt32LE(0x40000000, 0);
    pointerMemory.writeInt32LE(7, 4);
    const pointerGraph = {
        root: 2,
        types: [
            { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
            { kind: "pointer", typeName: "Driver", byteSize: 4, target: 0 },
            {
                kind: "class",
                typeName: "Ina226",
                byteSize: 8,
                fields: [
                    { name: "driver", type: 1, offset: 0 },
                    { name: "reading", type: 0, offset: 4 }
                ]
            }
        ]
    };
    const pointerTree = await new RuntimeObjectReader(
        {
            name: "pwr",
            address: 0x20000000,
            size: 8,
            runtimeLayout: pointerGraph,
            runtimeRanges: [{ start: 0x20000000, end: 0x20000008 }]
        },
        async (address, size) => pointerMemory.subarray(address - 0x20000000, address - 0x20000000 + size)
    ).sample();
    assert.strictEqual(pointerTree.members[0].valueText, "0x40000000");
    assert.strictEqual(pointerTree.members[0].value, 0x40000000);
    assert.strictEqual(pointerTree.members[1].value, 7);

    const pointerSymbol = {
        name: "pwr",
        address: 0x20000000,
        size: 8,
        isComposite: true,
        compositeLayout: {
            kind: "class",
            members: [
                { name: "driver", offset: 0, byteSize: 4, watchType: "u32" },
                { name: "reading", offset: 4, byteSize: 4, watchType: "i32" }
            ]
        },
        runtimeLayout: pointerGraph
    };
    assert.strictEqual(runtimeWatchEntry("pwr", pointerSymbol), null);
    const staticItems = normalizeWatchList([{ name: "pwr" }], [pointerSymbol]);
    assert.strictEqual(staticItems.length, 1);
    assert.ok(staticItems[0].compositeLayout);
    assert.strictEqual(staticItems[0].runtimeLayout, undefined);

    console.log("Runtime rendering and ELF memory cache regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
