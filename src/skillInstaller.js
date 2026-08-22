"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const i18n = require("./i18n");

// 安装范围:workspace = 当前工作区 .agents/skills;global = 用户主目录 ~/.agents/skills(所有项目可用)
// 合并状态时按此优先级取两范围中的较优值
const STATE_RANK = { notInstalled: 0, partial: 1, outdated: 2, modified: 3, installed: 4 };

async function readManifest(context) {
    const file = path.join(context.extensionPath, "skills", "manifest.json");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(value.skills) || !value.skills.length) throw new Error("Invalid Agent Skills manifest");
    return value;
}

async function exists(file) {
    try { await fs.access(file); return true; } catch { return false; }
}

async function digest(file) {
    return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function workspaceSkillsRoot(vscode) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    return workspace ? path.join(workspace.uri.fsPath, ".agents", "skills") : null;
}

function globalSkillsRoot() {
    return path.join(os.homedir(), ".agents", "skills");
}

function skillsRootFor(vscode, scope) {
    return scope === "global" ? globalSkillsRoot() : workspaceSkillsRoot(vscode);
}

async function inspectSkill(sourceRoot, targetRoot, entry) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    const present = await exists(target);
    if (!present) return { name: entry.name, version: entry.version, state: "notInstalled", missing: entry.required.slice() };
    const missing = [];
    let modified = false;
    for (const relative of entry.required) {
        const sourceFile = path.join(source, relative);
        const targetFile = path.join(target, relative);
        if (!await exists(targetFile)) missing.push(relative);
        else if (await digest(sourceFile) !== await digest(targetFile)) modified = true;
    }
    if (missing.length) return { name: entry.name, version: entry.version, state: "partial", missing };
    let installedVersion = "";
    try {
        installedVersion = JSON.parse(await fs.readFile(path.join(target, ".emberprobe-skill.json"), "utf8")).version || "";
    } catch { /* old installs have no metadata */ }
    if (installedVersion !== entry.version) {
        return { name: entry.name, version: entry.version, installedVersion, state: "outdated", missing: [] };
    }
    return { name: entry.name, version: entry.version, installedVersion, state: modified ? "modified" : "installed", missing: [] };
}

async function inspectRoot(manifest, sourceRoot, targetRoot, scope) {
    const skills = [];
    for (const entry of manifest.skills) skills.push(await inspectSkill(sourceRoot, targetRoot, entry));
// 共享运行时按 _emberprobe 下全部脚本逐一比对（agent-client、flash-common 等），
// 任一缺失或内容更新都会反映到依赖运行时的 skill 状态上
const runtimeStatus = { missing: [], modified: false };
try {
    const runtimeFiles = (await fs.readdir(path.join(sourceRoot, "_emberprobe"))).filter(name => name.endsWith(".js"));
    for (const name of runtimeFiles) {
        const targetFile = path.join(targetRoot, "_emberprobe", name);
        if (!await exists(targetFile)) runtimeStatus.missing.push(`../_emberprobe/${name}`);
        else if (await digest(path.join(sourceRoot, "_emberprobe", name)) !== await digest(targetFile)) runtimeStatus.modified = true;
    }
} catch { /* 源 _emberprobe 目录缺失时按无运行时依赖处理 */ }
for (let index = 0; index < manifest.skills.length; index++) {
    if (!manifest.skills[index].runtime || skills[index].state === "notInstalled") continue;
    if (runtimeStatus.missing.length) {
        skills[index].state = "partial";
        skills[index].missing.push(...runtimeStatus.missing);
    } else if (runtimeStatus.modified && skills[index].state === "installed") {
        skills[index].state = "modified";
    }
}
    const installed = skills.filter(item => item.state === "installed").length;
    let state = "installed";
    if (skills.every(item => item.state === "notInstalled")) state = "notInstalled";
    else if (skills.some(item => item.state === "partial" || item.state === "notInstalled")) state = "partial";
    else if (skills.some(item => item.state === "outdated")) state = "outdated";
    else if (skills.some(item => item.state === "modified")) state = "modified";
    return { scope, root: targetRoot, state, installed, total: skills.length, skills };
}

// 检查两个安装范围;顶层为兼容 webview 的合并视图(每个 skill 取较优状态),scopes 供菜单与提示细分
async function inspectSkills(vscode, context) {
    const manifest = await readManifest(context);
    const sourceRoot = path.join(context.extensionPath, "skills");
    const scopes = {
        workspace: workspaceSkillsRoot(vscode) ? await inspectRoot(manifest, sourceRoot, workspaceSkillsRoot(vscode), "workspace") : null,
        global: await inspectRoot(manifest, sourceRoot, globalSkillsRoot(), "global")
    };
    const skills = manifest.skills.map((entry, index) => {
        const candidates = [scopes.workspace, scopes.global].filter(Boolean).map(status => status.skills[index]);
        return candidates.reduce((best, current) => !best || STATE_RANK[current.state] > STATE_RANK[best.state] ? current : best, null);
    });
    const installed = skills.filter(item => item.state === "installed").length;
    let state = "installed";
    if (skills.every(item => item.state === "notInstalled")) state = "notInstalled";
    else if (skills.some(item => item.state === "partial" || item.state === "notInstalled")) state = "partial";
    else if (skills.some(item => item.state === "outdated")) state = "outdated";
    else if (skills.some(item => item.state === "modified")) state = "modified";
    return { state, installed, total: skills.length, skills, scopes };
}

async function installSkill(vscode, context, lang, scope = "workspace") {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (scope === "workspace" && !workspace) throw Object.assign(new Error(i18n.t(lang, "msg.openWorkspaceFirst")), { i18nKey: "msg.openWorkspaceFirst" });
    const manifest = await readManifest(context);
    const sourceRoot = path.join(context.extensionPath, "skills");
    const targetRoot = skillsRootFor(vscode, scope);
    const stage = path.join(path.dirname(targetRoot), `.emberprobe-stage-${process.pid}-${Date.now()}`);
    await fs.mkdir(stage, { recursive: true });
    try {
        await fs.cp(path.join(sourceRoot, "_emberprobe"), path.join(stage, "_emberprobe"), { recursive: true, force: true });
        for (const entry of manifest.skills) {
            const stagedSkill = path.join(stage, entry.name);
            await fs.cp(path.join(sourceRoot, entry.name), stagedSkill, { recursive: true, force: true });
            await fs.writeFile(path.join(stagedSkill, ".emberprobe-skill.json"), JSON.stringify({
                name: entry.name, version: entry.version, installedAt: new Date().toISOString()
            }, null, 2));
            for (const required of entry.required) {
                if (!await exists(path.join(stagedSkill, required))) throw new Error(`Skill ${entry.name} is missing ${required}`);
            }
        }
        await fs.mkdir(targetRoot, { recursive: true });
        await fs.cp(path.join(stage, "_emberprobe"), path.join(targetRoot, "_emberprobe"), { recursive: true, force: true });
        for (const entry of manifest.skills) {
            await fs.cp(path.join(stage, entry.name), path.join(targetRoot, entry.name), { recursive: true, force: true });
        }
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
    const status = await inspectSkills(vscode, context);
    vscode.window.showInformationMessage(i18n.t(lang, scope === "global" ? "msg.skillsInstalledGlobal" : "msg.skillsInstalled"));
    return status;
}

// 按范围卸载:只删除 manifest 清单内的 skill 与共享运行时,不触碰用户自建的其它 skill
async function uninstallSkill(vscode, context, lang, scope) {
    const manifest = await readManifest(context);
    const targetRoot = skillsRootFor(vscode, scope);
    let removed = 0;
    if (targetRoot && await exists(targetRoot)) {
        for (const entry of manifest.skills) {
            const target = path.join(targetRoot, entry.name);
            if (!await exists(target)) continue;
            await fs.rm(target, { recursive: true, force: true });
            removed++;
        }
        let emberprobeSkillRemains = false;
        for (const entry of manifest.skills) {
            if (await exists(path.join(targetRoot, entry.name))) { emberprobeSkillRemains = true; break; }
        }
        if (!emberprobeSkillRemains) {
            await fs.rm(path.join(targetRoot, "_emberprobe"), { recursive: true, force: true });
        }
        // skills 目录已空则一并移除;仍含用户内容时保留
        try {
            if ((await fs.readdir(targetRoot)).length === 0) await fs.rm(targetRoot, { recursive: true, force: true });
        } catch { /* 目录已不存在或无法移除 */ }
    }
    const status = await inspectSkills(vscode, context);
    if (removed) vscode.window.showInformationMessage(i18n.t(lang, scope === "global" ? "msg.skillsUninstalledGlobal" : "msg.skillsUninstalled"));
    return status;
}

module.exports = { installSkill, uninstallSkill, inspectSkills, inspectSkill, readManifest };
