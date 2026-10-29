"use strict";
const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const targetManifest = require("../resources/openocd-targets-manifest.json");
const installer = require("../src/openocdInstaller");
const { discoverTargetConfigs } = require("../src/openocdScripts");
const { probeOpenOcd, probeDefaultOpenOcd, shouldUseBundledDefault } = require("../src/openocdChecker");
const {
    platformKey,
    getBundledArchive,
    installDir,
    locateOpenOcdBinary,
    installBundledOpenOcd,
    assertSafeEntryPath,
    OPENOCD_BIN
} = installer;

// 用 async IIFE 包裹，避免与 require 一起触发模块格式歧义
(async () => {
    // 解包路径断言（Zip Slip 纵深防御）：越出 staging 的条目必须拒绝
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ep-slip-"));
    try {
        assert.doesNotThrow(() => assertSafeEntryPath(staging, "bin/openocd.exe"));
        assert.doesNotThrow(() => assertSafeEntryPath(staging, "xpack-openocd-1.0/scripts/inner.cfg"));
        for (const evil of ["../evil.txt", "/etc/passwd", "a/../../evil"]) {
            assert.throws(
                () => assertSafeEntryPath(staging, evil),
                (error) => error.code === "UNSAFE_ARCHIVE_ENTRY",
                `entry path must be rejected: ${evil}`
            );
        }
        if (process.platform === "win32") {
            assert.throws(
                () => assertSafeEntryPath(staging, "C:\\evil\\openocd.exe"),
                (error) => error.code === "UNSAFE_ARCHIVE_ENTRY"
            );
        }
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }

    // 平台映射：当前进程平台应能映射到已知键或返回 null
    const key = platformKey();
    assert.ok(typeof key === "string" || key === null, "platformKey 必须返回 string 或 null");
    if (process.platform === "win32" && process.arch === "x64") {
        assert.strictEqual(key, "win32-x64", "win32-x64 应映射到预置包键");
    }

    // 用统一 mock context：asAbsolutePath 指向项目根用于定位预置包，globalStorageUri 指向临时目录用于解压
    const projectRoot = path.resolve(__dirname, "..");
    const linuxArchive = path.join(projectRoot, "resources", "openocd-linux-x64.tar.gz");
    assert.strictEqual(
        createHash("sha256").update(fs.readFileSync(linuxArchive)).digest("hex"),
        targetManifest.archives.find((item) => item.platform === "linux-x64").sha256,
        "Linux x64 预置包必须与合入兼容配置后的清单 SHA-256 一致"
    );
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-"));
    const mockContext = {
        asAbsolutePath: (p) => path.join(projectRoot, p),
        globalStorageUri: { fsPath: tmpBase }
    };
    const archive = getBundledArchive(mockContext);
    assert.strictEqual(shouldUseBundledDefault("/custom/openocd", mockContext), false);
    assert.strictEqual(await probeDefaultOpenOcd("/custom/openocd", mockContext), undefined);
    assert.strictEqual(shouldUseBundledDefault("openocd", { asAbsolutePath: () => "/missing/archive.tar.gz" }), false);
    if (["linux", "win32"].includes(process.platform) && process.arch === "x64") {
        assert.strictEqual(shouldUseBundledDefault("openocd", mockContext), true);
        assert.strictEqual(shouldUseBundledDefault("", mockContext), true);
        if (process.platform === "linux") assert.strictEqual(archive, linuxArchive);
        const progress = [];
        const [bundled, otherWindow] = await Promise.all([
            probeDefaultOpenOcd("openocd", mockContext, (event) => progress.push(event)),
            probeDefaultOpenOcd("openocd", mockContext)
        ]);
        assert.ok(bundled.found && bundled.compatible, JSON.stringify(bundled));
        assert.ok(otherWindow.found && otherWindow.compatible, JSON.stringify(otherWindow));
        assert.strictEqual(otherWindow.path, bundled.path, "跨窗口并发准备必须共享已发布的运行时");
        assert.strictEqual(bundled.bundled, true);
        assert.strictEqual(bundled.requested, "openocd");
        assert.ok(bundled.path.startsWith(tmpBase), "默认运行时必须安装在扩展全局存储内");
        assert.notStrictEqual(bundled.path, "/usr/bin/openocd");
        const installedAt = fs.statSync(bundled.path).mtimeMs;
        const reusedProgress = [];
        const reused = await probeDefaultOpenOcd("openocd", mockContext, (event) => reusedProgress.push(event));
        assert.strictEqual(reused.path, bundled.path);
        assert.strictEqual(fs.statSync(bundled.path).mtimeMs, installedAt, "重复解析不得覆盖缓存的运行时");
        assert.deepStrictEqual(reusedProgress, [], "复用已验证的运行时不得上报安装状态（避免烧录/调试时闪现安装卡片）");
        assert.ok(progress.some((event) => event.key === "oc.preparing" && event.state === "preparing"));
        assert.ok(progress.some((event) => event.key === "oc.extracting"));

        // A verified runtime is reused by its size and mtime without starting it again; a stamp change re-verifies.
        const executable = fs.readFileSync(bundled.path);
        const stampAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
        fs.utimesSync(bundled.path, stampAt, stampAt);
        assert.ok((await probeDefaultOpenOcd("openocd", mockContext)).found, "a new stamp is verified by running it");
        fs.writeFileSync(bundled.path, Buffer.alloc(executable.length));
        fs.utimesSync(bundled.path, stampAt, stampAt);
        const cached = await probeDefaultOpenOcd("openocd", mockContext);
        assert.ok(cached.found && cached.compatible, "an unchanged stamp must not start the executable");
        assert.strictEqual(cached.path, bundled.path);
        fs.utimesSync(bundled.path, stampAt, new Date(stampAt.getTime() + 1000));
        assert.strictEqual((await probeDefaultOpenOcd("openocd", mockContext)).found, false);
        fs.writeFileSync(bundled.path, executable);
        assert.ok((await probeDefaultOpenOcd("openocd", mockContext)).found);

        // A damaged cached runtime must fail without falling back to the affected system build.
        fs.unlinkSync(bundled.path);
        const damaged = await probeDefaultOpenOcd("openocd", mockContext);
        assert.strictEqual(damaged.found, false);
        assert.strictEqual(damaged.errorKey, "oc.prepareFailed");
        assert.match(damaged.error, /缓存验证失败/);

        const corrupt = path.join(tmpBase, "default-corrupt.tar.gz");
        fs.writeFileSync(corrupt, "not a tar archive");
        const invalid = await probeDefaultOpenOcd("openocd", {
            asAbsolutePath: () => corrupt,
            globalStorageUri: { fsPath: tmpBase }
        });
        assert.strictEqual(invalid.found, false);
        assert.strictEqual(invalid.errorKey, "oc.prepareFailed");
    }
    if (archive) {
        // 当前平台有预置包：文件必须真实存在且可读
        assert.ok(fs.existsSync(archive), `预置包应存在：${archive}`);
        assert.ok(archive.endsWith("openocd-win32-x64.tar.gz") || /\.tar\.gz$/.test(archive), "预置包应为 tar.gz");
    } else {
        // 当前平台无预置包：getBundledArchive 返回 null，不应抛错
        assert.strictEqual(archive, null);
    }

    // installDir：基于 mock context 的 globalStorageUri
    const dest = installDir(mockContext);
    assert.ok(dest.includes(path.join("emberprobe", "openocd")), "installDir 应包含 emberprobe/openocd 子目录");

    // 若有预置包，执行一次真实解压安装并定位可执行文件（解压到临时目录，不污染真实全局存储）
    const archiveForInstall = archive;
    if (archiveForInstall) {
        const progressCalls = [];
        const result = await installBundledOpenOcd(null, mockContext, (p) => progressCalls.push(p));
        assert.ok(result.ok, `安装应成功，实际：${result.error || JSON.stringify(result)}`);
        assert.ok(result.path, "安装成功应返回可执行文件路径");
        assert.ok(result.path.endsWith(OPENOCD_BIN), `路径应以 ${OPENOCD_BIN} 结尾，实际：${result.path}`);
        assert.ok(fs.existsSync(result.path), "解压出的可执行文件应真实存在");
        const probe = await probeOpenOcd(result.path);
        assert.ok(probe.found, `预置 OpenOCD 应可执行，实际：${probe.error || JSON.stringify(probe)}`);
        assert.ok(progressCalls.length > 0, "解压过程应上报进度");
        // locateOpenOcdBinary 独立验证
        const destRoot = installDir(mockContext);
        const located = locateOpenOcdBinary(destRoot);
        assert.ok(located, "locateOpenOcdBinary 应能在解压目录内定位到可执行文件");
        const targets = discoverTargetConfigs(located);
        assert.ok(targets.includes("geehy/apm32f0x.cfg"), "预置包应包含 APM32F0 target");
        assert.ok(targets.includes("geehy/apm32f1x.cfg"), "预置包应包含 APM32F1 target");
        assert.ok(targets.includes("geehy/apm32f4x.cfg"), "预置包应包含 APM32F4 target");
        // Configuration-only execution: explicit shutdown prevents implicit init or probe access.
        for (const target of targetManifest.targets) {
            const name = target.path.slice("target/".length);
            assert.ok(targets.includes(name), `merged configuration must be discoverable: ${name}`);
            const rz = name === "renesas_rz_g2.cfg";
            const load = (config, options = {}) => {
                const loaded = spawnSync(
                    located,
                    [
                        "-f",
                        rz ? "interface/dummy.cfg" : "interface/cmsis-dap.cfg",
                        "-c",
                        `transport select ${rz ? "jtag" : "swd"}`,
                        ...Object.entries(options).flatMap(([key, value]) => ["-c", `set ${key} ${value}`]),
                        "-f",
                        config,
                        "-c",
                        "echo EP_TARGETS=[target names]",
                        "-c",
                        "echo EP_BANKS=[flash list]",
                        "-c",
                        "echo EP_ADAPTER=[adapter name]",
                        "-c",
                        "echo EP_TRANSPORT=[transport select]",
                        "-c",
                        "shutdown"
                    ],
                    { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
                );
                const output = `${loaded.stdout || ""}\n${loaded.stderr || ""}`;
                assert.ifError(loaded.error);
                assert.strictEqual(loaded.status, 0, output);
                assert.match(output, /EP_TARGETS=\S+/);
                assert.ok(output.includes(`EP_ADAPTER=${rz ? "dummy" : "cmsis-dap"}`), output);
                assert.ok(output.includes(`EP_TRANSPORT=${rz ? "jtag" : "swd"}`), output);
                return output;
            };
            const output = load(target.path);
            assert.deepStrictEqual(
                output.match(/^EP_.*$/gm),
                load(target.canonical, target.options).match(/^EP_.*$/gm),
                `${name} must retain canonical target/bank declarations and adapter/transport`
            );
            if (name === "rp2040-core0.cfg") assert.match(output, /EP_TARGETS=rp2040\.core0\s*$/m);
        }

        // 新包损坏时安装应失败，但已经可用的旧目录必须原样保留。
        const marker = path.join(destRoot, "existing-install.marker");
        fs.writeFileSync(marker, "keep");
        const rejected = await installBundledOpenOcd(null, mockContext, null, async () => ({
            ok: false,
            error: "simulated runtime failure"
        }));
        assert.strictEqual(rejected.ok, false, "可执行性验证失败时必须中止安装");
        assert.ok(fs.existsSync(marker), "可执行性验证失败不得替换已有 OpenOCD");

        const corruptArchive = path.join(tmpBase, "corrupt.tar.gz");
        fs.writeFileSync(corruptArchive, "not a tar archive");
        const corruptContext = {
            asAbsolutePath: () => corruptArchive,
            globalStorageUri: { fsPath: tmpBase }
        };
        const failed = await installBundledOpenOcd(null, corruptContext);
        assert.strictEqual(failed.ok, false, "损坏的预置包必须安装失败");
        assert.ok(fs.existsSync(marker), "安装失败不得删除已有 OpenOCD");
        // 清理临时安装目录
        try {
            fs.rmSync(destRoot, { recursive: true, force: true });
        } catch (e) {
            /* ignore */
        }
    }

    // 清理临时基目录
    try {
        fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (e) {
        /* ignore */
    }

    console.log("OpenOCD installer tests passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
