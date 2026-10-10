"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { minimalElf } = require("./helpers/elf-fixture");
const { probeRsArgs, runProbeRs, downloadWithProbeRs } = require("../src/services/probeRsFlashService");
const { resolveProbeRsDebugConfiguration } = require("../src/services/probeRsConfiguration");

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-regression-"));
    const elf = path.join(root, "firmware");
    const bytes = minimalElf("original firmware");
    const settings = { executable: "fake-probe-rs", chip: "STM32H723VG", probe: "1366:0101:1234", speed: 2000 };
    const writeElf = () => fs.writeFile(elf, bytes);
    try {
        await writeElf();
        const args = probeRsArgs("download", settings, elf);
        for (const flag of ["--verify", "--reset"]) assert.ok(args.includes(flag), `${flag} is mandatory`);
        assert.equal(args[args.indexOf("--binary-format") + 1], "elf");
        assert.equal(args.at(-1), elf);
        assert.ok(!probeRsArgs("read", settings).includes("--reset"), "read commands remain read-only");
        assert.ok(!probeRsArgs("read", settings).includes("--verify"));

        const calls = [];
        const progress = [];
        let snapshot;
        const inspected = await downloadWithProbeRs(settings, elf, root, {
            onProgress: (event) => progress.push(event),
            run: async (executable, command, cwd, options) => {
                calls.push(command);
                assert.equal(executable, settings.executable);
                assert.equal(cwd, root);
                snapshot = command.at(-1);
                assert.notEqual(snapshot, elf);
                assert.deepEqual(await fs.readFile(snapshot), bytes);
                await fs.writeFile(elf, minimalElf("new build"));
                assert.deepEqual(await fs.readFile(snapshot), bytes, "the selected build cannot replace the snapshot");
                options.onLine("\u001b[32mErasing flash\u001b[0m");
                options.onLine("Programming flash");
                options.onLine("Verifying flash");
                options.onLine("Resetting target");
                return { stdout: "", stderr: "Finished in 1.00s\n" };
            }
        });
        assert.equal(calls.length, 1, "verification and reset reuse the download connection");
        assert.equal(inspected.sha256, createHash("sha256").update(bytes).digest("hex"));
        await assert.rejects(fs.stat(snapshot), { code: "ENOENT" });
        for (const stage of ["prepare", "download", "erase", "program", "verify", "reset", "complete"])
            assert.ok(
                progress.some((event) => event.stage === stage),
                `report ${stage}`
            );
        assert.equal(progress.at(-1).level, "success");

        for (const stage of ["verify", "reset"]) {
            await writeElf();
            const failedProgress = [];
            let runs = 0;
            await assert.rejects(
                downloadWithProbeRs(settings, elf, root, {
                    onProgress: (event) => failedProgress.push(event),
                    run: async (_executable, command, _cwd, options) => {
                        runs++;
                        snapshot = command.at(-1);
                        options.onLine(stage === "verify" ? "Verification failed: readback mismatch" : "Reset failed");
                        throw Object.assign(new Error(`${stage} failed`), { code: 1 });
                    }
                }),
                (error) => {
                    assert.equal(error.code, "PROBE_RS_FLASH_FAILED");
                    assert.equal(error.stage, stage);
                    assert.equal(error.retryable, false);
                    assert.equal(error.details.resultUnknown, true);
                    assert.equal(error.details.elfSha256, inspected.sha256);
                    assert.ok(error.details.probeRsTail.includes("failed"));
                    return true;
                }
            );
            assert.equal(runs, 1, "a failed write never retries or opens a reset connection");
            assert.ok(!failedProgress.some((event) => event.level === "success"));
            assert.equal(failedProgress.at(-1).level, "error");
            await assert.rejects(fs.stat(snapshot), { code: "ENOENT" });
        }

        await writeElf();
        await assert.rejects(
            downloadWithProbeRs(settings, elf, root, {
                timeoutMs: 234,
                run: async (_executable, command, _cwd, options) => {
                    assert.equal(options.timeoutMs, 234);
                    snapshot = command.at(-1);
                    options.onLine("x".repeat(20000));
                    options.onLine("Verifying flash");
                    throw Object.assign(new Error("process timed out"), { killed: true, signal: "SIGTERM" });
                }
            }),
            (error) => {
                assert.equal(error.code, "PROBE_RS_TIMEOUT");
                assert.equal(error.stage, "verify");
                assert.equal(error.details.timeoutMs, 234);
                assert.equal(error.details.resultUnknown, true);
                assert.equal(error.retryable, false);
                assert.ok(error.details.probeRsTail.length <= 8000);
                return true;
            }
        );
        await assert.rejects(fs.stat(snapshot), { code: "ENOENT" });

        await assert.rejects(
            downloadWithProbeRs(settings, elf, root, {
                run: async () => {
                    throw Object.assign(new Error("not installed"), { code: "ENOENT" });
                }
            }),
            (error) => error.code === "PROBE_RS_FLASH_FAILED" && error.details.resultUnknown === false
        );
        let touchedProbe = false;
        await fs.writeFile(elf, "not an ELF");
        await assert.rejects(
            downloadWithProbeRs(settings, elf, root, { run: async () => (touchedProbe = true) }),
            (error) => error.stage === "prepare" && error.details.resultUnknown === false
        );
        assert.equal(touchedProbe, false);

        await writeElf();
        await assert.rejects(
            downloadWithProbeRs(settings, elf, root, {
                beforeRun: () => {
                    throw Object.assign(new Error("driver switching"), { code: "PROBE_DRIVER_BUSY" });
                },
                run: async () => (touchedProbe = true)
            }),
            (error) => error.code === "PROBE_DRIVER_BUSY" && error.details.resultUnknown === false
        );
        assert.equal(touchedProbe, false, "the final gate runs after snapshot preparation");

        const lines = [];
        const result = await runProbeRs(
            process.execPath,
            [
                "-e",
                "process.stdout.write('first\\nsecond\\rthird'); process.stdin.on('end', () => process.stderr.write('closed')); process.stdin.resume();"
            ],
            root,
            { timeoutMs: 2000, onLine: (line) => lines.push(line) }
        );
        assert.equal(result.stdout, "first\nsecond\rthird");
        assert.equal(result.stderr, "closed");
        assert.deepEqual(lines.sort(), ["closed", "first", "second", "third"]);
        await assert.rejects(
            runProbeRs(path.join(root, "missing-probe-rs"), [], root, { timeoutMs: 2000, onLine() {} }),
            { code: "ENOENT" }
        );
        await assert.rejects(
            runProbeRs(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], root),
            { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }
        );
        await assert.rejects(
            runProbeRs(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], root, { timeoutMs: 200 }),
            (error) => error.killed === true
        );

        const folder = { uri: { fsPath: root } };
        const launch = (flashingConfig, request = "launch") =>
            resolveProbeRsDebugConfiguration({ request, executable: elf, flashingConfig }, folder, "", settings);
        assert.equal(launch().flashingConfig.verifyAfterFlashing, true);
        assert.equal(launch({ verifyAfterFlashing: false }).flashingConfig.verifyAfterFlashing, false);
        assert.equal(launch({ flashingEnabled: true }, "attach").flashingConfig.flashingEnabled, false);
        console.log("probe-rs flash verification, snapshots, diagnostics and CLI lifetime tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
