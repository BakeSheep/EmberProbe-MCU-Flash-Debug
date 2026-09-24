"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { waitForJlinkReady } = require("../src/services/jlinkProbeReady");

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-ready-"));
    try {
        const executable = path.join(root, "bin", "openocd.exe");
        const scripts = path.join(root, "share", "openocd", "scripts");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.mkdirSync(path.join(scripts, "interface"), { recursive: true });
        fs.mkdirSync(path.join(scripts, "target"), { recursive: true });
        fs.writeFileSync(executable, "");
        fs.writeFileSync(path.join(scripts, "interface", "jlink.cfg"), "");
        let attempts = 0;
        let now = 0;
        await waitForJlinkReady(executable, "001234", {
            run: async (_file, args, cwd) => {
                attempts++;
                assert.strictEqual(cwd, scripts);
                assert(args.includes("adapter serial 1234"));
                assert(args.includes("gdb_port disabled"));
                assert(
                    !args.some((item) => item.includes("target/") || item.includes("reset") || item.includes("flash"))
                );
                if (attempts < 3) throw new Error("device re-enumerating");
            },
            wait: async (ms) => {
                now += ms;
            },
            now: () => now
        });
        assert.strictEqual(attempts, 3);
        attempts = 0;
        now = 0;
        await assert.rejects(
            waitForJlinkReady(executable, "1234", {
                run: async () => {
                    attempts++;
                    throw new Error("LIBUSB_ERROR_NO_DEVICE");
                },
                wait: async (ms) => {
                    now += ms;
                },
                now: () => now,
                timeoutMs: 500
            }),
            { code: "PROBE_DRIVER_NOT_READY" }
        );
        assert(attempts >= 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("J-Link readiness tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
