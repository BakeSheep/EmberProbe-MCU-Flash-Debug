"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createLogMonitor } = require("../src/services/cubemxLog");
const { hash, preserveTextFormatting, assertUserCodePreserved } = require("../src/services/cubemxProject");
const { CubeMxService } = require("../src/services/cubemxService");
const entry = (text) => ({ bytes: Buffer.from(text), hash: hash(text) });
const parseLog = (stdout, stderr = "") => {
    const monitor = createLogMonitor();
    // Include chunk boundaries inside commands, UTF-8 and CRLF.
    const bytes = Buffer.from(stdout);
    const chunkSize = bytes.length > 65536 ? 4093 : 17;
    for (let i = 0; i < bytes.length; i += chunkSize) monitor.stdout(bytes.subarray(i, i + chunkSize));
    monitor.stderr(Buffer.from(stderr));
    return monitor.finish();
};

(async () => {
    const noise = "[INFO] loading a pack\n".repeat(60000);
    const success = "project generate\r\nGenerated code: 中文/Core/Src/main.c\r\nOK\r\nexit\r\n";
    assert(parseLog(success).confirmed);
    assert.deepStrictEqual(parseLog(success).generatedFiles, ["中文/Core/Src/main.c"]);
    const earlyError = parseLog("[ERROR] failure at start\n" + noise + success);
    assert(earlyError.failureLine.includes("failure at start"));
    assert(earlyError.diagnostic.length <= 16384);
    assert(!earlyError.log.includes("failure at start"));
    assert(parseLog("project generate\n" + noise + "OK\nexit").confirmed);
    assert(parseLog(success, "[FATAL] Unable to create output\n").failureLine);
    assert(!parseLog("0 errors, 0 failed\n" + success).failureLine);
    assert(!parseLog("project generate\nexit\nOK").confirmed);
    assert(!parseLog("project generate\n", "OK\n").confirmed);
    assert(parseLog("x".repeat(70000) + "\n" + success).failureLine);
    assert(!parseLog("project generate\nOK\nproject generate\nexit").confirmed);

    for (const extension of ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx"]) {
        const before = new Map([
            ["main." + extension, entry("/* USER CODE BEGIN 0 */\r\nkeep();\r\n/* USER CODE END 0 */")]
        ]);
        assert.throws(() => assertUserCodePreserved(before, new Map()), { code: "CUBEMX_USER_CODE_CHANGED" });
        assertUserCodePreserved(before, before);
    }
    const old = new Map([
        ["main.c", entry("init();\r\n")],
        [".mxproject", entry("SourceFiles=Core/Src/main.c;\r\nFlag=true\r\n")],
        ["blob.bin", entry("a\r\n")]
    ]);
    const next = new Map([
        ["main.c", entry("init();\n")],
        [".mxproject", entry("SourceFiles=Core\\Src\\main.c;\nFlag=true\n")],
        ["blob.bin", entry("a\n")]
    ]);
    const normalized = preserveTextFormatting(old, next);
    assert.strictEqual(normalized.get("main.c"), old.get("main.c"));
    assert.strictEqual(normalized.get(".mxproject"), old.get(".mxproject"));
    assert.strictEqual(normalized.get("blob.bin"), next.get("blob.bin"));
    next.set("main.c", entry("newInit();\n"));
    next.set(".mxproject", entry("SourceFiles=Core/Src/other.c;\nFlag=true\n"));
    const changed = preserveTextFormatting(old, next);
    assert.strictEqual(changed.get("main.c").bytes.toString(), "newInit();\r\n");
    assert.notStrictEqual(changed.get(".mxproject").hash, old.get(".mxproject").hash);
    const metadataBefore = new Map([
        [".mxproject", entry("[A]\nSourceFiles=Core/Src/main.c;\nFlag=true\n[B]\nValue=1\n")]
    ]);
    const metadataAfter = new Map([
        [".mxproject", entry("[B]\nValue=1\n[A]\nFlag=true\nSourceFiles=Core\\Src\\main.c;\n")]
    ]);
    assert.strictEqual(
        preserveTextFormatting(metadataBefore, metadataAfter).get(".mxproject"),
        metadataBefore.get(".mxproject")
    );
    metadataAfter.set(".mxproject", entry("[A]\nFlag=true\nFlag=false\n"));
    assert.strictEqual(
        preserveTextFormatting(metadataBefore, metadataAfter).get(".mxproject"),
        metadataAfter.get(".mxproject")
    );
    const inventory = new Map([[".mxproject", entry("[PreviousLibFiles]\nLibFiles=Drivers/a.h;Drivers/b.h;\n")]]);
    const reordered = new Map([[".mxproject", entry("[PreviousLibFiles]\nLibFiles=Drivers\\b.h;Drivers\\a.h;\n")]]);
    assert.strictEqual(preserveTextFormatting(inventory, reordered).get(".mxproject"), inventory.get(".mxproject"));

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-generation-safety-"));
    try {
        for (const underRoot of ["true", "false"]) {
            const project = path.join(root, underRoot);
            await fs.mkdir(path.join(project, "Core", "Src"), { recursive: true });
            const ioc = path.join(project, "demo.ioc");
            const content = `Mcu.Name=STM32F407VGTx\nMxCube.Version=6.18.1\nProjectManager.ProjectName=demo\nProjectManager.TargetToolchain=CMake\nProjectManager.KeepUserCode=true\nProjectManager.UnderRoot=${underRoot}\nProjectManager.MainLocation=Core/Src\nBaud=9600\n`;
            const main = path.join(project, "Core", "Src", "main.c");
            const user = "/* USER CODE BEGIN 0 */\r\nkeep();\r\n/* USER CODE END 0 */\r\n";
            await fs.writeFile(ioc, content);
            await fs.writeFile(main, user + "baud=9600;\r\n");
            await fs.writeFile(path.join(project, ".mxproject"), "SourceFiles=Core/Src/main.c;\r\n");
            await fs.writeFile(path.join(project, "CMakeLists.txt"), "target_sources(app PRIVATE stress_test.c)\r\n");
            await fs.mkdir(path.join(project, "cmake", "stm32cubemx"), { recursive: true });
            await fs.writeFile(
                path.join(project, "cmake", "stm32cubemx", "CMakeLists.txt"),
                "set(MX_Application_Src stress_test.c)\n"
            );
            const service = new CubeMxService({
                platform: "win32",
                storage: { get: () => undefined, update: async () => {} },
                config: () => ({ iocPath: ioc }),
                roots: () => [project],
                installation: async () => ({ version: "6.18.1" }),
                run: async () => ({ log: "project generate\nOK\nexit" })
            });
            const execute = async (candidate = content) => {
                const plan = await service.prepare({ content: candidate });
                return service.execute({ content: candidate, confirmationId: plan.confirmationId });
            };
            await assert.rejects(execute(content.replace("9600", "115200")), { code: "CUBEMX_OUTPUT_MISSING" });
            assert.strictEqual(await fs.readFile(ioc, "utf8"), content);
            service.options.run = async () => ({ generatedFiles: [path.join(project, "Core", "Src", "main.c")] });
            await assert.rejects(execute(), { code: "CUBEMX_OUTPUT_MISSING" });
            service.options.run = async (_tool, directory) => ({
                generatedFiles: [
                    path.join(directory, ...(underRoot === "false" ? ["demo"] : []), "Core", "Src", "main.c")
                ]
            });
            assert((await execute()).generated);
            const run = async (_tool, directory) => {
                const output = underRoot === "false" ? path.join(directory, "demo") : directory;
                const target = path.join(output, "Core", "Src", "main.c");
                assert((await fs.readFile(target, "utf8")).includes("keep();"));
                const candidate = await fs.readFile(path.join(output, "demo.ioc"), "utf8");
                await fs.writeFile(target, user.replace(/\r\n/g, "\n") + `baud=${candidate.match(/Baud=(\d+)/)[1]};\n`);
                await fs.writeFile(path.join(output, ".mxproject"), "SourceFiles=Core\\Src\\main.c;\n");
                return {};
            };
            service.options.run = async (...args) => {
                await run(...args);
                const output = underRoot === "false" ? path.join(args[1], "demo") : args[1];
                await fs.writeFile(path.join(output, "CMakeLists.txt"), "target_sources(app PRIVATE)\n");
                await fs.writeFile(
                    path.join(output, "cmake", "stm32cubemx", "CMakeLists.txt"),
                    "set(MX_Application_Src)\n"
                );
                return {};
            };
            await assert.rejects(execute(), (error) => {
                assert.strictEqual(error.code, "CUBEMX_BASELINE_DRIFT");
                assert(error.suggestedActions.some((action) => action.includes("top-level CMakeLists.txt")));
                return true;
            });
            assert((await fs.readFile(path.join(project, "CMakeLists.txt"), "utf8")).includes("stress_test.c"));
            service.options.run = run;
            const result = await execute(content.replace("9600", "115200"));
            assert(result.generated);
            assert.strictEqual(await fs.readFile(main, "utf8"), user + "baud=115200;\r\n");
            assert.strictEqual(
                await fs.readFile(path.join(project, ".mxproject"), "utf8"),
                "SourceFiles=Core/Src/main.c;\r\n"
            );
        }
        console.log("CubeMX generation safety, output freshness, formatting and streaming diagnostics passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

    await scenario("Stream classified CubeMX logs and close failed spawn log handles", async () => {
        const { EventEmitter } = require("events");
        const { runCubeMx } = require("../src/services/cubemxRunner");
        {
            const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-log-stream-"));
            try {
                const logPath = path.join(tmp, "streamed.log");
                const monitor = createLogMonitor({ logPath });
                // Normal WARN containing 'not found' must NOT set failureLine
                monitor.stdout(Buffer.from("[WARN] BankMapConfig not found\n"));
                monitor.stdout(Buffer.from("Some non-leveled file not found\n"));
                let result = monitor.finish();
                assert.strictEqual(result.failureLine, "");
                assert(result.warnings.some((w) => w.includes("BankMapConfig")));

                // Missing required firmware/dependency must set failureLine
                const monitor2 = createLogMonitor();
                monitor2.stdout(
                    Buffer.from("Firmware package STM32Cube_FW_F4_V1.28.0 not installed, please download\n")
                );
                assert(monitor2.finish().failureLine.includes("not installed"));

                // ERROR followed later by OK: failureLine is still set
                const monitor3 = createLogMonitor();
                monitor3.stdout(Buffer.from("[ERROR] compilation error\nproject generate\nOK\nexit\n"));
                const res3 = monitor3.finish();
                assert(res3.failureLine.includes("[ERROR]"));
                assert(res3.confirmed); // confirmed generate, but failureLine prevents clean success

                // Verify streaming to disk exists
                assert((await fs.readFile(logPath, "utf8")).includes("BankMapConfig"));

                // Overlong line
                const monitor4 = createLogMonitor();
                monitor4.stdout(Buffer.from("A".repeat(70000) + "\n"));
                assert(monitor4.finish().failureLine.includes("exceeds 64 KiB"));

                // runCubeMx process spawn error cleans up log fd
                const spawnErrLog = path.join(tmp, "spawn-err.log");
                const mockChild = new EventEmitter();
                mockChild.stdout = new EventEmitter();
                mockChild.stderr = new EventEmitter();
                mockChild.kill = () => {};
                const fakeSpawn = () => {
                    process.nextTick(() => mockChild.emit("error", new Error("java ENOENT")));
                    return mockChild;
                };
                await assert.rejects(
                    runCubeMx({ java: "java", executable: "cube.jar" }, tmp, "test.ioc", {
                        logPath: spawnErrLog,
                        spawn: fakeSpawn
                    }),
                    (err) => err.code === "CUBEMX_START_FAILED"
                );
                // File handle must be closed, so unlink will succeed without EBUSY on Windows
                await fs.unlink(spawnErrLog);
            } finally {
                await fs.rm(tmp, { recursive: true, force: true });
            }
        }
    });

    await scenario("Distinguish user code edits from generated edits and corrupt markers", async () => {
        const { classifyUserCodeChanges } = require("../src/services/cubemxOperations");
        {
            const validC = [
                "/* USER CODE BEGIN 0 */",
                "int a = 1;",
                "/* USER CODE END 0 */",
                "void init() {}",
                "/* USER CODE BEGIN 1 */",
                "int b = 2;",
                "/* USER CODE END 1 */"
            ].join("\n");

            const userModifiedC = [
                "/* USER CODE BEGIN 0 */",
                "int a = 999;",
                "/* USER CODE END 0 */",
                "void init() {}",
                "/* USER CODE BEGIN 1 */",
                "int b = 2;",
                "/* USER CODE END 1 */"
            ].join("\n");

            const generatedModifiedC = [
                "/* USER CODE BEGIN 0 */",
                "int a = 1;",
                "/* USER CODE END 0 */",
                "void init_renamed() {}",
                "/* USER CODE BEGIN 1 */",
                "int b = 2;",
                "/* USER CODE END 1 */"
            ].join("\n");

            const corruptedC = [
                "/* USER CODE BEGIN 0 */",
                "int a = 1;",
                "/* USER CODE BEGIN 0 */" // Duplicate
            ].join("\n");

            for (const { name, content, expected } of [
                {
                    name: "user code edit",
                    content: userModifiedC,
                    expected: { classifiable: true, generatedChanged: false, userChanged: true }
                },
                {
                    name: "generated code edit",
                    content: generatedModifiedC,
                    expected: { classifiable: true, generatedChanged: true }
                },
                { name: "duplicate user code marker", content: corruptedC, expected: { classifiable: false } }
            ]) {
                const result = classifyUserCodeChanges(validC, content);
                for (const [key, value] of Object.entries(expected)) {
                    assert.strictEqual(result[key], value, `${name}: ${key}`);
                }
            }
        }
    });

    await scenario("Recover interrupted operations after an extension restart", async () => {
        const { CubeMxOperationStore } = require("../src/services/cubemxOperations");
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-operation-restart-"));
        try {
            const project = path.join(root, "project");
            const storageDir = path.join(root, "storage");
            await fs.mkdir(project);

            // Extension restart: uncompleted operations marked interrupted
            const store = new CubeMxOperationStore(storageDir);
            const restartedOp = await store.createOperation(project, {
                type: "generate",
                stage: "baseline"
            });
            const restartedWritingOp = await store.createOperation(project, {
                type: "generate",
                stage: "writing"
            });
            // Create new store instance pointing to same storage to simulate restart
            const store2 = new CubeMxOperationStore(storageDir);
            const op1 = await store2.getOperation(project, restartedOp.operationId);
            assert.strictEqual(op1.status, "interrupted");
            assert.strictEqual(op1.sourceProjectStatus, "unchanged");

            const op2 = await store2.getOperation(project, restartedWritingOp.operationId);
            assert.strictEqual(op2.status, "interrupted");
            assert.strictEqual(op2.sourceProjectStatus, "unknown");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
    await scenario("Identify changed user code block names", async () => {
        const { changedUserCodeBlockNames } = require("../src/services/cubemxOperations");
        assert.deepStrictEqual(
            changedUserCodeBlockNames(
                "/* USER CODE BEGIN 0 */\nint a = 1;\n/* USER CODE END 0 */",
                "/* USER CODE BEGIN 0 */\nint a = 2;\n/* USER CODE END 0 */"
            ),
            ["0"]
        );
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
