"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeElfDiagnostics = factory();
})(globalThis, function () {
    // Raw parser messages remain stable for logs/API users. Only presentation is localized.
    const messages = new Map([
        ["No DWARF type info found; types are inferred from size (build with -g for precise types)", "warn.noDwarf"],
        ["未读取到 DWARF 类型信息，类型按大小推测（如需精确类型，请用带 -g 的 Debug 构建）", "warn.noDwarf"],
        ["DWARF type information is unavailable", "elfDiag.code.DWARF_MISSING"],
        ["符号字符串表（.strtab）缺失", "elfDiag.elfStringTable"],
        ["ELF 符号表或字符串表越界", "elfDiag.elfSymbolBounds"],
        ["ELF 符号表条目大小无效", "elfDiag.elfSymbolSize"],
        ["ELF symbol processing budget exceeded", "elfDiag.elfSymbolBudget"],
        ["Layout consumer visit budget exceeded", "elfDiag.layoutVisits"],
        ["Layout consumer depth budget exceeded", "elfDiag.layoutDepth"],
        ["Layout decode budget exceeded", "elfDiag.layoutDecode"],
        ["Runtime layout branch is unavailable: depth-limit", "elfDiag.runtimeDepth"],
        ["Runtime layout branch is unavailable: expansion-budget", "elfDiag.runtimeBudget"],
        ["Runtime layout branch is unavailable: type-cycle", "elfDiag.runtimeCycle"],
        ["Runtime dynamic type graph exceeds its 4096 type budget", "elfDiag.dynamicBudget"],
        ["Runtime array dimension exceeds its integer budget", "elfDiag.runtimeArray"],
        ["DWARF array dimension exceeds its integer budget", "elfDiag.array"],
        ["DWARF root layout cannot fit its expansion budget", "elfDiag.rootBudget"],
        ["Required DWARF sections are unavailable", "elfDiag.missing"],
        ["Split DWARF requires the ELF path and its matching .dwo file", "elfDiag.companionRequired"],
        ["Split DWARF compilation-unit identity does not match its ELF", "elfDiag.companionMismatch"],
        ["DWARF type signature is unavailable", "elfDiag.signature"],
        ["Split DWARF address index is unavailable", "elfDiag.addressIndex"],
        ["Invalid split DWARF companion filename", "elfDiag.companionName"],
        ["Split DWARF companion path escapes the ELF directory", "elfDiag.companionEscape"],
        ["Split DWARF companion exceeds its shared file budget", "elfDiag.companionBudget"],
        ["Split DWARF companion changed while reading", "elfDiag.companionChanged"],
        ["Split DWARF companion count exceeds 32", "elfDiag.companionCount"],
        ["Truncated or oversized LEB128 value", "elfDiag.leb"],
        ["Truncated DWARF integer", "elfDiag.integerTruncated"],
        ["DWARF integer exceeds 64 bits", "elfDiag.integer64"],
        ["DWARF offset exceeds the safe integer range", "elfDiag.offset"],
        ["DWARF indirect form nesting exceeded", "elfDiag.indirect"],
        ["Invalid DWARF cursor", "elfDiag.cursor"],
        ["Truncated DWARF attribute", "elfDiag.attribute"],
        ["Unterminated DWARF string", "elfDiag.string"],
        ["Truncated DWARF64 header", "elfDiag.header64"],
        ["Oversized DWARF64 unit", "elfDiag.unit64"],
        ["Unsupported DWARF unit length", "elfDiag.unitLength"],
        ["Oversized DWARF offset", "elfDiag.offsetLarge"],
        ["Truncated DWARF unit", "elfDiag.unitTruncated"],
        ["unknown abbrev code", "elfDiag.abbrev"],
        ["ELF changed while it was being read", "elfDiag.elfChanged"],
        ["ELF changed while it was being read; retry after the build finishes", "elfDiag.elfChangedRetry"],
        ["ELF exceeds the 64 MiB limit", "elfDiag.elfTooLarge"],
        ["Too many pending ELF layout requests", "elfDiag.pending"],
        ["文件过小，不是有效的 ELF", "elfDiag.elfSmall"],
        ["不是有效的 ELF 文件（魔数不匹配）", "elfDiag.elfMagic"],
        ["仅支持 32 位 ELF（Cortex-M）", "elfDiag.elf32"],
        ["仅支持小端 ELF（Cortex-M）", "elfDiag.elfEndian"],
        ["缺少节头表，可能已被 strip（请用 Debug 构建）", "elfDiag.elfSections"],
        ["ELF 节头表越界或条目大小无效", "elfDiag.elfSectionBounds"],
        ["未找到符号表（.symtab）：请使用 Debug 构建且不要 strip", "elfDiag.elfSymbols"],
        ["Truncated zstd block header", "elfDiag.zstd"],
        ["Invalid zstd block type", "elfDiag.zstd"],
        ["Truncated zstd block", "elfDiag.zstd"],
        ["Truncated zstd checksum", "elfDiag.zstd"],
        ["Truncated zstd frame magic", "elfDiag.zstd"],
        ["Truncated zstd skippable header", "elfDiag.zstd"],
        ["Truncated zstd skippable frame", "elfDiag.zstd"],
        ["Invalid or truncated zstd frame header", "elfDiag.zstd"]
    ]);
    /** @type {Array<[RegExp, string, string]>} */
    const patterns = [
        [/^Matching split DWARF companion is missing: (.+)$/, "elfDiag.companionMissing", "name"],
        [/^Unsupported DWARF version (.+)$/, "elfDiag.version", "value"],
        [/^Unsupported DWARF unit type (.+)$/, "elfDiag.unitType", "value"],
        [/^unknown DWARF form (0x[0-9a-f]+)$/, "elfDiag.form", "value"],
        [/^ELF32 DWARF address size must be 4, got (.+)$/, "elfDiag.addrSize", "value"],
        [/^DWARF section is outside the ELF: (.+)$/, "elfDiag.sectionBounds", "section"],
        [/^Compressed DWARF section header is truncated: (.+)$/, "elfDiag.compressedHeader", "section"],
        [/^Compressed DWARF section is too large: (.+)$/, "elfDiag.compressedLarge", "section"],
        [/^(?:Legacy compressed|Compressed) DWARF section size mismatch: (.+)$/, "elfDiag.compressedSize", "section"],
        [/^Legacy compressed DWARF section is truncated: (.+)$/, "elfDiag.legacySection", "section"],
        [/^e_machine=(0x[0-9a-f]+) 非 ARM，解析结果可能不准确$/, "elfDiag.machine", "value"]
    ];
    const codes = new Set([
        "DWARF_BUDGET_EXCEEDED",
        "DWARF_TYPE_CYCLE",
        "DWARF_MISSING",
        "DWARF_UNSUPPORTED",
        "DWARF_CU_INVALID",
        "DWARF_SECTION_INVALID",
        "DWARF_COMPANION_MISSING",
        "DWARF_COMPANION_MISMATCH",
        "DWARF_TYPE_UNRESOLVED",
        "DWARF_ADDRESS_UNRESOLVED",
        "DWARF_INVALID_ELF",
        "DWARF_PARSE_FAILED",
        "CPP_SYMBOL_AMBIGUOUS",
        "CPP_TYPE_UNRESOLVED",
        "CPP_DIAGNOSTICS_TRUNCATED",
        "ELF_READ_FAILED",
        "ELF_TOO_LARGE"
    ]);
    const budgets = new Map([
        ["abbreviation", "elfDiag.budget.abbreviation"],
        ["abbreviation attribute", "elfDiag.budget.abbreviation_attribute"],
        ["global attribute", "elfDiag.budget.global_attribute"],
        ["global abbreviation", "elfDiag.budget.global_abbreviation"],
        ["decompressed section", "elfDiag.budget.decompressed_section"],
        ["zstd window", "elfDiag.budget.zstd_window"],
        ["zstd content size", "elfDiag.budget.zstd_content_size"],
        ["zstd output", "elfDiag.budget.zstd_output"],
        ["compilation unit", "elfDiag.budget.compilation_unit"],
        ["DIE", "elfDiag.budget.DIE"],
        ["enum member", "elfDiag.budget.enum_member"],
        ["diagnostic", "elfDiag.budget.diagnostic"],
        ["layout response", "elfDiag.budget.layout_response"],
        ["time", "elfDiag.budget.time"]
    ]);
    function translateMessage(message, t) {
        const readFailure = /^(?:Cannot read ELF: |无法读取 ELF：)(.+)$/.exec(message);
        if (readFailure) return t("live.elfReadFail", { path: readFailure[1] });
        const fileLimit =
            /^(?:ELF exceeds the (\d+) MiB safety limit and was not parsed: |ELF 超过 (\d+) MiB 安全上限，已拒绝解析：)(.+)$/.exec(
                message
            );
        if (fileLimit) return t("live.elfTooLarge", { limit: fileLimit[1] || fileLimit[2], path: fileLimit[3] });
        const key = messages.get(message);
        if (key) return t(key);
        for (const [pattern, key, param] of patterns) {
            const match = pattern.exec(message);
            if (match) return t(key, { [param]: match[1] });
        }
        const budget = /^DWARF (.+) budget exceeded$/.exec(message);
        if (budget && budgets.has(budget[1])) return t(budgets.get(budget[1]));
        const compression = /^Unsupported DWARF compression type (\d+): (.+)$/.exec(message);
        if (compression) return t("elfDiag.compression", { value: compression[1], section: compression[2] });
        return null;
    }
    function formatDiagnostic(value, t) {
        const raw = typeof value === "string" ? value : typeof value?.message === "string" ? value.message : "";
        if (typeof t !== "function") return raw;
        const prefix = /^([A-Z][A-Z0-9_]+): ([\s\S]*)$/.exec(raw);
        const code = typeof value === "object" && value?.code ? value.code : prefix?.[1];
        const message = prefix ? prefix[2] : raw;
        const localized = value?.i18nKey ? t(value.i18nKey, value.i18nParams) : translateMessage(message, t);
        if (localized) return (code ? code + ": " : "") + localized;
        // Some saved-watch layout failures are prefixed with a variable's readable name.
        const separator = raw.lastIndexOf(": ");
        if (separator >= 0) {
            const detail = translateMessage(raw.slice(separator + 2), t);
            if (detail) return raw.slice(0, separator + 2) + detail;
        }
        if (codes.has(code)) return code + ": " + t("elfDiag.code." + code);
        return raw;
    }
    function displayWarnings(result) {
        const indexed = new Map(
            (result?.diagnostics || [])
                .filter((diagnostic) => diagnostic.i18nKey)
                .map((diagnostic) => [
                    diagnostic.code + ": " + (diagnostic.warningMessage || diagnostic.message),
                    {
                        code: diagnostic.code,
                        message: diagnostic.warningMessage || diagnostic.message,
                        i18nKey: diagnostic.i18nKey,
                        i18nParams: diagnostic.warningI18nParams || diagnostic.i18nParams
                    }
                ])
        );
        return (result?.warnings || []).map((message) => indexed.get(message) || message);
    }
    return { formatDiagnostic, displayWarnings };
});
