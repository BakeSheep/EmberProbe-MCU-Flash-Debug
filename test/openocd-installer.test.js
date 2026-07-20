"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const installer = require("../src/openocdInstaller");
const { platformKey, getBundledArchive, installDir, locateOpenOcdBinary, installBundledOpenOcd, OPENOCD_BIN } = installer;

// 用 async IIFE 包裹，避免与 require 一起触发模块格式歧义
(async () => {
    // 平台映射：当前进程平台应能映射到已知键或返回 null
    const key = platformKey();
    assert.ok(typeof key === "string" || key === null, "platformKey 必须返回 string 或 null");
    if (process.platform === "win32" && process.arch === "x64") {
        assert.strictEqual(key, "win32-x64", "win32-x64 应映射到预置包键");
    }

    // 用统一 mock context：asAbsolutePath 指向项目根用于定位预置包，globalStorageUri 指向临时目录用于解压
    const projectRoot = path.resolve(__dirname, "..");
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-"));
    const mockContext = {
        asAbsolutePath: (p) => path.join(projectRoot, p),
        globalStorageUri: { fsPath: tmpBase }
    };
    const archive = getBundledArchive(mockContext);
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
        assert.ok(progressCalls.length > 0, "解压过程应上报进度");
        // locateOpenOcdBinary 独立验证
        const destRoot = installDir(mockContext);
        const located = locateOpenOcdBinary(destRoot);
        assert.ok(located, "locateOpenOcdBinary 应能在解压目录内定位到可执行文件");

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
        try { fs.rmSync(destRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }

    // 清理临时基目录
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log("OpenOCD installer tests passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
