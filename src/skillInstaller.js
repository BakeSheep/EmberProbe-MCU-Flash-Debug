"use strict";
const fs = require("fs/promises");
const path = require("path");
const i18n = require("./i18n");
async function installSkill(vscode, context, lang) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw Object.assign(new Error(i18n.t(lang, 'msg.openWorkspaceFirst')), { i18nKey: 'msg.openWorkspaceFirst' });
    const skillNames = ['mcu-download', 'mcu-live-watch'];
    const root = path.join(workspace.uri.fsPath, '.agents', 'skills');
    await fs.mkdir(root, { recursive: true });
    for (const name of skillNames) {
        await fs.cp(path.join(context.extensionPath, 'skills', name), path.join(root, name), { recursive: true, force: true });
    }
    vscode.window.showInformationMessage(i18n.t(lang, 'msg.skillsInstalled'));
    return skillNames.map(name => path.join(root, name));
}
module.exports = { installSkill };
