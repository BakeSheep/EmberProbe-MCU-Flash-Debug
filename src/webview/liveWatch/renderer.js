var api = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null,
    CFG = window.__CFG__;
var HISTORY_WINDOW_MS = 30 * 60 * 1000;
var HISTORY_MAX_POINTS = HISTORY_WINDOW_MS / 5 + 1;
var RETENTION_TRIM_CHUNK = 4096;
function retainedSampleLimit(frequencyHz, intervalMs) {
    if (!CFG.autoMaxSamples) return CFG.maxSamples;
    // Use the actual rounded clock period, including when the host omits intervalMs.
    var ms = Number(intervalMs) > 0 ? Number(intervalMs) : Math.round(1000 / Number(frequencyHz));
    ms = Math.min(10000, Math.max(5, ms || 33));
    return Math.min(HISTORY_MAX_POINTS, Math.ceil(HISTORY_WINDOW_MS / ms) + 1);
}
var MAXPTS = retainedSampleLimit(CFG.frequencyHz, CFG.intervalMs);
var remoteHistory = {
    status: null,
    liveStatus: null,
    series: [],
    snapshotId: null,
    nextId: 0,
    inFlight: null,
    pending: null,
    desiredKey: null,
    desiredViewKey: null,
    cachedKey: null,
    operation: null,
    lastRequest: -Infinity
};
function requestChartViewport(range, width) {
    if (!CFG.backendHistory || !range || !remoteHistory.status || historyClearPending) return;
    var names = watch
        .filter(function (item) {
            return !hidden[item.name] && !isCompositeItem(item);
        })
        .map(function (item) {
            return item.name;
        });
    // Automatic following advances the range without changing the user's viewport choice.
    var viewRange =
        chartState.follow && chartState.x === range && !chartState.endpointDrag
            ? [
                  "follow",
                  $("timeWindow").value,
                  chartState.startPinned,
                  $("timeWindow").value === "custom" && !chartState.startPinned ? range.max - range.min : null
              ]
            : range;
    var viewKey = JSON.stringify([
        historyRevision,
        remoteHistory.snapshotId,
        names,
        watch.map(function (item) {
            return [item.name, item.type, item.address, item.bitOffset, item.bitSize];
        }),
        viewRange,
        width
    ]);
    var key = JSON.stringify([viewKey, remoteHistory.status.revision, range]);
    remoteHistory.desiredKey = key;
    remoteHistory.desiredViewKey = viewKey;
    if (!names.length) {
        remoteHistory.pending = null;
        remoteHistory.series = [];
        remoteHistory.cachedKey = key;
        return;
    }
    if (key === remoteHistory.cachedKey) return;
    remoteHistory.pending = {
        key: key,
        viewKey: viewKey,
        range: { ...range },
        width: width,
        names: names,
        snapshotId: remoteHistory.snapshotId
    };
    dispatchChartViewport();
}
function dispatchChartViewport() {
    if (remoteHistory.inFlight || !remoteHistory.pending) return;
    var elapsed = performance.now() - remoteHistory.lastRequest;
    if (elapsed < 80) {
        dirty = true;
        return;
    }
    var request = remoteHistory.pending;
    remoteHistory.pending = null;
    request.requestId = ++remoteHistory.nextId;
    remoteHistory.inFlight = request;
    remoteHistory.lastRequest = performance.now();
    post({
        type: "chartViewport",
        names: request.names,
        range: request.range,
        width: request.width,
        snapshotId: request.snapshotId,
        requestId: request.requestId,
        historyRevision: historyRevision
    });
}
function retainedPoints(arr) {
    return arr.slice(arr.retainedStart || 0);
}
function trimHistory(arr, cutoff) {
    var start = arr.retainedStart || 0,
        limit = CFG.autoMaxSamples ? HISTORY_MAX_POINTS : MAXPTS,
        countStart = Math.max(start, arr.length - limit);
    // Release expired objects immediately; move the remaining references only once per chunk.
    // A frequency reduction must not discard high-rate samples still inside the time window.
    while (start < arr.length && (start < countStart || arr[start].t < cutoff)) {
        arr[start++] = undefined;
    }
    if (start >= RETENTION_TRIM_CHUNK || start * 2 >= arr.length) {
        arr.splice(0, start);
        start = 0;
    }
    arr.retainedStart = start;
}
var I18N = window.__I18N__ || { zh: {}, en: {} };
var LANG = window.__LANG__ === "en" ? "en" : "zh";
function t(k, p) {
    return window.EmberProbeRuntime.translate(I18N, LANG, k, p);
}
function msgText(m) {
    return m && m.key ? t(m.key, m.params) : m && m.message != null ? m.message : "";
}
var statusMsg = { key: "lw.ready" };
var requestedFrequencyHz = CFG.frequencyHz;
var unlimitedState = { available: false, enabled: false, active: false, limitedBy: null, suppressed: null };
var frequencyPresets = [20, 50, 100, 200];
var frequencyDrag = null;
var frequencyMotion = { selected: false, started: 0, lastFrame: -Infinity, image: null, still: false };
var samplingBytesPerSecond = 0;
function rateText(hz, bytesPerSecond) {
    if (Number.isFinite(bytesPerSecond)) samplingBytesPerSecond = Math.max(0, bytesPerSecond);
    var value = (Number.isFinite(hz) ? hz : 0).toFixed(1);
    return (samplingBytesPerSecond / 1000).toFixed(1) + "kb/s | " + value + "Hz";
}
function renderUnlimited(syncInput) {
    // Native pointer tracking owns the range until release; telemetry must not touch its value or bounds.
    if (frequencyDrag) return;
    var input = $("frequency"),
        slider = $("frequencyPreset"),
        field = $("frequencyField"),
        unlimited = unlimitedState.available && unlimitedState.enabled;
    if (syncInput === true || document.activeElement !== input)
        input.value = unlimited ? "-" : String(requestedFrequencyHz);
    var nearest = frequencyPresets.reduce(function (best, value, index) {
        return Math.abs(value - requestedFrequencyHz) < Math.abs(frequencyPresets[best] - requestedFrequencyHz)
            ? index
            : best;
    }, 0);
    var index = unlimited ? 4 : nearest,
        max = unlimitedState.available ? 4 : 3;
    slider.max = String(max);
    slider.value = String(index);
    slider.setAttribute("aria-valuetext", unlimited ? t("lw.unlimited") : requestedFrequencyHz + " Hz");
    var ticks = $("frequencyTicks");
    if (ticks.children.length !== max + 1) {
        ticks.replaceChildren();
        for (var i = 0; i <= max; i++) {
            var tick = document.createElement("i");
            tick.style.setProperty("--stop", String(i / max));
            ticks.appendChild(tick);
        }
    }
    Array.from(ticks.children).forEach(function (tick, i) {
        tick.title = i === 4 ? t("lw.unlimited") : frequencyPresets[i] + " Hz";
    });
    paintFrequencyPosition(index, false);
    $("frequencyToggle").setAttribute("aria-label", t("lw.frequencyPresets"));
    if (unlimited && unlimitedState.suppressed) field.title = t("lw.unlimitedSuppressed");
    else if (unlimitedState.active && unlimitedState.limitedBy)
        field.title =
            t("lw.unlimitedTitle") +
            " — " +
            t(unlimitedState.limitedBy === "host" ? "lw.unlimitedByHost" : "lw.unlimitedByProbe");
    else field.title = unlimited ? t("lw.unlimitedTitle") : "";
}
function paintFrequencyPosition(position, preview) {
    var max = unlimitedState.available ? 4 : 3;
    position = Math.round(Math.min(max, Math.max(0, position)));
    var index = Math.round(position),
        unlimited = index === 4,
        track = $("frequencySlider");
    // The visible thumb and fill share the same coordinate and animation clock.
    track.style.setProperty("--frequency-position", String(position / max));
    Array.from($("frequencyTicks").children).forEach(function (tick, i) {
        tick.classList.toggle("selected", i <= position);
    });
    track.classList.toggle("is-unlimited", unlimited);
    if (frequencyMotion.selected !== unlimited) {
        frequencyMotion.selected = unlimited;
        frequencyMotion.started = performance.now();
        frequencyMotion.lastFrame = -Infinity;
        frequencyMotion.image = null;
    }
    if (preview) {
        $("frequency").value = unlimited ? "-" : String(frequencyPresets[index]);
        $("frequencyPreset").setAttribute(
            "aria-valuetext",
            unlimited ? t("lw.unlimited") : frequencyPresets[index] + " Hz"
        );
    }
}
function drawFrequencyMotion(now) {
    if (!frequencyMotion.selected || $("frequencyPopup").hidden || document.hidden) return;
    if (now - frequencyMotion.lastFrame < 1000 / 30) return;
    var canvas = $("frequencyMotion");
    var scale = Math.min(1.5, window.devicePixelRatio || 1);
    var width = Math.min(384, Math.round(canvas.clientWidth * scale));
    var height = Math.min(64, Math.round(canvas.clientHeight * scale));
    if (!width || !height) return;
    var still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    var resized = canvas.width !== width || canvas.height !== height;
    if (frequencyMotion.image && still && frequencyMotion.still && !resized) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!frequencyMotion.image || resized) {
        canvas.width = width;
        canvas.height = height;
        frequencyMotion.image = ctx.createImageData(width, height);
    }
    window.EmberProbeSamplingRateMotion.paint(
        frequencyMotion.image.data,
        width,
        height,
        still ? 2 : (now - frequencyMotion.started) / 1000
    );
    ctx.putImageData(frequencyMotion.image, 0, 0);
    frequencyMotion.lastFrame = now;
    frequencyMotion.still = still;
}
function finishFrequencyDrag(commit) {
    if (!frequencyDrag) return;
    var position = frequencyDrag.position;
    frequencyDrag = null;
    $("frequencySlider").classList.remove("is-dragging");
    if (commit) {
        $("frequencyPreset").value = String(Math.round(position));
        selectFrequencyPreset();
    } else renderUnlimited(true);
}
function positionFrequencyPopup() {
    var popup = $("frequencyPopup");
    popup.style.removeProperty("transform");
    var rect = popup.getBoundingClientRect();
    var shift = Math.max(8 - rect.left, Math.min(0, window.innerWidth - 8 - rect.right));
    if (shift) popup.style.transform = "translateX(" + shift + "px)";
}
function setFrequencyPopup(open, focusSlider) {
    $("frequencyPopup").hidden = !open;
    if (!open) finishFrequencyDrag(false);
    $("frequencyToggle").setAttribute("aria-expanded", String(open));
    if (open) positionFrequencyPopup();
    if (open && focusSlider) $("frequencyPreset").focus();
}
function selectFrequencyPreset() {
    var index = Math.round(Number($("frequencyPreset").value));
    if (!Number.isInteger(index) || index < 0 || index > (unlimitedState.available ? 4 : 3)) return;
    if (index === 4) {
        if (!unlimitedState.enabled) {
            sampleTimes = [];
            unlimitedState.enabled = true;
            post({ type: "setUnlimitedSampling", enabled: true });
        }
        renderUnlimited(true);
    } else commitFrequency(frequencyPresets[index]);
}
function commitFrequency(value) {
    if (unlimitedState.enabled || value !== requestedFrequencyHz) sampleTimes = [];
    if (unlimitedState.enabled) {
        unlimitedState.enabled = false;
        unlimitedState.active = false;
        post({ type: "setUnlimitedSampling", enabled: false });
    }
    requestedFrequencyHz = value;
    renderUnlimited(true);
    post({ type: "setFrequency", frequencyHz: requestedFrequencyHz });
}
function applyUnlimitedStatus(m) {
    if (typeof m.unlimitedActive === "boolean") unlimitedState.active = m.unlimitedActive;
    if (m.limitedBy !== undefined) unlimitedState.limitedBy = m.limitedBy;
    if (m.unlimitedSuppressedReason !== undefined) unlimitedState.suppressed = m.unlimitedSuppressedReason;
    renderUnlimited();
}
function selectedFrequencyHz() {
    var value = Number($("frequency").value);
    if (!Number.isFinite(value) || value <= 0) value = requestedFrequencyHz;
    return Math.min(200, Math.max(0.1, Math.round(value * 10) / 10));
}
var TYPES = window.EmberProbeRuntime.SUPPORTED_TYPES,
    Styles = window.EmberProbeSeriesStyles,
    Analysis = window.EmberProbeAnalysisState,
    Inspection = window.EmberProbeChartInspection,
    seriesStyles = Object.create(null),
    styleRequests = new Set(),
    analysis = Analysis.create(),
    dataRevision = 0,
    seriesCache = null,
    boundsCache = null,
    axisModes = {},
    controls;
var watch = [],
    data = Object.create(null),
    latest = Object.create(null),
    latestText = Object.create(null),
    latestEnum = Object.create(null),
    latestPointer = Object.create(null),
    // Last sampled pointer targets by watch path; restored with the view so a reopened panel still names them.
    // They belong to the ELF version they were sampled from and are shown only while it is loaded.
    lastPointers = Object.create(null),
    lastPointersVersion = "",
    valueCells = Object.create(null),
    hidden = Object.create(null),
    expanded = Object.create(null),
    rawMembers = Object.create(null),
    compCells = Object.create(null),
    dispSpec = Object.create(null),
    running = false,
    starting = false,
    frozen = false,
    norm = false,
    allSymbols = [],
    sampleTimes = [],
    samplingOrigin = null,
    dirty = true,
    lastDraw = 0,
    runtimeBodies = Object.create(null),
    // Expanded pointee entries rendered inside their pointer rows / as stand-alone cards.
    placedPointees = new Set(),
    fallbackPointees = new Set();
var MAX_ARR_SHOWN = 16;
var wantImportOpen = false,
    impVersion = "",
    impGeneration = null,
    impWarnings = [],
    impError = "",
    impTypesReady = true,
    impExpanded = Object.create(null),
    impLayoutPending = new Set(),
    // Scalar pointer symbols whose runtime type graph was requested to offer expansion.
    pointerLayoutWaiters = new Set(),
    impSymbolByName = new Map(),
    impIndexByName = new Map(),
    impTypeChunks = 0,
    impSearchTimer = null,
    impSearchQuery = "";
var PANEL_MARGIN = 8,
    PANEL_MIN_WIDTH = 220,
    PANEL_MIN_HEIGHT = 120,
    PANEL_COLUMNS_WIDTH = 480;
// Saved card geometry, or a default top-left card that keeps the former side panel width.
function savedValuePanel(state) {
    var p = state && state.valuePanel;
    if (p && ["x", "y", "w"].every((key) => Number.isFinite(p[key])) && (p.h === null || Number.isFinite(p.h)))
        return { x: p.x, y: p.y, w: p.w, h: p.h, dockRight: p.dockRight === true, dockBottom: p.dockBottom === true };
    var width = state && Number(state.sideWidth);
    return { x: 12, y: 40, w: width > 0 ? width : 300, h: null, dockRight: false, dockBottom: false };
}
var saved = api && api.getState ? api.getState() : null,
    valuePanel = savedValuePanel(saved),
    sideCollapsed = !!(saved && saved.sideCollapsed),
    windowPreset = saved && saved.timeWindow && saved.timeWindow !== "custom" ? String(saved.timeWindow) : "30";
if (saved && saved.hidden) hidden = saved.hidden;
if (saved && typeof saved.norm === "boolean") norm = saved.norm;
if (saved && saved.expanded) expanded = saved.expanded;
if (saved && saved.rawMembers) rawMembers = saved.rawMembers;
if (saved && saved.dispSpec) dispSpec = saved.dispSpec;
// State saved before pointer curves defaulted to hidden lacks the marker written by saveUi.
var legacyPointerCurves = !!(saved && saved.hidden) && !saved.pointerCurveDefaults;
if (saved && saved.lastPointers && saved.lastPointersVersion) {
    lastPointers = saved.lastPointers;
    lastPointersVersion = String(saved.lastPointersVersion);
}
var impHead = document.createElement("div");
impHead.className = "imp-head";
impHead.setAttribute("aria-hidden", "true");
["", "common.variable", "common.type", "common.address", "common.size"].forEach(function (key) {
    var cell = document.createElement("span");
    if (key) {
        cell.setAttribute("data-i18n", key);
        cell.textContent = t(key);
    }
    impHead.appendChild(cell);
});
$("impList").parentNode.insertBefore(impHead, $("impList"));
function $(id) {
    return document.getElementById(id);
}
function colorFor(i) {
    return styleFor(typeof i === "string" ? i : watch[i]?.name || String(i)).color;
}
function styleFor(name) {
    if (!Object.prototype.hasOwnProperty.call(seriesStyles, name)) {
        Styles.ensure(seriesStyles, name);
        if (!styleRequests.has(name)) {
            styleRequests.add(name);
            post({ type: "setSeriesStyle", name: name });
        }
    }
    return seriesStyles[name];
}
function plotBuffers() {
    return analysis.snapshot || data;
}
function invalidateSeries() {
    dataRevision++;
    seriesCache = null;
    boundsCache = null;
}
function toggleCurve(name) {
    analysis.previousHidden = null;
    analysis.focused = null;
    hidden[name] = !hidden[name];
    saveUi();
    renderVars();
    dirty = true;
}
function fmtAddr(a) {
    return "0x" + (Number(a) >>> 0).toString(16).toUpperCase();
}
function fmtNum(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    v = Number(v);
    if (Number.isInteger(v)) return String(v);
    var a = Math.abs(v);
    return a !== 0 && (a >= 1e7 || a < 1e-4) ? v.toExponential(4) : String(Number(v.toFixed(5)));
}
function fmtExact(v, valueText, enumText) {
    if (enumText) return String(enumText);
    return valueText !== null && valueText !== undefined ? String(valueText) : fmtNum(v);
}
function setDisplayedValue(cell, value) {
    EmberProbeRuntime.setValueCell(cell, value);
}
var buildCsv = window.__BUILD_CSV__;
var historyRevision = 0,
    historyClearPending = false;
function defType(size) {
    return window.EmberProbeRuntime.defaultType(size);
}
function layoutSymbol(path) {
    const name = EmberProbeRuntime.variableBaseName(path);
    const symbol = impSymbolByName.get(name);
    return symbol?.compositeLayout ? symbol : watch.find((item) => item.name === name) || symbol;
}
const layoutExpansionUi = EmberProbeRuntime.createLayoutExpansionUi({
    post,
    version: () => impVersion,
    generation: () => impGeneration,
    symbol: layoutSymbol,
    changed: () => {
        for (const item of watch) {
            const symbol = impSymbolByName.get(item.name);
            if (
                symbol?.compositeLayout &&
                symbol.compositeLayout.expansionGeneration === item.compositeLayout?.expansionGeneration
            ) {
                item.layoutExpansions = symbol?.layoutExpansions;
                item.layoutExpansionGeneration = symbol?.layoutExpansionGeneration;
            }
        }
        if (!$("overlay").classList.contains("hidden")) renderImport();
        renderVars();
    }
});
function showRawFor(path) {
    return !!rawMembers[baseNameOf(path)];
}
function renderRawMembersUi(container, node, name) {
    const base = baseNameOf(name);
    EmberProbeRuntime.renderMemberVisibility(container, node, name, showRawFor(name), t, function () {
        rawMembers[base] = !showRawFor(name);
        saveUi();
        renderVars();
        if (!$("overlay").classList.contains("hidden")) renderImport();
    });
}
function fmtDisplayNode(node) {
    if (node?.functionEmpty) return t("lw.functionEmpty");
    if (node?.isPointer) return EmberProbeRuntime.pointerLabel(node, t);
    return node ? fmtExact(node.value, node.valueText, node.enumText) : "—";
}
// Pointer metadata for a scalar watch; the layout walk runs once per render, not per refresh.
var displayInfos = new WeakMap();
function watchDisplayInfo(item) {
    if (!displayInfos.has(item)) displayInfos.set(item, resolveWatchDisplayInfo(item));
    return displayInfos.get(item);
}
function resolveWatchDisplayInfo(item) {
    if (item.isPointer) return item;
    const direct = impSymbolByName.get(item.name);
    if (direct?.isPointer) return direct;
    const symbol = layoutSymbol(item.name);
    return (
        EmberProbeRuntime.displayLayoutLeaves(symbol, symbol?.compositeLayout, baseNameOf(item.name), symbol?.address, {
            showRaw: true,
            includePointers: true
        }).find((leaf) => leaf.path === item.name) || item
    );
}
function scalarDisplay(item) {
    const info = watchDisplayInfo(item);
    // Before the first sample a pointer shows the target it had when last sampled.
    const last = info.isPointer && latest[item.name] === undefined && shownLastPointers()[item.name];
    if (last) return fmtDisplayNode({ ...info, ...last, stale: true });
    return fmtDisplayNode({
        ...info,
        ...latestPointer[item.name],
        value: latest[item.name],
        valueText: latestText[item.name],
        enumText: latestEnum[item.name]
    });
}
function post(m) {
    if (api) {
        m.panelId = CFG.panelId;
        api.postMessage(m);
    }
}
function saveWatch() {
    post({ type: "saveWatch", items: watch });
}
// The host keeps each chart's curve visibility so a panel reopened after a restart restores it.
// Nothing is sent before the host's copy arrives, so a fresh view cannot overwrite it.
var curveVisibilityLoaded = false,
    sentCurveVisibility = null;
function saveUi() {
    var curves = analysis.previousHidden || hidden;
    if (curveVisibilityLoaded) {
        var key = JSON.stringify(curves);
        if (key !== sentCurveVisibility) {
            sentCurveVisibility = key;
            post({ type: "saveCurveVisibility", hidden: curves });
        }
    }
    if (api && api.setState)
        api.setState({
            panelId: CFG.panelId,
            hidden: curves,
            expanded: expanded,
            rawMembers: rawMembers,
            dispSpec: dispSpec,
            lastPointers: lastPointers,
            lastPointersVersion: lastPointersVersion,
            pointerCurveDefaults: true,
            timeWindow: windowPreset,
            valuePanel: valuePanel,
            sideCollapsed: sideCollapsed,
            norm: norm
        });
}
var pointerSaveTimer = null;
// Snapshots sampled from another ELF never name targets in the loaded one.
function shownLastPointers() {
    return impVersion && lastPointersVersion === impVersion ? lastPointers : Object.create(null);
}
function resetLastPointers(version) {
    lastPointers = Object.create(null);
    lastPointersVersion = version || "";
}
function rememberPointers(entries) {
    if (!impVersion) return;
    var changed = false;
    if (lastPointersVersion !== impVersion) {
        resetLastPointers(impVersion);
        changed = true;
    }
    Object.keys(entries).forEach(function (path) {
        var next = entries[path];
        if (JSON.stringify(lastPointers[path]) !== JSON.stringify(next)) {
            lastPointers[path] = next;
            changed = true;
        }
    });
    if (!changed || pointerSaveTimer !== null) return;
    pointerSaveTimer = setTimeout(function () {
        pointerSaveTimer = null;
        saveUi();
    }, 2000);
}
function forgetPointers(name) {
    Object.keys(lastPointers).forEach(function (path) {
        if (path === name || path.startsWith(name + ".") || path.startsWith(name + "[")) delete lastPointers[path];
    });
}
// Pointer curves carry little information; they start hidden unless the user switched them on.
function hidePointerCurve(item) {
    if (item && item.isPointer && hidden[item.name] === undefined) hidden[item.name] = true;
}
function ensureBuf(n) {
    if (!Object.prototype.hasOwnProperty.call(data, n)) data[n] = [];
}
function renderStatus() {
    var txt = statusMsg.key ? t(statusMsg.key, statusMsg.params) : statusMsg.message != null ? statusMsg.message : "";
    $("status").textContent = txt;
    $("dot").className = "status-dot " + (statusMsg.kind === "error" ? "err" : running ? "on" : "");
    $("dot").title = txt;
    $("dot").setAttribute("aria-label", txt);
}
function setStatusKey(key, params, kind) {
    statusMsg = { key: key, params: params, kind: kind || "" };
    renderStatus();
}
function setStatusMsg(m, kind) {
    statusMsg = { key: m && m.key, params: m && m.params, message: m && m.message, kind: kind || "" };
    renderStatus();
}
function applyI18n() {
    var i, els;
    els = document.querySelectorAll("[data-i18n]");
    for (i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute("data-i18n"));
    els = document.querySelectorAll("[data-i18n-title]");
    for (i = 0; i < els.length; i++) els[i].title = t(els[i].getAttribute("data-i18n-title"));
    els = document.querySelectorAll("[data-i18n-ph]");
    for (i = 0; i < els.length; i++) els[i].placeholder = t(els[i].getAttribute("data-i18n-ph"));
    renderUnlimited();
}
function updateLangToggle() {
    var b = $("langToggle");
    if (b) {
        b.textContent = LANG === "zh" ? "EN" : "中";
        b.title = t("common.langTitle");
        b.setAttribute("aria-label", t("common.langTitle"));
    }
}
function rerenderLive() {
    applyI18n();
    renderElfDiagnostics();
    renderVars();
    if (!$("overlay").classList.contains("hidden")) renderImport();
    if ($("acDrop").classList.contains("open")) renderAutocomplete(ambiguityChoices);
    updateRun();
    applySideLayout();
    $("freeze").textContent = frozen ? t("lw.resume") : t("lw.freeze");
    renderStatus();
    updateLangToggle();
    dirty = true;
}
function setLang(l, notify) {
    LANG = l === "en" ? "en" : "zh";
    document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
    rerenderLive();
    if (notify) post({ type: "setLang", lang: LANG });
}
function updateRun() {
    var b = $("run");
    b.disabled = starting;
    b.textContent = starting ? t("lw.starting") : running ? t("lw.stopSampling") : t("lw.startSampling");
}
function displayNameFor(item) {
    return EmberProbeRuntime.variableDisplayName(item, {
        get: function (name) {
            var symbol = impSymbolByName.get(name);
            if (symbol && symbol.displayName && symbol.displayName !== symbol.name) return symbol;
            return (
                watch.find(function (entry) {
                    return entry.name === name;
                }) || symbol
            );
        }
    });
}
function curveDisplayName(name) {
    return displayNameFor(
        watch.find(function (item) {
            return item.name === name;
        }) || { name: name }
    );
}
function addSymbol(sym, resolved = false) {
    if (
        !sym ||
        !sym.name ||
        watch.some(function (w) {
            return w.name === sym.name;
        })
    )
        return;
    if (
        !resolved &&
        impVersion &&
        (!impTypesReady || (sym.isComposite && !sym.compositeLayout && !sym.runtimeLayout))
    ) {
        post({ type: "resolveVariable", name: sym.name, version: impVersion });
        return;
    }
    if (sym.isComposite) {
        if (!sym.compositeLayout && !sym.runtimeLayout) {
            setStatusMsg({ message: sym.unsupportedReason || t("lw.compositeNoLayout") }, "error");
            return;
        }
        var lay = sym.compositeLayout;
        var addComp = function (disp) {
            if (disp) dispSpec[sym.name] = disp;
            else delete dispSpec[sym.name];
            watch.push({
                name: sym.name,
                displayName: displayNameFor(sym),
                address: Number(sym.address) || 0,
                size: Number(sym.size) || 4,
                type: "",
                isComposite: true,
                compositeLayout: sym.compositeLayout || null,
                ...(sym.runtimeSegments ? { runtimeSegments: sym.runtimeSegments } : {}),
                ...(sym.runtimeStaticPointers ? { runtimeStaticPointers: true } : {}),
                ...(sym.derefPath ? { derefPath: true, typeName: sym.typeName } : {}),
                ...(EmberProbeRuntime.runtimeGraph(sym) ? { runtimeLayout: EmberProbeRuntime.runtimeGraph(sym) } : {})
            });
            expanded[sym.name] = true;
            renderVars();
            saveWatch();
            saveUi();
            dirty = true;
        };
        if (lay?.kind === "array" && (Number(lay.totalElements) || 0) > MAX_ARR_SHOWN)
            showArraySelectDialog(sym, addComp);
        else addComp(null);
        return;
    }
    watch.push({
        name: sym.name,
        displayName: displayNameFor(sym),
        address: Number(sym.address) || 0,
        size: Number(sym.size) || 4,
        type: sym.type || sym.watchType || defType(sym.size || 4),
        ...(sym.isPointer ? { isPointer: true, typeName: sym.typeName, pointerTarget: sym.pointerTarget } : {}),
        ...(EmberProbeRuntime.runtimeGraph(sym)
            ? {
                  runtimeLayout: EmberProbeRuntime.runtimeGraph(sym),
                  runtimeSegments: sym.runtimeSegments || [],
                  ...(sym.runtimeStaticPointers ? { runtimeStaticPointers: true } : {}),
                  ...(sym.derefPath ? { derefPath: true, typeName: sym.typeName } : {})
              }
            : {})
    });
    ensureBuf(sym.name);
    hidePointerCurve(sym);
    renderVars();
    saveWatch();
    saveUi();
    dirty = true;
}
function removeVar(name) {
    var rmv = watch.filter(function (w) {
        return w.name === name || baseNameOf(w.name) === name || EmberProbeRuntime.isPointeeDescendant(w, name);
    });
    watch = watch.filter(function (w) {
        return rmv.indexOf(w) < 0;
    });
    if (
        rmv.some(function (w) {
            return w.name === analysis.focused;
        })
    )
        hidden = Analysis.restore(
            analysis,
            watch.map(function (w) {
                return w.name;
            })
        );
    Analysis.remove(
        analysis,
        rmv.map(function (w) {
            return w.name;
        })
    );
    invalidateSeries();
    rmv.forEach(function (w) {
        delete data[w.name];
        delete latest[w.name];
        delete latestText[w.name];
        delete latestEnum[w.name];
        delete latestPointer[w.name];
        delete hidden[w.name];
    });
    Object.keys(expanded).forEach(function (path) {
        if (path === name || path.startsWith(name + ".") || path.startsWith(name + "[")) delete expanded[path];
    });
    delete dispSpec[name];
    delete rawMembers[name];
    forgetPointers(name);
    renderVars();
    saveWatch();
    saveUi();
    dirty = true;
}
function createCurveToggle(swatch, content, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "curve-toggle";
    button.title = swatch.title;
    button.setAttribute("aria-label", swatch.getAttribute("aria-label") || content.title + ": " + swatch.title);
    button.setAttribute(
        "aria-pressed",
        swatch.getAttribute("aria-pressed") || String(!swatch.classList.contains("off"))
    );
    swatch.setAttribute("aria-hidden", "true");
    button.onclick = function (event) {
        event.stopPropagation();
        onClick();
    };
    button.append(swatch, content);
    return button;
}
function renderVars() {
    displayInfos = new WeakMap();
    invalidateSeries();
    dirty = true;
    if (analysis.focused)
        watch.forEach(function (w) {
            hidden[w.name] = w.name !== analysis.focused;
        });
    var box = $("vars");
    box.textContent = "";
    variableCards = [];
    box.classList.remove("independent-columns");
    valueCells = Object.create(null);
    compCells = Object.create(null);
    runtimeBodies = Object.create(null);
    placedPointees = new Set();
    fallbackPointees = new Set();
    // Expanded pointees render inside their pointer rows while cards are built.
    const topLevel = watch.filter((item) => !EmberProbeRuntime.isPointeeEntry(item));
    const cards = new Map();
    topLevel.filter(isCompositeItem).forEach(function (item) {
        const holder = document.createElement("div");
        renderCompositeCard(item, watch.indexOf(item), holder);
        cards.set(item.name, [...holder.childNodes]);
    });
    topLevel.forEach(function (item) {
        if (!isCompositeItem(item) && !isLeafChild(item.name)) cards.set(item.name, renderScalarCard(item));
    });
    if (!watch.length) {
        $("count").textContent = "0";
        var empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("lw.varListEmpty");
        box.appendChild(empty);
        return;
    }
    topLevel.forEach((item) => box.append(...(cards.get(item.name) || [])));
    // Pointees whose pointer row is not shown (typed paths, older saved lists) stay cards; parents first.
    watch
        .filter(EmberProbeRuntime.isPointeeEntry)
        .sort((a, b) => a.name.length - b.name.length)
        .forEach(function (item) {
            if (placedPointees.has(item.name)) return;
            fallbackPointees.add(item.name);
            if (isCompositeItem(item)) renderCompositeCard(item, watch.indexOf(item), box);
            else box.append(...renderScalarCard(item));
        });
    // A member card drawn before its pointee tree was rendered is shown by that tree instead.
    cards.forEach(function (nodes, name) {
        const item = watch.find((w) => w.name === name);
        if (!item || isCompositeItem(item) || !isLeafChild(name)) return;
        nodes.forEach((node) => node.remove());
        if (valueCells[name]?.isConnected === false) delete valueCells[name];
    });
    $("count").textContent = String(
        watch.filter(function (it) {
            return !isLeafChild(it.name) && !placedPointees.has(it.name);
        }).length
    );
    variableCards = Array.from(box.children);
    arrangeVariableCards(true);
}
var variableCards = [];
function arrangeVariableCards(force) {
    if (!variableCards.length) return;
    var box = $("vars");
    // A collapsed card has no width; keep its columns until it is shown again.
    var columns = sideCollapsed
        ? box.classList.contains("independent-columns")
        : $("valuePane").getBoundingClientRect().width >= PANEL_COLUMNS_WIDTH;
    if (!force && columns === box.classList.contains("independent-columns")) return;
    var focused = document.activeElement;
    var scrollTop = box.scrollTop;
    if (columns) {
        var stacks = [document.createElement("div"), document.createElement("div")];
        stacks.forEach(function (stack) {
            stack.className = "var-column";
        });
        // Stable alternating columns: expanding a tree never moves cards in the other column.
        variableCards.forEach(function (card, index) {
            stacks[index % 2].appendChild(card);
        });
        box.replaceChildren(...stacks);
    } else {
        // Restore watch order, DOM focus order and the original nodes when the card is narrow.
        box.replaceChildren(...variableCards);
    }
    box.classList.toggle("independent-columns", columns);
    if (focused && focused !== document.activeElement && box.contains(focused)) focused.focus({ preventScroll: true });
    box.scrollTop = scrollTop;
}
function renderScalarCard(item) {
    var idx = watch.indexOf(item);
    var card = document.createElement("div");
    card.className = "var-card";
    var sw = document.createElement("span");
    sw.className = "swatch" + (hidden[item.name] ? " off" : "");
    sw.style.background = colorFor(idx);
    sw.title = hidden[item.name] ? t("lw.showCurve") : t("lw.hideCurve");
    var main = document.createElement("span");
    main.className = "var-main";
    var name = document.createElement("span");
    name.className = "var-name";
    EmberProbeRuntime.renderVariableName(name, displayNameFor(item), item.name);
    name.title += " \u00b7 " + fmtAddr(item.address);
    var val = document.createElement("div");
    val.className = "var-value";
    val.addEventListener("click", function (event) {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: EmberProbeRuntime.copyValueText(val) });
    });
    valueCells[item.name] = val;
    main.append(name);
    const info = watchDisplayInfo(item);
    if (info.isPointer) {
        const type = document.createElement("span");
        type.className = "member-type";
        type.textContent = info.typeName || item.type;
        type.title = type.textContent;
        main.appendChild(type);
    }
    if (controls) controls.decorate(card, item.name, sw);
    var rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = t("lw.removeVar");
    rm.setAttribute("aria-label", t("lw.removeVarName", { name: displayNameFor(item) }));
    rm.onclick = function () {
        removeVar(item.name);
    };
    var toggle = createCurveToggle(sw, main, function () {
        toggleCurve(item.name);
    });
    card.append(toggle, val, rm);
    // The pointee is part of the variable's card, on a grid row below its value.
    const host = info.isPointer && pointerPointee(card, item.name, displayNameFor(item), info);
    if (host) card.appendChild(host);
    setDisplayedValue(val, scalarDisplay(item));
    return [card];
}
function updateValues() {
    const items = new Map(watch.map((entry) => [entry.name, entry]));
    Object.keys(valueCells).forEach(function (n) {
        const item = items.get(n);
        if (item) setDisplayedValue(valueCells[n], scalarDisplay(item));
    });
    watch.forEach(function (it) {
        if (isCompositeItem(it)) updateCompositeValues(it.name);
    });
}
var valueRefreshTimer = null;
var lastValueRefresh = 0;
function scheduleValueRefresh() {
    if (valueRefreshTimer !== null) return;
    var interval = CFG.backendHistory ? 50 : 100;
    var elapsed = Date.now() - lastValueRefresh;
    if (elapsed >= interval) {
        lastValueRefresh = Date.now();
        updateValues();
        return;
    }
    valueRefreshTimer = setTimeout(function () {
        valueRefreshTimer = null;
        lastValueRefresh = Date.now();
        updateValues();
    }, interval - elapsed);
}
function onSamples(samples) {
    if (historyClearPending) return;
    if (!frozen) invalidateSeries();
    var now = Date.now();
    // Measure acquisition timestamps, not delayed Webview message delivery.
    var tick =
        (samples || []).reduce(function (last, sample) {
            return Number.isFinite(sample.t) ? Math.max(last, sample.t) : last;
        }, 0) || now;
    (samples || []).forEach(function (s) {
        var st = Number(s.t);
        if (Number.isFinite(st) && (!sampleTimes.length || st > sampleTimes[sampleTimes.length - 1])) {
            sampleTimes.push(st);
        }
    });
    var expiredTicks = 0;
    while (expiredTicks < sampleTimes.length - 1 && sampleTimes[expiredTicks] < tick - 3000) expiredTicks++;
    if (expiredTicks) sampleTimes.splice(0, expiredTicks);
    var elapsed = sampleTimes.length > 1 ? tick - sampleTimes[0] : 0;
    $("rate").textContent = rateText(elapsed > 0 ? ((sampleTimes.length - 1) * 1000) / elapsed : 0);
    (samples || []).forEach(function (s) {
        var time = Number(s.t) || now;
        if (samplingOrigin === null) samplingOrigin = time;
        latest[s.name] = s.value;
        latestText[s.name] = s.diagnostic?.code === "LIVE_NULL_POINTER" ? t("lw.pointeeNull") : (s.valueText ?? null);
        latestEnum[s.name] = s.enumText ?? null;
        recordPointerSample(s);
        // Preserve failed samples as breaks rather than drawing across a gap.
        ensureBuf(s.name);
        var arr = data[s.name];
        arr.push({ t: time, v: s.value == null ? null : Number(s.value), valueText: s.valueText ?? null });
        trimHistory(arr, time - HISTORY_WINDOW_MS);
    });
    Object.keys(data).forEach(function (name) {
        // Also expire a channel that stopped producing samples while other channels keep running.
        trimHistory(data[name], tick - HISTORY_WINDOW_MS);
    });
    scheduleValueRefresh();
    dirty = true;
}
function recordPointerSample(s) {
    latestPointer[s.name] = {
        ...(s.isPointer || s.pointerText ? { isPointer: true } : {}),
        pointerText: s.pointerText,
        pointerInfo: s.pointerInfo,
        pointerString: s.pointerString
    };
    if ((s.isPointer || s.pointerText) && s.value != null && !s.diagnostic)
        rememberPointers({
            [s.name]: {
                value: s.value,
                ...(s.valueText != null ? { valueText: s.valueText } : {}),
                ...(s.pointerText ? { pointerText: s.pointerText } : {}),
                ...(s.pointerInfo ? { pointerInfo: s.pointerInfo } : {}),
                ...(s.pointerString ? { pointerString: s.pointerString } : {})
            }
        });
}
function isCompositeItem(it) {
    return !!(it && it.isComposite && (it.compositeLayout || it.runtimeLayout));
}
function defW(ty) {
    return ty === "u8" || ty === "i8"
        ? 1
        : ty === "u16" || ty === "i16"
          ? 2
          : ty === "u64" || ty === "i64" || ty === "f64"
            ? 8
            : 4;
}
function walkTreeLeaves(node, path, cb) {
    if (!node) return;
    cb(path, node);
    for (const member of node.members || [])
        walkTreeLeaves(member, EmberProbeRuntime.layoutMemberPath(path, member), cb);
    for (const element of node.elements || []) walkTreeLeaves(element, path + "[" + element.index + "]", cb);
}
function updateCompositeValues(name) {
    var tree = latest[name];
    if (!tree) return;
    const nodes = new Map();
    walkTreeLeaves(tree, name, (path, node) => nodes.set(path, node));
    nodes.forEach(function (node, path) {
        const cell = compCells[path];
        if (!cell) return;
        const summary = cell.summaryPath && EmberProbeRuntime.summaryRow(nodes.get(cell.summaryPath), cell.summaryPath);
        setDisplayedValue(
            cell,
            fmtDisplayNode({
                ...cell.displayNode,
                ...node,
                ...(summary ? { functionEmpty: summary.empty } : {})
            })
        );
    });
}
// Pointer rows expand in place. A pointee already present in the sampled tree toggles
// locally; otherwise opening adds the read-only `<path>.value` watch, nested here.
function pointerPointee(row, path, label, node, renderInline) {
    const host = document.createElement("div");
    if (renderInline) {
        const toggle = EmberProbeRuntime.renderPointerToggle(row, path, !!expanded[path], t, function () {
            expanded[path] = !expanded[path];
            host.classList.toggle("open", expanded[path]);
            toggle.classList.toggle("open", expanded[path]);
            toggle.setAttribute("aria-expanded", String(expanded[path]));
            saveUi();
        });
        host.className = "pointer-pointee" + (expanded[path] ? " open" : "");
        renderInline(host);
        return host;
    }
    row.classList.add("pointer-row");
    const entry = node?.isPointer && EmberProbeRuntime.pointerDerefEntry(path, pointerSymbol(path));
    if (!entry) return null;
    const item = watch.find((w) => w.name === entry.name);
    EmberProbeRuntime.renderPointerToggle(row, path, !!item, t, function () {
        togglePointee(entry);
    });
    if (!item) return null;
    host.className = "pointer-pointee open";
    renderPointee(host, item, label);
    return host;
}
// Expansion needs the base symbol's runtime type graph. Composite watches load it with their
// layout; a scalar pointer variable requests it once here and re-renders when it arrives.
function pointerSymbol(path) {
    const symbol = impSymbolByName.get(baseNameOf(path));
    if (EmberProbeRuntime.runtimeGraph(symbol)) return symbol;
    const fallback = layoutSymbol(path);
    if (
        !EmberProbeRuntime.runtimeGraph(fallback) &&
        symbol?.hasRuntimeLayout &&
        !symbol.layoutError &&
        impVersion &&
        !impLayoutPending.has(symbol.name)
    ) {
        impLayoutPending.add(symbol.name);
        pointerLayoutWaiters.add(symbol.name);
        post({ type: "resolveCompositeLayout", name: symbol.name, version: impVersion });
    }
    return fallback;
}
function togglePointee(entry) {
    if (watch.some((item) => item.name === entry.name)) {
        removeVar(entry.name);
        return;
    }
    // Expanding inspects the target; a scalar target joins the chart only when its swatch is enabled.
    if (!entry.isComposite) hidden[entry.name] = true;
    addSymbol(entry, true);
    saveUi();
}
function renderPointee(host, item, label) {
    placedPointees.add(item.name);
    if (isCompositeItem(item)) {
        runtimeBodies[item.name] = host;
        renderRuntimeBody(host, latest[item.name], item.name);
        return;
    }
    // A scalar target (`int *`, `char *` string preview, pointer to pointer) is one chart row.
    const idx = watch.indexOf(item);
    const row = document.createElement("div");
    row.className = "member-row";
    row.dataset.path = item.name;
    const sw = document.createElement("span");
    sw.className = "member-swatch" + (hidden[item.name] ? " off" : "");
    sw.style.background = colorFor(idx);
    sw.title = t(hidden[item.name] ? "lw.showCurve" : "lw.hideCurve");
    if (controls) controls.decorate(row, item.name, sw);
    const nm = document.createElement("span");
    nm.className = "member-name";
    nm.textContent = "*" + EmberProbeRuntime.shortVariableName(label).replace(/^\./, "");
    nm.title = displayNameFor(item);
    nm.setAttribute("aria-label", nm.title);
    const ty = document.createElement("span");
    ty.className = "member-type";
    ty.textContent = item.typeName || item.type || "";
    ty.title = ty.textContent;
    const val = document.createElement("span");
    val.className = "member-value";
    val.addEventListener("click", function (event) {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: EmberProbeRuntime.copyValueText(val) });
    });
    valueCells[item.name] = val;
    const toggle = createCurveToggle(sw, nm, function () {
        toggleCurve(item.name);
    });
    row.append(toggle, ty, val);
    host.appendChild(row);
    const nested = pointerPointee(row, item.name, nm.textContent, watchDisplayInfo(item));
    if (nested) host.appendChild(nested);
    setDisplayedValue(val, scalarDisplay(item));
}
function renderLeafInto(container, label, typeName, path, watchType, address, node, renderInline) {
    var row = document.createElement("div");
    row.className = "member-row";
    var wi = watch.findIndex(function (w) {
        return w.name === path;
    });
    var sw = document.createElement("span");
    sw.className = "member-swatch" + (wi < 0 || hidden[path] ? " off" : "");
    if (wi >= 0) sw.style.background = colorFor(wi);
    sw.title = wi >= 0 ? t(hidden[path] ? "lw.showCurve" : "lw.hideCurve") : t("lw.addToChart");
    if (controls && wi >= 0) controls.decorate(row, path, sw);
    var nm = document.createElement("span");
    nm.className = "member-name";
    nm.textContent = label;
    nm.title = node?.displayPath ? displayNameFor({ name: node.displayPath }) : curveDisplayName(path);
    nm.setAttribute("aria-label", nm.title);
    var val = document.createElement("span");
    val.className = "member-value";
    val.displayNode = node;
    val.summaryPath = node?.summaryPath;
    val.addEventListener("click", function (event) {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: EmberProbeRuntime.copyValueText(val) });
    });
    compCells[path] = val;
    var toggle = createCurveToggle(sw, nm, function () {
        // A placeholder row has no address yet: it can be added once samples arrive, but a curve
        // already in the chart can be switched off right away.
        if (
            !node?.placeholder ||
            watch.some(function (w) {
                return w.name === path;
            })
        )
            toggleLeafInChart(path, address, watchType, node);
    });
    const ty = document.createElement("span");
    ty.className = "member-type";
    ty.textContent = typeName || watchType || "";
    ty.title = ty.textContent;
    row.dataset.path = path;
    row.append(toggle, ty, val);
    container.appendChild(row);
    const host = node?.isPointer && pointerPointee(row, path, label, node, renderInline);
    if (host) container.appendChild(host);
    setDisplayedValue(val, fmtDisplayNode(withLastPointer(node, path)));
}
// A static layout row has no value until sampled; a pointer in it shows its last known target.
function withLastPointer(node, path) {
    const last = node?.isPointer && node.value == null && !node.stale && shownLastPointers()[path];
    return last && latest[baseNameOf(path)] === undefined ? { ...node, ...last, stale: true } : node;
}
function renderNestInto(container, layout, fieldName, path, baseAddr, offset, displayPath = path) {
    renderLayoutInto(
        nestShell(container, fieldName, layout.typeName, path, displayPath),
        layout,
        path,
        baseAddr,
        offset,
        null,
        displayPath
    );
}
// Collapsible head + body for a nested composite, laid out like the sidebar; returns the body.
function nestShell(container, fieldName, typeName, path, displayPath = path) {
    var wrap = document.createElement("div");
    wrap.className = "comp-nest";
    var head = document.createElement("div");
    head.className = "comp-head";
    var arrow = document.createElement("span");
    arrow.className = "comp-arrow" + (expanded[path] ? " open" : "");
    arrow.textContent = "\u25B6";
    var nm = document.createElement("span");
    nm.className = "comp-name";
    nm.textContent = fieldName;
    nm.title = displayNameFor({ name: displayPath });
    var ty = document.createElement("span");
    ty.className = "comp-type";
    ty.textContent = typeName || "";
    ty.title = ty.textContent;
    head.append(arrow, nm, ty);
    var body = document.createElement("div");
    body.className = "comp-members" + (expanded[path] ? " open" : "");
    head.onclick = function () {
        var open = !expanded[path];
        expanded[path] = open;
        body.classList.toggle("open", open);
        arrow.classList.toggle("open", open);
        saveUi();
    };
    wrap.append(head, body);
    container.appendChild(wrap);
    return body;
}
function renderLayoutInto(container, layout, path, baseAddr, offset, disp, displayPath = path) {
    if (!layout) return;
    const promoted = !showRawFor(path) && EmberProbeRuntime.summaryRow(layout, path, offset);
    if (promoted) {
        renderSummaryInto(container, promoted, baseAddr, path);
        return;
    }
    if (layout.kind === "struct" || layout.kind === "union" || layout.kind === "class") {
        var ms = layout.members || [];
        ms.forEach(function (original) {
            if (!EmberProbeRuntime.memberVisible(original, showRawFor(path))) return;
            const m = EmberProbeRuntime.layoutBranch(
                layoutSymbol(path),
                original,
                EmberProbeRuntime.layoutMemberPath(path, original)
            );
            var cp = EmberProbeRuntime.layoutMemberPath(path, m),
                off = offset + (Number(m.offset) || 0);
            const summary = !showRawFor(path) && EmberProbeRuntime.summaryRow(m, cp, off);
            if (summary) renderSummaryInto(container, summary, baseAddr, m.name, m.typeName);
            else if (m.unobservable)
                layoutExpansionUi.render(container, { ...m, path: cp }, EmberProbeRuntime.variableBaseName(path), t);
            else if (m.compositeLayout && !m.name)
                renderLayoutInto(container, m.compositeLayout, cp, baseAddr, off, null, displayPath);
            else if (m.compositeLayout)
                renderNestInto(
                    container,
                    m.compositeLayout,
                    m.name,
                    cp,
                    baseAddr,
                    off,
                    EmberProbeRuntime.layoutMemberPath(displayPath, m)
                );
            else if (m.watchType)
                renderLeafInto(container, m.name, m.typeName || m.watchType, cp, m.watchType, baseAddr + off, {
                    ...m,
                    ...(displayPath !== path ? { displayPath: EmberProbeRuntime.layoutMemberPath(displayPath, m) } : {})
                });
        });
        if (!ms.length) appendNote(container, t("lw.compositeNoLayout"));
    } else if (layout.kind === "array") {
        var et = layout.elementType || {},
            total = Number(layout.totalElements) || 0,
            es = Number(et.byteSize) || 0;
        var start = 0,
            end = Math.min(total, MAX_ARR_SHOWN);
        if (disp) {
            start = Math.max(0, Number(disp.start) || 0);
            end = Math.min(total, isNaN(Number(disp.end)) ? total : Number(disp.end));
            end = Math.min(end, start + 256);
        }
        if (!et.watchType && !et.compositeLayout && !et.unobservable) {
            appendNote(container, t("lw.compositeNoLayout"));
            return;
        }
        for (var i = start; i < end; i++) {
            var cp = path + "[" + i + "]",
                off = offset + i * es;
            const element = EmberProbeRuntime.layoutBranch(layoutSymbol(path), et, cp);
            if (element.unobservable)
                layoutExpansionUi.render(
                    container,
                    { ...element, path: cp },
                    EmberProbeRuntime.variableBaseName(path),
                    t
                );
            else if (element.compositeLayout)
                renderNestInto(
                    container,
                    element.compositeLayout,
                    "[" + i + "]",
                    cp,
                    baseAddr,
                    off,
                    displayPath + "[" + i + "]"
                );
            else
                renderLeafInto(
                    container,
                    "[" + i + "]",
                    et.typeName || et.watchType,
                    cp,
                    et.watchType,
                    baseAddr + off,
                    { ...element, ...(displayPath !== path ? { displayPath: displayPath + "[" + i + "]" } : {}) }
                );
        }
        if (total > end) appendNote(container, t("lw.arrayMore", { n: total - end }));
    }
}
function renderSummaryInto(container, summary, baseAddr, label, typeName) {
    const node = {
        ...summary.node,
        displayPath: summary.displayPath,
        summaryPath: summary.displayPath,
        functionEmpty: summary.empty
    };
    const layout = node.compositeLayout || ((node.members || node.elements || node.kind === "array") && node);
    if (node.unobservable)
        layoutExpansionUi.render(container, { ...node, path: summary.path }, baseNameOf(summary.path), t);
    else if (layout)
        renderNestInto(container, layout, label, summary.path, baseAddr, summary.offset, summary.displayPath);
    else
        renderLeafInto(
            container,
            label,
            typeName || node.typeName || node.watchType,
            summary.path,
            node.watchType || node.type,
            node.address ?? baseAddr + summary.offset,
            node
        );
}
// Nested structs and array elements get a collapsible head, as in static layouts; base
// classes, anonymous members and a pointer's own target stay flat.
function renderRuntimeTreeInto(container, tree, path, label = "value", promoted = false, nest = false) {
    if (!tree) return;
    const summary = !promoted && !showRawFor(path) && EmberProbeRuntime.summaryRow(tree, path);
    if (summary) {
        const target = { ...summary.node, displayPath: path, summaryPath: path, functionEmpty: summary.empty };
        if (target.members || target.elements) {
            const wrap = document.createElement("div");
            wrap.className = "comp-nest";
            const head = document.createElement("button");
            head.type = "button";
            head.className = "comp-head summary-head";
            head.textContent = label;
            head.title = displayNameFor({ name: path });
            const body = document.createElement("div");
            body.className = "comp-members" + (expanded[path] ? " open" : "");
            head.setAttribute("aria-expanded", String(!!expanded[path]));
            head.onclick = () => {
                expanded[path] = !expanded[path];
                body.classList.toggle("open", expanded[path]);
                head.setAttribute("aria-expanded", String(expanded[path]));
                saveUi();
            };
            renderRuntimeTreeInto(body, target, summary.path, label, true);
            wrap.append(head, body);
            container.appendChild(wrap);
        } else renderRuntimeTreeInto(container, target, summary.path, label, true);
        return;
    }
    const pointer = tree.isPointer || tree.valueText === "nullptr";
    if (nest && !pointer && !Object.prototype.hasOwnProperty.call(tree, "value") && (tree.members || tree.elements)) {
        const body = nestShell(container, label, tree.typeName, path, tree.displayPath || path);
        renderRuntimeTreeInto(body, tree, path, label, promoted);
        return;
    }
    const renderMembers = function (target) {
        tree.members.forEach(function (member) {
            if (!EmberProbeRuntime.memberVisible(member, showRawFor(path))) return;
            var childPath = EmberProbeRuntime.layoutMemberPath(path, member);
            if (member.unobservable)
                appendNote(
                    target,
                    (member.name || "?") + ": " + EmberProbeRuntime.unobservableReason(member.unobservable, t)
                );
            else
                renderRuntimeTreeInto(
                    target,
                    {
                        ...member,
                        ...(tree.displayPath
                            ? { displayPath: EmberProbeRuntime.layoutMemberPath(tree.displayPath, member) }
                            : {})
                    },
                    childPath,
                    pointer && member.name === "value" ? "*" + label : member.name || "value",
                    false,
                    !!member.name &&
                        !member.isBase &&
                        !/^@based+$/.test(member.name) &&
                        !(pointer && member.name === "value")
                );
        });
    };
    const inline = pointer && tree.members?.length ? renderMembers : null;
    if (pointer || Object.prototype.hasOwnProperty.call(tree, "value"))
        renderLeafInto(
            container,
            label,
            tree.typeName || tree.type || "",
            path,
            tree.type || (pointer ? "u32" : undefined),
            tree.address,
            { ...tree, ...(pointer ? { isPointer: true } : {}) },
            inline
        );
    if (tree.members && !inline) renderMembers(container);
    else if (tree.elements)
        tree.elements.forEach(function (element) {
            renderRuntimeTreeInto(
                container,
                {
                    ...element,
                    ...(tree.displayPath ? { displayPath: tree.displayPath + "[" + element.index + "]" } : {})
                },
                path + "[" + element.index + "]",
                "[" + element.index + "]",
                false,
                true
            );
        });
    if (tree.unobservable) appendNote(container, EmberProbeRuntime.unobservableReason(tree.unobservable, t));
    else if (tree.unavailable)
        appendNote(container, tree.unavailableCode === "LIVE_NULL_POINTER" ? t("lw.pointeeNull") : tree.unavailable);
}
function renderRuntimeBody(body, sampled, name) {
    // Without a sample the type graph still yields the rows, so pointer rows keep their pointees.
    var tree =
        sampled ||
        EmberProbeRuntime.placeholderRuntimeTree(
            watch.find(function (item) {
                return item.name === name;
            }),
            shownLastPointers()
        );
    var shape = JSON.stringify([showRawFor(name), !sampled, EmberProbeRuntime.displayTreeShape(tree)]);
    if (body.dataset.runtimeShape === shape) return;
    Object.keys(compCells).forEach(function (path) {
        if (body.contains(compCells[path])) delete compCells[path];
    });
    body.textContent = "";
    body.dataset.runtimeShape = shape;
    if (tree?.truncated) appendNote(body, t("lw.layoutPartial"));
    renderRawMembersUi(body, sampled || layoutSymbol(name)?.compositeLayout, name);
    renderRuntimeTreeInto(body, tree, name);
    const symbol = layoutSymbol(name);
    for (const entry of EmberProbeRuntime.displayUnavailableRows(
        symbol?.compositeLayout,
        name,
        64,
        symbol,
        showRawFor(name)
    ))
        layoutExpansionUi.render(body, entry, name, t);
    if (!sampled) appendNote(body, t("lw.waitSamples"));
}
function appendNote(container, text) {
    var n = document.createElement("div");
    n.className = "comp-note";
    n.textContent = text;
    container.appendChild(n);
}
function renderCompositeCard(item, idx, box) {
    var card = document.createElement("div");
    card.className = "var-card composite" + (expanded[item.name] ? " open" : "");
    var rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = t("lw.removeVar");
    rm.setAttribute("aria-label", t("lw.removeVarName", { name: displayNameFor(item) }));
    rm.onclick = function (e) {
        e.stopPropagation();
        removeVar(item.name);
    };
    var content = document.createElement("div");
    content.className = "comp-content";
    var head = document.createElement("div");
    head.className = "comp-head";
    var arrow = document.createElement("span");
    arrow.className = "comp-arrow" + (expanded[item.name] ? " open" : "");
    arrow.textContent = "\u25B6";
    var nm = document.createElement("span");
    nm.className = "comp-name";
    EmberProbeRuntime.renderVariableName(nm, displayNameFor(item), item.name);
    var lay = item.compositeLayout || {};
    var ty = document.createElement("span");
    ty.className = "comp-type";
    ty.textContent = item.typeName || lay.typeName || "";
    ty.title =
        (ty.textContent ? ty.textContent + " · " : "") + (Number(item.size) || 0) + "B · " + fmtAddr(item.address);
    head.append(arrow, nm, ty);
    var body = document.createElement("div");
    body.className = "comp-body";
    head.onclick = function () {
        expanded[item.name] = !expanded[item.name];
        card.classList.toggle("open", expanded[item.name]);
        arrow.classList.toggle("open", expanded[item.name]);
        saveUi();
        dirty = true;
    };
    if (item.runtimeLayout) {
        runtimeBodies[item.name] = body;
        renderRuntimeBody(body, latest[item.name], item.name);
    } else {
        renderRawMembersUi(body, lay, item.name);
        if (lay.truncated) appendNote(body, t("lw.layoutPartial"));
        renderLayoutInto(body, lay, item.name, Number(item.address) >>> 0, 0, dispSpec[item.name] || null);
    }
    if (controls) controls.decorate(card, item.name);
    content.append(head, body);
    card.append(rm, content);
    box.appendChild(card);
    updateCompositeValues(item.name);
}
function baseNameOf(n) {
    return EmberProbeRuntime.variableBaseName(String(n));
}
function isLeafChild(name) {
    var b = baseNameOf(name);
    if (b === name) return false;
    const parent = watch.find((w) => w.name === b && isCompositeItem(w));
    if (parent)
        return !!compCells[name] && !(parent.runtimeLayout && watch.find((w) => w.name === name)?.layoutExpanded);
    // Members of an expanded pointee are charted from its tree, which already shows them.
    return (
        !!compCells[name] &&
        watch.some((w) => w.runtimeLayout && isCompositeItem(w) && EmberProbeRuntime.runtimeMemberRoute(name, w.name))
    );
}
function addLeafWatch(path, address, watchType, node) {
    if (
        watch.some(function (w) {
            return w.name === path;
        })
    )
        return false;
    watch.push({
        name: path,
        address: Number(address) >>> 0,
        size: defW(watchType),
        type: watchType,
        ...(node?.isPointer ? { isPointer: true, typeName: node.typeName, pointerTarget: node.pointerTarget } : {}),
        ...(node?.displayPath ? { displayName: node.displayPath } : {}),
        ...(node?.layoutExpanded ? { layoutExpanded: true, staticRuntimeStorage: node.staticRuntimeStorage } : {}),
        ...(node && Number.isInteger(node.bitSize) ? { bitSize: node.bitSize, bitOffset: node.bitOffset } : {})
    });
    ensureBuf(path);
    return true;
}
function toggleLeafInChart(path, address, watchType, node) {
    var i = watch.findIndex(function (w) {
        return w.name === path;
    });
    if (i >= 0) {
        toggleCurve(path);
        return;
    } else {
        addLeafWatch(path, address, watchType, node);
    }
    renderVars();
    saveWatch();
    dirty = true;
}
function collectLeaves(layout, name, baseAddr, options = {}) {
    return EmberProbeRuntime.displayLayoutLeaves(layoutSymbol(name), layout, name, baseAddr, options);
}
function selectionLeaves(symbol, runtime) {
    const showRaw = showRawFor(symbol.name);
    const statics = collectLeaves(symbol.compositeLayout, symbol.name, symbol.address, {
        showRaw,
        includePointers: true
    });
    const visibleRuntime = EmberProbeRuntime.displayRuntimeSelection(symbol, latest[symbol.name], showRaw);
    return runtime ? (visibleRuntime?.entries || []).concat(statics.filter((leaf) => leaf.layoutExpanded)) : statics;
}
function onCompositeSamples(samples) {
    if (historyClearPending) return;
    var refreshImport = false;
    var searching = !!$("impFilter").value.trim();
    (samples || []).forEach(function (s) {
        if (!s || !s.name) return;
        if (
            (impExpanded[s.name] || searching) &&
            !$("overlay").classList.contains("hidden") &&
            EmberProbeRuntime.runtimeTreeShape(latest[s.name]) !== EmberProbeRuntime.runtimeTreeShape(s.tree) &&
            EmberProbeRuntime.runtimeSelection(impSymbolByName.get(s.name), s.tree)
        )
            refreshImport = true;
        if (s && s.name) {
            latest[s.name] = s.tree;
            rememberPointers(EmberProbeRuntime.pointerSnapshots(s.tree, s.name));
            var body = runtimeBodies[s.name];
            if (body) renderRuntimeBody(body, s.tree, s.name);
        }
    });
    if (refreshImport && !$("overlay").classList.contains("hidden")) renderImport();
    // A re-rendered tree can now show the pointer row of a pointee drawn as a stand-alone card.
    // A re-rendered tree can also now show members that still have their own chart card.
    if (
        [...fallbackPointees].some((name) => placedPointees.has(name)) ||
        watch.some((it) => !isCompositeItem(it) && valueCells[it.name]?.closest(".var-card") && isLeafChild(it.name))
    )
        renderVars();
    scheduleValueRefresh();
    dirty = true;
}
function showArraySelectDialog(sym, cb) {
    var lay = sym.compositeLayout || {},
        total = Number(lay.totalElements) || 0;
    var ov = document.createElement("div");
    ov.className = "array-overlay";
    var panel = document.createElement("div");
    panel.className = "array-panel";
    var h = document.createElement("h4");
    h.textContent = t("lw.arraySelectTitle") + " \u00b7 " + displayNameFor(sym) + "[" + total + "]";
    panel.appendChild(h);
    function opt(mode, label, extra) {
        var l = document.createElement("label");
        l.className = "opt";
        var r = document.createElement("input");
        r.type = "radio";
        r.name = "arrmode";
        r.value = mode;
        if (mode === "all") r.checked = true;
        var sp = document.createElement("span");
        sp.textContent = label;
        l.append(r, sp);
        if (extra) l.appendChild(extra);
        panel.appendChild(l);
        return r;
    }
    opt("all", t("lw.arrayAll"));
    var rw = document.createElement("span");
    var s0 = document.createElement("input");
    s0.type = "number";
    s0.min = "0";
    s0.value = "0";
    var s1 = document.createElement("input");
    s1.type = "number";
    s1.min = "0";
    s1.value = String(Math.min(total, 16));
    rw.append(document.createTextNode(t("lw.arrayStart")), s0, document.createTextNode(t("lw.arrayEnd")), s1);
    opt("range", t("lw.arrayRange"), rw);
    var iw = document.createElement("span");
    var si = document.createElement("input");
    si.type = "number";
    si.min = "0";
    si.value = "0";
    iw.append(document.createTextNode(t("lw.arrayIndex")), si);
    opt("single", t("lw.arraySingle"), iw);
    var right = document.createElement("div");
    right.className = "right";
    var cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = t("lw.cancel");
    var ok = document.createElement("button");
    ok.textContent = t("lw.arrayApply");
    right.append(cancel, ok);
    panel.appendChild(right);
    ov.appendChild(panel);
    document.body.appendChild(ov);
    var close = function () {
        ov.remove();
    };
    cancel.onclick = close;
    ov.onclick = function (e) {
        if (e.target === ov) close();
    };
    ok.onclick = function () {
        var sel = panel.querySelector("input[name=arrmode]:checked");
        var mode = sel ? sel.value : "all";
        var disp = null;
        if (mode === "range") {
            var a = Math.max(0, parseInt(s0.value, 10) || 0),
                b = parseInt(s1.value, 10);
            if (isNaN(b)) b = total;
            disp = { start: a, end: Math.max(a, b) };
        } else if (mode === "single") {
            var ix = Math.max(0, parseInt(si.value, 10) || 0);
            disp = { start: ix, end: ix + 1 };
        }
        close();
        cb(disp);
    };
}
function start() {
    if (running || starting) return;
    if (!watch.length) {
        setStatusKey("lw.needVar", null, "error");
        return;
    }
    var frequencyHz = selectedFrequencyHz();
    requestedFrequencyHz = frequencyHz;
    renderUnlimited(true);
    starting = true;
    updateRun();
    setStatusKey("lw.starting");
    post({ type: "start", items: watch, frequencyHz: frequencyHz });
}
function stop() {
    if (!running && !starting) return;
    starting = false;
    post({ type: "stop" });
    setStatusKey("lw.stopping");
    updateRun();
}
function clearHistory(clearArchive = true) {
    historyRevision++;
    historyClearPending = clearArchive;
    if (CFG.backendHistory) {
        remoteHistory.status = remoteHistory.liveStatus = null;
        remoteHistory.series = [];
        remoteHistory.inFlight = remoteHistory.pending = remoteHistory.operation = null;
        remoteHistory.cachedKey = remoteHistory.desiredKey = remoteHistory.snapshotId = null;
        remoteHistory.desiredViewKey = null;
    }
    archiveExportInfo = null;
    exportCandidates = [];
    hideExport();
    if (clearArchive) post({ type: "clearSamplingHistory", historyRevision: historyRevision });
    Analysis.resume(analysis);
    frozen = false;
    $("freeze").textContent = t("lw.freeze");
    invalidateSeries();
    Object.keys(data).forEach(function (n) {
        data[n] = [];
    });
    Object.keys(latest).forEach(function (n) {
        latest[n] = null;
        latestText[n] = null;
        latestEnum[n] = null;
        delete latestPointer[n];
    });
    sampleTimes = [];
    samplingOrigin = null;
    $("rate").textContent = rateText(0, 0);
    updateValues();
    resetChartView();
    dirty = true;
}
const IMPORT_VARIABLE_LIMIT = 500;
const IMPORT_ROW_LIMIT = IMPORT_VARIABLE_LIMIT * 2;
function needsImportLayout(symbol) {
    return symbol.isComposite && !symbol.compositeLayout && !symbol.runtimeLayout && !symbol.layoutError;
}
function cancelImportMemberSearch() {
    clearTimeout(impSearchTimer);
    impSearchTimer = null;
}
function scheduleImportMemberSearch(query) {
    if (query !== impSearchQuery || !query || !impTypesReady) {
        cancelImportMemberSearch();
        impSearchQuery = query;
    }
    if (!query || !impTypesReady || !api || impSearchTimer !== null) return;
    impSearchTimer = setTimeout(function () {
        impSearchTimer = null;
        if ($("overlay").classList.contains("hidden")) return;
        var slots = Math.max(0, 4 - impLayoutPending.size);
        allSymbols
            .filter(function (symbol) {
                return needsImportLayout(symbol) && !impLayoutPending.has(symbol.name);
            })
            .slice(0, slots)
            .forEach(function (symbol) {
                impLayoutPending.add(symbol.name);
                post({ type: "resolveCompositeLayout", name: symbol.name, version: impVersion });
            });
    }, 180);
}
function renderImport() {
    renderElfDiagnostics();
    var f = ($("impFilter").value || "").trim().toLowerCase(),
        box = $("impList");
    var checkedNames = new Set(
        Array.from(box.querySelectorAll("input:checked"), (cb) => cb.dataset.leafPath || cb.dataset.symbolName)
    );
    box.textContent = "";
    scheduleImportMemberSearch(f);
    var memberMatches = new Map();
    var matched = allSymbols.filter(function (s) {
            if (!f || s.name.toLowerCase().includes(f) || displayNameFor(s).toLowerCase().includes(f)) return true;
            if (!s.isComposite) return false;
            var runtime = EmberProbeRuntime.runtimeSelection(s, latest[s.name]);
            var leaves = selectionLeaves(s, runtime);
            var matches = leaves.filter(function (leaf) {
                return (
                    leaf.path.toLowerCase().includes(f) || displayNameFor({ name: leaf.path }).toLowerCase().includes(f)
                );
            });
            if (!matches.length) return false;
            memberMatches.set(s.name, matches);
            return true;
        }),
        shown = matched.slice(0, IMPORT_VARIABLE_LIMIT),
        leafRows = 0;
    shown.forEach(function (s) {
        var gi = impIndexByName.get(s.name);
        if (s.isComposite) {
            var open = !!impExpanded[s.name] || memberMatches.has(s.name);
            var row = document.createElement("div");
            row.className = "imp-row";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.idx = String(gi);
            cb.dataset.symbolName = s.name;
            cb.checked = checkedNames.has(s.name);
            cb.title = t("lw.compositeExpandable");
            var nmWrap = document.createElement("span");
            nmWrap.className = "imp-name-wrap";
            var arrow = document.createElement("span");
            arrow.className = "imp-arrow";
            arrow.textContent = "\u25B6";
            if (open) arrow.classList.add("open");
            var nm = document.createElement("span");
            nm.className = "imp-name";
            EmberProbeRuntime.renderSymbolName(nm, displayNameFor(s), s);
            nmWrap.append(arrow, nm);
            var ty = document.createElement("span");
            ty.className = "ty";
            ty.textContent = s.typeName || t("lw.unknownType");
            var a = document.createElement("span");
            a.className = "address";
            a.textContent = fmtAddr(s.address);
            var z = document.createElement("span");
            z.className = "size";
            z.textContent = s.size + "B";
            row.append(cb, nmWrap, ty, a, z);
            box.appendChild(row);
            var kids = document.createElement("div");
            kids.className = "imp-children";
            if (open) kids.classList.add("open");
            var ownLeafRows = 0;
            var populate = function () {
                leafRows -= ownLeafRows;
                ownLeafRows = 0;
                kids.textContent = "";
                if (!s.compositeLayout && !s.runtimeLayout) {
                    kids.textContent = s.layoutError || s.unsupportedReason || t("lw.compositeNoLayout");
                    return;
                }
                renderRawMembersUi(kids, latest[s.name] || s.compositeLayout, s.name);
                var runtime = EmberProbeRuntime.runtimeSelection(s, latest[s.name]);
                var leaves = memberMatches.get(s.name) || selectionLeaves(s, runtime);
                if (runtime)
                    appendNote(
                        kids,
                        t(
                            runtime.sampled
                                ? "lw.runtimeMembersReadOnly"
                                : runtime.entries.length
                                  ? "lw.runtimeMembersSelectable"
                                  : "lw.runtimeMembersHint"
                        )
                    );
                if (runtime && leaves.some((leaf) => leaf.layoutExpanded))
                    appendNote(kids, t("lw.layoutStaticStorage"));
                if (s.compositeLayout?.truncated || s.runtimeLayout?.truncated) appendNote(kids, t("lw.layoutPartial"));
                EmberProbeRuntime.displayUnavailableRows(s.compositeLayout, s.name, 64, s, showRawFor(s.name)).forEach(
                    function (entry) {
                        layoutExpansionUi.render(kids, entry, s.name, t);
                    }
                );
                var shownLeaves = Math.min(leaves.length, Math.max(0, IMPORT_ROW_LIMIT - shown.length - leafRows));
                leaves.slice(0, shownLeaves).forEach(function (lf) {
                    var lr = document.createElement("label");
                    lr.className = "imp-row leaf";
                    var lcb = document.createElement("input");
                    lcb.type = "checkbox";
                    lcb.dataset.leafPath = lf.path;
                    lcb.checked = checkedNames.has(lf.path);
                    lcb.dataset.leafAddr = String(lf.address);
                    lcb.dataset.leafType = lf.type;
                    if (lf.runtimeLayout) lcb.runtimeEntry = lf;
                    else lcb.leafEntry = lf;
                    var ln = document.createElement("span");
                    ln.className = "imp-leaf-name";
                    ln.textContent = lf.label;
                    ln.title = displayNameFor(lf.runtimeLayout ? lf : { name: lf.displayPath || lf.path });
                    var lty = document.createElement("span");
                    lty.className = "ty";
                    lty.textContent =
                        (lf.isPointer ? lf.typeName : lf.type) || (lf.isComposite ? t("lw.compositeType") : "");
                    var la = document.createElement("span");
                    la.className = "address";
                    la.textContent = fmtAddr(lf.address);
                    var lz = document.createElement("span");
                    lz.className = "size";
                    lr.append(lcb, ln, lty, la, lz);
                    kids.appendChild(lr);
                });
                ownLeafRows = shownLeaves;
                leafRows += shownLeaves;
                if (leaves.length > shownLeaves) {
                    var note = document.createElement("div");
                    note.textContent = t("lw.arrayMore", { n: leaves.length - shownLeaves });
                    kids.appendChild(note);
                }
            };
            if (open) {
                populate();
                if (!s.compositeLayout && !s.runtimeLayout && !s.layoutError && !impLayoutPending.has(s.name)) {
                    impLayoutPending.add(s.name);
                    post({ type: "resolveCompositeLayout", name: s.name, version: impVersion });
                }
            }
            box.appendChild(kids);
            var toggle = function (e) {
                e.preventDefault();
                e.stopPropagation();
                var open = kids.classList.toggle("open");
                arrow.classList.toggle("open", open);
                impExpanded[s.name] = open;
                if (open) {
                    populate();
                    if (!s.compositeLayout && !s.runtimeLayout && !s.layoutError && !impLayoutPending.has(s.name)) {
                        impLayoutPending.add(s.name);
                        post({ type: "resolveCompositeLayout", name: s.name, version: impVersion });
                    }
                } else {
                    leafRows -= ownLeafRows;
                    ownLeafRows = 0;
                    kids.textContent = "";
                }
            };
            arrow.onclick = toggle;
            nm.onclick = toggle;
        } else {
            var row2 = document.createElement("label");
            row2.className = "imp-row";
            if (s.isComposite && !s.compositeLayout && !s.runtimeLayout)
                row2.title = s.unsupportedReason || t("lw.compositeNoLayout");
            var cb2 = document.createElement("input");
            cb2.type = "checkbox";
            cb2.disabled = !!(s.isComposite && !s.compositeLayout && !s.runtimeLayout);
            cb2.dataset.idx = String(gi);
            cb2.dataset.symbolName = s.name;
            cb2.checked = checkedNames.has(s.name);
            var nm2 = document.createElement("span");
            nm2.className = "imp-name";
            EmberProbeRuntime.renderSymbolName(nm2, displayNameFor(s), s);
            var ty2 = document.createElement("span");
            ty2.className = "ty";
            ty2.textContent = s.typeName || s.watchType || defType(s.size);
            var a2 = document.createElement("span");
            a2.className = "address";
            a2.textContent = fmtAddr(s.address);
            var z2 = document.createElement("span");
            z2.className = "size";
            z2.textContent = s.size + "B";
            row2.append(cb2, nm2, ty2, a2, z2);
            box.appendChild(row2);
        }
    });
    if (!shown.length) {
        var empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent =
            f && (!impTypesReady || allSymbols.some(needsImportLayout))
                ? t("sb.searchingMembers")
                : allSymbols.length
                  ? t("sb.noMatch")
                  : t("sb.noImportable");
        box.appendChild(empty);
    }
    $("impCount").textContent =
        t("lw.totalVars", { n: allSymbols.length }) +
        (matched.length > shown.length ? t("lw.showingFirst", { n: shown.length }) : "");
}
function showImport(symbols) {
    allSymbols = symbols || [];
    impIndexByName = new Map(allSymbols.map((symbol, index) => [symbol.name, index]));
    openImport();
}
function openImport() {
    $("impFilter").value = "";
    renderImport();
    $("overlay").classList.remove("hidden");
}
function hideImport() {
    $("overlay").classList.add("hidden");
    cancelImportMemberSearch();
}
var autocompleteMatches = [],
    autocompleteIndex = -1,
    ambiguityChoices = null,
    variableRequestId = 0,
    pendingVariableRequest = null;
function hideAutocomplete() {
    $("acDrop").classList.remove("open");
    $("addName").setAttribute("aria-expanded", "false");
    $("addName").removeAttribute("aria-activedescendant");
    autocompleteMatches = [];
    autocompleteIndex = -1;
    ambiguityChoices = null;
    pendingVariableRequest = null;
    $("acChoiceHint").hidden = true;
}
function selectAutocomplete(index) {
    autocompleteIndex = index;
    var rows = $("acResults").children;
    for (var i = 0; i < rows.length; i++) {
        rows[i].classList.toggle("active", i === index);
        rows[i].setAttribute("aria-selected", String(i === index));
    }
    var row = rows[index];
    if (row) {
        $("addName").setAttribute("aria-activedescendant", row.id);
        if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    }
}
function acceptAutocomplete(symbol) {
    if (ambiguityChoices || symbol.addressAmbiguous) {
        resolveTypedVariable(symbol.name);
        return;
    }
    addSymbol(symbol);
    $("addName").value = "";
    hideAutocomplete();
}
function renderAutocomplete(candidates) {
    var drop = $("acDrop");
    if (!drop) return;
    var q = ($("addName").value || "").trim().toLowerCase();
    hideAutocomplete();
    var results = $("acResults");
    results.textContent = "";
    if (!q) {
        drop.classList.remove("open");
        return;
    }
    var matches = Array.isArray(candidates)
        ? candidates
        : allSymbols
              .filter(function (s) {
                  return s.name.toLowerCase().indexOf(q) >= 0 || displayNameFor(s).toLowerCase().indexOf(q) >= 0;
              })
              .slice(0, 12);
    if (!matches.length) {
        drop.classList.remove("open");
        return;
    }
    autocompleteMatches = matches;
    ambiguityChoices = Array.isArray(candidates) ? matches : null;
    $("acChoiceHint").hidden = !ambiguityChoices;
    matches.forEach(function (s, index) {
        var it = document.createElement("div");
        it.className = "ac-item";
        it.id = "ac-option-" + index;
        it.setAttribute("role", "option");
        it.setAttribute("aria-selected", "false");
        var nm = document.createElement("span");
        nm.className = "ac-name";
        EmberProbeRuntime.renderSymbolName(nm, displayNameFor(s), s);
        var ty = document.createElement("span");
        ty.className = "ac-type";
        ty.textContent = s.typeName || s.watchType || (ambiguityChoices ? s.address : defType(s.size));
        it.append(nm, ty);
        it.onmousedown = function (e) {
            e.preventDefault();
            acceptAutocomplete(s);
        };
        results.appendChild(it);
    });
    drop.classList.add("open");
    $("addName").setAttribute("aria-expanded", "true");
}
function resolveTypedVariable(name) {
    hideAutocomplete();
    pendingVariableRequest = { id: ++variableRequestId, query: $("addName").value.trim(), name: name };
    post({ type: "resolveVariable", name: name, version: impVersion, requestId: variableRequestId });
}
function currentVariableReply(message) {
    return (
        pendingVariableRequest &&
        pendingVariableRequest.id === message.requestId &&
        pendingVariableRequest.name === message.requestedName &&
        pendingVariableRequest.query === $("addName").value.trim() &&
        message.version === impVersion
    );
}
function importSelected() {
    var leafCbs = [],
        syms = [];
    $("impList")
        .querySelectorAll("input:checked")
        .forEach(function (cb) {
            if (cb.dataset.leafPath) leafCbs.push(cb);
            else if (cb.dataset.idx) {
                var s = allSymbols[parseInt(cb.dataset.idx, 10)];
                if (s) syms.push(s);
            }
        });
    var changed = false;
    leafCbs.forEach(function (cb) {
        if (cb.runtimeEntry) addSymbol(cb.runtimeEntry, true);
        else if (
            addLeafWatch(cb.dataset.leafPath, Number(cb.dataset.leafAddr) || 0, cb.dataset.leafType, cb.leafEntry)
        ) {
            hidePointerCurve(cb.leafEntry && { ...cb.leafEntry, name: cb.dataset.leafPath });
            changed = true;
        }
    });
    syms.forEach(function (s) {
        addSymbol(s);
    });
    if (changed) {
        renderVars();
        saveWatch();
        saveUi();
        dirty = true;
    }
    hideImport();
}
var exportCandidates = [],
    exportOpenedAt = 0,
    exportTimelineStart = 0,
    exportTimelineEnd = 0;
function formatElapsed(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000)),
        seconds = Math.floor(total % 60),
        minutes = Math.floor(total / 60) % 60,
        hours = Math.floor(total / 3600),
        two = function (v) {
            return String(v).padStart(2, "0");
        };
    return hours ? two(hours) + ":" + two(minutes) + ":" + two(seconds) : two(minutes) + ":" + two(seconds);
}
function exportBounds(candidates) {
    var from = Infinity,
        to = -Infinity;
    (candidates || []).forEach(function (c) {
        (c.buffer || []).forEach(function (p) {
            var time = Number(p && p.t);
            if (Number.isFinite(time)) {
                from = Math.min(from, time);
                to = Math.max(to, time);
            }
        });
    });
    return { from: from, to: to };
}
function selectedExportCandidates() {
    var picked = [];
    $("exportSeries")
        .querySelectorAll("input[type=checkbox]:checked")
        .forEach(function (cb) {
            var item = exportCandidates[Number(cb.dataset.index)];
            if (item) picked.push(item);
        });
    return picked;
}
function updateExportTimeline(changed) {
    var from = $("exportFromRange"),
        to = $("exportToRange"),
        a = Number(from.value),
        b = Number(to.value),
        span = Math.max(1, exportTimelineEnd - exportTimelineStart);
    if (a > b) {
        if (changed === "from") {
            b = a;
            to.value = String(b);
        } else {
            a = b;
            from.value = String(a);
        }
    }
    $("exportRangeFill").style.left = (a / span) * 100 + "%";
    $("exportRangeFill").style.width = ((b - a) / span) * 100 + "%";
    $("exportSelection").textContent = t("lw.exportSelectedRange", { from: formatElapsed(a), to: formatElapsed(b) });
}
function setupExportTimeline(candidates) {
    var bounds = exportBounds(candidates);
    exportTimelineStart = Number.isFinite(bounds.from) ? Math.min(bounds.from, exportOpenedAt) : exportOpenedAt;
    exportTimelineEnd = Math.max(exportTimelineStart, exportOpenedAt);
    var span = Math.max(1, Math.round(exportTimelineEnd - exportTimelineStart)),
        from = $("exportFromRange"),
        to = $("exportToRange");
    from.min = to.min = "0";
    from.max = to.max = String(span);
    from.value = "0";
    to.value = String(span);
    $("exportAxisStart").textContent = "00:00";
    $("exportAxisEnd").textContent = formatElapsed(span);
    updateExportTimeline();
}
function setExportTimelineMode() {
    var selected = $("exportRanges").querySelector("input[name=exportRange]:checked"),
        enabled = !!selected && selected.value === "custom";
    $("exportCustom").classList.toggle("disabled", !enabled);
    $("exportFromRange").disabled = !enabled;
    $("exportToRange").disabled = !enabled;
}
function exportOptions() {
    var radio = $("exportRanges").querySelector("input[name=exportRange]:checked"),
        mode = radio ? radio.value : "all";
    if (mode === "all") return {};
    if (mode === "custom") {
        var from = exportTimelineStart + Number($("exportFromRange").value),
            to = exportTimelineStart + Number($("exportToRange").value);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
        return { from: from, to: to };
    }
    var seconds = Number(mode);
    return Number.isFinite(seconds) ? { from: exportOpenedAt - seconds * 1000, to: exportOpenedAt } : null;
}
function hideExport() {
    $("exportOverlay").classList.add("hidden");
    $("exportWarn").textContent = "";
}
var archiveExportInfo = null;
function showExport() {
    if (historyClearPending) return;
    post({ type: "samplingArchiveInfo", openExport: true, historyRevision: historyRevision });
}
function showArchiveExport(info) {
    var names = Array.isArray(info && info.variables) ? info.variables : [],
        first = Number(info && info.firstTimestampMs),
        last = Number(info && info.lastTimestampMs);
    if (!names.length || !Number.isFinite(first) || !Number.isFinite(last)) {
        exportCandidates = [];
        $("exportSeries").textContent = "";
        $("exportWarn").textContent = t("lw.noDataToExport");
        $("exportOverlay").classList.remove("hidden");
        setStatusKey("lw.noDataToExport", null, "error");
        return;
    }
    exportCandidates = names.map(function (name) {
        var displayName =
            info.displayNames &&
            Object.prototype.hasOwnProperty.call(info.displayNames, name) &&
            typeof info.displayNames[name] === "string" &&
            info.displayNames[name];
        return { name: name, displayName: displayName || curveDisplayName(name), buffer: [{ t: first }, { t: last }] };
    });
    exportOpenedAt = last;
    var box = $("exportSeries");
    box.textContent = "";
    exportCandidates.forEach(function (item, index) {
        var label = document.createElement("label"),
            cb = document.createElement("input"),
            name = document.createElement("span");
        cb.type = "checkbox";
        cb.checked = true;
        cb.dataset.index = String(index);
        cb.onchange = function () {
            setupExportTimeline(selectedExportCandidates());
        };
        name.textContent = name.title = item.displayName;
        label.append(cb, name);
        box.appendChild(label);
    });
    setupExportTimeline(exportCandidates);
    var all = $("exportRanges").querySelector("input[value=all]");
    if (all) all.checked = true;
    setExportTimelineMode();
    $("exportWarn").textContent = info.limitReached
        ? t("lw.archiveTruncated")
        : info.limited
          ? t("lw.memoryHistoryLimited")
          : "";
    $("exportOverlay").classList.remove("hidden");
}
function applyExport() {
    var selected = selectedExportCandidates();
    if (!selected.length) {
        $("exportWarn").textContent = t("lw.exportNoSeries");
        return;
    }
    var opts = exportOptions(selected);
    if (!opts) {
        $("exportWarn").textContent = t("lw.exportInvalidRange");
        return;
    }
    post({
        type: "exportCsv",
        historyRevision: historyRevision,
        names: selected.map(function (c) {
            return c.name;
        }),
        fromMs: opts.from,
        toMs: opts.to
    });
    hideExport();
}
var VP = window.EmberChartViewport,
    canvas = $("chart"),
    ctx = canvas.getContext("2d"),
    chartStage = $("chartStage");
var historyLoading = document.createElement("div");
historyLoading.className = "chart-history-loading";
historyLoading.setAttribute("role", "status");
historyLoading.hidden = true;
chartStage.appendChild(historyLoading);
var chartState = {
    bounds: null,
    x: null,
    y: null,
    autoY: true,
    follow: true,
    startPinned: false,
    endpointDrag: null,
    pointer: null,
    drag: null,
    geometry: null,
    visibleKey: "",
    fastDirty: false
};
function resetChartView() {
    chartState.bounds = null;
    chartState.x = null;
    chartState.y = null;
    chartState.autoY = true;
    chartState.follow = true;
    chartState.startPinned = false;
    chartState.endpointDrag = null;
    chartState.pointer = null;
    chartState.drag = null;
    chartState.visibleKey = "";
    chartState.curveGeometry = null;
    chartState.prepared = null;
    chartState.hits = [];
    chartState.geometry = null;
    $("chartOverview").classList.add("disabled");
}
function freezeChart() {
    syncTimeBounds();
    if (CFG.backendHistory) {
        if (remoteHistory.operation || frozen) return;
        remoteHistory.operation = ++remoteHistory.nextId;
        post({ type: "chartFreeze", requestId: remoteHistory.operation, historyRevision: historyRevision });
        return;
    }
    // Auto retention can exceed the new rate's point target while preserving earlier high-rate history.
    var buffers = Object.fromEntries(
        Object.entries(data).map(function (entry) {
            return [entry[0], retainedPoints(entry[1])];
        })
    );
    Analysis.freeze(analysis, buffers, CFG.autoMaxSamples ? HISTORY_MAX_POINTS : MAXPTS);
    frozen = true;
    chartState.follow = false;
    invalidateSeries();
    dirty = true;
    chartState.fastDirty = true;
}
function resumeChart() {
    $("freeze").textContent = t("lw.freeze");
    if (CFG.backendHistory) {
        remoteHistory.operation = null;
        remoteHistory.snapshotId = null;
        remoteHistory.status = remoteHistory.liveStatus;
        remoteHistory.cachedKey = null;
        post({ type: "chartResume", requestId: ++remoteHistory.nextId, historyRevision: historyRevision });
    }
    Analysis.resume(analysis);
    frozen = false;
    invalidateSeries();
    syncTimeBounds();
    applyWindowPreset(windowPreset);
    renderVars();
    dirty = true;
    chartState.fastDirty = true;
}
function updateChartEmpty(series, hasBounds) {
    var empty = $("chartEmpty");
    if (empty.classList.contains("hidden")) return;
    empty.removeAttribute("data-i18n");
    var key = !watch.length
        ? "lw.varListEmpty"
        : watch.every(isCompositeItem)
          ? "lw.chooseMembers"
          : watch.every(function (w) {
                  return isCompositeItem(w) || hidden[w.name];
              })
            ? "lw.allHidden"
            : !hasBounds
              ? frozen
                  ? "lw.frozenNew"
                  : "lw.waitSamples"
              : "lw.rangeEmpty";
    empty.textContent = t(key);
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = t(
        !watch.length
            ? "lw.importVars"
            : key === "lw.chooseMembers"
              ? "lw.expandMembers"
              : key === "lw.allHidden"
                ? "lw.showAll"
                : frozen
                  ? "lw.resume"
                  : hasBounds
                    ? "lw.fitTime"
                    : "lw.startSampling"
    );
    button.disabled = !hasBounds && running && !frozen && key !== "lw.allHidden" && key !== "lw.chooseMembers";
    button.onclick = function () {
        if (!watch.length) $("import").click();
        else if (key === "lw.chooseMembers") {
            watch.forEach(function (w) {
                expanded[w.name] = true;
            });
            sideCollapsed = false;
            applySideLayout();
            renderVars();
            saveUi();
        } else if (key === "lw.allHidden") chartAction("showAll");
        else if (frozen) resumeChart();
        else if (hasBounds) {
            chartState.x = { ...chartState.bounds };
            chartState.follow = true;
            dirty = true;
        } else $("run").click();
    };
    empty.appendChild(button);
}
function chartAction(action, value) {
    if (action === "importSidebar") {
        post({ type: "importSidebarWatch", items: watch });
        return;
    }
    var names = watch.map(function (w) {
        return w.name;
    });
    if (action === "showAll" || action === "hideAll") {
        hidden = Object.fromEntries(
            names.map(function (name) {
                return [name, action === "hideAll"];
            })
        );
        analysis.previousHidden = null;
        analysis.focused = null;
        renderVars();
        saveUi();
    }
    if (action === "restore") {
        hidden = Analysis.restore(analysis, names);
        renderVars();
        saveUi();
    }
    if (action === "focus") {
        hidden = Analysis.focus(analysis, hidden, names, value);
        renderVars();
        saveUi();
    }
    if (action === "hover") {
        chartState.hoverName = value;
        chartState.pointer = null;
        chartState.hits = [];
    }
    if (action === "style") {
        seriesStyles[value.name] = value.style;
        post({ type: "setSeriesStyle", ...value });
        renderVars();
    }
    if (action === "type") {
        var item = watch.find(function (entry) {
            return entry.name === value.name;
        });
        if (item && !isCompositeItem(item) && TYPES.includes(value.type)) {
            item.type = value.type;
            data[item.name] = [];
            latest[item.name] = null;
            latestText[item.name] = null;
            latestEnum[item.name] = null;
            Analysis.remove(analysis, [item.name]);
            invalidateSeries();
            updateValues();
            saveWatch();
        }
    }
    if (action === "remove") removeVar(value);
    if (action === "autoY") chartState.autoY = !chartState.autoY;
    chartState.fastDirty = true;
    dirty = true;
}
controls = window.EmberProbeChartControls.create({
    document: document,
    t: t,
    fmtNum: fmtNum,
    displayName: curveDisplayName,
    tooltipName: function (name) {
        return EmberProbeRuntime.shortVariableName(curveDisplayName(name));
    },
    time: formatChartTime,
    inspection: Inspection,
    change: chartAction,
    get: function () {
        return {
            chart: chartState,
            analysis: analysis,
            hidden: hidden,
            frozen: frozen,
            running: running,
            style: styleFor,
            watch: watch,
            types: TYPES,
            lang: LANG
        };
    }
});
var suppressClickUntil = 0;
canvas.addEventListener("click", function (e) {
    var point = canvasPoint(e);
    if (
        e.button !== 0 ||
        Date.now() < suppressClickUntil ||
        !chartState.x ||
        $("chartEmpty").classList.contains("hidden") === false ||
        chartRegion(point.x, point.y) !== "plot" ||
        !chartState.curveGeometry
    )
        return;
    if (Inspection.hit(chartState.curveGeometry.value, point).length) freezeChart();
});
function chartData(range, width) {
    if (CFG.backendHistory) {
        requestChartViewport(range, width);
        return remoteHistory.series.flatMap(function (part) {
            var idx = watch.findIndex(function (item) {
                return item.name === part.name;
            });
            return idx < 0 || hidden[part.name]
                ? []
                : [{ item: part.item || watch[idx], idx: idx, arr: part.arr, visibleCount: part.visibleCount }];
        });
    }
    var key = JSON.stringify([
        dataRevision,
        !!analysis.snapshot,
        watch.map(function (w) {
            return w.name;
        }),
        hidden,
        range,
        width
    ]);
    if (seriesCache && seriesCache.key === key) return seriesCache.series;
    var series = [];
    watch.forEach(function (item, idx) {
        if (hidden[item.name]) return;
        var arr = plotBuffers()[item.name] || [],
            segment = [];
        if (range && width) {
            Inspection.visibleSegments(arr, range, width).forEach(function (part) {
                series.push({ item: item, idx: idx, arr: part.arr, visibleCount: part.visibleCount });
            });
            return;
        }
        function flush() {
            if (segment.length) {
                series.push({ item: item, idx: idx, arr: segment });
                segment = [];
            }
        }
        for (var i = arr.retainedStart || 0; i < arr.length; i++) {
            var point = arr[i];
            if (point && Number.isFinite(point.v) && Number.isFinite(point.t)) segment.push(point);
            else flush();
        }
        flush();
    });
    seriesCache = { key: key, series: series };
    return series;
}
function retainedTimeBounds() {
    if (CFG.backendHistory) return remoteHistory.status && remoteHistory.status.bounds;
    if (boundsCache) return boundsCache;
    var lo = Infinity,
        hi = -Infinity;
    watch.forEach(function (item) {
        var arr = plotBuffers()[item.name] || [],
            first = arr[arr.retainedStart || 0],
            last = arr[arr.length - 1];
        if (first && last) {
            lo = Math.min(lo, first.t);
            hi = Math.max(hi, last.t);
        }
    });
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    boundsCache = { min: lo, max: Math.max(lo + 1, hi) };
    return boundsCache;
}
function minimumXSpan() {
    return chartState.bounds ? Math.min(VP.span(chartState.bounds), 1) : 1;
}
function endTolerance() {
    var width = $("chartTimeline").clientWidth || 1;
    return chartState.bounds ? (VP.span(chartState.bounds) * 8) / width : 0;
}
function setWindowCustom() {
    var option = $("timeWindow").querySelector("option[value=custom]");
    option.hidden = false;
    $("timeWindow").value = "custom";
}
function applyWindowPreset(value) {
    if (value !== "custom") windowPreset = String(value);
    var custom = $("timeWindow").querySelector("option[value=custom]");
    custom.hidden = true;
    $("timeWindow").value = windowPreset;
    if (!chartState.bounds) return;
    var end = chartState.bounds.max,
        seconds = parseInt(windowPreset, 10);
    chartState.x =
        windowPreset === "0"
            ? { min: chartState.bounds.min, max: end }
            : VP.clamp({ min: end - Math.max(1, seconds * 1000), max: end }, chartState.bounds, minimumXSpan());
    chartState.follow = true;
    chartState.startPinned = windowPreset === "0";
    chartState.fastDirty = true;
    dirty = true;
}
function updateFollowFromView(snap) {
    if (!chartState.x || !chartState.bounds) return;
    var tolerance = endTolerance();
    chartState.startPinned = chartState.x.min - chartState.bounds.min <= tolerance;
    chartState.follow = VP.isAtEnd(chartState.x, chartState.bounds, tolerance);
    if (chartState.follow && snap) {
        if (chartState.startPinned) chartState.x = { min: chartState.bounds.min, max: chartState.bounds.max };
        else chartState.x = VP.followEnd(chartState.x, chartState.bounds, chartState.bounds, minimumXSpan());
    }
}
function snapDraggedRangeEdges() {
    if (!chartState.x || !chartState.bounds) return;
    var tolerance = endTolerance(),
        width = VP.span(chartState.x);
    if (chartState.x.min - chartState.bounds.min <= tolerance) {
        chartState.x = VP.clamp(
            { min: chartState.bounds.min, max: chartState.bounds.min + width },
            chartState.bounds,
            minimumXSpan()
        );
        chartState.startPinned = true;
        chartState.follow = VP.isAtEnd(chartState.x, chartState.bounds, tolerance);
        return;
    }
    if (chartState.bounds.max - chartState.x.max <= tolerance) {
        chartState.x = VP.followEnd(chartState.x, chartState.bounds, chartState.bounds, minimumXSpan());
        chartState.startPinned = chartState.x.min === chartState.bounds.min;
        chartState.follow = true;
        return;
    }
    chartState.startPinned = false;
    chartState.follow = false;
}
function syncTimeBounds() {
    var next = retainedTimeBounds(),
        previous = chartState.bounds;
    if (!next) {
        resetChartView();
        return false;
    }
    var changed = !previous || previous.min !== next.min || previous.max !== next.max;
    chartState.bounds = next;
    if (!chartState.x) {
        applyWindowPreset(windowPreset);
    } else if (changed && chartState.follow) {
        // While resizing, keep the chosen left edge fixed and only advance the attached right edge.
        if (chartState.endpointDrag)
            chartState.x = VP.updateEndpoint(chartState.x, "max", next.max, next, minimumXSpan());
        else if ($("timeWindow").value !== "custom") applyWindowPreset(windowPreset);
        else if (chartState.startPinned) chartState.x = { min: next.min, max: next.max };
        else chartState.x = VP.followEnd(chartState.x, previous, next, minimumXSpan());
    } else if (changed) chartState.x = VP.clamp(chartState.x, next, minimumXSpan());
    return true;
}
function padRange(lo, hi) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: -1, max: 1 };
    if (hi <= lo) {
        var bump = Math.abs(lo) * 0.05 || 1;
        return { min: lo - bump, max: hi + bump };
    }
    var padding = (hi - lo) * 0.08;
    return { min: lo - padding, max: hi + padding };
}
function formatChartTime(ms) {
    var d = new Date(ms),
        two = function (v) {
            return String(v).padStart(2, "0");
        };
    return (
        two(d.getHours()) +
        ":" +
        two(d.getMinutes()) +
        ":" +
        two(d.getSeconds()) +
        "." +
        String(d.getMilliseconds()).padStart(3, "0")
    );
}
function refreshChartTimeline() {
    var overview = $("chartOverview"),
        from = $("chartFromRange"),
        to = $("chartToRange");
    if (!chartState.bounds || !chartState.x) {
        overview.classList.add("disabled");
        from.disabled = to.disabled = true;
        overview.removeAttribute("title");
        $("chartAxisStart").textContent = $("chartAxisEnd").textContent = "00:00";
        return;
    }
    overview.classList.remove("disabled");
    from.disabled = to.disabled = false;
    var total = Math.max(1, Math.round(VP.span(chartState.bounds))),
        a = Math.max(0, Math.round(chartState.x.min - chartState.bounds.min)),
        b = Math.min(total, Math.round(chartState.x.max - chartState.bounds.min)),
        percent = VP.toPercent(chartState.x, chartState.bounds),
        origin = Number.isFinite(samplingOrigin) ? samplingOrigin : chartState.bounds.min;
    from.min = to.min = "0";
    from.max = to.max = String(total);
    from.value = String(a);
    to.value = String(b);
    $("chartRangeFill").style.left = percent.left + "%";
    $("chartRangeFill").style.width = percent.width + "%";
    $("chartAxisStart").textContent = formatElapsed(chartState.bounds.min - origin);
    $("chartAxisEnd").textContent = formatElapsed(chartState.bounds.max - origin);
    overview.title = t("lw.chartSelectedRange", {
        from: formatElapsed(chartState.x.min - origin),
        to: formatElapsed(chartState.x.max - origin)
    });
}
function draw(now) {
    if (!dirty) return;
    if (!chartState.fastDirty && now - lastDraw < 80) return;
    lastDraw = now;
    dirty = false;
    chartState.fastDirty = false;
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    var hasBounds = syncTimeBounds(),
        series = chartData(chartState.x, canvas.clientWidth);
    refreshChartTimeline();
    chartState.selectedName = chartState.hoverName;
    window.EmberProbeChart.paint({
        canvas,
        ctx,
        chartState,
        norm,
        series,
        hasBounds,
        pixelRatio: window.devicePixelRatio,
        style: getComputedStyle(document.body),
        elements: { chartEmpty: $("chartEmpty"), points: $("points"), range: $("range") },
        VP,
        padRange,
        fmtNum,
        colorFor,
        styleFor,
        inspection: Inspection,
        formatChartTime,
        t
    });
    updateChartEmpty(series, hasBounds);
    historyLoading.textContent = t("lw.historyLoading");
    historyLoading.hidden =
        !CFG.backendHistory ||
        !hasBounds ||
        !watch.some(function (item) {
            return !hidden[item.name] && !isCompositeItem(item);
        }) ||
        !(
            remoteHistory.operation ||
            (remoteHistory.desiredKey !== remoteHistory.cachedKey &&
                watch.some(function (item) {
                    return (
                        !hidden[item.name] &&
                        !isCompositeItem(item) &&
                        !series.some(function (part) {
                            return part.item.name === item.name;
                        })
                    );
                }))
        );
    if (!historyLoading.hidden && !series.length) {
        $("chartEmpty").textContent = t("lw.historyLoading");
    }
    if (controls) controls.refresh(series);
}
function chartRegion(x, y) {
    var g = chartState.geometry;
    if (!g) return "none";
    if (x >= g.padL && x <= g.padL + g.pw && y >= g.padT && y <= g.padT + g.ph) return "plot";
    if (x >= g.padL && x <= g.padL + g.pw && y > g.padT + g.ph && y <= g.h) return "x";
    if (x < g.padL && y >= g.padT && y <= g.padT + g.ph) return "y";
    return "none";
}
function chartYAt(py, range) {
    var g = chartState.geometry,
        ratio = Math.max(0, Math.min(1, (py - g.padT) / g.ph));
    return range.max - ratio * VP.span(range);
}
function canvasPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function setCanvasCursor(region) {
    canvas.style.cursor =
        region === "plot" ? "crosshair" : region === "x" ? "ew-resize" : region === "y" ? "ns-resize" : "default";
}
canvas.addEventListener("pointermove", function (e) {
    var p = canvasPoint(e);
    if (chartState.drag) {
        var g = chartState.geometry,
            drag = chartState.drag,
            dx = p.x - drag.start.x,
            dy = p.y - drag.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        chartState.x = VP.panClamped(drag.x, (-dx / g.pw) * VP.span(drag.x), chartState.bounds, minimumXSpan());
        if (drag.mode === "pan") {
            chartState.y = VP.pan(drag.y, (dy / g.ph) * VP.span(drag.y));
            chartState.autoY = false;
        }
        setWindowCustom();
        updateFollowFromView(false);
        chartState.pointer = p;
        chartState.fastDirty = true;
        dirty = true;
        return;
    }
    var region = chartRegion(p.x, p.y);
    setCanvasCursor(region);
    chartState.pointer = region === "plot" ? p : null;
    chartState.fastDirty = true;
    dirty = true;
});
canvas.addEventListener("pointerleave", function () {
    if (chartState.drag) return;
    chartState.pointer = null;
    canvas.style.cursor = "default";
    chartState.fastDirty = true;
    dirty = true;
});
canvas.addEventListener("pointerdown", function (e) {
    var p = canvasPoint(e);
    if ((e.button !== 0 && e.button !== 1) || chartRegion(p.x, p.y) !== "plot" || !chartState.x || !chartState.y)
        return;
    e.preventDefault();
    chartState.drag = {
        mode: e.button === 1 ? "x" : "pan",
        moved: false,
        pointerId: e.pointerId,
        start: p,
        x: { min: chartState.x.min, max: chartState.x.max },
        y: { min: chartState.y.min, max: chartState.y.max }
    };
    chartState.pointer = p;
    chartStage.classList.add("dragging");
    canvas.setPointerCapture(e.pointerId);
});
function endChartDrag(e) {
    if (!chartState.drag || e.pointerId !== chartState.drag.pointerId) return;
    suppressClickUntil = chartState.drag.moved ? Date.now() + 50 : 0;
    chartState.drag = null;
    chartStage.classList.remove("dragging");
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    setCanvasCursor(chartState.pointer ? "plot" : "none");
    chartState.fastDirty = true;
    dirty = true;
}
canvas.addEventListener("pointerup", endChartDrag);
canvas.addEventListener("pointercancel", endChartDrag);
canvas.addEventListener("auxclick", function (e) {
    if (e.button === 1) e.preventDefault();
});
canvas.addEventListener(
    "wheel",
    function (e) {
        var p = canvasPoint(e),
            region = chartRegion(p.x, p.y);
        if (region === "none" || !chartState.x || !chartState.y) return;
        e.preventDefault();
        var scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1,
            factor = Math.exp(Math.max(-4, Math.min(4, e.deltaY * scale * 0.0015)));
        if (region === "plot" || region === "x") {
            var anchor =
                chartState.x.min + ((p.x - chartState.geometry.padL) / chartState.geometry.pw) * VP.span(chartState.x);
            chartState.x = VP.zoomClamped(chartState.x, factor, anchor, chartState.bounds, minimumXSpan());
            setWindowCustom();
            updateFollowFromView(true);
        }
        if (region === "plot" || region === "y") {
            var minY = Math.max(Number.EPSILON, Math.abs((chartState.y.min + chartState.y.max) / 2) * 1e-12);
            chartState.y = VP.zoom(chartState.y, factor, chartYAt(p.y, chartState.y), minY);
            chartState.autoY = false;
        }
        chartState.pointer = region === "plot" ? p : null;
        chartState.fastDirty = true;
        dirty = true;
    },
    { passive: false }
);
function updateTimelineEndpoint(edge) {
    if (!chartState.bounds || !chartState.x) return;
    var input = edge === "min" ? $("chartFromRange") : $("chartToRange"),
        value = chartState.bounds.min + Number(input.value),
        tolerance = endTolerance();
    chartState.x = VP.updateEndpoint(chartState.x, edge, value, chartState.bounds, minimumXSpan());
    if (edge === "min" && chartState.x.min - chartState.bounds.min <= tolerance)
        chartState.x.min = chartState.bounds.min;
    if (edge === "max" && chartState.bounds.max - chartState.x.max <= tolerance)
        chartState.x.max = chartState.bounds.max;
    chartState.startPinned = chartState.x.min === chartState.bounds.min;
    chartState.follow = chartState.x.max === chartState.bounds.max;
    setWindowCustom();
    chartState.fastDirty = true;
    dirty = true;
}
function beginTimelineEndpoint(edge, event) {
    if (!chartState.bounds || !chartState.x || (event && event.button !== 0)) return;
    chartState.endpointDrag = edge;
    if (event && Number.isFinite(event.pointerId) && event.currentTarget.setPointerCapture)
        event.currentTarget.setPointerCapture(event.pointerId);
}
function endTimelineEndpoint() {
    // Include samples delivered between the last input event and releasing the handle.
    syncTimeBounds();
    chartState.endpointDrag = null;
    chartState.follow = !!(chartState.x && chartState.bounds && chartState.x.max === chartState.bounds.max);
    chartState.fastDirty = true;
    dirty = true;
}
$("chartFromRange").onpointerdown = function (event) {
    beginTimelineEndpoint("min", event);
};
$("chartToRange").onpointerdown = function (event) {
    beginTimelineEndpoint("max", event);
};
$("chartFromRange").oninput = function () {
    updateTimelineEndpoint("min");
};
$("chartToRange").oninput = function () {
    updateTimelineEndpoint("max");
};
$("chartFromRange").onpointerup =
    $("chartFromRange").onpointercancel =
    $("chartFromRange").onlostpointercapture =
    $("chartFromRange").onchange =
        endTimelineEndpoint;
$("chartToRange").onpointerup =
    $("chartToRange").onpointercancel =
    $("chartToRange").onlostpointercapture =
    $("chartToRange").onchange =
        endTimelineEndpoint;
$("chartRangeFill").addEventListener("pointerdown", function (e) {
    if (!chartState.bounds || !chartState.x) return;
    e.preventDefault();
    var fill = this,
        track = $("chartTimeline"),
        startX = e.clientX,
        startRange = { min: chartState.x.min, max: chartState.x.max },
        pointerId = e.pointerId;
    chartState.follow = false;
    fill.classList.add("dragging");
    fill.setPointerCapture(pointerId);
    var move = function (ev) {
        var width = track.getBoundingClientRect().width || 1,
            delta = ((ev.clientX - startX) / width) * VP.span(chartState.bounds);
        chartState.x = VP.panClamped(startRange, delta, chartState.bounds, minimumXSpan());
        snapDraggedRangeEdges();
        setWindowCustom();
        chartState.fastDirty = true;
        dirty = true;
    };
    var end = function (ev) {
        if (ev.pointerId !== pointerId) return;
        fill.classList.remove("dragging");
        if (fill.hasPointerCapture(pointerId)) fill.releasePointerCapture(pointerId);
        fill.removeEventListener("pointermove", move);
        fill.removeEventListener("pointerup", end);
        fill.removeEventListener("pointercancel", end);
    };
    fill.addEventListener("pointermove", move);
    fill.addEventListener("pointerup", end);
    fill.addEventListener("pointercancel", end);
});
function loop(now) {
    draw(now);
    drawFrequencyMotion(now);
    requestAnimationFrame(loop);
}
function renderElfDiagnostics() {
    for (const id of ["elfDiagnostics", "importDiagnostics"])
        EmberProbeRuntime.renderElfDiagnostics($(id), impWarnings, impError, t("common.diagnostics"), t);
}
window.EmberProbeMessages.connect(window, {
    sidebarImportResult: function (m) {
        setStatusKey(
            !m.sourceCount ? "lw.sidebarEmpty" : m.added ? "lw.sidebarImported" : "lw.sidebarAlreadyImported",
            { n: m.added || 0 }
        );
    },
    seriesStyles: function (m) {
        seriesStyles = Styles.clean(m.styles);
        styleRequests.clear();
        renderVars();
        dirty = true;
    },
    watchList: function (m) {
        invalidateSeries();
        var incoming = (m.items || []).slice();
        var removed = watch
            .filter(function (w) {
                return !incoming.some(function (next) {
                    return next.name === w.name;
                });
            })
            .map(function (w) {
                return w.name;
            });
        Analysis.remove(analysis, removed);
        if (removed.includes(analysis.focused))
            hidden = Analysis.restore(
                analysis,
                incoming.map(function (w) {
                    return w.name;
                })
            );
        removed.forEach(function (name) {
            delete data[name];
            delete latest[name];
            delete latestText[name];
            delete latestEnum[name];
            delete latestPointer[name];
            forgetPointers(name);
        });
        // A view saved before pointer curves started hidden keeps the pointer curves it showed.
        if (legacyPointerCurves) {
            incoming.forEach(function (item) {
                if (item.isPointer && hidden[item.name] === undefined) hidden[item.name] = false;
            });
            legacyPointerCurves = false;
            saveUi();
        }
        watch = incoming;
        watch.forEach(hidePointerCurve);
        if (m.resetValues) {
            resetLastPointers(lastPointersVersion);
            watch.forEach(function (item) {
                delete latest[item.name];
                delete latestText[item.name];
                delete latestEnum[item.name];
                delete latestPointer[item.name];
            });
        }
        // Curve visibility is kept for watches missing from this list: a list sent while layouts are
        // still resolving can omit them briefly, and they must come back as the user left them.
        // Removing a watch here (removeVar) is what forgets its curve.
        watch.forEach(function (w) {
            ensureBuf(w.name);
        });
        renderVars();
        dirty = true;
    },
    variablesList: function (m) {
        impWarnings = m.warnings || [];
        impError = m.error || "";
        renderElfDiagnostics();
        var checked = Array.from($("impList").querySelectorAll("input:checked")).map(function (cb) {
            return cb.dataset.leafPath || (allSymbols[Number(cb.dataset.idx)] || {}).name;
        });
        allSymbols = m.symbols || [];
        impTypesReady = true;
        impSymbolByName = new Map(allSymbols.map((symbol) => [symbol.name, symbol]));
        impIndexByName = new Map(allSymbols.map((symbol, index) => [symbol.name, index]));
        renderVars();
        if (wantImportOpen) {
            wantImportOpen = false;
            openImport();
        } else {
            if (!$("overlay").classList.contains("hidden")) {
                renderImport();
                $("impList")
                    .querySelectorAll("input")
                    .forEach(function (cb) {
                        var name = cb.dataset.leafPath || (allSymbols[Number(cb.dataset.idx)] || {}).name;
                        cb.checked = checked.includes(name);
                    });
            }
            renderAutocomplete();
        }
    },
    curveVisibility: function (m) {
        // A panel VS Code restored keeps its own state; a newly opened one adopts the host's copy.
        if (!(saved && saved.hidden) && m.hidden && typeof m.hidden === "object") {
            hidden = Object.create(null);
            Object.keys(m.hidden).forEach(function (name) {
                hidden[name] = !!m.hidden[name];
            });
            renderVars();
            dirty = true;
        }
        curveVisibilityLoaded = true;
        saveUi();
    },
    variablesListReset: function (m) {
        impWarnings = m.warnings || [];
        impError = "";
        renderElfDiagnostics();
        cancelImportMemberSearch();
        impVersion = m.version || "";
        impGeneration = m.generation ?? null;
        if (impVersion && lastPointersVersion && lastPointersVersion !== impVersion) {
            resetLastPointers(impVersion);
            saveUi();
        }
        layoutExpansionUi.reset();
        for (const item of watch) {
            delete item.layoutExpansions;
            item.layoutExpansionGeneration = -1;
        }
        impTypesReady = false;
        allSymbols = [];
        hideAutocomplete();
        impSymbolByName.clear();
        renderVars();
        impIndexByName.clear();
        impTypeChunks = 0;
        impLayoutPending.clear();
        if (!$("overlay").classList.contains("hidden")) renderImport();
    },
    variablesListChunk: function (m) {
        if (m.version !== impVersion) return;
        const symbols = m.symbols || [];
        for (const symbol of symbols) {
            impIndexByName.set(symbol.name, allSymbols.length);
            allSymbols.push(symbol);
            impSymbolByName.set(symbol.name, symbol);
        }
        if (
            !$("overlay").classList.contains("hidden") &&
            (allSymbols.length <= 1000 || allSymbols.length % 10000 < symbols.length)
        )
            renderImport();
    },
    variablesListDone: function (m) {
        if (m.version && m.version !== impVersion) return;
        if (Array.isArray(m.warnings)) impWarnings = m.warnings;
        impError = m.error || "";
        renderElfDiagnostics();
        if (wantImportOpen) {
            wantImportOpen = false;
            openImport();
        } else if (!$("overlay").classList.contains("hidden")) renderImport();
    },
    variableTypes: function (m) {
        if (m.version !== impVersion) return;
        for (const update of m.symbols || []) {
            const symbol = impSymbolByName.get(update.name);
            if (symbol) Object.assign(symbol, update);
        }
        if (++impTypeChunks % 10 === 0 && !$("overlay").classList.contains("hidden")) renderImport();
    },
    variableTypesDone: function (m) {
        if (m.version !== impVersion) return;
        if (Array.isArray(m.warnings)) impWarnings = m.warnings;
        renderElfDiagnostics();
        impTypesReady = true;
        renderVars();
        if (!$("overlay").classList.contains("hidden")) renderImport();
        if ($("acDrop").classList.contains("open")) renderAutocomplete(ambiguityChoices);
    },
    layoutExpansionResult: function (m) {
        layoutExpansionUi.receive(m);
    },
    compositeLayoutResult: function (m) {
        if (m.version !== impVersion) return;
        impLayoutPending.delete(m.name);
        const symbol = impSymbolByName.get(m.name);
        if (!symbol) return;
        const pointerWaiter = pointerLayoutWaiters.delete(m.name);
        if (pointerWaiter && !symbol.isComposite) {
            // Scalars keep their identity; only the type graph is needed to expand them.
            symbol.runtimeLayout = m.layout?.runtimeLayout || null;
            if (symbol.runtimeLayout) renderVars();
            else symbol.layoutError = m.error || t("lw.compositeNoLayout");
            return;
        }
        if (m.layout) {
            symbol.compositeLayout = m.layout;
            symbol.layoutExpansions = m.layoutExpansions;
            symbol.layoutExpansionGeneration = m.layoutExpansionGeneration;
            symbol.runtimeLayout = m.layout.runtimeLayout || null;
            symbol.layoutError = "";
        } else {
            symbol.layoutError = m.error || t("lw.compositeNoLayout");
        }
        if (!$("overlay").classList.contains("hidden")) renderImport();
    },
    addResolved: function (m) {
        if (m.version && m.version !== impVersion) return;
        if (m.requestId !== undefined) {
            if (!currentVariableReply(m)) return;
            $("addName").value = "";
            hideAutocomplete();
        }
        addSymbol(m.symbol, true);
    },
    variableChoices: function (m) {
        if (!currentVariableReply(m)) return;
        // A reply must not steal focus back after the user has moved to another control.
        if (document.activeElement !== $("addName")) return;
        $("addName").focus();
        renderAutocomplete(m.candidates);
    },
    liveSample: function (m) {
        onSamples(m.samples || []);
    },
    liveCompositeSample: function (m) {
        if (running && Number.isFinite(m.actualHz)) $("rate").textContent = rateText(m.actualHz, m.bytesPerSecond);
        onCompositeSamples(m.samples || []);
    },
    debugSessionChanged: function () {
        clearHistory(false);
    },
    liveStatus: function (m) {
        var fresh = window.EmberProbeRuntime.liveState({ running: running }, m).fresh;
        document.body.classList.toggle("debug-stale", !fresh);
        if (typeof m.running === "boolean") {
            running = m.running;
            if (!running) {
                sampleTimes = [];
                $("rate").textContent = rateText(0, 0);
                $("rate").title = "";
            }
        }
        applyUnlimitedStatus(m);
        if (typeof m.actualHz === "number" && running) {
            $("rate").textContent = rateText(m.actualHz, m.bytesPerSecond);
        }
        if (m.effectiveIntervalMs === 0) {
            $("rate").title =
                "Target: unlimited | P95: " +
                (m.p95DurationMs || 0) +
                "ms | Limited by: " +
                (m.limitedBy || "-") +
                " | Host hold: " +
                (m.hostHoldMs || 0) +
                "ms" +
                (m.pauseReason ? " | Paused: " + m.pauseReason : "");
        } else if (m.effectiveIntervalMs !== undefined) {
            var targetHz = m.frequencyHz || requestedFrequencyHz;
            $("rate").title =
                "Target: " +
                targetHz +
                " Hz | Effective: " +
                (1000 / m.effectiveIntervalMs).toFixed(1) +
                " Hz (" +
                m.effectiveIntervalMs +
                " ms) | P95: " +
                (m.p95DurationMs || 0) +
                "ms | Missed: " +
                (m.missedDeadlines || 0) +
                (m.pauseReason ? " | Paused: " + m.pauseReason : "");
        }
        starting = false;
        updateRun();
        m.key || m.message != null
            ? setStatusMsg({ key: m.key, params: m.params, message: m.message }, m.error ? "error" : "")
            : setStatusKey(running ? "sb.sampling" : "sb.stopped", null, m.error ? "error" : "");
    },
    liveError: function (m) {
        if (m.requestId !== undefined) {
            if (!currentVariableReply(m)) return;
            pendingVariableRequest = null;
        }
        setStatusMsg({ key: m.key, params: m.params, message: m.message || t("lw.error") }, "error");
    },
    setLang: function (m) {
        setLang(m.lang, false);
    }
});
$("run").onclick = function () {
    running || starting ? stop() : start();
};
$("import").onclick = function () {
    wantImportOpen = true;
    post({ type: "importVariables", version: impVersion });
};
function addByName() {
    var n = $("addName").value.trim();
    if (!n) return;
    var sym = allSymbols.find(function (s) {
        return s.name === n;
    });
    if (!sym || sym.addressAmbiguous) {
        resolveTypedVariable(n);
        return;
    }
    addSymbol(sym);
    $("addName").value = "";
    hideAutocomplete();
}
$("addName").oninput = function () {
    if (!allSymbols.length) post({ type: "importVariables", version: impVersion });
    renderAutocomplete();
};
$("addName").onblur = function () {
    setTimeout(function () {
        if (document.activeElement !== $("addName")) hideAutocomplete();
    }, 150);
};
$("addName").onkeydown = function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!$("acDrop").classList.contains("open")) renderAutocomplete();
        if (!autocompleteMatches.length) return;
        e.preventDefault();
        var length = autocompleteMatches.length;
        selectAutocomplete(
            autocompleteIndex < 0
                ? e.key === "ArrowDown"
                    ? 0
                    : length - 1
                : (autocompleteIndex + (e.key === "ArrowDown" ? 1 : -1) + length) % length
        );
    } else if (e.key === "Enter") {
        e.preventDefault();
        if (autocompleteIndex >= 0 && $("acDrop").classList.contains("open"))
            acceptAutocomplete(autocompleteMatches[autocompleteIndex]);
        else addByName();
    } else if (e.key === "Escape") {
        e.preventDefault();
        hideAutocomplete();
    }
};
$("impFilter").oninput = renderImport;
$("impFilterClear").onclick = function () {
    $("impFilter").value = "";
    renderImport();
    $("impFilter").focus();
};
$("impCancel").onclick = hideImport;
$("impAdd").onclick = importSelected;
$("clear").onclick = function () {
    clearHistory();
};
$("freeze").onclick = function () {
    if (frozen) resumeChart();
    else freezeChart();
};
$("timeWindow").onchange = function () {
    if (this.value !== "custom") {
        applyWindowPreset(this.value);
        saveUi();
    }
};
$("frequencyToggle").onclick = function () {
    setFrequencyPopup($("frequencyPopup").hidden, true);
};
$("frequencyPreset").oninput = function () {
    if (!frequencyDrag) return selectFrequencyPreset();
    frequencyDrag.position = Math.round(Number(this.value));
    this.value = String(frequencyDrag.position);
    paintFrequencyPosition(frequencyDrag.position, true);
};
$("frequencyPreset").addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || e.isPrimary === false || frequencyDrag) return;
    frequencyDrag = { pointerId: e.pointerId, position: Number(this.value) };
    $("frequencySlider").classList.add("is-dragging");
});
document.addEventListener("pointerup", function (e) {
    if (frequencyDrag && e.pointerId === frequencyDrag.pointerId) finishFrequencyDrag(true);
});
document.addEventListener("pointercancel", function (e) {
    if (frequencyDrag && e.pointerId === frequencyDrag.pointerId) finishFrequencyDrag(false);
});
$("frequencyPreset").addEventListener("lostpointercapture", function (e) {
    if (frequencyDrag && e.pointerId === frequencyDrag.pointerId) finishFrequencyDrag(false);
});
$("frequencyPreset").addEventListener("keydown", function (e) {
    var max = unlimitedState.available ? 4 : 3;
    var index = Math.round(Number(this.value));
    if (e.key === "Home") index = 0;
    else if (e.key === "End") index = max;
    else if (["ArrowLeft", "ArrowDown", "PageDown"].includes(e.key)) index--;
    else if (["ArrowRight", "ArrowUp", "PageUp"].includes(e.key)) index++;
    else return;
    e.preventDefault();
    finishFrequencyDrag(false);
    this.value = String(Math.min(max, Math.max(0, index)));
    selectFrequencyPreset();
});
$("frequency").onchange = function () {
    if (this.value.trim() === "-" && unlimitedState.available && unlimitedState.enabled) return;
    commitFrequency(selectedFrequencyHz());
};
$("frequency").onkeydown = function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
        e.preventDefault();
        this.onchange();
    } else if (e.key === "ArrowDown" && e.altKey) {
        e.preventDefault();
        setFrequencyPopup(true, true);
    }
};
$("frequencyPicker").addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || $("frequencyPopup").hidden) return;
    e.preventDefault();
    e.stopPropagation();
    setFrequencyPopup(false);
    $("frequencyToggle").focus();
});
document.addEventListener("pointerdown", function (e) {
    if (!$("frequencyPicker").contains(e.target)) setFrequencyPopup(false);
});
$("frequencyPicker").addEventListener("focusout", function (e) {
    if (!$("frequencyPicker").contains(e.relatedTarget)) setFrequencyPopup(false);
});
$("norm").onclick = function () {
    axisModes[norm ? "norm" : "raw"] = { y: chartState.y, autoY: chartState.autoY, origin: chartState.axisOrigin };
    norm = !norm;
    var mode = axisModes[norm ? "norm" : "raw"] || { y: null, autoY: true };
    chartState.y = mode.y;
    chartState.axisOrigin = mode.origin;
    chartState.autoY = mode.autoY;
    chartState.visibleKey = "";
    $("norm").classList.toggle("ghost", !norm);
    saveUi();
    chartState.fastDirty = true;
    dirty = true;
};
$("timeWindow").value = windowPreset;
$("export").onclick = showExport;
$("exportCancel").onclick = hideExport;
$("exportApply").onclick = applyExport;
$("exportOverlay").onclick = function (e) {
    if (e.target === $("exportOverlay")) hideExport();
};
$("exportRanges").onchange = setExportTimelineMode;
$("exportFromRange").oninput = function () {
    updateExportTimeline("from");
};
$("exportToRange").oninput = function () {
    updateExportTimeline("to");
};
window.EmberProbeMessages.connect(window, {
    chartHistoryReady: function (m) {
        if (historyClearPending || !Number.isSafeInteger(m.historyRevision) || m.historyRevision < 0) return;
        clearHistory(false);
        historyRevision = m.historyRevision;
        post({ type: "samplingArchiveInfo", historyRevision: historyRevision });
    },
    samplingArchiveInfo: function (m) {
        if ((m.historyRevision ?? 0) !== historyRevision) return;
        if (historyClearPending) return;
        var first = Number(m.firstTimestampMs);
        if (Number(m.rows) > 0 && Number.isFinite(first)) samplingOrigin = first;
        archiveExportInfo = m;
        if (m.openExport) showArchiveExport(m);
    },
    chartValues: function (m) {
        if (!CFG.backendHistory || historyClearPending) return;
        (m.samples || []).forEach(function (sample) {
            latest[sample.name] = sample.value;
            latestText[sample.name] =
                sample.diagnostic?.code === "LIVE_NULL_POINTER" ? t("lw.pointeeNull") : (sample.valueText ?? null);
            latestEnum[sample.name] = sample.enumText ?? null;
            recordPointerSample(sample);
        });
        scheduleValueRefresh();
        applyUnlimitedStatus(m);
        if (running && Number.isFinite(m.actualHz)) $("rate").textContent = rateText(m.actualHz, m.bytesPerSecond);
    },
    chartHistoryStatus: function (m) {
        if (!CFG.backendHistory || historyClearPending || (m.historyRevision ?? 0) !== historyRevision) return;
        if (m.limited && !remoteHistory.liveStatus?.limited) setStatusKey("lw.memoryHistoryLimited", null, "warning");
        remoteHistory.liveStatus = m;
        if (!m.bounds && m.limited && !frozen) {
            remoteHistory.series = [];
            remoteHistory.cachedKey = null;
        }
        if (!frozen) {
            remoteHistory.status = m;
            dirty = true;
        }
        if (samplingOrigin === null && m.bounds) samplingOrigin = m.bounds.min;
    },
    chartViewportResult: function (m) {
        var request = remoteHistory.inFlight;
        if (!request || request.requestId !== m.requestId) return;
        remoteHistory.inFlight = null;
        if (
            m.historyRevision === historyRevision &&
            request.viewKey === remoteHistory.desiredViewKey &&
            (m.snapshotId || null) === remoteHistory.snapshotId
        ) {
            if (m.error) {
                setStatusMsg({ message: m.error }, "error");
                remoteHistory.cachedKey = request.key;
            } else {
                remoteHistory.series = m.series || [];
                remoteHistory.cachedKey = request.key;
            }
            dirty = true;
        }
        if (remoteHistory.pending && remoteHistory.pending.key === remoteHistory.cachedKey)
            remoteHistory.pending = null;
        dispatchChartViewport();
    },
    chartFreezeResult: function (m) {
        if (m.historyRevision !== historyRevision || m.requestId !== remoteHistory.operation) return;
        remoteHistory.operation = null;
        if (m.error) {
            setStatusMsg({ message: m.error }, "error");
            return;
        }
        remoteHistory.snapshotId = m.snapshotId;
        remoteHistory.status = m;
        remoteHistory.cachedKey = null;
        frozen = true;
        $("freeze").textContent = t("lw.resume");
        chartState.follow = false;
        dirty = true;
        chartState.fastDirty = true;
        renderVars();
    },
    samplingHistoryCleared: function (m) {
        if (m.historyRevision === historyRevision) historyClearPending = false;
    },
    exportCsvResult: function (m) {
        if (m.ok) {
            setStatusKey("lw.exportSuccess", { series: m.seriesCount, rows: m.rowCount });
        }
    },
    liveUnlimited: function (m) {
        if (frequencyDrag && unlimitedState.available !== (m.available === true)) finishFrequencyDrag(false);
        if (unlimitedState.enabled !== (m.available === true && m.enabled === true)) sampleTimes = [];
        unlimitedState.available = m.available === true;
        unlimitedState.enabled = unlimitedState.available && m.enabled === true;
        if (!unlimitedState.enabled) unlimitedState.active = false;
        renderUnlimited(true);
    },
    liveFrequency: function (m) {
        if (requestedFrequencyHz !== m.frequencyHz) sampleTimes = [];
        requestedFrequencyHz = m.frequencyHz;
        MAXPTS = retainedSampleLimit(requestedFrequencyHz, m.intervalMs);
        renderUnlimited(true);
    }
});
var layout = $("layout"),
    valuePane = $("valuePane"),
    sideToggle = $("sideToggle");
function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}
// The card keeps its preferred geometry; smaller views shrink and shift it without losing that preference.
function panelGeometry(bounds) {
    var height = valuePanel.h === null ? Math.min(Math.round(bounds.height * 0.6), 460) : valuePanel.h;
    var w = clampNumber(valuePanel.w, PANEL_MIN_WIDTH, bounds.width - 2 * PANEL_MARGIN);
    var h = clampNumber(height, PANEL_MIN_HEIGHT, bounds.height - 2 * PANEL_MARGIN);
    var x = valuePanel.dockRight ? bounds.width - PANEL_MARGIN - w : valuePanel.x;
    var y = valuePanel.dockBottom ? bounds.height - PANEL_MARGIN - h : valuePanel.y;
    return {
        x: Math.round(clampNumber(x, PANEL_MARGIN, bounds.width - PANEL_MARGIN - w)),
        y: Math.round(clampNumber(y, PANEL_MARGIN, bounds.height - PANEL_MARGIN - h)),
        w: Math.round(w),
        h: Math.round(h)
    };
}
function applyPanelGeometry() {
    var bounds = layout.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    var g = panelGeometry(bounds);
    valuePane.style.left = g.x + "px";
    valuePane.style.top = g.y + "px";
    valuePane.style.width = g.w + "px";
    valuePane.style.height = g.h + "px";
}
// Cards moved against the right or bottom edge stay docked there when the view is resized.
function setPanelGeometry(g, bounds) {
    var x = Math.round(clampNumber(g.x, PANEL_MARGIN, bounds.width - PANEL_MARGIN - g.w)),
        y = Math.round(clampNumber(g.y, PANEL_MARGIN, bounds.height - PANEL_MARGIN - g.h)),
        right = bounds.width - PANEL_MARGIN - x - g.w,
        bottom = bounds.height - PANEL_MARGIN - y - g.h;
    valuePanel = {
        x: x,
        y: y,
        w: Math.round(g.w),
        h: Math.round(g.h),
        dockRight: right <= 1 && x > PANEL_MARGIN + 1,
        dockBottom: bottom <= 1 && y > PANEL_MARGIN + 1
    };
    applyPanelGeometry();
    arrangeVariableCards();
}
function movedPanel(start, dx, dy) {
    return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
}
// Dragging a north or west edge keeps the opposite edge where it was.
function resizedPanel(start, edge, dx, dy, bounds) {
    var g = { x: start.x, y: start.y, w: start.w, h: start.h };
    if (edge.indexOf("e") >= 0) g.w = clampNumber(start.w + dx, PANEL_MIN_WIDTH, bounds.width - PANEL_MARGIN - start.x);
    if (edge.indexOf("s") >= 0)
        g.h = clampNumber(start.h + dy, PANEL_MIN_HEIGHT, bounds.height - PANEL_MARGIN - start.y);
    if (edge.indexOf("w") >= 0) {
        g.w = clampNumber(start.w - dx, PANEL_MIN_WIDTH, start.x + start.w - PANEL_MARGIN);
        g.x = start.x + start.w - g.w;
    }
    if (edge.indexOf("n") >= 0) {
        g.h = clampNumber(start.h - dy, PANEL_MIN_HEIGHT, start.y + start.h - PANEL_MARGIN);
        g.y = start.y + start.h - g.h;
    }
    return g;
}
function applySideLayout() {
    layout.classList.toggle("side-collapsed", sideCollapsed);
    sideToggle.setAttribute("aria-expanded", String(!sideCollapsed));
    sideToggle.setAttribute("aria-controls", "vars");
    sideToggle.setAttribute("aria-label", sideCollapsed ? t("lw.expandPane") : t("lw.collapsePane"));
    sideToggle.textContent = (sideCollapsed ? "› " : "‹ ") + t("lw.valuePane");
    sideToggle.title = sideCollapsed ? t("lw.expandPane") : t("lw.collapsePane");
    $("panelHandle").setAttribute("aria-label", t("lw.panelMoveHint"));
    $("panelResize").setAttribute("aria-label", t("lw.panelResizeHint"));
    applyPanelGeometry();
    arrangeVariableCards();
    dirty = true;
}
sideToggle.onclick = function () {
    sideCollapsed = !sideCollapsed;
    applySideLayout();
    saveUi();
};
function trackPanelPointer(target, e, update) {
    if (e.button !== 0) return;
    e.preventDefault();
    var bounds = layout.getBoundingClientRect(),
        start = panelGeometry(bounds),
        startX = e.clientX,
        startY = e.clientY;
    valuePane.classList.add("dragging");
    target.classList.add("active");
    target.setPointerCapture(e.pointerId);
    var move = function (ev) {
        if (ev.pointerId !== e.pointerId) return;
        setPanelGeometry(update(start, ev.clientX - startX, ev.clientY - startY, bounds), bounds);
    };
    var end = function (ev) {
        if (ev.pointerId !== e.pointerId) return;
        valuePane.classList.remove("dragging");
        target.classList.remove("active");
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", end);
        target.removeEventListener("pointercancel", end);
        target.removeEventListener("lostpointercapture", end);
        if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
        saveUi();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
    target.addEventListener("lostpointercapture", end);
}
function nudgePanel(e, update) {
    var step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    var bounds = layout.getBoundingClientRect(),
        size = e.shiftKey ? 50 : 10;
    setPanelGeometry(update(panelGeometry(bounds), step[0] * size, step[1] * size, bounds), bounds);
    saveUi();
}
$("panelHandle").addEventListener("pointerdown", function (e) {
    trackPanelPointer(e.currentTarget, e, movedPanel);
});
$("panelHandle").addEventListener("keydown", function (e) {
    nudgePanel(e, movedPanel);
});
valuePane.querySelectorAll(".float-resize").forEach(function (handle) {
    var resize = function (start, dx, dy, bounds) {
        return resizedPanel(start, handle.dataset.edge, dx, dy, bounds);
    };
    handle.addEventListener("pointerdown", function (e) {
        trackPanelPointer(handle, e, resize);
    });
    handle.addEventListener("keydown", function (e) {
        nudgePanel(e, resize);
    });
});
applySideLayout();
new ResizeObserver(function () {
    applyPanelGeometry();
}).observe(layout);
new ResizeObserver(function () {
    arrangeVariableCards();
}).observe(valuePane);
window.addEventListener("resize", function () {
    applyPanelGeometry();
    arrangeVariableCards();
    if (!$("frequencyPopup").hidden) positionFrequencyPopup();
});
new ResizeObserver(function () {
    dirty = true;
}).observe($("chartWrap"));
// VS Code updates body classes when its theme changes. Repaint frozen charts too.
new MutationObserver(function () {
    dirty = true;
}).observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
renderUnlimited(true);
updateRun();
updateLangToggle();
if (norm) $("norm").classList.remove("ghost");
var _lt = $("langToggle");
if (_lt)
    _lt.onclick = function () {
        setLang(LANG === "zh" ? "en" : "zh", true);
    };
post({ type: "samplingArchiveInfo", historyRevision: historyRevision });
post({ type: "ready" });
requestAnimationFrame(loop);
