"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { ManagedOpenOcdSession, compileReadBatches } = require("../src/liveWatch");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { connectionIdentity } = require("../skills/_emberprobe/probe-connection");
const { writeConnectionIdentity } = require("../src/writeAuthorization");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { readArchive } = require("../src/services/samplingArchiveFormat");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { encodeViewport, decodeViewport } = require("../src/webview/liveWatch/chartTransport");
const { createSampleTimeFormatter } = require("../src/services/sampleTime");
const { LiveWatchService } = require("../src/services/liveWatchService");
const elf = require("../src/elfSymbols");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");
const { loadProvider } = require("./helpers/load-provider");

const base = 0x20000000;
const ranges = [{ start: base, end: base + 65536 }];
const item = (name, offset, size = 4) => ({ name, address: base + offset, size });

function timedSession() {
    let now = 1700000000000.125;
    const session = new ManagedOpenOcdSession(null, { sampleNow: () => now }, {});
    const fake = new FakeOpenOcdServer();
    session._sendCheckedCommand = async (command) => {
        now += 1.25;
        return fake._execute(command).response;
    };
    return { session, fake, time: () => now };
}

async function timestamps() {
    const { session, time } = timedSession();
    const entries = [item("large", 0, 1536), item("later", 4096)];
    session.socket = { destroyed: false };
    session._scheduleNext = () => {};
    session.setWatch(entries);
    const ticks = [];
    session.handlers.onSample = (samples, t) => ticks.push({ samples, t });
    for (let i = 0; i < 2; i++) {
        const cycleStart = time();
        await session._sampleTick();
        const tick = ticks.at(-1);
        assert.strictEqual(tick.t, (cycleStart + time()) / 2, "the stamp is centred on the cycle's reads");
        assert(!Number.isInteger(tick.t));
        assert.deepStrictEqual(
            tick.samples.map((sample) => sample.t),
            entries.map(() => tick.t),
            "every sample of a cycle shares one time, keeping one archive/CSV row per cycle"
        );
    }
    assert(ticks[1].t > ticks[0].t);

    const fractional = { ...item("later", 4096), bytes: [42, 0, 0, 0], t: 1700000000001.625 };
    const decoded = new LiveWatchService(elf).decodeConsumerSamples(
        [fractional],
        fractional.t,
        new Map([["later", "u32"]])
    );
    assert.strictEqual(decoded.scalarSamples[0].t, fractional.t);
    const provider = Object.create(loadProvider().prototype);
    assert.strictEqual(
        provider._decodeAgentSample([{ ...item("later", 4096), type: "u32" }], [fractional]).timestamp,
        fractional.t
    );
}

async function widening() {
    const compile = (items, sections = ranges, debug = false, reserved = 0) =>
        compileReadBatches(items, sections, debug, reserved).flat();
    const odd = item("odd", 1, 3);
    assert.strictEqual(compile([odd])[0].shape.widthBits, 32);
    assert.strictEqual(compile([odd])[0].start, base);
    for (const sections of [[], [{ start: base + 1, end: base + 4 }], [{ start: base, end: base + 3 }]])
        assert.strictEqual(compile([odd], sections)[0].shape.widthBits, 8);
    // The original 33-byte gap is too large; alignment makes it mergeable.
    const neighbours = [item("head", 1, 2), item("tail", 36)];
    assert.strictEqual(compile(neighbours).length, 1);
    assert.strictEqual(compile(neighbours)[0].byteCount, 40);
    assert.strictEqual(compile([odd], ranges, true, 4093)[0].byteCount, 3);
    assert.strictEqual(compile([item("edge", 5, 2)], [{ start: base, end: base + 7 }])[0].byteCount, 2);
    const commands = [item("large", 1, 1024), ...Array.from({ length: 31 }, (_, i) => item(`v${i}`, 2048 + i * 128))];
    assert.strictEqual(compile(commands, ranges, true)[0].start, base + 1, "widening cannot add a 33rd command");
    const { session, fake } = timedSession();
    fake.seed(
        base,
        Array.from({ length: 40 }, (_, i) => i)
    );
    session.setWatch(neighbours, ranges);
    const widened = await session._readItems(neighbours, 0);
    assert.deepStrictEqual(
        widened.samples.map((sample) => sample.bytes),
        [
            [1, 2],
            [36, 37, 38, 39]
        ]
    );
    assert.strictEqual(session._memoryReadBytes, 40);
}

async function networkAndIdentity() {
    let config = { debugger: "cmsis-dap.cfg", adapterSpeedKhz: 100, samplingAdapterSpeedKhz: 4000 };
    const service = new ProbeConnectionService({
        getConfig: () => config,
        prepareConnection: async (request) => ({
            ...connectionIdentity(request),
            profile: { kind: "tcp", fingerprint: "profile" },
            selectionIdentity: { kind: "tcp", profile: "profile", endpoint: "localhost:1234" }
        })
    });
    const connection = await service.prepare({ probe: "cmsis-dap.cfg", sampling: true });
    assert.strictEqual(connection.backendKind, "tcp");
    assert.strictEqual(connection.samplingAdapterSpeedKhz, 4000);
    assert.strictEqual(connection.adapterSpeedKhz, 100);
    assert.strictEqual(writeConnectionIdentity(connection).adapterSpeedKhz, 4000);
    assert.strictEqual(writeConnectionIdentity({ ...connection, mode: "debug" }).adapterSpeedKhz, 100);
    const ordinary = await service.prepare({ probe: "cmsis-dap.cfg" });
    assert.strictEqual(ordinary.samplingAdapterSpeedKhz, undefined);
    config = { ...config, samplingAdapterSpeedKhz: 8000 };
    assert.throws(() => service.assertCurrent({ options: connection }), { code: "PROBE_SESSION_STALE" });
    assert.doesNotThrow(() => service.assertCurrent({ options: ordinary }));
    for (const invalid of [-1, 1.5, 2147483648, "bad"]) {
        config.samplingAdapterSpeedKhz = invalid;
        await assert.rejects(service.prepare({ sampling: true }), { code: "ADAPTER_SPEED_INVALID" });
    }
    config.samplingAdapterSpeedKhz = 0;
    assert.strictEqual(writeConnectionIdentity(await service.prepare({ sampling: true })).adapterSpeedKhz, 100);
    service.prepareConnection = async () => {
        config.samplingAdapterSpeedKhz = 2000;
        return ordinary;
    };
    await assert.rejects(service.prepare({ sampling: true }), { code: "PROBE_CONFIGURATION_CHANGED" });

    for (const [kind, timeout] of [
        ["tcp", 5000],
        ["usb", 2000],
        ["local", 2000],
        [undefined, 2000]
    ]) {
        const session = new ManagedOpenOcdSession(null, { backendKind: kind }, {});
        assert.strictEqual(session.rpcTimeoutMs, timeout);
        const socket = new EventEmitter();
        socket.setNoDelay = () => {};
        socket.destroy = () => {
            socket.destroyed = true;
        };
        socket.write = () => {};
        session.socket = socket;
        session._setupSocket();
        const originalNow = Date.now;
        let now = originalNow();
        try {
            Date.now = () => now;
            const pending = session._sendCommand("test");
            now += 2500;
            socket.emit("data", Buffer.from("ok\x1a"));
            if (kind === "tcp") assert.strictEqual(await pending, "ok");
            else await assert.rejects(pending, { code: "OPENOCD_RPC_TIMEOUT" });
            if (kind === "tcp") {
                const overdue = session._sendCommand("test");
                now += 5001;
                socket.emit("data", Buffer.from("late\x1a"));
                await assert.rejects(overdue, { code: "OPENOCD_RPC_TIMEOUT" });
            }
        } finally {
            Date.now = originalNow;
        }
    }
    let now = 0;
    const lock = new ManagedOpenOcdSession(null, { backendKind: "tcp", now: () => now }, {});
    for (now = 0; now <= 3000; now += 500) lock._handlePollingFailure("Polling failed");
    assert(lock.stopped, "500 ms target polling still locks after three seconds");

    const provider = Object.create(loadProvider().prototype);
    let marked = 0,
        stopped = 0,
        restarted = 0;
    Object.assign(provider, {
        _liveSession: { options: connection },
        _samplingIntent: true,
        _liveStartGeneration: 0,
        _probeConnectionService: {
            markConfigurationChanged: (sessions) => {
                assert.deepStrictEqual(sessions, [provider._liveSession]);
                marked++;
            }
        },
        _debugBridge: { activeSession: { id: "debug" } },
        _refreshConnectedProbes: async () => {},
        _postConsumerStatuses: () => {},
        stopLiveWatch: (options) => {
            assert(options.preserveIntent);
            stopped++;
            provider._liveStartGeneration++;
        },
        startLiveWatch: async () => {
            restarted++;
        }
    });
    provider.connectionConfigurationChanged(true, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual([marked, stopped, restarted], [1, 1, 1]);
}

async function fractionalStorage() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sampling-p1-"));
    const archive = new SamplingArchive({ rootDir: path.join(dir, "archive") });
    const t = 1700000000123.125,
        later = t + 0.25;
    const samples = [
        { name: "a", value: 1, t },
        { name: "b", value: 2, t: later }
    ];
    try {
        assert(archive.append(samples, t));
        const source = await archive.historySource("");
        const rows = [];
        for await (const row of readArchive(source.dataPath)) rows.push(row);
        assert.deepStrictEqual(
            rows.map((row) => row.t),
            [t, later]
        );
        const expected = "2023-11-14T22:13:20.123125Z";
        const iso = createSampleTimeFormatter();
        assert.strictEqual(iso(t), expected);
        assert.strictEqual(iso(t + 1000), "2023-11-14T22:13:21.123125Z");
        assert.strictEqual(iso(999.9999999), "1970-01-01T00:00:01.000Z");
        const csv = await archive.readCsv({ names: ["a", "b"] });
        assert(csv.csv.includes(expected + ",1,"));
        assert(csv.csv.includes(".123375Z,,2"));
        const parseIso = (text) => {
            const [whole, fraction] = text.slice(0, -1).split(".");
            return Date.parse(whole + "Z") + Number("0." + fraction) * 1000;
        };
        assert.strictEqual(parseIso(expected), t);
        const store = new ChartHistoryStore();
        store.configure("p", [
            { name: "a", type: "u32" },
            { name: "b", type: "u32" }
        ]);
        store.append("p", samples, later);
        const viewport = store.viewport("p", ["a", "b"], { min: t - 1, max: later + 1 }, 100);
        assert.deepStrictEqual(
            decodeViewport(encodeViewport(viewport).message.series).map((s) => s.arr[0].t),
            [t, later]
        );
    } finally {
        await archive.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }
}

(async () => {
    await timestamps();
    await widening();
    await networkAndIdentity();
    await fractionalStorage();
    console.log("Sampling midpoint, widening, network, clock identity and fractional storage tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
