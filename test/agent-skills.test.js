"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { AgentBridge } = require("../src/agentBridge");
const { call, diagnosticForError } = require("../skills/_emberprobe/agent-client");
const configSkill = require("../skills/mcu-config/scripts/config");
const liveSkill = require("../skills/mcu-live-watch/scripts/read-live");
const { LiveWatchSession } = require("../src/liveWatch");
const execFileAsync = promisify(execFile);

(async () => {
    assert.deepStrictEqual(configSkill.parseSet("debugger=cmsis-dap.cfg,mcu=stm32f4x.cfg"), {
        debugger: "cmsis-dap.cfg", mcu: "stm32f4x.cfg"
    });
    assert.throws(() => configSkill.parseSet("broken"), /Invalid assignment/);
    assert.deepStrictEqual(liveSkill.variableSpecs("tick,sinx:f32"), [
        { name: "tick" }, { name: "sinx", type: "f32" }
    ]);
    const targetDiagnostic = diagnosticForError(Object.assign(new Error("cannot read IDR"), {
        code: "TARGET_NOT_CONNECTED",
        details: { openocdTail: ["Error: cannot read IDR"] }
    }), { operation: "variables.trend" });
    assert.strictEqual(targetDiagnostic.type, "diagnostic");
    assert.strictEqual(targetDiagnostic.error.category, "target_connection");
    assert.strictEqual(targetDiagnostic.operation, "variables.trend");

    const rising = liveSkill.summarize([
        { timestamp: 0, value: 1 },
        { timestamp: 1000, value: 2 },
        { timestamp: 2000, value: 3 }
    ]);
    assert.strictEqual(rising.direction, "rising");
    assert.strictEqual(rising.slopePerSecond, 1);
    assert.strictEqual(liveSkill.summarize([
        { timestamp: 0, value: 5 },
        { timestamp: 1000, value: 5 }
    ]).direction, "stable");
    assert.strictEqual(liveSkill.summarize([
        { timestamp: 0, value: 1 },
        { timestamp: 1000, value: 5 },
        { timestamp: 2000, value: 1 },
        { timestamp: 3000, value: 5 }
    ]).direction, "volatile");

    const session = new LiveWatchSession(null, {}, {});
    session.socket = { destroyed: false };
    session._readMemoryBytes = async (address, count) =>
        address === 0x20000000 ? [0x2a, 0, 0, 0].slice(0, count) : null;
    const once = await session.readOnce([{ name: "Tick", address: 0x20000000, size: 4 }]);
    assert.deepStrictEqual(once[0].bytes, [0x2a, 0, 0, 0]);
    assert.deepStrictEqual(session.watch, [], "one-shot reads must not modify the UI watch list");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-bridge-"));
    const bridge = new AgentBridge(root, async (method, params) => {
        if (method !== "variables.sample") return { method, params };
        if (params.variables?.[0]?.name === "disconnected") {
            throw Object.assign(new Error("调试器已启动，但无法与目标 MCU 建立 SWD/JTAG 连接。"), {
                code: "TARGET_NOT_CONNECTED",
                category: "target_connection",
                stage: "openocd_start",
                likelyCause: "目标 MCU 未连接。",
                retryable: true,
                suggestedActions: ["检查 SWD 接线。"],
                details: { openocdTail: ["Error: cannot read IDR"] }
            });
        }
        return {
            source: "temporary-probe",
            elf: { path: "firmware.elf", sha256: "test" },
            samples: [
                { timestamp: 1000, values: { Tick: { requestedName: "tick", value: 1, type: "u32", address: "0x20000000" } } },
                { timestamp: 2000, values: { Tick: { requestedName: "tick", value: 2, type: "u32", address: "0x20000000" } } },
                { timestamp: 3000, values: { Tick: { requestedName: "tick", value: 3, type: "u32", address: "0x20000000" } } }
            ]
        };
    });
    try {
        const descriptor = await bridge.start();
        assert.ok(descriptor.port > 0);
        const result = await call(root, "config.get", { test: true });
        assert.deepStrictEqual(result, { method: "config.get", params: { test: true } });
        const fastPath = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-live-watch/scripts/read-live.js"),
            "--workspace", root,
            "--variables", "tick,sinx"
        ]);
        const fastPayload = JSON.parse(fastPath.stdout);
        assert.strictEqual(fastPayload.method, "variables.read");
        assert.deepStrictEqual(fastPayload.params.variables, [{ name: "tick" }, { name: "sinx" }]);
        const trendPath = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-live-watch/scripts/read-live.js"),
            "--workspace", root,
            "--variables", "tick",
            "--trend",
            "--count", "3",
            "--interval", "20"
        ]);
        const trendPayload = JSON.parse(trendPath.stdout);
        assert.strictEqual(trendPayload.type, "trend");
        assert.strictEqual(trendPayload.source, "temporary-probe");
        assert.strictEqual(trendPayload.sampleCount, 3);
        assert.strictEqual(trendPayload.latest.Tick.value, 3);
        assert.strictEqual(trendPayload.trends.Tick.direction, "rising");
        let failedTrend;
        try {
            await execFileAsync(process.execPath, [
                path.resolve(__dirname, "../skills/mcu-live-watch/scripts/read-live.js"),
                "--workspace", root,
                "--variables", "disconnected",
                "--trend"
            ]);
        } catch (error) {
            failedTrend = JSON.parse(error.stderr);
        }
        assert.ok(failedTrend, "failed trend should emit a JSON diagnostic");
        assert.strictEqual(failedTrend.type, "diagnostic");
        assert.strictEqual(failedTrend.operation, "variables.trend");
        assert.strictEqual(failedTrend.error.code, "TARGET_NOT_CONNECTED");
        assert.strictEqual(failedTrend.error.details.openocdTail[0], "Error: cannot read IDR");
        assert.ok(fs.existsSync(path.join(root, ".emberprobe", "agent-bridge.json")));
    } finally {
        await bridge.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log("Agent Skills tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
