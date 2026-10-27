"use strict";
const assert = require("assert");
const { formatDiagnostic, displayWarnings } = require("../src/webview/elfDiagnostics");
const { t } = require("../src/i18n");
const { ElfService } = require("../src/services/elfService");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const translate = (lang) => (key, params) => {
    const value = t(lang, key, params);
    assert.notStrictEqual(value, key, `missing translation: ${lang}/${key}`);
    return value;
};
const depth = "DWARF_BUDGET_EXCEEDED: Runtime layout branch is unavailable: depth-limit";
const messages = [
    depth,
    "DWARF_BUDGET_EXCEEDED: Runtime layout branch is unavailable: expansion-budget",
    "DWARF_TYPE_CYCLE: Runtime layout branch is unavailable: type-cycle",
    "DWARF_BUDGET_EXCEEDED: Runtime dynamic type graph exceeds its 4096 type budget",
    "DWARF_BUDGET_EXCEEDED: DWARF global abbreviation budget exceeded",
    "DWARF_BUDGET_EXCEEDED: Runtime array dimension exceeds its integer budget",
    "DWARF_BUDGET_EXCEEDED: DWARF root layout cannot fit its expansion budget",
    "DWARF_MISSING: Required DWARF sections are unavailable",
    "DWARF_UNSUPPORTED: Unsupported DWARF version 6",
    "DWARF_UNSUPPORTED: unknown DWARF form 0xff",
    "DWARF_UNSUPPORTED: Unsupported DWARF compression type 7: .debug_info",
    "DWARF_CU_INVALID: Truncated DWARF64 header",
    "DWARF_SECTION_INVALID: Compressed DWARF section size mismatch: .debug_info",
    "DWARF_COMPANION_MISSING: Matching split DWARF companion is missing: object.dwo",
    "DWARF_COMPANION_MISSING: Split DWARF companion path escapes the ELF directory",
    "DWARF_COMPANION_MISMATCH: Split DWARF compilation-unit identity does not match its ELF",
    "DWARF_TYPE_UNRESOLVED: DWARF type signature is unavailable",
    "DWARF_ADDRESS_UNRESOLVED: Split DWARF address index is unavailable",
    "DWARF_INVALID_ELF: ELF 节头表越界或条目大小无效",
    "ELF_READ_FAILED: 未找到符号表（.symtab）：请使用 Debug 构建且不要 strip",
    "ELF_TOO_LARGE: ELF exceeds the 64 MiB limit",
    "e_machine=0x3e 非 ARM，解析结果可能不准确"
];
for (const raw of messages) {
    const zh = formatDiagnostic(raw, translate("zh"));
    const en = formatDiagnostic(raw, translate("en"));
    assert(/[\u4e00-\u9fff]/.test(zh), zh);
    assert(!/[\u4e00-\u9fff]/.test(en), en);
    assert.notStrictEqual(zh, en);
    const code = raw.match(/^([A-Z_]+): /)?.[1];
    if (code) assert(zh.startsWith(code + ": ") && en.startsWith(code + ": "));
}
assert(formatDiagnostic(depth, translate("zh")).includes("嵌套过深"));
assert(formatDiagnostic(depth, translate("en")).includes("depth limit"));
assert(formatDiagnostic(messages[3], translate("zh")).includes("4096"));
assert(formatDiagnostic(messages[12], translate("zh")).includes(".debug_info"));
assert(formatDiagnostic(messages[13], translate("zh")).includes("object.dwo"));
assert.strictEqual(
    formatDiagnostic("custom external diagnostic <x>", translate("zh")),
    "custom external diagnostic <x>"
);
assert.strictEqual(formatDiagnostic(depth), depth, "raw diagnostics remain available without a UI translator");
assert.strictEqual(formatDiagnostic(null, translate("zh")), "");
assert.strictEqual(formatDiagnostic({ message: 42 }, translate("zh")), "");
assert.strictEqual(
    formatDiagnostic({ code: "DWARF_PARSE_FAILED", message: "unfamiliar parser exception" }, translate("zh")),
    "DWARF_PARSE_FAILED: DWARF 调试信息解析失败。"
);
assert(
    formatDiagnostic("lab::device: DWARF root layout cannot fit its expansion budget", translate("zh")).startsWith(
        "lab::device: "
    )
);
for (const raw of ["Cannot read ELF: C:/build/demo.elf", "无法读取 ELF：C:/build/demo.elf"]) {
    assert.strictEqual(formatDiagnostic(raw, translate("en")), "Cannot read ELF: C:/build/demo.elf");
    assert.strictEqual(formatDiagnostic(raw, translate("zh")), "无法读取 ELF：C:/build/demo.elf");
}
for (const lang of ["zh", "en"]) {
    const raw = t(lang, "live.elfTooLarge", { limit: 64, path: "C:/demo.elf" });
    assert.strictEqual(
        formatDiagnostic(raw, translate("zh")),
        t("zh", "live.elfTooLarge", { limit: 64, path: "C:/demo.elf" })
    );
    assert.strictEqual(
        formatDiagnostic(raw, translate("en")),
        t("en", "live.elfTooLarge", { limit: 64, path: "C:/demo.elf" })
    );
}

// Host-localized C++ diagnostics retain their translation metadata across cached snapshots.
const service = new ElfService({ t: translate("zh") });
const result = { symbols: [{ name: "_Z3amb", displayName: "app::amb" }], diagnostics: [], warnings: [] };
service._recordCppDiagnostics(result, new Map([["_Z3amb", { ambiguous: true }]]));
const original = structuredClone(result);
const warnings = displayWarnings(result);
assert.strictEqual(typeof result.warnings[0], "string", "Agent/API warning shape is unchanged");
assert(formatDiagnostic(warnings[0], translate("en")).includes("C++ symbol app::amb"));
assert.deepStrictEqual(result, original, "preparing a UI snapshot never mutates raw diagnostics");
assert.deepStrictEqual(displayWarnings(null), []);
const overflow = {
    symbols: Array.from({ length: 55 }, (_, i) => ({ name: `_Z${i}missing` })),
    diagnostics: [],
    warnings: []
};
overflow.symbols.push({ name: "_Z3amb" });
service._recordCppDiagnostics(overflow, new Map([["_Z3amb", { ambiguous: true }]]));
assert(
    formatDiagnostic(displayWarnings(overflow)[0], translate("en")).startsWith("CPP_DIAGNOSTICS_TRUNCATED: 1 further")
);

const Provider = loadProvider();
const provider = Object.create(Provider.prototype);
provider._elfService = { cache: { ...result, elf: { sha256: "elf1" }, dwarfReady: true } };
const sent = [];
provider._sendElfSnapshot((message) => sent.push(message), "availableVariables");
const hostWarning = sent.find((message) => message.type === "availableTypesDone").warnings[0];
assert.strictEqual(hostWarning.i18nKey, "diag.cppSymbolAmbiguous");

// A diagnostics notice shows the first message; the rest fold into its details panel.
function noticeLines(box) {
    const notice = box.querySelector(".notice");
    if (!notice) return [];
    const text = notice.querySelector(".notice-content > .notice-text, .notice-head > .notice-text");
    const detail = notice.querySelector(".notice-diagnostic pre")?.textContent || "";
    return [text?.textContent || "", ...detail.split("\n")].filter(Boolean);
}
const expanded = (box) => box.querySelector(".notice-toggle")?.getAttribute("aria-expanded") === "true";
for (const lang of ["zh", "en"]) {
    const sidebar = render(getModernWebviewContent({}, lang));
    const graph = render(getLiveWatchContent({}, lang));
    try {
        for (const [view, type, id] of [
            [sidebar, "availableVariables", "availableDiagnostics"],
            [graph, "variablesList", "elfDiagnostics"]
        ]) {
            view.send({ type: type + "Reset", version: "v1", warnings: [depth, depth, hostWarning] });
            const box = view.document.getElementById(id);
            assert.strictEqual(box.hidden, false);
            assert.strictEqual(noticeLines(box).length, 2, "translated diagnostics stay deduplicated");
            assert(box.querySelector(".notice").classList.contains("notice--warning"));
            box.querySelector(".notice-toggle").click();
            const initial = box.textContent;
            const next = lang === "zh" ? "en" : "zh";
            view.send({ type: "setLang", lang: next });
            assert.notStrictEqual(box.textContent, initial, "cached diagnostic contents follow the language toggle");
            assert(box.textContent.includes(formatDiagnostic(depth, translate(next))));
            assert(box.textContent.includes(formatDiagnostic(hostWarning, translate(next))));
            assert(expanded(box), "language changes preserve the expanded state");
            view.send({
                type: type + "Done",
                version: "v1",
                warnings: [
                    "DWARF_COMPANION_MISSING: Matching split DWARF companion is missing: <img src=x onerror=alert(1)>.dwo"
                ]
            });
            assert.strictEqual(box.querySelector("img"), null, "diagnostic parameters are text only");
            assert(box.textContent.includes("<img src=x onerror=alert(1)>.dwo"));
        }
        // Both waveform diagnostic surfaces use the same formatter.
        assert.strictEqual(
            graph.document.getElementById("importDiagnostics").textContent,
            graph.document.getElementById("elfDiagnostics").textContent
        );
        graph.send({ type: "variablesListDone", version: "v1", warnings: [depth], error: depth });
        const failed = graph.document.getElementById("elfDiagnostics");
        assert(failed.querySelector(".notice").classList.contains("notice--error"));
        assert.strictEqual(noticeLines(failed).length, 1, "the error is not repeated as a warning");
        viewHealth(sidebar, graph);
    } finally {
        sidebar.close();
        graph.close();
    }
}
function viewHealth(...views) {
    for (const view of views) view.assertHealthy();
}
console.log("ELF/DWARF diagnostic language, cached toggles, raw API compatibility and safe rendering passed");
