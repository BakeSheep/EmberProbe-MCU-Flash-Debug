"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

for (const lang of ["zh", "en"]) {
    for (const backendHistory of [false, true]) {
        const page = render(getLiveWatchContent({ backendHistory }, lang));
        try {
            const { window: w, document: doc } = page;
            assert.strictEqual(doc.getElementById("exportSource"), null);
            assert.strictEqual(doc.querySelector(".export-history-note"), null);
            // Freezing or losing old in-memory points must not select a partial export source.
            w.frozen = true;
            w.remoteHistory.snapshotId = "snapshot";
            w.showExport();
            assert.deepStrictEqual(page.messages.at(-1), {
                type: "samplingArchiveInfo",
                openExport: true,
                historyRevision: 0,
                panelId: 1
            });
            const info = {
                type: "samplingArchiveInfo",
                openExport: true,
                historyRevision: 0,
                variables: ["old", "chosen"],
                displayNames: { chosen: "app::chosen" },
                firstTimestampMs: 1000,
                lastTimestampMs: 4 * 60 * 60 * 1000
            };
            page.send(info);
            assert.strictEqual(doc.querySelector('input[name="exportRange"]:checked').value, "all");
            doc.querySelector('#exportSeries input[data-index="0"]').checked = false;
            w.applyExport();
            const exported = page.messages.at(-1);
            assert.deepStrictEqual(exported.names, ["chosen"]);
            assert.strictEqual(exported.historyRevision, 0);
            for (const field of ["source", "snapshotId", "backendHistory", "csv", "fromMs", "toMs"])
                assert.strictEqual(exported[field], undefined, field);
            w.showExport();
            page.send(info);
            doc.querySelector('input[name="exportRange"][value="10"]').checked = true;
            w.applyExport();
            assert.strictEqual(page.messages.at(-1).fromMs, info.lastTimestampMs - 10000);
            assert.strictEqual(page.messages.at(-1).toMs, info.lastTimestampMs);
            w.clearHistory();
            const revision = w.historyRevision;
            page.send(info);
            assert.strictEqual(w.exportCandidates.length, 0, "late archive replies cannot resurrect cleared history");
            const count = page.messages.length;
            w.showExport();
            assert.strictEqual(page.messages.length, count, "wait for history clear acknowledgement");
            page.send({ type: "samplingHistoryCleared", historyRevision: revision });
            w.showExport();
            page.send({
                ...info,
                historyRevision: revision,
                variables: ["chosen"],
                firstTimestampMs: info.lastTimestampMs + 10,
                lastTimestampMs: info.lastTimestampMs + 20
            });
            w.applyExport();
            assert.strictEqual(page.messages.at(-1).historyRevision, revision);
            assert.strictEqual(w.exportTimelineStart, info.lastTimestampMs + 10);
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
}
console.log("Full sampling archive export, language, frozen charts, selection and clear isolation passed");
