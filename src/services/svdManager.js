"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { DeviceIdentityService } = require("./deviceIdentityService");
const { SvdLibraryService, validateSvdBuffer } = require("./svdLibraryService");
const { OfficialSvdService, compareVersions } = require("./officialSvdService");

function folderKey(folder) {
    return folder?.uri?.toString?.() || "";
}

function findFiles(root, predicate, limit = 1000, maxEntries = Math.max(5000, limit * 10)) {
    const result = [];
    if (!root || !fs.existsSync(root)) return result;
    const queue = [root];
    const ignored = new Set([".git", "node_modules", "dist", "build", "out"]);
    let visitedEntries = 0;
    while (queue.length && result.length < limit && visitedEntries < maxEntries) {
        const dir = queue.shift();
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            visitedEntries += 1;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!ignored.has(entry.name)) queue.push(file);
            } else if (predicate(file)) result.push(file);
            if (result.length >= limit || visitedEntries >= maxEntries) break;
        }
    }
    return result;
}

class SvdManager {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.cacheKeys = options.cacheKeys;
        this.t = options.t;
        this.getChipInfo = options.getChipInfo || (() => null);
        this.onStatus = options.onStatus || (() => {});
        this.identity = new DeviceIdentityService();
        this.library = new SvdLibraryService({ context: options.context });
        this.official = options.official || new OfficialSvdService();
        this.activeDownload = null;
        this.legacyWarned = false;
    }

    workspaceForElf() {
        const elf = this.context.workspaceState.get(this.cacheKeys.elfPath);
        if (elf) {
            const folder = this.vscode.workspace.getWorkspaceFolder(this.vscode.Uri.file(elf));
            if (folder) return folder;
        }
        return this.vscode.workspace.workspaceFolders?.length === 1 ? this.vscode.workspace.workspaceFolders[0] : null;
    }

    identityFor(folder) {
        return this.identity.resolve({
            workspacePath: folder?.uri?.fsPath,
            target: this.context.workspaceState.get(this.cacheKeys.mcuCore),
            chipInfo: this.getChipInfo()
        });
    }

    async importAndBind(file, folder, identity, metadata = {}) {
        const imported = await this.library.importFile(file, metadata, identity?.exact ? identity : null);
        await this.library.bind(folder.uri, imported.hash);
        await this.context.workspaceState.update(this.cacheKeys.svdPath, imported.path);
        this.onStatus({
            state: "configured",
            key: "svd.configured",
            path: imported.path,
            device: imported.svd.device,
            hash: imported.hash
        });
        return imported;
    }

    async resolveForFolder(folder, options = {}) {
        if (!folder) return null;
        const identity = options.identity || this.identityFor(folder);
        const bound = await this.library.resolveBound(folder.uri, identity.exact ? identity : null);
        if (bound) return bound;

        const compatible = await this.library.findCompatible(identity.exact ? identity : null);
        if (identity.exact && compatible.length === 1) {
            await this.library.bind(folder.uri, compatible[0].hash);
            return { ...compatible[0], source: "global-library" };
        }

        const matchingIdentity = identity.exact
            ? identity
            : identity.family
              ? { ...identity, device: identity.family, exact: true }
              : null;
        const selectUnique = async (files, source) => {
            const matches = [];
            for (const file of files) {
                try {
                    validateSvdBuffer(await fs.promises.readFile(file), matchingIdentity);
                    matches.push(file);
                } catch {
                    /* incompatible */
                }
            }
            if (matches.length !== 1) return null;
            return {
                ...(await this.importAndBind(matches[0], folder, matchingIdentity || identity, {
                    source,
                    originalPath: matches[0]
                })),
                source
            };
        };

        const project = await selectUnique(
            findFiles(folder.uri.fsPath, (file) => /\.svd$/i.test(file), 250),
            "workspace"
        );
        if (project) return project;

        const roots = String(process.env.CMSIS_PACK_ROOT || "")
            .split(path.delimiter)
            .filter(Boolean);
        for (const root of roots) {
            const cmsis = await selectUnique(
                findFiles(root, (candidate) => /\.svd$/i.test(candidate), 1500),
                "CMSIS_PACK_ROOT"
            );
            if (cmsis) return { ...cmsis, source: "cmsis-pack-root" };
        }

        const legacy = this.context.workspaceState.get(this.cacheKeys.svdPath);
        if (legacy) {
            try {
                if (fs.statSync(legacy).isFile())
                    return {
                        ...(await this.importAndBind(legacy, folder, identity, {
                            source: "legacy",
                            originalPath: legacy
                        })),
                        source: "legacy"
                    };
            } catch {
                await this.context.workspaceState.update(this.cacheKeys.svdPath, undefined);
                if (!this.legacyWarned) {
                    this.legacyWarned = true;
                    this.vscode.window.showWarningMessage(this.t("svd.legacyMissing"));
                }
            }
        }
        return null;
    }

    async peekBound(folder = this.workspaceForElf()) {
        if (!folder) return null;
        return this.library.resolveBound(folder.uri, null, { readOnly: true });
    }

    async currentPath(folder = this.workspaceForElf()) {
        return (await this.resolveForFolder(folder))?.path || "";
    }

    async selectExisting(folder = this.workspaceForElf()) {
        if (!folder) throw Object.assign(new Error(this.t("msg.openWorkspaceFirst")), { code: "NO_WORKSPACE" });
        const picked = await this.vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri: folder.uri,
            filters: { "CMSIS SVD": ["svd"] },
            title: this.t("svd.selectExisting")
        });
        if (!picked?.[0]) return null;
        return this.importAndBind(picked[0].fsPath, folder, this.identityFor(folder), {
            source: "manual",
            originalPath: picked[0].fsPath
        });
    }

    async switchBinding(folder = this.workspaceForElf()) {
        if (!folder) throw Object.assign(new Error(this.t("msg.openWorkspaceFirst")), { code: "NO_WORKSPACE" });
        const identity = this.identityFor(folder);
        const list = await this.library.findCompatible(identity.exact ? identity : null);
        /** @type {any[]} */
        const items = list.map((entry) => ({
            label: entry.metadata?.device || entry.svd.device,
            description: [entry.metadata?.vendor || entry.svd.vendor, entry.metadata?.packageVersion]
                .filter(Boolean)
                .join(" · "),
            detail: entry.path,
            entry
        }));
        items.push(
            { label: this.t("svd.selectAnother"), action: "select" },
            { label: this.t("svd.clearBinding"), action: "clear" }
        );
        const selected = await this.vscode.window.showQuickPick(items, {
            placeHolder: this.t("svd.switchPlaceholder")
        });
        if (!selected) return null;
        if (selected.action === "select") return this.selectExisting(folder);
        if (selected.action === "clear") {
            await this.library.bind(folder.uri, "");
            await this.context.workspaceState.update(this.cacheKeys.svdPath, undefined);
            this.onStatus({ state: "idle", key: "svd.notConfigured" });
            return null;
        }
        await this.library.bind(folder.uri, selected.entry.hash);
        await this.context.workspaceState.update(this.cacheKeys.svdPath, selected.entry.path);
        this.onStatus({
            state: "configured",
            key: "svd.configured",
            path: selected.entry.path,
            device: selected.entry.svd.device
        });
        return selected.entry;
    }

    async chooseCandidate(candidates, identity) {
        if (!candidates.length) return null;
        const unique = [
            ...new Map(
                candidates.map((item) => [[item.device, item.core, item.svd, item.packageVersion].join("|"), item])
            ).values()
        ];
        if (unique.length === 1 && identity.exact) return unique[0];
        const selected = await this.vscode.window.showQuickPick(
            unique.map((candidate) => ({
                label: candidate.device,
                description: [
                    candidate.core,
                    `${candidate.packageVendor}.${candidate.packageName}@${candidate.packageVersion}`
                ]
                    .filter(Boolean)
                    .join(" · "),
                detail: candidate.svd,
                candidate
            })),
            { placeHolder: this.t("svd.chooseDevice") }
        );
        return selected?.candidate || null;
    }

    async downloadOfficial(folder = this.workspaceForElf()) {
        if (!folder) throw Object.assign(new Error(this.t("msg.openWorkspaceFirst")), { code: "NO_WORKSPACE" });
        if (this.activeDownload)
            throw Object.assign(new Error(this.t("svd.downloadBusy")), { code: "SVD_DOWNLOAD_BUSY" });
        const identity = this.identityFor(folder);
        const abort = new AbortController();
        this.activeDownload = abort;
        this.onStatus({ state: "downloading", key: "svd.catalog", percent: null });
        try {
            return await this.vscode.window.withProgress(
                {
                    location: this.vscode.ProgressLocation.Notification,
                    title: this.t("svd.downloadTitle"),
                    cancellable: true
                },
                async (progress, token) => {
                    token.onCancellationRequested(() => abort.abort());
                    let lastPercent = 0;
                    const onProgress = (event) => {
                        const percent = Number.isFinite(event.percent) ? event.percent : null;
                        const phaseKey =
                            event.phase === "validating"
                                ? "svd.validating"
                                : event.phase === "catalog"
                                  ? "svd.catalog"
                                  : "svd.downloading";
                        this.onStatus({
                            state: event.phase === "validating" ? "validating" : "downloading",
                            key: phaseKey,
                            percent,
                            received: event.received,
                            total: event.total
                        });
                        if (percent !== null) {
                            progress.report({ increment: Math.max(0, percent - lastPercent), message: `${percent}%` });
                            lastPercent = percent;
                        } else if (event.received)
                            progress.report({ message: `${Math.round(event.received / 1024)} KiB` });
                    };
                    const candidates = await this.official.discover(identity, { signal: abort.signal, onProgress });
                    if (abort.signal.aborted)
                        throw Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" });
                    const candidate = await this.chooseCandidate(candidates, identity);
                    if (!candidate) {
                        if (!candidates.length)
                            this.vscode.window.showWarningMessage(
                                this.t("svd.noOfficial", { device: identity.device || identity.family || "?" })
                            );
                        this.onStatus({ state: "idle", key: "svd.notConfigured" });
                        return null;
                    }
                    if (abort.signal.aborted)
                        throw Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" });
                    const downloaded = await this.official.download(candidate, {
                        signal: abort.signal,
                        onProgress,
                        onLicense: async (license) => {
                            const names = license.licenses.map((item) => item.spdx || item.title).join(", ");
                            const accept = await this.vscode.window.showWarningMessage(
                                this.t("svd.acceptLicense", {
                                    source: license.source,
                                    license: names || "CMSIS-Pack license"
                                }),
                                { modal: true },
                                this.t("svd.accept")
                            );
                            return accept === this.t("svd.accept");
                        }
                    });
                    validateSvdBuffer(downloaded.buffer, identity.exact ? identity : null);
                    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-svd-import-"));
                    const file = path.join(tmp, "device.svd");
                    try {
                        await fs.promises.writeFile(file, downloaded.buffer, { flag: "wx" });
                        const imported = await this.importAndBind(file, folder, identity, {
                            source: "official-cmsis-pack",
                            sourceUrl: downloaded.sourceUrl,
                            vendor: candidate.vendor,
                            device: candidate.device,
                            core: candidate.core,
                            packageVendor: candidate.packageVendor,
                            packageName: candidate.packageName,
                            packageVersion: candidate.packageVersion,
                            license: candidate.license.items.map((item) => item.spdx || item.title).join(", ")
                        });
                        this.vscode.window.showInformationMessage(
                            this.t("svd.configuredNextDebug", { device: imported.svd.device })
                        );
                        return imported;
                    } finally {
                        await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
                    }
                }
            );
        } catch (error) {
            const cancelled = error.code === "DOWNLOAD_CANCELLED";
            this.onStatus({
                state: cancelled ? "idle" : "error",
                key: cancelled ? "svd.cancelled" : "svd.failed",
                message: error.message,
                canRetry: !cancelled
            });
            if (!cancelled) this.vscode.window.showErrorMessage(this.t("svd.failedWith", { error: error.message }));
            return null;
        } finally {
            this.activeDownload = null;
        }
    }

    cancel() {
        if (!this.activeDownload) return false;
        this.onStatus({ state: "cancelling", key: "svd.cancelling" });
        this.activeDownload.abort();
        return true;
    }

    async syncStatus(folder = this.workspaceForElf()) {
        if (!folder) {
            this.onStatus({ state: "idle", key: "svd.notConfigured" });
            return;
        }
        const bound = await this.library.resolveBound(folder.uri, null);
        if (!bound) {
            this.onStatus({ state: "idle", key: "svd.notConfigured", identity: this.identityFor(folder) });
            return;
        }
        this.onStatus({
            state: "configured",
            key: "svd.configured",
            path: bound.path,
            device: bound.svd.device,
            hash: bound.hash
        });
        const metadata = bound.metadata;
        if (!metadata?.packageVersion || !metadata?.packageName) return;
        try {
            const candidates = await this.official.discover(this.identityFor(folder), {});
            const latest = candidates
                .filter(
                    (candidate) =>
                        candidate.packageName === metadata.packageName &&
                        candidate.packageVendor === metadata.packageVendor
                )
                .sort((a, b) => compareVersions(b.packageVersion, a.packageVersion))[0];
            if (latest && compareVersions(latest.packageVersion, metadata.packageVersion) > 0) {
                this.onStatus({
                    state: "update",
                    key: "svd.updateAvailable",
                    currentVersion: metadata.packageVersion,
                    version: latest.packageVersion,
                    path: bound.path,
                    device: bound.svd.device
                });
            }
        } catch {
            /* update checks are best-effort and never invalidate a working binding */
        }
    }
}

module.exports = { SvdManager, findFiles, folderKey };
