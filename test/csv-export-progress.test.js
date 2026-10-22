"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

// The waveform panel shows archive CSV export progress and keeps the export button disabled until it finishes.
for (const lang of ["en", "zh"]) {
    const view = render(getLiveWatchContent({ backendHistory: true }, lang));
    try {
        const doc = view.document,
            status = doc.getElementById("status"),
            button = doc.getElementById("export");
        view.send({ type: "exportCsvProgress", percent: 42.4 });
        assert.ok(status.textContent.includes("42%"), status.textContent);
        assert.strictEqual(button.disabled, true, "a running export cannot be started twice");
        view.send({ type: "exportCsvProgress", percent: 250 });
        assert.ok(status.textContent.includes("100%"), "progress is clamped");
        view.send({ type: "exportCsvResult", ok: false, cancelled: true, aborted: true });
        assert.strictEqual(button.disabled, false);
        assert.strictEqual(status.textContent, lang === "zh" ? "已取消导出 CSV" : "CSV export cancelled");
        view.send({ type: "exportCsvProgress", percent: 10 });
        view.send({ type: "exportCsvResult", ok: false, message: "disk full" });
        assert.strictEqual(button.disabled, false);
        assert.ok(status.textContent.includes("disk full"));
        view.send({ type: "exportCsvResult", ok: false, cancelled: true });
        assert.ok(status.textContent.includes("disk full"), "closing the save dialog adds no status message");
        view.send({ type: "exportCsvProgress", percent: 99 });
        view.send({ type: "exportCsvResult", ok: true, seriesCount: 2, rowCount: 600000 });
        assert.strictEqual(button.disabled, false);
        assert.ok(status.textContent.includes("600000"));
        view.assertHealthy();
    } finally {
        view.close();
    }
}
console.log("CSV export progress, cancel and failure status tests passed");
