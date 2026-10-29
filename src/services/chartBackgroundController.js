"use strict";
const Icon = require("../webview/liveWatch/backgroundIcon");
const { ChartBackgroundStore } = require("./chartBackgroundStore");

// Native Settings owns image selection. A waveform Webview only decodes a host-authorized PNG.
class ChartBackgroundController {
    constructor({ vscode, state, entries, open, t }) {
        this.vscode = vscode;
        this.entries = entries;
        this.open = open;
        this.t = t;
        this.store = new ChartBackgroundStore(state);
        this.generation = 0;
        this.pending = null;
        this.selecting = null;
    }
    state() {
        const enabled = this.vscode.workspace.getConfiguration("emberprobe").get?.("chartBackgroundIcon.enabled", true);
        return { type: "chartBackgroundIcon", icon: enabled === false ? null : this.store.read() };
    }
    broadcast() {
        const message = this.state();
        for (const entry of this.entries()) entry.post(message);
    }
    select() {
        if (this.selecting) return this.selecting;
        this.selecting = this.selectFile()
            .catch((error) => {
                if (error.code === "cancelled") return;
                const keys = {
                    size: "lw.backgroundSizeError",
                    invalid: "lw.backgroundInvalidError",
                    background: "lw.backgroundCutoutError",
                    empty: "lw.backgroundCutoutError"
                };
                return this.vscode.window.showErrorMessage(this.t(keys[error.code] || "lw.backgroundSaveError"));
            })
            .finally(() => {
                this.selecting = null;
            });
        return this.selecting;
    }
    async selectFile() {
        const generation = ++this.generation;
        const selected = await this.vscode.window.showOpenDialog({
            title: this.t("lw.backgroundSelectTitle"),
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { PNG: ["png"] }
        });
        if (!selected?.length || generation !== this.generation) return;
        return this.vscode.window.withProgress(
            {
                location: this.vscode.ProgressLocation.Notification,
                title: this.t("lw.backgroundProcessing"),
                cancellable: false
            },
            async () => {
                const stat = await this.vscode.workspace.fs.stat(selected[0]);
                if (stat.size > Icon.MAX_FILE_BYTES) throw Object.assign(new Error("size"), { code: "size" });
                const bytes = await this.vscode.workspace.fs.readFile(selected[0]);
                if (bytes.length > Icon.MAX_FILE_BYTES) throw Object.assign(new Error("size"), { code: "size" });
                Icon.pngSize(bytes);
                if (generation !== this.generation) return;
                let entry = Array.from(this.entries()).sort((a, b) => b.focusOrder - a.focusOrder)[0];
                if (!entry) {
                    this.open();
                    entry = Array.from(this.entries()).sort((a, b) => b.focusOrder - a.focusOrder)[0];
                }
                if (!entry) throw new Error("No waveform renderer");
                const promise = new Promise((resolve, reject) => {
                    const timer = setTimeout(() => this.cancel(undefined, "timeout"), 30000);
                    this.pending = {
                        entry,
                        requestId: generation,
                        pngBase64: Buffer.from(bytes).toString("base64"),
                        resolve,
                        reject,
                        timer,
                        sent: false,
                        saving: false
                    };
                });
                this.ready(entry);
                return promise;
            }
        );
    }
    ready(entry) {
        const pending = this.pending;
        if (!pending || pending.entry !== entry || !entry.ready || pending.sent) return;
        pending.sent = true;
        const failed = () => {
            if (this.pending === pending) this.cancel(entry, "invalid");
        };
        try {
            Promise.resolve(
                entry.post({
                    type: "importChartBackgroundIcon",
                    requestId: pending.requestId,
                    pngBase64: pending.pngBase64
                })
            ).then((delivered) => {
                if (delivered === false) failed();
            }, failed);
        } catch {
            failed();
        }
        pending.pngBase64 = null;
    }
    async imported(entry, message) {
        const pending = this.pending;
        if (!pending || pending.entry !== entry || pending.requestId !== message.requestId || pending.saving) return;
        pending.saving = true;
        try {
            if (message.errorCode) throw Object.assign(new Error("PNG processing failed"), { code: message.errorCode });
            await this.store.update(Icon.validate(message.icon));
            this.broadcast();
            pending.resolve(null);
        } catch (error) {
            pending.reject(error);
        } finally {
            clearTimeout(pending.timer);
            if (this.pending === pending) this.pending = null;
        }
    }
    cancel(entry = undefined, code = "cancelled") {
        if (entry && this.pending?.entry !== entry) return;
        ++this.generation;
        const pending = this.pending;
        this.pending = null;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(Object.assign(new Error("Import cancelled"), { code }));
        }
    }
    async remove() {
        this.cancel();
        try {
            await this.store.update(null);
            this.broadcast();
        } catch {
            await this.vscode.window.showErrorMessage(this.t("lw.backgroundSaveError"));
        }
    }
}
module.exports = { ChartBackgroundController };
