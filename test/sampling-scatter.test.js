"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ManagedOpenOcdSession, compileReadBatches } = require("../src/liveWatch");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");
const { buildElf32 } = require("./helpers/elf-fixture");
const benchmark = require("../scripts/measure-sampling-scatter");

const item = (name, address, size = 4) => ({ name, address, size });
const many = (count, size = 4) =>
    Array.from({ length: count }, (_, index) => item(`v${index}`, 0x20000000 + index * 2048, size));
const scatterCommands = (fake) => fake.commands.filter((cmd) => cmd.startsWith("emberprobe_read_scatter {"));

async function fixture(mode = "standalone", version = "1") {
    const fake = new FakeOpenOcdServer();
    fake.scatterVersion = version;
    await fake.start();
    const session = new ManagedOpenOcdSession(null, { mode }, {});
    session._scheduleNext = () => {};
    session.socket = await fake.connect();
    session._setupSocket();
    session.noEchoResponses = true;
    await session._detectScatter();
    return { fake, session };
}

async function close({ fake, session }) {
    await session.stop(50);
    await fake.stop();
}

(async () => {
    const args = [
        "--openocd",
        "fake",
        "--probe",
        "cmsis-dap.cfg",
        "--target",
        "stm32f4x.cfg",
        "--output",
        "report.json"
    ];
    const options = benchmark.optionsFromArgs([...args, "--addresses", "0x20000000,0x20000100"]);
    assert.deepStrictEqual(
        benchmark.selectItems(options).items.map((entry) => entry.address),
        [0x20000000, 0x20000100]
    );
    assert.strictEqual(benchmark.percentile([5, 1, 3, 4, 2], 0.5), 3);
    assert.strictEqual(benchmark.percentile([], 0.95), null);
    for (const extra of [
        [],
        ["--addresses", "0x20000000", "--elf", "test.elf"],
        ["--unknown", "1"],
        ["--probe"],
        ["--addresses", "0x20000000", "--seconds", "0"],
        ["--addresses", "0x20000000", "--transport", "spi"],
        ["--addresses", "0x20000000", "--layout", "block"],
        ["--elf", "test.elf", "--layout", "spiral"],
        ["--elf", "test.elf", "--block-bytes", "1023"],
        ["--elf", "test.elf", "--rate-hz", "201"],
        ["--addresses", "0x20000000", "--variables", "1.5"],
        ["--addresses", "0x20000000", "--output", "again.json"]
    ])
        assert.throws(() => benchmark.optionsFromArgs([...args, ...extra]));
    assert.throws(() => benchmark.optionsFromArgs(["--addresses", "0x20000000"]), /Missing/);
    for (const addresses of ["0x40000000", "0x20000001", "1234", "0x20000000,0x20000000"])
        assert.throws(() => benchmark.selectItems({ addresses }));
    const savedConfirm = process.env.EMBERPROBE_HIL_CONFIRM;
    delete process.env.EMBERPROBE_HIL_CONFIRM;
    try {
        await assert.rejects(benchmark.main([]), /EMBERPROBE_HIL_CONFIRM=YES/);
    } finally {
        if (savedConfirm !== undefined) process.env.EMBERPROBE_HIL_CONFIRM = savedConfirm;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-scatter-elf-"));
    try {
        const elf = path.join(directory, "test.elf");
        fs.writeFileSync(
            elf,
            buildElf32({
                sections: [{ name: ".data", flags: 3, addr: 0x20000000, size: 4096 }],
                symbols: Array.from({ length: 10 }, (_, index) => ({
                    name: `ram${index}`,
                    value: 0x20000000 + index * 128,
                    size: 8
                }))
            })
        );
        const selected = benchmark.selectItems({ elf, variables: 4 });
        assert.strictEqual(selected.items.length, 4);
        assert.ok(selected.items.every((entry) => entry.size === 4));
        assert.strictEqual(selected.ramSectionRanges.length, 1);
        assert.throws(() => benchmark.selectItems({ elf, variables: 11 }), /only 10/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    for (const version of [null, "", "0", "2", "1\n", "1"]) {
        const f = await fixture("standalone", version);
        try {
            assert.strictEqual(f.session.stats().scatterReads, version === "1");
            assert.strictEqual(f.fake.commands[0], "emberprobe_read_scatter version");
        } finally {
            await close(f);
        }
    }
    for (const mode of ["standalone", "debug"]) {
        const f = await fixture(mode);
        const { fake, session } = f;
        try {
            const items = [item("byte", 0x20000001, 3), item("half", 0x20000102, 2), ...many(20).slice(1)];
            for (const entry of items)
                fake.seed(
                    entry.address,
                    Array.from({ length: entry.size }, (_, index) => (entry.address + index) & 255)
                );
            fake.commands.length = 0;
            const result = await session._readItems(items, 42);
            assert.strictEqual(fake.commands.length, 1, "many non-contiguous groups use one RPC");
            assert.strictEqual(result.ok, items.length);
            assert.match(fake.commands[0], /\{0x20000001 8 3\}/);
            assert.match(fake.commands[0], /\{0x20000102 16 1\}/);
            assert.match(fake.commands[0], / 32 1\}/);
            const transferred = items.reduce((sum, entry) => sum + entry.size, 0);
            assert.strictEqual(session._memoryReadBytes, transferred);
            session.scatterReads = false;
            assert.deepStrictEqual(
                await session._readItems(items, 42),
                result,
                "samples are byte-identical to batches"
            );
            session.scatterReads = true;
            assert.deepStrictEqual(
                (await session.readOnce(items)).map(({ bytes }) => bytes),
                result.samples.map(({ bytes }) => bytes)
            );
            const runtime = {
                ...item("runtime", 0x20010000),
                runtimeLayout: { root: 0, types: [{ kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" }] },
                runtimeRanges: [{ start: 0x20010000, end: 0x20010100 }]
            };
            fake.seed(runtime.address, [42, 0, 0, 0]);
            fake.commands.length = 0;
            const mixed = await session._readItems([items[2], runtime], 0);
            assert.strictEqual(mixed.samples.find((entry) => entry.name === "runtime").runtimeTree.value, 42);
            assert.ok(
                fake.commands.some((cmd) => /^(?:ocd_)?read_memory /.test(cmd)),
                "runtime reads stay ordinary"
            );
            assert.strictEqual(scatterCommands(fake).length, 1);
            const written = await session.writeAndVerify([{ ...items[2], bytes: [9, 8, 7, 6] }]);
            assert.deepStrictEqual(written.after[0].bytes, [9, 8, 7, 6]);
            assert.strictEqual(written.halted, false);
        } finally {
            await close(f);
        }
    }
    const splitFailure = await fixture();
    try {
        const { session, fake } = splitFailure;
        const execute = fake._execute.bind(fake);
        let calls = 0;
        fake._execute = (cmd) => {
            if (cmd.startsWith("emberprobe_read_scatter {") && ++calls === 2) return { ok: true, response: "bad" };
            return execute(cmd);
        };
        const items = many(5, 1024);
        const result = await session._readItems(items, 0);
        assert.strictEqual(result.ok, 5);
        assert.strictEqual(
            fake.commands.filter((cmd) => /^(?:ocd_)?read_memory /.test(cmd)).length,
            5,
            "a later failed scatter call re-reads every group of the cycle"
        );
        assert.strictEqual(session._memoryReadBytes, 4096 + 5120, "count valid scatter bytes plus fallback transfers");
        session._sendCheckedCommand = async () => {
            throw new Error("unexpected scatter failure");
        };
        session._readBatchBytes = async (batch) => batch.map((unit) => new Array(unit.byteCount).fill(0));
        assert.strictEqual((await session._readItems(items, 0)).ok, 5, "ordinary errors also fall back");
    } finally {
        await close(splitFailure);
    }
    const widened = await fixture();
    try {
        const { session, fake } = widened;
        session.setWatch([item("a", 0x20000001, 3), item("b", 0x20000024)], [{ start: 0x20000000, end: 0x20000100 }]);
        const results = await session._readItems(session.watch, 0);
        assert.strictEqual(results.ok, 2);
        assert.strictEqual(session._memoryReadBytes, 40, "gap and widened bytes count toward throughput");
        assert.match(scatterCommands(fake)[0], /\{0x20000000 32 10\}/);
    } finally {
        await close(widened);
    }
    for (const [items, segmentCounts] of [
        [many(65), [64, 1]],
        [many(5, 1024), [4, 1]],
        [[item("large", 0x20000000, 9000)], [4, 4, 1]]
    ]) {
        const f = await fixture();
        try {
            const { session, fake } = f;
            const result = await session._readItems(items, 0);
            assert.strictEqual(result.ok, items.length);
            assert.deepStrictEqual(
                scatterCommands(fake).map((cmd) => [...cmd.matchAll(/\{/g)].length),
                segmentCounts
            );
            assert.strictEqual(
                session._memoryReadBytes,
                items.reduce((sum, entry) => sum + entry.size, 0)
            );
            assert.ok(
                compileReadBatches(items)
                    .flat()
                    .every((unit) => unit.byteCount <= 1024)
            );
        } finally {
            await close(f);
        }
    }
    for (const invalid of [
        "",
        "00000000",
        "00000000\n00000000\n",
        "00000000\r\n00000000",
        "FFFFFFFF\n00000000",
        "zzzzzzzz\n00000000",
        "0000000\n00000000"
    ]) {
        const f = await fixture();
        try {
            const items = many(2);
            f.fake.scatterReply = invalid;
            const result = await f.session._readItems(items, 0);
            assert.strictEqual(result.ok, 2, "malformed replies fall back in the same cycle");
            assert.ok(f.fake.commands.some((cmd) => cmd.startsWith("join [list")));
            assert.strictEqual(f.session._scatterFailures, 1);
            assert.strictEqual(f.session.scatterReads, true);
        } finally {
            await close(f);
        }
    }
    const f = await fixture();
    try {
        const { session, fake } = f;
        const items = many(2);
        fake.scatterFailures = 2;
        await session._readItems(items, 0);
        await session._readItems(items, 0);
        assert.strictEqual(session._scatterFailures, 2);
        await session._readItems(items, 0);
        assert.strictEqual(session._scatterFailures, 0, "successful cycle resets the failure streak");
        fake.scatterFailures = 3;
        for (let i = 0; i < 3; i++) assert.strictEqual((await session._readItems(items, 0)).ok, 2);
        assert.strictEqual(session.stats().scatterReads, false);
        const before = scatterCommands(fake).length;
        await session._readItems(items, 0);
        assert.strictEqual(scatterCommands(fake).length, before);

        session.scatterReads = true;
        const execute = fake._execute.bind(fake);
        fake._execute = (cmd) =>
            cmd.startsWith("emberprobe_read_scatter {")
                ? { ok: false, response: "EMBERPROBE_SCATTER_UNSUPPORTED: HLA" }
                : execute(cmd);
        assert.strictEqual((await session._readItems(items, 0)).ok, 2);
        assert.strictEqual(session.scatterReads, false);

        session.scatterReads = true;
        fake._execute = (cmd) => {
            if (
                cmd.startsWith("emberprobe_read_scatter {") ||
                cmd.startsWith("join [list") ||
                /read_memory 0x20000000 /.test(cmd)
            )
                return { ok: false, response: "bad address" };
            return execute(cmd);
        };
        const partial = await session._readItems(items, 0);
        assert.strictEqual(partial.ok, 1, "fallback isolates the failing group");
        assert.strictEqual(partial.samples[0].bytes, null);
        assert.strictEqual(partial.samples[0].diagnostic.code, "OPENOCD_MEMORY_RESPONSE_ERROR");
        assert.deepStrictEqual(partial.samples[1].bytes, [0, 0, 0, 0]);
    } finally {
        await close(f);
    }
    const late = await fixture("standalone", "1");
    try {
        const { session, fake } = late;
        const execute = fake._execute.bind(fake);
        let examined = false;
        fake._execute = (cmd) =>
            cmd === "emberprobe_read_scatter version" && !examined
                ? { ok: false, response: "EMBERPROBE_SCATTER_UNSUPPORTED: examined Cortex-M MEM-AP required" }
                : execute(cmd);
        await session._detectScatter();
        assert.strictEqual(session.scatterReads, false, "an unexamined target refuses at connect");
        examined = true;
        session.setWatch([item("a", 0x20000000), item("b", 0x20001000)]);
        await session._sampleTick();
        assert.strictEqual(session.scatterReads, true, "a target examined after connect enables scatter once");
        const versions = fake.commands.filter((cmd) => cmd === "emberprobe_read_scatter version").length;
        await session._sampleTick();
        assert.strictEqual(scatterCommands(fake).length, 1, "the next cycle uses one scatter RPC");
        assert.strictEqual(
            fake.commands.filter((cmd) => cmd === "emberprobe_read_scatter version").length,
            versions,
            "the re-check runs only once"
        );
    } finally {
        await close(late);
    }
    const debug = await fixture("debug");
    try {
        const { session, fake } = debug;
        await assert.rejects(session.readOnce(many(33)), { code: "LIVE_READ_BUDGET_EXCEEDED" });
        await assert.rejects(session.readOnce([item("big", 0x20000000, 4097)]), { code: "LIVE_READ_BUDGET_EXCEEDED" });
        assert.strictEqual(scatterCommands(fake).length, 0, "budgets checked before any scatter RPC");
        const guard = { targetEpoch: session.targetEpoch, deadline: Date.now() + 1000 };
        const checked = session._sendCheckedCommand.bind(session);
        session._sendCheckedCommand = async (cmd) => {
            const result = await checked(cmd);
            session.targetEpoch++;
            return result;
        };
        await assert.rejects(session._readItems(many(2), 0, guard), { code: "LIVE_READ_CANCELLED" });
        assert.strictEqual(scatterCommands(fake).length, 1, "cancellation never falls back");
        session._sendCheckedCommand = checked;
        await assert.rejects(session._readItems(many(2), 0, { targetEpoch: session.targetEpoch, deadline: 1 }), {
            code: "LIVE_READ_BUDGET_EXCEEDED"
        });
    } finally {
        await close(debug);
    }
    for (const detection of [false, true]) {
        const f = await fixture();
        try {
            f.session.rpcTimeoutMs = 30;
            f.fake.timeoutNext = true;
            if (detection) {
                await f.session._detectScatter();
                assert.strictEqual(f.session.scatterReads, false);
                assert.strictEqual(f.session.connectionFailed, false, "lost capability probe is non-fatal");
                assert.strictEqual(f.session.socket, null, "ambiguous capability FIFO is discarded");
            } else {
                await assert.rejects(f.session._readItems(many(2), 0), { code: "OPENOCD_RPC_TIMEOUT" });
                assert.strictEqual(f.session.connectionFailed, true, "acquisition timeout retains fatal handling");
            }
        } finally {
            await close(f);
        }
    }
    console.log("Sampling scatter detection, limits, fallback and guard tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
