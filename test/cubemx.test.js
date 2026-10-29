"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { CubeMxAuthorization } = require("../src/cubemxAuthorization");
const { CubeMxService } = require("../src/services/cubemxService");
const { parseIoc, snapshot, applyFiles, hash, assertUserCodePreserved } = require("../src/services/cubemxProject");
const { installation, discover, workspaceIoc } = require("../src/services/cubemxEnvironment");
const { CubeMxConfiguration } = require("../src/services/cubemxConfiguration");
const { runCubeMx } = require("../src/services/cubemxRunner");
const { args } = require("../skills/mcu-cubemx/scripts/cubemx");
const { ConfirmationStore } = require("../src/confirmationStore");
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
const memory = () => {
    const data = new Map();
    return { get: (key) => data.get(key), update: async (key, value) => data.set(key, value) };
};
const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code);

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-cubemx-")));
    try {
        let now = 100;
        const auth = new CubeMxAuthorization(memory(), { now: () => now });
        const plan = { trust: { ioc: "a", chip: "f4" }, identity: { before: "a", after: "b" } };
        assert.throws(() => auth.authorize(plan), /confirmation/);
        const request = auth.request(plan);
        assert(request.confirmationRequired);
        auth.authorize(plan, request.confirmationId);
        assert.throws(() => auth.authorize(plan, request.confirmationId), /confirmation/);
        const changed = auth.request(plan);
        assert.throws(
            () => auth.authorize({ ...plan, identity: { after: "c" } }, changed.confirmationId),
            /confirmation/
        );
        const expired = auth.request(plan);
        now += 300001;
        assert.throws(() => auth.authorize(plan, expired.confirmationId), /confirmation/);
        await auth.remember(plan);
        assert(auth.status(plan.trust).trusted);
        assert(!auth.status({ ioc: "other", chip: "f4" }).trusted);
        assert.strictEqual(auth.request(plan).confirmationRequired, false);
        auth.authorize(plan);
        now += 86400001;
        assert(!auth.status(plan.trust).trusted);
        await auth.reset();
        const confirmations = new ConfirmationStore({ now: () => now });
        for (let i = 0; i < 40; i++) confirmations.request({ i });
        assert(confirmations.pending.size <= 32);
        now += 300001;
        confirmations.prune();
        assert.strictEqual(confirmations.pending.size, 0);

        assert.strictEqual(parseIoc(content)["USART2.BaudRate"], "9600");
        for (const invalid of [
            "abc",
            content + "Mcu.Name=other",
            content.replace("KeepUserCode=true", "KeepUserCode=false"),
            content + "ProjectManager.PreGenerateCommand=evil",
            content + "ProjectManager.MainLocation=../outside",
            content.replace("UnderRoot=true", "UnderRoot=invalid"),
            content + "bad=\\uXYZ0",
            "\0"
        ])
            assert.throws(() => parseIoc(invalid));
        assert.throws(() => args(["--remember", "--execute"]));
        assert.throws(() => args(["--inspect", "--execute"]));
        assert.throws(() => args(["--inspect", "--candidate", "x"]));
        assert.throws(() => args(["--confirm", "x", "--prepare"]));
        assert.throws(() => args(["--unknown"]));
        assert.throws(() => args([]));
        assert.strictEqual(args(["--execute", "--confirm", "id", "--remember"]).remember, true);

        const install = path.join(root, "CubeMX 空格");
        await fs.mkdir(path.join(install, "jre/bin"), { recursive: true });
        await fs.writeFile(path.join(install, "STM32CubeMX.exe"), "test");
        await fs.writeFile(path.join(install, "jre/bin/java.exe"), "test");
        await fs.writeFile(path.join(install, "version.xml"), "<Version>6.12.0</Version>");
        const tool = await installation(path.join(install, "STM32CubeMX.exe"), { platform: "win32" });
        assert.strictEqual(tool.version, "6.12.0");
        // Non-default installs are recorded by CubeMX itself, even without PATH,
        // uninstall registry entries or version.xml in the installation.
        const updaterDirectory = path.join(root, ".stm32cubemx/plugins/updater");
        await fs.mkdir(updaterDirectory, { recursive: true });
        const updaterFile = path.join(updaterDirectory, "updater.ini");
        await fs.writeFile(updaterFile, `SoftwarePath=${install}${path.sep}\r\nSoftVersion=MX.6.17.0\r\n`);
        await fs.unlink(path.join(install, "version.xml"));
        const updaterOptions = { platform: "win32", env: { USERPROFILE: root }, exec: async () => ({ stdout: "" }) };
        const recordedInstall = await discover(updaterOptions);
        assert.strictEqual(recordedInstall.executable, tool.executable);
        assert.strictEqual(recordedInstall.version, "6.17.0");
        await fs.writeFile(updaterFile, `\uFEFFSoftwarePath="${tool.executable}"\nSoftVersion=MX.6.17.1\n`);
        assert.strictEqual((await discover(updaterOptions)).version, "6.17.1");
        await fs.writeFile(updaterFile, "SoftwarePath=relative/path\nSoftVersion=MX.6.17.0\n");
        assert.strictEqual(await discover(updaterOptions), null);
        await fs.writeFile(path.join(install, "version.xml"), "<Version>6.12.0</Version>");
        assert.strictEqual(
            (await discover({ ...updaterOptions, hints: [tool.executable] })).executable,
            tool.executable
        );
        await assert.rejects(installation("relative.exe"));
        assert.strictEqual(
            (await discover({ platform: "win32", env: { PATH: install }, exec: async () => ({ stdout: "" }) }))
                .executable,
            tool.executable
        );

        const project = path.join(root, "工程 空格");
        await fs.mkdir(project);
        const ioc = path.join(project, "demo.ioc");
        await fs.writeFile(ioc, content);
        await fs.writeFile(path.join(project, "main.c"), "baud=9600;\n");
        await fs.writeFile(path.join(project, "app.c"), "business code\n");
        const config = { iocPath: ioc, cubemxPath: tool.executable };
        const storage = memory();
        const fakeRun = async (_tool, directory, name) => {
            const values = parseIoc(await fs.readFile(path.join(directory, name), "utf8"));
            const output = values["ProjectManager.UnderRoot"] === "false" ? path.join(directory, "demo") : directory;
            await fs.writeFile(path.join(output, "main.c"), "baud=" + values["USART2.BaudRate"] + ";\n");
            return { log: "generated" };
        };
        const service = new CubeMxService({
            platform: "win32",
            storage,
            config: () => config,
            roots: () => [project],
            run: fakeRun
        });
        const candidate = content.replace("9600", "115200");
        const candidateFile = path.join(project, "candidate.txt");
        await fs.writeFile(candidateFile, candidate + "#" + "x".repeat(70000));
        const large = await service.prepare({ candidatePath: candidateFile });
        assert.strictEqual(large.changes[0].requested, "115200");
        await rejects(() => service.prepare({ candidatePath: ioc }), "PATH_OUTSIDE_WORKSPACE");
        await rejects(() => service.prepare({ candidatePath: candidateFile, content }), "INVALID_ARGUMENT");
        await fs.unlink(candidateFile);
        await rejects(() => service.execute({ content: candidate }), "CUBEMX_CONFIRMATION_INVALID");
        assert.strictEqual(await fs.readFile(ioc, "utf8"), content);
        const prepared = await service.prepare({ content: candidate });
        assert.strictEqual(prepared.changes.length, 1);
        await rejects(
            () =>
                service.execute({ content: content.replace("9600", "4800"), confirmationId: prepared.confirmationId }),
            "CUBEMX_CONFIRMATION_INVALID"
        );
        const confirmed = await service.prepare({ content: candidate });
        const result = await service.execute({
            content: candidate,
            confirmationId: confirmed.confirmationId,
            remember: true
        });
        assert(result.generated && !result.compiled);
        assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=115200;\n");
        assert.strictEqual(await fs.readFile(path.join(project, "app.c"), "utf8"), "business code\n");
        assert((await service.permission()).trusted);
        assert.strictEqual((await service.prepare()).confirmationRequired, false);
        assert.strictEqual((await service.execute()).changes.length, 0);
        const nestedContent = candidate.replace("UnderRoot=true", "UnderRoot=false");
        const nestedPlan = await service.prepare({ content: nestedContent });
        assert.strictEqual(nestedPlan.changes[0].key, "ProjectManager.UnderRoot");
        const nestedResult = await service.execute({ content: nestedContent });
        assert.strictEqual(nestedResult.generated, true);
        assert.strictEqual(parseIoc(await fs.readFile(ioc, "utf8"))["ProjectManager.UnderRoot"], "false");
        await fs.writeFile(path.join(project, "main.c"), "hand edit");
        await rejects(() => service.execute(), "CUBEMX_BASELINE_DRIFT");
        assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "hand edit");
        await fs.writeFile(path.join(project, "main.c"), "baud=115200;\n");
        // Reproduce CLI output under <ProjectName>, leaving the staged originals untouched.
        const nestedRun = async (_tool, directory, name) => {
            const output = path.join(directory, "demo");
            await fs.mkdir(output, { recursive: true });
            await fs.copyFile(path.join(directory, name), path.join(output, name));
            const values = parseIoc(await fs.readFile(path.join(output, name), "utf8"));
            await fs.writeFile(path.join(output, "main.c"), "baud=" + values["USART2.BaudRate"] + ";\n");
            return { log: "generated" };
        };
        service.options.run = nestedRun;
        const updated = nestedContent.replace("115200", "57600");
        const promoted = await service.execute({ content: updated });
        assert(promoted.generated);
        assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=57600;\n");
        assert(!promoted.changes.some((entry) => entry.file.startsWith("demo" + path.sep)));
        await assert.rejects(fs.stat(path.join(project, "demo")), { code: "ENOENT" });
        await fs.writeFile(path.join(project, "main.c"), "hand edit");
        await rejects(() => service.execute(), "CUBEMX_BASELINE_DRIFT");
        assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "hand edit");
        await fs.writeFile(path.join(project, "main.c"), "baud=57600;\n");
        await fs.mkdir(path.join(project, "demo"));
        await fs.writeFile(path.join(project, "demo", "user.txt"), "keep");
        await rejects(() => service.execute(), "CUBEMX_LAYOUT_UNSUPPORTED");
        assert.strictEqual(await fs.readFile(path.join(project, "demo", "user.txt"), "utf8"), "keep");
        await fs.unlink(path.join(project, "demo", "user.txt"));
        await fs.rmdir(path.join(project, "demo"));
        service.options.run = async (...params) => {
            await nestedRun(...params);
            await fs.unlink(path.join(params[1], "demo", "demo.ioc"));
            return {};
        };
        await rejects(() => service.execute(), "CUBEMX_LAYOUT_UNSUPPORTED");
        service.options.run = async (...params) => {
            await nestedRun(...params);
            await fs.writeFile(path.join(params[1], "main.c"), "ambiguous output");
            return {};
        };
        await rejects(() => service.execute(), "CUBEMX_LAYOUT_UNSUPPORTED");
        service.options.run = nestedRun;
        await rejects(
            () => service.execute({ content: updated.replace("UnderRoot=false", "UnderRoot=true") }),
            "CUBEMX_LAYOUT_UNSUPPORTED"
        );
        await fs.writeFile(ioc, nestedContent);
        await fs.writeFile(path.join(project, "main.c"), "baud=115200;\n");
        service.options.run = async (...params) => {
            await fakeRun(...params);
            await fs.writeFile(path.join(project, "app.c"), "concurrent");
            return {};
        };
        await rejects(() => service.execute(), "CUBEMX_PROJECT_CHANGED");
        assert.strictEqual(await fs.readFile(path.join(project, "app.c"), "utf8"), "concurrent");
        service.options.run = async () => {
            throw Object.assign(new Error("missing package"), { code: "CUBEMX_GENERATION_FAILED" });
        };
        await rejects(() => service.execute(), "CUBEMX_GENERATION_FAILED");
        service.options.run = fakeRun;
        const controller = new AbortController();
        controller.abort();
        await rejects(() => service.execute({}, controller.signal), "CUBEMX_CANCELLED");
        service.jobs.set(project, new AbortController());
        await rejects(() => service.execute(), "CUBEMX_BUSY");
        assert.strictEqual(service.cancel().cancelled, 1);
        service.jobs.clear();
        await service.permission({ action: "reset" });
        assert(!(await service.permission()).trusted);
        await rejects(() => service.permission({ action: "wrong" }), "INVALID_ARGUMENT");
        await rejects(
            () => service.prepare({ content: candidate.replace("6.12.0", "6.11.0") }),
            "CUBEMX_LAYOUT_UNSUPPORTED"
        );
        service.options.platform = "darwin";
        await rejects(() => service.inspect(), "CUBEMX_PLATFORM_UNSUPPORTED");
        service.options.platform = "win32";
        config.iocPath = "";
        await rejects(() => service.inspect(), "CUBEMX_IOC_MISSING");
        config.iocPath = ioc;

        const before = await snapshot(project);
        const after = new Map(before);
        after.set("app.c", { bytes: Buffer.from("new"), hash: hash("new") });
        after.set("main.c", { bytes: Buffer.from("new main"), hash: hash("new main") });
        let writes = 0;
        await rejects(
            () =>
                applyFiles(project, before, after, path.join(root, "backup"), {
                    writeFile: async (...p) => {
                        if (++writes === 2) throw new Error("disk full");
                        return fs.writeFile(...p);
                    }
                }),
            "CUBEMX_WRITE_FAILED"
        );
        assert.strictEqual(await fs.readFile(path.join(project, "app.c"), "utf8"), "concurrent");
        const user = new Map([
            ["main.c", { bytes: Buffer.from("/* USER CODE BEGIN 0 */\napp();\n/* USER CODE END 0 */") }]
        ]);
        assertUserCodePreserved(user, user);
        assert.throws(() => assertUserCodePreserved(user, new Map()), /user code/);

        const state = memory();
        const settings = new Map();
        let picked;
        const v = {
            ConfigurationTarget: { Global: 1 },
            workspace: {
                workspaceFolders: [{ uri: { fsPath: project } }],
                findFiles: async () => [{ fsPath: ioc }],
                getConfiguration: () => ({
                    get: (key, fallback) => settings.get(key) || fallback,
                    update: async (key, value) => settings.set(key, value)
                })
            },
            window: { showQuickPick: async () => picked, showOpenDialog: async () => [{ fsPath: ioc }] }
        };
        const ui = new CubeMxConfiguration({
            vscode: v,
            context: { workspaceState: state },
            changed: () => {},
            t: (key) => key
        });
        assert.strictEqual(await workspaceIoc(v, ioc), ioc);
        await rejects(() => workspaceIoc(v, tool.executable), "PATH_OUTSIDE_WORKSPACE");
        assert.strictEqual(await workspaceIoc(v, ""), "");
        assert.strictEqual(state.get("mcu.iocPath"), undefined);
        assert.strictEqual(await ui.detectIoc(), ioc);
        v.workspace.findFiles = async () => [{ fsPath: ioc }, { fsPath: ioc }];
        picked = undefined;
        assert.strictEqual(await ui.detectIoc(), "");
        assert.strictEqual(state.get("mcu.iocPath"), ioc);
        picked = { value: "" };
        await ui.select("ioc");
        assert.strictEqual(state.get("mcu.iocPath"), "");
        picked = { value: ioc };
        await ui.select("ioc");
        assert.strictEqual(state.get("mcu.iocPath"), ioc);
        settings.set("cubemxPath", tool.executable);
        if (process.platform === "win32") {
            assert.strictEqual((await ui.detect()).executable, tool.executable);
            settings.set("cubemxPath", path.join(root, "bad.exe"));
            assert.strictEqual(await ui.detect(), null);
            assert.strictEqual(ui.status, "cubemx.invalid");
        }

        const runnerDir = path.join(root, "runner");
        await fs.mkdir(runnerDir);
        const spawn =
            (mode, output, exitCode = 0) =>
            (_executable, argv, options) => {
                assert.strictEqual(options.shell, false);
                assert.strictEqual(options.windowsHide, true);
                assert(argv.includes("-q"));
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.kill = () => setImmediate(() => child.emit("close", 1));
                setImmediate(() => {
                    if (mode === "hang") return;
                    if (mode === "start-error") {
                        child.emit("error", new Error("no java"));
                        return;
                    }
                    child.stdout.emit(
                        "data",
                        Buffer.from(output ?? (mode === "error" ? "package not installed" : "generated successfully"))
                    );
                    child.emit("close", exitCode);
                });
                return child;
            };
        assert((await runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok") })).log.includes("successfully"));
        const scriptPath = path.join(runnerDir, ".emberprobe-cubemx-script.txt");
        await assert.rejects(fs.stat(scriptPath), { code: "ENOENT" }, "generation must await script cleanup");
        for (const errorFirst of [true, false]) {
            const completion = runCubeMx(tool, runnerDir, "demo.ioc", {
                spawn: () => {
                    const child = new EventEmitter();
                    child.stdout = new EventEmitter();
                    child.stderr = new EventEmitter();
                    child.kill = () => {};
                    setImmediate(() => {
                        child.stdout.emit("data", Buffer.from("generated successfully"));
                        if (errorFirst) child.emit("error", new Error("start failed"));
                        child.emit("close", 0);
                        if (!errorFirst) child.emit("error", new Error("late error"));
                    });
                    return child;
                }
            });
            if (errorFirst) await rejects(() => completion, "CUBEMX_START_FAILED");
            else await completion;
            await assert.rejects(fs.stat(scriptPath), { code: "ENOENT" });
        }
        const notice = "log4j user configuration file not found: C:\\Users\\ASUS/.stm32cubemx/log4j2.xml";
        const fallback = "Configure log4j with default settings from jar:file:/D:/software/CubeMX/";
        const cliLines = [
            notice,
            fallback,
            'config load "demo.ioc"',
            "OK",
            'project path "stage"',
            "OK",
            "project generate",
            "2026-09-12 16:14:12,807 [INFO] CodeEngine:321 - Generated code: C:/stage/Core/Src/main.c",
            "2026-09-12 16:14:13,704 [INFO] ProjectBuilder:5636 - Time for Generating toolchain IDE Files: 661mS.",
            "OK",
            "exit",
            "Bye bye"
        ];
        for (const newline of ["\n", "\r\n"]) {
            const output = cliLines.join(newline);
            assert.strictEqual(
                (await runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok", output) })).log,
                output
            );
        }
        for (const output of [
            "OK\nexit\nBye bye",
            'project path "stage"\nOK\nproject generate\nexit',
            "project generate\nGenerated code: Core/Src/main.c\nTime for Generating toolchain IDE Files: 661mS.",
            "project generate\n[INFO] status OK\nexit",
            "project generate\nexit\nOK",
            'project generate\nproject path "stage"\nOK\nexit',
            "project generate\nOK\nproject generate\nexit"
        ])
            await rejects(
                () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok", output) }),
                "CUBEMX_OUTPUT_UNCONFIRMED"
            );
        for (const [output, exitCode] of [
            [cliLines.join("\n"), 1],
            [cliLines.concat("[ERROR] generation failed").join("\n"), 0]
        ])
            await rejects(
                () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok", output, exitCode) }),
                "CUBEMX_GENERATION_FAILED"
            );
        for (const newline of ["\n", "\r\n"]) {
            const output = [notice, fallback, "Code generated successfully"].join(newline);
            const result = await runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok", output) });
            assert.strictEqual(result.log, output);
        }
        await rejects(
            () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok", notice + "\n" + fallback) }),
            "CUBEMX_OUTPUT_UNCONFIRMED"
        );
        await rejects(
            () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("ok", "generated successfully", 1) }),
            "CUBEMX_GENERATION_FAILED"
        );
        for (const diagnostic of [
            "[ERROR] generation failed",
            "java.lang.Exception: failure",
            "package not installed",
            "firmware not found",
            "migration required",
            "please download firmware",
            notice + " ERROR: generation failed"
        ])
            await rejects(
                () =>
                    runCubeMx(tool, runnerDir, "demo.ioc", {
                        spawn: spawn("ok", [notice, fallback, diagnostic, "generated successfully"].join("\n"))
                    }),
                "CUBEMX_GENERATION_FAILED"
            );
        await rejects(
            () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("error") }),
            "CUBEMX_GENERATION_FAILED"
        );
        await rejects(
            () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("start-error") }),
            "CUBEMX_START_FAILED"
        );
        await rejects(
            () => runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("hang"), timeoutMs: 10 }),
            "CUBEMX_TIMEOUT"
        );
        const abort = new AbortController();
        const running = runCubeMx(tool, runnerDir, "demo.ioc", { spawn: spawn("hang"), signal: abort.signal });
        setTimeout(() => abort.abort(), 10);
        await rejects(() => running, "CUBEMX_CANCELLED");
        await rejects(() => runCubeMx(tool, runnerDir, "demo.ioc", { signal: abort.signal }), "CUBEMX_CANCELLED");
        console.log("CubeMX environment, authorization, generation, recovery and configuration tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

    await scenario("Clean up a CubeMX script when cancelled before process startup", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-cubemx-cancel-"));
        const script = path.join(root, ".emberprobe-cubemx-script.txt");
        const controller = new AbortController();
        const writeFile = fs.writeFile;
        const options = {
            signal: controller.signal,
            spawn: () => assert.fail("cancelled generation must not start CubeMX")
        };
        const run = () => runCubeMx({ executable: "fake", platform: "linux" }, root, "project.ioc", options);
        try {
            // Abort while the asynchronous write is in flight, before runCubeMx can start the process.
            fs.writeFile = async (...args) => {
                const result = await writeFile(...args);
                if (args[0] === script) controller.abort();
                return result;
            };
            try {
                await rejects(run, "CUBEMX_CANCELLED");
            } finally {
                fs.writeFile = writeFile;
            }
            await assert.rejects(fs.stat(script), { code: "ENOENT" }, "cancellation must await script cleanup");
            // A pre-aborted call creates nothing and leaves a script owned by another operation alone.
            await rejects(run, "CUBEMX_CANCELLED");
            await assert.rejects(fs.stat(script), { code: "ENOENT" });
            await fs.writeFile(script, "another operation");
            await rejects(run, "CUBEMX_CANCELLED");
            assert.strictEqual(await fs.readFile(script, "utf8"), "another operation");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    await scenario("Retain project ownership while CubeMX process exit is unconfirmed", async () => {
        const tick = () => new Promise((resolve) => setImmediate(resolve));
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-cubemx-exit-"));
        try {
            const cubeChild = new EventEmitter();
            cubeChild.stdout = new EventEmitter();
            cubeChild.stderr = new EventEmitter();
            cubeChild.pid = 101;
            const cubeKills = [];
            cubeChild.kill = (signal) => cubeKills.push(signal || "SIGTERM");
            const cube = new CubeMxService({ storage: { get() {} }, storageDir: root });
            cube.jobs.set(root, { controller: new AbortController() });
            await assert.rejects(
                runCubeMx({ executable: "fake", platform: "linux" }, root, "project.ioc", {
                    spawn: () => cubeChild,
                    timeoutMs: 5,
                    killGraceMs: 5,
                    exitTimeoutMs: 30,
                    onExitUnconfirmed: (exited, retry) => cube._retainProcess(root, exited, retry)
                }),
                { code: "CUBEMX_EXIT_UNCONFIRMED" }
            );
            await cube._finishJob(root, "operation");
            assert.ok(cube.jobs.has(root), "retain project ownership while process is alive");
            cube.cancel();
            assert.ok(cubeKills.includes("SIGKILL"));
            cubeChild.emit("close", 1);
            await tick();
            assert.strictEqual(cube.jobs.has(root), false);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    await scenario(
        "Query asynchronous operations, generation failures, project drift and request deduplication",
        async () => {
            const { createLogMonitor } = require("../src/services/cubemxLog");
            const { applyFiles } = require("../src/services/cubemxProject");
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
            const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-operations-")));
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
                        const logPath = path.join(directory, ".emberprobe-cubemx-output.log");
                        await fs.writeFile(logPath, "early warning\n" + "x".repeat(1024 * 1024 + 100));
                        return {
                            generatedFiles: [target],
                            logPath,
                            warnings: ["ordinary warning"],
                            log: "project generate\nOK\nexit\n"
                        };
                    }
                });

                for (const message of [
                    "[WARN] Required firmware package not installed",
                    "[ERROR] generation failed; see warning details"
                ]) {
                    const monitor = createLogMonitor();
                    monitor.stdout(Buffer.from(message + "\nproject generate\nOK\nexit\n"));
                    assert(monitor.finish().failureLine, "blocking semantics must win over warnings");
                }
                const appFile = path.join(project, "application.c");
                await fs.writeFile(appFile, "int app = 1;\n");
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
                service.jobs.set(project, {
                    controller: fakeController,
                    operationId: "op_cancel_me",
                    type: "generate"
                });
                const cancelRes = service.cancel({ operationId: "op_cancel_me" });
                assert.strictEqual(cancelRes.cancelled, 1);
                assert.strictEqual(fakeController.signal.aborted, true);
                service.jobs.delete(project);

                await scenario("Merge candidate updates and deletions from changes files", async () => {
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
                    await fs.writeFile(
                        changesFileWithUpdates,
                        JSON.stringify({ updates: { "USART1.BaudRate": "19200" } })
                    );
                    const candidateMerged = await service.generateCandidate({
                        outputPath: "cand_merged.ioc",
                        changesFile: "updates-only.json",
                        deletions: ["PA10.Signal"]
                    });
                    assert(candidateMerged.changes.some((c) => c.key === "USART1.BaudRate"));
                    assert(candidateMerged.changes.some((c) => c.key === "PA10.Signal" && c.action === "deleted"));
                });
                await scenario("Replay a failed request without creating a duplicate operation", async () => {
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
                        (err) =>
                            err.code === "CUBEMX_GENERATION_FAILED" && err.message.includes("Simulated prior failure")
                    );
                    const allOps = await service.store.getOperations(project);
                    assert.strictEqual(allOps.filter((o) => o.requestId === "req_failed_retry").length, 1);
                });

                // Quick-check classification branches (against the committed manifest)

                const latest = await service.status({ operationId: startResult.operationId });
                assert((await fs.stat(latest.logPath)).size > 1024 * 1024, "full streamed log survives success");
                assert.deepStrictEqual(latest.result.warnings, ["ordinary warning"]);
                const mainRel = path.join("Core", "Src", "main.c");
                const mainCOriginal = await fs.readFile(main, "utf8"); // user code already edited (count=999)
                const mxprojectPath = path.join(project, ".mxproject");
                const mxprojectOriginal = await fs.readFile(mxprojectPath, "utf8");

                await fs.writeFile(appFile, "int app = 2;\n");
                assert.strictEqual(
                    (await service.check()).status,
                    "consistent",
                    "ordinary application changes are not generation drift"
                );
                await scenario("Detect missing files recorded by the generation manifest", async () => {
                    // Missing manifest file
                    await fs.rm(mxprojectPath);
                    const checkMissing = await service.check({ mode: "quick" });
                    assert.strictEqual(checkMissing.status, "drift_detected");
                    assert(
                        checkMissing.drift.some((entry) => entry.file === ".mxproject" && entry.action === "missing")
                    );
                    await fs.writeFile(mxprojectPath, mxprojectOriginal);
                });
                await scenario("Classify corrupt user code markers without guessing", async () => {
                    // Corrupted USER CODE markers -> unclassifiable, never guessed
                    await fs.writeFile(main, mainCOriginal.replace("/* USER CODE END 0 */\n", ""));
                    const checkCorrupted = await service.check({ mode: "quick" });
                    assert.strictEqual(checkCorrupted.status, "drift_detected");
                    assert.strictEqual(checkCorrupted.unclassifiedChanges.length, 1);
                    assert.strictEqual(checkCorrupted.unclassifiedChanges[0].reason, "mismatched_marker_count");
                    await fs.writeFile(main, mainCOriginal);
                });
                await scenario("Distinguish generated-region drift from user edits", async () => {
                    // Generated-region edit -> drift (not a user-code change)
                    await fs.writeFile(main, mainCOriginal.replace("int main()", "int main_renamed()"));
                    const checkGeneratedEdit = await service.check({ mode: "quick" });
                    assert.strictEqual(checkGeneratedEdit.status, "drift_detected");
                    assert(
                        checkGeneratedEdit.drift.some((entry) => entry.file === mainRel && entry.action === "modified")
                    );
                    assert.strictEqual(checkGeneratedEdit.userCodeChanges.length, 0);
                    await fs.writeFile(main, mainCOriginal);
                });
                await scenario("Identify changed user code blocks", async () => {
                    // User-code edit names the changed block(s)
                    await fs.writeFile(
                        main,
                        mainCOriginal.replace("int count = 999;", "int count = 777;\nint added = 1;")
                    );
                    const checkBlocks = await service.check({ mode: "quick" });
                    assert.strictEqual(checkBlocks.status, "consistent");
                    assert.deepStrictEqual(checkBlocks.userCodeChanges[0].blocks, ["0"]);
                    await fs.writeFile(main, mainCOriginal);
                });
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

                // Deep check as a queryable background operation

                const startedDeep = await service.check({ mode: "deep" });
                assert.strictEqual(startedDeep.status, "in_progress");
                assert(startedDeep.operationId);
                await service.activeExecutions.get(startedDeep.operationId);
                const deepBackgroundRecord = await service.store.getOperation(project, startedDeep.operationId);
                assert.strictEqual(deepBackgroundRecord.status, "succeeded");
                assert.strictEqual(deepBackgroundRecord.result.status, "consistent");

                await assert.rejects(service.check({ mode: "bogus" }), (err) => err.code === "INVALID_ARGUMENT");

                // Generation failure paths on an isolated second project

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

                await scenario("Report committed sources when saving the manifest fails", async () => {
                    // Manifest save failure: source files are committed, report must not pretend retry
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
                    assert.strictEqual(recordFailRec.status, "failed");
                    assert.strictEqual((await recordFailService.status()).error.code, "CUBEMX_RECORD_SAVE_FAILED");
                    assert.strictEqual(recordFailRec.sourceProjectStatus, "committed");
                });
                await scenario("Report unknown source state after readback verification fails", async () => {
                    // Readback verification failure -> source project status unknown
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
                });
                await scenario("Preserve concurrent pre-write changes without claiming rollback", async () => {
                    // Pre-write project change is "unchanged", never misreported as rolledBack
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
                });
                await scenario("Claim the project lock before awaiting operation persistence", async () => {
                    // Project lock is claimed synchronously: a concurrent start is deterministically busy
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
                });

                // Deep-check drift, invalidation, and failure diagnostics

                await fs.writeFile(main2, userCode + "int main() { return 0; }\nint drifted = 1;\n");
                await fs.writeFile(
                    path.join(project2, "Core", "Src", "usart.c"),
                    "leftover from a removed peripheral\n"
                );
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

                await scenario("Invalidate a deep check when its source changes concurrently", async () => {
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
                });
                await scenario("Retain deep-check diagnostics after removing staged files", async () => {
                    // Deep-check failure keeps its CubeMX log after the stage directory is removed
                    await fs.writeFile(main2, userCode + "int main() { return 0; }\n");
                    service2.options.run = async (_tool, directory) => {
                        await fs.writeFile(
                            path.join(directory, ".emberprobe-cubemx-output.log"),
                            "deep run exploded\n"
                        );
                        throw new Error("CubeMX exploded");
                    };
                    await assert.rejects(service2.check({ mode: "deep", wait: true }), /CubeMX exploded/);
                    service2.options.run = standardRun;
                    const failureOps = await service2.store.getOperations(project2);
                    const failureRec = failureOps[failureOps.length - 1];
                    assert.strictEqual(failureRec.status, "failed");
                    assert(failureRec.error?.details?.logPath, "persisted deep-check log path recorded");
                    assert.strictEqual(
                        await fs.readFile(failureRec.error.details.logPath, "utf8"),
                        "deep run exploded\n"
                    );
                });

                // Request dedup replays: in-progress, failed and interrupted operations

                await scenario("Wait for a successful in-progress request replay", async () => {
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
                });
                await scenario("Propagate the original failure from an in-progress request replay", async () => {
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
                });
                await scenario("Reject replay of interrupted operations", async () => {
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
                });
                // Cancel with an unknown operation id reports zero cancellations
                const unknownCancel = service.cancel({ operationId: "op_missing" });
                assert.strictEqual(unknownCancel.cancelled, 0);
                assert(unknownCancel.message);
            } finally {
                await fs.rm(root, { recursive: true, force: true });
            }
        }
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
