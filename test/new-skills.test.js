"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");
const { AgentBridge } = require("../src/agentBridge");
const peripheralSkill = require("../skills/mcu-peripheral-debug/scripts/peripheral");
const debugSkill = require("../skills/mcu-debug-control/scripts/debug");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");

(async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-new-skills-"));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-new-skills-storage-"));
    const calls = [];
    const bridge = new AgentBridge(
        workspace,
        async (method, params) => {
            calls.push({ method, params });
            if (method === "peripherals.read" && params.targets.includes("RUNNING"))
                throw Object.assign(new Error("target is running"), { code: "TARGET_NOT_PAUSED" });
            if (method === "peripherals.write" && !params.confirmationId)
                return { confirmationRequired: true, confirmationId: "peripheral-confirm" };
            return { method, params };
        },
        storage
    );
    try {
        await bridge.start();
        const peripheral = path.join(root, "skills", "mcu-peripheral-debug", "scripts", "peripheral.js");
        const debug = path.join(root, "skills", "mcu-debug-control", "scripts", "debug.js");

        assert.throws(
            () => peripheralSkill.args(["--list", "--confirm", "unused"]),
            /--confirm can only be used with --set/
        );
        assert.throws(
            () => peripheralSkill.args(["--read", "GPIOA.MODER", "--confirm", "unused"]),
            /--confirm can only be used with --set/
        );
        for (const argv of [
            ["--status", "--thread", "7"],
            ["--start", "--thread", "7"],
            ["--breakpoints", "--thread", "7"],
            ["--add-breakpoint", "--function", "main", "--thread", "7"]
        ]) {
            assert.throws(() => debugSkill.args(argv), /--thread can only be used with debug control actions/);
        }
        assert.deepStrictEqual(debugSkill.request(debugSkill.args(["--pause", "--thread", "7"])), {
            method: "debug.control",
            params: { action: "pause", threadId: 7 }
        });
        assert.throws(() => debugSkill.args(["--pause", "--thread", "0"]), /--thread must be a positive integer/);
        assert.deepStrictEqual(debugSkill.request(debugSkill.args(["--start", "--attach"])), {
            method: "debug.start",
            params: { attach: true }
        });
        assert.deepStrictEqual(debugSkill.request(debugSkill.args(["--start"])), { method: "debug.start", params: {} });
        assert.throws(() => debugSkill.args(["--pause", "--attach"]), /--attach can only be used with --start/);

        const listed = JSON.parse(
            (await execFileAsync(process.execPath, [peripheral, "--workspace", workspace, "--list", "--query", "gpio"]))
                .stdout
        );
        assert.strictEqual(listed.method, "peripherals.list");
        assert.strictEqual(listed.params.query, "gpio");

        const read = JSON.parse(
            (
                await execFileAsync(process.execPath, [
                    peripheral,
                    "--workspace",
                    workspace,
                    "--read",
                    "GPIOA.MODER,USART1.SR"
                ])
            ).stdout
        );
        assert.deepStrictEqual(read.params.targets, ["GPIOA.MODER", "USART1.SR"]);

        const requested = JSON.parse(
            (
                await execFileAsync(process.execPath, [
                    peripheral,
                    "--workspace",
                    workspace,
                    "--set",
                    "GPIOA.MODER.MODE0=Output"
                ])
            ).stdout
        );
        assert.strictEqual(requested.confirmationRequired, true);
        const confirmed = JSON.parse(
            (
                await execFileAsync(process.execPath, [
                    peripheral,
                    "--workspace",
                    workspace,
                    "--set",
                    "GPIOA.MODER.MODE0=Output",
                    "--confirm",
                    "peripheral-confirm"
                ])
            ).stdout
        );
        assert.strictEqual(confirmed.params.confirmationId, "peripheral-confirm");
        assert.deepStrictEqual(confirmed.params.writes, [{ target: "GPIOA.MODER.MODE0", value: "Output" }]);

        let diagnostic;
        try {
            await execFileAsync(process.execPath, [peripheral, "--workspace", workspace, "--read", "RUNNING"]);
        } catch (error) {
            diagnostic = JSON.parse(error.stderr);
        }
        assert.strictEqual(diagnostic.error.code, "TARGET_NOT_PAUSED");
        assert.strictEqual(diagnostic.error.category, "debug_state");

        const status = JSON.parse(
            (await execFileAsync(process.execPath, [debug, "--workspace", workspace, "--status"])).stdout
        );
        assert.strictEqual(status.method, "debug.status");
        const paused = JSON.parse(
            (await execFileAsync(process.execPath, [debug, "--workspace", workspace, "--pause"])).stdout
        );
        assert.deepStrictEqual(paused.params, { action: "pause" });
        const source = JSON.parse(
            (
                await execFileAsync(process.execPath, [
                    debug,
                    "--workspace",
                    workspace,
                    "--add-breakpoint",
                    "--source",
                    "src/main.c",
                    "--line",
                    "42",
                    "--condition",
                    "counter > 3"
                ])
            ).stdout
        );
        assert.strictEqual(source.method, "debug.breakpoints.update");
        assert.strictEqual(source.params.type, "source");
        assert.strictEqual(source.params.line, 42);
        assert.strictEqual(source.params.condition, "counter > 3");
        const fn = JSON.parse(
            (
                await execFileAsync(process.execPath, [
                    debug,
                    "--workspace",
                    workspace,
                    "--remove-breakpoint",
                    "--function",
                    "main"
                ])
            ).stdout
        );
        assert.strictEqual(fn.params.action, "remove");
        assert.strictEqual(fn.params.function, "main");
        assert(calls.some((entry) => entry.method === "peripherals.write"));
        assert(calls.some((entry) => entry.method === "debug.breakpoints.update"));
    } finally {
        await bridge.stop();
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    }
    console.log("New Agent Skills tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
