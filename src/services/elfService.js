"use strict";

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
        this.cache = null;
    }

    invalidate() {
        this.cache = null;
    }

    read() {
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
        for (const symbol of result.symbols) {
            const info = typeMap?.get(symbol.name);
            symbol.typeName = info?.typeName || "";
            const layout = layouts?.get(symbol.name);
            const hasLayout = !!layout;
            symbol.isComposite =
                hasLayout ||
                /^(struct|union)\b/.test(symbol.typeName) ||
                /\[\]$/.test(symbol.typeName) ||
                (!info && ![1, 2, 4, 8].includes(Number(symbol.size)));
            symbol.watchType = symbol.isComposite ? "" : info?.watchType || this.elfSymbols.defaultType(symbol.size);
            symbol.hasDwarfWriteType = !symbol.isComposite && !!info?.watchType;
            if (symbol.isComposite) {
                symbol.compositeLayout = layout || null;
                symbol.unsupportedReason = hasLayout ? "" : this.t("lw.compositeNoLayout");
            }
        }
        if (!typeMap || typeMap.size === 0) result.warnings.push(this.t("warn.noDwarf"));
        this.cache = { elfPath, mtimeMs: before.mtimeMs, size: before.size, sha256, result };
        return result;
    }
}

module.exports = { ElfService };
