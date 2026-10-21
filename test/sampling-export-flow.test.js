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
            assert.strictEqual(doc.querySelector('input[name="exportRange"]'), null);
            assert.strictEqual(doc.getElementById("exportFromRange").disabled, false);
            assert.strictEqual(doc.getElementById("exportFromRange").value, "0");
            assert.strictEqual(doc.getElementById("exportToRange").value, doc.getElementById("exportToRange").max);
            doc.querySelector('#exportSeries input[data-index="0"]').checked = false;
            w.applyExport();
            const exported = page.messages.at(-1);
            assert.deepStrictEqual(exported.names, ["chosen"]);
            assert.strictEqual(exported.historyRevision, 0);
            for (const field of ["source", "snapshotId", "backendHistory", "csv", "fromMs", "toMs"])
                assert.strictEqual(exported[field], undefined, field);
            w.showExport();
            page.send(info);
            doc.getElementById("exportFromRange").value = String(info.lastTimestampMs - info.firstTimestampMs - 10000);
            w.updateExportTimeline("from");
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

const page = render(getLiveWatchContent({}, "zh"));
try {
    const { window: w, document: doc } = page;
    w.watch = [{ name: "v0", type: "f32", typeName: "float" }];
    w.impSymbolByName.set("v1", { name: "v1", watchType: "u32", typeName: "uint32_t" });
    w.showArchiveExport({
        variables: Array.from({ length: 12 }, (_, i) => "v" + i),
        firstTimestampMs: 1000,
        lastTimestampMs: 10000
    });
    const box = doc.getElementById("exportSeries");
    const rows = Array.from(box.querySelectorAll("tbody tr"));
    const inputs = rows.map((row) => row.querySelector("input"));
    assert.deepStrictEqual(
        Array.from(box.querySelectorAll("th"), (th) => th.textContent),
        ["变量名", "数据类型"]
    );
    assert.strictEqual(rows[0].lastChild.textContent, "float");
    assert.strictEqual(rows[1].lastChild.textContent, "uint32_t");
    assert.strictEqual(rows[2].lastChild.textContent, "未知类型");
    assert.strictEqual(doc.querySelector(".export-timeline-title").textContent, "时间范围");
    assert.strictEqual(doc.getElementById("exportRanges"), null);
    let scrollTop = 0;
    Object.defineProperties(box, {
        clientWidth: { value: 600 },
        clientHeight: { value: 180 },
        scrollTop: {
            get: () => scrollTop,
            set: (v) => {
                scrollTop = Math.max(0, Math.min(144, v));
            }
        }
    });
    box.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 180 });
    box.querySelector("thead").getBoundingClientRect = () => ({ height: 24 });
    rows.forEach((row, index) => {
        row.getBoundingClientRect = () => ({
            left: 0,
            right: 600,
            top: 24 + index * 25 - scrollTop,
            bottom: 49 + index * 25 - scrollTop
        });
    });
    let captured = false;
    box.setPointerCapture = () => {
        captured = true;
    };
    box.hasPointerCapture = () => captured;
    box.releasePointerCapture = () => {
        captured = false;
    };
    const frames = new Map();
    let nextFrame = 0;
    w.requestAnimationFrame = (cb) => {
        frames.set(++nextFrame, cb);
        return nextFrame;
    };
    w.cancelAnimationFrame = (id) => frames.delete(id);
    function pointer(type, target, x, y, button = 0, id = 7) {
        const event = new w.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button,
            buttons: type === "pointerup" ? 0 : 1
        });
        Object.defineProperty(event, "pointerId", { value: id });
        target.dispatchEvent(event);
    }
    const checked = () => inputs.map((input) => input.checked);
    pointer("pointerdown", rows[0], 50, 35, 2);
    assert.strictEqual(w.exportSeriesDrag, null, "right button does not start selection");
    pointer("pointerdown", rows[0], 50, 35);
    pointer("pointerup", box, 50, 35);
    assert.strictEqual(inputs[0].checked, false, "a row click toggles once");
    inputs[0].click();
    assert.strictEqual(inputs[0].checked, true, "keyboard checkbox activation still works");
    inputs[1].checked = false;
    pointer("pointerdown", rows[0], 50, 35);
    pointer("pointermove", box, 180, 80);
    assert.deepStrictEqual(checked().slice(0, 4), [false, true, false, true], "invert the original mixed selection");
    pointer("pointermove", box, 190, 80);
    assert.deepStrictEqual(
        checked().slice(0, 4),
        [false, true, false, true],
        "moving within rows does not toggle twice"
    );
    pointer("pointermove", box, 100, 40);
    assert.deepStrictEqual(
        checked().slice(0, 4),
        [false, false, true, true],
        "shrinking restores rows outside the box"
    );
    pointer("pointerup", box, 100, 40);
    assert.strictEqual(captured, false);
    assert.strictEqual(box.querySelector(".export-marquee"), null);
    assert.strictEqual(frames.size, 0);
    inputs.forEach((input) => {
        input.checked = false;
    });
    pointer("pointerdown", rows[0], 50, 35);
    pointer("pointermove", box, 160, 230);
    for (let i = 0; i < 10; i++) {
        const id = w.exportSeriesDrag.frame;
        const callback = frames.get(id);
        frames.delete(id);
        callback(w.exportSeriesDrag.lastFrame + 32);
    }
    assert.strictEqual(scrollTop, 144, "scroll down while the pointer stays below the list");
    assert.ok(
        inputs.every((input) => input.checked),
        "auto scrolling includes newly exposed rows"
    );
    pointer("pointerup", box, 160, 230);
    pointer("pointerdown", rows[11], 180, 160);
    pointer("pointermove", box, 40, -30);
    for (let i = 0; i < 10; i++) {
        const id = w.exportSeriesDrag.frame;
        const callback = frames.get(id);
        frames.delete(id);
        callback(w.exportSeriesDrag.lastFrame + 32);
    }
    assert.strictEqual(scrollTop, 0, "scroll up while the pointer stays above the list");
    assert.ok(
        inputs.every((input) => !input.checked),
        "upward selection inverts the full range"
    );
    pointer("pointercancel", box, 40, -30);
    assert.strictEqual(w.exportSeriesDrag, null);
    pointer("pointerdown", rows[0], 50, 35);
    pointer("pointermove", box, 160, 80);
    w.hideExport();
    assert.strictEqual(w.exportSeriesDrag, null, "closing releases an active drag");
    assert.strictEqual(captured, false);
    assert.strictEqual(box.querySelector(".export-marquee"), null);
    w.showArchiveExport({ variables: [] });
    pointer("pointerdown", box, 50, 35);
    assert.strictEqual(w.exportSeriesDrag, null, "empty lists do not start selection");
    page.assertHealthy();
} finally {
    page.close();
}
console.log("CSV table, click, mixed marquee inversion, shrink, auto scroll and cleanup passed");
