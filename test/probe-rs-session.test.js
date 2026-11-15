"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { FakeClock } = require("./helpers/fake-clock");
const { nativeSamplerFixture } = require("./helpers/native-sampler-fixture");
const { ProbeRsProcess } = require("../src/probeRsProcess");
const { ProbeRsSamplingSession } = require("../src/probeRsSession");
const ram = [{ start: 0x20000000, end: 0x20001000 }];
const item = { name: "counter", address: 0x20000000, size: 4 };
const input = { graphItems: [item], sidebarItems: [item], graphIntervalMs: 10, unlimited: true, ramSectionRanges: ram };

async function main() {
    await scenario("native session publishes plans and cancels stale results", async () => {
        const clock = new FakeClock();
        const fixture = nativeSamplerFixture({ clock });
        const delivered = [];
        const session = new ProbeRsSamplingSession(
            { clock: { ...clock, monotonicMs: clock.now }, nativeExecutable: "fake", native: { elfSha256: "digest" } },
            { onSample: (...args) => delivered.push(args) },
            { spawn: fixture.spawn }
        );
        await session.setSamplingPlan(input);
        await session.start();
        assert.equal(session.ready, true);
        assert.equal(session.stats().linkSpeedKhz, 1000, "report the helper's acknowledged link speed");
        assert.equal(session.capabilities.write, false);
        const message = (generation, t = 1000) => ({
            generation,
            recipe: 3,
            byteCount: 4,
            samples: [{ t, durationMs: 0.5, bytes: Buffer.from([1, 2, 3, 4]) }]
        });
        session.onSamples(message(session.generation - 1));
        assert.equal(delivered.length, 0);
        session.onSamples(message(session.generation));
        session.onSamples(message(session.generation, 1001));
        assert.equal(delivered.length, 2);
        assert.equal(session.stats().actualHz, 1000);
        assert.equal(session.stats().bytesPerSecond, 4000);
        assert.equal(session.stats().p95DurationMs, 0.5);
        assert.equal(session.stats().unlimitedActive, true);
        session.setHostHold(true);
        await clock.advance(20);
        assert.equal(session.stats().limitedBy, "host");
        assert.equal(session.stats().hostHoldMs, 20);
        session.setHostHold(false);
        session.setHostHold(false);
        session.setPauseReason("archive_backpressure");
        assert.equal(session.stats().pauseReason, "archive_backpressure");
        const values = await session.readOnce([item]);
        assert.deepEqual(values[0].bytes, [7, 7, 7, 7]);
        await session.waitForIdle();
        await session.invalidateTarget();
        await session.setIntervalMs(20);
        session.setSamplingEnabled(false);
        session.onSamples(message(session.generation));
        assert.equal(delivered.length, 2);
        session.setSamplingEnabled(true);
        await session.setWatch([item], ram);
        for (const method of ["writeAndVerify", "peripheralTransaction", "rttControl"])
            await assert.rejects(session[method](), { code: "BACKEND_UNSUPPORTED" });
        assert.equal(await session.stop(), true);
        assert.equal(await session.waitForExit(), true);
        await assert.rejects(session.readOnce([item]));
        await assert.rejects(session.start());
        assert.equal(session.setSamplingEnabled(true), false);
        assert.ok(fixture.requests.some((request) => request.method === "hold"));
    });
    await scenario("timeouts reject pending work and retain unconfirmed process ownership", async () => {
        const clock = new FakeClock();
        const fixture = nativeSamplerFixture({
            clock,
            exitOnStop: false,
            onRequest: (request) => (request.method === "start" ? undefined : false)
        });
        const failures = [];
        const process = new ProbeRsProcess(
            { clock, nativeExecutable: "fake" },
            { onFailure: (error) => failures.push(error) },
            { spawn: fixture.spawn }
        );
        await process.start({ elfSha256: "a" });
        const read = process.request("read", [], 10);
        const rejected = assert.rejects(read, { code: "PROBE_RS_TIMEOUT" });
        await clock.advance(10);
        await rejected;
        assert.equal(failures.length, 1);
        const stopping = process.stop(10);
        await clock.advance(20);
        assert.equal(await stopping, false);
        assert.equal(fixture.child.killed, true);
        fixture.close();
        assert.equal(await process.stop(), true);
    });
    await scenario("invalid layouts and malformed child output stop the session", async () => {
        const clock = new FakeClock();
        const fixture = nativeSamplerFixture({ clock });
        const failures = [];
        const session = new ProbeRsSamplingSession(
            { clock, native: { elfSha256: "x" } },
            { onDisconnect: (error) => failures.push(error) },
            { spawn: fixture.spawn }
        );
        await session.start();
        assert.throws(
            () => session.setSamplingPlan({ ...input, graphItems: [{ ...item, runtimeLayout: {} }] }),
            /runtime/
        );
        assert.equal(failures.length, 1);
        assert.equal(session.connectionFailed, true);
        await session.stop();
        const badFixture = nativeSamplerFixture({ clock });
        const bad = new ProbeRsProcess({ clock }, {}, { spawn: badFixture.spawn });
        await bad.start({ elfSha256: "x" });
        badFixture.child.stdout.write(Buffer.from([255, 255, 255, 255]));
        assert.equal(bad.failed.code, "PROBE_RS_PROTOCOL_ERROR");
        await bad.stop();
    });
}
main()
    .then(() => console.log("probe-rs session tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
