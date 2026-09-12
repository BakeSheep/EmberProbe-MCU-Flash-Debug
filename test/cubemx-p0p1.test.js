"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createLogMonitor } = require("../src/services/cubemxLog");
const { runCubeMx } = require("../src/services/cubemxRunner");
const { CubeMxService } = require("../src/services/cubemxService");
const {
    deriveCandidate,
    generateCandidate,
    categorizeChanges,
    validateStructuralIoc
} = require("../src/services/cubemxCandidate");
const {
    CubeMxOperationStore,
    classifyUserCodeMarkers,
    classifyUserCodeChanges,
    changedUserCodeBlockNames
} = require("../src/services/cubemxOperations");
const { normalizeGenerated, stageGeneration, applyFiles, hash } = require("../src/services/cubemxProject");
const { args, resolveRequestId, requestFingerprint } = require("../skills/mcu-cubemx/scripts/cubemx");

// Mirrors computeParamsHash in cubemxService.js so tests can forge dedup records.
const paramsHash = (params) =>
    hash(
        JSON.stringify({
            candidatePath: params.candidatePath || "",
            content: params.content || "",
            mode: params.mode || "",
            confirmationId: params.confirmationId || "",
            remember: !!params.remember
        })
    );

async function until(condition, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error("condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sampleIoc = [
    "Mcu.Name=STM32F407VGTx",
    "Mcu.CPN=STM32F407VGT6",
    "Mcu.IPNb=2",
    "Mcu.IP0=RCC",
    "Mcu.IP1=USART1",
    "Mcu.PinNb=2",
    "Mcu.Pin0=PA9",
    "Mcu.Pin1=PA10",
    "PA9.Signal=USART1_TX",
    "PA10.Signal=USART1_RX",
    "MxCube.Version=6.12.0",
    "ProjectManager.ProjectName=demo",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
    "ProjectManager.UnderRoot=true",
    "ProjectManager.FirmwarePackage=STM32Cube_FW_F4_V1.28.0",
    "USART1.BaudRate=115200",
    ""
].join("\n");

(async () => {
    // ---------------------------------------------------------
    // 1. Log classification, layout diagnosis, streaming to disk
    // ---------------------------------------------------------
    {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-p0p1-log-"));
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
            monitor2.stdout(Buffer.from("Firmware package STM32Cube_FW_F4_V1.28.0 not installed, please download\n"));
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

    // ---------------------------------------------------------
    // 2. Candidate structural checks & categorized diff
    // ---------------------------------------------------------
    {
        // Contiguous IP sequence check
        const validValues = {
            "Mcu.IPNb": "2",
            "Mcu.IP0": "RCC",
            "Mcu.IP1": "USART1"
        };
        validateStructuralIoc(validValues);

        // Gap in IP sequence
        assert.throws(
            () => validateStructuralIoc({ "Mcu.IPNb": "2", "Mcu.IP0": "RCC" }),
            (err) => err.code === "CUBEMX_IOC_INVALID"
        );

        // Duplicate IP
        assert.throws(
            () => validateStructuralIoc({ "Mcu.IPNb": "2", "Mcu.IP0": "RCC", "Mcu.IP1": "RCC" }),
            (err) => err.code === "CUBEMX_IOC_INVALID"
        );

        // Orphaned IP
        assert.throws(
            () => validateStructuralIoc({ "Mcu.IPNb": "1", "Mcu.IP0": "RCC", "Mcu.IP1": "USART1" }),
            (err) => err.code === "CUBEMX_IOC_INVALID"
        );

        // Contiguous Mcu.PinsNb sequence check
        const validPins = {
            "Mcu.PinsNb": "2",
            "Mcu.Pin0": "PA9",
            "Mcu.Pin1": "PA10"
        };
        validateStructuralIoc(validPins);

        // Gap in Pins sequence
        assert.throws(
            () => validateStructuralIoc({ "Mcu.PinsNb": "2", "Mcu.Pin0": "PA9" }),
            (err) => err.code === "CUBEMX_IOC_INVALID"
        );

        // Duplicate Pin
        assert.throws(
            () => validateStructuralIoc({ "Mcu.PinsNb": "2", "Mcu.Pin0": "PA9", "Mcu.Pin1": "PA9" }),
            (err) => err.code === "CUBEMX_IOC_INVALID"
        );

        // Orphaned Pin
        assert.throws(
            () => validateStructuralIoc({ "Mcu.PinsNb": "1", "Mcu.Pin0": "PA9", "Mcu.Pin1": "PA10" }),
            (err) => err.code === "CUBEMX_IOC_INVALID"
        );

        // Categorized diff summary
        const diffList = [
            { key: "Mcu.IP0", previous: null, requested: "RCC" },
            { key: "PA9.Signal", previous: null, requested: "USART1_TX" },
            { key: "RCC.Clock", previous: null, requested: "168MHz" },
            { key: "ProjectManager.TargetToolchain", previous: null, requested: "CMake" },
            { key: "Custom.Setting", previous: null, requested: "1" }
        ];
        const categorized = categorizeChanges(diffList);
        assert.strictEqual(categorized.ips.length, 1);
        assert.strictEqual(categorized.pins.length, 1);
        assert.strictEqual(categorized.clock.length, 1);
        assert.strictEqual(categorized.metadata.length, 1);
        assert.strictEqual(categorized.other.length, 1);

        // deriveCandidate with deletions
        const orig = "a=1\nb=2\nc=3\n";
        const candidateResult = deriveCandidate(orig, { d: "4" }, ["b"]);
        assert.strictEqual(candidateResult.content, "a=1\nc=3\nd=4\n");
        assert(candidateResult.changes.some((c) => c.key === "b" && c.action === "deleted"));

        // Reject updating and deleting the same key
        assert.throws(
            () => deriveCandidate(orig, { a: "new" }, ["a"]),
            (err) => err.code === "INVALID_ARGUMENT"
        );
    }

    // ---------------------------------------------------------
    // 3. User Code Integrity Classification
    // ---------------------------------------------------------
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

        const class1 = classifyUserCodeChanges(validC, userModifiedC);
        assert.strictEqual(class1.classifiable, true);
        assert.strictEqual(class1.generatedChanged, false);
        assert.strictEqual(class1.userChanged, true);

        const class2 = classifyUserCodeChanges(validC, generatedModifiedC);
        assert.strictEqual(class2.classifiable, true);
        assert.strictEqual(class2.generatedChanged, true);

        const class3 = classifyUserCodeChanges(validC, corruptedC);
        assert.strictEqual(class3.classifiable, false);
    }

    // ---------------------------------------------------------
    // 4. CubeMxService: start, status, deduplication, check (quick/deep)
    // ---------------------------------------------------------
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-p0p1-service-")));
    try {
        const project = path.join(root, "demo");
        await fs.mkdir(path.join(project, "Core", "Src"), { recursive: true });
        const ioc = path.join(project, "demo.ioc");
        await fs.writeFile(ioc, sampleIoc);
        const main = path.join(project, "Core", "Src", "main.c");
        const userCode = "/* USER CODE BEGIN 0 */\nint count = 0;\n/* USER CODE END 0 */\n";
        await fs.writeFile(main, userCode + "int main() { return 0; }\n");
        await fs.writeFile(path.join(project, ".mxproject"), "SourceFiles=Core/Src/main.c;\n");

        const storageDir = path.join(root, "storage");
        await fs.mkdir(storageDir, { recursive: true });

        const service = new CubeMxService({
            platform: "win32",
            storage: { get: () => undefined, update: async () => {} },
            storageDir,
            config: () => ({ iocPath: ioc }),
            roots: () => [project],
            installation: async () => ({ version: "6.12.0", executable: "STM32CubeMX.exe" }),
            run: async (_tool, directory) => {
                const target = path.join(directory, "Core", "Src", "main.c");
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, userCode + "int main() { return 0; }\n");
                return {
                    generatedFiles: [target],
                    log: "project generate\nOK\nexit\n"
                };
            }
        });

        // Quick check with no manifest -> status: unknown
        const checkNoManifest = await service.check({ mode: "quick" });
        assert.strictEqual(checkNoManifest.status, "unknown");

        // Inspect with summary: true (default for CLI) — summary stays compact without a prefix
        const summaryInspect = await service.inspect({ summary: true });
        assert(summaryInspect.summary);
        assert.strictEqual(summaryInspect.full, false);
        assert.strictEqual(summaryInspect.content, undefined);
        assert.strictEqual(summaryInspect.values, undefined);

        // Inspect with prefix filter
        const prefixInspect = await service.inspect({ prefix: "USART1" });
        assert.strictEqual(prefixInspect.values["USART1.BaudRate"], "115200");
        assert.strictEqual(prefixInspect.values["Mcu.Name"], undefined);

        // Prepare with summary
        const prep = await service.prepare({ summary: true });
        assert(prep.changesSummary);
        assert.strictEqual(prep.verification.propertiesSyntax, "passed");
        assert.strictEqual(prep.verification.structuralCheck, "passed");

        // Test start -> status asynchronous flow
        const startResult = await service.start({
            confirmationId: prep.confirmationId,
            requestId: "req_test_001"
        });
        assert(startResult.operationId);
        assert.strictEqual(startResult.status, "in_progress");

        // Deduplication: same requestId with same params returns existing operation
        const deduplicated = await service.start({
            confirmationId: prep.confirmationId,
            requestId: "req_test_001"
        });
        assert.strictEqual(deduplicated.deduplicated, true);
        assert.strictEqual(deduplicated.operationId, startResult.operationId);

        // Same requestId with different params rejected
        await assert.rejects(
            service.start({
                confirmationId: "different_id",
                requestId: "req_test_001"
            }),
            (err) => err.code === "CUBEMX_REQUEST_CONFLICT"
        );

        // Wait for active execution to finish
        if (service.activeExecutions.has(startResult.operationId)) {
            await service.activeExecutions.get(startResult.operationId);
        }

        // Query status by operationId
        const statusResult = await service.status({ operationId: startResult.operationId });
        assert.strictEqual(statusResult.status, "succeeded");
        assert.strictEqual(statusResult.sourceProjectStatus, "committed");

        // Quick check after generation commit -> consistent
        const checkAfter = await service.check({ mode: "quick" });
        assert.strictEqual(checkAfter.status, "consistent");
        assert.strictEqual(checkAfter.drift.length, 0);

        // Edit user code block in main.c
        await fs.writeFile(
            main,
            "/* USER CODE BEGIN 0 */\nint count = 999;\n/* USER CODE END 0 */\nint main() { return 0; }\n"
        );
        const checkUserEdit = await service.check({ mode: "quick" });
        assert.strictEqual(checkUserEdit.status, "consistent");
        assert.strictEqual(checkUserEdit.drift.length, 0);
        assert.strictEqual(checkUserEdit.userCodeChanges.length, 1);
        assert.strictEqual(checkUserEdit.userCodeChanges[0].file, path.join("Core", "Src", "main.c"));
        assert.deepStrictEqual(checkUserEdit.userCodeChanges[0].blocks, ["0"]);

        // Quick check detects .ioc configuration changes against manifest
        const iocFilePath = path.join(project, "demo.ioc");
        const origIocContent = await fs.readFile(iocFilePath, "utf8");
        await fs.writeFile(iocFilePath, origIocContent + "Custom.Setting=changed\n");
        const checkIocEdit = await service.check({ mode: "quick" });
        assert.strictEqual(checkIocEdit.status, "drift_detected");
        assert.strictEqual(checkIocEdit.iocChanged, true);
        assert(checkIocEdit.configChanges.some((c) => c.key === "Custom.Setting" && c.requested === "changed"));
        await fs.writeFile(iocFilePath, origIocContent);

        // Deep check (synchronous wait mode) and verify stored result completeness
        const deepCheck = await service.check({ mode: "deep", wait: true });
        assert.strictEqual(deepCheck.status, "consistent");
        const deepOp = await service.store.getOperation(project, deepCheck.operationId);
        assert(Array.isArray(deepOp.result.userCodeChanges));
        assert(Array.isArray(deepOp.result.unclassifiedChanges));
        assert(Array.isArray(deepOp.result.staleCandidates));

        // Decoupled status: works even if platform is linux or toolchain not installed
        const nonWinService = new CubeMxService({
            ...service.options,
            platform: "linux",
            installation: async () => {
                throw new Error("Toolchain should not be queried for status");
            }
        });
        const nonWinStatus = await nonWinService.status();
        assert.strictEqual(nonWinStatus.operationId, deepCheck.operationId);

        // Concurrency project lock check
        service.jobs.set(project, { controller: new AbortController(), operationId: "fake", type: "generate" });
        await assert.rejects(service.check({ mode: "deep" }), (err) => err.code === "CUBEMX_BUSY");
        service.jobs.delete(project);

        // Test cancel by operation ID
        const fakeController = new AbortController();
        service.jobs.set(project, { controller: fakeController, operationId: "op_cancel_me", type: "generate" });
        const cancelRes = service.cancel({ operationId: "op_cancel_me" });
        assert.strictEqual(cancelRes.cancelled, 1);
        assert.strictEqual(fakeController.signal.aborted, true);
        service.jobs.delete(project);

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

        // Candidate generation with --changes-file
        const changesFile = path.join(project, "my-changes.json");
        await fs.writeFile(changesFile, JSON.stringify({ "USART1.BaudRate": "9600" }));
        const candidateOutput = await service.generateCandidate({
            outputPath: "cand_output.ioc",
            changesFile: "my-changes.json"
        });
        assert(candidateOutput.candidatePath);
        assert(candidateOutput.changes.some((c) => c.key === "USART1.BaudRate" && c.requested === "9600"));

        // Candidate generation with --changes-file updates object and CLI deletions merged
        const changesFileWithUpdates = path.join(project, "updates-only.json");
        await fs.writeFile(changesFileWithUpdates, JSON.stringify({ updates: { "USART1.BaudRate": "19200" } }));
        const candidateMerged = await service.generateCandidate({
            outputPath: "cand_merged.ioc",
            changesFile: "updates-only.json",
            deletions: ["PA10.Signal"]
        });
        assert(candidateMerged.changes.some((c) => c.key === "USART1.BaudRate"));
        assert(candidateMerged.changes.some((c) => c.key === "PA10.Signal" && c.action === "deleted"));

        // Idempotency: execute with already failed requestId rejects rather than creating duplicate
        const { hash } = require("../src/services/cubemxProject");
        const failedParams = {
            requestId: "req_failed_retry",
            confirmationId: "auto-trusted"
        };
        const failedParamsHash = hash(
            JSON.stringify({
                candidatePath: "",
                content: "",
                mode: "",
                confirmationId: "auto-trusted",
                remember: false
            })
        );
        await service.store.createOperation(project, {
            type: "generate",
            requestId: "req_failed_retry",
            requestParamsHash: failedParamsHash,
            status: "failed",
            diagnostic: "Simulated prior failure"
        });
        await assert.rejects(
            service.execute(failedParams),
            (err) => err.code === "CUBEMX_GENERATION_FAILED" && err.message.includes("Simulated prior failure")
        );
        const allOps = await service.store.getOperations(project);
        assert.strictEqual(allOps.filter((o) => o.requestId === "req_failed_retry").length, 1);

        // CLI args validation
        assert.strictEqual(args(["--check", "--deep"]).deep, true);
        assert.strictEqual(args(["--status", "--operation-id", "op_123"])["operation-id"], "op_123");
        assert.strictEqual(args(["--inspect", "--prefix", "USART"]).prefix, "USART");
        assert.strictEqual(
            args(["--generate-candidate", "--output", "out.ioc", "--changes-file", "c.json"])["changes-file"],
            "c.json"
        );

        // ---------------------------------------------------------
        // 5. Quick-check classification branches (against the committed manifest)
        // ---------------------------------------------------------
        const mainRel = path.join("Core", "Src", "main.c");
        const mainCOriginal = await fs.readFile(main, "utf8"); // user code already edited (count=999)
        const mxprojectPath = path.join(project, ".mxproject");
        const mxprojectOriginal = await fs.readFile(mxprojectPath, "utf8");

        // Missing manifest file
        await fs.rm(mxprojectPath);
        const checkMissing = await service.check({ mode: "quick" });
        assert.strictEqual(checkMissing.status, "drift_detected");
        assert(checkMissing.drift.some((entry) => entry.file === ".mxproject" && entry.action === "missing"));
        await fs.writeFile(mxprojectPath, mxprojectOriginal);

        // Corrupted USER CODE markers -> unclassifiable, never guessed
        await fs.writeFile(main, mainCOriginal.replace("/* USER CODE END 0 */\n", ""));
        const checkCorrupted = await service.check({ mode: "quick" });
        assert.strictEqual(checkCorrupted.status, "drift_detected");
        assert.strictEqual(checkCorrupted.unclassifiedChanges.length, 1);
        assert.strictEqual(checkCorrupted.unclassifiedChanges[0].reason, "mismatched_marker_count");
        await fs.writeFile(main, mainCOriginal);

        // Generated-region edit -> drift (not a user-code change)
        await fs.writeFile(main, mainCOriginal.replace("int main()", "int main_renamed()"));
        const checkGeneratedEdit = await service.check({ mode: "quick" });
        assert.strictEqual(checkGeneratedEdit.status, "drift_detected");
        assert(checkGeneratedEdit.drift.some((entry) => entry.file === mainRel && entry.action === "modified"));
        assert.strictEqual(checkGeneratedEdit.userCodeChanges.length, 0);
        await fs.writeFile(main, mainCOriginal);

        // User-code edit names the changed block(s)
        await fs.writeFile(main, mainCOriginal.replace("int count = 999;", "int count = 777;\nint added = 1;"));
        const checkBlocks = await service.check({ mode: "quick" });
        assert.strictEqual(checkBlocks.status, "consistent");
        assert.deepStrictEqual(checkBlocks.userCodeChanges[0].blocks, ["0"]);
        await fs.writeFile(main, mainCOriginal);

        assert.deepStrictEqual(
            changedUserCodeBlockNames(
                "/* USER CODE BEGIN 0 */\nint a = 1;\n/* USER CODE END 0 */",
                "/* USER CODE BEGIN 0 */\nint a = 2;\n/* USER CODE END 0 */"
            ),
            ["0"]
        );

        // Quick check must work without a usable CubeMX installation and off Windows
        const noToolService = new CubeMxService({
            ...service.options,
            platform: "linux",
            installation: async () => {
                throw new Error("CubeMX must not be required for a quick check");
            }
        });
        const quickNoTool = await noToolService.check({ mode: "quick" });
        assert.strictEqual(quickNoTool.status, "consistent");

        // ---------------------------------------------------------
        // 6. Deep check as a queryable background operation
        // ---------------------------------------------------------
        const startedDeep = await service.check({ mode: "deep" });
        assert.strictEqual(startedDeep.status, "in_progress");
        assert(startedDeep.operationId);
        await service.activeExecutions.get(startedDeep.operationId);
        const deepBackgroundRecord = await service.store.getOperation(project, startedDeep.operationId);
        assert.strictEqual(deepBackgroundRecord.status, "succeeded");
        assert.strictEqual(deepBackgroundRecord.result.status, "consistent");

        await assert.rejects(service.check({ mode: "bogus" }), (err) => err.code === "INVALID_ARGUMENT");

        // ---------------------------------------------------------
        // 7. Generation failure paths on an isolated second project
        // ---------------------------------------------------------
        const project2 = path.join(root, "demo2");
        await fs.mkdir(path.join(project2, "Core", "Src"), { recursive: true });
        const ioc2 = path.join(project2, "demo2.ioc");
        const sampleIoc2 = sampleIoc.replace("demo", "demo2");
        await fs.writeFile(ioc2, sampleIoc2);
        const main2 = path.join(project2, "Core", "Src", "main.c");
        await fs.writeFile(main2, userCode + "int main() { return 0; }\n");
        await fs.writeFile(path.join(project2, ".mxproject"), "SourceFiles=Core/Src/main.c;\n");
        await fs.writeFile(path.join(project2, "notes.txt"), "user notes\n");

        const standardRun = async (_tool, directory) => {
            const target = path.join(directory, "Core", "Src", "main.c");
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, userCode + "int main() { return 0; }\n");
            return { generatedFiles: [target], log: "project generate\nOK\nexit\n" };
        };

        const service2 = new CubeMxService({
            platform: "win32",
            storage: { get: () => undefined, update: async () => {} },
            storageDir: path.join(root, "storage2"),
            config: () => ({ iocPath: ioc2 }),
            roots: () => [project2],
            installation: async () => ({ version: "6.12.0", executable: "STM32CubeMX.exe" }),
            run: standardRun
        });

        // 7a. Manifest save failure: source files are committed, report must not pretend retry
        const recordFailService = new CubeMxService({ ...service2.options });
        recordFailService.store.saveManifest = async () => {
            throw new Error("disk full");
        };
        const candidateIocRecordFail = sampleIoc2.replace("115200", "9600");
        const prepRecordFail = await recordFailService.prepare({ content: candidateIocRecordFail });
        await assert.rejects(
            recordFailService.execute({
                content: candidateIocRecordFail,
                confirmationId: prepRecordFail.confirmationId
            }),
            (err) => err.code === "CUBEMX_RECORD_SAVE_FAILED" && err.details?.committed === true
        );
        assert.strictEqual(await fs.readFile(ioc2, "utf8"), candidateIocRecordFail);
        const recordFailOps = await recordFailService.store.getOperations(project2);
        const recordFailRec = recordFailOps[recordFailOps.length - 1];
        assert.strictEqual(recordFailRec.status, "succeeded");
        assert.strictEqual(recordFailRec.sourceProjectStatus, "committed");

        // 7b. Readback verification failure -> source project status unknown
        const readbackService = new CubeMxService({ ...service2.options });
        readbackService.options.applyFiles = async (rootDir, before, after, backup) => {
            const changed = await applyFiles(rootDir, before, after, backup);
            await fs.writeFile(path.join(rootDir, "Core", "Src", "main.c"), "tampered content\n");
            return changed;
        };
        const candidateIocReadback = sampleIoc2.replace("115200", "4800");
        const prepReadback = await readbackService.prepare({ content: candidateIocReadback });
        await assert.rejects(
            readbackService.execute({
                content: candidateIocReadback,
                confirmationId: prepReadback.confirmationId
            }),
            (err) => err.code === "CUBEMX_WRITE_FAILED" && err.details?.file === mainRel
        );
        const readbackOps = await readbackService.store.getOperations(project2);
        const readbackRec = readbackOps[readbackOps.length - 1];
        assert.strictEqual(readbackRec.status, "failed");
        assert.strictEqual(readbackRec.sourceProjectStatus, "unknown");
        await fs.writeFile(main2, userCode + "int main() { return 0; }\n");

        // 7c. Pre-write project change is "unchanged", never misreported as rolledBack
        const preWriteService = new CubeMxService({ ...service2.options });
        const originalRun2 = preWriteService.options.run;
        preWriteService.options.run = async (...runArgs) => {
            await fs.appendFile(path.join(project2, "notes.txt"), "concurrent edit during run\n");
            return originalRun2(...runArgs);
        };
        const candidateIocPreWrite = sampleIoc2.replace("115200", "19200");
        const prepPreWrite = await preWriteService.prepare({ content: candidateIocPreWrite });
        await assert.rejects(
            preWriteService.execute({
                content: candidateIocPreWrite,
                confirmationId: prepPreWrite.confirmationId
            }),
            (err) => err.code === "CUBEMX_PROJECT_CHANGED" && err.details?.condition === "pre_write_change"
        );
        const preWriteOps = await preWriteService.store.getOperations(project2);
        const preWriteRec = preWriteOps[preWriteOps.length - 1];
        assert.strictEqual(preWriteRec.status, "failed");
        assert.strictEqual(preWriteRec.sourceProjectStatus, "unchanged");

        // 7d. Project lock is claimed synchronously: a concurrent start is deterministically busy
        const raceService = new CubeMxService({ ...service2.options });
        const origCreate = raceService.store.createOperation.bind(raceService.store);
        raceService.store.createOperation = async (...createArgs) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return origCreate(...createArgs);
        };
        const candidateIocRace = sampleIoc2.replace("115200", "2400");
        const prepRace = await raceService.prepare({ content: candidateIocRace });
        const firstStart = raceService.start({
            content: candidateIocRace,
            confirmationId: prepRace.confirmationId,
            requestId: "req_race_a"
        });
        await until(() => raceService.jobs.has(project2));
        await assert.rejects(
            raceService.start({
                content: candidateIocRace,
                confirmationId: prepRace.confirmationId,
                requestId: "req_race_b"
            }),
            (err) => err.code === "CUBEMX_BUSY"
        );
        const raceStarted = await firstStart;
        assert(raceStarted.operationId);
        await raceService.activeExecutions.get(raceStarted.operationId);

        // ---------------------------------------------------------
        // 8. Deep-check drift, invalidation, and failure diagnostics
        // ---------------------------------------------------------
        await fs.writeFile(main2, userCode + "int main() { return 0; }\nint drifted = 1;\n");
        await fs.writeFile(path.join(project2, "Core", "Src", "usart.c"), "leftover from a removed peripheral\n");
        await fs.writeFile(path.join(project2, "README.md"), "root user doc\n");
        // CubeMX regenerates in the staged copy and removes sources it no longer generates.
        service2.options.run = async (_tool, directory) => {
            const target = path.join(directory, "Core", "Src", "main.c");
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, userCode + "int main() { return 0; }\n");
            await fs.rm(path.join(directory, "Core", "Src", "usart.c"), { force: true });
            return { generatedFiles: [target], log: "project generate\nOK\nexit\n" };
        };
        const deepDrift = await service2.check({ mode: "deep", wait: true });
        assert.strictEqual(deepDrift.status, "drift_detected");
        assert(deepDrift.drift.some((entry) => entry.file === mainRel && entry.action === "modified"));
        assert.deepStrictEqual(deepDrift.staleCandidates, [
            { file: path.join("Core", "Src", "usart.c"), action: "not_regenerated" }
        ]);
        service2.options.run = standardRun;

        // Concurrent source edit during the check invalidates the result
        await fs.writeFile(main2, userCode + "int main() { return 0; }\n");
        await fs.rm(path.join(project2, "Core", "Src", "usart.c"));
        service2.options.run = async (_tool, directory) => {
            const target = path.join(directory, "Core", "Src", "main.c");
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, userCode + "int main() { return 0; }\n");
            await fs.appendFile(main2, "/* concurrent edit */\n");
            return { generatedFiles: [target], log: "project generate\nOK\nexit\n" };
        };
        const deepInvalidated = await service2.check({ mode: "deep", wait: true });
        assert.strictEqual(deepInvalidated.status, "invalidated");
        assert.strictEqual(deepInvalidated.message, "Source project changed during deep check");
        const invalidatedRec = await service2.store.getOperation(project2, deepInvalidated.operationId);
        assert.strictEqual(invalidatedRec.status, "succeeded");
        assert.strictEqual(invalidatedRec.result.status, "invalidated");

        // Deep-check failure keeps its CubeMX log after the stage directory is removed
        await fs.writeFile(main2, userCode + "int main() { return 0; }\n");
        service2.options.run = async (_tool, directory) => {
            await fs.writeFile(path.join(directory, ".emberprobe-cubemx-output.log"), "deep run exploded\n");
            throw new Error("CubeMX exploded");
        };
        await assert.rejects(service2.check({ mode: "deep", wait: true }), /CubeMX exploded/);
        service2.options.run = standardRun;
        const failureOps = await service2.store.getOperations(project2);
        const failureRec = failureOps[failureOps.length - 1];
        assert.strictEqual(failureRec.status, "failed");
        assert(failureRec.error?.details?.logPath, "persisted deep-check log path recorded");
        assert.strictEqual(await fs.readFile(failureRec.error.details.logPath, "utf8"), "deep run exploded\n");

        // ---------------------------------------------------------
        // 9. Request dedup replays: in-progress, failed and interrupted operations
        // ---------------------------------------------------------
        const replayParams = { requestId: "req_replay_ok", confirmationId: "auto-trusted" };
        const replayOp = await service.store.createOperation(project, {
            type: "generate",
            requestId: "req_replay_ok",
            requestParamsHash: paramsHash(replayParams)
        });
        service.activeExecutions.set(
            replayOp.operationId,
            (async () => {
                await service.store.updateOperation(project, replayOp.operationId, {
                    status: "succeeded",
                    result: { generated: true, operationId: replayOp.operationId }
                });
            })()
        );
        const replayed = await service.execute(replayParams);
        assert.strictEqual(replayed.generated, true);
        assert.strictEqual(replayed.operationId, replayOp.operationId);

        const replayFailParams = { requestId: "req_replay_fail", confirmationId: "auto-trusted" };
        const replayFailOp = await service.store.createOperation(project, {
            type: "generate",
            requestId: "req_replay_fail",
            requestParamsHash: paramsHash(replayFailParams)
        });
        service.activeExecutions.set(
            replayFailOp.operationId,
            (async () => {
                await service.store.updateOperation(project, replayFailOp.operationId, {
                    status: "failed",
                    diagnostic: "Generation exceeded five minutes",
                    error: { code: "CUBEMX_TIMEOUT", message: "Generation exceeded five minutes" }
                });
            })()
        );
        await assert.rejects(
            service.execute(replayFailParams),
            (err) => err.code === "CUBEMX_TIMEOUT" && err.message === "Generation exceeded five minutes"
        );

        const interruptedParams = { requestId: "req_interrupted", confirmationId: "auto-trusted" };
        await service.store.createOperation(project, {
            type: "generate",
            requestId: "req_interrupted",
            requestParamsHash: paramsHash(interruptedParams),
            status: "interrupted"
        });
        await assert.rejects(
            service.execute(interruptedParams),
            (err) => err.code === "CUBEMX_OPERATION_INTERRUPTED"
        );

        // Cancel with an unknown operation id reports zero cancellations
        const unknownCancel = service.cancel({ operationId: "op_missing" });
        assert.strictEqual(unknownCancel.cancelled, 0);
        assert(unknownCancel.message);

        // ---------------------------------------------------------
        // 10. CLI request-id persistence: retry dedup across CLI invocations
        // ---------------------------------------------------------
        const cliWorkspace = path.join(root, "cli-workspace");
        await fs.mkdir(cliWorkspace, { recursive: true });
        const cliParams = { candidatePath: "/x/candidate.ioc", confirmationId: "c1", remember: false };
        const firstId = resolveRequestId(cliWorkspace, "start", cliParams, 1000000);
        const retryId = resolveRequestId(cliWorkspace, "start", cliParams, 1000000 + 60 * 1000);
        assert.strictEqual(retryId, firstId); // reused inside the TTL window
        const expiredId = resolveRequestId(cliWorkspace, "start", cliParams, 1000000 + 16 * 60 * 1000);
        assert.notStrictEqual(expiredId, firstId); // expired -> fresh logical operation
        const otherParams = { ...cliParams, confirmationId: "c2" };
        const otherId = resolveRequestId(cliWorkspace, "start", otherParams, 1000000 + 16 * 60 * 1000 + 1);
        assert.notStrictEqual(otherId, expiredId); // different parameters -> different fingerprint
        const storedRequests = JSON.parse(
            await fs.readFile(path.join(cliWorkspace, ".emberprobe-cubemx-audit", "cubemx-requests.json"), "utf8")
        );
        assert(storedRequests[requestFingerprint("start", otherParams)]);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

    console.log("CubeMX P0/P1 comprehensive tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
