"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { probeRsInstallCandidates, resolveProbeRsExecutable } = require("../src/services/probeRsEnvironment");
const {
    canInstallProbeRs,
    probeRsInstallerCommand,
    installProbeRs,
    WINDOWS_INSTALL_COMMAND,
    UNIX_INSTALL_COMMAND
} = require("../src/services/probeRsInstaller");
const { checkProbeRs, ProbeRsStatusService } = require("../src/services/probeRsStatusService");
const { getModernWebviewContent } = require("../src/modernView");
const { render } = require("./helpers/render-webview");
const { loadProvider } = require("./helpers/load-provider");

const ready = (executable) => ({ state: "ready", key: "pr.ready", path: executable, params: { version: "0.32.0" } });
const missing = () => ({ state: "missing", key: "pr.missing" });
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
};

function fixture(options = {}) {
    const values = { probeRsPath: "missing-probe-rs" };
    const statuses = [],
        writes = [],
        progress = [],
        reveals = [],
        notices = [];
    let installs = 0;
    const vscode = {
        ConfigurationTarget: { Workspace: 2, Global: 1 },
        ProgressLocation: { Notification: 15 },
        workspace: {
            isTrusted: true,
            workspaceFolders: options.noWorkspace ? [] : [{ uri: { fsPath: "/workspace" } }],
            getConfiguration: () => ({
                get: (key, fallback) => values[key] ?? fallback,
                update: async (key, value, target) => {
                    if (options.failSave) throw new Error("Cannot save configuration");
                    writes.push({ key, value, target });
                    values[key] = value;
                }
            })
        },
        commands: { executeCommand: async (command) => reveals.push(command) },
        window: {
            showOpenDialog: async () => [{ fsPath: "selected-probe-rs" }],
            showInformationMessage: (message) => notices.push(message),
            withProgress: async (settings, task) => {
                assert.equal(settings.location, 15);
                assert.equal(settings.cancellable, false);
                return task({ report: (message) => progress.push(message) });
            }
        }
    };
    const service = new ProbeRsStatusService({
        vscode,
        platform: "win32",
        candidates: () => ["installed-probe-rs"],
        check: async (executable) => (executable.includes("missing") ? missing() : ready(executable)),
        install: async ({ onLine }) => {
            installs++;
            onLine("downloading probe-rs-tools 0.32.0");
            onLine("installing to the user Cargo directory");
        },
        onStatus: (status) => statuses.push(status)
    });
    return { service, vscode, values, statuses, writes, progress, reveals, notices, installs: () => installs };
}

async function verifyInstaller() {
    const windows = probeRsInstallerCommand("win32", { SystemRoot: "D:\\Windows" });
    assert.equal(windows.executable, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.ok(windows.args.includes("-NonInteractive"));
    assert.ok(windows.args.at(-1).endsWith(WINDOWS_INSTALL_COMMAND));
    for (const platform of ["linux", "darwin"]) {
        assert.deepEqual(probeRsInstallerCommand(platform), {
            executable: "/bin/bash",
            args: ["-o", "pipefail", "-c", UNIX_INSTALL_COMMAND]
        });
        assert.equal(canInstallProbeRs(platform), true);
    }
    assert.equal(canInstallProbeRs("freebsd"), false);
    assert.throws(() => probeRsInstallerCommand("freebsd"), { code: "PROBE_RS_INSTALL_UNSUPPORTED" });
    let spawned;
    const lines = [];
    const run = (executable, args, settings, done) => {
        spawned = { executable, args, settings };
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        queueMicrotask(() => {
            stdout.write("downloading pro");
            stdout.write("be-rs\r\n\x1b[32minstalling\x1b[0m\n");
            stderr.end("finished");
            stdout.end("x".repeat(10000) + "\n");
            setImmediate(() => done(null, "installed", ""));
        });
        return { stdout, stderr };
    };
    await installProbeRs({ platform: "linux", run, onLine: (line) => lines.push(line) });
    assert.deepEqual(spawned.args, ["-o", "pipefail", "-c", UNIX_INSTALL_COMMAND]);
    assert.equal(spawned.settings.windowsHide, true);
    assert.equal(spawned.settings.timeout, 600000);
    assert.equal(spawned.settings.maxBuffer, 1024 * 1024);
    assert.ok(lines.includes("downloading probe-rs"));
    assert.ok(lines.includes("installing"));
    assert.ok(lines.includes("finished"));
    assert.ok(
        lines.every((line) => line.length <= 300),
        "bounded installer output reaches the UI"
    );
    const fail = (_executable, _args, _settings, done) => {
        queueMicrotask(() => done(new Error("Installer failed"), "", "network failure"));
        return {};
    };
    await assert.rejects(installProbeRs({ platform: "win32", run: fail }), /network failure/);
    await assert.rejects(
        installProbeRs({
            platform: "linux",
            run: () => {
                throw new Error("Spawn failed");
            }
        }),
        /Spawn failed/
    );
}

async function verifyDetection(root) {
    assert.deepEqual(
        probeRsInstallCandidates({ platform: "linux", env: { CARGO_HOME: "/custom cargo" }, home: "/home/user" }),
        ["/custom cargo/bin/probe-rs", "/home/user/.cargo/bin/probe-rs"]
    );
    assert.deepEqual(
        probeRsInstallCandidates({
            platform: "win32",
            env: { PROBE_RS_TOOLS_INSTALL_DIR: "C:\\custom", CARGO_DIST_FORCE_INSTALL_DIR: "C:\\ignored" },
            home: "C:\\Users\\user"
        }),
        ["C:\\custom\\bin\\probe-rs.exe", "C:\\Users\\user\\.cargo\\bin\\probe-rs.exe"]
    );
    assert.equal(
        probeRsInstallCandidates({
            platform: "linux",
            env: { CARGO_DIST_FORCE_INSTALL_DIR: "/forced" },
            home: "/home/user"
        })[0],
        "/forced/bin/probe-rs"
    );
    const binary = process.platform === "win32" ? "probe-rs.exe" : "probe-rs";
    const cargo = path.join(root, ".cargo", "bin");
    fs.mkdirSync(cargo, { recursive: true });
    const installed = path.join(cargo, binary);
    fs.writeFileSync(installed, "test executable");
    fs.chmodSync(installed, 0o755);
    const options = { env: {}, home: root };
    assert.equal(resolveProbeRsExecutable("probe-rs", options), installed, "detect Cargo even without refreshed PATH");
    assert.equal(resolveProbeRsExecutable("custom-missing-probe-rs", options), "custom-missing-probe-rs");
    assert.equal(resolveProbeRsExecutable("", options), "");
    const first = path.join(root, "tools with spaces");
    fs.mkdirSync(first);
    const onPath = path.join(first, binary);
    fs.writeFileSync(onPath, "preferred executable");
    fs.chmodSync(onPath, 0o755);
    assert.equal(resolveProbeRsExecutable("probe-rs", { ...options, env: { Path: first } }), onPath);
    assert.equal(resolveProbeRsExecutable("probe-rs", { env: {}, home: path.join(root, "absent") }), "probe-rs");
    let checked;
    const detected = await checkProbeRs("configured path", {
        resolve: (target) => target,
        run: (executable, args, settings, done) => {
            checked = { executable, args, settings };
            done(null, "", "probe-rs 0.32.0\n");
        }
    });
    assert.equal(detected.state, "ready");
    assert.equal(detected.path, "configured path");
    assert.deepEqual(checked.args, ["--version"]);
    assert.equal(checked.settings.timeout, 5000);
    assert.equal(
        (
            await checkProbeRs("missing", {
                resolve: (target) => target,
                run: (_exe, _args, _opts, done) => done({ code: "ENOENT" })
            })
        ).state,
        "missing"
    );
    assert.equal((await checkProbeRs(process.execPath)).state, "error", "reject executables that are not probe-rs");
}

async function verifyService() {
    const f = fixture();
    assert.equal(await f.service.refresh(), null);
    assert.equal(f.statuses.at(-1).canInstall, true);
    assert.equal(await f.service.resolve("missing"), null);
    assert.equal(f.reveals.at(-1), "workbench.view.extension.mcu-vscode-container");
    assert.equal(await f.service.handleAction("install"), "installed-probe-rs");
    assert.equal(f.installs(), 1);
    assert.deepEqual(f.writes, [{ key: "probeRsPath", value: "installed-probe-rs", target: 2 }]);
    assert.equal(f.statuses.at(-1).key, "pr.installedReady");
    assert.ok(f.statuses.some((status) => status.key === "pr.verifying" && status.state === "installing"));
    assert.ok(f.progress.some((event) => event.message.includes("downloading")));
    assert.equal(f.notices.length, 1);
    const picked = fixture({ noWorkspace: true });
    assert.equal(await picked.service.handleAction("select"), "selected-probe-rs");
    assert.equal(picked.writes[0].target, 1, "a window without a workspace can save a machine path");
    const cancelled = fixture();
    cancelled.vscode.window.showOpenDialog = async () => undefined;
    assert.equal(await cancelled.service.handleAction("select"), null);
    assert.equal(cancelled.writes.length, 0);
    const invalid = fixture();
    invalid.vscode.window.showOpenDialog = async () => [{ fsPath: "missing-selection" }];
    assert.equal(await invalid.service.handleAction("select"), null);
    assert.equal(invalid.writes.length, 0);
    assert.equal(invalid.statuses.at(-1).state, "missing");
    invalid.service.check = async () => {
        throw new Error("check failed");
    };
    assert.equal(await invalid.service.refresh(), null);
    assert.equal(await invalid.service.handleAction("select"), null);
    assert.equal(invalid.statuses.at(-1).state, "error");
    for (const failSave of [false, true]) {
        const failed = fixture({ failSave });
        if (!failSave)
            failed.service.install = async () => {
                throw new Error("network failure");
            };
        assert.equal(await failed.service.handleAction("install"), null);
        assert.equal(failed.statuses.at(-1).key, "pr.installFailed");
        assert.equal(failed.statuses.at(-1).canInstall, true);
        assert.equal(failed.writes.length, 0);
        assert.equal(failed.service.installing, null);
    }
    const unverified = fixture();
    unverified.service.check = async () => missing();
    assert.equal(await unverified.service.handleAction("install"), null);
    assert.equal(unverified.writes.length, 0);
    assert.match(unverified.statuses.at(-1).params.error, /no working probe-rs/);
    const busy = fixture();
    busy.service.assertEditable = () => {
        throw new Error("Probe is busy");
    };
    await assert.rejects(busy.service.handleAction("install"), /busy/);
    assert.equal(busy.installs(), 0);
    await assert.rejects(busy.service.handleAction("select"), /busy/);
    const unsupported = fixture();
    unsupported.service.platform = "freebsd";
    unsupported.service.install = installProbeRs;
    assert.equal(await unsupported.service.handleAction("install"), null);
    assert.equal(unsupported.statuses.at(-1).canInstall, false);
}

async function verifyRaces() {
    const f = fixture();
    const wait = deferred();
    f.service.install = async () => wait.promise;
    const first = f.service.handleAction("install");
    const second = f.service.handleAction("install");
    const count = f.statuses.length;
    assert.equal(await f.service.refresh(), null);
    assert.equal(await f.service.handleAction("select"), null);
    assert.equal(await f.service.resolve("missing"), null);
    assert.equal(f.statuses.length, count, "refreshes do not overwrite installation progress");
    wait.resolve();
    assert.deepEqual(await Promise.all([first, second]), ["installed-probe-rs", "installed-probe-rs"]);
    assert.equal(f.writes.length, 1, "duplicate clicks share one installation and configuration write");
    const stale = fixture();
    const installation = deferred();
    stale.service.install = async () => installation.promise;
    const installing = stale.service.handleAction("install");
    stale.values.probeRsPath = "new-user-path";
    installation.resolve();
    assert.equal(await installing, null);
    assert.equal(stale.values.probeRsPath, "new-user-path");
    assert.equal(stale.writes.length, 0);
    const changed = fixture();
    changed.vscode.window.showOpenDialog = async () => {
        changed.values.probeRsPath = "new-user-path";
        return [{ fsPath: "selected-probe-rs" }];
    };
    assert.equal(await changed.service.handleAction("select"), "new-user-path");
    assert.equal(changed.writes.length, 0);
    const older = fixture();
    const detection = deferred();
    older.service.check = async (executable) =>
        executable === "missing-probe-rs" ? detection.promise : ready(executable);
    const old = older.service.refresh();
    older.values.probeRsPath = "new-user-path";
    assert.equal(await older.service.refresh(), "new-user-path");
    detection.resolve(missing());
    assert.equal(await old, null);
    assert.equal(older.statuses.at(-1).path, "new-user-path");
    const occupied = fixture();
    occupied.service.install = async () => {
        occupied.service.assertEditable = () => {
            throw new Error("Probe became busy");
        };
    };
    assert.equal(await occupied.service.handleAction("install"), null);
    assert.equal(occupied.writes.length, 0, "recheck ownership before saving the installed executable");
}

function verifyCard() {
    const html = getModernWebviewContent({ backend: "probe-rs" }, "zh");
    const view = render(html);
    let saved;
    try {
        const card = view.document.getElementById("backendCard");
        const install = view.document.getElementById("backendInstall");
        const bar = view.document.getElementById("backendProgress");
        view.send({ type: "backendStatus", backend: "probe-rs", ...missing(), canInstall: true });
        assert.equal(card.hidden, false);
        assert.equal(install.style.display, "");
        assert.equal(install.textContent, "一键安装");
        assert.equal(view.document.getElementById("backendSelectPath").textContent, "选择路径");
        install.click();
        assert.deepEqual(view.messages.at(-1), { type: "backendAction", action: "install" });
        view.send({
            type: "backendStatus",
            backend: "probe-rs",
            state: "installing",
            key: "pr.installOutput",
            params: { message: "downloading" },
            canInstall: true
        });
        assert.equal(bar.hidden, false);
        assert.equal(bar.hasAttribute("value"), false, "unknown download totals use honest indeterminate progress");
        assert.equal(card.getAttribute("aria-busy"), "true");
        assert.equal(install.disabled, true);
        saved = view.getState();
        view.send({ type: "setLang", lang: "en" });
        assert.equal(bar.hidden, false);
        view.send({ type: "backendStatus", backend: "openocd", state: "ready" });
        assert.equal(card.hidden, false, "ignore a stale response from the other backend");
        view.send({ type: "backendStatus", backend: "probe-rs", ...ready("installed") });
        assert.equal(card.hidden, true);
        assert.equal(bar.hidden, true);
        view.assertHealthy();
    } finally {
        view.close();
    }
    const restored = render(html, saved);
    try {
        assert.equal(restored.document.getElementById("backendProgress").hidden, false);
        restored.send({
            type: "backendStatus",
            backend: "probe-rs",
            state: "error",
            key: "pr.installFailed",
            params: { error: "network failure" },
            canInstall: true
        });
        assert.equal(restored.document.getElementById("backendProgress").hidden, true);
        assert.equal(restored.document.getElementById("backendInstall").disabled, false);
        restored.document.getElementById("backendSelectPath").click();
        assert.deepEqual(restored.messages.at(-1), { type: "backendAction", action: "select" });
    } finally {
        restored.close();
    }
}

async function verifyEntrypoints(root) {
    const f = fixture();
    const Provider = loadProvider(f.vscode);
    const provider = Object.create(Provider.prototype);
    const folder = { uri: { fsPath: root } };
    const elf = path.join(__dirname, "fixtures", "rust-globals.elf");
    Object.assign(provider, {
        _context: { workspaceState: { get: () => elf } },
        _commandContext: () => ({ folder }),
        _probeRsStatusService: f.service,
        _debugBridge: {
            activeSession: null,
            setWorkspace: () => {
                throw new Error("Missing tools cannot start debugging");
            }
        },
        _assertCpuIdle() {},
        _assertProbeDriverIdle() {},
        _assertProbeRsStartAvailable() {},
        _assertProbeRsDownloadAvailable() {}
    });
    assert.equal(
        await provider.prepareProbeRsDebug(folder, { request: "attach", chip: "STM32H723VG", executable: elf }),
        undefined
    );
    assert.equal(
        await provider._startProbeRsDebug("attach", undefined, false, { chip: "STM32H723VG", executable: elf }),
        false
    );
    assert.equal(await provider._downloadProbeRs(), false);
    assert.equal(f.reveals.length, 3, "debug, LiveWatch and flash missing-tool guards reveal the environment card");
    provider._debugBridge.activeSession = { configuration: { __emberprobeWatchOnly: true } };
    assert.equal(
        await provider.prepareProbeRsDebug(folder, { request: "attach", chip: "STM32H723VG", executable: elf }),
        undefined,
        "a missing executable does not stop an existing watch session"
    );
    provider._debugBridge.activeSession = null;
    f.service.check = async (executable) => {
        f.values.probeRsPath = "changed-during-detection";
        return ready(executable);
    };
    await assert.rejects(
        provider.prepareProbeRsDebug(folder, { request: "attach", chip: "STM32H723VG", executable: elf }),
        { code: "PROBE_RS_CONFIGURATION_CHANGED" }
    );
    const manifest = require("../package.json");
    assert.ok(manifest.contributes.commands.some((entry) => entry.command === "mcu-vscode.checkProbeRs"));
    const resourcePatterns = manifest.files.filter((pattern) => pattern.startsWith("resources/"));
    assert.deepEqual(resourcePatterns, ["resources/openocd-*.tar.gz", "resources/driver-helper/win32-x64/*"]);
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-probe-rs-environment-"));
    try {
        await verifyInstaller();
        await verifyDetection(root);
        await verifyService();
        await verifyRaces();
        verifyCard();
        await verifyEntrypoints(root);
        console.log(
            "probe-rs environment, official installation, progress, path validation, races and missing-tool guards passed"
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
