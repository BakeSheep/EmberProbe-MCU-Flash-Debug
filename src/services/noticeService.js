"use strict";
const { toUiError } = require("./errorEnvelope");

// Sidebar notice box for each command's messages; errors and busy warnings keep the command id, so the
// next run of the same command replaces them.
const COMMAND_AREAS = Object.freeze({
    "mcu-vscode.download": "flash",
    "mcu-vscode.debug": "flash",
    "mcu-vscode.attachDebug": "flash",
    "mcu-vscode.autoDetect": "config",
    "mcu-vscode.selectElf": "config",
    "mcu-vscode.selectDebugger": "config",
    "mcu-vscode.selectMcuCore": "config",
    "mcu-vscode.selectCubeMx": "config",
    "mcu-vscode.selectIoc": "config",
    "mcu-vscode.installCubeMxFirmware": "config",
    "mcu-vscode.downloadOfficialSvd": "config",
    "mcu-vscode.selectExistingSvd": "config",
    "mcu-vscode.switchWorkspaceSvd": "config"
});
// Title of the error box when a command fails, so the box says which operation failed.
const COMMAND_FAILURE_TITLES = Object.freeze({
    "mcu-vscode.download": "notice.downloadFailed",
    "mcu-vscode.debug": "notice.debugFailed",
    "mcu-vscode.attachDebug": "notice.attachFailed",
    "mcu-vscode.selectElf": "notice.selectElfFailed",
    "mcu-vscode.autoDetect": "notice.autoDetectFailed"
});

function commandArea(cmd) {
    return COMMAND_AREAS[cmd] || "global";
}

// One exit for user-facing messages. The sidebar shows them in place; a VS Code notification is only the
// fallback for an error or warning the user cannot see because the sidebar is hidden or not open yet.
class NoticeService {
    constructor({ vscode, t, view }) {
        this.vscode = vscode;
        this.t = t;
        this.view = view;
        this.notices = new Map();
        // Bumped by every notice, so a caller can tell whether an operation reported anything.
        this.revision = 0;
    }
    _post(message) {
        this.view()?.webview.postMessage(message);
    }
    _visible() {
        const view = this.view();
        return !!view && view.visible !== false;
    }
    _text(notice) {
        const error = notice.error;
        const reason = error ? (error.key ? this.t(error.key, error.params) : error.message) : "";
        const text = notice.key ? this.t(notice.key, notice.params) : notice.message || reason;
        const title = notice.titleKey ? this.t(notice.titleKey) : "";
        return title ? `${title}: ${text}` : text;
    }
    has(area, id) {
        return this.notices.has(area + "\n" + id);
    }
    get(area, id) {
        return this.notices.get(area + "\n" + id)?.notice;
    }
    // notice: { level, key?, params?, message?, titleKey?, error?, items?, detail?, actions?, busy? }
    notify(area, id, notice) {
        this.revision++;
        const payload = { ...notice };
        if (notice.error) payload.error = toUiError(notice.error);
        // A reported error is not reported again by whoever catches it further up.
        if (notice.error && typeof notice.error === "object") notice.error.reported = true;
        const key = area + "\n" + id;
        if (payload.level === "success") this.notices.delete(key);
        else this.notices.set(key, { area, id, notice: payload });
        this._post({ type: "notice", area, id, notice: payload });
        if (!this._visible() && (payload.level === "error" || payload.level === "warning") && !notice.quiet) {
            const show =
                payload.level === "error"
                    ? this.vscode.window?.showErrorMessage
                    : this.vscode.window?.showWarningMessage;
            show?.call(this.vscode.window, this._text(payload));
        }
    }
    clear(area, id) {
        if (!this.notices.delete(area + "\n" + id)) return;
        this._post({ type: "noticeClear", area, id });
    }
    // The user closed it in the sidebar; forget it so a rebuilt sidebar does not show it again.
    dismiss(area, id) {
        this.notices.delete(String(area) + "\n" + String(id));
    }
    // Retained notices come back when the sidebar is rebuilt; success notices are transient and do not.
    replay(post) {
        for (const { area, id, notice } of this.notices.values()) post({ type: "notice", area, id, notice });
    }
}

module.exports = { NoticeService, commandArea, COMMAND_FAILURE_TITLES };
