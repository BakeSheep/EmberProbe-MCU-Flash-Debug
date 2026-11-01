"use strict";
const elfSymbols = require("../elfSymbols");
const validation = require("../validation");
const { variableScope } = require("../webview/runtime");
const { displayWarnings } = require("../webview/elfDiagnostics");
const { CACHE_KEYS } = require("../cacheKeys");

// How a loaded or changed ELF reaches the views: symbol and type progress for the sidebar and the chart panels,
// layouts of watched composites, watch lists rebound to the new symbols, and layout expansion requests. host is the
// MainViewProvider.
class ElfViewController {
    constructor(host) {
        this.host = host;
        // Settles once the watch lists are rebound to a freshly parsed ELF; sampling starts wait for it.
        this.rebindPromise = null;
        // Renames and ambiguous names found while the watch lists are rebound, read by the list normalizer.
        this.watchNameChanges = null;
    }
    // Drops what was derived from the previous ELF: symbols, resolved watch lists, runtime RAM sections and the
    // samples the views hold.
    invalidate() {
        this.host._elfService.invalidate();
        this.host._watchLists.invalidate();
        this.host._sampling.invalidateRuntimeRam();
        this.host._runtimeSampleHold?.reset();
        this.host._latestSidebarSamples.clear();
        for (const entry of this.host._livePanels.values()) entry.latestSamples.clear();
    }
    async refreshBindings() {
        this.invalidate();
        const memoryRefresh = this.host._memoryAnalysisController?.refresh();
        try {
            if (this.host._context.workspaceState.get(CACHE_KEYS.elfPath)) {
                const result = await this.host._elfService.ready();
                await this.hydrateSelectedLayouts(result);
                await this.rebindWatchLists(result.symbols);
            }
        } finally {
            await this.host._sampling.refreshSamplingPlan();
        }
        await memoryRefresh;
        this.host._syncSidebarTarget((message) => this.host._webviewView?.webview.postMessage(message));
        for (const entry of this.host._livePanels.values()) {
            this.host._syncGraphTarget(entry);
            entry.post({ type: "watchList", items: this.host._scalarWatchList(entry.watchKey), resetValues: true });
        }
        this.host._webviewView?.webview.postMessage({
            type: "sidebarWatchList",
            items: this.host._watchListWithDisplayNames(CACHE_KEYS.sidebarWatchList),
            resetValues: true
        });
    }
    // Prefetches DWARF layouts of the composites in a request. With options.layoutErrors, layout errors are collected
    // per item (keyed by original symbol name) without aborting the batch; without it the first layout error throws.
    // Name resolution failures are left to the later planning step.
    async prepareLayouts(requests, options = {}) {
        const result = await this.host._elfService.ready();
        const resolveSymbol = elfSymbols.createSymbolResolver(result.symbols);
        for (const request of Array.isArray(requests) ? requests : []) {
            const name = typeof request === "string" ? request : request?.name;
            const parsed = elfSymbols.parseMemberPath(name);
            const base = parsed ? parsed.base : name;
            let symbol;
            try {
                symbol = resolveSymbol(base);
            } catch {
                continue;
            }
            if ((!symbol.isComposite && !symbol.hasRuntimeLayout) || symbol.compositeLayout) continue;
            try {
                await this.host._elfService.layout(symbol.name);
            } catch (error) {
                if (!options.layoutErrors) throw error;
                options.layoutErrors.set(symbol.name, error);
            }
        }
        return result;
    }
    version(result) {
        const sha256 = result?.elf?.sha256 || "";
        return result?.companions?.length
            ? sha256 + ":" + result.companions.map((entry) => entry.sha256 || "missing").join(":")
            : sha256;
    }
    sendSnapshot(post, listType) {
        const result = this.host._elfService?.cache;
        if (!result?.elf) return;
        const version = this.version(result);
        post({
            type: `${listType}Reset`,
            version,
            generation: this.host._elfService.generation,
            warnings: displayWarnings(result)
        });
        for (let i = 0; i < result.symbols.length; i += 1000)
            post({ type: `${listType}Chunk`, version, symbols: result.symbols.slice(i, i + 1000) });
        post({ type: `${listType}Done`, version, total: result.symbols.length, warnings: displayWarnings(result) });
        if (result.dwarfReady)
            post({
                type: listType === "availableVariables" ? "availableTypesDone" : "variableTypesDone",
                version,
                warnings: displayWarnings(result)
            });
    }
    onElfChange(phase, result, entries) {
        // Worker chunks and DWARF display-name enrichment mutate the same symbols array.
        this.host._symbolNameIndexes?.delete(result.symbols);
        const version = this.version(result);
        const sidebarPost = (message) => this.host._webviewView?.webview.postMessage(message);
        const graphPosts = Array.from(this.host._livePanels.values())
            .filter((entry) => entry.ready)
            .map((entry) => entry.post);
        if (phase === "metadata") {
            this.host._watchLists.invalidate();
            sidebarPost({
                type: "availableVariablesReset",
                version,
                generation: this.host._elfService.generation,
                warnings: displayWarnings(result)
            });
            for (const post of graphPosts)
                post({
                    type: "variablesListReset",
                    version,
                    generation: this.host._elfService.generation,
                    warnings: displayWarnings(result)
                });
        } else if (phase === "symbols") {
            sidebarPost({ type: "availableVariablesChunk", version, symbols: entries });
            for (const post of graphPosts) post({ type: "variablesListChunk", version, symbols: entries });
        } else if (phase === "symbolsDone") {
            sidebarPost({
                type: "availableVariablesDone",
                version,
                total: result.symbols.length,
                warnings: displayWarnings(result)
            });
            for (const post of graphPosts)
                post({
                    type: "variablesListDone",
                    version,
                    total: result.symbols.length,
                    warnings: displayWarnings(result)
                });
        } else if (phase === "identities") {
            // DWARF refined the CU identities of same-named statics: resend the renamed symbol list.
            this.host._watchLists.invalidate();
            this.sendSnapshot(sidebarPost, "availableVariables");
            for (const post of graphPosts) this.sendSnapshot(post, "variablesList");
        } else if (phase === "types") {
            const symbols = entries.map((symbol) => ({
                name: symbol.name,
                displayName: symbol.displayName || symbol.name,
                typeName: symbol.typeName,
                watchType: symbol.watchType,
                isComposite: symbol.isComposite,
                hasRuntimeLayout: symbol.hasRuntimeLayout,
                unsupportedReason: symbol.unsupportedReason || "",
                hasDwarfWriteType: symbol.hasDwarfWriteType,
                sourceFile: symbol.sourceFile || "",
                origin: symbol.origin || "user",
                ...(symbol.enumInfo ? { enumInfo: symbol.enumInfo } : {}),
                ...(symbol.isEnum ? { isEnum: true } : {}),
                ...(symbol.isBoolean ? { isBoolean: true } : {}),
                ...(symbol.isConst ? { isConst: true } : {}),
                ...(symbol.isReference ? { isReference: true } : {}),
                ...(symbol.isMemberPointer ? { isMemberPointer: true } : {}),
                ...(symbol.isPointer ? { isPointer: true, pointerTarget: symbol.pointerTarget } : {})
            }));
            sidebarPost({ type: "availableVariableTypes", version, symbols });
            for (const post of graphPosts) post({ type: "variableTypes", version, symbols });
        } else if (phase === "dwarfReady") {
            sidebarPost({ type: "availableTypesDone", version, warnings: displayWarnings(result) });
            for (const post of graphPosts)
                post({ type: "variableTypesDone", version, warnings: displayWarnings(result) });
            this.rebindPromise = this.hydrateSelectedLayouts(result)
                .then(() => this.rebindWatchLists(result.symbols))
                .then(() => {
                    this.host._syncSidebarTarget(sidebarPost, true);
                    for (const entry of this.host._livePanels.values()) this.host._syncGraphTarget(entry, true);
                })
                .catch((error) => console.error("ELF watch list rebind failed:", error));
            this.rebindPromise.then(() => this.host._sampling.refreshSamplingPlan()).catch(() => {});
        } else if (phase === "failed") {
            sidebarPost({
                type: "availableVariablesDone",
                version,
                warnings: displayWarnings(result),
                error: result.symbols.length ? "" : result.warnings[result.warnings.length - 1]
            });
            for (const post of graphPosts)
                post({
                    type: "variablesListDone",
                    version,
                    warnings: displayWarnings(result),
                    error: result.symbols.length ? "" : result.warnings[result.warnings.length - 1]
                });
        }
    }
    async hydrateSelectedLayouts(result) {
        const names = new Set();
        const keys = [CACHE_KEYS.sidebarWatchList, CACHE_KEYS.sidebarWriteList, CACHE_KEYS.watchList];
        for (const entry of this.host._livePanels.values()) keys.push(entry.watchKey);
        for (const key of keys) {
            for (const item of this.host._context.workspaceState.get(key) || []) {
                const parsed = elfSymbols.parseMemberPath(item?.name);
                if (parsed) names.add(parsed.base);
                else if (item?.name) names.add(item.name);
            }
        }
        const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
        for (const name of names) {
            const symbol = byName.get(name);
            if (!symbol?.isComposite && !symbol?.hasRuntimeLayout) continue;
            try {
                await this.host._elfService.layout(name);
            } catch (error) {
                result.warnings.push(`${symbol.displayName || name}: ${error.message}`);
            }
        }
    }
    async resolveLayout(name, version) {
        const result = await this.host._elfService.ready();
        if (version !== this.version(result))
            throw Object.assign(new Error("ELF changed while resolving layout"), { code: "ELF_CHANGED" });
        return this.host._elfService.layout(name);
    }
    layoutExpansionSnapshot(name) {
        const symbol = this.host._elfService.symbolByName.get(name);
        return symbol?.layoutExpansions
            ? {
                  layoutExpansions: symbol.layoutExpansions,
                  layoutExpansionGeneration: symbol.layoutExpansionGeneration
              }
            : {};
    }
    async expandLayout(message) {
        validation.validateLayoutExpansionRequest(message.handle, message.generation);
        validation.validateLayoutExpansionTarget(message.name, message.path);
        const result = await this.host._elfService.ready();
        if (message.generation !== this.host._elfService.generation || message.version !== this.version(result))
            throw Object.assign(new Error("ELF changed while expanding layout"), { code: "STALE_LAYOUT_HANDLE" });
        const layout = await this.host._elfService.expandSymbolLayout(
            message.name,
            message.path,
            message.handle,
            message.generation
        );
        if (message.generation !== this.host._elfService.generation)
            throw Object.assign(new Error("ELF changed while expanding layout"), { code: "STALE_LAYOUT_HANDLE" });
        return layout;
    }
    async handleLayoutExpansion(message, post) {
        const identity = {
            type: "layoutExpansionResult",
            name: message.name,
            path: message.path,
            handle: message.handle,
            generation: message.generation,
            version: message.version
        };
        let layout;
        try {
            layout = await this.expandLayout(message);
        } catch (error) {
            post({ ...identity, code: error.code || "LAYOUT_EXPANSION_FAILED" });
            return;
        }
        const reply = { ...identity, layout };
        post(reply);
        this.host._webviewView?.webview.postMessage(reply);
        for (const entry of this.host._livePanels.values()) entry.post(reply);
        this.host._watchLists.invalidate();
        this.host._syncSidebarTarget((message) => this.host._webviewView?.webview.postMessage(message), true);
        for (const entry of this.host._livePanels.values()) this.host._syncGraphTarget(entry, true);
        await this.host._sampling.refreshSamplingPlan();
    }
    async rebindWatchLists(symbols) {
        const entries = Array.from(this.host._livePanels.values());
        const keys = [
            CACHE_KEYS.sidebarWatchList,
            CACHE_KEYS.sidebarWriteList,
            CACHE_KEYS.watchList,
            ...entries.map((entry) => entry.watchKey)
        ];
        const expanded = keys.flatMap((key) =>
            (this.host._context.workspaceState.get(key) || []).filter((item) => item.layoutExpanded)
        );
        const expandedByName = new Map(expanded.map((item) => [item.name, item]));
        const changes = { renamed: new Map(), ambiguous: new Map() };
        this.watchNameChanges = changes;
        let rebound;
        try {
            rebound = await this.host._watchLists.rebind(
                [
                    CACHE_KEYS.sidebarWatchList,
                    CACHE_KEYS.sidebarWriteList,
                    CACHE_KEYS.watchList,
                    ...entries.map((entry) => entry.watchKey)
                ],
                symbols
            );
        } finally {
            this.watchNameChanges = null;
        }
        const valid = new Set([...rebound.values()].flat().map((item) => item.name));
        const invalid = [
            ...new Set(
                expanded
                    .filter((item) => !valid.has(changes.renamed.get(item.name) || item.name))
                    .map((item) => item.name)
            )
        ].filter((name) => !changes.ambiguous.has(name));
        if (invalid.length)
            this.host._postLive({
                type: "liveError",
                key: "lw.layoutWatchInvalid",
                params: {
                    names: invalid
                        .map((name) => this.host._variableDisplayName(expandedByName.get(name) || { name }, symbols))
                        .join(", ")
                }
            });
        // A saved name that now matches same-named variables of several CUs is removed, never bound to one of them.
        if (changes.ambiguous.size)
            this.host._postLive({
                type: "liveError",
                key: "lw.watchAmbiguous",
                params: {
                    names: [...changes.ambiguous]
                        .map(([name, candidates]) => {
                            const displayName = symbols.find((symbol) => symbol.name === candidates[0])?.displayName;
                            return this.host._variableDisplayName(
                                { name, displayName: displayName && (variableScope(displayName)?.name || displayName) },
                                symbols
                            );
                        })
                        .join(", "),
                    candidates: [...new Set([...changes.ambiguous.values()].flat())]
                        .slice(0, 8)
                        .map((name) => symbols.find((symbol) => symbol.name === name)?.displayName || name)
                        .join(", ")
                }
            });
        this.host._latestSidebarSamples.clear();
        for (const entry of entries) entry.latestSamples.clear();
        return { entries, rebound };
    }
}

module.exports = { ElfViewController };
