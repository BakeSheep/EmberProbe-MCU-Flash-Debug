"use strict";
// Manual, read-only board benchmark. Never part of the destructive HIL runner.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SamplingSession } = require("../src/samplingSession");
const { SYSTEM_CLOCK } = require("../src/samplingClock");

async function measure(plan, options, entry) {
    let complete;
    let reject;
    const finished = new Promise((resolve, fail) => {
        complete = resolve;
        reject = fail;
    });
    let beginning;
    let first;
    let last;
    let count = 0;
    let previous;
    let gaps = 0;
    const session = new SamplingSession(options, {
        onSample(_samples, t) {
            if (previous !== undefined && t < previous) return reject(new Error("Sample clock moved backwards"));
            previous = t;
            beginning ??= t;
            if (t - beginning < 1000) return;
            first ??= t;
            last = t;
            count++;
            if (last - first >= plan.seconds * 1000) complete();
        },
        onSampleGap() {
            gaps++;
        },
        onDisconnect: reject,
        onError: reject
    });
    const deadline = SYSTEM_CLOCK.schedule(() => reject(new Error("Benchmark timed out")), 90000);
    // A startup error must not leave the deadline rejection unhandled.
    finished.catch(() => {});
    try {
        const ready = await session.start();
        const tick = () => session.readOnce([{ name: "tick", address: plan.tickAddress, size: 4 }]);
        const before = Buffer.from((await tick())[0].bytes).readUInt32LE();
        session.setSamplingPlan({
            graphItems: entry.ranges.map(({ address, count: size }, index) => ({
                name: `range${index}`,
                address,
                size
            })),
            sidebarItems: [],
            graphIntervalMs: 5,
            unlimited: true,
            ramSectionRanges: plan.ram
        });
        await finished;
        session.setSamplingEnabled(false);
        const after = Buffer.from((await tick())[0].bytes).readUInt32LE();
        assert.ok(after !== before, "Firmware tick must advance during sampling");
        assert.equal(gaps, 0, "Host sample queue must not drop points");
        const result = {
            name: entry.name,
            hz: ((count - 1) * 1000) / (last - first),
            count,
            measuredMs: last - first,
            tickBefore: before,
            tickAfter: after,
            gaps,
            ready,
            stats: session.stats()
        };
        console.log(`${entry.name}: ${result.hz.toFixed(2)} Hz (${count} points, no gaps)`);
        return result;
    } finally {
        SYSTEM_CLOCK.cancel(deadline);
        assert.equal(await session.stop(), true, "Native process exit must be confirmed");
    }
}
async function main() {
    assert.equal(process.env.EMBERPROBE_HIL_CONFIRM, "YES", "Set EMBERPROBE_HIL_CONFIRM=YES for an authorized board");
    const [input, helper, speedText, output] = process.argv.slice(2);
    assert.ok(
        input && helper && speedText && output,
        "Usage: node scripts/measure-probe-rs.js PLAN HELPER SPEED_KHZ OUTPUT"
    );
    assert.ok(fs.statSync(input).size <= 1024 * 1024);
    const plan = JSON.parse(fs.readFileSync(input, "utf8"));
    assert.ok(Number.isFinite(plan.seconds) && plan.seconds > 0 && plan.seconds <= 30);
    assert.ok(Array.isArray(plan.cases) && plan.cases.length > 0 && plan.cases.length <= 16);
    assert.ok(fs.statSync(plan.elf).size <= 64 * 1024 * 1024);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(plan.elf)).digest("hex");
    assert.equal(hash, plan.elfSha256, "ELF changed since benchmark plan creation");
    const speedKhz = Number(speedText);
    assert.ok(Number.isInteger(speedKhz) && speedKhz > 0 && speedKhz <= 50000);
    const options = {
        samplingBackend: "probe-rs",
        nativeExecutable: path.resolve(helper),
        native: {
            chip: plan.chip,
            elf: plan.elf,
            elfSha256: hash,
            targetDescription: plan.target,
            ...plan.probe,
            speedKhz,
            protocol: "swd"
        }
    };
    const report = { date: new Date().toISOString(), speedKhz, elfSha256: hash, results: [] };
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    for (const entry of plan.cases) {
        report.results.push(await measure(plan, options, entry));
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
