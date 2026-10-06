"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { ManagedOpenOcdSession, parseMemoryElements } = require("../src/liveWatch");
const { LiveWatchService } = require("../src/services/liveWatchService");
const elf = require("../src/elfSymbols");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

function socketFixture() {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.setNoDelay = () => {};
    socket.write = () => {};
    socket.destroy = () => {
        socket.destroyed = true;
    };
    return socket;
}

(async () => {
    assert.deepStrictEqual(
        parseMemoryElements("0x20000000: 0xffffffff -2147483648 42 deadbeef", 32),
        [0xffffffff, 0x80000000, 42, 0xdeadbeef]
    );
    assert.deepStrictEqual(parseMemoryElements("-128 -1 0xff", 8), [128, 255, 255]);
    assert.deepStrictEqual(parseMemoryElements("-32768 -1 65535", 16), [32768, 65535, 65535]);
    assert.deepStrictEqual(parseMemoryElements("1", 64), []);
    for (const [width, text] of [
        [8, "0x01 unexpected 0x02"],
        [8, "0x01 256 0x02"],
        [16, "0x1234 -32769 0x5678"],
        [32, "0x12345678 4294967296 0xabcdef01"],
        [32, "Error: read failed at 0x20000000"],
        [32, "0x12345678\x1a0xabcdef01"]
    ]) {
        assert.deepStrictEqual(parseMemoryElements(text, width), [], "reject the entire malformed response");
    }

    const reader = new ManagedOpenOcdSession(null, {}, {});
    for (const [address, count, valid] of [
        [0x20000001, 3, "1 2 3"],
        [0x20000002, 4, "0x0201 0x0403"],
        [0x20000000, 4, "0x04030201"]
    ]) {
        reader._sendCheckedCommand = async () => valid;
        assert.deepStrictEqual(await reader._readMemoryBytes(address, count), [1, 2, 3, 4].slice(0, count));
        for (const invalid of ["", valid + " 0", valid + " invalid", "0x100000000 " + valid]) {
            reader._sendCheckedCommand = async () => invalid;
            assert.strictEqual(await reader._readMemoryBytes(address, count), null, "never truncate a bad read");
        }
    }

    const fake = new FakeOpenOcdServer();
    await fake.start();
    const samples = [];
    const session = new ManagedOpenOcdSession(null, {}, { onSample: (batch) => samples.push(...batch) });
    session.socket = await fake.connect();
    session._setupSocket();
    session.watch = [
        { name: "pwr", address: 0x20000000, size: 8 },
        { name: "value", address: 0x20000020, size: 4 }
    ];
    fake.seed(0x20000000, [1, 2, 3, 4, 5, 6, 7, 8]);
    fake.seed(0x20000020, [0, 0, 128, 63]);
    const executeRead = fake._executeRead.bind(fake);
    fake._executeRead = (command) => {
        const result = executeRead(command);
        return result?.ok ? { ...result, response: result.response + " 0x12345678" } : result;
    };
    try {
        await session._sampleTick();
        assert.strictEqual(samples.length, 2);
        assert.ok(samples.every((sample) => sample.bytes === null && sample.diagnostic));
        const latest = new Map([["pwr", { tree: { kind: "struct", members: [{ value: 99 }] } }]]);
        const decoded = new LiveWatchService(elf).decodeConsumerSamples(
            samples,
            Date.now(),
            new Map([["value", "f32"]]),
            new Map([["pwr", { layout: { kind: "struct", byteSize: 8 } }]]),
            latest
        );
        assert.strictEqual(decoded.scalarSamples[0].value, null);
        assert.deepStrictEqual(latest.get("pwr").tree.members, [], "bad reads must clear old composite values");
        assert.ok(latest.get("pwr").tree.unavailable);
        fake._executeRead = (command) => {
            const result = executeRead(command);
            return command.includes("0x20000000") ? { ...result, response: "0x04030201" } : result;
        };
        samples.length = 0;
        await session._sampleTick();
        assert.strictEqual(samples[0].bytes, null, "a short object response must never expose a partial object");
        assert.deepStrictEqual(samples[1].bytes, [0, 0, 128, 63], "an independent valid group stays usable");
        fake._executeRead = executeRead;
        samples.length = 0;
        await session._sampleTick();
        assert.deepStrictEqual(
            samples.map((sample) => sample.bytes),
            [
                [1, 2, 3, 4, 5, 6, 7, 8],
                [0, 0, 128, 63]
            ]
        );
    } finally {
        await session.stop();
        await fake.stop();
    }

    // After sleep or an event-loop stall, data can be dispatched before the overdue timer callback.
    const overdue = new ManagedOpenOcdSession(null, {}, {});
    overdue.socket = socketFixture();
    overdue._setupSocket();
    const realNow = Date.now;
    let now = realNow();
    let pending;
    let queued;
    try {
        Date.now = () => now;
        pending = overdue._sendCommand("read_memory 0x20000000 32 1");
        queued = overdue._sendCommand("read_memory 0x20000020 32 1");
        now += 2001;
        overdue.socket.emit("data", Buffer.from("EP_OK:0x12345678\x1aEP_OK:0x04030201\x1a"));
    } finally {
        Date.now = realNow;
    }
    await assert.rejects(pending, /超时/);
    await assert.rejects(queued, /超时/);
    assert.strictEqual(overdue.stopped, true, "an overdue response invalidates the FIFO connection");
    assert.strictEqual(overdue.queue.length, 0);

    const replaced = new ManagedOpenOcdSession(null, {}, {});
    const oldSocket = socketFixture();
    replaced.socket = oldSocket;
    replaced._setupSocket();
    replaced.socket = socketFixture();
    replaced._setupSocket();
    const current = replaced._sendCommand("read_memory 0x20000020 32 1");
    oldSocket.emit("data", Buffer.from("EP_OK:0xdeadbeef\x1a"));
    oldSocket.emit("error", new Error("old socket error"));
    oldSocket.emit("close");
    assert.strictEqual(replaced.queue.length, 1, "old socket events cannot consume the new request");
    assert.strictEqual(replaced.stopped, false);
    replaced.socket.emit("data", Buffer.from("EP_OK:0x04030201\x1a"));
    assert.strictEqual(await current, "EP_OK:0x04030201");
    console.log("Live watch response integrity and overdue transport tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
