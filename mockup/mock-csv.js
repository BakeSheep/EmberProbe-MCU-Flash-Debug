"use strict";
// CSV writer for the standalone mockup's simulated export download. The extension itself exports on the host
// through src/services/samplingArchive.js; the escaping rules here mirror its csvField / csvHeaderField.
const { createSampleTimeFormatter } = require("../src/services/sampleTime");

// RFC 4180 with a UTF-8 BOM and CRLF rows: a time column plus one column per series, rows aligned by timestamp.
function buildCsv(names, buffers, opts) {
    opts = opts || {};
    const from = Number.isFinite(opts.from) ? opts.from : -Infinity;
    const to = Number.isFinite(opts.to) ? opts.to : Infinity;
    const NUMERIC_CELL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    function esc(value, header) {
        let text = String(value);
        const risky = header
            ? /^[=+\-@\t\r]/.test(text)
            : /^[=+@\t\r]/.test(text) || (text.charAt(0) === "-" && !NUMERIC_CELL.test(text));
        if (risky) text = "'" + text;
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    const rows = [["time"].concat(names.map((name) => esc(name, true))).join(",")];
    const times = [];
    const cellsByTime = new Map();
    buffers.forEach((arr, seriesIndex) => {
        for (const point of arr) {
            if (!point) continue;
            const time = Number(point.t);
            if (!Number.isFinite(time) || time < from || time > to) continue;
            let cells = cellsByTime.get(time);
            if (!cells) {
                cells = new Array(names.length).fill("");
                cellsByTime.set(time, cells);
                times.push(time);
            }
            cells[seriesIndex] = point.v == null ? "" : esc(point.valueText ?? point.v);
        }
    });
    times.sort((a, b) => a - b);
    const iso = createSampleTimeFormatter();
    for (const time of times) rows.push([iso(time)].concat(cellsByTime.get(time)).join(","));
    return "﻿" + rows.join("\r\n") + "\r\n";
}

function csvDataRowCount(csv) {
    let quoted = false;
    let lines = 0;
    for (let i = 0; i < csv.length; i++) {
        if (csv[i] === '"') {
            if (quoted && csv[i + 1] === '"') i++;
            else quoted = !quoted;
        } else if (csv[i] === "\n" && !quoted) lines++;
    }
    if (csv && !csv.endsWith("\n")) lines++;
    return Math.max(0, lines - 1);
}

// The browser script served as dist/csv.js; it carries its own copy of the timestamp formatter.
function browserSource() {
    return (
        "window.EmberProbeMockCsv = (function () {\n" +
        `const createSampleTimeFormatter = ${createSampleTimeFormatter};\n` +
        `return { buildCsv: ${buildCsv}, csvDataRowCount: ${csvDataRowCount} };\n` +
        "})();\n"
    );
}

module.exports = { buildCsv, csvDataRowCount, browserSource };
