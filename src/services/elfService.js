"use strict";
const { Worker } = require("worker_threads");

// §3：解析前的 ELF 体积硬上限。MCU 固件 64 MiB 已极宽裕；
// autoDetect 会取工作区 mtime 最新的 .elf，无上限时多 GB 文件会被
// 整份 readFileSync 进内存再送入 DWARF 解析，直接压垮扩展宿主。
const MAX_ELF_BYTES = 64 * 1024 * 1024;

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
    }

    invalidate() {
        this.generation++;
        this.loadIdentity = null;
        if (this.worker) {
            this.worker.terminate().catch(() => {});
            this.worker = null;
        }
        for (const pending of this.pendingLayouts.values()) pending.reject(new Error("ELF changed"));
        this.pendingLayouts.clear();
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

    _enrich(result, types, layouts = new Map(), displayNames = new Map()) {
        for (const symbol of result.symbols) {
            const info = types.get(symbol.name);
            const looksCpp = /^_Z/.test(symbol.name);
            const unresolvedCpp = looksCpp && (!info || info.kind === "unknown");
            symbol.displayName = displayNames.get(symbol.name) || symbol.displayName || symbol.name;
            symbol.qualifiedName = symbol.displayName;
            symbol.typeName = info?.typeName || "";
            const layout = layouts.get(symbol.name);
            const hasLayout = !!layout && !info?.ambiguous;
            symbol.cppTypeUnavailable = !!info?.ambiguous || unresolvedCpp;
            const knownKind = info?.kind && info.kind !== "unknown";
            symbol.isComposite =
                !!info?.ambiguous ||
                hasLayout ||
                (knownKind
                    ? ["struct", "class", "union", "array"].includes(info.kind)
                    : /^(struct|class|union)\b/.test(symbol.typeName) ||
                      /\[\]$/.test(symbol.typeName) ||
                      unresolvedCpp ||
                      (!info && ![1, 2, 4, 8].includes(Number(symbol.size))));
            symbol.watchType = symbol.isComposite ? "" : info?.watchType || this.elfSymbols.defaultType(symbol.size);
            symbol.hasDwarfWriteType = !symbol.isComposite && !!info?.watchType;
            if (info?.isBoolean) symbol.isBoolean = true;
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
    }

    _recordCppDiagnostics(result, types) {
        for (const symbol of result.symbols) {
            if (!/^_Z/.test(symbol.name)) continue;
            const info = types.get(symbol.name);
            const code = info?.ambiguous
                ? "CPP_SYMBOL_AMBIGUOUS"
                : !info || info.kind === "unknown"
                  ? "CPP_TYPE_UNRESOLVED"
                  : null;
            if (!code) continue;
            const message = this.t(
                code === "CPP_SYMBOL_AMBIGUOUS" ? "diag.cppSymbolAmbiguous" : "diag.cppTypeUnresolved",
                {
                    name: symbol.displayName || symbol.name
                }
            );
            result.diagnostics.push({ code, stage: "bind", message });
            result.warnings.push(`${code}: ${message}`);
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
            this.loadIdentity.size === stat.size
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
                workerData: { path: elfPath },
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
                    result.warnings.push(...message.warnings);
                    this.onChange("metadata", result);
                    break;
                case "symbols":
                    result.symbols.push(...message.entries);
                    for (const symbol of message.entries) this.symbolByName.set(symbol.name, symbol);
                    this._enrich({ symbols: message.entries }, types);
                    this.onChange("symbols", result, message.entries);
                    ack("symbols");
                    break;
                case "symbolsDone":
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
                    result.diagnostics.push(...message.diagnostics);
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
                case "layoutResult": {
                    const pending = this.pendingLayouts.get(message.id);
                    if (!pending) break;
                    this.pendingLayouts.delete(message.id);
                    if (message.error) {
                        this.layoutErrors.set(message.name, message.error);
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
                        symbol.compositeLayout = layout;
                        symbol.unsupportedReason = "";
                    }
                    resolve(layout);
                },
                reject
            });
            this.worker.postMessage({ type: "layout", id, name });
        });
    }

    read() {
        if (this.workerPath) {
            if (this.cache?.elf) {
                const currentPath = this._path();
                const stat = this.fs.statSync(currentPath);
                if (
                    this.cache.elf.path === currentPath &&
                    this.cache.elf.mtimeMs === stat.mtimeMs &&
                    this.cache.elf.size === stat.size
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
                this.cache.size === before.size
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
        if (this.cache?.elfPath === elfPath && this.cache.sha256 === sha256) return this.cache.result;

        const result = this.elfSymbols.parseElfSymbols(buffer);
        result.elf = { path: elfPath, mtimeMs: before.mtimeMs, size: before.size, sha256 };
        const parsed = this.dwarf.parseDwarf(buffer);
        result.diagnostics = parsed?.diagnostics || [];
        for (const diagnostic of result.diagnostics) result.warnings.push(`${diagnostic.code}: ${diagnostic.message}`);
        const typeMap = parsed?.types || null;
        const layouts = parsed?.layouts || null;
        const displayNames = parsed?.displayNames || null;
        this._enrich(result, typeMap || new Map(), layouts || new Map(), displayNames || new Map());
        this._recordCppDiagnostics(result, typeMap || new Map());
        for (const fn of result.functions || []) fn.displayName = displayNames?.get(fn.name) || fn.name;
        if (!typeMap || typeMap.size === 0) result.warnings.push(this.t("warn.noDwarf"));
        this.cache = { elfPath, mtimeMs: before.mtimeMs, size: before.size, sha256, result };
        return result;
    }
}

module.exports = { ElfService };
