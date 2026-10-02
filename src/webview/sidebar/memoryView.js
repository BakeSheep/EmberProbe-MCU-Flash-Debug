"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeMemoryView = factory();
})(globalThis, function () {
    const esc = (value) =>
        String(value ?? "").replace(
            /[&<>"']/g,
            (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
        );
    function bytes(value) {
        if (value == null) return "—";
        if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MiB`;
        if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
        return `${value} B`;
    }
    function render(result, t) {
        const summaries = ["flash", "ram"].map(
            (kind) =>
                "<span><strong>" +
                kind.toUpperCase() +
                "</strong> " +
                esc(bytes(result[kind].total)) +
                (result[kind].estimated
                    ? ' <small class="memory-estimate">' + esc(t("memory.estimated")) + "</small>"
                    : "") +
                "</span>"
        );
        const regions = result.regions
            .map((region) => {
                const percent = region.percent == null ? "—" : `${region.percent.toFixed(2)}%`;
                const rows = region.sections
                    .map(
                        (section) =>
                            "<tr><td>" +
                            esc(section.name) +
                            "</td><td>" +
                            esc(section.runtimeAddress || (section.role === "runtime" ? section.address : "—")) +
                            "</td><td>" +
                            esc(section.loadAddress || (section.role === "load" ? section.address : "—")) +
                            "</td><td>" +
                            esc(bytes(section.size)) +
                            "</td><td>" +
                            esc(t(`memory.${section.role}`)) +
                            "</td></tr>"
                    )
                    .join("");
                return (
                    '<div class="memory-region' +
                    (region.percent > 100 ? " overflow" : "") +
                    '">' +
                    '<div class="memory-region-head"><strong>' +
                    esc(region.name) +
                    "</strong><span>" +
                    percent +
                    '</span></div><div class="memory-region-size">' +
                    esc(bytes(region.used)) +
                    " / " +
                    esc(bytes(region.capacity)) +
                    '</div><progress max="100" value="' +
                    Math.min(100, Math.max(0, region.percent || 0)) +
                    '" aria-label="' +
                    esc(region.name) +
                    '"' +
                    (region.percent == null ? " hidden" : "") +
                    "></progress>" +
                    '<details class="memory-details" data-region="' +
                    esc(region.name) +
                    '"><summary>' +
                    esc(t("memory.sections")) +
                    " · " +
                    esc(bytes(region.sectionBytes)) +
                    "</summary>" +
                    '<div class="memory-table-wrap"><table><thead><tr><th>' +
                    esc(t("memory.section")) +
                    "</th><th>" +
                    esc(t("memory.runtimeAddress")) +
                    "</th><th>" +
                    esc(t("memory.loadAddress")) +
                    "</th><th>" +
                    esc(t("memory.bytes")) +
                    "</th><th>" +
                    esc(t("memory.role")) +
                    "</th></tr></thead><tbody>" +
                    rows +
                    "</tbody></table></div></details></div>"
                );
            })
            .join("");
        const warningLabels = {
            MEMORY_LAYOUT_MISSING: "memory.layoutMissing",
            MEMORY_SOURCE_AMBIGUOUS: "memory.ambiguous",
            MAP_ELF_MISMATCH: "memory.mapMismatch",
            REGION_KIND_UNKNOWN: "memory.unknownKind"
        };
        const warnings = result.diagnostics
            .map(
                (item) =>
                    '<li title="' +
                    esc(item.message) +
                    '">' +
                    esc(warningLabels[item.code] ? t(warningLabels[item.code]) : item.message) +
                    "</li>"
            )
            .join("");
        const source = result.source.mapFile || result.source.linkerScript || result.elf.path;
        const symbols = result.topSymbols
            .map(
                (symbol) =>
                    '<tr><td title="' +
                    esc(symbol.name) +
                    '">' +
                    esc(symbol.displayName) +
                    "</td><td>" +
                    esc(symbol.section) +
                    "</td><td>" +
                    esc(bytes(symbol.size)) +
                    "</td></tr>"
            )
            .join("");
        return (
            '<div class="memory-summary">' +
            summaries.join("") +
            '</div><small class="memory-source" title="' +
            esc(source) +
            '">' +
            esc(source.split(/[\\/]/).pop()) +
            '</small><p class="memory-note">' +
            esc(t("memory.basis")) +
            "</p>" +
            (warnings ? '<ul class="memory-warnings">' + warnings + "</ul>" : "") +
            regions +
            '<details class="memory-details memory-symbols"><summary>' +
            esc(t("memory.symbols")) +
            '</summary><div class="memory-table-wrap"><table><thead><tr><th>' +
            esc(t("memory.symbol")) +
            "</th><th>" +
            esc(t("memory.section")) +
            "</th><th>" +
            esc(t("memory.bytes")) +
            "</th></tr></thead><tbody>" +
            symbols +
            "</tbody></table></div></details>"
        );
    }
    function create({ api, t, uiState }) {
        const body = document.getElementById("memoryBody");
        const refresh = document.getElementById("memoryRefresh");
        const select = document.getElementById("memorySelectSource");
        let last = { state: "idle" },
            requestId = -1;
        refresh.onclick = () => api?.postMessage({ type: "memoryRefresh" });
        select.onclick = () => api?.postMessage({ type: "memorySelectSource" });
        function repaint() {
            refresh.disabled = last.state === "loading";
            select.disabled = last.state === "loading";
            body.setAttribute("aria-busy", String(last.state === "loading"));
            if (last.state !== "ready") {
                body.textContent =
                    t(last.state === "loading" ? "memory.loading" : last.key || "memory.selectElf") +
                    (last.state === "error" && last.code !== "ELF_NOT_CONFIGURED" && last.message
                        ? `: ${last.message}`
                        : "");
                return;
            }
            body.innerHTML = render(last.result, t);
            const key = last.result.elf.path;
            for (const details of body.querySelectorAll("details")) {
                const id = key + ":" + (details.dataset.region || "symbols");
                details.open = !!uiState.memoryExpanded?.[id];
                details.addEventListener("toggle", () => {
                    uiState.memoryExpanded ||= {};
                    uiState.memoryExpanded[id] = details.open;
                    api?.setState?.(uiState);
                });
            }
        }
        return {
            render: repaint,
            receive(message) {
                if (message.requestId != null && message.requestId < requestId) return;
                if (message.requestId != null) requestId = message.requestId;
                last = message;
                repaint();
            }
        };
    }
    return { create, render, bytes };
});
