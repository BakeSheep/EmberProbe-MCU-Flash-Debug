"use strict";
// OpenOCD 环境探测、安装引导与路径配置。
// 设计要点：
// - 不修改系统 PATH / rc 文件 / 注册表，零系统副作用；
// - 通过 emberprobe.openocdPath 扩展配置项指向 openocd 绝对路径即可运行；
// - 内存级缓存避免每次烧录/调试/实时查看都重新探测；
// - 所有检测与安装状态通过回调交给侧边栏展示，不发送通知弹窗。

const { spawn } = require("child_process");
const installer = require("./openocdInstaller");

const OPENOCD_GETTING_STARTED_URL = "https://openocd.org/pages/getting-openocd/";

// 内存级探测结果缓存
let _cachedResult = null;

// 从输出文本中提取 OpenOCD 版本号，兼容多种格式：
//   Open On-Chip Debugger 0.12.0
//   Open On-Chip Debugger 0.11.0-rc2 (2021-09-30-15:23)
function parseVersion(text) {
    if (!text) return '';
    const m = String(text).match(/open on-chip debugger\s+v?(\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?)/i);
    if (m) return m[1];
    const m2 = String(text).match(/openocd[^\d]*v?(\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?)/i);
    return m2 ? m2[1] : '';
}

// 探测指定可执行文件是否为可运行的 OpenOCD。
// spawn 失败（ENOENT）或 5s 内无响应均视为未找到；返回结构化结果供上层判断。
function probeOpenOcd(executable) {
    const target = executable && String(executable).trim();
    if (!target) {
        return Promise.resolve({ found: false, path: '', version: '', error: '未配置 OpenOCD 路径' });
    }
    // Windows 上裸命令名（无路径分隔符、无扩展名）先通过 where.exe 解析完整路径，
    // 避免 spawn shell:false 对 PATH 搜索不健壮的问题。
    const needsResolve = process.platform === 'win32'
        && !target.includes('\\') && !target.includes('/')
        && !/\.\w+$/.test(target);
    const doProbe = (resolved) => new Promise((resolve) => {
        let child;
        try {
            // windowsHide 避免一闪而过的控制台窗口；shell:false 直接调用，避免 PATH 注入
            child = spawn(resolved, ['--version'], { windowsHide: true, shell: false });
        } catch (error) {
            resolve({ found: false, path: resolved, version: '', error: error.code === 'ENOENT' ? '找不到该可执行文件' : error.message });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) { /* ignore */ }
            done({ found: false, path: resolved, version: '', error: '探测超时' });
        }, 5000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (error) => {
            const msg = error.code === 'ENOENT' ? '找不到该可执行文件（请确认路径或将其加入 PATH）' : error.message;
            done({ found: false, path: resolved, version: '', error: msg });
        });
        child.on('close', (code) => {
            const out = `${stdout}\n${stderr}`;
            const version = parseVersion(out);
            // 多数版本 --version 退出码为 0；个别老版本/特殊构建退出码非 0 但仍会打印标识，
            // 只要输出含 "open on-chip debugger" 即视为可运行，避免误判。
            if (version || /open on-chip debugger/i.test(out)) {
                done({ found: true, path: resolved, version, error: '' });
            } else {
                done({ found: false, path: resolved, version: '', error: code ? `退出码 ${code}，且输出无法识别为 OpenOCD` : '所选文件不是有效的 OpenOCD' });
            }
        });
    });
    if (!needsResolve) return doProbe(target);
    // Windows 裸命令名：先用 where.exe 解析完整路径，失败则回退到原始名称
    return new Promise((resolve) => {
        let out = '';
        let settled = false;
        const finish = (resolved) => { if (!settled) { settled = true; resolve(resolved); } };
        const t = setTimeout(() => finish(doProbe(target)), 3000);
        try {
            const w = spawn('where.exe', [target], { windowsHide: true, shell: false });
            w.stdout.on('data', (d) => { out += d.toString(); });
            w.on('error', () => { clearTimeout(t); finish(doProbe(target)); });
            w.on('close', () => {
                clearTimeout(t);
                const first = out.split(/\r?\n/).map(l => l.trim()).find(l => l);
                finish(doProbe(first || target));
            });
        } catch (e) {
            clearTimeout(t);
            finish(doProbe(target));
        }
    });
}

function getCachedResult() { return _cachedResult; }
function setCache(result) { _cachedResult = result; }
function resetCache() { _cachedResult = null; }
function reportStatus(report, status) {
    if (typeof report === 'function') report(status);
}

// 将路径写入当前实际使用的配置层级。打开工作区时优先写入 Workspace，
// 并同步替换值仍等于旧路径的 Folder 覆盖项，避免 Global 值被更高优先级设置遮蔽。
async function persistOpenOcdPath(vscode, fsPath, previousPath) {
    const folders = vscode.workspace.workspaceFolders || [];
    const target = folders.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('emberprobe').update('openocdPath', fsPath, target);
    if (folders.length && vscode.ConfigurationTarget.WorkspaceFolder !== undefined) {
        for (const folder of folders) {
            const scoped = vscode.workspace.getConfiguration('emberprobe', folder.uri);
            const inspected = typeof scoped.inspect === 'function' ? scoped.inspect('openocdPath') : null;
            if (inspected?.workspaceFolderValue !== undefined
                && String(inspected.workspaceFolderValue).trim() === String(previousPath || '').trim()) {
                await scoped.update('openocdPath', fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
            }
        }
    }
    return fsPath;
}

// 通过文件选择器让用户选中 openocd(.exe)，立即验证并写入扩展配置；返回最终路径或 null。
async function pickOpenOcdPath(vscode, report) {
    const isWin = process.platform === 'win32';
    const previousPath = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: '选择 OpenOCD',
        filters: isWin ? { 'OpenOCD 可执行文件': ['exe'], '所有文件': ['*'] } : { '所有文件': ['*'] }
    });
    if (!uris || !uris.length) return null;
    const fsPath = uris[0].fsPath;
    reportStatus(report, { state: 'checking', message: '正在验证所选 OpenOCD…' });
    const result = await probeOpenOcd(fsPath);
    if (result.found) {
        await persistOpenOcdPath(vscode, fsPath, previousPath);
        // 配置变更监听会 resetCache；这里同步更新缓存，使本次后续动作立即可用
        _cachedResult = result;
        reportStatus(report, { state: 'ready', message: result.version ? `OpenOCD v${result.version} 已就绪` : 'OpenOCD 已就绪', result });
        return fsPath;
    }
    reportStatus(report, { state: 'error', message: `所选文件不可用：${result.error || '请重新选择'}`, result });
    return null;
}

// 一键安装：从插件预置包解压到全局存储目录，通过 report 将状态发送给侧边栏。
// 返回安装并配置后的最终路径，失败返回 null。
async function installBundledAndConfigure(vscode, context, report) {
    const previousPath = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
    const archive = installer.getBundledArchive(context);
    if (!archive) {
        // 当前平台无预置包，回退到打开官方下载页
        await vscode.env.openExternal(vscode.Uri.parse(OPENOCD_GETTING_STARTED_URL));
        reportStatus(report, { state: 'missing', canInstall: false, message: `当前平台（${process.platform}-${process.arch}）暂无预置包；已打开下载页，安装后请选择 OpenOCD 路径` });
        return null;
    }
    try {
        let stagedProbe = null;
        reportStatus(report, { state: 'installing', message: '正在准备安装 OpenOCD…' });
        const result = await installer.installBundledOpenOcd(vscode, context, (p) => {
            if (p.message) reportStatus(report, { state: 'installing', message: p.message });
        }, async (candidate) => {
            reportStatus(report, { state: 'checking', message: '正在验证 OpenOCD…' });
            stagedProbe = await probeOpenOcd(candidate);
            return { ok: stagedProbe.found, version: stagedProbe.version, error: stagedProbe.error };
        });
        if (!result.ok) {
            reportStatus(report, { state: 'error', message: `OpenOCD 安装失败：${result.error || '未知错误'}` });
            return null;
        }
        // 暂存目录中的可执行文件已经在替换旧安装前验证；缓存路径需改成最终目录。
        const verify = stagedProbe
            ? { ...stagedProbe, path: result.path }
            : await probeOpenOcd(result.path);
        if (verify.found) {
            await persistOpenOcdPath(vscode, result.path, previousPath);
            setCache(verify);
            reportStatus(report, { state: 'ready', message: verify.version ? `OpenOCD v${verify.version} 已安装并就绪` : 'OpenOCD 已安装并就绪', result: verify });
            return result.path;
        }
        setCache(verify);
        reportStatus(report, { state: 'error', message: `OpenOCD 验证未通过：${verify.error || '请手动确认'}；原配置未更改`, result: verify });
        return null;
    } catch (error) {
        reportStatus(report, { state: 'error', message: `OpenOCD 安装失败：${error.message || error}` });
        return null;
    }
}

// 探测并通过侧边栏回调报告状态；不显示右下角通知。
// 返回当前可执行路径（命中缓存或刚配置成功均可），未就绪返回 null。
async function resolveOpenOcdStatus(executable, context, probedResult, report) {
    const result = probedResult && probedResult.path === String(executable || '').trim()
        ? probedResult
        : await probeOpenOcd(executable);
    setCache(result);
    if (result.found) {
        reportStatus(report, { state: 'ready', message: result.version ? `OpenOCD v${result.version} 已就绪` : 'OpenOCD 已就绪', result });
        return result.path;
    }
    reportStatus(report, { state: 'missing', canInstall: Boolean(installer.getBundledArchive(context)), message: result.error || '未检测到 OpenOCD', result });
    return null;
}

module.exports = {
    parseVersion,
    probeOpenOcd,
    getCachedResult,
    setCache,
    resetCache,
    persistOpenOcdPath,
    pickOpenOcdPath,
    installBundledAndConfigure,
    resolveOpenOcdStatus,
    OPENOCD_GETTING_STARTED_URL
};
