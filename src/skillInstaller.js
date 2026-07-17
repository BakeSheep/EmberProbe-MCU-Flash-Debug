"use strict";
const fs = require("fs/promises");
const path = require("path");
async function installSkill(vscode, context) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw new Error('请先打开工作区');
    const skillNames = ['mcu-download', 'mcu-live-watch'];
    const root = path.join(workspace.uri.fsPath, '.agents', 'skills');
    await fs.mkdir(root, { recursive: true });
    for (const name of skillNames) {
        await fs.cp(path.join(context.extensionPath, 'skills', name), path.join(root, name), { recursive: true, force: true });
    }
    vscode.window.showInformationMessage('EmberProbe Agent Skills 已安装到当前工作区');
    return skillNames.map(name => path.join(root, name));
}
module.exports = { installSkill };
