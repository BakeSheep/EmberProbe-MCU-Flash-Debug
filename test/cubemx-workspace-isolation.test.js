"use strict";

// Regression coverage for GitHub issue #38: benign CubeMX log errors, staged copies left in the
// workspace, and unrelated tool links rejecting generation.
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createLogMonitor } = require("../src/services/cubemxLog");
const { runCubeMx } = require("../src/services/cubemxRunner");
const { CubeMxService } = require("../src/services/cubemxService");
const { snapshot, parseIoc } = require("../src/services/cubemxProject");

const content = [
    "Mcu.Name=STM32F407VGTx",
    "MxCube.Version=6.12.0",
    "ProjectManager.ProjectName=demo",
    "ProjectManager.TargetToolchain=CMake",
    "ProjectManager.KeepUserCode=true",
    "ProjectManager.UnderRoot=true",
    "USART2.BaudRate=9600",
    ""
].join("\n");
const parseLog = (stdout, stderr = "") => {
    const monitor = createLogMonitor();
    monitor.stdout(Buffer.from(stdout));
    monitor.stderr(Buffer.from(stderr));
    return monitor.finish();
};
// Linux CubeMX 6.18.1 transcript from the issue: `project path` answers KO harmlessly.
const script = 'config load "/ws/demo.ioc"\nOK\nproject path "/ws"\nKO\nproject generate\nOK\nexit\nBye bye\n';
const updaterNoise = [
    "2026-10-01 10:00:00,123 [ERROR] WebUtils:658 - Updater is busy",
    "[ERROR] HomeAdPanel:133 - Failed to refresh advertisement data",
    "java.net.UnknownHostException: www.st.com",
    "\tat java.base/java.net.InetAddress.getAllByName0(InetAddress.java:1302)",
    "Caused by: java.io.IOException: offline",
    "\t... 12 more",
    ""
].join("\n");
// Directory links: junctions need no extra privilege on Windows; the type is ignored elsewhere.
const link = (target, location) => fs.symlink(target, location, "junction");

(async () => {
    await scenario("Report CubeMX updater and advertisement errors as warnings", () => {
        const benign = parseLog(updaterNoise + script);
        assert.strictEqual(benign.failureLine, "");
        assert.strictEqual(benign.confirmed, true);
        assert(benign.warnings.some((warning) => warning.includes("Updater is busy")));
        assert(benign.warnings.some((warning) => warning.includes("HomeAdPanel")));
        assert(!benign.warnings.some((warning) => warning.includes("UnknownHostException")), "trace stays quiet");
        assert.strictEqual(parseLog(script, updaterNoise).failureLine, "", "stderr records are classified alike");
    });

    await scenario("Keep blocking real generation failures", () => {
        assert(parseLog("[ERROR] ProjectManager:120 - Unable to write file\n" + script).failureLine);
        assert(parseLog("[ERROR] generation error\n" + script).failureLine);
        // Generation-relevant text blocks even when logged by an otherwise benign source.
        assert(
            parseLog("[ERROR] UpdaterManager:88 - Firmware package STM32Cube_FW_H7_V1.12.0 not installed\n" + script)
                .failureLine
        );
        assert(parseLog("[WARN] WebUtils:12 - Project migration required\n" + script).failureLine);
        // A trace after an unrelated line no longer belongs to the benign record.
        const unattributed = parseLog(
            "[ERROR] WebUtils:658 - Updater is busy\nloading project\n\tat com.st.Gen.run(Gen.java:10)\n" + script
        );
        assert(unattributed.failureLine.includes("Gen.java"));
        const otherSource = parseLog(
            "[ERROR] WebUtils:658 - Updater is busy\n[ERROR] CodeGenerator:44 - boom\n\tat com.st.Gen.run(Gen.java:10)\n" +
                script
        );
        assert(otherSource.failureLine.includes("CodeGenerator"));
        assert(parseLog("java.lang.NullPointerException\n" + script).failureLine);
        const ko = parseLog('config load "/ws/demo.ioc"\nOK\nproject generate\nKO\nexit\n');
        assert.strictEqual(ko.confirmed, false);
        assert(ko.failureLine.includes("KO"));
    });

    await scenario("Resolve a clean CubeMX run that logged benign updater errors", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-benign-run-"));
        try {
            const spawn = () => {
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.kill = () => {};
                setImmediate(() => {
                    child.stderr.emit("data", Buffer.from(updaterNoise));
                    child.stdout.emit("data", Buffer.from(script));
                    child.emit("close", 0);
                });
                return child;
            };
            const result = await runCubeMx(
                { executable: path.join(directory, "cube"), platform: "linux" },
                directory,
                "demo.ioc",
                {
                    spawn,
                    logPath: path.join(directory, "run.log")
                }
            );
            assert(result.warnings.some((warning) => warning.includes("Updater is busy")));
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-isolation-")));
    try {
        const workspace = path.join(root, "workspace");
        const project = path.join(workspace, "demo");
        const stagingDir = path.join(root, "staging");
        const storageDir = path.join(root, "storage");
        const outside = path.join(root, "outside");
        await fs.mkdir(path.join(workspace, ".agents", "skills", "mcu-cubemx"), { recursive: true });
        await fs.writeFile(path.join(workspace, ".agents", "skills", "mcu-cubemx", "SKILL.md"), "skill\n");
        await fs.mkdir(project, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(outside, "keep.txt"), "outside\n");
        const ioc = path.join(project, "demo.ioc");
        await fs.writeFile(ioc, content);
        await fs.writeFile(path.join(project, "main.c"), "baud=9600;\n");
        await fs.writeFile(path.join(project, "app.c"), "business code\n");

        const stages = [];
        const generate = async (_tool, directory, name, options) => {
            stages.push(directory);
            const values = parseIoc(await fs.readFile(path.join(directory, name), "utf8"));
            await fs.writeFile(path.join(directory, "main.c"), "baud=" + values["USART2.BaudRate"] + ";\n");
            await fs.writeFile(options.logPath, "[ERROR] WebUtils:658 - Updater is busy\nproject generate\nOK\n");
            return { log: "project generate\nOK\n", logPath: options.logPath, warnings: ["Updater is busy"] };
        };
        const service = new CubeMxService({
            platform: "win32",
            storage: { get: () => undefined, update: async () => {} },
            storageDir,
            stagingDir,
            config: () => ({ iocPath: ioc }),
            roots: () => [workspace],
            installation: async () => ({ version: "6.12.0", executable: "STM32CubeMX.exe" }),
            run: generate
        });
        const execute = async (candidate) => {
            const prepared = await service.prepare({ content: candidate });
            return service.execute({ content: candidate, confirmationId: prepared.confirmationId });
        };
        const workspaceLeftovers = async () =>
            (await fs.readdir(project)).filter((name) => name.startsWith(".emberprobe-cubemx-"));
        const stagingLeftovers = async () => fs.readdir(stagingDir).catch(() => []);

        await scenario("Stage outside the workspace and keep only small recovery material", async () => {
            const staleStage = path.join(stagingDir, "emberprobe-cubemx-stage-gen-crashed");
            const otherTemp = path.join(stagingDir, "unrelated");
            await fs.mkdir(path.join(staleStage, "baseline"), { recursive: true });
            await fs.mkdir(otherTemp, { recursive: true });
            const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            await fs.utimes(staleStage, twoDaysAgo, twoDaysAgo);

            const result = await execute(content.replace("9600", "115200"));
            assert(result.generated);
            assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=115200;\n");
            assert(stages.length >= 2);
            for (const stage of stages) {
                assert(path.relative(workspace, stage).startsWith(".."), "stage must not be inside the workspace");
                assert(path.relative(stagingDir, stage).split(path.sep).length >= 2);
            }
            assert.deepStrictEqual(await workspaceLeftovers(), []);
            assert.deepStrictEqual(await stagingLeftovers(), ["unrelated"], "stage and stale stage are removed");

            assert(result.diagnosticsPath.startsWith(storageDir));
            assert((await fs.readFile(path.join(result.diagnosticsPath, "generating.log"), "utf8")).includes("OK"));
            assert(await fs.stat(path.join(result.diagnosticsPath, "baseline.log")));
            // Backup holds only the original bytes of modified files, not a full project copy.
            assert.strictEqual(await fs.readFile(path.join(result.backup, "main.c"), "utf8"), "baud=9600;\n");
            assert.strictEqual(await fs.readFile(path.join(result.backup, "demo.ioc"), "utf8"), content);
            await assert.rejects(fs.stat(path.join(result.backup, "app.c")), { code: "ENOENT" });
            assert.deepStrictEqual(result.warnings, ["Updater is busy"]);
        });

        await scenario("Keep only logs after a failed generation", async () => {
            stages.length = 0;
            service.options.run = async (tool, directory, name, options) => {
                if (options.stage === "baseline") return generate(tool, directory, name, options);
                stages.push(directory);
                await fs.writeFile(path.join(directory, ".emberprobe-cubemx-output.log"), "candidate exploded\n");
                throw Object.assign(new Error("CubeMX did not complete cleanly"), {
                    code: "CUBEMX_GENERATION_FAILED",
                    details: { stage: options.stage }
                });
            };
            const error = await execute(content.replace("9600", "57600")).catch((caught) => caught);
            assert.strictEqual(error.code, "CUBEMX_GENERATION_FAILED");
            assert.strictEqual(error.details.stage, "generating", "runner stage name is not replaced by a path");
            assert(error.details.diagnosticsPath.startsWith(storageDir));
            assert.strictEqual(error.details.logPath, path.join(error.details.diagnosticsPath, "generating.log"));
            assert.strictEqual(await fs.readFile(error.details.logPath, "utf8"), "candidate exploded\n");
            assert.deepStrictEqual(await workspaceLeftovers(), []);
            assert.deepStrictEqual(await stagingLeftovers(), ["unrelated"]);
            const record = await service.status();
            assert.strictEqual(record.status, "failed");
            assert.strictEqual(record.error.details.diagnosticsPath, error.details.diagnosticsPath);
            assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=115200;\n");
            service.options.run = generate;
        });

        await scenario("Keep regenerated drift files for review", async () => {
            await fs.writeFile(path.join(project, "main.c"), "hand edit\n");
            const error = await execute(content.replace("9600", "4800")).catch((caught) => caught);
            assert.strictEqual(error.code, "CUBEMX_BASELINE_DRIFT");
            assert.strictEqual(
                await fs.readFile(path.join(error.details.baselineOutput, "main.c"), "utf8"),
                "baud=115200;\n"
            );
            assert.deepStrictEqual(await stagingLeftovers(), ["unrelated"]);
            await fs.writeFile(path.join(project, "main.c"), "baud=115200;\n");
        });

        await scenario("Retain the backup that recovery depends on", async () => {
            service.options.applyFiles = async (rootDir, before, after, backup) => {
                const { applyFiles } = require("../src/services/cubemxProject");
                return applyFiles(rootDir, before, after, backup, {
                    writeFile: async () => {
                        throw new Error("disk full");
                    }
                });
            };
            const error = await execute(content.replace("9600", "2400")).catch((caught) => caught);
            delete service.options.applyFiles;
            assert.strictEqual(error.code, "CUBEMX_WRITE_FAILED");
            assert.strictEqual(await fs.readFile(path.join(error.details.backup, "main.c"), "utf8"), "baud=115200;\n");
            assert.deepStrictEqual(await stagingLeftovers(), ["unrelated"]);
        });

        await scenario("Prune old diagnostics but never recovery material", async () => {
            const runs = path.join(service.store.projectDir(project), "runs");
            for (let i = 0; i < 25; i++) await fs.mkdir(path.join(runs, `op_old_${i}`), { recursive: true });
            const recovery = await service.store.createOperation(project, {
                type: "generate",
                status: "failed",
                sourceProjectStatus: "recoveryRequired"
            });
            await fs.mkdir(path.join(runs, recovery.operationId, "backup"), { recursive: true });
            const result = await execute(content.replace("9600", "1200"));
            const remaining = await fs.readdir(runs);
            assert(remaining.includes(recovery.operationId));
            assert(remaining.includes(result.operationId));
            assert.strictEqual(remaining.length, 21);
            // Directories without an operation record are older than every recorded one.
            const recorded = remaining.filter((name) => !name.startsWith("op_old_"));
            assert.strictEqual(recorded.length, 6, "four earlier runs, the recovery run and this run");
        });

        await scenario("Ignore tool directories and skip links outside the generation scope", async () => {
            await fs.mkdir(path.join(project, ".claude"), { recursive: true });
            await link(path.join(workspace, ".agents", "skills"), path.join(project, ".claude", "skills"));
            await link(outside, path.join(project, "tmp_link"));
            const links = [];
            const files = await snapshot(project, { links });
            assert.deepStrictEqual(links, ["tmp_link"]);
            assert(![...files.keys()].some((file) => file.startsWith(".claude") || file.startsWith("tmp_link")));

            const result = await execute(content.replace("9600", "38400"));
            assert(result.generated);
            assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=38400;\n");
            assert.strictEqual(await fs.readFile(path.join(project, "tmp_link", "keep.txt"), "utf8"), "outside\n");
            assert((await fs.lstat(path.join(project, ".claude", "skills"))).isSymbolicLink());
            assert.strictEqual((await service.check({ mode: "deep", wait: true })).status, "consistent");
        });

        await scenario("Reject links inside the generation scope or under generated output", async () => {
            await link(outside, path.join(project, "Core"));
            await assert.rejects(snapshot(project), (error) => {
                assert.strictEqual(error.code, "CUBEMX_LAYOUT_UNSUPPORTED");
                assert.strictEqual(error.details.file, "Core");
                return true;
            });
            await fs.unlink(path.join(project, "Core"));

            service.options.run = async (tool, directory, name, options) => {
                await fs.mkdir(path.join(directory, "tmp_link"), { recursive: true });
                await fs.writeFile(path.join(directory, "tmp_link", "generated.c"), "generated\n");
                return generate(tool, directory, name, options);
            };
            const error = await execute(content.replace("9600", "19200")).catch((caught) => caught);
            assert.strictEqual(error.code, "CUBEMX_LAYOUT_UNSUPPORTED");
            assert.strictEqual(error.details.condition, "linked_output_path");
            assert.deepStrictEqual(await fs.readdir(outside), ["keep.txt"]);
            assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=38400;\n");
            const deep = await service.check({ mode: "deep", wait: true }).catch((caught) => caught);
            assert.strictEqual(deep.details?.condition, "linked_output_path");
            assert.deepStrictEqual(await stagingLeftovers(), ["unrelated"]);
            service.options.run = generate;
        });
        console.log("CubeMX workspace isolation, benign log and link scope tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
