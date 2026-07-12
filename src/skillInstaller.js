"use strict";
const fs = require("fs/promises");
const path = require("path");
async function installSkill(vscode, context) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw new Error('请先打开工作区');
    const source = path.join(context.extensionPath, 'skills', 'mcu-download');
    const destination = path.join(workspace.uri.fsPath, '.agents', 'skills', 'mcu-download');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
    vscode.window.showInformationMessage('MCU Download Agent Skill 已安装到当前工作区');
    return destination;
}
module.exports = { installSkill };
