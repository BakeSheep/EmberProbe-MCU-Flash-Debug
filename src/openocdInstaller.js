"use strict";
// Bundled OpenOCD runtime preparation: extracts the bundled tar.gz into global storage, reporting progress through the
// onentry callback, and returns the openocd executable path on success. Design points:
// - works offline;
// - manual installs go to globalStorageUri/emberprobe/openocd/, the automatic default runtime to sibling directories
// named by archive digest;
// - bundles are named platform-arch; an unmatched platform returns null so the caller can guide manual configuration.
const fs = require("fs");
const { createHash } = require("crypto");
const path = require("path");
const { leavesDirectory } = require("../skills/_emberprobe/file-identity");
const tar = require("tar");

// Bundle directory relative to the extension root; the files field of package.json must include "resources/**/*"
const BUNDLED_DIR = "resources";
// Executable name on Windows; openocd on macOS/Linux
const OPENOCD_BIN = process.platform === "win32" ? "openocd.exe" : "openocd";

// Returns the absolute path of the bundle for the current platform-arch, or null. The extension root is resolved
// through context.asAbsolutePath so cwd changes do not matter.
function getBundledArchive(context) {
    const plat = platformKey();
    if (!plat) return null;
    const rel = path.join(BUNDLED_DIR, `openocd-${plat}.tar.gz`);
    const abs = context.asAbsolutePath(rel);
    try {
        fs.accessSync(abs, fs.constants.R_OK);
    } catch (e) {
        return null;
    }
    return abs;
}

// Platform key matching the bundle naming convention; null for unsupported platforms.
function platformKey() {
    const { platform, arch } = process;
    // win32-x64 and linux-x64 are bundled; other platforms install offline only once a matching bundle is added.
    if (platform === "win32" && arch === "x64") return "win32-x64";
    if (platform === "darwin" && arch === "x64") return "darwin-x64";
    if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
    if (platform === "linux" && arch === "x64") return "linux-x64";
    if (platform === "linux" && arch === "arm64") return "linux-arm64";
    return null;
}

// Install target directory: globalStorageUri/emberprobe/openocd/. VS Code guarantees globalStorageUri exists, but
// subdirectories must be created.
function installDir(context) {
    const base = context.globalStorageUri.fsPath;
    return path.join(base, "emberprobe", "openocd");
}

// Finds the openocd executable in an extracted directory: bin/openocd(.exe) first, then the xpack layout
// xpack-openocd-*/openocd/bin/.
function locateOpenOcdBinary(root) {
    const candidates = [
        path.join(root, "bin", OPENOCD_BIN),
        // Fallback for archives that extract into a versioned subdirectory
        ...globFirst(root, (d) => fs.existsSync(path.join(d, "bin", OPENOCD_BIN))).map((d) =>
            path.join(d, "bin", OPENOCD_BIN)
        )
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (e) {
            /* continue */
        }
    }
    return null;
}
// Lists subdirectories of root for the fallback search
function globFirst(root, predicate) {
    let out = [];
    try {
        for (const name of fs.readdirSync(root)) {
            const full = path.join(root, name);
            if (fs.statSync(full).isDirectory() && predicate(full)) out.push(full);
        }
    } catch (e) {
        /* ignore */
    }
    return out;
}

// The archive only changes with an extension update, so its digest is reused while its stat matches.
const archiveDigests = new Map();
function archiveDigest(archive) {
    const stat = fs.statSync(archive);
    const key = `${archive}:${stat.mtimeMs}:${stat.size}`;
    let digest = archiveDigests.get(key);
    if (!digest) {
        digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
        if (archiveDigests.size >= 8) archiveDigests.clear();
        archiveDigests.set(key, digest);
    }
    return digest;
}

// Extraction path assertion: reject entries that resolve outside the staging directory (Zip Slip defence in depth;
// node-tar already strips absolute paths and "..", and this check guards against future changes)
function assertSafeEntryPath(staging, entryPath) {
    const target = path.resolve(staging, String(entryPath || ""));
    const relative = path.relative(staging, target);
    if (leavesDirectory(relative)) {
        throw Object.assign(new Error(`Refusing unsafe archive entry: ${entryPath}`), { code: "UNSAFE_ARCHIVE_ENTRY" });
    }
}

// Installs the bundle into global storage; progress(report) reports progress and verifyBinary checks the staged files
// before the old version is replaced. Returns { ok, path?, version?, error? }, where path is the absolute openocd
// executable path.
async function installBundledOpenOcd(vscode, context, progress, verifyBinary, { reuse = false } = {}) {
    const archive = getBundledArchive(context);
    if (!archive) {
        return {
            ok: false,
            error: `当前平台（${process.platform}-${process.arch}）暂无预置 OpenOCD 包，请选择可用的 OpenOCD 路径`
        };
    }
    // Automatic defaults use an archive-specific sibling directory, leaving manual installations
    // and runtimes from other extension versions intact, including those used by another window.
    const dest = reuse
        ? path.join(path.dirname(installDir(context)), `openocd-${platformKey()}-${archiveDigest(archive)}`)
        : installDir(context);
    if (reuse && fs.existsSync(dest)) {
        const binary = locateOpenOcdBinary(dest);
        let verification;
        try {
            verification = binary && verifyBinary ? await verifyBinary(binary) : null;
        } catch (error) {
            verification = { ok: false, error: error.message || String(error) };
        }
        if (!binary || !verification || verification.ok === false) {
            return { ok: false, error: `预置 OpenOCD 缓存验证失败：${verification?.error || "缺少可用的可执行文件"}` };
        }
        return { ok: true, path: binary, version: verification.version || "", verification, error: "" };
    }
    if (progress) progress({ message: "正在准备内置 OpenOCD…", key: "oc.preparing" });
    const parent = path.dirname(dest);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staging = path.join(parent, `.openocd-staging-${nonce}`);
    const backup = path.join(parent, `.openocd-backup-${nonce}`);
    fs.mkdirSync(staging, { recursive: true });

    // tar.x extracts as a stream; onentry fires once per entry to advance progress
    let total = 0;
    let processed = 0;
    try {
        // Count entries first to compute percentages without jumps
        await tar.t({
            file: archive,
            onentry: () => {
                total++;
            }
        });
        if (total === 0) total = 1;
        if (progress) progress({ message: "正在解压 OpenOCD…", key: "oc.extracting" });
        await tar.x({
            file: archive,
            cwd: staging,
            // Strip absolute paths and .. traversal (archive paths are all relative; extra defence)
            preserveOwner: false,
            onentry: (entry) => {
                assertSafeEntryPath(staging, entry.path);
                processed++;
                if (progress && processed % 10 === 0) {
                    const pct = Math.min(99, Math.round((processed / total) * 100));
                    progress({
                        message: `正在解压 OpenOCD… ${pct}%`,
                        key: "oc.extractingPct",
                        params: { pct },
                        increment: undefined
                    });
                }
            }
        });
    } catch (error) {
        try {
            fs.rmSync(staging, { recursive: true, force: true });
        } catch (e) {
            /* ignore */
        }
        return { ok: false, error: `解压失败：${error.message || error}` };
    }

    const bin = locateOpenOcdBinary(staging);
    if (!bin) {
        try {
            fs.rmSync(staging, { recursive: true, force: true });
        } catch (e) {
            /* ignore */
        }
        return { ok: false, error: `解压完成但未找到 ${OPENOCD_BIN}，请检查预置包结构` };
    }
    let verification = null;
    if (verifyBinary) {
        try {
            verification = await verifyBinary(bin);
        } catch (error) {
            verification = { ok: false, error: error.message || String(error) };
        }
        if (!verification || verification.ok === false) {
            try {
                fs.rmSync(staging, { recursive: true, force: true });
            } catch (e) {
                /* ignore */
            }
            return { ok: false, error: `新安装验证失败：${verification?.error || "OpenOCD 无法运行"}` };
        }
    }
    const relativeBin = path.relative(staging, bin);
    let movedOld = false;
    try {
        if (!reuse && fs.existsSync(dest)) {
            fs.renameSync(dest, backup);
            movedOld = true;
        }
        fs.renameSync(staging, dest);
    } catch (error) {
        // Another VS Code window may have published this exact archive while we extracted it.
        // Reuse its verified runtime without moving or replacing files it may already be running.
        if (reuse && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) && fs.existsSync(dest)) {
            fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            return installBundledOpenOcd(vscode, context, progress, verifyBinary, { reuse: true });
        }
        // Restore the old install if switching to the new directory fails; staging and backup stay inside the
        // extension's global storage subdirectory.
        try {
            if (!fs.existsSync(dest) && movedOld && fs.existsSync(backup)) fs.renameSync(backup, dest);
        } catch (e) {
            /* ignore */
        }
        try {
            fs.rmSync(staging, { recursive: true, force: true });
        } catch (e) {
            /* ignore */
        }
        return { ok: false, error: `替换旧安装失败：${error.message || error}` };
    }
    try {
        fs.rmSync(backup, { recursive: true, force: true });
    } catch (e) {
        /* The next install does not depend on this backup */
    }
    return {
        ok: true,
        path: path.join(dest, relativeBin),
        version: verification?.version || "",
        error: "",
        verification
    };
}

module.exports = {
    getBundledArchive,
    platformKey,
    installDir,
    locateOpenOcdBinary,
    installBundledOpenOcd,
    archiveDigest,
    assertSafeEntryPath,
    BUNDLED_DIR,
    OPENOCD_BIN
};
