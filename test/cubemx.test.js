"use strict";
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
        const tool = await installation(path.join(install, "STM32CubeMX.exe"));
        assert.strictEqual(tool.version, "6.12.0");
        // Non-default installs are recorded by CubeMX itself, even without PATH,
        // uninstall registry entries or version.xml in the installation.
        const updaterDirectory = path.join(root, ".stm32cubemx/plugins/updater");
        await fs.mkdir(updaterDirectory, { recursive: true });
        const updaterFile = path.join(updaterDirectory, "updater.ini");
        await fs.writeFile(updaterFile, `SoftwarePath=${install}${path.sep}\r\nSoftVersion=MX.6.17.0\r\n`);
        await fs.unlink(path.join(install, "version.xml"));
        const updaterOptions = { env: { USERPROFILE: root }, exec: async () => ({ stdout: "" }) };
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
            (await discover({ env: { PATH: install }, exec: async () => ({ stdout: "" }) })).executable,
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
        service.options.platform = "linux";
        await rejects(() => service.inspect(), "CUBEMX_WINDOWS_ONLY");
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
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
