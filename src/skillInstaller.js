"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const i18n = require("./i18n");

// Scopes: workspace = .agents/skills in the current workspace; global = ~/.agents/skills, which is no longer installed
// but is still inspected and uninstalled
async function readManifest(context) {
    const file = path.join(context.extensionPath, "skills", "manifest.json");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(value.skills) || !value.skills.length) throw new Error("Invalid Agent Skills manifest");
    return value;
}

async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

function insidePath(root, target) {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

// Hardening: if .agents, .agents/skills, _emberprobe or a skill directory under the workspace (or home directory) is
// replaced by a symlink or junction, following it would run readdir+rm on the link target, which amounts to rm -rf
// outside the workspace. So paths are sanitized before any mkdir/readdir/rm/cp:
// - a symlink or non-directory: fs.rm only unlinks the link itself and never enters the target (Node.js behaviour,
// verified);
// - a real directory: its realpath must stay inside the allowed root, otherwise the operation is refused.
async function sanitizeSkillPath(target, realRoot) {
    const st = await fs.lstat(target).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
        return;
    }
    const real = await fs.realpath(target);
    if (!insidePath(realRoot, real))
        throw Object.assign(new Error(`Refusing to operate on a skill path outside the workspace: ${target}`), {
            code: "SKILL_PATH_OUTSIDE_WORKSPACE"
        });
}

async function sanitizeSkillTree(targetRoot, rootBase, manifest) {
    if (!rootBase) return;
    const realRoot = await fs.realpath(rootBase).catch(() => rootBase);
    await sanitizeSkillPath(path.dirname(targetRoot), realRoot);
    await sanitizeSkillPath(targetRoot, realRoot);
    await sanitizeSkillPath(path.join(targetRoot, "_emberprobe"), realRoot);
    for (const entry of manifest.skills) await sanitizeSkillPath(path.join(targetRoot, entry.name), realRoot);
}

async function digest(file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw Object.assign(new Error("Skill file exceeds its inspection budget"), { code: "SKILL_FILE_TOO_LARGE" });
    return crypto
        .createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
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
    if (!present)
        return { name: entry.name, version: entry.version, state: "notInstalled", missing: entry.required.slice() };
    const missing = [];
    const contents = [];
    let modified = false;
    for (const relative of entry.required) {
        const sourceFile = path.join(source, relative);
        const targetFile = path.join(target, relative);
        if (!(await exists(targetFile))) missing.push(relative);
        else {
            const actual = await digest(targetFile);
            contents.push([relative, actual]);
            if ((await digest(sourceFile)) !== actual) modified = true;
        }
    }
    const fingerprint = crypto
        .createHash("sha256")
        .update(JSON.stringify([contents, missing]))
        .digest("hex");
    if (missing.length) return { name: entry.name, version: entry.version, state: "partial", missing, fingerprint };
    let installedVersion = "";
    try {
        installedVersion =
            JSON.parse(await fs.readFile(path.join(target, ".emberprobe-skill.json"), "utf8")).version || "";
    } catch {
        /* old installs have no metadata */
    }
    if (installedVersion !== entry.version) {
        return {
            name: entry.name,
            version: entry.version,
            installedVersion,
            state: "outdated",
            missing: [],
            fingerprint
        };
    }
    return {
        name: entry.name,
        version: entry.version,
        installedVersion,
        state: modified ? "modified" : "installed",
        fingerprint,
        missing: []
    };
}

async function inspectRoot(manifest, sourceRoot, targetRoot, scope) {
    const skills = [];
    for (const entry of manifest.skills) skills.push(await inspectSkill(sourceRoot, targetRoot, entry));
    // The shared runtime is compared file by file against the explicit manifest.shared list (scripts such as
    // agent-client and flash-common, plus shared Markdown such as agent-workflow.md). Any missing or updated file is
    // reflected in the status of skills that depend on the runtime. An explicit list rather than an extension filter
    // makes sure new shared documents are checked; a drift test keeps the list in line with the source _emberprobe
    // directory. Without a source directory every exists check is false, as if there were no runtime dependency.
    const runtimeStatus = { missing: [], modified: false };
    const runtimeContents = [];
    for (const name of Array.isArray(manifest.shared) ? manifest.shared : []) {
        const sourceFile = path.join(sourceRoot, "_emberprobe", name);
        const targetFile = path.join(targetRoot, "_emberprobe", name);
        if (!(await exists(sourceFile))) continue;
        if (!(await exists(targetFile))) runtimeStatus.missing.push(`../_emberprobe/${name}`);
        else {
            const actual = await digest(targetFile);
            runtimeContents.push([name, actual]);
            if ((await digest(sourceFile)) !== actual) runtimeStatus.modified = true;
        }
    }
    for (let index = 0; index < manifest.skills.length; index++) {
        if (!manifest.skills[index].runtime || skills[index].state === "notInstalled") continue;
        if (runtimeStatus.missing.length) {
            skills[index].state = "partial";
            skills[index].missing.push(...runtimeStatus.missing);
        } else if (runtimeStatus.modified && skills[index].state === "installed") {
            skills[index].state = "modified";
        }
    }
    const installed = skills.filter((item) => item.state === "installed").length;
    let state = "installed";
    if (skills.every((item) => item.state === "notInstalled")) state = "notInstalled";
    else if (skills.some((item) => item.state === "partial" || item.state === "notInstalled")) state = "partial";
    else if (skills.some((item) => item.state === "outdated")) state = "outdated";
    else if (skills.some((item) => item.state === "modified")) state = "modified";
    const fingerprint = crypto
        .createHash("sha256")
        .update(JSON.stringify([skills, runtimeContents, runtimeStatus.missing]))
        .digest("hex");
    // Only copies with executable scripts are complete skills; a documentation-only knowledge pack runs no code.
    let hasScripts = await exists(path.join(targetRoot, "_emberprobe", "agent-client.js"));
    for (const entry of manifest.skills) {
        if (hasScripts) break;
        hasScripts = await exists(path.join(targetRoot, entry.name, "scripts"));
    }
    return { scope, root: targetRoot, state, installed, total: skills.length, skills, fingerprint, hasScripts };
}

// Inspects any skill root (for example when an agent runs scripts from a custom copy) so approval follows the copy that
// actually runs.
async function inspectSkillRoot(context, targetRoot, scope = "custom") {
    const manifest = await readManifest(context);
    return inspectRoot(manifest, path.join(context.extensionPath, "skills"), targetRoot, scope);
}

// Inspects both scopes; the top level is the merged view the webview expects (the better state per skill), and scopes
// give the per-scope detail for menus and prompts
async function inspectSkills(vscode, context) {
    const manifest = await readManifest(context);
    const sourceRoot = path.join(context.extensionPath, "skills");
    const scopes = {
        workspace: workspaceSkillsRoot(vscode)
            ? await inspectRoot(manifest, sourceRoot, workspaceSkillsRoot(vscode), "workspace")
            : null,
        global: await inspectRoot(manifest, sourceRoot, globalSkillsRoot(), "global")
    };
    // Agents discover the workspace first, so the status must reflect the skill that will actually run; a clean global
    // copy must not mask a tampered workspace copy.
    const skills = manifest.skills.map((entry, index) => {
        const workspace = scopes.workspace?.skills[index];
        return workspace && workspace.state !== "notInstalled" ? workspace : scopes.global.skills[index];
    });
    const installed = skills.filter((item) => item.state === "installed").length;
    let state = "installed";
    if (skills.every((item) => item.state === "notInstalled")) state = "notInstalled";
    else if (skills.some((item) => item.state === "partial" || item.state === "notInstalled")) state = "partial";
    else if (skills.some((item) => item.state === "outdated")) state = "outdated";
    else if (skills.some((item) => item.state === "modified")) state = "modified";
    return { state, installed, total: skills.length, skills, scopes };
}

async function installSkill(vscode, context, lang, scope = "workspace") {
    if (scope !== "workspace") throw new Error("Agent Skills installation is workspace-only");
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (scope === "workspace" && !workspace)
        throw Object.assign(new Error(i18n.t(lang, "msg.openWorkspaceFirst")), { i18nKey: "msg.openWorkspaceFirst" });
    const manifest = await readManifest(context);
    const sourceRoot = path.join(context.extensionPath, "skills");
    const targetRoot = skillsRootFor(vscode, scope);
    // Sanitize the whole workspace path before any mkdir/readdir/rm/cp, refusing to follow symlinks.
    await sanitizeSkillTree(targetRoot, workspace.uri.fsPath, manifest);
    const stage = path.join(path.dirname(targetRoot), `.emberprobe-stage-${process.pid}-${Date.now()}`);
    await fs.mkdir(stage, { recursive: true });
    try {
        await fs.cp(path.join(sourceRoot, "_emberprobe"), path.join(stage, "_emberprobe"), {
            recursive: true,
            force: true
        });
        for (const entry of manifest.skills) {
            const stagedSkill = path.join(stage, entry.name);
            await fs.cp(path.join(sourceRoot, entry.name), stagedSkill, { recursive: true, force: true });
            await fs.writeFile(
                path.join(stagedSkill, ".emberprobe-skill.json"),
                JSON.stringify(
                    {
                        name: entry.name,
                        version: entry.version,
                        installedAt: new Date().toISOString()
                    },
                    null,
                    2
                )
            );
            for (const required of entry.required) {
                if (!(await exists(path.join(stagedSkill, required))))
                    throw new Error(`Skill ${entry.name} is missing ${required}`);
            }
        }
        await fs.mkdir(targetRoot, { recursive: true });
        const runtimeRoot = path.join(targetRoot, "_emberprobe");
        await fs.mkdir(runtimeRoot, { recursive: true });
        // The bridge owns this live pointer; never delete or restore a stale copy during installation.
        for (const name of await fs.readdir(runtimeRoot)) {
            if (name !== "agent-bridge.json")
                await fs.rm(path.join(runtimeRoot, name), { recursive: true, force: true });
        }
        await fs.cp(path.join(stage, "_emberprobe"), runtimeRoot, {
            recursive: true,
            force: true,
            filter: (source) => path.basename(source) !== "agent-bridge.json"
        });
        for (const entry of manifest.skills) {
            await fs.rm(path.join(targetRoot, entry.name), { recursive: true, force: true });
            await fs.cp(path.join(stage, entry.name), path.join(targetRoot, entry.name), {
                recursive: true,
                force: true
            });
        }
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
    // The sidebar's Skills switch shows the result; no separate notification.
    return inspectSkills(vscode, context);
}

// Uninstalls a scope: deletes only the manifest's skills and the shared runtime, never other skills the user created
async function uninstallSkill(vscode, context, lang, scope) {
    const manifest = await readManifest(context);
    const targetRoot = skillsRootFor(vscode, scope);
    // Uninstalling must not follow symlinks in the workspace or home directory either.
    const rootBase = scope === "global" ? os.homedir() : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await sanitizeSkillTree(targetRoot, rootBase, manifest);
    if (targetRoot && (await exists(targetRoot))) {
        for (const entry of manifest.skills) {
            const target = path.join(targetRoot, entry.name);
            if (!(await exists(target))) continue;
            await fs.rm(target, { recursive: true, force: true });
        }
        let emberprobeSkillRemains = false;
        for (const entry of manifest.skills) {
            if (await exists(path.join(targetRoot, entry.name))) {
                emberprobeSkillRemains = true;
                break;
            }
        }
        if (!emberprobeSkillRemains) {
            await fs.rm(path.join(targetRoot, "_emberprobe"), { recursive: true, force: true });
        }
        // Remove the skills directory too once it is empty; keep it while it holds user content
        try {
            if ((await fs.readdir(targetRoot)).length === 0) await fs.rm(targetRoot, { recursive: true, force: true });
        } catch {
            /* The directory is already gone or cannot be removed */
        }
    }
    // The current pointer lives in the _emberprobe runtime directory removed above. Also remove the pointer older
    // versions may have left in the project root, deleting only an empty directory so no other user content is touched.
    if (scope === "workspace") {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspace) {
            const bridgeDir = path.join(workspace, ".emberprobe");
            await fs.rm(path.join(bridgeDir, "agent-bridge.json"), { force: true });
            await fs.rmdir(bridgeDir).catch(() => {});
        }
    }
    // The sidebar's Skills switch shows the result; no separate notification.
    return inspectSkills(vscode, context);
}

module.exports = {
    installSkill,
    uninstallSkill,
    inspectSkills,
    inspectSkill,
    inspectSkillRoot,
    readManifest
};
