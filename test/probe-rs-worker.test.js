"use strict";
const assert = require("assert");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { waitFor } = require("./helpers/wait");
const { SamplingSession } = require("../src/samplingSession");
async function main() {
    await scenario("real child frames cross the sampling Worker and stop with confirmed exit", async () => {
        const received = [];
        const errors = [];
        const session = new SamplingSession(
            {
                samplingBackend: "probe-rs",
                nativeExecutable: process.execPath,
                nativeArgs: [path.join(__dirname, "fixtures", "fake-native-sampler.js")],
                native: { elfSha256: "digest" }
            },
            {
                onSample: (samples) => received.push(samples),
                onError: (error) => errors.push(error)
            }
        );
        const plan = (name) => ({
            graphItems: [{ name, address: 0x20000000, size: 4 }],
            sidebarItems: [],
            graphIntervalMs: 10,
            unlimited: true,
            ramSectionRanges: [{ start: 0x20000000, end: 0x20001000 }]
        });
        try {
            session.setSamplingPlan(plan("first"));
            await session.start();
            await waitFor(() => received.length >= 2);
            assert.deepEqual(received[0][0].bytes, [7, 7, 7, 7]);
            session.setSamplingPlan(plan("second"));
            await waitFor(() => received.some((samples) => samples[0].name === "second"));
            const firstNew = received.findIndex((samples) => samples[0].name === "second");
            assert.ok(received.slice(firstNew).every((samples) => samples[0].name === "second"));
            assert.equal(session.capabilities.write, false);
            const read = await session.readOnce([{ name: "read", address: 0x20000000, size: 4 }]);
            assert.equal(read[0].name, "read");
            await assert.rejects(session.writeAndVerify([]), { code: "BACKEND_UNSUPPORTED" });
            assert.equal(errors.length, 0);
        } finally {
            assert.equal(await session.stop(), true);
        }
    });
}
main()
    .then(() => console.log("probe-rs Worker integration passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
