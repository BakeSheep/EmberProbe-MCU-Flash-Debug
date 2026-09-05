"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { AgentBridge, stringifyJson } = require("../src/agentBridge");
const { call, descriptor: descriptorOf, diagnosticForError } = require("../skills/_emberprobe/agent-client");
const configSkill = require("../skills/mcu-config/scripts/config");
const liveSkill = require("../skills/mcu-variables/scripts/read");
const { LiveWatchSession } = require("../src/liveWatch");
const execFileAsync = promisify(execFile);

(async () => {
    const extensionManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    assert.ok(
        extensionManifest.activationEvents.includes("onStartupFinished"),
        "workspace Agent Skills require startup detection before they can connect to the Bridge"
    );
    assert.deepStrictEqual(configSkill.parseSet("debugger=cmsis-dap.cfg,mcu=stm32f4x.cfg"), {
        debugger: "cmsis-dap.cfg",
        mcu: "stm32f4x.cfg"
    });
    assert.throws(() => configSkill.parseSet("broken"), /Invalid assignment/);
    assert.deepStrictEqual(liveSkill.variableSpecs("tick,sinx:f32"), [{ name: "tick" }, { name: "sinx", type: "f32" }]);
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-output-boundary-"));
    try {
        assert.strictEqual(
            liveSkill.workspaceOutputPath(outputRoot, "exports/live.csv"),
            path.join(fs.realpathSync(outputRoot), "exports", "live.csv")
        );
        assert.throws(
            () => liveSkill.workspaceOutputPath(outputRoot, path.join(os.tmpdir(), "outside.csv")),
            (error) => error.code === "PATH_OUTSIDE_WORKSPACE"
        );
        assert.throws(
            () => liveSkill.workspaceOutputPath(outputRoot, "../outside.csv"),
            (error) => error.code === "PATH_OUTSIDE_WORKSPACE"
        );
        const actualDirectory = path.join(outputRoot, "actual");
        fs.mkdirSync(actualDirectory);
        const aliasDirectory = path.join(outputRoot, "alias");
        fs.symlinkSync(actualDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
        assert.strictEqual(
            liveSkill.workspaceOutputPath(aliasDirectory, "watch.csv"),
            path.join(fs.realpathSync(actualDirectory), "watch.csv"),
            "workspace aliases must return the canonical output path"
        );
    } finally {
        fs.rmSync(outputRoot, { recursive: true, force: true });
    }
    const targetDiagnostic = diagnosticForError(
        Object.assign(new Error("cannot read IDR"), {
            code: "TARGET_NOT_CONNECTED",
            details: { openocdTail: ["Error: cannot read IDR"] }
        }),
        { operation: "variables.trend" }
    );
    assert.strictEqual(targetDiagnostic.type, "diagnostic");
    assert.strictEqual(targetDiagnostic.error.category, "target_connection");
    assert.strictEqual(targetDiagnostic.operation, "variables.trend");
    const unknownTypeDiagnostic = diagnosticForError(
        Object.assign(new Error("missing DWARF type"), { code: "WRITE_TYPE_UNKNOWN" })
    );
    assert.strictEqual(unknownTypeDiagnostic.error.category, "write_safety");
    assert.strictEqual(unknownTypeDiagnostic.error.retryable, false);
    const changedElfDiagnostic = diagnosticForError(
        Object.assign(new Error("ELF changed"), { code: "ELF_CHANGED_DURING_WRITE_CONFIRMATION" })
    );
    assert.strictEqual(changedElfDiagnostic.error.category, "write_safety");
    assert.strictEqual(changedElfDiagnostic.error.retryable, false);
    const invalidPeripheralValueDiagnostic = diagnosticForError(
        Object.assign(new Error("invalid enum"), { code: "INVALID_PERIPHERAL_WRITE_VALUE" })
    );
    assert.strictEqual(invalidPeripheralValueDiagnostic.error.category, "peripheral_value");
    assert.strictEqual(invalidPeripheralValueDiagnostic.error.retryable, false);
    const missingSvdTargetDiagnostic = diagnosticForError(
        Object.assign(new Error("missing targets"), { code: "SVD_TARGET_NOT_FOUND" })
    );
    assert.ok(missingSvdTargetDiagnostic.error.suggestedActions.some((action) => action.includes("invalidTargets")));
    const debugTimeoutDiagnostic = diagnosticForError(
        Object.assign(new Error("timeout"), { code: "DEBUG_CONTROL_TIMEOUT" })
    );
    assert.ok(
        debugTimeoutDiagnostic.error.suggestedActions.some(
            (action) => action.includes("--stop") && action.includes("--start")
        )
    );
    assert.deepStrictEqual(JSON.parse(stringifyJson({ nan: NaN, pos: Infinity, neg: -Infinity })), {
        nan: "NaN",
        pos: "Infinity",
        neg: "-Infinity"
    });
    assert.deepStrictEqual(liveSkill.exportRange({ last: "10" }, 20000), { from: 10000, to: 20000 });
    assert.deepStrictEqual(liveSkill.exportRange({ from: "1000000000000", to: "2000000000000" }, 0), {
        from: 1000000000000,
        to: 2000000000000
    });
    const localClockRange = liveSkill.exportRange({ from: "12:43", to: "12:44" }, Date.UTC(2026, 7, 24));
    const localClockDetails = liveSkill.exportRangeDetails({ from: "12:43", to: "12:44" }, localClockRange);
    assert.strictEqual(localClockDetails.bareClockUsesLocalTime, true);
    assert.ok(localClockDetails.resolvedUtc.from.endsWith("Z") && localClockDetails.localTimeZone);
    assert.ok(localClockDetails.guidance.includes("ISO 8601"));
    assert.throws(
        () => liveSkill.exportRange({ from: "2026-08-24T12:00:00Z", to: "2026-08-24T11:00:00Z" }),
        /must not be later/
    );

    const rising = liveSkill.summarize([
        { timestamp: 0, value: 1 },
        { timestamp: 1000, value: 2 },
        { timestamp: 2000, value: 3 }
    ]);
    assert.strictEqual(rising.direction, "rising");
    assert.strictEqual(rising.slopePerSecond, 1);
    assert.strictEqual(
        liveSkill.summarize([
            { timestamp: 0, value: 5 },
            { timestamp: 1000, value: 5 }
        ]).direction,
        "stable"
    );
    assert.strictEqual(
        liveSkill.summarize([
            { timestamp: 0, value: 1 },
            { timestamp: 1000, value: 5 },
            { timestamp: 2000, value: 1 },
            { timestamp: 3000, value: 5 }
        ]).direction,
        "volatile"
    );

    const session = new LiveWatchSession(null, {}, {});
    session.socket = { destroyed: false };
    session._readMemoryBytes = async (address, count) =>
        address === 0x20000000 ? [0x2a, 0, 0, 0].slice(0, count) : null;
    const once = await session.readOnce([{ name: "Tick", address: 0x20000000, size: 4 }]);
    assert.deepStrictEqual(once[0].bytes, [0x2a, 0, 0, 0]);
    assert.deepStrictEqual(session.watch, [], "one-shot reads must not modify the UI watch list");

    const freePort = await require("../src/liveWatch").findFreePort();
    assert.ok(Number.isInteger(freePort) && freePort > 0 && freePort < 65536, "findFreePort must return a valid port");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-bridge-"));
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-bridge-storage-"));
    // 捕获 chip.read 实际收到的参数，验证 --fields 单独使用时不会回落到 identity 组
    const chipReadParams = [];
    const csvExportParams = [];
    const watchAddParams = [];
    const bridge = new AgentBridge(
        root,
        async (method, params) => {
            if (method === "config.set") {
                // 与扩展端 _setAgentConfiguration 相同的守卫：openocdPath 不允许经 Agent Bridge 修改
                require("../src/services/configurationStore").assertAgentSettable(params.values || {});
                return { updated: true };
            }
            if (method === "chip.read") {
                chipReadParams.push(params);
                return { core: "M4", chip: "STM32F407", deviceId: "0x463", flashSize: "1024 KB" };
            }
            if (method === "watch.add") {
                watchAddParams.push(params);
                return { method, params };
            }
            if (method === "variables.write") {
                if (!params.confirmationId)
                    return {
                        confirmationRequired: true,
                        confirmationId: "test-confirmation",
                        choices: ["once", "workspace"],
                        items: [{ name: "kp", address: "0x20000000", type: "f32", value: 0.5 }]
                    };
                if (params.confirmationId !== "test-confirmation")
                    throw Object.assign(new Error("Invalid confirmation"), { code: "WRITE_CONFIRMATION_INVALID" });
                return {
                    source: "temporary-probe",
                    elf: { path: "firmware.elf", sha256: "test" },
                    results: [
                        {
                            name: "kp",
                            resolvedName: "kp",
                            address: "0x20000000",
                            type: "f32",
                            previous: 0.2,
                            written: 0.5,
                            readBack: 0.5,
                            verified: true
                        }
                    ],
                    permission: { mode: params.remember ? "workspace" : "once", trusted: !!params.remember }
                };
            }
            if (method === "variables.exportCsv") {
                csvExportParams.push(params);
                if (params.variables.includes("empty")) {
                    throw Object.assign(new Error("The selected range has no chart samples"), {
                        code: "CSV_EXPORT_EMPTY",
                        details: { availableRange: { from: 1000, to: 2000 } }
                    });
                }
                return {
                    panelId: params.panelId || 1,
                    names: params.variables.length ? params.variables : ["Tick", "sinx"],
                    from: params.from || 1000,
                    to: params.to,
                    seriesCount: params.variables.length || 2,
                    rowCount: 2,
                    csv: "\uFEFFtime,Tick\r\n1970-01-01T00:00:01.000Z,1\r\n"
                };
            }
            if (method === "variables.write.permission") return { trusted: false, scope: "workspace" };
            if (method === "fault.read") {
                return {
                    targetState: "halted",
                    faultDetected: true,
                    faults: [{ register: "CFSR", flag: "PRECISERR", group: "bus", faultAddress: "0x60000000" }],
                    exception: { number: 3, name: "HardFault" },
                    pc: "0x08000012",
                    pcSymbol: "uart_send+0x12",
                    symbolication: "ok"
                };
            }
            if (method === "elf.analyze") {
                return {
                    flash: { total: 0x110 },
                    ram: { total: 0x30 },
                    topSymbols: [],
                    requestedTop: params.top ?? null
                };
            }
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
                    {
                        timestamp: 1000,
                        values: { Tick: { requestedName: "tick", value: 1, type: "u32", address: "0x20000000" } }
                    },
                    {
                        timestamp: 2000,
                        values: { Tick: { requestedName: "tick", value: 2, type: "u32", address: "0x20000000" } }
                    },
                    {
                        timestamp: 3000,
                        values: { Tick: { requestedName: "tick", value: 3, type: "u32", address: "0x20000000" } }
                    }
                ]
            };
        },
        storageDir
    );
    try {
        const obsoletePointer = path.join(root, ".emberprobe", "agent-bridge.json");
        fs.mkdirSync(path.dirname(obsoletePointer), { recursive: true });
        fs.writeFileSync(obsoletePointer, "{}");
        const descriptor = await bridge.start();
        assert.ok(descriptor.port > 0);
        assert.ok(
            !fs.existsSync(path.join(root, ".emberprobe")),
            "starting the new Bridge must remove the empty legacy pointer directory"
        );
        // 描述文件（含 token）必须落在用户目录而非工作区；工作区只留指针
        assert.deepStrictEqual(descriptor, JSON.parse(fs.readFileSync(bridge.descriptorPath, "utf8")));
        assert.ok(bridge.descriptorPath.startsWith(storageDir), "descriptor must live in the storage dir");
        const pointer = JSON.parse(
            fs.readFileSync(path.join(root, ".agents", "skills", "_emberprobe", "agent-bridge.json"), "utf8")
        );
        assert.strictEqual(pointer.descriptorPath, bridge.descriptorPath);
        assert.ok(!pointer.token, "workspace pointer must never contain the bridge token");
        const result = await call(root, "config.get", { test: true });
        assert.deepStrictEqual(result, { method: "config.get", params: { test: true } });
        const fastPath = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--variables",
            "tick,sinx"
        ]);
        const fastPayload = JSON.parse(fastPath.stdout);
        assert.strictEqual(fastPayload.method, "variables.read");
        assert.deepStrictEqual(fastPayload.params.variables, [{ name: "tick" }, { name: "sinx" }]);
        const inferredAdd = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--variables",
            "g_f32,g_f64",
            "--add-to",
            "chart"
        ]);
        const inferredAddPayload = JSON.parse(inferredAdd.stdout);
        assert.strictEqual(inferredAddPayload.method, "watch.add");
        assert.deepStrictEqual(
            inferredAddPayload.params.types,
            {},
            "--add-to without suffixes must let the extension use DWARF types"
        );
        const explicitAdd = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--variables",
            "g_f32:f32,g_f64:f64",
            "--add-to",
            "chart"
        ]);
        const explicitAddPayload = JSON.parse(explicitAdd.stdout);
        assert.deepStrictEqual(explicitAddPayload.params.types, { g_f32: "f32", g_f64: "f64" });
        const countedAdd = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--variables",
            "g_f32",
            "--add-to",
            "chart",
            "--count",
            "2",
            "--interval",
            "20"
        ]);
        assert.ok(
            countedAdd.stdout
                .split("\n")
                .filter(Boolean)
                .every((line) => JSON.parse(line).type === "sample")
        );
        assert.deepStrictEqual(
            watchAddParams.at(-1).types,
            {},
            "combined --add-to/--count must still defer type resolution to DWARF"
        );
        const csvRead = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--export-csv",
            "--variables",
            "Tick",
            "--last",
            "10",
            "--panel",
            "1"
        ]);
        const csvReadPayload = JSON.parse(csvRead.stdout);
        assert.strictEqual(csvReadPayload.type, "csvExport");
        assert.ok(csvReadPayload.csv.startsWith("\uFEFFtime,Tick"));
        assert.strictEqual(csvReadPayload.requestedRange.resolvedUtc.to.endsWith("Z"), true);
        assert.deepStrictEqual(csvExportParams.at(-1).variables, ["Tick"]);
        assert.strictEqual(csvExportParams.at(-1).panelId, 1);
        assert.strictEqual(csvExportParams.at(-1).to - csvExportParams.at(-1).from, 10000);
        const csvOutput = path.join(root, "exports", "watch.csv");
        const csvWrite = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--export-csv",
            "--output",
            "exports/watch.csv"
        ]);
        const csvWritePayload = JSON.parse(csvWrite.stdout);
        assert.strictEqual(csvWritePayload.output, fs.realpathSync(csvOutput));
        assert.ok(
            !Object.prototype.hasOwnProperty.call(csvWritePayload, "csv"),
            "file exports should return metadata instead of duplicating CSV text"
        );
        assert.ok(fs.readFileSync(csvOutput, "utf8").startsWith("\uFEFFtime,Tick"));
        let emptyCsvDiagnostic;
        try {
            await execFileAsync(process.execPath, [
                path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
                "--workspace",
                root,
                "--export-csv",
                "--variables",
                "empty",
                "--from",
                "12:43",
                "--to",
                "12:44"
            ]);
        } catch (error) {
            emptyCsvDiagnostic = JSON.parse(error.stderr);
        }
        assert.strictEqual(emptyCsvDiagnostic.error.code, "CSV_EXPORT_EMPTY");
        assert.strictEqual(emptyCsvDiagnostic.error.details.requestedRange.bareClockUsesLocalTime, true);
        assert.ok(emptyCsvDiagnostic.error.details.requestedRange.resolvedUtc.from.endsWith("Z"));
        assert.ok(emptyCsvDiagnostic.error.suggestedActions[0].includes("ISO 8601 UTC"));

        // —— mcu-chip-info：--fields 单独使用时 sections 必须为空，否则扩展端会把 identity 整组字段并回结果 ——
        await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-chip-info/scripts/read-chip.js"),
            "--workspace",
            root,
            "--fields",
            "deviceId"
        ]);
        assert.deepStrictEqual(chipReadParams.at(-1), { sections: [], fields: ["deviceId"] });
        await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-chip-info/scripts/read-chip.js"),
            "--workspace",
            root
        ]);
        assert.deepStrictEqual(chipReadParams.at(-1), { sections: ["identity"], fields: [] });
        const trendPath = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
            "--workspace",
            root,
            "--variables",
            "tick",
            "--trend",
            "--count",
            "3",
            "--interval",
            "20"
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
                path.resolve(__dirname, "../skills/mcu-variables/scripts/read.js"),
                "--workspace",
                root,
                "--variables",
                "disconnected",
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
        assert.ok(fs.existsSync(path.join(root, ".agents", "skills", "_emberprobe", "agent-bridge.json")));

        // Bridge 侧 config.set 拒绝修改 openocdPath：该键可把探针调用引向任意可执行文件
        let forbidden;
        try {
            await call(root, "config.set", { values: { openocdPath: "/tmp/evil" } });
        } catch (error) {
            forbidden = error;
        }
        assert.ok(forbidden, "config.set with openocdPath must fail");
        assert.strictEqual(forbidden.code, "CONFIG_KEY_FORBIDDEN");
        const forbiddenDiagnostic = diagnosticForError(forbidden);
        assert.strictEqual(forbiddenDiagnostic.error.code, "CONFIG_KEY_FORBIDDEN");
        assert.strictEqual(forbiddenDiagnostic.error.retryable, false);
        assert.ok(forbiddenDiagnostic.error.suggestedActions.length > 0);

        // —— mcu-variables 写入：先返回聊天确认，再凭一次性 ID 写入并记住工作区授权 ——
        const writeRequest = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/write.js"),
            "--workspace",
            root,
            "--set",
            "kp=0.5"
        ]);
        const confirmation = JSON.parse(writeRequest.stdout);
        assert.strictEqual(confirmation.confirmationRequired, true);
        assert.strictEqual(confirmation.confirmationId, "test-confirmation");
        const writeOk = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/write.js"),
            "--workspace",
            root,
            "--set",
            "kp=0.5",
            "--confirm",
            confirmation.confirmationId,
            "--remember"
        ]);
        const writePayload = JSON.parse(writeOk.stdout);
        assert.strictEqual(writePayload.results[0].verified, true);
        assert.strictEqual(writePayload.results[0].written, 0.5);
        assert.strictEqual(writePayload.permission.mode, "workspace");
        const reset = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-variables/scripts/write.js"),
            "--workspace",
            root,
            "--reset-permission"
        ]);
        assert.deepStrictEqual(JSON.parse(reset.stdout), { trusted: false, scope: "workspace" });

        // —— mcu-fault-analyzer ——
        const faultOut = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-fault-analyzer/scripts/analyze-fault.js"),
            "--workspace",
            root
        ]);
        const faultPayload = JSON.parse(faultOut.stdout);
        assert.strictEqual(faultPayload.faultDetected, true);
        assert.strictEqual(faultPayload.faults[0].flag, "PRECISERR");
        assert.strictEqual(faultPayload.pcSymbol, "uart_send+0x12");

        // —— mcu-elf-analyze（含 --top 透传） ——
        const elfOut = await execFileAsync(process.execPath, [
            path.resolve(__dirname, "../skills/mcu-elf-analyze/scripts/analyze-elf.js"),
            "--workspace",
            root,
            "--top",
            "5"
        ]);
        const elfPayload = JSON.parse(elfOut.stdout);
        assert.strictEqual(elfPayload.flash.total, 0x110);
        assert.strictEqual(elfPayload.requestedTop, 5);

        // 停止 Bridge 后描述文件与工作区指针一并清理
        await bridge.stop();
        assert.ok(!fs.existsSync(bridge.descriptorPath), "descriptor must be removed on stop");
        assert.ok(
            !fs.existsSync(path.join(root, ".agents", "skills", "_emberprobe", "agent-bridge.json")),
            "pointer must be removed on stop"
        );
        assert.ok(
            !fs.existsSync(path.join(root, ".agents", "skills", "_emberprobe")),
            "empty bridge runtime directory must be removed on stop"
        );

        // 目录内存在用户文件时只删指针，不删用户内容或非空目录。
        await bridge.start();
        const keepFile = path.join(root, ".agents", "skills", "_emberprobe", "keep.txt");
        fs.writeFileSync(keepFile, "keep");
        await bridge.stop();
        assert.strictEqual(fs.readFileSync(keepFile, "utf8"), "keep");

        // 旧格式兼容：工作区描述文件直接含 token（旧版扩展写入）时，agent-client 仍可原地读取
        const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-bridge-legacy-"));
        try {
            const legacyFile = path.join(legacyRoot, ".emberprobe", "agent-bridge.json");
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
            fs.writeFileSync(legacyFile, JSON.stringify({ host: "127.0.0.1", port: 61234, token: "legacy-token" }));
            const legacy = descriptorOf(legacyRoot);
            assert.strictEqual(legacy.port, 61234);
            assert.strictEqual(legacy.token, "legacy-token");
        } finally {
            fs.rmSync(legacyRoot, { recursive: true, force: true });
        }
    } finally {
        await bridge.stop();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    }

    console.log("Agent Skills tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
