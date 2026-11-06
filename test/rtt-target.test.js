"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const { rttControl } = require("../src/rttControl");

const ADDRESS = 0x20000400;
const BLOCK = { address: ADDRESS, size: 72, exact: true };
const DESCRIPTOR = ADDRESS + 24;

function fixture({ upCount = 3, downCount = 1, flags = 0x80000000 } = {}) {
    const clock = new FakeClock();
    const memory = Buffer.alloc(16384);
    memory.write("SEGGER RTT", 0, "ascii");
    memory.writeUInt32LE(upCount, 16);
    memory.writeUInt32LE(downCount, 20);
    for (let index = 0; index < upCount; index++) {
        const offset = 24 + index * 24;
        [0x08001000 + index * 8, 0x20010000 + index * 128, 128, 9, 120, flags].forEach((value, word) =>
            memory.writeUInt32LE(value, offset + word * 4)
        );
    }
    const f = {
        memory,
        clock,
        commands: [],
        locks: 0,
        acquires: 0,
        endian: "little",
        aliases: true,
        writeAliases: true,
        writes: 0,
        ignoreWrite: false,
        beforeCommand: () => {},
        word: (address, value) => memory.writeUInt32LE(value, address - ADDRESS),
        snapshot: (channels = [0, 1]) => rttControl(session, { operation: "snapshot", block: BLOCK, channels }),
        mode: (mode, extra = {}) =>
            rttControl(session, { operation: "setMode", block: BLOCK, channel: 0, mode, ...extra })
    };
    const session = {
        clock,
        targetEpoch: 1,
        stopped: false,
        _acquireExclusive: async () => {
            assert.strictEqual(f.locks, 0, "RTT helpers must not acquire a nested exclusive lock");
            f.locks++;
            f.acquires++;
        },
        _releaseExclusive: () => f.locks--,
        _assertReadGuard: (guard) => {
            if (guard.targetEpoch !== session.targetEpoch)
                throw Object.assign(new Error("Target changed"), { code: "LIVE_READ_CANCELLED" });
        },
        tcl: {
            connected: true,
            sendChecked: async (command) => {
                f.commands.push(command);
                f.beforeCommand(command);
                if (command === "[target current] cget -endian") return f.endian;
                if (command === "info commands *read_memory")
                    return f.aliases ? "ocd_read_memory read_memory" : "read_memory";
                if (command === "info commands *write_memory")
                    return f.writeAliases ? "ocd_write_memory write_memory" : "write_memory";
                const read = /^(?:ocd_)?read_memory (0x[0-9a-f]+) 32 (\d+)$/.exec(command);
                if (read) {
                    const offset = Number(read[1]) - ADDRESS;
                    return Array.from(
                        { length: Number(read[2]) },
                        (_, index) => "0x" + memory.readUInt32LE(offset + index * 4).toString(16)
                    ).join(" ");
                }
                const write = /^(?:ocd_)?write_memory (0x[0-9a-f]+) 32 \{(0x[0-9a-f]+)\}$/.exec(command);
                if (write) {
                    f.writes++;
                    if (!f.ignoreWrite) f.word(Number(write[1]), Number(write[2]));
                    return "";
                }
                throw new Error("Unexpected mock command " + command);
            }
        }
    };
    f.session = session;
    return f;
}

function rejects(f, promise, code, unknown = false) {
    return assert.rejects(promise, (error) => {
        assert.strictEqual(error.code, code);
        assert.strictEqual(error.retryable, false);
        if (error.details?.operation === "setMode") assert.strictEqual(error.details.resultUnknown, unknown);
        assert.strictEqual(f.locks, 0, "failed target access releases the lock");
        return true;
    });
}

(async () => {
    await scenario("snapshot decodes ARM32 fields, ring wrap and capacity without reading payloads", async () => {
        const f = fixture();
        const result = await f.snapshot([1, 0]);
        assert.deepStrictEqual(result.snapshot, {
            address: ADDRESS,
            upCount: 3,
            downCount: 1,
            targetEpoch: 1,
            channels: [1, 0].map((index) => ({
                index,
                descriptorAddress: DESCRIPTOR + index * 24,
                nameAddress: 0x08001000 + index * 8,
                bufferAddress: 0x20010000 + index * 128,
                size: 128,
                flags: 0x80000000,
                mode: "skip",
                writeOffset: 9,
                readOffset: 120,
                usedBytes: 17,
                capacity: 127
            }))
        });
        const reads = f.commands.filter((command) => /read_memory 0x/.test(command));
        assert.deepStrictEqual(reads, [
            "ocd_read_memory 0x20000400 32 6",
            "ocd_read_memory 0x20000418 32 12",
            "ocd_read_memory 0x20000400 32 6"
        ]);
        assert.strictEqual(f.acquires, 1);
        assert.strictEqual(f.locks, 0);
        assert.strictEqual(f.writes, 0);
    });

    await scenario("zero up/down counts form a valid empty snapshot", async () => {
        const f = fixture({ upCount: 0, downCount: 0 });
        assert.deepStrictEqual((await f.snapshot([])).snapshot.channels, []);
        await rejects(f, f.snapshot([0]), "RTT_CHANNEL_UNINITIALIZED");
    });

    await scenario("target access rejects scan ranges and invalid requests before acquiring the lock", async () => {
        for (const request of [
            { operation: "snapshot", block: { ...BLOCK, exact: false }, channels: [0] },
            { operation: "snapshot", block: { ...BLOCK, address: ADDRESS + 1 }, channels: [0] },
            { operation: "snapshot", block: { ...BLOCK, address: 0xfffffffc }, channels: [0] },
            { operation: "snapshot", block: { ...BLOCK, size: 4 }, channels: [0] },
            { operation: "snapshot", block: BLOCK, channels: [0, 0] },
            { operation: "snapshot", block: BLOCK, channels: [256] },
            { operation: "snapshot", block: BLOCK, channels: Array.from({ length: 169 }, (_, i) => i) },
            { operation: "setMode", block: BLOCK, channel: 0, mode: "unknown" },
            { operation: "setMode", block: BLOCK, channel: 0, mode: "trim", expected: null }
        ]) {
            const f = fixture();
            await assert.rejects(rttControl(f.session, request), (error) => {
                assert.match(error.code, /^RTT_/);
                assert.strictEqual(error.retryable, false);
                return true;
            });
            assert.strictEqual(f.acquires, 0);
            assert.deepStrictEqual(f.commands, []);
        }
    });

    await scenario("layout validation rejects invalid ID, counts, pointers, sizes, offsets and mode bits", async () => {
        const mutations = [
            (f) => f.memory.write("BAD", 0),
            (f) => f.word(ADDRESS + 16, 257),
            (f) => f.word(ADDRESS + 20, 257),
            (f) => f.word(DESCRIPTOR + 4, 0xfffffff0),
            (f) => f.word(DESCRIPTOR + 4, ADDRESS + 4),
            (f) => f.word(DESCRIPTOR, ADDRESS + 4),
            (f) => f.word(DESCRIPTOR + 8, 1),
            (f) => f.word(DESCRIPTOR + 8, 0x10000001),
            (f) => f.word(DESCRIPTOR + 12, 128),
            (f) => f.word(DESCRIPTOR + 16, 128),
            (f) => f.word(DESCRIPTOR + 20, 3)
        ];
        for (const mutate of mutations) {
            const f = fixture();
            mutate(f);
            await rejects(f, f.snapshot([0]), "RTT_INVALID_LAYOUT");
            assert.strictEqual(f.writes, 0);
        }
        for (const field of [4, 8]) {
            const f = fixture();
            f.word(DESCRIPTOR + field, 0);
            await rejects(f, f.mode("trim"), "RTT_CHANNEL_UNINITIALIZED");
            assert.strictEqual(f.writes, 0);
        }
        const f = fixture();
        f.word(DESCRIPTOR + 16, 9);
        assert.strictEqual((await f.snapshot([0])).snapshot.channels[0].usedBytes, 0);
    });

    await scenario("runtime endian and command availability are verified before accessing target memory", async () => {
        for (const endian of ["big", "", "unknown"]) {
            const f = fixture();
            f.endian = endian;
            await rejects(f, f.mode("trim"), "RTT_ACCESS_UNSUPPORTED");
            assert.strictEqual(f.commands.length, 1);
        }
        const f = fixture();
        f.beforeCommand = (command) => {
            if (command === "[target current] cget -endian")
                throw Object.assign(new Error("unknown command cget"), { code: "OPENOCD_TCL_ERROR" });
        };
        await rejects(f, f.snapshot(), "RTT_ACCESS_UNSUPPORTED");
        const noCommand = fixture();
        noCommand.beforeCommand = (command) => {
            if (command === "info commands *write_memory") noCommand.writeAliases = null;
        };
        // An empty discovery result is distinct from a Tcl error and must not cause a speculative write.
        const originalSend = noCommand.session.tcl.sendChecked;
        noCommand.session.tcl.sendChecked = (command) =>
            command === "info commands *write_memory" ? Promise.resolve("") : originalSend(command);
        await rejects(noCommand, noCommand.mode("trim"), "RTT_ACCESS_UNSUPPORTED");
        assert.strictEqual(noCommand.writes, 0);
    });

    await scenario("snapshot and writes stop on target epoch changes and 250 ms budget expiry", async () => {
        for (const operation of ["snapshot", "setMode"]) {
            for (const invalidate of [false, true]) {
                const f = fixture();
                f.beforeCommand = (command) => {
                    if (!/read_memory 0x/.test(command)) return;
                    if (invalidate) f.session.targetEpoch++;
                    else f.clock.time += 251;
                };
                const pending = operation === "snapshot" ? f.snapshot() : f.mode("trim");
                await rejects(f, pending, invalidate ? "LIVE_READ_CANCELLED" : "LIVE_READ_BUDGET_EXCEEDED");
                assert.strictEqual(f.writes, 0);
            }
        }
    });

    await scenario("snapshot enforces 24 commands even for fragmented descriptor selections", async () => {
        const f = fixture({ upCount: 45 });
        await rejects(f, f.snapshot(Array.from({ length: 21 }, (_, i) => i * 2)), "RTT_TARGET_BUDGET_EXCEEDED");
        assert.strictEqual(f.commands.length, 24);
        assert.strictEqual(f.writes, 0);
    });

    await scenario("snapshot accepts 256 runtime channels while keeping selected reads below 4 KiB", async () => {
        const f = fixture({ upCount: 256, downCount: 256 });
        const selected = Array.from({ length: 168 }, (_, index) => index);
        assert.strictEqual((await f.snapshot(selected)).snapshot.channels.length, 168);
        const bytesRead = f.commands.reduce((total, command) => {
            const read = /read_memory 0x[0-9a-f]+ 32 (\d+)/.exec(command);
            return total + (read ? Number(read[1]) * 4 : 0);
        }, 0);
        assert.strictEqual(bytesRead, 4080);
        assert.strictEqual((await f.snapshot([255])).snapshot.channels[0].index, 255);
    });

    await scenario("snapshots reject control block reinitialization and incomplete memory responses", async () => {
        const f = fixture();
        let headers = 0;
        f.beforeCommand = (command) => {
            if (command === "ocd_read_memory 0x20000400 32 6" && ++headers === 2) f.word(ADDRESS + 16, 2);
        };
        await rejects(f, f.snapshot([0]), "RTT_IDENTITY_CHANGED");
        const incomplete = fixture();
        const send = incomplete.session.tcl.sendChecked;
        incomplete.session.tcl.sendChecked = (command) =>
            /read_memory 0x/.test(command) ? Promise.resolve("0x0") : send(command);
        await rejects(incomplete, incomplete.snapshot(), "RTT_READ_FAILED");
    });

    await scenario("mode changes preserve Flags high bits, use discovered aliases and verify read-back", async () => {
        const f = fixture();
        f.aliases = f.writeAliases = false;
        const expected = (await f.snapshot([0])).snapshot.channels[0];
        f.commands.length = 0;
        const result = await f.mode("block", { expected });
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.channel.mode, "block");
        assert.strictEqual(result.channel.flags, 0x80000002);
        assert.strictEqual(f.writes, 1);
        assert.strictEqual(f.memory.readUInt32LE(44), 0x80000002);
        assert(
            f.commands.indexOf("info commands *write_memory") <
                f.commands.indexOf("write_memory 0x2000042c 32 {0x80000002}")
        );
        assert.strictEqual(f.commands.filter((command) => /^write_memory/.test(command)).length, 1);
        assert.strictEqual(f.locks, 0);
        assert.strictEqual(f.acquires, 2);
    });

    await scenario("mode no-op does not write and ignores changing ring offsets in the expected snapshot", async () => {
        const f = fixture();
        const expected = (await f.snapshot([0])).snapshot.channels[0];
        f.word(DESCRIPTOR + 12, 10);
        const result = await f.mode("skip", { expected });
        assert.strictEqual(result.changed, false);
        assert.strictEqual(result.channel.writeOffset, 10);
        assert.strictEqual(f.writes, 0);
    });

    await scenario("mode refuses stale expected identity or Flags before writing", async () => {
        for (const field of ["index", "descriptorAddress", "bufferAddress", "size", "nameAddress", "flags"]) {
            const f = fixture();
            const expected = (await f.snapshot([0])).snapshot.channels[0];
            expected[field]++;
            await rejects(f, f.mode("trim", { expected }), "RTT_VALUE_CHANGED");
            assert.strictEqual(f.writes, 0);
        }
    });

    await scenario("mode rechecks descriptor identity and old Flags immediately before writing", async () => {
        for (const field of [4, 20]) {
            const f = fixture();
            let reads = 0;
            f.beforeCommand = (command) => {
                if (command === "ocd_read_memory 0x20000418 32 6" && ++reads === 2)
                    f.word(DESCRIPTOR + field, field === 4 ? 0x20020000 : 1);
            };
            await rejects(f, f.mode("trim"), field === 4 ? "RTT_IDENTITY_CHANGED" : "RTT_VALUE_CHANGED");
            assert.strictEqual(f.writes, 0);
        }
    });

    await scenario(
        "read-back mismatch, transport failure and post-write epoch invalidation never retry writes",
        async () => {
            for (const failure of ["mismatch", "writeError", "readError", "identity", "epoch", "budget"]) {
                const f = fixture();
                f.ignoreWrite = failure === "mismatch";
                f.beforeCommand = (command) => {
                    if (/^ocd_write_memory/.test(command)) {
                        if (failure === "writeError") throw new Error("write response lost");
                        if (failure === "epoch") f.session.targetEpoch++;
                        if (failure === "budget") f.clock.time += 251;
                    }
                    if (!f.writes || !/read_memory 0x/.test(command)) return;
                    if (failure === "readError") throw new Error("read response lost");
                    if (failure === "identity") f.word(DESCRIPTOR + 4, 0x20020000);
                };
                const code = {
                    mismatch: "RTT_READBACK_MISMATCH",
                    writeError: "RTT_WRITE_FAILED",
                    readError: "RTT_WRITE_FAILED",
                    identity: "RTT_IDENTITY_CHANGED",
                    epoch: "LIVE_READ_CANCELLED",
                    budget: "LIVE_READ_BUDGET_EXCEEDED"
                }[failure];
                await assert.rejects(f.mode("trim"), (error) => {
                    assert.strictEqual(error.code, code);
                    assert.strictEqual(error.retryable, false);
                    assert.strictEqual(error.details.resultUnknown, true);
                    assert.deepStrictEqual(error.details.completed, []);
                    return true;
                });
                assert.strictEqual(f.commands.filter((command) => /^ocd_write_memory/.test(command)).length, 1);
                assert.strictEqual(f.locks, 0);
            }
        }
    );

    await scenario("lock acquisition failures are coded and do not release an unacquired lock", async () => {
        const f = fixture();
        f.session._acquireExclusive = async () => {
            throw new Error("arbiter stopped");
        };
        await rejects(f, f.snapshot(), "RTT_CONTROL_FAILED");
        assert.deepStrictEqual(f.commands, []);
    });

    console.log("RTT target transaction tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
