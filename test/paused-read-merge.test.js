"use strict";
const assert = require("assert");
const {
    DebugSessionBridge,
    mergeReadPlan,
    MAX_PAUSED_GAP_BYTES,
    MAX_PAUSED_PARALLEL_READS
} = require("../src/services/debugSessionBridge");

const BASE = 0x20000000;
const RAM = [{ start: BASE, end: BASE + 0x10000 }];
const item = (name, address, size = 4) => ({ name, address, size });

function pausedBridge(ram, options = {}) {
    const requests = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const session = {
        id: "paused",
        type: "emberprobe",
        async customRequest(command, args) {
            assert.strictEqual(command, "readMemory");
            requests.push({ address: Number(args.memoryReference), count: args.count });
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await new Promise((resolve) => setTimeout(resolve, 2));
                if (options.fail?.(Number(args.memoryReference))) throw new Error("read failed");
                const offset = Number(args.memoryReference) - BASE;
                return { data: ram.subarray(offset, offset + args.count).toString("base64") };
            } finally {
                inFlight--;
            }
        }
    };
    const bridge = new DebugSessionBridge({ getRamSectionRanges: options.ranges || (() => RAM) });
    bridge.sessions.set(session.id, session);
    Object.assign(bridge, { intentEnabled: true, paused: true, snapshotReady: true });
    bridge.capabilities = { read: true, write: false };
    return { bridge, requests, maxInFlight: () => maxInFlight };
}

(async () => {
    // Small gaps inside one writable section join; larger gaps, other sections and unknown memory do not.
    {
        const groups = mergeReadPlan(
            [item("a", BASE), item("b", BASE + 4 + MAX_PAUSED_GAP_BYTES), item("c", BASE + 0x100)],
            4096,
            RAM
        );
        assert.deepStrictEqual(
            groups.map((group) => [group.address, group.size, group.items.map((entry) => entry.name)]),
            [
                [BASE, 8 + MAX_PAUSED_GAP_BYTES, ["a", "b"]],
                [BASE + 0x100, 4, ["c"]]
            ]
        );
        assert.strictEqual(mergeReadPlan([item("a", BASE), item("b", BASE + 8)], 4096).length, 2, "no sections");
        const split = [
            { start: BASE, end: BASE + 6 },
            { start: BASE + 6, end: BASE + 0x100 }
        ];
        assert.strictEqual(mergeReadPlan([item("a", BASE), item("b", BASE + 8)], 4096, split).length, 2);
        assert.strictEqual(mergeReadPlan([item("a", BASE), item("b", BASE + 8)], 10, RAM).length, 2, "size cap");
        const touching = mergeReadPlan([item("a", BASE), item("b", BASE + 4)], 4096);
        assert.deepStrictEqual([touching.length, touching[0].size], [1, 8]);
    }

    const ram = Buffer.alloc(0x10000);
    for (let index = 0; index < ram.length; index++) ram[index] = (index * 13) & 0xff;

    // Variables separated by small gaps cost one request; groups go out a few at a time in plan order.
    {
        const { bridge, requests, maxInFlight } = pausedBridge(ram);
        const near = [item("x", BASE + 0x10), item("y", BASE + 0x20), item("z", BASE + 0x30, 2)];
        const far = Array.from({ length: 10 }, (_, index) => item(`f${index}`, BASE + 0x1000 * (index + 1)));
        const samples = await bridge.read([...far, ...near]);
        assert.strictEqual(requests.length, 1 + far.length);
        assert.ok(maxInFlight() > 1 && maxInFlight() <= MAX_PAUSED_PARALLEL_READS);
        assert.deepStrictEqual(
            samples.map((sample) => sample.name),
            ["x", "y", "z", ...far.map((entry) => entry.name)]
        );
        for (const sample of samples) {
            const source = [...near, ...far].find((entry) => entry.name === sample.name);
            const offset = source.address - BASE;
            assert.deepStrictEqual(Buffer.from(sample.bytes), ram.subarray(offset, offset + source.size));
        }
        bridge.dispose();
    }

    // Unavailable ELF sections fall back to touching ranges only.
    {
        const { bridge, requests } = pausedBridge(ram, {
            ranges: () => {
                throw new Error("no ELF");
            }
        });
        await bridge.read([item("x", BASE + 0x10), item("y", BASE + 0x20)]);
        assert.strictEqual(requests.length, 2);
        bridge.dispose();
    }

    // A failed read stops new requests and fails the snapshot.
    {
        const failAt = BASE + 0x1000;
        const { bridge, requests } = pausedBridge(ram, { fail: (address) => address === failAt });
        const many = Array.from({ length: 12 }, (_, index) => item(`f${index}`, BASE + 0x1000 * (index + 1)));
        await assert.rejects(bridge.read(many), /read failed/);
        assert.ok(requests.length < many.length, "no further groups start after a failure");
        bridge.dispose();
    }

    // Resuming during the reads cancels the snapshot.
    {
        const { bridge } = pausedBridge(ram);
        const many = Array.from({ length: 8 }, (_, index) => item(`f${index}`, BASE + 0x1000 * (index + 1)));
        const pending = bridge.read(many);
        bridge.paused = false;
        await assert.rejects(pending, { code: "DEBUG_STATE_CHANGED" });
        bridge.dispose();
    }
    console.log("Paused read gap merging and bounded parallel reads passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
