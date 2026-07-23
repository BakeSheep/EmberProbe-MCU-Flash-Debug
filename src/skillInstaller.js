"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const i18n = require("./i18n");

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

async function inspectSkills(vscode, context) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return { state: "noWorkspace", installed: 0, total: 0, skills: [] };
    const manifest = await readManifest(context);
    const sourceRoot = path.join(context.extensionPath, "skills");
    const targetRoot = path.join(workspace.uri.fsPath, ".agents", "skills");
    const skills = [];
    for (const entry of manifest.skills) skills.push(await inspectSkill(sourceRoot, targetRoot, entry));
    const sourceRuntime = path.join(sourceRoot, "_emberprobe", "agent-client.js");
    const targetRuntime = path.join(targetRoot, "_emberprobe", "agent-client.js");
    const runtimeMissing = !await exists(targetRuntime);
    const runtimeModified = !runtimeMissing && await digest(sourceRuntime) !== await digest(targetRuntime);
    for (let index = 0; index < manifest.skills.length; index++) {
        if (!manifest.skills[index].runtime || skills[index].state === "notInstalled") continue;
        if (runtimeMissing) {
            skills[index].state = "partial";
            skills[index].missing.push("../_emberprobe/agent-client.js");
        } else if (runtimeModified && skills[index].state === "installed") {
            skills[index].state = "modified";
        }
    }
    const installed = skills.filter(item => item.state === "installed").length;
    let state = "installed";
    if (skills.every(item => item.state === "notInstalled")) state = "notInstalled";
    else if (skills.some(item => item.state === "partial" || item.state === "notInstalled")) state = "partial";
    else if (skills.some(item => item.state === "outdated")) state = "outdated";
    else if (skills.some(item => item.state === "modified")) state = "modified";
    return { state, installed, total: skills.length, skills };
}

async function installSkill(vscode, context, lang) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw Object.assign(new Error(i18n.t(lang, "msg.openWorkspaceFirst")), { i18nKey: "msg.openWorkspaceFirst" });
    const manifest = await readManifest(context);
    const sourceRoot = path.join(context.extensionPath, "skills");
    const targetRoot = path.join(workspace.uri.fsPath, ".agents", "skills");
    const stage = path.join(workspace.uri.fsPath, ".agents", `.emberprobe-stage-${process.pid}-${Date.now()}`);
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
    vscode.window.showInformationMessage(i18n.t(lang, "msg.skillsInstalled"));
    return status;
}

module.exports = { installSkill, inspectSkills, inspectSkill, readManifest };
