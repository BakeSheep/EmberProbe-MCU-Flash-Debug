"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeCpuLoadView = factory();
})(globalThis, function () {
    function create({ api, t }) {
        const row = document.getElementById("cpuLoadRow");
        if (!row) return null;
        const el = (id) => document.getElementById(id);
        let latest = { state: "stopped" };
        const validPercent = (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
        const pct = (value) => (validPercent(value) ? `${value.toFixed(1)}%` : "—");
        const toggle = el("cpuLoadToggle");
        toggle.addEventListener("click", () =>
            api?.postMessage({ type: latest.intentEnabled ? "cpuLoadStop" : "cpuLoadStart" })
        );
        function render() {
            row.dataset.state = latest.state;
            toggle.setAttribute("aria-pressed", String(!!latest.intentEnabled));
            const action = t(latest.intentEnabled ? "cpu.stopHint" : "cpu.startHint");
            toggle.title = action;
            toggle.setAttribute("aria-label", action);
            const hasWindow = ["collecting", "running", "low-coverage"].includes(latest.state);
            const coverage = hasWindow ? pct(latest.coveragePercent) : "—";
            const available =
                latest.state === "running" &&
                validPercent(latest.coveragePercent) &&
                latest.coveragePercent >= 80 &&
                validPercent(latest.workloadPercent);
            const workload = available ? pct(latest.workloadPercent) : "—";
            el("cpuWorkload").textContent = workload;
            el("cpuCoverage").textContent = coverage;
            el("cpuLoadProgress").value = available ? latest.workloadPercent : 0;
            row.dataset.available = String(available);
            const notes = [t(`cpu.state.${latest.state}`)];
            if (latest.error || latest.reason) notes.push(latest.error || latest.reason);
            if (latest.state === "low-coverage") notes.push(t("cpu.lowCoverageNote"));
            if (hasWindow && latest.workloadPercent === null) notes.push(t("cpu.idleUnconfirmed"));
            row.title = notes.join("\n");
            row.setAttribute(
                "aria-label",
                `${t("cpu.title")}: ${workload}; ${t("cpu.coverage")}: ${coverage}. ${notes.join(". ")}`
            );
        }
        render();
        return {
            render,
            onSummary(message) {
                latest = message;
                render();
            }
        };
    }
    return { create };
});
