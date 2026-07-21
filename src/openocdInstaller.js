"use strict";
// OpenOCD 捆绑预置包的一键安装：从插件内置 tar.gz 解压到全局存储目录，
// 解压进度通过 onentry 回调上报；安装成功后返回 openocd 可执行文件路径。
// 设计要点：
// - 离线可用，不依赖网络；
// - 安装目标为 context.globalStorageUri/emberprobe/openocd/，跨工作区共享、卸载随插件清理；
// - 预置包按 平台-架构 命名，未匹配当前平台时返回 null 由上层兜底（引导手动配置）。
const fs = require("fs");
const path = require("path");
const tar = require("tar");

// 预置包相对扩展根的目录；package.json 的 files 字段需包含 "resources/**/*"
const BUNDLED_DIR = "resources";
// Windows 下可执行文件名；macOS/Linux 为 openocd
const OPENOCD_BIN = process.platform === "win32" ? "openocd.exe" : "openocd";

// 返回当前平台-架构对应的预置包绝对路径；不存在返回 null。
// 扩展根通过传入的 context.asAbsolutePath 解析，避免 cwd 漂移。
function getBundledArchive(context) {
    const plat = platformKey();
    if (!plat) return null;
    const rel = path.join(BUNDLED_DIR, `openocd-${plat}.tar.gz`);
    const abs = context.asAbsolutePath(rel);
    try { fs.accessSync(abs, fs.constants.R_OK); } catch (e) { return null; }
    return abs;
}

// 平台标识：与预置包命名约定一致；未覆盖平台返回 null。
function platformKey() {
    const { platform, arch } = process;
    // 当前预置包为 win32-x64（i686 mingw 构建可在 x64 运行）
    if (platform === "win32" && arch === "x64") return "win32-x64";
    if (platform === "darwin" && arch === "x64") return "darwin-x64";
    if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
    if (platform === "linux" && arch === "x64") return "linux-x64";
    if (platform === "linux" && arch === "arm64") return "linux-arm64";
    return null;
}

// 计算安装目标目录：globalStorageUri/emberprobe/openocd/
// VS Code 保证 globalStorageUri 存在，但子目录需自行创建。
function installDir(context) {
    const base = context.globalStorageUri.fsPath;
    return path.join(base, "emberprobe", "openocd");
}

// 在已解压目录内定位 openocd 可执行文件：优先 bin/openocd(.exe)，
// 兼容 xpack 风格的顶层 xpack-openocd-*/openocd/bin/。
function locateOpenOcdBinary(root) {
    const candidates = [
        path.join(root, "bin", OPENOCD_BIN),
        // 兜底：解压出带版本号子目录的情况
        ...globFirst(root, d => fs.existsSync(path.join(d, "bin", OPENOCD_BIN)))
            .map(d => path.join(d, "bin", OPENOCD_BIN))
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* continue */ }
    }
    return null;
}
// 简易：列出 root 下的子目录用于兜底查找
function globFirst(root, predicate) {
    let out = [];
    try {
        for (const name of fs.readdirSync(root)) {
            const full = path.join(root, name);
            if (fs.statSync(full).isDirectory() && predicate(full)) out.push(full);
        }
    } catch (e) { /* ignore */ }
    return out;
}

// 安装预置包到全局存储目录；progress(report) 上报进度，verifyBinary 在替换旧版本前验证暂存文件。
// 返回 { ok, path?, version?, error? }；path 为 openocd 可执行文件绝对路径。
async function installBundledOpenOcd(vscode, context, progress, verifyBinary) {
    const archive = getBundledArchive(context);
    if (!archive) {
        return { ok: false, error: `当前平台（${process.platform}-${process.arch}）暂无预置 OpenOCD 包，请手动安装后用「配置 OpenOCD 路径」选择` };
    }
    const dest = installDir(context);
    const parent = path.dirname(dest);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staging = path.join(parent, `.openocd-staging-${nonce}`);
    const backup = path.join(parent, `.openocd-backup-${nonce}`);
    fs.mkdirSync(staging, { recursive: true });

    // tar.x 流式解压；onentry 每处理一个条目回调一次，用于推进进度
    let total = 0;
    let processed = 0;
    try {
        // 先统计条目数以计算百分比，避免进度跳跃
        await tar.t({ file: archive, onentry: () => { total++; } });
        if (total === 0) total = 1;
        if (progress) progress({ message: "正在解压 OpenOCD…", key: 'oc.extracting' });
        await tar.x({
            file: archive,
            cwd: staging,
            // 安全：剥离绝对路径与 .. 遍历（tar 包内均为相对路径，额外防御）
            preserveOwner: false,
            onentry: (entry) => {
                processed++;
                if (progress && processed % 10 === 0) {
                    const pct = Math.min(99, Math.round(processed / total * 100));
                    progress({ message: `正在解压 OpenOCD… ${pct}%`, key: 'oc.extractingPct', params: { pct }, increment: undefined });
                }
            }
        });
    } catch (error) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        return { ok: false, error: `解压失败：${error.message || error}` };
    }

    const bin = locateOpenOcdBinary(staging);
    if (!bin) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }
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
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            return { ok: false, error: `新安装验证失败：${verification?.error || 'OpenOCD 无法运行'}` };
        }
    }
    const relativeBin = path.relative(staging, bin);
    let movedOld = false;
    try {
        if (fs.existsSync(dest)) {
            fs.renameSync(dest, backup);
            movedOld = true;
        }
        fs.renameSync(staging, dest);
    } catch (error) {
        // 新目录切换失败时恢复旧安装；staging/backup 都限定在扩展全局存储子目录内。
        try { if (!fs.existsSync(dest) && movedOld && fs.existsSync(backup)) fs.renameSync(backup, dest); } catch (e) { /* ignore */ }
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        return { ok: false, error: `替换旧安装失败：${error.message || error}` };
    }
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e) { /* 下次安装不依赖该备份 */ }
    return { ok: true, path: path.join(dest, relativeBin), version: verification?.version || "", error: "", verification };
}

module.exports = {
    getBundledArchive,
    platformKey,
    installDir,
    locateOpenOcdBinary,
    installBundledOpenOcd,
    BUNDLED_DIR,
    OPENOCD_BIN
};
