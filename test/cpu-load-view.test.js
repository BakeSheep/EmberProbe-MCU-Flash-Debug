"use strict";
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { t } = require("../src/i18n");
for (const lang of ["zh", "en"]) {
    const html = getModernWebviewContent({}, lang);
    const initial = new JSDOM(html, { virtualConsole: new VirtualConsole() });
    try {
        assert.strictEqual(initial.window.document.getElementById("cpuLoadSection"), null);
        const row = initial.window.document.getElementById("cpuLoadRow");
        assert(row.closest("#flashDebugSection #memoryAnalysisSection"));
        const other = initial.window.document.getElementById("memoryAnalysisSection");
        assert.deepStrictEqual(
            [...other.querySelectorAll(":scope > .other-block")].map((block) => block.id),
            ["memoryUsageBlock", "experimentalFeaturesBlock"]
        );
        assert.strictEqual(row.tagName, "DIV");
        assert.strictEqual(row.querySelector('[data-i18n="cpu.experimental"]'), null);
        assert(initial.window.document.getElementById("memoryRefresh").closest("#memoryUsageBlock .other-block-head"));
        assert(
            initial.window.document
                .getElementById("cpuLoadToggle")
                .closest("#experimentalFeaturesBlock .other-block-head")
        );
        for (const label of other.querySelectorAll(".other-block-head [data-i18n]"))
            assert.strictEqual(label.textContent, t(lang, label.dataset.i18n));
        assert.strictEqual(row.querySelectorAll(".cpu-inline-badge").length, 1);
        for (const label of row.querySelectorAll("[data-i18n]"))
            assert.strictEqual(label.textContent, t(lang, label.dataset.i18n));
    } finally {
        initial.window.close();
    }
    const page = render(html);
    try {
        page.assertHealthy();
        const el = (id) => page.document.getElementById(id);
        const row = el("cpuLoadRow");
        const toggle = el("cpuLoadToggle");
        assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
        assert(toggle.disabled, "support must be established by the host before enabling Start");
        page.send({ type: "cpuLoad", state: "stopped", canStart: true, canStop: false, ownsProbe: false });
        assert(toggle.title.includes(t(lang, "cpu.startHint")));
        assert.strictEqual(el("cpuWorkload").textContent, "—");
        assert.strictEqual(el("cpuCoverage").textContent, "—");
        const beforeRowClick = page.messages.length;
        row.click();
        assert.strictEqual(page.messages.length, beforeRowClick, "CPU bar is display-only");
        el("memoryRefresh").click();
        assert.strictEqual(page.messages.at(-1).type, "memoryRefresh");
        assert.strictEqual(el("memoryAnalysisSection").open, true, "memory refresh does not fold Other");
        toggle.click();
        assert.strictEqual(page.messages.at(-1).type, "cpuLoadStart");
        const sample = {
            type: "cpuLoad",
            state: "collecting",
            intentEnabled: true,
            ownsProbe: true,
            canStart: false,
            canStop: true,
            windowMs: 1000,
            actualHz: 160,
            coveragePercent: 100,
            workloadPercent: 70,
            tasks: [{ name: "<script>danger()</script>", percent: 10 }],
            hotspots: [{ name: "shared", percent: 5 }]
        };
        page.send(sample);
        assert.strictEqual(el("cpuWorkload").textContent, "—");
        assert.strictEqual(el("cpuCoverage").textContent, "100.0%");
        assert.strictEqual(el("cpuLoadProgress").value, 0);
        assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
        page.send({ ...sample, state: "running" });
        assert.strictEqual(el("cpuWorkload").textContent, "70.0%");
        assert.strictEqual(el("cpuLoadProgress").value, 70);
        assert.strictEqual(row.dataset.available, "true");
        assert.strictEqual(row.querySelector("script"), null);
        assert.strictEqual(el("cpuLoadTasks"), null);
        assert.strictEqual(el("cpuLoadMetrics"), null);
        for (const next of [lang === "zh" ? "en" : "zh", lang]) {
            page.send({ type: "setLang", lang: next });
            assert.strictEqual(row.querySelector('[data-i18n="cpu.title"]').textContent, t(next, "cpu.title"));
            assert.strictEqual(row.querySelector('[data-i18n="cpu.coverage"]').textContent, t(next, "cpu.coverage"));
            assert(toggle.title.includes(t(next, "cpu.stopHint")));
            assert.strictEqual(el("experimentalFeaturesTitle").textContent, t(next, "cpu.experimentalFeatures"));
            assert.strictEqual(el("memoryUsageTitle").textContent, t(next, "memory.title"));
            assert.strictEqual(el("cpuWorkload").textContent, "70.0%");
            assert.strictEqual(el("cpuCoverage").textContent, "100.0%");
            assert.strictEqual(
                el("memoryAnalysisSection").querySelector('[data-i18n="sb.memoryRegions"]').textContent,
                t(next, "sb.memoryRegions")
            );
        }
        const beforeFold = page.messages.length;
        el("memoryAnalysisSection").open = false;
        el("memoryAnalysisSection").open = true;
        assert.strictEqual(page.messages.length, beforeFold, "folding Other does not control sampling");
        page.send({ ...sample, state: "low-coverage", coveragePercent: 70, workloadPercent: 40 });
        assert.strictEqual(row.dataset.state, "low-coverage");
        assert.strictEqual(el("cpuCoverage").textContent, "70.0%");
        assert.strictEqual(el("cpuWorkload").textContent, "—");
        assert.strictEqual(el("cpuLoadProgress").value, 0);
        assert(row.title.includes(t(lang, "cpu.lowCoverageNote")));
        for (const workload of [null, -1, 101, NaN, Infinity]) {
            page.send({ ...sample, state: "running", workloadPercent: workload });
            assert.strictEqual(el("cpuWorkload").textContent, "—");
            assert.strictEqual(el("cpuLoadProgress").value, 0);
        }
        page.send({ ...sample, state: "running", coveragePercent: 79.9 });
        assert.strictEqual(el("cpuWorkload").textContent, "—", "inconsistent state cannot bypass coverage gate");
        page.send({ ...sample, state: "running", coveragePercent: 80, workloadPercent: 0 });
        assert.strictEqual(el("cpuWorkload").textContent, "0.0%", "zero workload is a valid estimate");
        assert.strictEqual(row.dataset.available, "true");
        for (const state of ["paused", "unavailable", "stopped"]) {
            page.send({
                ...sample,
                state,
                reason: "<script>missing()</script>",
                intentEnabled: state !== "stopped",
                ownsProbe: state !== "stopped",
                canStart: state === "stopped"
            });
            assert.strictEqual(el("cpuWorkload").textContent, "—");
            assert.strictEqual(el("cpuCoverage").textContent, "—", "inactive states clear previous window");
            assert.strictEqual(el("cpuLoadProgress").value, 0);
            assert(row.title.includes("<script>missing()</script>"));
            assert.strictEqual(row.querySelector("script"), null);
            toggle.click();
            assert.strictEqual(page.messages.at(-1).type, state === "stopped" ? "cpuLoadStart" : "cpuLoadStop");
        }
        page.send({
            type: "cpuLoad",
            state: "stopped",
            canStart: false,
            canStop: false,
            blockedReason: { code: "CPU_LAYOUT_UNSUPPORTED", i18nKey: "cpu.unsupportedProject" }
        });
        assert(toggle.disabled);
        assert(toggle.title.includes(t(lang, "cpu.unsupportedProject")));
        const blockedMessages = page.messages.length;
        toggle.click();
        assert.strictEqual(page.messages.length, blockedMessages);
        page.send({ ...sample, state: "running" });
        const download = page.document.querySelector('[data-command="mcu-vscode.download"]');
        assert(download.disabled);
        assert(el("liveToggle").disabled);
        page.send({ type: "probeDriverSwitch", busy: false });
        page.send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
        assert(download.disabled, "driver and chip renders cannot undo CPU exclusion");
        assert(el("chipRead").disabled);
        assert(!toggle.disabled, "Stop remains accessible to the CPU owner");
        page.send({ ...sample, state: "stopping", intentEnabled: false, canStop: false });
        assert(toggle.disabled);
        assert(download.disabled);
        page.send({ type: "cpuLoad", state: "stopped", ownsProbe: false, canStart: true, canStop: false });
        assert(!download.disabled);
    } finally {
        page.close();
    }
}
console.log("Inline CPU workload, coverage, bilingual controls and stale-state tests passed");
