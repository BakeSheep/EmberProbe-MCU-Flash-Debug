"use strict";
const assert = require("assert");
const { LiveWatchSession } = require("../src/liveWatch");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

(async () => {
    const fake = new FakeOpenOcdServer();
    await fake.start();
    fake.seed(0x20000000, [1, 2, 3, 4, 5, 6]);

    const session = new LiveWatchSession(null, {}, {});
    session.socket = await fake.connect();
    session._setupSocket();

    try {
        const samples = await session.readOnce([
            { name: "head", address: 0x20000000, size: 2 },
            { name: "tail", address: 0x20000002, size: 4 }
        ]);
        assert.deepStrictEqual(samples.map(sample => ({ name: sample.name, bytes: sample.bytes })), [
            { name: "head", bytes: [1, 2] },
            { name: "tail", bytes: [3, 4, 5, 6] }
        ]);
        assert.deepStrictEqual(
            fake.commands.filter(command => command.includes("read_memory")),
            ["ocd_read_memory 0x20000000 8 6"],
            "contiguous variables should be read in one Tcl command"
        );

        const written = await session.writeOnce([
            { address: 0x20000001, bytes: [0xaa, 0xbb] }
        ]);
        assert.strictEqual(written, 1);
        assert.deepStrictEqual(fake.bytes(0x20000000, 4), [1, 0xaa, 0xbb, 4]);
        assert.ok(
            fake.commands.includes("ocd_write_memory 0x20000001 8 {0xaa 0xbb}"),
            "write command should contain the expected address and bytes"
        );
    } finally {
        session.stop();
        await fake.stop();
    }

    console.log("Live watch Tcl-RPC integration tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
