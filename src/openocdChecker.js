"use strict";
// OpenOCD 环境探测、安装引导与路径配置。
// 设计要点：
// - 不修改系统 PATH / rc 文件 / 注册表，零系统副作用；
// - 通过 emberprobe.openocdPath 扩展配置项指向 openocd 绝对路径即可运行；
// - 内存级缓存避免每次烧录/调试/实时查看都重新探测；
// - 所有检测与安装状态通过回调交给侧边栏展示，不发送通知弹窗。

const { spawn } = require("child_process");
const installer = require("./openocdInstaller");
const i18n = require("./i18n");

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
        return Promise.resolve({ found: false, path: '', version: '', error: '未配置 OpenOCD 路径', errorKey: 'oc.errNoPath' });
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
            resolve({ found: false, path: resolved, requested: target, version: '', error: error.code === 'ENOENT' ? '找不到该可执行文件' : error.message, errorKey: error.code === 'ENOENT' ? 'oc.errNotFound' : undefined });
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
            done({ found: false, path: resolved, requested: target, version: '', error: '探测超时', errorKey: 'oc.errTimeout' });
        }, 5000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (error) => {
            const isEnoent = error.code === 'ENOENT';
            const msg = isEnoent ? '找不到该可执行文件（请确认路径或将其加入 PATH）' : error.message;
            done({ found: false, path: resolved, requested: target, version: '', error: msg, errorKey: isEnoent ? 'oc.errNotFoundPath' : undefined });
        });
        child.on('close', (code) => {
            const out = `${stdout}\n${stderr}`;
            const version = parseVersion(out);
            // 多数版本 --version 退出码为 0；个别老版本/特殊构建退出码非 0 但仍会打印标识，
            // 只要输出含 "open on-chip debugger" 即视为可运行，避免误判。
            if (version || /open on-chip debugger/i.test(out)) {
                done({ found: true, path: resolved, requested: target, version, error: '' });
            } else {
                done({ found: false, path: resolved, requested: target, version: '', error: code ? `退出码 ${code}，且输出无法识别为 OpenOCD` : '所选文件不是有效的 OpenOCD', errorKey: code ? 'oc.errExit' : 'oc.errNotOpenocd', errorParams: code ? { code } : undefined });
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
async function pickOpenOcdPath(vscode, report, lang) {
    const isWin = process.platform === 'win32';
    const previousPath = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
    const exeLabel = i18n.t(lang, 'oc.pickExe');
    const allLabel = i18n.t(lang, 'oc.allFiles');
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: i18n.t(lang, 'oc.pickLabel'),
        filters: isWin ? { [exeLabel]: ['exe'], [allLabel]: ['*'] } : { [allLabel]: ['*'] }
    });
    if (!uris || !uris.length) return null;
    const fsPath = uris[0].fsPath;
    reportStatus(report, { state: 'checking', key: 'oc.validatingSelected' });
    const result = await probeOpenOcd(fsPath);
    if (result.found) {
        await persistOpenOcdPath(vscode, fsPath, previousPath);
        // 配置变更监听会 resetCache；这里同步更新缓存，使本次后续动作立即可用
        _cachedResult = result;
        reportStatus(report, { state: 'ready', key: result.version ? 'oc.readyVer' : 'oc.ready', params: { version: result.version }, result });
        return fsPath;
    }
    reportStatus(report, { state: 'error', key: 'oc.selectedUnusable', params: { error: result.errorKey ? i18n.t(lang, result.errorKey, result.errorParams) : (result.error || i18n.t(lang, 'oc.reselect')) }, result });
    return null;
}

// 一键安装：从插件预置包解压到全局存储目录，通过 report 将状态发送给侧边栏。
// 返回安装并配置后的最终路径，失败返回 null。
async function installBundledAndConfigure(vscode, context, report, lang) {
    const previousPath = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
    const archive = installer.getBundledArchive(context);
    if (!archive) {
        // 当前平台无预置包，回退到打开官方下载页
        await vscode.env.openExternal(vscode.Uri.parse(OPENOCD_GETTING_STARTED_URL));
        reportStatus(report, { state: 'missing', canInstall: false, key: 'oc.noBundle', params: { platform: process.platform + '-' + process.arch } });
        return null;
    }
    try {
        let stagedProbe = null;
        reportStatus(report, { state: 'installing', key: 'oc.preparing' });
        const result = await installer.installBundledOpenOcd(vscode, context, (p) => {
            if (p.message || p.key) reportStatus(report, { state: 'installing', key: p.key, params: p.params, message: p.message });
        }, async (candidate) => {
            reportStatus(report, { state: 'checking', key: 'oc.verifying' });
            stagedProbe = await probeOpenOcd(candidate);
            return { ok: stagedProbe.found, version: stagedProbe.version, error: stagedProbe.error };
        });
        if (!result.ok) {
            reportStatus(report, { state: 'error', key: 'oc.installFailed', params: { error: result.error || i18n.t(lang, 'oc.unknownError') } });
            return null;
        }
        // 暂存目录中的可执行文件已经在替换旧安装前验证；缓存路径需改成最终目录。
        const verify = stagedProbe
            ? { ...stagedProbe, path: result.path }
            : await probeOpenOcd(result.path);
        if (verify.found) {
            await persistOpenOcdPath(vscode, result.path, previousPath);
            setCache(verify);
            reportStatus(report, { state: 'ready', key: verify.version ? 'oc.installedReadyVer' : 'oc.installedReady', params: { version: verify.version }, result: verify });
            return result.path;
        }
        setCache(verify);
        reportStatus(report, { state: 'error', key: 'oc.verifyFailed', params: { error: verify.error || i18n.t(lang, 'oc.confirmManually') }, result: verify });
        return null;
    } catch (error) {
        reportStatus(report, { state: 'error', key: 'oc.installFailed', params: { error: error.message || String(error) } });
        return null;
    }
}

// 探测并通过侧边栏回调报告状态；不显示右下角通知。
// 返回当前可执行路径（命中缓存或刚配置成功均可），未就绪返回 null。
async function resolveOpenOcdStatus(executable, context, probedResult, report) {
    const target = String(executable || '').trim();
    const result = probedResult && (probedResult.requested || probedResult.path) === target
        ? probedResult
        : await probeOpenOcd(executable);
    setCache(result);
    if (result.found) {
        reportStatus(report, { state: 'ready', key: result.version ? 'oc.readyVer' : 'oc.ready', params: { version: result.version }, result });
        return result.path;
    }
    reportStatus(report, { state: 'missing', canInstall: Boolean(installer.getBundledArchive(context)), key: result.errorKey || 'oc.missing', params: result.errorParams, message: result.error || '未检测到 OpenOCD', result });
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
