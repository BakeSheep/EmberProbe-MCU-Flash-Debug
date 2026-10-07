"use strict";
const assert = require("assert");
const path = require("path");
const { SamplingSession } = require("../src/samplingSession");
const { CpuOpenOcdServer } = require("./helpers/cpu-openocd-server");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        await wait(10);
    }
}

(async () => {
    const source = new CpuOpenOcdServer();
    for (const mode of ["standalone", "debug"]) {
        const events = [],
            variables = [];
        const session = new SamplingSession(
            { mode, intervalMs: 20, refuseFirstStop: mode === "standalone" },
            {
                onCpuLoad: (result) => events.push(result),
                onSample: (samples) => variables.push(samples)
            },
            path.join(__dirname, "helpers/cpu-sampling-worker-fixture.js")
        );
        try {
            await session.start();
            await session.setCpuLoadPlan(source.plan);
            await waitFor(
                () => events.some((result) => result.windowMs > 900 && result.acquiredSamples > 0),
                mode + " CPU with empty watch list"
            );
            assert.strictEqual(events.at(-1).capabilities.core, mode === "standalone" ? "Cortex-M7" : "Cortex-M0");
            assert.deepStrictEqual(
                events.at(-1).capabilities.auxiliaryTargets,
                mode === "standalone" ? ["stm32h7x.ap2"] : []
            );
            session.setSamplingPlan({
                graphItems: [{ name: "value", address: 0x20000200, size: 4 }],
                graphIntervalMs: 20
            });
            session.setSamplingEnabled(true);
            await waitFor(() => variables.length > 0, mode + " variable sampling starts");
            const cpuCount = events.length;
            session.setSamplingEnabled(false);
            await waitFor(() => events.length > cpuCount, "stopping variables leaves CPU alive");
            session.setSamplingEnabled(true);
            await session.setCpuLoadPlan(null);
            const variableCount = variables.length,
                stoppedCpu = events.length;
            await waitFor(() => variables.length > variableCount, "stopping CPU leaves variables alive");
            await wait(180);
            assert.strictEqual(events.length, stoppedCpu);
            await session.setCpuLoadPlan({ ...source.plan, generation: 2 });
            await session.setCpuLoadPaused("debug-control");
            await session.waitForIdle();
            assert.strictEqual(events.at(-1).state, "paused");
            await session.setCpuLoadPaused(null);
            await waitFor(() => events.at(-1)?.runGeneration > 1, "resuming CPU starts a new run generation");
        } finally {
            if (mode === "standalone") {
                assert.strictEqual(await session.stop(), false, "unconfirmed exit must not terminate the worker");
                assert(!session.exited);
            }
            assert.strictEqual(await session.stop(), true, "shutdown can be retried until confirmed");
        }
    }
    // Real Tcl framing and silent debug replies share exactly one socket with writes.
    const server = new CpuOpenOcdServer({ h7: true }),
        native = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    try {
        await server.start();
        native.socket = await server.connect();
        native._setupSocket();
        native.setCpuLoadPlan(server.plan);
        await waitFor(
            () =>
                server.commands.some(
                    (command) => command.includes("stm32h7x.cpu0 read_memory") && command.includes("curstate")
                ),
            "native CPU sampler acquires a memory sample"
        );
        native.setCpuLoadPaused("control");
        await native.waitForIdle();
        const before = server.commands.length;
        await wait(30);
        assert.strictEqual(server.commands.length, before);
        assert(
            server.commands.every((command) => !/write_memory|\bhalt\b|\bresume\b|\bprofile\b|e000edf0/i.test(command))
        );
        assert(
            server.responses.every((response) => response === ""),
            "CPU does not broadcast data into GDB console"
        );
        assert.strictEqual(server.maxInFlight, 1);
        assert(server.commands.some((command) => command.includes("stm32h7x.cpu0 read_memory")));
        assert(server.commands.some((command) => command.includes("stm32h7x.cpu0 curstate")));
        assert(!server.commands.some((command) => command.includes("stm32h7x.ap2 read_memory")));
        const writing = new ManagedOpenOcdSession(null, { mode: "standalone" }, {});
        try {
            writing.socket = await server.connect();
            writing._setupSocket();
            const beforeStart = server.commands.length;
            writing.setCpuLoadPlan(server.plan);
            await waitFor(
                () => server.commands.slice(beforeStart).some((command) => command.includes("curstate")),
                "standalone CPU sampler starts"
            );
            server.readLatencyMs = 5;
            const beginWrite = server.commands.length;
            await writing.writeAndVerify([{ name: "value", address: 0x20000200, bytes: [9, 8, 7, 6] }]);
            writing.setCpuLoadPaused("after-write");
            await writing.waitForIdle();
            const transaction = server.commands.slice(beginWrite);
            const halt = transaction.indexOf("halt"),
                resume = transaction.indexOf("resume");
            assert(halt >= 0 && resume > halt);
            assert(
                !transaction
                    .slice(halt, resume)
                    .some((command) => command.startsWith("join [list") && command.includes("curstate")),
                "CPU never interleaves with an authorized write transaction"
            );
            assert.deepStrictEqual(server.bytes(0x20000200, 4), [9, 8, 7, 6]);
        } finally {
            await writing.stop();
        }
    } finally {
        await native.stop();
        await server.stop();
    }

    console.log("CPU worker transport, read safety and independent low-level consumers passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
