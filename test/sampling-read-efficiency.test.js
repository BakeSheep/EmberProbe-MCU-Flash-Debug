"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { ManagedOpenOcdSession, compileReadBatches } = require("../src/liveWatch");
const { MultiRatePlan } = require("../src/services/multiRatePlan");
const { writableRamSectionRanges } = require("../src/services/liveWatchService");
const { SamplingSession } = require("../src/samplingSession");
const { loadProvider } = require("./helpers/load-provider");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");
const item = (name, address = 0x20000000, size = 4) => ({ name, address, size });
const ranges = [{ start: 0x20000000, end: 0x20010000 }];

function startupFixture(mode, branch) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
        child.exitCode = 0;
        child.emit("close", 0);
    };
    const sockets = [],
        commands = [],
        scheduled = [];
    let release;
    const connect = async () => {
        const socket = new EventEmitter();
        socket.destroyed = false;
        socket.setNoDelay = () => {};
        socket.destroy = () => {
            socket.destroyed = true;
            socket.emit("close");
        };
        socket.write = (command, callback) => {
            commands.push(command);
            callback?.();
            const marker = command.match(/EP_(?:NOECHO|SYNC)_[a-f0-9]+/)?.[0];
            if (command.includes("catch {emberprobe_read_scatter version}")) {
                queueMicrotask(() => socket.emit("data", Buffer.from("EP_OK:0\x1a")));
                return;
            }
            if (!marker) return;
            const reply = () => {
                if (branch === "closed") return socket.destroy();
                if (branch === "error") return socket.emit("error", new Error("detection transport error"));
                if (branch === "timeout") return;
                if (branch === "echoed" && marker.includes("NOECHO")) child.stderr.write(marker + "\n");
                const mismatch = branch === "mismatch" || (branch === "sync-mismatch" && marker.includes("SYNC"));
                socket.emit("data", Buffer.from((mismatch ? "wrong" : marker) + "\x1a"));
                if (marker.includes("SYNC") && branch !== "no-sync") {
                    child.stdout.write(marker.slice(0, 9));
                    child.stdout.write(marker.slice(9) + "\n");
                }
            };
            if (branch === "held" && marker.includes("NOECHO")) release = reply;
            else queueMicrotask(reply);
        };
        sockets.push(socket);
        return socket;
    };
    const filename = path.resolve(__dirname, "../src/liveWatch.js");
    const localRequire = createRequire(filename);
    const mod = { exports: {} };
    const scripts = require("../src/openocdScripts");
    vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(filename, "utf8") + "\n})", {
        filename
    })(
        (name) =>
            name === "child_process"
                ? { spawn: () => child }
                : name === "./openocdScripts"
                  ? {
                        ...scripts,
                        resolveOpenOcdLaunch: () => ({
                            executable: "fake",
                            probePath: "jlink.cfg",
                            targetPath: "stm32f4x.cfg"
                        })
                    }
                  : localRequire(name),
        mod,
        mod.exports
    );
    const errors = [];
    const session = new mod.exports.ManagedOpenOcdSession(
        null,
        { executable: "fake", probe: "jlink.cfg", target: "stm32f4x.cfg", port: 16666, gdbPort: 13333, mode },
        { onError: (message) => errors.push(message) }
    );
    session._connectWithRetry = connect;
    session._waitForTclListening = async () => {};
    session._scheduleNext = (delay) => scheduled.push(delay);
    return { session, child, commands, sockets, scheduled, errors, release: () => release() };
}

(async () => {
    for (const mode of ["standalone", "debug"]) {
        for (const branch of [
            "verified",
            "mismatch",
            "sync-mismatch",
            "no-sync",
            "echoed",
            "closed",
            "error",
            "timeout"
        ]) {
            const fixture = startupFixture(mode, branch);
            const { session, child } = fixture;
            await session.start();
            assert.strictEqual(
                session.noEchoResponses,
                branch === "verified" || (branch === "no-sync" && mode === "standalone"),
                `${mode}/${branch}`
            );
            assert.strictEqual(session.stopped, false, "detection must never fail startup");
            assert.strictEqual(session._openOcdLogTail.length, 0, "capability markers stay out of diagnostics");
            assert.strictEqual(session.queue.length, 0);
            if (["mismatch", "sync-mismatch", "closed", "error", "timeout"].includes(branch)) {
                assert.strictEqual(fixture.sockets.length, 2, "discard the ambiguous response stream");
            }
            child.stderr.write("EP_OK:Error: WriteFile Polling failed\n");
            assert.strictEqual(session._openOcdLogTail.length, 0);
            assert.strictEqual(session._pollFailureCount, 0);
            assert.strictEqual(fixture.errors.length, 0);
            child.stderr.write("EP_ERR:read failed\nError: real failure\n");
            assert.deepStrictEqual(session._openOcdLogTail, ["EP_ERR:read failed", "Error: real failure"]);
            assert.ok(fixture.errors.length);
            await session.stop(100);
        }
        const fixture = startupFixture(mode, "held");
        const starting = fixture.session.start();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(fixture.scheduled.length, 0, "sampling waits for detection");
        let checked;
        fixture.session._sendCommand = async (command) => {
            checked = command;
            return "EP_OK:42";
        };
        const command = fixture.session._executeCheckedCommand("expr 42");
        await fixture.session._sampleTick();
        assert.strictEqual(checked, undefined, "checked commands also wait for detection");
        fixture.release();
        await starting;
        assert.strictEqual(await command, "42");
        assert.ok(checked.endsWith("return -code exit $_ep_out"));
        assert.strictEqual(fixture.scheduled.length, mode === "standalone" ? 1 : 0);
        await fixture.session.stop(100);

        const session = new ManagedOpenOcdSession(null, { mode }, {});
        for (const noEcho of [false, true]) {
            session.noEchoResponses = noEcho;
            let wrapped;
            session._sendSilentDebugCommand = async () => "file";
            session._sendCommand = async (command) => {
                wrapped = command;
                return "EP_OK:42";
            };
            assert.strictEqual(
                await session._executeCheckedCommand("expr 42"),
                mode === "debug" && !noEcho ? "file" : "42"
            );
            if (wrapped) {
                assert.ok(wrapped.includes("catch {expr 42} _ep_msg"));
                assert.strictEqual(wrapped.endsWith("return -code exit $_ep_out"), noEcho);
                session._sendCommand = async () => "EP_ERR:bad command";
                await assert.rejects(session._executeCheckedCommand("bad"), { code: "OPENOCD_TCL_ERROR" });
                session._sendCommand = async () => "bad protocol";
                await assert.rejects(session._executeCheckedCommand("bad"), { code: "OPENOCD_TCL_PROTOCOL_ERROR" });
            }
        }
    }

    const pair = [item("a"), item("b", 0x20000024)];
    assert.strictEqual(compileReadBatches(pair, ranges)[0][0].byteCount, 40);
    assert.strictEqual(compileReadBatches(pair).flat().length, 2);
    assert.strictEqual(compileReadBatches([pair[0], item("b", 0x20000025)], ranges).flat().length, 1);
    assert.strictEqual(
        compileReadBatches(pair, [
            { start: 0x20000000, end: 0x20000020 },
            { start: 0x20000020, end: 0x20000100 }
        ]).flat().length,
        2
    );
    assert.strictEqual(compileReadBatches(pair, [{ start: 0x20000004, end: 0x20000100 }]).flat().length, 2);
    const fullBudget = [item("a", 0x20000000, 2048), item("b", 0x20000804, 2048)];
    assert.strictEqual(compileReadBatches(fullBudget, ranges, true).flat().length, 4);
    assert.strictEqual(compileReadBatches(fullBudget, ranges, true).flat()[0].group.vars.length, 1);
    assert.strictEqual(compileReadBatches(pair, ranges, true, 4088).flat().length, 2);
    const many = [
        item("head", 0x20000000, 1024),
        item("tail", 0x20000404, 1024),
        ...Array.from({ length: 30 }, (_, index) => item(`v${index}`, 0x20002000 + index * 256))
    ];
    assert.strictEqual(compileReadBatches(many, ranges, true).flat().length, 32);
    assert.strictEqual(
        compileReadBatches(many, ranges, true).flat()[0].group.vars.length,
        1,
        "splitting a merged span must not exceed the command budget"
    );
    const split = compileReadBatches([item("a", 0x20000000, 1024), item("b", 0x20000404, 1024)], ranges);
    assert.deepStrictEqual(
        split.map((batch) => batch.reduce((n, unit) => n + unit.byteCount, 0)),
        [1024, 1024, 4]
    );
    for (const mode of ["standalone", "debug"]) {
        const session = new ManagedOpenOcdSession(null, { mode }, {});
        session.setSamplingPlan({ graphItems: pair, ramSectionRanges: ranges });
        const fake = new FakeOpenOcdServer();
        fake.seed(
            ranges[0].start,
            Array.from({ length: 40 }, (_, index) => index)
        );
        session._sendCheckedCommand = async (command) => fake._execute(command).response;
        await session._readItems(session.watch, 0);
        assert.strictEqual(session._memoryReadBytes, 40, "throughput counts actual gap bytes");
        assert.strictEqual(fake.commands.length, 1, "small gaps use one read_memory call");
        session._batchUnsupported = true;
        const merged = session._getReadBatches(session.watch);
        assert.strictEqual(session._getReadBatches(session.watch), merged, "reuse compiled plan");
        session._readMemoryBytes = async (start, count) =>
            Array.from({ length: count }, (_, index) => (start + index) & 255);
        const result = await session._readItems(session.watch, 0);
        session.setSamplingPlan({ graphItems: pair });
        assert.notStrictEqual(session._getReadBatches(session.watch), merged, "ranges invalidate the cache");
        assert.deepStrictEqual(
            (await session._readItems(session.watch, 0)).samples.map(({ name, bytes }) => ({ name, bytes })),
            result.samples.map(({ name, bytes }) => ({ name, bytes }))
        );
        assert.deepStrictEqual(
            result.samples.map((sample) => sample.bytes),
            [
                [0, 1, 2, 3],
                [36, 37, 38, 39]
            ]
        );
        session.setWatch(pair, [
            null,
            { start: -1, end: 4 },
            { start: "0", end: 4 },
            { start: 0, end: 2 ** 32 + 1 },
            { start: 1.5, end: 4 },
            { start: 4, end: 4 },
            ...ranges
        ]);
        assert.deepStrictEqual(session.ramSectionRanges, ranges);
        session.setWatch(pair, Array(5000).fill(ranges[0]));
        assert.strictEqual(session.ramSectionRanges.length, 4096);
    }
    const sections = [
        { flags: 3, addr: ranges[0].start, size: 65536 },
        { flags: 2, addr: 0x08000000, size: 4096 }
    ];
    assert.deepStrictEqual(
        writableRamSectionRanges(sections).map(({ start, end }) => ({ start, end })),
        ranges
    );
    const provider = Object.create(loadProvider({}).prototype);
    provider.readElfSymbols = () => ({ memory: { sections } });
    provider._consumerTypes = () => ({
        graphs: new Map([["g", new Map([["a", "u32"]])]]),
        sidebar: new Map([["b", "u32"]])
    });
    provider._liveIntervalMs = 10;
    for (const mode of ["standalone", "debug"]) {
        const session = new ManagedOpenOcdSession(null, { mode }, {});
        provider._applySamplingPlan(session, pair);
        assert.deepStrictEqual(session.ramSectionRanges, ranges);
    }
    let forwarded;
    SamplingSession.prototype.setWatch.call(
        {
            mode: "standalone",
            notify: (_method, args) => {
                forwarded = args;
            }
        },
        pair,
        ranges
    );
    assert.deepStrictEqual(forwarded, [pair, ranges]);
    provider._applySamplingPlan(
        {
            setWatch: (items, deliveredRanges) => {
                forwarded = deliveredRanges;
            }
        },
        pair
    );
    assert.strictEqual(forwarded.length, 1);

    const standalone = new ManagedOpenOcdSession(null, { intervalMs: 10 }, {});
    standalone._recentDurations = [...Array(28).fill(5), ...Array(4).fill(40)];
    standalone._consecutiveSuccesses = 4;
    standalone._evaluateAdaptiveSchedule();
    assert.strictEqual(standalone.effectiveIntervalMs, 12, "spikes affect mean duty, not p95 duty");
    assert.strictEqual(standalone.stats().p95DurationMs, 40);
    standalone._recentDurations = [7, 7, 7, 7];
    standalone._setClockInterval(10, true);
    assert.strictEqual(standalone.effectiveIntervalMs, 10);
    standalone.cpuLoad.plan = {};
    standalone._setClockInterval(5, true);
    assert.strictEqual(standalone.effectiveIntervalMs, 10, "CPU sampler retains 70% duty");
    standalone.cpuLoad.plan = null;
    standalone._setClockInterval(5, true);
    assert.strictEqual(standalone.effectiveIntervalMs, 9);
    standalone.effectiveIntervalMs = 100;
    standalone._consecutiveSuccesses = 32;
    standalone._lastBackoffOrErrorAt = 0;
    standalone._recentDurations = [...Array(28).fill(5), ...Array(4).fill(80)];
    standalone._evaluateAdaptiveSchedule(10000);
    assert.strictEqual(standalone.effectiveIntervalMs, 85, "step-down also uses the mean");
    const debug = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    debug._recentDurations = [...Array(28).fill(5), ...Array(4).fill(40)];
    debug._setClockInterval(10);
    assert.strictEqual(debug.effectiveIntervalMs, 100, "debug retains p95 / 0.4");

    const plan = new MultiRatePlan({ graphItems: [item("g")], sidebarItems: [item("s")], graphIntervalMs: 20 });
    plan.due(0.25, 20);
    plan.due(21.25, 20);
    assert.strictEqual(plan.nextGraph, 40.25);
    const piggy = plan.due(41.25, 20);
    assert.deepStrictEqual(piggy.sidebarNames, ["s"]);
    assert.strictEqual(plan.nextSidebar, 100.25);
    plan.due(61.25, 20);
    assert.strictEqual(plan.nextGraph, 80.25, "late wake-ups do not accumulate drift");
    const fresh = new MultiRatePlan({ graphItems: [item("g")], sidebarItems: [item("s")], graphIntervalMs: 20 });
    for (const now of [0.25, 21.25]) {
        const due = fresh.due(now, 20);
        fresh.deliver(
            due.items.map((entry) => ({ name: entry.name, bytes: [1], t: now })),
            now,
            due
        );
    }
    assert.deepStrictEqual(
        fresh.due(41.25, 20).items.map((entry) => entry.name),
        ["g", "s"],
        "an early sidebar tick re-reads sidebar-only items instead of reusing a 41 ms old value"
    );
    plan.due(200.5, 20);
    assert.strictEqual(plan.nextGraph, 220.5);
    assert.strictEqual(plan.nextSidebar, 250.5, "long stalls resync");
    for (const interval of [5, 33, 200, 10000]) {
        const plan = new MultiRatePlan({
            graphItems: [item("g")],
            sidebarItems: [item("s")],
            graphIntervalMs: interval
        });
        const ticks = [];
        for (let now = 0.5; now < 10000; now += 1) {
            const due = plan.due(now, Math.min(interval, 50));
            if (due.sidebarNames.length) ticks.push(now);
        }
        assert.ok(ticks.length >= 199 && ticks.length <= 201, `20 Hz sidebar at graph interval ${interval}`);
        assert.ok(
            ticks.slice(1).every((time, index) => time - ticks[index] <= 67),
            "sidebar never starves"
        );
    }
    console.log("Sampling no-echo, RAM gap and scheduler tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
