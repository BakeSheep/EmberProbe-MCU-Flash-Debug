"use strict";

const assert = require("assert");
const { DebugSessionBridge, MAX_PAUSED_ITEM_BYTES } = require("../src/services/debugSessionBridge");
const { MAX_DEBUG_READ_BYTES } = require("../src/liveWatch");
const { loadProvider } = require("./helpers/load-provider");

const BASE = 0x20000000;

function runtimeItem(name, address) {
    return {
        name,
        address,
        size: 4,
        runtimeLayout: {
            root: 0,
            types: [{ kind: "scalar", typeName: "unsigned int", byteSize: 4, watchType: "u32" }]
        },
        runtimeRanges: [{ start: BASE, end: BASE + 0x20000 }]
    };
}

function pausedBridge(ram, onRead = () => {}) {
    const requests = [];
    const session = {
        id: "paused",
        type: "emberprobe",
        async customRequest(command, args) {
            assert.strictEqual(command, "readMemory");
            requests.push(args.count);
            onRead(requests.length);
            const offset = Number(args.memoryReference) - BASE;
            return { data: ram.subarray(offset, offset + args.count).toString("base64") };
        }
    };
    const bridge = new DebugSessionBridge();
    bridge.sessions.set(session.id, session);
    Object.assign(bridge, { intentEnabled: true, paused: true, snapshotReady: true });
    bridge.capabilities = { read: true, write: false };
    return { bridge, session, requests };
}

(async () => {
    const ram = Buffer.alloc(0x14000);
    for (let index = 0; index < ram.length; index++) ram[index] = (index * 7) & 0xff;

    {
        // A struct larger than one DAP block is read as consecutive blocks of the frozen target.
        const { bridge, requests } = pausedBridge(ram);
        const big = { name: "big", address: BASE, size: 9000 };
        const tail = { name: "tail", address: BASE + 9000, size: 4 };
        const samples = await bridge.read([big, tail]);
        assert.ok(
            requests.every((count) => count <= MAX_DEBUG_READ_BYTES),
            "every DAP request stays within 4096 bytes"
        );
        assert.deepStrictEqual(requests, [4096, 4096, 812]);
        const byName = new Map(samples.map((sample) => [sample.name, sample]));
        assert.deepStrictEqual(Buffer.from(byName.get("big").bytes), ram.subarray(0, 9000));
        assert.deepStrictEqual(Buffer.from(byName.get("tail").bytes), ram.subarray(9000, 9004));
        bridge.dispose();
    }

    {
        // An object over the paused limit is reported on its own; the rest of the snapshot is read.
        const { bridge, requests } = pausedBridge(ram);
        const huge = { name: "huge", address: BASE, size: MAX_PAUSED_ITEM_BYTES + 1 };
        const word = { name: "word", address: BASE + 0x12000, size: 4 };
        const samples = await bridge.read([huge, word]);
        assert.deepStrictEqual(requests, [4]);
        const byName = new Map(samples.map((sample) => [sample.name, sample]));
        assert.strictEqual(byName.get("huge").bytes, null);
        assert.strictEqual(byName.get("huge").diagnostic.code, "LIVE_READ_BUDGET_EXCEEDED");
        assert.deepStrictEqual(Buffer.from(byName.get("word").bytes), ram.subarray(0x12000, 0x12004));
        bridge.dispose();
    }

    {
        // A target change between blocks cancels the snapshot instead of mixing two stops.
        let bridgeRef;
        const { bridge, requests } = pausedBridge(ram, (count) => {
            if (count === 1) bridgeRef.epoch++;
        });
        bridgeRef = bridge;
        await assert.rejects(bridge.read([{ name: "big", address: BASE, size: 9000 }], undefined, bridge.epoch), {
            code: "DEBUG_STATE_CHANGED"
        });
        assert.strictEqual(requests.length, 1, "no further block is read after the change");
        bridge.dispose();
    }

    {
        // Fixed reads have no snapshot budget, so they must not exhaust the runtime objects' budget.
        const { bridge } = pausedBridge(ram);
        const samples = await bridge.read([
            { name: "big", address: BASE, size: 5000 },
            runtimeItem("runtime", BASE + 0x10000)
        ]);
        const runtime = samples.find((sample) => sample.name === "runtime");
        assert.strictEqual(runtime.diagnostic, undefined);
        assert.strictEqual(runtime.runtimeTree.value, ram.readUInt32LE(0x10000));
        bridge.dispose();
    }

    {
        // Running debug sampling drops only the oversized item and keeps the others.
        const Provider = loadProvider();
        const host = Object.create(Provider.prototype);
        const applied = [];
        const raw = [];
        const posts = [];
        const big = { name: "big", address: BASE, size: 5000 };
        const word = { name: "word", address: BASE + 0x10000, size: 4 };
        let plan = [big, word];
        Object.assign(host, {
            _managedDebugServer: { capabilities: {} },
            _runtimeDeniedKey: "",
            _runtimeOverBudgetKey: "",
            _runtimeRamCache: null,
            readElfSymbols: () => ({
                elf: { sha256: "elf" },
                memory: { sections: [{ name: ".bss", addr: BASE, size: 0x20000, flags: 3 }] }
            }),
            _activeReadPlan: () => plan,
            _applySamplingPlan: (server, items) => applied.push(items),
            _handleRawSamples: (samples) => raw.push(...samples),
            _postLive: (message) => posts.push(message)
        });
        assert.deepStrictEqual(host._configureManagedRuntimeWatch(), [word]);
        assert.deepStrictEqual(applied, [[word]]);
        assert.deepStrictEqual(
            raw.map((sample) => [sample.name, sample.bytes, sample.diagnostic.code]),
            [["big", null, "LIVE_READ_BUDGET_EXCEEDED"]]
        );
        assert.deepStrictEqual(posts, [
            { type: "liveError", key: "live.runtimeBudgetExceededNames", params: { names: "big" } }
        ]);

        host._configureManagedRuntimeWatch();
        assert.strictEqual(raw.length, 2, "rejected items are marked again after a paused snapshot");
        assert.strictEqual(posts.length, 1, "the notice is not repeated for the same rejected set");

        plan = [big];
        assert.throws(() => host._configureManagedRuntimeWatch(), { code: "LIVE_READ_BUDGET_EXCEEDED" });
        assert.strictEqual(raw.at(-1).name, "big", "the item is marked even when nothing can be sampled");
        assert.strictEqual(applied.length, 2, "an empty plan is not applied when every item was rejected");

        plan = [word];
        host._configureManagedRuntimeWatch();
        assert.strictEqual(host._runtimeOverBudgetKey, "");

        // Explicit Agent reads and writes still require the whole request to fit.
        assert.throws(() => host._runtimeRamPlan([big, word], true), { code: "LIVE_READ_BUDGET_EXCEEDED" });

        const namedBig = { ...big, name: "_ZN3lab5largeE" };
        const denied = { name: "_ZN3lab6deviceE.value", address: BASE - 4, size: 4 };
        const readElfSymbols = host.readElfSymbols;
        host.readElfSymbols = () => ({
            ...readElfSymbols(),
            symbols: [
                { name: namedBig.name, displayName: "lab::large" },
                { name: "_ZN3lab6deviceE", displayName: "lab::device" }
            ]
        });
        plan = [namedBig, denied, word];
        host._configureManagedRuntimeWatch();
        assert.deepStrictEqual(posts.slice(-2), [
            { type: "liveError", key: "live.runtimeAddressRejectedNames", params: { names: "lab::device.value" } },
            { type: "liveError", key: "live.runtimeBudgetExceededNames", params: { names: "lab::large" } }
        ]);
        assert.strictEqual(raw.at(-1).name, namedBig.name, "sample identities remain unchanged");
    }

    console.log("Large object read budget tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
