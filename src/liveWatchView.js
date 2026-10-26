"use strict";
const { STRINGS, t, normalizeLang, jsonForScript } = require("./i18n");
const { DEFAULT_FREQUENCY_HZ, frequencyHzFromInterval, intervalMsFromHz, normalizeFrequencyHz } = require("./samplingFrequency");
const { loadWebviewAsset } = require("./webviewTemplate");
const { createSampleTimeFormatter } = require("./services/sampleTime");
const liveWatchCss = loadWebviewAsset("liveWatch", "app.css");
const liveWatchViewport = loadWebviewAsset("liveWatch", "viewport.js");
const liveWatchRenderer = loadWebviewAsset("liveWatch", "renderer.js");
// 独立实时变量面板：无外部依赖，使用高 DPI Canvas 绘制曲线。
// 采样序列 → RFC 4180 CSV：time 列（ISO 8601 UTC）+ 每变量一列，行尾 CRLF，带 UTF-8 BOM；
// 各序列按采样时间戳对齐（同一 tick 共享同一时刻，可含亚毫秒），晚加入的序列起始前留空单元格
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
    const iso = createSampleTimeFormatter();
    for (const time of times) rows.push([iso(time)].concat(cellsByTime.get(time)).join(','));
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
    const samplingHint = (id) => `<div class="sampling-hint" id="${id}" role="note"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6"/><path d="M8 4.5v4"/><circle class="sampling-hint-dot" cx="8" cy="11.5" r=".6"/></svg><span data-i18n="lw.samplingSelectionHint">${tr('lw.samplingSelectionHint')}</span></div>`;
    return `<!doctype html><html lang="${L==='zh'?'zh-CN':'en'}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';">
<title>${tr('lw.title')}</title><style>
${liveWatchCss}
</style></head><body><div class="top"><span class="sr-only" id="status" role="status">${tr('lw.ready')}</span><div class="toolbar">
<div class="group sampling-tools"><i class="status-dot" id="dot" role="img"></i><button class="ghost side-toggle" id="sideToggle" title="${tr('lw.collapsePane')}">‹ ${tr('lw.valuePane')}</button><button id="run">${tr('lw.startSampling')}</button>
<button id="import" class="secondary" data-i18n="lw.importVars">${tr('lw.importVars')}</button><span class="ac-wrap"><input id="addName" role="combobox" aria-autocomplete="list" aria-controls="acResults" aria-describedby="acSamplingHint acChoiceHint" aria-expanded="false" data-i18n-ph="lw.addByName" placeholder="${tr('lw.addByName')}"><div class="ac-dropdown" id="acDrop">${samplingHint("acSamplingHint")}<div id="acChoiceHint" class="ac-choice-hint" role="status" hidden data-i18n="lw.chooseVariableSource">${tr('lw.chooseVariableSource')}</div><div id="acResults" role="listbox"></div></div></span></div>
<div class="group frequency-tools"><div class="frequency-picker" id="frequencyPicker"><label for="frequency" id="frequencyLabel" data-i18n="lw.targetFrequency">${tr('lw.targetFrequency')}</label><div class="frequency-field" id="frequencyField"><input id="frequency" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${conf.frequencyHz}" aria-labelledby="frequencyLabel"><button id="frequencyToggle" class="frequency-toggle" type="button" aria-expanded="false" aria-controls="frequencyPopup" aria-label="${tr('lw.frequencyPresets')}" data-i18n-title="lw.frequencyPresets" title="${tr('lw.frequencyPresets')}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div><span class="frequency-unit" aria-hidden="true">Hz</span><div class="frequency-popup" id="frequencyPopup" hidden><div class="frequency-slider" id="frequencySlider"><div class="frequency-fill" aria-hidden="true"><canvas class="frequency-motion" id="frequencyMotion"></canvas></div><div class="frequency-ticks" id="frequencyTicks" aria-hidden="true"></div><span class="frequency-thumb" aria-hidden="true"></span><input id="frequencyPreset" type="range" min="0" max="3" step="1" value="0" aria-labelledby="frequencyLabel"></div></div></div></div>
<div class="group history-tools"><label><span data-i18n="lw.window">${tr('lw.window')}</span> <select id="timeWindow"><option value="10" data-i18n="lw.sec10">${tr('lw.sec10')}</option><option value="30" selected data-i18n="lw.sec30">${tr('lw.sec30')}</option><option value="60" data-i18n="lw.sec60">${tr('lw.sec60')}</option><option value="0" data-i18n="lw.all">${tr('lw.all')}</option><option value="custom" data-i18n="lw.windowCustom" hidden>${tr('lw.windowCustom')}</option></select></label><button id="freeze" class="ghost">${tr('lw.freeze')}</button><button id="norm" class="ghost" data-i18n="lw.normalize" data-i18n-title="lw.normalized" title="${tr('lw.normalized')}">${tr('lw.normalize')}</button><button id="clear" class="ghost" data-i18n="lw.clear">${tr('lw.clear')}</button><button id="export" class="ghost" data-i18n="lw.exportCsv" data-i18n-title="lw.exportCsvTitle" title="${tr('lw.exportCsvTitle')}">${tr('lw.exportCsv')}</button></div>
<div class="chart-settings" id="chartSettings"><button class="chart-settings-toggle" id="chartSettingsToggle" type="button" aria-expanded="false" aria-controls="chartSettingsPopup" data-i18n-title="lw.chartSettings" data-i18n-aria="lw.chartSettings" title="${tr('lw.chartSettings')}" aria-label="${tr('lw.chartSettings')}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.47 6.8L15.13 7.01L15.13 8.99L13.47 9.2L12.72 11.02L13.74 12.35L12.35 13.74L11.02 12.72L9.2 13.47L8.99 15.13L7.01 15.13L6.8 13.47L4.98 12.72L3.65 13.74L2.26 12.35L3.28 11.02L2.53 9.2L0.87 8.99L0.87 7.01L2.53 6.8L3.28 4.98L2.26 3.65L3.65 2.26L4.98 3.28L6.8 2.53L7.01 0.87L8.99 0.87L9.2 2.53L11.02 3.28L12.35 2.26L13.74 3.65L12.72 4.98Z"/><circle cx="8" cy="8" r="2.2"/></svg></button><div class="chart-settings-popup" id="chartSettingsPopup" role="group" aria-labelledby="chartSettingsToggle" hidden><label class="chart-settings-option"><span class="chart-settings-text"><span data-i18n="lw.jitterBands">${tr('lw.jitterBands')}</span><small data-i18n="lw.jitterBandsHint">${tr('lw.jitterBandsHint')}</small></span><input type="checkbox" class="switch" role="switch" id="jitterBands" checked></label></div></div><button class="lang-toggle" id="langToggle" type="button" data-i18n-title="common.langTitle" title="${tr('common.langTitle')}" aria-label="${tr('common.langTitle')}"></button></div></div><div class="elf-diagnostics" id="elfDiagnostics" role="status" hidden></div><main class="layout" id="layout"><aside class="side" id="valuePane"><div class="side-head" id="panelHandle"><strong data-i18n="lw.currentValues">${tr('lw.currentValues')}</strong><span class="badge" id="count">0</span><span id="rate">0.0kb/s | 0.0Hz</span><div class="side-actions"><button type="button" class="panel-icon" id="panelMode" aria-pressed="false" title="${tr('lw.panelFloat')}"><svg class="icon-float" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><rect class="solid" x="6.5" y="6" width="6" height="5" rx="1"/></svg><svg class="icon-dock" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path class="solid" d="M3.5 2.5h2.5v11H3.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/></svg></button><button type="button" class="panel-icon" id="panelClose" title="${tr('lw.panelClose')}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button></div></div><div class="var-list" id="vars"><div class="empty" data-i18n="lw.varListEmpty">${tr('lw.varListEmpty')}</div></div><div class="float-resize" data-edge="n"></div><div class="float-resize" data-edge="s"></div><div class="float-resize" data-edge="e"></div><div class="float-resize" data-edge="w"></div><div class="float-resize" data-edge="ne"></div><div class="float-resize" data-edge="nw"></div><div class="float-resize" data-edge="sw"></div><div class="float-resize" data-edge="se" id="panelResize" tabindex="0" aria-controls="valuePane" data-i18n-title="lw.panelResizeHint" title="${tr('lw.panelResizeHint')}"></div></aside><div class="side-splitter" id="sideSplitter" role="separator" tabindex="0" aria-controls="valuePane" aria-orientation="vertical" data-i18n-title="lw.splitterHint" title="${tr('lw.splitterHint')}"></div><section class="chart-pane"><div class="chart-head"><strong data-i18n="lw.history">${tr('lw.history')}</strong><span id="range">—</span><span class="spacer"></span><span id="points">${tr('lw.points',{n:0})}</span></div><div class="chart-wrap" id="chartWrap"><div class="chart-stage" id="chartStage"><canvas id="chart"></canvas><div class="chart-empty" id="chartEmpty" data-i18n="lw.chartEmpty">${tr('lw.chartEmpty')}</div></div><div class="chart-overview" id="chartOverview"><div class="range-timeline chart-timeline" id="chartTimeline" data-i18n-title="lw.chartTimelineHint" title="${tr('lw.chartTimelineHint')}"><div class="range-fill chart-range-fill" id="chartRangeFill"></div><div class="chart-timeline-labels"><span id="chartAxisStart">00:00</span><span id="chartAxisEnd">00:00</span></div><input type="range" id="chartFromRange" min="0" max="1" value="0" aria-label="${tr('lw.chartFrom')}"><input type="range" id="chartToRange" min="0" max="1" value="1" aria-label="${tr('lw.chartTo')}"></div></div></div></section></main>
<div class="overlay hidden" id="overlay"><div class="panel"><h3 data-i18n="lw.importTitle">${tr('lw.importTitle')}</h3><div class="import-filter"><div class="filter-wrap"><input id="impFilter" data-i18n-ph="lw.filterVars" placeholder="${tr('lw.filterVars')}"><button class="filter-clear" id="impFilterClear" type="button" data-i18n-title="lw.clearFilter" title="${tr('lw.clearFilter')}" aria-label="${tr('lw.clearFilter')}">×</button></div><button class="secondary" id="impUserOnly" type="button" data-i18n="sb.userVarsOnly" data-i18n-title="sb.userVarsOnlyTitle" title="${tr('sb.userVarsOnlyTitle')}" aria-pressed="false">${tr('sb.userVarsOnly')}</button></div>${samplingHint("impSamplingHint")}<div class="imp-meta" id="impCount"></div><div class="elf-diagnostics" id="importDiagnostics" role="status" hidden></div><div class="imp-list" id="impList"></div><div class="right"><button class="secondary" id="impCancel" data-i18n="lw.cancel">${tr('lw.cancel')}</button><button id="impAdd" data-i18n="lw.importSelected">${tr('lw.importSelected')}</button></div></div></div>
<div class="overlay hidden" id="exportOverlay"><div class="panel export-panel"><h3 data-i18n="lw.exportTitle">${tr('lw.exportTitle')}</h3><div class="export-filename"><input type="text" id="exportFileName" maxlength="180" aria-label="${tr('lw.exportFileName')}" data-i18n-aria="lw.exportFileName"><span>.csv</span></div><div class="export-series-heading"><div class="export-label" id="exportSeriesLabel" data-i18n="lw.exportSeries">${tr('lw.exportSeries')}</div><div class="export-series-actions" role="group" aria-labelledby="exportSeriesLabel"><button type="button" id="exportSelectAll" data-i18n="lw.exportSelectAll">${tr('lw.exportSelectAll')}</button><button type="button" id="exportInvert" data-i18n="lw.exportInvert">${tr('lw.exportInvert')}</button></div></div><input type="search" id="exportSearch" class="export-search" placeholder="${tr('lw.exportSearch')}" data-i18n-ph="lw.exportSearch" aria-label="${tr('lw.exportSearch')}" data-i18n-aria="lw.exportSearch"><div class="export-series" id="exportSeries"></div><div class="export-custom" id="exportCustom"><div class="export-timeline-title" data-i18n="lw.exportTimeline">${tr('lw.exportTimeline')}</div><div class="export-axis-labels"><span id="exportAxisStart">00:00</span><span id="exportAxisEnd">00:00</span></div><div class="range-timeline export-timeline"><div class="range-fill export-range-fill" id="exportRangeFill"></div><input type="range" id="exportFromRange" min="0" max="1" value="0" aria-label="${tr('lw.exportFrom')}"><input type="range" id="exportToRange" min="0" max="1" value="1" aria-label="${tr('lw.exportTo')}"></div><div class="export-selection" id="exportSelection"></div></div><div class="warn" id="exportWarn"></div><div class="right"><button class="secondary" id="exportCancel" data-i18n="lw.cancel">${tr('lw.cancel')}</button><button id="exportApply" data-i18n="lw.exportSave">${tr('lw.exportSave')}</button></div></div></div>
<script>window.__CFG__=${jsonForScript(conf)};window.__LANG__=${jsonForScript(L)};window.__I18N__=${i18nJson};window.__BUILD_CSV__=(()=>{const createSampleTimeFormatter=${createSampleTimeFormatter.toString()};return ${buildCsv.toString()};})();</script><script>
${liveWatchViewport}
</script><script>
${liveWatchRenderer}
</script></body></html>`;
}
module.exports = { getLiveWatchContent, buildCsv, csvDataRowCount };
