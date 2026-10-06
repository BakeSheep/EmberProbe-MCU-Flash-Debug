"use strict";
const { STRINGS, t, normalizeLang, jsonForScript } = require("./i18n");
const { DEFAULT_FREQUENCY_HZ, frequencyHzFromInterval, intervalMsFromHz, normalizeFrequencyHz } = require("./samplingFrequency");
const { loadWebviewAsset } = require("./webviewTemplate");
const liveWatchCss = loadWebviewAsset("liveWatch", "app.css");
const liveWatchViewport = loadWebviewAsset("liveWatch", "viewport.js");
const liveWatchRenderer = loadWebviewAsset("liveWatch", "renderer.js");
// 独立实时变量面板：无外部依赖，使用高 DPI Canvas 绘制曲线。
// 采样序列 → RFC 4180 CSV：time 列（ISO 8601 UTC）+ 每变量一列，行尾 CRLF，带 UTF-8 BOM；
// 各序列按采样时间戳对齐（同一 tick 共享同一时刻），晚加入的序列起始前留空单元格
function buildCsv(names, buffers, opts) {
    opts = opts || {};
    const from = Number.isFinite(opts.from) ? opts.from : -Infinity;
    const to = Number.isFinite(opts.to) ? opts.to : Infinity;
    // This function is serialized into the live-watch page as window.__BUILD_CSV__, so it must stay
    // self-contained and cannot close over module imports. Keep these rules in step with csvField /
    // csvHeaderField in src/services/samplingArchive.js, which serves the archive-backed exports.
    const NUMERIC_CELL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    function esc(value, header) {
        let text = String(value);
        // Header names never contain numbers, so any leading "-" is a formula risk there. Data cells
        // are dominated by negative readings, so "-" only counts when the rest is not a plain number.
        const risky = header
            ? /^[=+\-@\t\r]/.test(text)
            : /^[=+@\t\r]/.test(text) || (text.charAt(0) === "-" && !NUMERIC_CELL.test(text));
        if (risky) text = "'" + text;
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    const rows = [['time'].concat(names.map(function(name){return esc(name,true)})).join(',')];
    const times = [];
    const cellsByTime = new Map();
    buffers.forEach((arr, seriesIndex) => {
        for (const point of arr) {
            if (!point) continue;
            const time = Number(point.t);
            if (!Number.isFinite(time) || time < from || time > to) continue;
            let cells = cellsByTime.get(time);
            if (!cells) {
                cells = new Array(names.length).fill('');
                cellsByTime.set(time, cells);
                times.push(time);
            }
            cells[seriesIndex] = point.v == null
                ? ''
                : esc(point.valueText !== null && point.valueText !== undefined ? point.valueText : point.v);
        }
    });
    times.sort((a, b) => a - b);
    for (const time of times) rows.push([new Date(time).toISOString()].concat(cellsByTime.get(time)).join(','));
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
}
function csvDataRowCount(csv) {
    let quoted = false;
    let lines = 0;
    for (let i = 0; i < csv.length; i++) {
        if (csv[i] === '"') {
            if (quoted && csv[i + 1] === '"') i++;
            else quoted = !quoted;
        } else if (csv[i] === '\n' && !quoted) lines++;
    }
    if (csv && !csv.endsWith('\n')) lines++;
    return Math.max(0, lines - 1);
}
function getLiveWatchContent(cfg, lang) {
    const raw = cfg || {};
    const frequencyHz =
        raw.frequencyHz !== undefined
            ? normalizeFrequencyHz(raw.frequencyHz)
            : raw.intervalMs !== undefined
              ? frequencyHzFromInterval(Math.min(10000, Math.max(5, Number(raw.intervalMs) || 100)))
              : DEFAULT_FREQUENCY_HZ;
    const conf = {
        maxSamples: Math.min(360001, Math.max(100, Math.floor(Number(raw.maxSamples) || 2000))),
        backendHistory: !!raw.backendHistory,
        autoMaxSamples: raw.autoMaxSamples !== false,
        frequencyHz,
        intervalMs: intervalMsFromHz(frequencyHz),
        panelId: Math.max(1, Math.floor(Number(raw.panelId) || 1))
    };
    const L = normalizeLang(lang), tr = (k, p) => t(L, k, p), i18nJson = jsonForScript(STRINGS);
    return `<!doctype html><html lang="${L==='zh'?'zh-CN':'en'}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';">
<title>${tr('lw.title')}</title><style>
${liveWatchCss}
</style></head><body><div class="top"><span class="sr-only" id="status" role="status">${tr('lw.ready')}</span><div class="toolbar">
<div class="group"><i class="status-dot" id="dot" role="img"></i><button class="ghost side-toggle" id="sideToggle" title="${tr('lw.collapsePane')}">‹ ${tr('lw.valuePane')}</button><button id="run">${tr('lw.startSampling')}</button><label><span data-i18n="lw.targetFrequency">${tr('lw.targetFrequency')}</span> <input id="frequency" type="number" min="0.1" max="200" step="0.1" value="${conf.frequencyHz}"> Hz</label></div>
<div class="group"><button id="import" class="secondary" data-i18n="lw.importVars">${tr('lw.importVars')}</button><span class="ac-wrap"><input id="addName" role="combobox" aria-autocomplete="list" aria-controls="acDrop" aria-expanded="false" data-i18n-ph="lw.addByName" placeholder="${tr('lw.addByName')}"><div class="ac-dropdown" id="acDrop" role="listbox"></div></span><button id="addBtn" class="secondary" data-i18n="lw.add">${tr('lw.add')}</button></div>
<div class="group"><label><span data-i18n="lw.window">${tr('lw.window')}</span> <select id="timeWindow"><option value="10" data-i18n="lw.sec10">${tr('lw.sec10')}</option><option value="30" selected data-i18n="lw.sec30">${tr('lw.sec30')}</option><option value="60" data-i18n="lw.sec60">${tr('lw.sec60')}</option><option value="0" data-i18n="lw.all">${tr('lw.all')}</option><option value="custom" data-i18n="lw.windowCustom" hidden>${tr('lw.windowCustom')}</option></select></label><button id="freeze" class="ghost">${tr('lw.freeze')}</button><button id="norm" class="ghost" data-i18n="lw.normalize" data-i18n-title="lw.normalized" title="${tr('lw.normalized')}">${tr('lw.normalize')}</button><button id="clear" class="ghost" data-i18n="lw.clear">${tr('lw.clear')}</button><button id="export" class="ghost" data-i18n="lw.exportCsv" data-i18n-title="lw.exportCsvTitle" title="${tr('lw.exportCsvTitle')}">${tr('lw.exportCsv')}</button></div>
<button class="lang-toggle" id="langToggle" type="button" data-i18n-title="common.langTitle" title="${tr('common.langTitle')}" aria-label="${tr('common.langTitle')}"></button></div></div><main class="layout" id="layout"><aside class="side"><div class="side-head"><strong data-i18n="lw.currentValues">${tr('lw.currentValues')}</strong><span class="badge" id="count">0</span><span id="rate">0 Hz</span></div><div class="var-list" id="vars"><div class="empty" data-i18n="lw.varListEmpty">${tr('lw.varListEmpty')}</div></div></aside><div class="side-splitter" id="sideSplitter" data-i18n-title="lw.splitterHint" title="${tr('lw.splitterHint')}"></div><section class="chart-pane"><div class="chart-head"><strong data-i18n="lw.history">${tr('lw.history')}</strong><span id="range">—</span><span class="spacer"></span><span id="points">${tr('lw.points',{n:0})}</span></div><div class="chart-wrap" id="chartWrap"><div class="chart-stage" id="chartStage"><canvas id="chart"></canvas><div class="chart-empty" id="chartEmpty" data-i18n="lw.chartEmpty">${tr('lw.chartEmpty')}</div></div><div class="chart-overview" id="chartOverview"><div class="range-timeline chart-timeline" id="chartTimeline" data-i18n-title="lw.chartTimelineHint" title="${tr('lw.chartTimelineHint')}"><div class="range-fill chart-range-fill" id="chartRangeFill"></div><div class="chart-timeline-labels"><span id="chartAxisStart">00:00</span><span id="chartAxisEnd">00:00</span></div><input type="range" id="chartFromRange" min="0" max="1" value="0" aria-label="${tr('lw.chartFrom')}"><input type="range" id="chartToRange" min="0" max="1" value="1" aria-label="${tr('lw.chartTo')}"></div></div></div></section></main>
<div class="overlay hidden" id="overlay"><div class="panel"><h3 data-i18n="lw.importTitle">${tr('lw.importTitle')}</h3><div class="filter-wrap"><input id="impFilter" data-i18n-ph="lw.filterVars" placeholder="${tr('lw.filterVars')}"><button class="filter-clear" id="impFilterClear" type="button" data-i18n-title="lw.clearFilter" title="${tr('lw.clearFilter')}" aria-label="${tr('lw.clearFilter')}">×</button></div><div class="warn" id="impWarn"></div><div class="imp-meta" id="impCount"></div><div class="imp-list" id="impList"></div><div class="right"><button class="secondary" id="impCancel" data-i18n="lw.cancel">${tr('lw.cancel')}</button><button id="impAdd" data-i18n="lw.importSelected">${tr('lw.importSelected')}</button></div></div></div>
<div class="overlay hidden" id="exportOverlay"><div class="panel export-panel"><h3 data-i18n="lw.exportTitle">${tr('lw.exportTitle')}</h3><div class="export-label" data-i18n="lw.exportSeries">${tr('lw.exportSeries')}</div><div class="export-series" id="exportSeries"></div><div class="export-label" data-i18n="lw.exportRange">${tr('lw.exportRange')}</div><div class="export-ranges" id="exportRanges"><label><input type="radio" name="exportRange" value="all" checked> <span data-i18n="lw.exportAll">${tr('lw.exportAll')}</span></label><label><input type="radio" name="exportRange" value="10"> <span data-i18n="lw.exportRecent10">${tr('lw.exportRecent10')}</span></label><label><input type="radio" name="exportRange" value="30"> <span data-i18n="lw.exportRecent30">${tr('lw.exportRecent30')}</span></label><label><input type="radio" name="exportRange" value="60"> <span data-i18n="lw.exportRecent60">${tr('lw.exportRecent60')}</span></label><label><input type="radio" name="exportRange" value="custom"> <span data-i18n="lw.exportCustom">${tr('lw.exportCustom')}</span></label></div><div class="export-custom disabled" id="exportCustom"><div class="export-timeline-title" data-i18n="lw.exportTimeline">${tr('lw.exportTimeline')}</div><div class="export-axis-labels"><span id="exportAxisStart">00:00</span><span id="exportAxisEnd">00:00</span></div><div class="range-timeline export-timeline"><div class="range-fill export-range-fill" id="exportRangeFill"></div><input type="range" id="exportFromRange" min="0" max="1" value="0" aria-label="${tr('lw.exportFrom')}" disabled><input type="range" id="exportToRange" min="0" max="1" value="1" aria-label="${tr('lw.exportTo')}" disabled></div><div class="export-selection" id="exportSelection"></div></div><div class="warn" id="exportWarn"></div><div class="right"><button class="secondary" id="exportCancel" data-i18n="lw.cancel">${tr('lw.cancel')}</button><button id="exportApply" data-i18n="lw.exportSave">${tr('lw.exportSave')}</button></div></div></div>
<script>window.__CFG__=${jsonForScript(conf)};window.__LANG__=${jsonForScript(L)};window.__I18N__=${i18nJson};window.__BUILD_CSV__=${buildCsv.toString()};</script><script>
${liveWatchViewport}
</script><script>
${liveWatchRenderer}
</script></body></html>`;
}
module.exports = { getLiveWatchContent, buildCsv, csvDataRowCount };
