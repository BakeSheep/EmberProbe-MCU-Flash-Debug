"use strict";

const path = require("path");
const { MemoryAnalysisService } = require("./memoryAnalysisService");

// Own the sidebar lifecycle, while the Agent calls the same analysis service directly.
class MemoryAnalysisController {
    /** @param {any} options */
    constructor(options) {
        this.options = options;
        this.sequence = 0;
        this.watchers = [];
        this.timer = null;
        this.disposed = false;
        this.service = new MemoryAnalysisService({
            elfService: options.elfService,
            fs: options.fs,
            roots: () => (options.vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
            findScripts: async (root) => {
                if (!root) return [];
                const files = await options.vscode.workspace.findFiles(
                    new options.vscode.RelativePattern(root, "**/*.ld"),
                    "{**/node_modules/**,**/.git/**}",
                    200
                );
                return files.map((file) => file.fsPath);
            },
            selection: (elf) => options.context.workspaceState.get("memoryAnalysis.sources", {})[elf] || {},
            regionKinds: () => options.vscode.workspace.getConfiguration("emberprobe").get("memory.regionKinds", {})
        });
        this.configurationListener = options.vscode.workspace.onDidChangeConfiguration?.((event) => {
            if (event.affectsConfiguration("emberprobe.memory.regionKinds")) this.refresh();
        });
    }

    async refresh() {
        if (this.disposed) return;
        const requestId = ++this.sequence;
        this.service.invalidate();
        this.options.post({ type: "memoryAnalysis", requestId, state: "loading" });
        try {
            const result = await this.service.analyze();
            if (this.disposed || requestId !== this.sequence) return;
            this.options.post({ type: "memoryAnalysis", requestId, state: "ready", result });
            this.watch(result.source.files);
        } catch (error) {
            if (this.disposed || requestId !== this.sequence) return;
            this.options.post({
                type: "memoryAnalysis",
                requestId,
                state: "error",
                key: error.code === "ELF_NOT_CONFIGURED" ? "memory.selectElf" : "memory.failed",
                message: error.message,
                code: error.code
            });
            this.watch([...this.service.files]);
        }
    }

    watch(files) {
        if (!this.options.vscode.workspace.createFileSystemWatcher) return;
        for (const watcher of this.watchers) watcher.dispose();
        this.watchers = [];
        const changed = () => {
            // Immediately invalidate in-flight requests, then coalesce linker writes.
            this.sequence++;
            this.service.invalidate();
            this.options.elfService.invalidate();
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.timer = null;
                this.refresh();
            }, 300);
        };
        for (const file of new Set(files)) {
            const watcher = this.options.vscode.workspace.createFileSystemWatcher(
                new this.options.vscode.RelativePattern(path.dirname(file), path.basename(file))
            );
            watcher.onDidChange(changed);
            watcher.onDidCreate(changed);
            watcher.onDidDelete(changed);
            this.watchers.push(watcher);
        }
    }

    async selectSource() {
        const snapshot = await this.options.elfService.load();
        const chosen = await this.options.vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri: this.options.vscode.Uri.file(path.dirname(snapshot.elf.path)),
            filters: { "Memory layout (.map, .ld)": ["map", "ld"] }
        });
        if (!chosen?.[0]) return;
        const file = chosen[0].fsPath;
        const extension = path.extname(file).toLowerCase();
        this.service.filePath(file, snapshot.elf.path, extension === ".map" ? ".map" : ".ld");
        const selections = this.options.context.workspaceState.get("memoryAnalysis.sources", {});
        await this.options.context.workspaceState.update("memoryAnalysis.sources", {
            ...selections,
            [snapshot.elf.path]: extension === ".map" ? { mapFile: file } : { linkerScript: file }
        });
        return this.refresh();
    }

    dispose() {
        this.disposed = true;
        this.sequence++;
        clearTimeout(this.timer);
        this.service.invalidate();
        for (const watcher of this.watchers) watcher.dispose();
        this.watchers = [];
        this.configurationListener?.dispose();
    }
}

module.exports = { MemoryAnalysisController };
