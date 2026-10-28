"use strict";

const assert = require("assert");
const { DebugSessionBridge, MAX_PAUSED_ITEM_BYTES } = require("../src/services/debugSessionBridge");
const { MAX_DEBUG_READ_BYTES } = require("../src/liveWatch");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
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

// struct { unsigned head, r0, ..., r39; unsigned char bytes[size - 168]; unsigned tail; }
function runtimeStruct(name, address, size) {
    const registers = Array.from({ length: 40 }, (_, index) => ({ name: "r" + index, type: 0, offset: 4 + index * 4 }));
    return {
        name,
        address,
        size,
        runtimeLayout: {
            root: 3,
            types: [
                { kind: "scalar", typeName: "unsigned int", byteSize: 4, watchType: "u32" },
                { kind: "scalar", typeName: "unsigned char", byteSize: 1, watchType: "u8" },
                { kind: "array", typeName: "unsigned char[]", target: 1, count: size - 168, byteSize: size - 168 },
                {
                    kind: "class",
                    typeName: "lab::SuperVariable",
                    byteSize: size,
                    fields: [
                        { name: "head", type: 0, offset: 0 },
                        ...registers,
                        { name: "bytes", type: 2, offset: 164 },
                        { name: "tail", type: 0, offset: size - 4 }
                    ]
                }
            ]
        },
        runtimeRanges: [{ start: BASE, end: BASE + 0x20000 }]
    };
}

// struct { struct { unsigned v0, v1; unsigned char pad[56]; } g0..g13; unsigned *p0..p15; }
// (1024 bytes, like lab::SuperVariable), viewed with every group open.
function groupedStruct(name, address) {
    const group = {
        kind: "class",
        typeName: "Group",
        byteSize: 64,
        fields: [
            { name: "v0", type: 0, offset: 0 },
            { name: "v1", type: 0, offset: 4 },
            { name: "pad", type: 4, offset: 8 }
        ]
    };
    return {
        name,
        address,
        size: 1024,
        runtimeExpanded: ["", ...Array.from({ length: 14 }, (_, index) => ".g" + index)],
        runtimeLayout: {
            root: 3,
            types: [
                { kind: "scalar", typeName: "unsigned int", byteSize: 4, watchType: "u32" },
                group,
                { kind: "pointer", typeName: "unsigned int *", target: 0, byteSize: 4 },
                {
                    kind: "class",
                    typeName: "Grouped",
                    byteSize: 1024,
                    fields: [
                        ...Array.from({ length: 14 }, (_, index) => ({
                            name: "g" + index,
                            type: 1,
                            offset: index * 64
                        })),
                        ...Array.from({ length: 16 }, (_, index) => ({
                            name: "p" + index,
                            type: 2,
                            offset: 896 + index * 4
                        }))
                    ]
                },
                { kind: "array", typeName: "unsigned char[56]", target: 5, count: 56, byteSize: 56 },
                { kind: "scalar", typeName: "unsigned char", byteSize: 1, watchType: "u8" }
            ]
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
        // A paused runtime object over 4096 bytes is prefetched whole in DAP blocks; members come from the cache.
        const { bridge, requests } = pausedBridge(ram);
        const [sample] = await bridge.read([runtimeStruct("super", BASE, 9000)]);
        assert.strictEqual(sample.diagnostic, undefined);
        assert.deepStrictEqual(requests, [4096, 4096, 808]);
        const members = new Map(sample.runtimeTree.members.map((member) => [member.name, member]));
        assert.strictEqual(members.get("head").value, ram.readUInt32LE(0));
        assert.strictEqual(members.get("r39").value, ram.readUInt32LE(160));
        assert.strictEqual(members.get("tail").value, ram.readUInt32LE(8996));
        // The display limits, not the read budget, decide how much of the array is shown: its first 100
        // elements fit the 256-node budget, each node counted once.
        assert.strictEqual(members.get("bytes").elements.length, 100);
        assert.strictEqual(members.get("bytes").partial, true);
        assert.strictEqual(members.get("bytes").elements[99].value, ram[164 + 99]);
        bridge.dispose();
    }

    {
        // Each paused runtime object has its own limit, so two 40 KiB objects are both read.
        const { bridge, requests } = pausedBridge(ram);
        const samples = await bridge.read([
            runtimeStruct("first", BASE, 0xa000),
            runtimeStruct("second", BASE + 0xa000, 0xa000)
        ]);
        assert.deepStrictEqual(
            samples.map((sample) => [sample.name, sample.diagnostic]),
            [
                ["first", undefined],
                ["second", undefined]
            ]
        );
        assert.strictEqual(requests.length, 20);
        assert(requests.every((count) => count === 4096));
        bridge.dispose();
    }

    {
        // Running sampling keeps the per-cycle budget: members it reaches show values, the rest are
        // marked as past the budget (scalars keep their rows), and the object as a whole still samples.
        const item = runtimeStruct("super", BASE, 9000);
        const read = async (address, size) => ram.subarray(address - BASE, address - BASE + size);
        const deadline = Date.now() + 1000;
        const unread = (tree) =>
            tree.members.filter((member) => member.unavailableCode === "LIVE_READ_BUDGET_EXCEEDED").map((m) => m.name);
        const registers = (from, to) => Array.from({ length: to - from }, (_, index) => "r" + (from + index));
        const running = { bytes: 0, commands: 0, deadline };
        const partial = await new RuntimeObjectReader(item, read, () => {}, running).sample();
        assert.deepStrictEqual(unread(partial), [...registers(31, 40), "bytes", "tail"]);
        assert.strictEqual(partial.members.find((member) => member.name === "r30").kind, "scalar");
        const r31 = partial.members.find((member) => member.name === "r31");
        assert.deepStrictEqual(
            [r31.kind, r31.type, r31.value],
            ["scalar", "u32", null],
            "an unread scalar keeps its row without a value"
        );
        assert.strictEqual(partial.members.find((member) => member.name === "bytes").kind, "class");
        assert.strictEqual(running.commands, 32);
        // A frozen reader stops at its own limit and skips a prefetch that would not fit.
        const sizes = [];
        const frozen = await new RuntimeObjectReader(
            item,
            (address, size) => (sizes.push(size), read(address, size)),
            () => {},
            { bytes: 0, commands: 0, deadline, maxBytes: 64, maxReads: 256 },
            { frozen: true }
        ).sample();
        assert.deepStrictEqual(unread(frozen), [...registers(15, 40), "bytes", "tail"]);
        assert(
            sizes.every((size) => size <= 4),
            "no oversized prefetch was attempted"
        );
        // A root the budget cannot reach still fails as a whole.
        await assert.rejects(
            new RuntimeObjectReader(item, read, () => {}, { bytes: 0, commands: 32, deadline }).sample(),
            { code: "LIVE_READ_BUDGET_EXCEEDED", message: "Runtime object exceeds 4096 bytes / 32 reads per cycle" }
        );
    }

    {
        // A 1 KiB running object with every group open: one read replaces one per group, and its 16
        // pointer words are verified in one read instead of 16, so the cycle stays within 32 reads.
        const item = groupedStruct("grouped", BASE);
        const sizes = [];
        const read = async (address, size) => (sizes.push(size), ram.subarray(address - BASE, address - BASE + size));
        const budget = { bytes: 0, commands: 0, deadline: Date.now() + 1000 };
        const tree = await new RuntimeObjectReader(item, read, () => {}, budget).sample();
        assert.deepStrictEqual(sizes, [1024, 64]);
        assert.deepStrictEqual(budget, { ...budget, bytes: 1088, commands: 2 });
        const members = new Map(tree.members.map((member) => [member.name, member]));
        assert.strictEqual(members.get("g13").members[1].value, ram.readUInt32LE(13 * 64 + 4));
        assert.strictEqual(members.get("p15").value, ram.readUInt32LE(956));
        // With only a few groups open each is still read on its own.
        sizes.length = 0;
        await new RuntimeObjectReader({ ...item, runtimeExpanded: ["", ".g0"] }, read, () => {}, {
            bytes: 0,
            commands: 0,
            deadline: Date.now() + 1000
        }).sample();
        assert.deepStrictEqual(sizes, [...Array(16).fill(4), 64, 64]);
    }

    {
        // A pointer word that changes between its read and the verification read withholds only that
        // pointer; the merged verification read still compares each word on its own.
        const item = groupedStruct("grouped", BASE);
        const copy = Buffer.from(ram.subarray(0, 1024));
        let reads = 0;
        const read = async (address, size) => {
            if (++reads === 2) copy.writeUInt32LE((copy.readUInt32LE(900) ^ 1) >>> 0, 900);
            return copy.subarray(address - BASE, address - BASE + size);
        };
        const tree = await new RuntimeObjectReader(item, read, () => {}, {
            bytes: 0,
            commands: 0,
            deadline: Date.now() + 1000
        }).sample();
        const members = new Map(tree.members.map((member) => [member.name, member]));
        assert.strictEqual(members.get("p1").unavailableCode, "LIVE_OBJECT_CHANGED");
        assert.strictEqual(members.get("p1").unavailable, "changing");
        assert.strictEqual(members.get("p0").value, ram.readUInt32LE(896));
        assert.strictEqual(members.get("p2").value, ram.readUInt32LE(904));
        assert.strictEqual(members.get("g0").members[0].value, ram.readUInt32LE(0));
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
