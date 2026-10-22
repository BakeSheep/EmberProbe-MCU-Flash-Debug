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
            const fileName = doc.getElementById("exportFileName"),
                search = doc.getElementById("exportSearch"),
                heading = doc.querySelector(".export-series-heading"),
                series = doc.getElementById("exportSeries");
            assert.strictEqual(fileName.value, "", "the default name is a placeholder, not an input value");
            assert.match(fileName.placeholder, /^emberprobe-live-\d{8}-\d{6}$/);
            assert.strictEqual(fileName.nextElementSibling.textContent, ".csv");
            assert.strictEqual(fileName.parentElement.nextElementSibling, heading);
            assert.strictEqual(heading.nextElementSibling, search);
            assert.strictEqual(search.nextElementSibling, series);
            assert.strictEqual(search.placeholder, lang === "zh" ? "搜索曲线" : "Search series");
            const filter = (value) => {
                search.value = value;
                search.dispatchEvent(new w.Event("input"));
            };
            filter(" APP::CHOSEN ");
            assert.deepStrictEqual(
                Array.from(series.querySelectorAll("tbody tr"), (row) => row.hidden),
                [true, false],
                "search matches displayed names regardless of case and surrounding spaces"
            );
            doc.getElementById("exportInvert").click();
            assert.deepStrictEqual(
                Array.from(w.selectedExportCandidates(), (item) => item.name),
                ["old"],
                "filtering and inverting preserve hidden selections"
            );
            doc.getElementById("exportSelectAll").click();
            filter("no match");
            doc.getElementById("exportInvert").click();
            assert.strictEqual(w.selectedExportCandidates().length, 2, "empty results leave selections intact");
            filter("");
            assert.ok(Array.from(series.querySelectorAll("tbody tr")).every((row) => !row.hidden));
            assert.strictEqual(doc.querySelector('input[name="exportRange"]'), null);
            assert.strictEqual(doc.getElementById("exportFromRange").disabled, false);
            assert.strictEqual(doc.getElementById("exportFromRange").value, "0");
            assert.strictEqual(doc.getElementById("exportToRange").value, doc.getElementById("exportToRange").max);
            const selectAll = doc.getElementById("exportSelectAll");
            const invert = doc.getElementById("exportInvert");
            const selectedNames = () => Array.from(w.selectedExportCandidates(), (item) => item.name);
            assert.strictEqual(selectAll.textContent, lang === "zh" ? "全选" : "Select all");
            assert.strictEqual(invert.textContent, lang === "zh" ? "反选" : "Invert");
            doc.querySelector('#exportSeries input[data-index="0"]').checked = false;
            invert.click();
            assert.deepStrictEqual(selectedNames(), ["old"], "invert toggles every row from a mixed selection");
            invert.click();
            assert.deepStrictEqual(selectedNames(), ["chosen"]);
            selectAll.click();
            selectAll.click();
            assert.deepStrictEqual(selectedNames(), ["old", "chosen"], "select all is idempotent");
            invert.click();
            assert.deepStrictEqual(selectedNames(), [], "invert supports deselecting all rows");
            invert.click();
            assert.deepStrictEqual(selectedNames(), ["old", "chosen"], "invert supports selecting all rows");
            doc.querySelector('#exportSeries input[data-index="0"]').checked = false;
            w.applyExport();
            const exported = page.messages.at(-1);
            assert.deepStrictEqual(exported.names, ["chosen"]);
            assert.strictEqual(exported.historyRevision, 0);
            assert.strictEqual(exported.fileName, fileName.placeholder + ".csv");
            for (const field of ["source", "snapshotId", "backendHistory", "csv", "fromMs", "toMs"])
                assert.strictEqual(exported[field], undefined, field);
            w.showExport();
            page.send(info);
            fileName.value = "  电源采样.CSV  ";
            doc.getElementById("exportFromRange").value = String(info.lastTimestampMs - info.firstTimestampMs - 10000);
            w.updateExportTimeline("from");
            w.applyExport();
            assert.strictEqual(page.messages.at(-1).fileName, "电源采样.csv", "custom names get one CSV extension");
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
            assert.strictEqual(fileName.value, "", "reopening restores the suggested name");
            assert.strictEqual(search.value, "", "reopening clears the series filter");
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

for (const lang of ["zh", "en"]) {
    const page = render(getLiveWatchContent({}, lang));
    try {
        const { window: w, document: doc } = page;
        // Real host archives qualify each name with its sampled type, including removed watches
        // and multiple historical interpretations of the same variable.
        const names = [
            "pwr.bus_ [u32]",
            "pwr.dev_adr_ [u8]",
            "pwr.data_.bus_voltage_v [f32]",
            "pwr.samples[2] [f64]",
            "removed [i64]",
            "pwr.bus_ [f32]",
            "_ZN3app5countE [u16]",
            "pwr.samples[3]"
        ];
        w.watch = [
            { name: "pwr.bus_", type: "f32" },
            { name: "pwr.data_.bus_voltage_v", type: "f32", typeName: "float" },
            { name: "pwr.samples[3]", type: "i16" }
        ];
        w.showArchiveExport({
            variables: names,
            displayNames: {
                "pwr.data_.bus_voltage_v [f32]": "pwr.data_.bus_voltage_v [f32]",
                "_ZN3app5countE [u16]": "app::count [u16]"
            },
            firstTimestampMs: 1000,
            lastTimestampMs: 2000
        });
        assert.deepStrictEqual(
            Array.from(doc.querySelectorAll(".export-series-name"), (cell) => cell.textContent),
            [
                "pwr.bus_",
                "pwr.dev_adr_",
                "pwr.data_.bus_voltage_v",
                "pwr.samples[2]",
                "removed",
                "pwr.bus_",
                "app::count",
                "pwr.samples[3]"
            ]
        );
        assert.deepStrictEqual(
            Array.from(doc.querySelectorAll(".export-series-type"), (cell) => cell.textContent),
            ["u32", "u8", "f32", "f64", "i64", "f32", "u16", "i16"]
        );
        doc.querySelector('#exportSeries input[data-index="5"]').checked = false;
        doc.getElementById("exportSearch").value = "_ZN3app";
        doc.getElementById("exportSearch").dispatchEvent(new w.Event("input"));
        assert.deepStrictEqual(
            Array.from(
                doc.querySelectorAll("#exportSeries tbody tr:not([hidden]) .export-series-name"),
                (el) => el.textContent
            ),
            ["app::count"],
            "search also matches the original archive name"
        );
        w.applyExport();
        assert.deepStrictEqual(
            page.messages.at(-1).names,
            names.filter((_, index) => index !== 5),
            "export keeps exact typed archive identities and independent type selections"
        );
        page.assertHealthy();
    } finally {
        page.close();
    }
}
console.log("Typed archive names, historical types, removed watches and exact export identities passed");

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
    doc.getElementById("exportSelectAll").click();
    doc.getElementById("exportInvert").click();
    pointer("pointerdown", box, 50, 35);
    assert.strictEqual(w.exportSeriesDrag, null, "empty lists do not start selection");
    page.assertHealthy();
} finally {
    page.close();
}
console.log("CSV table, click, mixed marquee inversion, shrink, auto scroll and cleanup passed");
