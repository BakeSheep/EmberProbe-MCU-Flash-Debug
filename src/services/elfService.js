"use strict";
const { Worker } = require("worker_threads");
const { isCppRuntimeSymbol, isItaniumMangled } = require("../elfSymbols");
const { companionsUnchanged } = require("../dwarf/files");
const { validateLayoutExpansionRequest, validateLayoutExpansionTarget } = require("../validation");
const { resolveLayoutPath, expandCompositeLeaves } = require("../elfSymbols");
const { validateComposite } = require("../compositeValidation");
const { classifyVariableOrigin } = require("../variableOrigin");
const MAX_LAYOUT_EXPANSIONS = 32;
const MAX_LAYOUT_EXPANSION_BYTES = 8 * 1024 * 1024;

// §3：解析前的 ELF 体积硬上限。MCU 固件 64 MiB 已极宽裕；
// autoDetect 会取工作区 mtime 最新的 .elf，无上限时多 GB 文件会被
// 整份 readFileSync 进内存再送入 DWARF 解析，直接压垮扩展宿主。
const MAX_ELF_BYTES = 64 * 1024 * 1024;

// 单个 ELF 的 C++ 绑定诊断上限。大型固件可能链接大量无调试信息的 C++ 目标文件，
// 内部诊断仍有上限；普通类型缺失不进入整体下发到 webview 的 warnings。
const MAX_CPP_DIAGNOSTICS = 50;

function isPartialDwarf(diagnostics) {
    return Array.isArray(diagnostics) && diagnostics.some((entry) => entry?.code === "DWARF_PARTIAL");
}

class ElfService {
    constructor(options) {
        this.context = options.context;
        this.cacheKey = options.cacheKey;
        this.fs = options.fs;
        this.crypto = options.crypto;
        this.elfSymbols = options.elfSymbols;
        this.dwarf = options.dwarf;
        this.cleanPath = options.cleanPath;
        this.t = options.t;
        this.workerPath = options.workerPath || null;
        this.onChange = options.onChange || (() => {});
        this.cache = null;
        this.loadIdentity = null;
        this.generation = 0;
        this.nextRequestId = 0;
        this.pendingLayouts = new Map();
        this.symbolByName = new Map();
        this.layoutErrors = new Map();
        this.symbolExpansionsPending = new Map();
        this.symbolExpansionBytes = new Map();
    }

    invalidate() {
        this.generation++;
        this.loadIdentity = null;
        if (this.worker) {
            this.worker.terminate().catch(() => {});
            this.worker = null;
        }
        for (const pending of this.pendingLayouts.values())
            pending.reject(
                Object.assign(new Error("ELF changed"), {
                    code: pending.isExpansion ? "STALE_LAYOUT_HANDLE" : "ELF_CHANGED"
                })
            );
        this.pendingLayouts.clear();
        for (const symbol of this.symbolByName.values()) {
            for (const path of Object.keys(symbol.layoutExpansions || {})) delete symbol.layoutExpansions[path];
            symbol.layoutExpansionGeneration = -1;
        }
        this.symbolExpansionsPending.clear();
        this.symbolExpansionBytes.clear();
        this.symbolByName.clear();
        this.layoutErrors.clear();
        if (this.rejectSymbols) this.rejectSymbols(new Error("ELF changed"));
        if (this.rejectDwarf) this.rejectDwarf(new Error("ELF changed"));
        this.symbolsPromise = null;
        this.dwarfPromise = null;
        this.rejectSymbols = null;
        this.rejectDwarf = null;
        this.cache = null;
    }

    _path() {
        const selected = this.context.workspaceState.get(this.cacheKey);
        if (!selected)
            throw Object.assign(new Error(this.t("live.elfFirst")), {
                code: "ELF_NOT_CONFIGURED",
                i18nKey: "live.elfFirst"
            });
        return this.cleanPath(selected);
    }

    // debugComplete: every DWARF type record is known, so a missing record is meaningful.
    // Returns the symbols whose filter origin changed.
    _enrich(result, types, layouts = new Map(), displayNames = new Map(), { debugComplete = false } = {}) {
        const originChanged = [];
        const hasDebugInfo = debugComplete && types.size > 0;
        for (const symbol of result.symbols) {
            const info = types.get(symbol.name);
            const looksCpp = isItaniumMangled(symbol.elfName || symbol.name);
            const unresolvedCpp =
                (looksCpp || result.typeMetadataIncomplete || info?.kind === "unknown") &&
                (!info || info.kind === "unknown");
            symbol.displayName = displayNames.get(symbol.name) || symbol.displayName || symbol.name;
            symbol.qualifiedName = symbol.displayName;
            symbol.typeName = info?.typeName || "";
            // A same-named static keeps the DWARF source path that settled its CU identity.
            symbol.sourceFile = info?.sourceFile || symbol.sourceFile || "";
            const origin = classifyVariableOrigin(symbol, { debugComplete: hasDebugInfo, hasDebugInfo: !!info });
            if (symbol.origin !== undefined && symbol.origin !== origin) originChanged.push(symbol);
            symbol.origin = origin;
            const layout = layouts.get(symbol.name);
            const hasLayout = !!layout && !info?.ambiguous && info?.kind !== "scalar";
            if (layout?.runtimeLayout) symbol.runtimeLayout = layout.runtimeLayout;
            symbol.cppTypeUnavailable = !!info?.ambiguous || unresolvedCpp;
            const knownKind = info?.kind && info.kind !== "unknown";
            symbol.hasRuntimeLayout =
                !!knownKind &&
                (info.isReference ||
                    /\*\s*$/.test(symbol.typeName) ||
                    ["struct", "class", "union", "array"].includes(info.kind));
            symbol.isComposite =
                !!info?.ambiguous ||
                hasLayout ||
                (knownKind
                    ? ["struct", "class", "union", "array"].includes(info.kind)
                    : /^(struct|class|union)\b/.test(symbol.typeName) ||
                      /\[\]$/.test(symbol.typeName) ||
                      unresolvedCpp ||
                      (!info && ![1, 2, 4, 8].includes(Number(symbol.size))));
            symbol.watchType = symbol.isComposite
                ? ""
                : info?.isEnum
                  ? info.watchType
                  : info?.watchType || this.elfSymbols.defaultType(symbol.size);
            symbol.hasDwarfWriteType =
                !symbol.isComposite &&
                !!info?.watchType &&
                !info.isReference &&
                !info.isMemberPointer &&
                !info.isPointer &&
                !info.isConst &&
                !info.enumEncodingInferred;
            if (info?.enumInfo) symbol.enumInfo = info.enumInfo;
            if (info?.isEnum) symbol.isEnum = true;
            if (info?.enumEncodingInferred) symbol.enumEncodingInferred = true;
            if (info?.isBoolean) symbol.isBoolean = true;
            if (info?.isConst) symbol.isConst = true;
            if (info?.isReference) symbol.isReference = true;
            if (info?.isMemberPointer) symbol.isMemberPointer = true;
            if (info?.isPointer) {
                symbol.isPointer = true;
                symbol.pointerTarget = info.pointerTarget;
            }
            if (symbol.isComposite) {
                symbol.compositeLayout = hasLayout ? layout : null;
                symbol.unsupportedReason = hasLayout
                    ? ""
                    : info?.ambiguous
                      ? this.t("lw.cppSymbolAmbiguous")
                      : unresolvedCpp
                        ? this.t("lw.cppUnknownType")
                        : this.t("lw.compositeNoLayout");
            }
        }
        return originChanged;
    }

    _recordCppDiagnostics(result, types) {
        let recorded = 0;
        let suppressed = 0;
        let suppressedWarnings = 0;
        for (const symbol of result.symbols) {
            if (!isItaniumMangled(symbol.elfName || symbol.name)) continue;
            const info = types.get(symbol.name);
            const code = info?.ambiguous
                ? "CPP_SYMBOL_AMBIGUOUS"
                : !info || info.kind === "unknown"
                  ? "CPP_TYPE_UNRESOLVED"
                  : null;
            if (!code) continue;
            if (recorded >= MAX_CPP_DIAGNOSTICS) {
                suppressed++;
                if (code !== "CPP_TYPE_UNRESOLVED") suppressedWarnings++;
                continue;
            }
            recorded++;
            const i18nKey = code === "CPP_SYMBOL_AMBIGUOUS" ? "diag.cppSymbolAmbiguous" : "diag.cppTypeUnresolved";
            const i18nParams = { name: symbol.displayName || symbol.name };
            const message = this.t(i18nKey, i18nParams);
            result.diagnostics.push({ code, stage: "bind", message, i18nKey, i18nParams });
            if (code !== "CPP_TYPE_UNRESOLVED") result.warnings.push(`${code}: ${message}`);
        }
        if (suppressed) {
            const message = this.t("diag.cppDiagnosticsTruncated", { count: suppressed });
            const diagnostic = {
                code: "CPP_DIAGNOSTICS_TRUNCATED",
                stage: "bind",
                message,
                i18nKey: "diag.cppDiagnosticsTruncated",
                i18nParams: { count: suppressed }
            };
            result.diagnostics.push(diagnostic);
            if (suppressedWarnings) {
                const warning = this.t("diag.cppDiagnosticsTruncated", { count: suppressedWarnings });
                result.warnings.push(`CPP_DIAGNOSTICS_TRUNCATED: ${warning}`);
                diagnostic.warningMessage = warning;
                diagnostic.warningI18nParams = { count: suppressedWarnings };
            }
        }
    }

    async load() {
        if (!this.workerPath) return Promise.resolve(this.read());
        const elfPath = this._path();
        const stat = this.fs.statSync(elfPath);
        if (stat.size > MAX_ELF_BYTES)
            return Promise.reject(
                Object.assign(new Error(this.t("live.elfTooLarge", { path: elfPath, limit: 64 })), {
                    code: "ELF_TOO_LARGE",
                    i18nKey: "live.elfTooLarge",
                    i18nParams: { path: elfPath, limit: 64 }
                })
            );
        if (
            this.loadIdentity?.path === elfPath &&
            this.loadIdentity.mtimeMs === stat.mtimeMs &&
            this.loadIdentity.size === stat.size &&
            companionsUnchanged(this.cache?.companions, this.fs)
        )
            return this.symbolsPromise || Promise.resolve(this.cache);
        this.invalidate();
        this.loadIdentity = { path: elfPath, mtimeMs: stat.mtimeMs, size: stat.size };
        const generation = this.generation;
        const result = { symbols: [], functions: [], warnings: [], diagnostics: [], elf: null, dwarfReady: false };
        this.cache = result;
        const types = new Map();
        let worker;
        try {
            worker = new Worker(this.workerPath, {
                workerData: { path: elfPath, generation },
                resourceLimits: { maxOldGenerationSizeMb: 512 }
            });
        } catch (error) {
            this.loadIdentity = null;
            this.cache = null;
            throw error;
        }
        this.symbolsPromise = new Promise((resolve, reject) => {
            this.resolveSymbols = resolve;
            this.rejectSymbols = reject;
        });
        this.dwarfPromise = new Promise((resolve, reject) => {
            this.resolveDwarf = resolve;
            this.rejectDwarf = reject;
        });
        this.dwarfPromise.catch(() => {});
        this.worker = worker;
        const ack = (kind) =>
            setImmediate(() => {
                if (generation !== this.generation) return;
                try {
                    worker.postMessage({ type: "ack", kind });
                } catch {
                    /* Worker terminated during invalidation. */
                }
            });
        let failed = false;
        const fail = (error) => {
            if (generation !== this.generation || failed) return;
            failed = true;
            this.loadIdentity = null;
            const failure = Object.assign(new Error(error.message || String(error)), {
                code: error.code || "ELF_READ_FAILED"
            });
            if (this.rejectSymbols) this.rejectSymbols(failure);
            if (this.rejectDwarf) this.rejectDwarf(failure);
            this.rejectSymbols = null;
            this.rejectDwarf = null;
            this.dwarfPromise = null;
            result.dwarfReady = false;
            for (const pending of this.pendingLayouts.values()) pending.reject(failure);
            this.pendingLayouts.clear();
            worker.terminate().catch(() => {});
            if (this.worker === worker) this.worker = null;
            result.warnings.push(`${failure.code}: ${failure.message}`);
            this.onChange("failed", result);
        };
        worker.on("message", (message) => {
            if (generation !== this.generation || failed) return;
            switch (message.type) {
                case "metadata":
                    result.elf = message.elf;
                    result.memory = message.memory;
                    result.warnings.push(...message.warnings);
                    this.onChange("metadata", result);
                    break;
                case "symbols": {
                    const entries = message.entries.filter(
                        (symbol) => !isCppRuntimeSymbol(symbol.elfName || symbol.name)
                    );
                    result.symbols.push(...entries);
                    for (const symbol of entries) this.symbolByName.set(symbol.name, symbol);
                    this._enrich({ symbols: entries }, types);
                    this.onChange("symbols", result, entries);
                    ack("symbols");
                    break;
                }
                case "symbolsDone":
                    break;
                case "symbolIdentities":
                    this._applySymbolIdentities(result, message.entries);
                    ack("symbolIdentities");
                    break;
                case "symbolIdentitiesDone":
                    this.onChange("identities", result);
                    break;
                case "functionsDone":
                    this.resolveSymbols?.(result);
                    this.resolveSymbols = null;
                    this.rejectSymbols = null;
                    this.onChange("symbolsDone", result);
                    break;
                case "functions":
                    result.functions.push(...message.entries);
                    ack("functions");
                    break;
                case "types": {
                    for (const [name, info] of message.entries) types.set(name, info);
                    const changed = message.entries
                        .map(([name]) => this.symbolByName.get(name))
                        .filter((symbol) => !!symbol);
                    this._enrich({ symbols: changed }, types);
                    this.onChange("types", result, changed);
                    ack("types");
                    break;
                }
                case "displayNames": {
                    const changed = [];
                    for (const [name, displayName] of message.entries) {
                        const symbol = this.symbolByName.get(name);
                        if (symbol) {
                            symbol.displayName = displayName;
                            symbol.qualifiedName = displayName;
                            changed.push(symbol);
                        }
                    }
                    const names = new Map(message.entries);
                    for (const fn of result.functions) if (names.has(fn.name)) fn.displayName = names.get(fn.name);
                    if (changed.length) this.onChange("types", result, changed);
                    ack("displayNames");
                    break;
                }
                case "dwarfReady":
                    result.companions = message.companions || [];
                    result.diagnostics.push(...message.diagnostics);
                    result.typeMetadataIncomplete = message.diagnostics.some((entry) => entry.code !== "DWARF_MISSING");
                    // Symbols without DWARF records are reclassified only now; publish them as type updates.
                    // A partial parse dropped whole units, so a missing record no longer means "no debug info".
                    const originChanged = this._enrich(result, types, undefined, undefined, {
                        debugComplete: !isPartialDwarf(message.diagnostics)
                    });
                    for (let i = 0; i < originChanged.length; i += 1000)
                        this.onChange("types", result, originChanged.slice(i, i + 1000));
                    this._recordCppDiagnostics(result, types);
                    result.workerHeapUsed = message.heapUsed;
                    result.warnings.push(...message.diagnostics.map((d) => `${d.code}: ${d.message}`));
                    result.dwarfReady = true;
                    this.resolveDwarf?.(result);
                    this.resolveDwarf = null;
                    this.rejectDwarf = null;
                    this.onChange("dwarfReady", result);
                    break;
                case "dwarfFailed":
                    result.diagnostics.push(message.diagnostic);
                    fail(message.diagnostic);
                    break;
                case "layoutExpansionResult":
                case "layoutResult": {
                    const pending = this.pendingLayouts.get(message.id);
                    if (!pending) break;
                    this.pendingLayouts.delete(message.id);
                    for (const diagnostic of message.diagnostics || []) {
                        result.diagnostics.push(diagnostic);
                        result.warnings.push(`${diagnostic.code}: ${diagnostic.message}`);
                    }
                    if (message.error) {
                        if (message.type === "layoutResult") this.layoutErrors.set(message.name, message.error);
                        pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
                    } else pending.resolve(message.layout);
                    break;
                }
                case "failed":
                    fail(message.error);
                    break;
            }
        });
        worker.on("error", fail);
        worker.on("exit", (code) => {
            if (generation === this.generation && code !== 0) fail(new Error(`ELF worker exited (${code})`));
        });
        return this.symbolsPromise;
    }

    async ready() {
        await this.load();
        if (this.dwarfPromise) await this.dwarfPromise;
        if (!this.cache?.dwarfReady)
            throw Object.assign(new Error("DWARF type information is unavailable"), { code: "DWARF_PARSE_FAILED" });
        return this.cache;
    }

    async layout(name) {
        await this.ready();
        const symbol = this.symbolByName.get(name);
        if (!symbol) return null;
        if (symbol.cppTypeUnavailable) return null;
        if (symbol.compositeLayout) return symbol.compositeLayout;
        const previousError = this.layoutErrors.get(name);
        if (previousError) throw Object.assign(new Error(previousError.message), { code: previousError.code });
        const id = ++this.nextRequestId;
        const generation = this.generation;
        return new Promise((resolve, reject) => {
            this.pendingLayouts.set(id, {
                resolve: (layout) => {
                    if (generation !== this.generation) return reject(new Error("ELF changed"));
                    if (layout) {
                        layout.expansionGeneration = generation;
                        symbol.compositeLayout = layout;
                        symbol.runtimeLayout = layout.runtimeLayout;
                        symbol.unsupportedReason = "";
                    }
                    resolve(layout);
                },
                reject
            });
            try {
                this.worker.postMessage({ type: "layout", id, name });
            } catch (error) {
                this.pendingLayouts.delete(id);
                reject(error);
            }
        });
    }

    // Expansions remain detached: merging fresh budgets into a cached root would
    // bypass its depth/node bounds and change the meaning of existing write paths.
    async expandLayout(handle, generation) {
        validateLayoutExpansionRequest(handle, generation);
        if (generation !== this.generation)
            throw Object.assign(new Error("ELF layout generation changed"), { code: "STALE_LAYOUT_HANDLE" });
        try {
            await this.ready();
        } catch (error) {
            if (generation !== this.generation)
                throw Object.assign(new Error("ELF layout generation changed"), { code: "STALE_LAYOUT_HANDLE" });
            throw error;
        }
        if (generation !== this.generation)
            throw Object.assign(new Error("ELF layout generation changed"), { code: "STALE_LAYOUT_HANDLE" });
        if (!this.worker)
            throw Object.assign(new Error("ELF layout expansion requires a Worker"), { code: "ELF_LOADING" });
        if (this.pendingLayouts.size >= 128)
            throw Object.assign(new Error("Too many pending ELF layout requests"), { code: "DWARF_BUDGET_EXCEEDED" });
        const id = ++this.nextRequestId;
        return new Promise((resolve, reject) => {
            this.pendingLayouts.set(id, {
                isExpansion: true,
                resolve: (layout) => {
                    if (generation !== this.generation)
                        return reject(
                            Object.assign(new Error("ELF layout generation changed"), { code: "STALE_LAYOUT_HANDLE" })
                        );
                    if (layout) layout.expansionGeneration = generation;
                    resolve(layout);
                },
                reject
            });
            try {
                this.worker.postMessage({ type: "expandLayout", id, handle, generation });
            } catch (error) {
                this.pendingLayouts.delete(id);
                reject(error);
            }
        });
    }

    async expandSymbolLayout(name, path, handle, generation) {
        validateLayoutExpansionRequest(handle, generation);
        const parsed = validateLayoutExpansionTarget(name, path);
        const stale = () => Object.assign(new Error("ELF layout generation changed"), { code: "STALE_LAYOUT_HANDLE" });
        if (generation !== this.generation) throw stale();
        await this.ready();
        if (generation !== this.generation) throw stale();
        const symbol = this.symbolByName.get(name);
        const layout = await this.layout(name);
        if (generation !== this.generation) throw stale();
        const target = symbol && resolveLayoutPath(symbol, layout, parsed, { finalExpansion: false });
        if (
            !target ||
            target.path !== path ||
            target.node.expansionHandle !== handle ||
            !["depth-limit", "expansion-budget"].includes(target.node.unobservable)
        )
            throw Object.assign(new Error("Expansion handle does not belong to this symbol member path"), {
                code: "INVALID_LAYOUT_HANDLE"
            });
        if (symbol.layoutExpansions?.[path]) return symbol.layoutExpansions[path];
        const key = JSON.stringify([name, path]);
        if (this.symbolExpansionsPending.has(key)) return this.symbolExpansionsPending.get(key);
        const pendingCount = [...this.symbolExpansionsPending.keys()].filter(
            (key) => JSON.parse(key)[0] === name
        ).length;
        if (Object.keys(symbol.layoutExpansions || {}).length + pendingCount >= MAX_LAYOUT_EXPANSIONS)
            throw Object.assign(new Error("Per-symbol layout expansion limit reached"), {
                code: "LAYOUT_EXPANSION_LIMIT"
            });
        const task = (async () => {
            const expanded = await this.expandLayout(handle, generation);
            if (generation !== this.generation) throw stale();
            if (!expanded || expanded.byteSize !== target.node.byteSize)
                throw Object.assign(new Error("Expanded layout does not match its verified storage size"), {
                    code: "INVALID_COMPOSITE_LAYOUT"
                });
            validateComposite(expanded, target.node.byteSize, Number(symbol.address) + target.offset);
            const bytes = Buffer.byteLength(JSON.stringify(expanded));
            const total = (this.symbolExpansionBytes.get(name) || 0) + bytes;
            if (total > MAX_LAYOUT_EXPANSION_BYTES)
                throw Object.assign(new Error("Per-symbol layout metadata limit reached"), {
                    code: "LAYOUT_EXPANSION_LIMIT"
                });
            const candidate = {
                ...symbol,
                layoutExpansionGeneration: generation,
                layoutExpansions: { ...symbol.layoutExpansions, [path]: expanded }
            };
            expandCompositeLeaves(candidate, layout);
            symbol.layoutExpansionGeneration = generation;
            symbol.layoutExpansions ||= Object.create(null);
            symbol.layoutExpansions[path] = expanded;
            this.symbolExpansionBytes.set(name, total);
            return expanded;
        })();
        this.symbolExpansionsPending.set(key, task);
        try {
            return await task;
        } finally {
            if (this.symbolExpansionsPending.get(key) === task) this.symbolExpansionsPending.delete(key);
        }
    }

    read() {
        if (this.workerPath) {
            if (this.cache?.elf) {
                const currentPath = this._path();
                const stat = this.fs.statSync(currentPath);
                if (
                    this.cache.elf.path === currentPath &&
                    this.cache.elf.mtimeMs === stat.mtimeMs &&
                    this.cache.elf.size === stat.size &&
                    companionsUnchanged(this.cache.companions, this.fs)
                )
                    return this.cache;
                this.invalidate();
                this.load().catch(() => {});
                throw Object.assign(new Error("ELF changed; waiting for refreshed symbols"), { code: "ELF_CHANGED" });
            }
            this._path();
            throw Object.assign(new Error("ELF is still loading"), { code: "ELF_LOADING" });
        }
        let elfPath = this.context.workspaceState.get(this.cacheKey);
        if (!elfPath) {
            throw Object.assign(new Error(this.t("live.elfFirst")), {
                code: "ELF_NOT_CONFIGURED",
                i18nKey: "live.elfFirst"
            });
        }
        elfPath = this.cleanPath(elfPath);
        let buffer;
        let before;
        try {
            before = this.fs.statSync(elfPath);
            if (before.size > MAX_ELF_BYTES)
                throw Object.assign(
                    new Error(this.t("live.elfTooLarge", { path: elfPath, limit: MAX_ELF_BYTES / (1024 * 1024) })),
                    {
                        code: "ELF_TOO_LARGE",
                        i18nKey: "live.elfTooLarge",
                        i18nParams: { path: elfPath, limit: MAX_ELF_BYTES / (1024 * 1024) }
                    }
                );
            if (
                this.cache?.elfPath === elfPath &&
                this.cache.mtimeMs === before.mtimeMs &&
                this.cache.size === before.size &&
                companionsUnchanged(this.cache.result.companions, this.fs)
            )
                return this.cache.result;
            buffer = this.fs.readFileSync(elfPath);
            const after = this.fs.statSync(elfPath);
            if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
                throw new Error("ELF changed while it was being read; retry after the build finishes");
            }
        } catch (error) {
            // 体积上限是结构化拒绝，不能被下面的通用读取失败包裹掉。
            if (error.code === "ELF_TOO_LARGE") throw error;
            throw Object.assign(new Error(this.t("live.elfReadFail", { path: elfPath })), {
                code: "ELF_READ_FAILED",
                i18nKey: "live.elfReadFail",
                i18nParams: { path: elfPath },
                details: { elfPath, cause: error.message }
            });
        }

        const sha256 = this.crypto.createHash("sha256").update(buffer).digest("hex");
        if (
            this.cache?.elfPath === elfPath &&
            this.cache.sha256 === sha256 &&
            companionsUnchanged(this.cache.result.companions, this.fs)
        )
            return this.cache.result;

        const result = this.elfSymbols.parseElfSymbols(buffer);
        result.memory = this.elfSymbols.parseElfSections(buffer);
        result.symbols = result.symbols.filter((symbol) => !isCppRuntimeSymbol(symbol.elfName || symbol.name));
        result.elf = {
            path: elfPath,
            mtimeMs: before.mtimeMs,
            size: before.size,
            sha256,
            machine: buffer.length >= 20 ? buffer.readUInt16LE(18) : undefined,
            elfClass: buffer[4],
            encoding: buffer[5]
        };
        const parsed = this.dwarf.parseDwarf(buffer, { filePath: elfPath, runtime: true });
        // DWARF 已按源文件给同名 static 定下编译单元身份；按 ELF 名+地址+尺寸采用它们，使类型/布局键与符号名一致。
        const qualified = new Map();
        for (const symbol of Array.isArray(parsed?.symbols) ? parsed.symbols : [])
            if (symbol.elfName) qualified.set(`${symbol.elfName}\0${symbol.address}\0${symbol.size}`, symbol);
        for (const symbol of result.symbols) {
            const match = qualified.get(`${symbol.elfName || symbol.name}\0${symbol.address}\0${symbol.size}`);
            if (match)
                Object.assign(symbol, {
                    name: match.name,
                    elfName: match.elfName,
                    scope: match.scope,
                    sameNameCount: match.sameNameCount,
                    // Path-suffix scopes ('app/main.c'::x) match against the DWARF source path.
                    ...(match.sourceFile ? { sourceFile: match.sourceFile } : {})
                });
        }
        result.typeMetadataIncomplete = parsed?.diagnostics?.some((entry) => entry.code !== "DWARF_MISSING");
        result.companions = parsed?.companions || [];
        result.diagnostics = parsed?.diagnostics || [];
        for (const diagnostic of result.diagnostics) result.warnings.push(`${diagnostic.code}: ${diagnostic.message}`);
        const typeMap = parsed?.types || null;
        const layouts = parsed?.layouts || null;
        const displayNames = parsed?.displayNames || null;
        this._enrich(result, typeMap || new Map(), layouts || new Map(), displayNames || new Map(), {
            debugComplete: !isPartialDwarf(result.diagnostics)
        });
        this._recordCppDiagnostics(result, typeMap || new Map());
        for (const fn of result.functions || []) fn.displayName = displayNames?.get(fn.name) || fn.name;
        if (!typeMap || typeMap.size === 0) result.warnings.push(this.t("warn.noDwarf"));
        this.cache = { elfPath, mtimeMs: before.mtimeMs, size: before.size, sha256, result };
        return result;
    }
    // Worker refinement of same-named statics: [previous identity, identity | null]. Old keys are all
    // removed first, since a refined name may equal another symbol's previous name.
    _applySymbolIdentities(result, entries) {
        const updates = [];
        for (const [previous, identity] of entries) {
            const symbol = this.symbolByName.get(previous);
            if (!symbol) continue;
            this.symbolByName.delete(previous);
            updates.push([symbol, identity]);
        }
        const removed = new Set();
        for (const [symbol, identity] of updates) {
            if (!identity) {
                removed.add(symbol);
                continue;
            }
            const { addressAmbiguous, ...fields } = identity;
            Object.assign(symbol, fields);
            if (addressAmbiguous) symbol.addressAmbiguous = true;
            else delete symbol.addressAmbiguous;
            this.symbolByName.set(symbol.name, symbol);
        }
        if (removed.size) {
            // Keep the array identity: name indexes and resolved promises share it.
            const kept = result.symbols.filter((symbol) => !removed.has(symbol));
            result.symbols.splice(0, result.symbols.length, ...kept);
        }
    }
}

module.exports = { ElfService, MAX_LAYOUT_EXPANSIONS, MAX_LAYOUT_EXPANSION_BYTES };
