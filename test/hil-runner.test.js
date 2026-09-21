"use strict";
const assert = require("assert");
const { required, runOpenOcd, main } = require("./hil/run-hil");
const fs = require("fs");
const os = require("os");
const path = require("path");

(async () => {
    const previous = process.env.EMBERPROBE_TEST_REQUIRED;
    try {
        delete process.env.EMBERPROBE_TEST_REQUIRED;
        assert.throws(
            () => required("EMBERPROBE_TEST_REQUIRED"),
            (error) => error.code === "HIL_CONFIG_MISSING"
        );
        process.env.EMBERPROBE_TEST_REQUIRED = " value ";
        assert.strictEqual(required("EMBERPROBE_TEST_REQUIRED"), "value");

        const output = await runOpenOcd(process.execPath, ["-e", "console.error('verified OK')"], 5000);
        assert.ok(output.includes("verified OK"));
        await assert.rejects(
            () => runOpenOcd(process.execPath, ["-e", "process.exit(2)"], 5000),
            (error) => error.code === "HIL_OPENOCD_FAILED" && error.exitCode === 2
        );
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-hil-contract-"));
        const elf = path.join(root, "test.elf");
        fs.writeFileSync(elf, "dedicated fixture");
        const environment = {
            EMBERPROBE_HIL_CONFIRM: "YES",
            EMBERPROBE_HIL_BOARD: "fixture",
            EMBERPROBE_HIL_OPENOCD: "fake",
            EMBERPROBE_HIL_PROBE: "jlink.cfg",
            EMBERPROBE_HIL_TARGET: "stm32f1x.cfg",
            EMBERPROBE_HIL_ELF: elf,
            EMBERPROBE_HIL_TRANSPORT: "swd",
            EMBERPROBE_HIL_PROBE_SERIAL: "1234",
            EMBERPROBE_HIL_ADAPTER_SPEED_KHZ: "100"
        };
        const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
        Object.assign(process.env, environment);
        try {
            const prepare = async (options) => ({
                ...options,
                launch: {
                    executable: "fake",
                    scriptsRoot: "/scripts",
                    probePath: "/scripts/interface/jlink.cfg",
                    targetPath: "/scripts/target/stm32f1x.cfg"
                }
            });
            const report = () => {};
            await assert.rejects(main({ prepare, report, run: async () => "shutdown command invoked" }), {
                code: "HIL_VERIFY_MARKER_MISSING"
            });
            await assert.rejects(main({ prepare, report, run: async () => "not verified" }), {
                code: "HIL_VERIFY_MARKER_MISSING"
            });
            const result = await main({
                prepare,
                report,
                run: async (_exe, args) => {
                    const expected = [
                        "/scripts/interface/jlink.cfg",
                        "adapter serial 1234",
                        "transport select swd",
                        "/scripts/target/stm32f1x.cfg",
                        "adapter speed 100"
                    ];
                    const positions = expected.map((value) => args.indexOf(value));
                    assert(positions.every((value, index) => value >= 0 && (!index || value > positions[index - 1])));
                    assert(args.find((value) => value.startsWith("program ")).endsWith("verify reset"));
                    return "EP_HIL_VERIFY_OK\nshutdown command invoked";
                }
            });
            assert.strictEqual(result.probeSerial, "1234");
            assert.strictEqual(result.transport, "swd");
        } finally {
            for (const [key, value] of Object.entries(previousEnvironment)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
        console.log("HIL runner tests passed");
    } finally {
        if (previous === undefined) delete process.env.EMBERPROBE_TEST_REQUIRED;
        else process.env.EMBERPROBE_TEST_REQUIRED = previous;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
