"use strict";
const assert = require("assert");
const { required, runOpenOcd } = require("./hil/run-hil");

(async () => {
    const previous = process.env.EMBERPROBE_TEST_REQUIRED;
    try {
        delete process.env.EMBERPROBE_TEST_REQUIRED;
        assert.throws(() => required("EMBERPROBE_TEST_REQUIRED"), error => error.code === "HIL_CONFIG_MISSING");
        process.env.EMBERPROBE_TEST_REQUIRED = " value ";
        assert.strictEqual(required("EMBERPROBE_TEST_REQUIRED"), "value");

        const output = await runOpenOcd(process.execPath, ["-e", "console.error('verified OK')"], 5000);
        assert.ok(output.includes("verified OK"));
        await assert.rejects(
            () => runOpenOcd(process.execPath, ["-e", "process.exit(2)"], 5000),
            error => error.code === "HIL_OPENOCD_FAILED" && error.exitCode === 2
        );
        console.log("HIL runner tests passed");
    } finally {
        if (previous === undefined) delete process.env.EMBERPROBE_TEST_REQUIRED;
        else process.env.EMBERPROBE_TEST_REQUIRED = previous;
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
