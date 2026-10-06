const api = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null,
    dot = document.getElementById("statusDot"),
    text = document.getElementById("statusText"),
    log = document.getElementById("openocdLog"),
    openocdCard = document.getElementById("openocdCard"),
    openocdMessage = document.getElementById("openocdMessage"),
    openocdInstall = document.getElementById("openocdInstall"),
    liveBox = document.getElementById("liveValues"),
    liveCard = liveBox && liveBox.closest(".live-box"),
    writeBox = document.getElementById("writeValues"),
    availableBox = document.getElementById("availableVars"),
    liveState = document.getElementById("liveState"),
    liveLabel = document.getElementById("liveLabel"),
    liveToggle = document.getElementById("liveToggle"),
    langToggle = document.getElementById("langToggle");
function showProbeDiagnostic(message) {
    const diagnostic = message.diagnostic;
    if (!diagnostic) return;
    const panel = document.getElementById("probeDiagnostic");
    const output = document.getElementById("probeDiagnosticText");
    output.textContent = JSON.stringify(diagnostic, null, 2);
    panel.hidden = false;
}
document.getElementById("probeDiagnosticCopy").addEventListener("click", () => {
    api?.postMessage({ type: "copyText", text: document.getElementById("probeDiagnosticText").textContent });
});
let sideWatch = [],
    writeList = [],
    available = [],
    availableByName = new Map(),
    availableVersion = "",
    availableTypesReady = true,
    availableLayoutPending = new Set(),
    availableAddPending = new Set(),
    availableTypeChunks = 0,
    availableSearchTimer = null,
    availableSearchQuery = "",
    latest = Object.create(null),
    latestText = Object.create(null),
    liveRunning = false,
    liveCanRead = false,
    liveCanWrite = false,
    liveSnapshotReady = true,
    variableError = "",
    variableErrorKey = "",
    variableErrorParams = null,
    lastSkill = { state: "checking" },
    uiState = api && api.getState ? api.getState() || {} : {};
let sbExpanded = (uiState && uiState.sbExpanded) || Object.create(null),
    compCells = Object.create(null),
    avExpanded = Object.create(null),
    writeCells = Object.create(null),
    writeTimers = Object.create(null),
    writeLastAt = Object.create(null),
    latestWriteSeq = Object.create(null),
    writeSeq = 0,
    writeFbTimer = null,
    runtimeBodies = Object.create(null);
function shiftSliderBounds(min, max, current, next) {
    const lo = Number(min),
        hi = Number(max),
        from = Number(current),
        to = Number(next);
    if (![lo, hi, from, to].every(Number.isFinite) || hi <= lo || (to >= lo && to <= hi)) return { min: lo, max: hi };
    const span = hi - lo,
        anchor = Math.min(hi, Math.max(lo, from)),
        offset = anchor - lo,
        newMin = to - offset;
    return { min: newMin, max: newMin + span };
}
var I18N = window.__I18N__ || { zh: {}, en: {} };
var LANG = window.__LANG__ === "en" ? "en" : "zh";
function t(k, p) {
    return window.EmberProbeRuntime.translate(I18N, LANG, k, p);
}
function msgText(m) {
    return m && m.key ? t(m.key, m.params) : m && m.message != null ? m.message : "";
}
var lastOpenocd = { state: "checking" },
    lastLive = { running: false, key: "sb.waiting" },
    lastChip = { state: "idle" },
    lastSvd = { state: "idle", key: "svd.notConfigured" },
    lastChipInfo = null,
    logEvents = [],
    lastStatus = null;
const chipRead = document.getElementById("chipRead"),
    chipState = document.getElementById("chipState"),
    chipLabel = document.getElementById("chipLabel"),
    chipBody = document.getElementById("chipBody"),
    svdStatusEl = document.getElementById("svdStatus"),
    svdSelect = document.getElementById("svdSelect"),
    svdDownload = document.getElementById("svdDownload"),
    jlinkDriverChoice = document.getElementById("jlinkDriverChoice"),
    jlinkDriverBusy = document.getElementById("jlinkDriverBusy"),
    otherConfig = document.getElementById("otherConfig");
const peripheralView = window.EmberProbePeripheralView?.create({ api, t, uiState });
const rtosView = window.EmberProbeRtosView?.create({ api, t, uiState });
const memoryView = window.EmberProbeMemoryView?.create({ api, t, uiState });
const mcuConfigSection = document.getElementById("mcuConfigSection");
const memoryAnalysisSection = document.getElementById("memoryAnalysisSection");
for (const id of [
    "mcuConfigSection",
    "memoryAnalysisSection",
    "chipInfoSection",
    "liveValuesSection",
    "variableBrowser"
]) {
    const section = document.getElementById(id);
    if (!section) continue;
    if (typeof uiState.sections?.[id] === "boolean") section.open = uiState.sections[id];
    const saveSection = () => {
        uiState.sections ||= {};
        uiState.sections[id] = section.open;
        api?.setState?.(uiState);
    };
    section.addEventListener("toggle", saveSection);
    // Save summary clicks immediately: a view may be hidden before the queued toggle event fires.
    section.querySelector(":scope > summary")?.addEventListener("click", () => {
        queueMicrotask(saveSection);
    });
}
let chipHasData = false,
    chipMoreOpen = !!(uiState && uiState.chipMoreOpen),
    probeDriverBusy = false,
    confirmedProbeDriver = "";
function setProbeDriverBusy(busy) {
    probeDriverBusy = busy;
    if (jlinkDriverChoice) jlinkDriverChoice.disabled = busy;
    if (jlinkDriverBusy) jlinkDriverBusy.hidden = !busy;
    if (chipRead) chipRead.disabled = busy || lastChip.state === "reading";
    chipBody?.querySelectorAll(".chip-control").forEach((button) => {
        button.disabled = busy || lastChip.state === "reading";
    });
    liveToggle.disabled = busy;
    document.querySelectorAll(".primary-actions [data-command]").forEach((button) => (button.disabled = busy));
}
function configurationIncomplete() {
    if (!mcuConfigSection) return false;
    return ["mcu-vscode.selectElf", "mcu-vscode.selectDebugger", "mcu-vscode.selectMcuCore"].some((command) => {
        const row = mcuConfigSection.querySelector(`[data-command="${command}"]`);
        const value = row?.querySelector("small");
        return !value || value.dataset.i18n === "common.notSelected" || !value.textContent.trim();
    });
}
function revealIncompleteConfiguration() {
    if (!configurationIncomplete() || !mcuConfigSection || mcuConfigSection.open) return;
    mcuConfigSection.open = true;
    uiState.sections ||= {};
    uiState.sections.mcuConfigSection = true;
    api?.setState?.(uiState);
}
if (otherConfig) {
    otherConfig.open = !!(uiState && uiState.otherConfigOpen);
    otherConfig.addEventListener("toggle", () => {
        uiState.otherConfigOpen = otherConfig.open;
        if (api && api.setState) api.setState(uiState);
    });
}
function chipStatusLabel(st) {
    return t(
        { idle: "sb.notConnected", reading: "chip.stReading", ready: "chip.done", error: "chip.stError" }[st] ||
            "sb.notConnected"
    );
}
const CHIP_STATE_TEXT = {
    running: "Running",
    halted: "Halted",
    reset: "Reset",
    "debug-running": "Debug",
    sleeping: "Sleeping",
    unknown: "Unknown"
};
const CHIP_ICON =
    '<svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/></svg>';
function setStat(cls, key, params, txt) {
    var s = key ? t(key, params) : txt != null ? txt : "";
    dot.className = "status-dot " + cls;
    dot.title = s;
    text.textContent = s;
    lastStatus = { cls: cls, key: key || "", params: params || null, text: s };
}
function applyStatus() {
    if (lastStatus) setStat(lastStatus.cls, lastStatus.key, lastStatus.params, lastStatus.text);
}
function applyI18n() {
    var i, els;
    els = document.querySelectorAll("[data-i18n]");
    for (i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute("data-i18n"));
    els = document.querySelectorAll("[data-i18n-title]");
    for (i = 0; i < els.length; i++) els[i].title = t(els[i].getAttribute("data-i18n-title"));
    els = document.querySelectorAll("[data-i18n-ph]");
    for (i = 0; i < els.length; i++) els[i].placeholder = t(els[i].getAttribute("data-i18n-ph"));
}
function renderLog() {
    log.textContent = "";
    logEvents.forEach(function (ev) {
        var line = document.createElement("div");
        line.className = ev.level || "";
        line.textContent = "• " + msgText(ev);
        log.appendChild(line);
    });
}
function updateLangToggle() {
    if (langToggle) {
        langToggle.textContent = LANG === "zh" ? "EN" : "中";
        langToggle.title = t("common.langTitle");
        langToggle.setAttribute("aria-label", t("common.langTitle"));
    }
    document.getElementById("githubLink").setAttribute("aria-label", t("sb.githubRepo"));
}
function rerenderDynamic() {
    if (variableErrorKey) variableError = t(variableErrorKey, variableErrorParams);
    renderValues();
    renderWrites();
    renderAvailable();
    applyFolds();
    renderSkillStatus(lastSkill);
    liveStatus(lastLive);
    openocdStatus(lastOpenocd);
    chipStatus(lastChip);
    svdStatus(lastSvd);
    peripheralView?.render();
    rtosView?.render();
    memoryView?.render();
    if (chipHasData && lastChipInfo) renderChip(lastChipInfo);
    renderLog();
    applyStatus();
}
function setLang(l, notify) {
    LANG = l === "en" ? "en" : "zh";
    document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
    uiState.lang = LANG;
    if (api && api.setState) api.setState(uiState);
    applyI18n();
    rerenderDynamic();
    updateLangToggle();
    if (notify && api) api.postMessage({ type: "setLang", lang: LANG });
}
function fmt(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    v = Number(v);
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a !== 0 && (a >= 1e7 || a < 1e-4) ? v.toExponential(4) : String(Number(v.toFixed(5)));
}
function fmtExact(value, valueText) {
    return valueText !== null && valueText !== undefined ? String(valueText) : fmt(value);
}
function setDisplayedValue(cell, value) {
    if (cell.textContent !== value) cell.textContent = value;
    if (cell.title !== value) cell.title = value;
}
function saveSideWatch() {
    if (api) api.postMessage({ type: "saveSidebarWatch", items: sideWatch });
}
function saveWriteList() {
    if (api) api.postMessage({ type: "saveSidebarWrite", items: writeList });
}
function sbBaseNameOf(n) {
    return EmberProbeRuntime.variableBaseName(String(n));
}
function sbDisplayName(item) {
    return EmberProbeRuntime.variableDisplayName(item, {
        get: (name) => {
            const symbol = availableByName.get(name);
            if (symbol?.displayName && symbol.displayName !== symbol.name) return symbol;
            return (
                sideWatch.find((entry) => entry.name === name) ||
                writeList.find((entry) => entry.name === name) ||
                symbol
            );
        }
    });
}
function sbIsLeafChild(name) {
    const b = sbBaseNameOf(name);
    if (b === name) return false;
    return sideWatch.some((w) => w.name === b && sbIsComposite(w));
}
function sbCollectLeaves(layout, name, baseAddr) {
    const out = [];
    (function walk(lyt, path, off, isConst = false, depth = 0) {
        if (!lyt || depth > 12 || out.length >= 1000) return;
        isConst ||= !!lyt.isConst;
        if (lyt.kind === "struct" || lyt.kind === "union" || lyt.kind === "class") {
            (lyt.members || []).forEach((m) => {
                if (out.length >= 1000) return;
                const cp = m.name ? path + "." + m.name : path,
                    mo = off + (Number(m.offset) || 0);
                if (m.compositeLayout) walk(m.compositeLayout, cp, mo, isConst || !!m.isConst, depth + 1);
                else if (m.watchType)
                    out.push({
                        path: cp,
                        label: cp.slice(name.length),
                        address: (baseAddr + mo) >>> 0,
                        size: Number(m.byteSize) || LEAF_W[m.watchType],
                        type: m.watchType,
                        ...(m.isBoolean ? { isBoolean: true } : {}),
                        ...(Number.isInteger(m.bitSize) ? { bitSize: m.bitSize, bitOffset: m.bitOffset } : {}),
                        ...(m.isConst || isConst ? { isConst: true } : {}),
                        ...(m.isReference ? { isReference: true } : {}),
                        ...(m.isMemberPointer ? { isMemberPointer: true } : {})
                    });
            });
        } else if (lyt.kind === "array") {
            const et = lyt.elementType || {},
                total = Number(lyt.totalElements) || 0,
                es = Number(et.byteSize) || 0,
                end = Math.min(total, 16);
            for (let i = 0; i < end && out.length < 1000; i++) {
                const cp = path + "[" + i + "]",
                    eo = off + i * es;
                if (et.compositeLayout) walk(et.compositeLayout, cp, eo, isConst || !!et.isConst, depth + 1);
                else if (et.watchType)
                    out.push({
                        path: cp,
                        label: cp.slice(name.length),
                        address: (baseAddr + eo) >>> 0,
                        size: es,
                        type: et.watchType,
                        ...(et.isBoolean ? { isBoolean: true } : {}),
                        ...(et.isConst || isConst ? { isConst: true } : {}),
                        ...(et.isReference ? { isReference: true } : {}),
                        ...(et.isMemberPointer ? { isMemberPointer: true } : {})
                    });
            }
        }
    })(layout, name, 0);
    return out;
}
const LEAF_W = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 };
function sbRemove(name, isComp) {
    if (isComp) {
        sideWatch = sideWatch.filter((w) => w.name !== name && sbBaseNameOf(w.name) !== name);
        Object.keys(sbExpanded).forEach((key) => {
            if (key === name || key.startsWith(name + ".") || key.startsWith(name + "[")) delete sbExpanded[key];
        });
    } else {
        sideWatch = sideWatch.filter((w) => w.name !== name);
    }
    delete latest[name];
    delete latestText[name];
}
function sbToggle(entry) {
    if (sideWatch.some((w) => w.name === entry.name)) {
        sbRemove(entry.name, !!entry.isComposite);
    } else {
        sideWatch.push(entry);
        if (entry.isComposite) sbExpanded[entry.name] = true;
    }
    renderValues();
    renderAvailable();
    saveSideWatch();
    saveSbUi();
}
function renderValues() {
    liveBox.textContent = "";
    compCells = Object.create(null);
    runtimeBodies = Object.create(null);
    document.getElementById("watchCount").textContent = String(
        sideWatch.filter((it) => !sbIsLeafChild(it.name)).length
    );
    if (!sideWatch.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = t("sb.watchEmpty");
        liveBox.appendChild(e);
        return;
    }
    sideWatch.forEach((item) => {
        if (sbIsComposite(item)) {
            sbRenderComposite(item);
            return;
        }
        if (sbIsLeafChild(item.name)) return;
        const row = document.createElement("div");
        row.className = "value-row";
        const n = document.createElement("span");
        n.className = "value-name";
        EmberProbeRuntime.renderVariableName(n, sbDisplayName(item), item.name);
        const val = document.createElement("span");
        val.className = "value-number";
        val.dataset.valueName = item.name;
        setDisplayedValue(val, fmtExact(latest[item.name], latestText[item.name]));
        const ty = document.createElement("span");
        ty.className = "value-type";
        ty.textContent = item.type || "u32";
        const nameWrap = document.createElement("span");
        nameWrap.className = "value-name-wrap";
        nameWrap.append(n, ty);
        const rm = document.createElement("button");
        rm.className = "watch-remove";
        rm.textContent = "✕";
        rm.title = t("sb.removeFromWatch");
        rm.onclick = () => {
            sideWatch = sideWatch.filter((w) => w.name !== item.name);
            renderValues();
            renderAvailable();
            saveSideWatch();
        };
        val.title = t("common.copy");
        val.addEventListener("click", (event) => {
            event.stopPropagation();
            if (api && val.textContent) api.postMessage({ type: "copyText", text: val.textContent });
        });
        row.append(nameWrap, val, rm);
        liveBox.appendChild(row);
    });
}
const AVAILABLE_VARIABLE_LIMIT = 500;
const AVAILABLE_ROW_LIMIT = AVAILABLE_VARIABLE_LIMIT * 2;
function needsAvailableLayout(symbol) {
    return symbol.isComposite && !symbol.compositeLayout && !symbol.runtimeLayout && !symbol.layoutError;
}
function scheduleAvailableMemberSearch(query) {
    if (query !== availableSearchQuery || !query || !availableTypesReady) {
        clearTimeout(availableSearchTimer);
        availableSearchTimer = null;
        availableSearchQuery = query;
    }
    if (!query || !availableTypesReady || !api || availableSearchTimer !== null) return;
    availableSearchTimer = setTimeout(() => {
        availableSearchTimer = null;
        const slots = Math.max(0, 4 - availableLayoutPending.size);
        available
            .filter((symbol) => needsAvailableLayout(symbol) && !availableLayoutPending.has(symbol.name))
            .slice(0, slots)
            .forEach((symbol) => {
                availableLayoutPending.add(symbol.name);
                api.postMessage({ type: "resolveCompositeLayout", name: symbol.name, version: availableVersion });
            });
    }, 180);
}
function renderAvailable() {
    availableBox.textContent = "";
    document.getElementById("allCount").textContent = String(available.length);
    if (variableError) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = variableError;
        availableBox.appendChild(e);
        return;
    }
    const query = document.getElementById("varSearch").value.trim().toLowerCase();
    scheduleAvailableMemberSearch(query);
    const selected = new Set(sideWatch.map((w) => w.name));
    const nameMatches = (symbol) =>
        symbol.name.toLowerCase().includes(query) || sbDisplayName(symbol).toLowerCase().includes(query);
    const memberMatches = new Map();
    const matching = available.filter((symbol) => {
        if (!query || nameMatches(symbol)) return true;
        if (!symbol.isComposite) return false;
        const runtime = EmberProbeRuntime.runtimeSelection(symbol, latest[symbol.name]);
        const leaves = runtime?.entries || sbCollectLeaves(symbol.compositeLayout, symbol.name, symbol.address);
        const matches = leaves.filter(
            (leaf) =>
                leaf.path.toLowerCase().includes(query) ||
                sbDisplayName({ name: leaf.path }).toLowerCase().includes(query)
        );
        if (!matches.length) return false;
        memberMatches.set(symbol.name, matches);
        return true;
    });
    const list = matching.slice(0, AVAILABLE_VARIABLE_LIMIT);
    let leafRows = 0;
    if (!list.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent =
            query && (!availableTypesReady || available.some(needsAvailableLayout))
                ? t("sb.searchingMembers")
                : available.length
                  ? t("sb.noMatch")
                  : t("sb.noImportable");
        availableBox.appendChild(e);
        return;
    }
    list.forEach((sym) => {
        if (sym.isComposite) {
            let open = !!avExpanded[sym.name] || memberMatches.has(sym.name);
            const row = document.createElement("div");
            row.className = "available-row comp";
            const wrap = document.createElement("span");
            wrap.className = "av-name-wrap";
            const arrow = document.createElement("span");
            arrow.className = "av-arrow" + (open ? " open" : "");
            arrow.textContent = "\u25B6";
            const nm = document.createElement("span");
            nm.className = "available-name";
            const on = selected.has(sym.name);
            EmberProbeRuntime.renderVariableName(nm, sbDisplayName(sym), sym.name);
            nm.title += "\n" + (on ? t("sb.removeFromWatch") : t("sb.compositeAddWhole"));
            const compEntry = {
                name: sym.name,
                displayName: sbDisplayName(sym),
                address: Number(sym.address) || 0,
                size: Number(sym.size) || 4,
                type: "",
                isComposite: true,
                compositeLayout: sym.compositeLayout || null,
                ...(EmberProbeRuntime.runtimeGraph(sym) ? { runtimeLayout: EmberProbeRuntime.runtimeGraph(sym) } : {})
            };
            wrap.append(
                arrow,
                mkWatchBtn(
                    sym.name,
                    !availableTypesReady || !!sym.layoutError,
                    sym.layoutError || sym.unsupportedReason || t("lw.compositeNoLayout"),
                    () => {
                        if (
                            sideWatch.some((item) => item.name === sym.name) ||
                            sym.compositeLayout ||
                            sym.runtimeLayout
                        ) {
                            sbToggle(compEntry);
                        } else if (!availableLayoutPending.has(sym.name)) {
                            availableAddPending.add(sym.name);
                            availableLayoutPending.add(sym.name);
                            api?.postMessage({
                                type: "resolveCompositeLayout",
                                name: sym.name,
                                version: availableVersion
                            });
                        }
                    }
                ),
                nm
            );
            const ty = document.createElement("span");
            ty.className = "available-type";
            ty.textContent = sym.typeName || t("lw.unknownType");
            row.append(wrap, ty);
            availableBox.appendChild(row);
            const kids = document.createElement("div");
            kids.className = "av-children" + (open ? " open" : "");
            let ownLeafRows = 0;
            const populate = () => {
                leafRows -= ownLeafRows;
                ownLeafRows = 0;
                kids.textContent = "";
                if (!sym.compositeLayout && !sym.runtimeLayout) {
                    const note = document.createElement("div");
                    note.className = "sb-note";
                    note.textContent = sym.layoutError || sym.unsupportedReason || t("lw.compositeNoLayout");
                    kids.appendChild(note);
                    return;
                }
                const runtime = EmberProbeRuntime.runtimeSelection(sym, latest[sym.name]);
                const leaves =
                    memberMatches.get(sym.name) ||
                    runtime?.entries ||
                    sbCollectLeaves(sym.compositeLayout, sym.name, sym.address);
                if (runtime)
                    sbNote(
                        kids,
                        t(
                            runtime.sampled
                                ? "lw.runtimeMembersReadOnly"
                                : runtime.entries.length
                                  ? "lw.runtimeMembersSelectable"
                                  : "lw.runtimeMembersHint"
                        )
                    );
                const shownLeaves = Math.min(leaves.length, Math.max(0, AVAILABLE_ROW_LIMIT - list.length - leafRows));
                leaves.slice(0, shownLeaves).forEach((lf) => {
                    const lb = document.createElement("div");
                    lb.className = "available-row leaf";
                    const cell = document.createElement("span");
                    cell.className = "av-name-cell";
                    const leafEntry = {
                        name: lf.path,
                        displayName: sbDisplayName({ name: lf.path, displayName: lf.displayName }),
                        address: lf.address,
                        size: lf.size || LEAF_W[lf.type] || 4,
                        type: lf.type,
                        ...(lf.isBoolean ? { isBoolean: true } : {}),
                        ...(Number.isInteger(lf.bitSize) ? { bitSize: lf.bitSize, bitOffset: lf.bitOffset } : {}),
                        ...(lf.isConst ? { isConst: true } : {}),
                        ...(lf.isReference ? { isReference: true } : {}),
                        ...(lf.isMemberPointer ? { isMemberPointer: true } : {}),
                        ...(lf.runtimeLayout
                            ? {
                                  runtimeLayout: lf.runtimeLayout,
                                  runtimeSegments: lf.runtimeSegments,
                                  ...(lf.runtimeStaticPointers ? { runtimeStaticPointers: true } : {}),
                                  compositeLayout: lf.compositeLayout,
                                  isComposite: lf.isComposite
                              }
                            : {})
                    };
                    cell.appendChild(mkWriteBtn(leafEntry));
                    cell.appendChild(mkWatchBtn(lf.path, false, "", () => sbToggle(leafEntry)));
                    const ln = document.createElement("span");
                    ln.className = "av-leaf-name";
                    ln.textContent = lf.label;
                    ln.title = leafEntry.displayName;
                    cell.appendChild(ln);
                    const lty = document.createElement("span");
                    lty.className = "available-type";
                    lty.textContent = lf.type || (lf.isComposite ? t("lw.compositeType") : "");
                    lb.append(cell, lty);
                    lb.onclick = () => sbToggle(leafEntry);
                    kids.appendChild(lb);
                });
                ownLeafRows = shownLeaves;
                leafRows += shownLeaves;
                if (leaves.length > shownLeaves) {
                    const note = document.createElement("div");
                    note.className = "sb-note";
                    note.textContent = t("lw.arrayMore", { n: leaves.length - shownLeaves });
                    kids.appendChild(note);
                }
            };
            if (open) populate();
            availableBox.appendChild(kids);
            const toggle = (e) => {
                e.preventDefault();
                e.stopPropagation();
                open = !open;
                avExpanded[sym.name] = open;
                arrow.classList.toggle("open", open);
                kids.classList.toggle("open", open);
                if (open) {
                    populate();
                    if (
                        !sym.compositeLayout &&
                        !sym.runtimeLayout &&
                        !sym.layoutError &&
                        !availableLayoutPending.has(sym.name)
                    ) {
                        availableLayoutPending.add(sym.name);
                        api?.postMessage({ type: "resolveCompositeLayout", name: sym.name, version: availableVersion });
                    }
                } else {
                    leafRows -= ownLeafRows;
                    ownLeafRows = 0;
                    kids.textContent = "";
                }
            };
            arrow.onclick = toggle;
            nm.onclick = (event) => {
                if (!sym.compositeLayout && !sym.runtimeLayout) return toggle(event);
                sbToggle({
                    name: sym.name,
                    displayName: sbDisplayName(sym),
                    address: Number(sym.address) || 0,
                    size: Number(sym.size) || 4,
                    type: "",
                    isComposite: true,
                    compositeLayout: sym.compositeLayout || null,
                    ...(EmberProbeRuntime.runtimeGraph(sym)
                        ? { runtimeLayout: EmberProbeRuntime.runtimeGraph(sym) }
                        : {})
                });
            };
        } else {
            const noLayout = sym.isComposite && !sym.compositeLayout && !sym.runtimeLayout;
            const b = document.createElement("div");
            b.className = "available-row" + (noLayout ? " off" : "");
            const already = selected.has(sym.name);
            b.title = noLayout
                ? sym.unsupportedReason || t("sb.compositeUnsupported")
                : already
                  ? t("sb.removeFromWatch")
                  : "";
            const cell = document.createElement("span");
            cell.className = "av-name-cell";
            const entry = {
                name: sym.name,
                displayName: sbDisplayName(sym),
                address: Number(sym.address) || 0,
                size: Number(sym.size) || 4,
                type: sym.watchType,
                ...(sym.isBoolean ? { isBoolean: true } : {})
            };
            cell.appendChild(
                mkWriteBtn(
                    entry,
                    !availableTypesReady || noLayout || !sym.hasDwarfWriteType,
                    noLayout ? sym.unsupportedReason || t("sb.compositeUnsupported") : t("sb.writeUnsupported")
                )
            );
            cell.appendChild(
                mkWatchBtn(
                    sym.name,
                    !availableTypesReady || noLayout,
                    sym.unsupportedReason || t("sb.compositeUnsupported"),
                    () => sbToggle(entry)
                )
            );
            const n = document.createElement("span");
            n.className = "available-name";
            EmberProbeRuntime.renderVariableName(n, sbDisplayName(sym), sym.name);
            cell.appendChild(n);
            const ty = document.createElement("span");
            ty.className = "available-type";
            ty.textContent = sym.typeName || sym.watchType || t("sb.composite");
            b.append(cell, ty);
            if (!noLayout) b.onclick = () => sbToggle(entry);
            availableBox.appendChild(b);
        }
    });
    if (matching.length > list.length) {
        const note = document.createElement("div");
        note.className = "sb-note";
        note.textContent = t("lw.showingFirst", { n: list.length });
        availableBox.appendChild(note);
    }
}
function sbIsComposite(it) {
    return !!(it && it.isComposite && (it.compositeLayout || it.runtimeLayout));
}
// 写入列表：与查看列表共用 ELF 变量栏添加；拖动时最多 10 Hz 连续写入，结果由 writeResult 反馈
const WRITE_INTERVAL_MS = 100;
const TYPE_RANGE = {
    u8: [0, 255],
    i8: [-128, 127],
    u16: [0, 65535],
    i16: [-32768, 32767],
    u32: [0, 4294967295],
    i32: [-2147483648, 2147483647]
};
function isWideInt(type) {
    return type === "u64" || type === "i64";
}
function isFloat(type) {
    return type === "f32" || type === "f64";
}
function defBounds(type) {
    if (isWideInt(type)) return null;
    if (isFloat(type)) return [-1, 1];
    const r = TYPE_RANGE[type];
    if (type === "u8" || type === "i8" || type === "u16" || type === "i16") return [r[0], r[1]];
    return [0, 100];
}
function clampToType(v, type) {
    if (!Number.isFinite(v)) return 0;
    const r = TYPE_RANGE[type];
    if (!r) return v;
    return Math.min(r[1], Math.max(r[0], Math.round(v)));
}
function normalizeWideInteger(raw, type) {
    const text = String(raw).trim();
    if (!/^[+-]?\d+$/.test(text)) return null;
    try {
        const value = BigInt(text),
            min = type === "u64" ? 0n : -(1n << 63n),
            max = type === "u64" ? (1n << 64n) - 1n : (1n << 63n) - 1n;
        return value < min || value > max ? null : value.toString(10);
    } catch {
        return null;
    }
}
function stepFor(item) {
    if (isFloat(item.type)) {
        const value = Math.abs(Number(item.value));
        if (!Number.isFinite(value) || value < 1) return 0.001;
        return Math.max(0.001, Math.pow(10, Math.floor(Math.log10(value)) - 2));
    }
    const v = Math.abs(Math.trunc(Number(item.value) || 0));
    return v < 100 ? 1 : Math.pow(10, Math.floor(Math.log10(v)) - 1);
}
function addWriteStep(value, delta, type) {
    const result = value + delta;
    if (!Number.isFinite(result)) return value;
    if (!isFloat(type)) return result;
    const step = Math.abs(delta);
    // Steps are decimal powers. Snap only representation noise near that decimal grid,
    // including f32 values decoded into a JavaScript double, without erasing off-grid values.
    const ticks = Math.round(result / step);
    const snapped = Number(`${ticks}e${Math.round(Math.log10(step))}`);
    const epsilon = type === "f32" ? 2 ** -23 : Number.EPSILON;
    const tolerance = Math.min(step / 4, Math.max(Math.abs(value), step) * epsilon);
    return Number.isFinite(snapped) && Math.abs(result - snapped) <= tolerance ? snapped : result;
}
function inWriteList(name) {
    return writeList.some((w) => w.name === name);
}
function mkAvBtn(cls, glyph, on, disabled, titleTxt, handler) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls + (on ? " on" : "");
    b.textContent = glyph;
    b.disabled = !!disabled;
    if (titleTxt) b.title = titleTxt;
    if (!disabled)
        b.onclick = (e) => {
            e.stopPropagation();
            handler();
        };
    return b;
}
function mkWriteBtn(entry, disabled, reason) {
    disabled ||=
        !!entry.runtimeLayout ||
        !!entry.isConst ||
        !!entry.isReference ||
        !!entry.isMemberPointer ||
        Number.isInteger(entry.bitSize);
    const on = !disabled && inWriteList(entry.name);
    return mkAvBtn(
        "av-write",
        "\u270e",
        on,
        disabled,
        disabled ? reason || t("sb.writeUnsupported") : on ? t("sb.removeFromWrite") : t("sb.addToWrite"),
        () => wToggle(entry)
    );
}
function mkWatchBtn(name, disabled, reason, handler) {
    const on = !disabled && sideWatch.some((w) => w.name === name);
    return mkAvBtn(
        "av-watch",
        on ? "\u2713" : "+",
        on,
        disabled,
        disabled ? reason || "" : on ? t("sb.removeFromWatch") : "",
        handler
    );
}
function cancelPendingWrite(name) {
    if (writeTimers[name]) {
        clearTimeout(writeTimers[name]);
        delete writeTimers[name];
    }
    delete writeLastAt[name];
    delete latestWriteSeq[name];
}
function removeWrite(name) {
    cancelPendingWrite(name);
    writeList = writeList.filter((w) => w.name !== name);
    renderWrites();
    renderAvailable();
    saveWriteList();
}
function wToggle(entry) {
    const i = writeList.findIndex((w) => w.name === entry.name);
    if (i >= 0) removeWrite(entry.name);
    else {
        const type = entry.type || "u32",
            nb = defBounds(type);
        if (entry.isBoolean) {
            writeList.push({
                name: entry.name,
                address: entry.address,
                size: entry.size,
                type,
                isBoolean: true,
                min: 0,
                max: 1,
                value: Number(latest[entry.name]) ? 1 : 0
            });
        } else if (isWideInt(type)) {
            const v = latestText[entry.name] || "0";
            writeList.push({ name: entry.name, address: entry.address, size: entry.size, type: type, value: v });
        } else {
            let v = Number(latest[entry.name]);
            if (!Number.isFinite(v)) v = 0;
            let min = nb[0],
                max = nb[1];
            if (v > max) max = 2 * Math.abs(v);
            if (v < min) min = -2 * Math.abs(v);
            writeList.push({
                name: entry.name,
                address: entry.address,
                size: entry.size,
                type: type,
                min: min,
                max: max,
                value: v
            });
        }
        renderWrites();
        renderAvailable();
        saveWriteList();
    }
}
function postWrite(item) {
    if (!api || !inWriteList(item.name)) return;
    if (!liveCanWrite) {
        setWriteFeedback(t("sb.writeNeedSampling"), true);
        return;
    }
    const seq = ++writeSeq;
    latestWriteSeq[item.name] = seq;
    const cells = writeCells[item.name];
    if (cells) cells.input.classList.add("pending");
    api.postMessage({ type: "writeVariable", name: item.name, value: item.value, seq });
}
function sendWrite(item, immediate) {
    const name = item.name;
    if (writeTimers[name]) {
        clearTimeout(writeTimers[name]);
        delete writeTimers[name];
    }
    const now = Date.now();
    if (immediate) {
        writeLastAt[name] = now;
        postWrite(item);
        return;
    }
    const wait = WRITE_INTERVAL_MS - (now - (writeLastAt[name] || 0));
    if (wait <= 0) {
        writeLastAt[name] = now;
        postWrite(item);
        return;
    }
    writeTimers[name] = setTimeout(() => {
        delete writeTimers[name];
        writeLastAt[name] = Date.now();
        postWrite(item);
    }, wait);
}
function setBound(item, key, v) {
    if (item.isBoolean) return;
    if (!Number.isFinite(v)) return;
    if (!isFloat(item.type)) v = Math.round(v);
    if (key === "min") item.min = Math.min(v, Number(item.max));
    else item.max = Math.max(v, Number(item.min));
}
function bindBound(el, item, key, sync) {
    el.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            setBound(
                item,
                key,
                addWriteStep(Number(item[key]) || 0, e.deltaY < 0 ? stepFor(item) : -stepFor(item), item.type)
            );
            sync();
            saveWriteList();
        },
        { passive: false }
    );
    el.onclick = () => {
        const inp = document.createElement("input");
        inp.className = "bound-input";
        inp.value = String(item[key]);
        el.replaceWith(inp);
        inp.focus();
        inp.select();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            if (commit) setBound(item, key, Number(inp.value.trim()));
            inp.replaceWith(el);
            sync();
            saveWriteList();
        };
        inp.onkeydown = (e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
        };
        inp.onblur = () => finish(true);
    };
}
function buildWriteCard(item) {
    const wide = isWideInt(item.type),
        row = document.createElement("div");
    row.className = "write-row" + (wide ? " wide" : "");
    const main = document.createElement("div");
    main.className = "write-main";
    const top = document.createElement("div");
    top.className = "write-top";
    const nm = document.createElement("span");
    nm.className = "value-name";
    EmberProbeRuntime.renderVariableName(nm, sbDisplayName(item), item.name);
    const dot = document.createElement("span");
    dot.className = "write-dot";
    const nmWrap = document.createElement("span");
    nmWrap.className = "write-name-wrap";
    nmWrap.append(dot, nm);
    const ctl = document.createElement("span");
    ctl.className = "write-ctl";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "step-btn";
    minus.textContent = "\u2212";
    const input = document.createElement("input");
    input.className = "write-input";
    input.value = wide ? String(item.value ?? "0") : fmt(item.value);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "step-btn";
    plus.textContent = "+";
    const bottom = document.createElement("div");
    bottom.className = "write-bottom";
    const ty = document.createElement("span");
    ty.className = "value-type";
    ty.textContent = item.isBoolean ? "bool" : item.type || "u32";
    nmWrap.appendChild(ty);
    ctl.append(minus, input, plus);
    top.append(nmWrap, ctl);
    const minL = document.createElement("span");
    minL.className = "bound";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "write-slider";
    const maxL = document.createElement("span");
    maxL.className = "bound";
    bottom.append(minL, slider, maxL);
    main.append(top, bottom);
    const rm = document.createElement("button");
    rm.className = "watch-remove";
    rm.textContent = "\u2715";
    rm.title = t("sb.removeFromWrite");
    rm.onclick = () => removeWrite(item.name);
    row.append(main, rm);
    writeCells[item.name] = {
        row,
        input,
        slider,
        dot,
        setVal: (v) => {
            if (item.isBoolean) v = Number(v) ? 1 : 0;
            item.value = v;
            input.value = wide ? String(v) : fmt(v);
            if (!wide) slider.value = String(Math.min(Number(item.max), Math.max(Number(item.min), v)));
        }
    };
    if (wide) {
        minus.hidden = true;
        plus.hidden = true;
        bottom.hidden = true;
        const commitWide = () => {
            const value = normalizeWideInteger(input.value, item.type);
            if (value === null) {
                input.value = String(item.value ?? "0");
                setWriteFeedback(t("sb.invalidWriteValue"), true);
                return;
            }
            if (value !== String(item.value)) {
                item.value = value;
                input.value = value;
                saveWriteList();
                sendWrite(item, true);
            }
        };
        input.onkeydown = (e) => {
            if (e.key === "Enter") commitWide();
            else if (e.key === "Escape") input.value = String(item.value ?? "0");
        };
        input.onblur = commitWide;
    } else {
        const syncSlider = () => {
            if (item.isBoolean) {
                item.min = 0;
                item.max = 1;
            }
            slider.min = String(item.min);
            slider.max = String(item.max);
            slider.step = isFloat(item.type) ? "any" : "1";
            slider.value = String(Math.min(Number(item.max), Math.max(Number(item.min), Number(item.value) || 0)));
            minL.textContent = fmt(item.min);
            maxL.textContent = fmt(item.max);
        };
        syncSlider();
        const setValue = (v, immediate) => {
            v = item.isBoolean
                ? Math.min(1, Math.max(0, Math.round(Number(v))))
                : isFloat(item.type)
                  ? Number(v)
                  : clampToType(Number(v), item.type);
            if (!Number.isFinite(v)) v = 0;
            if (Object.is(v, -0)) v = 0;
            item.value = v;
            input.value = fmt(v);
            syncSlider();
            saveWriteList();
            sendWrite(item, immediate);
        };
        const commitInput = () => {
            if (input.value.trim() === fmt(item.value)) return;
            const raw = Number(input.value.trim());
            if (!Number.isFinite(raw)) {
                input.value = fmt(item.value);
                return;
            }
            const v = item.isBoolean
                ? Math.min(1, Math.max(0, Math.round(raw)))
                : isFloat(item.type)
                  ? raw
                  : clampToType(raw, item.type);
            if (v !== item.value) {
                const bounds = shiftSliderBounds(item.min, item.max, item.value, v);
                item.min = bounds.min;
                item.max = bounds.max;
                setValue(v, true);
            } else input.value = fmt(item.value);
        };
        input.onkeydown = (e) => {
            if (e.key === "Enter") commitInput();
            else if (e.key === "Escape") input.value = fmt(item.value);
        };
        input.onblur = commitInput;
        input.addEventListener(
            "wheel",
            (e) => {
                if (!liveCanWrite) return;
                e.preventDefault();
                const value = inputValue();
                setValue(
                    addWriteStep(
                        value,
                        e.deltaY < 0 ? stepFor({ ...item, value }) : -stepFor({ ...item, value }),
                        item.type
                    ),
                    false
                );
            },
            { passive: false }
        );
        const inputValue = () => {
            const text = input.value.trim();
            // Empty or unchanged display text keeps the full precision of the last known value.
            if (!text || text === fmt(item.value)) return Number(item.value) || 0;
            const value = Number(text);
            return Number.isFinite(value) ? value : Number(item.value) || 0;
        };
        minus.onclick = () => {
            const value = inputValue();
            setValue(addWriteStep(value, -stepFor({ ...item, value }), item.type), true);
        };
        plus.onclick = () => {
            const value = inputValue();
            setValue(addWriteStep(value, stepFor({ ...item, value }), item.type), true);
        };
        slider.addEventListener("input", () => {
            const v = item.isBoolean
                ? Math.min(1, Math.max(0, Math.round(Number(slider.value))))
                : isFloat(item.type)
                  ? Number(slider.value)
                  : clampToType(Number(slider.value), item.type);
            item.value = v;
            input.value = fmt(v);
            sendWrite(item, false);
        });
        slider.addEventListener("change", () => setValue(Number(slider.value), true));
        if (!item.isBoolean) {
            bindBound(minL, item, "min", syncSlider);
            bindBound(maxL, item, "max", syncSlider);
        }
    }
    if (!liveCanWrite) {
        row.classList.add("gated");
        const gt = t("sb.writeNeedSampling");
        [minus, plus, input, slider].forEach((el) => {
            el.disabled = true;
            el.title = gt;
        });
    }
    return row;
}
function renderWrites() {
    writeBox.textContent = "";
    writeCells = Object.create(null);
    document.getElementById("writeCount").textContent = String(writeList.length);
    if (!writeList.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = t("sb.writeEmpty");
        writeBox.appendChild(e);
        return;
    }
    writeList.forEach((item) => writeBox.appendChild(buildWriteCard(item)));
}
function setWriteFeedback(text, isErr) {
    const fb = document.getElementById("writeFeedback");
    if (!fb) return;
    fb.textContent = text;
    fb.classList.toggle("err", !!isErr);
    if (writeFbTimer) clearTimeout(writeFbTimer);
    writeFbTimer = setTimeout(
        () => {
            fb.textContent = "";
            fb.classList.remove("err");
        },
        isErr ? 5000 : 3000
    );
}
// 写入结果反馈：变量名前的小圆点渐亮后消失（成功绿点/失败红点）；失败另在标题区显示错误原因
function onWriteResult(m) {
    if (m.seq !== latestWriteSeq[m.name]) return;
    delete latestWriteSeq[m.name];
    const cells = writeCells[m.name];
    if (cells) {
        cells.input.classList.remove("pending");
        cells.dot.className = "write-dot " + (m.ok ? "ok" : "err");
        void cells.dot.offsetWidth;
        cells.dot.classList.add("flash");
        if (m.ok) {
            latest[m.name] = m.value;
            latestText[m.name] = m.valueText ?? null;
            cells.setVal(m.valueText ?? m.value);
        }
    }
    if (!m.ok) setWriteFeedback(t("sb.writeFail", { msg: msgText(m) || t("sb.commandFailed") }), true);
}
const EYE_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.7"/></svg>';
const EYE_OFF_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.7"/><path d="M4 4l16 16"/></svg>';
function applyFolds() {
    const wf = !!uiState.sbWatchFolded,
        rf = !!uiState.sbWriteFolded,
        wb = document.getElementById("watchFold"),
        rb = document.getElementById("writeFold");
    liveBox.classList.toggle("folded", wf);
    writeBox.classList.toggle("folded", rf);
    if (wb) {
        wb.innerHTML = wf ? EYE_OFF_SVG : EYE_SVG;
        wb.title = t(wf ? "sb.unfoldList" : "sb.foldList");
    }
    if (rb) {
        rb.innerHTML = rf ? EYE_OFF_SVG : EYE_SVG;
        rb.title = t(rf ? "sb.unfoldList" : "sb.foldList");
    }
}
function saveSbUi() {
    uiState.sbExpanded = sbExpanded;
    if (api && api.setState) api.setState(uiState);
}
function sbWalkLeaves(node, path, cb) {
    if (!node) return;
    if (node.members) {
        node.members.forEach((m) => sbWalkLeaves(m, m.name ? path + "." + m.name : path, cb));
    } else if (node.elements) {
        node.elements.forEach((e) => sbWalkLeaves(e, path + "[" + e.index + "]", cb));
    } else if ("value" in node) {
        cb(path, node);
    }
}
function sbUpdateComposite(name) {
    const tree = latest[name];
    if (!tree) return;
    sbWalkLeaves(tree, name, (path, node) => {
        const cell = compCells[path];
        if (cell) setDisplayedValue(cell, fmtExact(node.value, node.valueText));
    });
}
function sbNote(container, txt) {
    const n = document.createElement("div");
    n.className = "sb-note";
    n.textContent = txt;
    container.appendChild(n);
}
function sbRenderLeaf(container, label, typeName, path, watchType, node) {
    const row = document.createElement("div");
    row.className = "sb-mrow";
    const nm = document.createElement("span");
    nm.className = "sb-mname";
    nm.textContent = label;
    nm.title = sbDisplayName({ name: path });
    nm.setAttribute("aria-label", nm.title);
    const ty = document.createElement("span");
    ty.className = "sb-mtype";
    ty.textContent = typeName || watchType;
    const val = document.createElement("span");
    val.className = "sb-mval";
    setDisplayedValue(val, node ? fmtExact(node.value, node.valueText) : "\u2014");
    val.title = t("common.copy");
    val.addEventListener("click", (event) => {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: val.textContent });
    });
    compCells[path] = val;
    row.append(nm, ty, val);
    container.appendChild(row);
}
function sbRenderLayout(container, layout, path) {
    if (!layout) return;
    if (layout.kind === "struct" || layout.kind === "union" || layout.kind === "class") {
        const ms = layout.members || [];
        ms.forEach((m) => {
            const cp = m.name ? path + "." + m.name : path;
            if (m.compositeLayout && !m.name) sbRenderLayout(container, m.compositeLayout, cp);
            else if (m.compositeLayout) sbRenderNest(container, m.compositeLayout, m.name, cp);
            else if (m.watchType) sbRenderLeaf(container, m.name, m.typeName || m.watchType, cp, m.watchType);
        });
        if (!ms.length) sbNote(container, t("lw.compositeNoLayout"));
    } else if (layout.kind === "array") {
        const et = layout.elementType || {},
            total = Number(layout.totalElements) || 0;
        if (!et.watchType && !et.compositeLayout) {
            sbNote(container, t("lw.compositeNoLayout"));
            return;
        }
        const shown = Math.min(total, 16);
        for (let i = 0; i < shown; i++) {
            const p = path + "[" + i + "]";
            if (et.compositeLayout) sbRenderNest(container, et.compositeLayout, "[" + i + "]", p);
            else sbRenderLeaf(container, "[" + i + "]", et.typeName || et.watchType, p, et.watchType);
        }
        if (total > shown) sbNote(container, t("lw.arrayMore", { n: total - shown }));
    }
}
function sbRenderRuntimeTree(container, tree, path) {
    if (!tree) return;
    if (tree.members) {
        tree.members.forEach((member) => {
            const childPath = member.name ? path + "." + member.name : path;
            if (member.members || member.elements) sbRenderRuntimeTree(container, member, childPath);
            else if (Object.prototype.hasOwnProperty.call(member, "value"))
                sbRenderLeaf(
                    container,
                    member.name || "value",
                    member.typeName || member.type || "",
                    childPath,
                    member.type,
                    member
                );
        });
    } else if (tree.elements) {
        tree.elements.forEach((element) => sbRenderRuntimeTree(container, element, path + "[" + element.index + "]"));
    } else if (Object.prototype.hasOwnProperty.call(tree, "value")) {
        sbRenderLeaf(container, "value", tree.typeName || tree.type || "", path, tree.type, tree);
    }
    if (tree.unavailable) sbNote(container, tree.unavailable);
}
function sbRenderRuntimeBody(body, tree, name) {
    const shape = EmberProbeRuntime.runtimeTreeShape(tree);
    if (body.dataset.runtimeShape === shape) return;
    for (const path of Object.keys(compCells)) {
        if (body.contains(compCells[path])) delete compCells[path];
    }
    body.textContent = "";
    body.dataset.runtimeShape = shape;
    sbRenderRuntimeTree(body, tree, name);
    if (!body.childNodes.length) sbNote(body, t("lw.waitSamples"));
}
function sbRenderNest(container, layout, fieldName, path) {
    const wrap = document.createElement("div");
    const head = document.createElement("div");
    head.className = "sb-comp-head";
    const open = !!sbExpanded[path];
    const arrow = document.createElement("span");
    arrow.className = "sb-arrow" + (open ? " open" : "");
    arrow.textContent = "\u25B6";
    const nm = document.createElement("span");
    nm.className = "sb-comp-name";
    nm.textContent = fieldName;
    const ty = document.createElement("span");
    ty.className = "sb-comp-type";
    ty.textContent = layout.typeName || "";
    head.append(arrow, nm, ty);
    const body = document.createElement("div");
    body.className = "sb-members" + (open ? " open" : "");
    head.onclick = () => {
        const nextOpen = !sbExpanded[path];
        sbExpanded[path] = nextOpen;
        body.classList.toggle("open", nextOpen);
        arrow.classList.toggle("open", nextOpen);
        saveSbUi();
    };
    sbRenderLayout(body, layout, path);
    wrap.append(head, body);
    container.appendChild(wrap);
}
function sbRenderComposite(item) {
    const row = document.createElement("div");
    row.className = "value-row composite" + (sbExpanded[item.name] ? " open" : "");
    const head = document.createElement("div");
    head.className = "sb-comp-head";
    const arrow = document.createElement("span");
    arrow.className = "sb-arrow" + (sbExpanded[item.name] ? " open" : "");
    arrow.textContent = "\u25B6";
    const nm = document.createElement("span");
    nm.className = "sb-comp-name";
    EmberProbeRuntime.renderVariableName(nm, sbDisplayName(item), item.name);
    const lay = item.compositeLayout || {};
    const ty = document.createElement("span");
    ty.className = "sb-comp-type";
    ty.textContent = lay.typeName || "";
    const sp = document.createElement("span");
    sp.className = "sb-comp-sp";
    const rm = document.createElement("button");
    rm.className = "watch-remove";
    rm.textContent = "\u2715";
    rm.title = t("sb.removeFromWatch");
    rm.onclick = (e) => {
        e.stopPropagation();
        sbRemove(item.name, true);
        renderValues();
        renderAvailable();
        saveSideWatch();
        saveSbUi();
    };
    head.append(arrow, nm, ty, sp, rm);
    const body = document.createElement("div");
    body.className = "sb-body";
    head.onclick = () => {
        sbExpanded[item.name] = !sbExpanded[item.name];
        row.classList.toggle("open", sbExpanded[item.name]);
        arrow.classList.toggle("open", sbExpanded[item.name]);
        saveSbUi();
    };
    if (item.runtimeLayout) {
        runtimeBodies[item.name] = body;
        sbRenderRuntimeBody(body, latest[item.name], item.name);
    } else sbRenderLayout(body, lay, item.name);
    row.append(head, body);
    liveBox.appendChild(row);
    sbUpdateComposite(item.name);
}
function sbOnComposite(samples) {
    let refreshAvailable = false;
    const searching = !!document.getElementById("varSearch").value.trim();
    (samples || []).forEach((s) => {
        if (s && s.name) {
            if (
                (avExpanded[s.name] || searching) &&
                EmberProbeRuntime.runtimeTreeShape(latest[s.name]) !== EmberProbeRuntime.runtimeTreeShape(s.tree) &&
                EmberProbeRuntime.runtimeSelection(availableByName.get(s.name), s.tree)
            )
                refreshAvailable = true;
            latest[s.name] = s.tree;
            const body = runtimeBodies[s.name];
            if (body) sbRenderRuntimeBody(body, s.tree, s.name);
        }
    });
    if (refreshAvailable) renderAvailable();
    scheduleValueRefresh();
}
function updateValues(samples) {
    (samples || []).forEach((s) => {
        latest[s.name] = s.value;
        latestText[s.name] = s.valueText ?? null;
    });
    scheduleValueRefresh();
}
let valueRefreshTimer = null;
let lastValueRefresh = 0;
function scheduleValueRefresh() {
    if (valueRefreshTimer !== null) return;
    const elapsed = Date.now() - lastValueRefresh;
    if (elapsed >= 100) {
        lastValueRefresh = Date.now();
        refreshDisplayedValues();
        return;
    }
    valueRefreshTimer = setTimeout(() => {
        valueRefreshTimer = null;
        lastValueRefresh = Date.now();
        refreshDisplayedValues();
    }, 100 - elapsed);
}
function refreshDisplayedValues() {
    document.querySelectorAll("[data-value-name]").forEach((el) => {
        setDisplayedValue(el, fmtExact(latest[el.dataset.valueName], latestText[el.dataset.valueName]));
    });
    sideWatch.forEach((it) => {
        if (sbIsComposite(it)) sbUpdateComposite(it.name);
    });
    syncWriteValues();
}
// 采样运行时写入卡片实时同步当前值；用户正在编辑（聚焦/写入在途/防抖中）的卡片不覆盖
function syncWriteValues() {
    if (!liveCanRead) return;
    writeList.forEach((item) => {
        const c = writeCells[item.name];
        if (!c) return;
        if (Date.now() - (writeLastAt[item.name] || 0) < 1000) return;
        if (writeTimers[item.name]) return;
        if (c.input.classList.contains("pending")) return;
        const ae = document.activeElement;
        if (ae === c.input || ae === c.slider) return;
        if (isWideInt(item.type)) {
            const text = latestText[item.name];
            if (text != null) c.setVal(text);
            return;
        }
        const sampled = latest[item.name];
        if (sampled === null || sampled === undefined) return;
        let v = Number(sampled);
        if (!Number.isFinite(v)) return;
        if (!isFloat(item.type)) v = Math.round(v);
        c.setVal(v);
    });
}
function liveStatus(m) {
    m = m || {};
    lastLive = m;
    const wasRunning = liveRunning,
        wasWrite = liveCanWrite,
        wasFresh = liveSnapshotReady;
    const next = window.EmberProbeRuntime.liveState(
        { running: liveRunning, canRead: liveCanRead, canWrite: liveCanWrite },
        m
    );
    liveRunning = next.running;
    liveCanRead = next.canRead;
    liveCanWrite = next.canWrite;
    liveSnapshotReady = next.fresh;
    const debugRunning = m.mode === "debug-running-waiting",
        debugReading = m.source === "dap" && liveRunning && !liveSnapshotReady;
    if (liveCard) liveCard.classList.toggle("debug-stale", !liveSnapshotReady);
    if (liveLabel.hasAttribute("data-i18n")) liveLabel.removeAttribute("data-i18n");
    liveToggle.textContent = liveRunning ? t("sb.stop") : t("sb.start");
    liveState.className =
        "live-state " +
        (m.error ? "err" : debugRunning || debugReading ? "busy" : liveCanRead ? "on" : liveRunning ? "busy" : "");
    liveLabel.textContent = msgText(m) || (liveRunning ? t("sb.sampling") : t("sb.stopped"));
    liveLabel.title = t("sb.samplingRate", { hz: Number(m.actualHz || 0).toFixed(1) });
    if (wasRunning !== liveRunning || wasWrite !== liveCanWrite || wasFresh !== liveSnapshotReady) renderWrites();
}
function openocdStatus(m) {
    m = m || {};
    lastOpenocd = m;
    uiState.sidebarStatus ||= {};
    const { state, key, params, message, canInstall } = m;
    uiState.sidebarStatus.openocd = { state, key, params, message, canInstall };
    api?.setState?.(uiState);
    const k = m.state || "checking",
        busy = k === "checking" || k === "installing";
    openocdCard.className = "openocd-card " + (k === "incompatible" ? "error" : k);
    openocdCard.style.display = k === "ready" ? "none" : "";
    openocdCard.hidden = k === "ready";
    openocdMessage.textContent = msgText(m) || t("oc.checking");
    openocdInstall.style.display = m.canInstall === false ? "none" : "";
    openocdCard.querySelectorAll("button").forEach((b) => (b.disabled = busy));
}
function renderSkillStatus(m) {
    lastSkill = m || lastSkill;
    const el = document.getElementById("skillStatus");
    if (!el) return;
    const workspace = lastSkill?.scopes?.workspace;
    uiState.sidebarStatus ||= {};
    uiState.sidebarStatus.skill = {
        state: lastSkill.state,
        busy: !!lastSkill.busy,
        scopes: workspace ? { workspace: { state: workspace.state } } : {}
    };
    api?.setState?.(uiState);
    el.classList.toggle("status-ready", !!workspace || lastSkill.state !== "checking");
    el.setAttribute("aria-checked", String(!!workspace && workspace.state !== "notInstalled"));
    el.disabled = !workspace || !!lastSkill.busy;
}
const skillToggle = document.getElementById("skillStatus");
if (skillToggle)
    skillToggle.onclick = () => {
        if (skillToggle.disabled || !api) return;
        skillToggle.classList.add("animate");
        skillToggle.disabled = true;
        api.postMessage({ type: "executeCommand", cmd: "mcu-vscode.manageAgentSkills" });
    };
function progress(m) {
    if (m?.cmd === "mcu-vscode.download" || m?.stage) {
        setStat(m.level === "error" ? "error" : m.level === "success" ? "ready" : "", m.key || "", m.params, m.message);
        return;
    }
    setStat(m.level === "error" ? "error" : m.level === "success" ? "ready" : "", m.key || "", m.params, m.message);
    logEvents.push({ level: m.level, key: m.key, params: m.params, message: m.message });
    while (logEvents.length > 6) logEvents.shift();
    const line = document.createElement("div");
    line.className = m.level || "";
    line.textContent = "• " + msgText(m);
    log.appendChild(line);
    while (log.children.length > 6) log.firstChild.remove();
}

function chipStatus(m) {
    m = m || {};
    lastChip = m;
    const st = m.state || "idle";
    chipState.className =
        "chip-state " + (st === "error" ? "err" : st === "ready" ? "on" : st === "reading" ? "busy" : "");
    if (chipRead) {
        chipRead.disabled = probeDriverBusy || st === "reading";
        chipRead.textContent = st === "reading" ? t("sb.readingEllipsis") : chipHasData ? t("sb.reread") : t("sb.read");
    }
    chipLabel.textContent = m.key || m.message ? msgText(m) : chipStatusLabel(st);
    chipLabel.title = chipLabel.textContent;
    chipBody.querySelectorAll(".chip-control").forEach((button) => {
        button.disabled = probeDriverBusy || st === "reading";
    });
    chipBody.querySelector(".chip-action-error")?.remove();
    if (st === "error" && chipHasData) {
        const note = document.createElement("div");
        note.className = "chip-note chip-err chip-action-error";
        note.textContent = msgText(m) || t("chip.stError");
        chipBody.appendChild(note);
    }
    if (st === "error" && !chipHasData) {
        chipBody.textContent = "";
        const n = document.createElement("div");
        n.className = "chip-note chip-err";
        n.textContent = msgText(m) || t("chip.stError");
        chipBody.appendChild(n);
    }
}
function svdStatus(m) {
    m = m || {};
    lastSvd = m;
    const st = m.state || "idle",
        cancellable = st === "downloading" || st === "validating",
        busy = cancellable || st === "cancelling";
    if (svdStatusEl) {
        svdStatusEl.className =
            "svd-status " +
            (st === "error"
                ? "err"
                : st === "configured"
                  ? "ok"
                  : st === "cancelling"
                    ? "cancelling"
                    : busy
                      ? "busy"
                      : "");
        svdStatusEl.textContent = msgText(m) || (st === "configured" ? t("svd.configured") : t("svd.notConfigured"));
        svdStatusEl.title = m.path || svdStatusEl.textContent;
    }
    if (svdSelect) svdSelect.disabled = busy;
    if (svdDownload) {
        svdDownload.disabled = st === "cancelling";
        svdDownload.textContent = cancellable
            ? t("svd.cancelDownload")
            : st === "cancelling"
              ? t("svd.cancelling")
              : st === "error"
                ? t("svd.retry")
                : t("svd.downloadOfficial");
        svdDownload.classList.toggle("cancel", cancellable);
    }
    peripheralView?.onSvdStatus(m);
}

function renderChip(info) {
    info = info || {};
    lastChipInfo = info;
    chipHasData = true;
    chipBody.innerHTML = window.EmberProbeChipView.render(info, {
        t,
        icon: CHIP_ICON,
        states: CHIP_STATE_TEXT,
        moreOpen: chipMoreOpen
    });
    const more = document.getElementById("chipMore");
    if (more)
        more.addEventListener("toggle", () => {
            chipMoreOpen = more.open;
            uiState.chipMoreOpen = chipMoreOpen;
            if (api && api.setState) api.setState(uiState);
        });
    chipBody.querySelectorAll(".chip-copy").forEach(
        (b) =>
            (b.onclick = () => {
                if (api) api.postMessage({ type: "copyText", text: b.dataset.copy });
            })
    );
    chipBody.querySelectorAll(".chip-control").forEach((button) => {
        button.disabled = probeDriverBusy || lastChip.state === "reading";
        button.onclick = () => {
            if (!api) return setStat("error", "sb.extNotConnected");
            chipStatus({ state: "reading", key: "chip.controlling" });
            api.postMessage({ type: "chipControl", action: button.dataset.chipAction });
        };
    });
    if (lastChip.state === "error") chipStatus(lastChip);
}
if (chipRead)
    chipRead.onclick = () => {
        if (!api) return setStat("error", "sb.extNotConnected");
        revealIncompleteConfiguration();
        chipStatus({ state: "reading" });
        api.postMessage({ type: "readChipInfo" });
    };
if (svdSelect)
    svdSelect.onclick = () => api && api.postMessage({ type: "executeCommand", cmd: "mcu-vscode.selectExistingSvd" });
if (jlinkDriverChoice)
    jlinkDriverChoice.onchange = () => {
        if (!api) return setStat("error", "sb.extNotConnected");
        const requested = jlinkDriverChoice.value;
        if (confirmedProbeDriver) jlinkDriverChoice.value = confirmedProbeDriver;
        setProbeDriverBusy(true);
        api.postMessage({ type: "selectProbeDriver", driver: requested });
    };
if (svdDownload)
    svdDownload.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!api) return;
        if (lastSvd.state === "downloading" || lastSvd.state === "validating") {
            svdStatus({ ...lastSvd, state: "cancelling", key: "svd.cancelling" });
            api.postMessage({ type: "cancelSvdDownload" });
        } else if (lastSvd.state !== "cancelling")
            api.postMessage({ type: "executeCommand", cmd: "mcu-vscode.downloadOfficialSvd" });
    };
document.querySelectorAll("[data-command]").forEach(
    (b) =>
        (b.onclick = () => {
            if (!api) return setStat("error", "sb.extNotConnected");
            revealIncompleteConfiguration();
            if (b.dataset.command === "mcu-vscode.download") {
                log.textContent = "";
                logEvents = [];
            }
            setStat("", "sb.executing");
            api.postMessage({ type: "executeCommand", cmd: b.dataset.command });
        })
);
liveToggle.onclick = () => {
    if (api) {
        revealIncompleteConfiguration();
        liveToggle.disabled = true;
        api.postMessage({ type: "liveToggle" });
        setTimeout(() => (liveToggle.disabled = probeDriverBusy), 500);
    }
};
for (const id of ["peripheralRefresh", "peripheralFormat", "rtosRefresh"]) {
    document.getElementById(id)?.addEventListener("click", revealIncompleteConfiguration);
}
document.getElementById("openocdInstall").onclick = () =>
    api && api.postMessage({ type: "openocdAction", action: "install" });
document.getElementById("openocdSelect").onclick = () =>
    api && api.postMessage({ type: "openocdAction", action: "select" });
document.getElementById("openocdCheck").onclick = () =>
    api && api.postMessage({ type: "openocdAction", action: "check" });
document.getElementById("varSearch").oninput = renderAvailable;
document.getElementById("varSearchClear").onclick = function () {
    const v = document.getElementById("varSearch");
    v.value = "";
    renderAvailable();
    v.focus();
};
document.getElementById("varRefresh").onclick = function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (api) api.postMessage({ type: "refreshVariables" });
};
document.getElementById("watchFold").onclick = () => {
    uiState.sbWatchFolded = !uiState.sbWatchFolded;
    if (api && api.setState) api.setState(uiState);
    applyFolds();
};
document.getElementById("writeFold").onclick = () => {
    uiState.sbWriteFolded = !uiState.sbWriteFolded;
    if (api && api.setState) api.setState(uiState);
    applyFolds();
};
applyFolds();
const variableBrowser = document.querySelector(".variable-browser");
if (uiState.variableBrowserOpen === false) variableBrowser.open = false;
variableBrowser.addEventListener("toggle", () => {
    uiState.variableBrowserOpen = variableBrowser.open;
    if (api && api.setState) api.setState(uiState);
});
function attachResizeHandle(handle, box, stateKey) {
    const savedHeight = Number(uiState[stateKey]);
    if (Number.isFinite(savedHeight) && savedHeight >= 80) box.style.height = savedHeight + "px";
    handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const startY = e.clientY,
            startHeight = box.getBoundingClientRect().height;
        handle.classList.add("dragging");
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
            const max = Math.max(120, window.innerHeight * 0.7),
                height = Math.min(max, Math.max(80, startHeight + ev.clientY - startY));
            box.style.height = height + "px";
        };
        const end = (ev) => {
            handle.classList.remove("dragging");
            handle.releasePointerCapture(ev.pointerId);
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", end);
            handle.removeEventListener("pointercancel", end);
            uiState[stateKey] = Math.round(box.getBoundingClientRect().height);
            if (api && api.setState) api.setState(uiState);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    });
}
attachResizeHandle(document.getElementById("varResizeHandle"), availableBox, "variableHeight");
attachResizeHandle(document.getElementById("rtosResizeHandle"), document.getElementById("rtosTableWrap"), "rtosHeight");
attachResizeHandle(
    document.getElementById("peripheralResizeHandle"),
    document.getElementById("peripheralTree"),
    "peripheralHeight"
);
document.getElementById("githubLink").onclick = () => api?.postMessage({ type: "openGitHub" });
window.EmberProbeMessages.connect(window, {
    memoryAnalysis: function (m) {
        memoryView?.receive(m);
    },
    initSuccess: function (m) {
        setStat("ready", "sb.ready");
    },
    skillStatus: function (m) {
        renderSkillStatus(m);
    },
    openocdStatus: function (m) {
        openocdStatus(m);
    },
    openocdProgress: function (m) {
        showProbeDiagnostic(m);
        progress(m);
    },
    probeDriverStatus: function (m) {
        if (m.state === "installing" || m.state === "restoring") setProbeDriverBusy(true);
        const keys = {
            installing: "probe.driverInstalling",
            ready: "probe.driverReady",
            restoring: "probe.driverRestoring",
            restored: "probe.driverRestored"
        };
        setStat(
            m.state === "error" ? "error" : m.state === "ready" || m.state === "restored" ? "ready" : "checking",
            keys[m.state] || "",
            null,
            m.message || ""
        );
    },
    probeDriverChoice: function (m) {
        if (!jlinkDriverChoice) return;
        confirmedProbeDriver = m.driver;
        jlinkDriverChoice.hidden = m.driver !== "winusb" && m.driver !== "segger";
        if (!jlinkDriverChoice.hidden) jlinkDriverChoice.value = m.driver;
        jlinkDriverChoice.disabled = probeDriverBusy;
    },
    probeDriverSwitch: function (m) {
        setProbeDriverBusy(!!m.busy);
    },
    commandSuccess: function (m) {
        setStat("ready", "sb.commandDone");
    },
    commandError: function (m) {
        showProbeDiagnostic(m);
        setStat("error", m.key || "", m.params, m.error || t("sb.commandFailed"));
    },
    sidebarWatchList: function (m) {
        sideWatch = (m.items || []).slice();
        if (m.resetValues) {
            sideWatch.forEach((item) => {
                delete latest[item.name];
                delete latestText[item.name];
            });
        }
        renderValues();
        renderAvailable();
    },
    sidebarWriteList: function (m) {
        writeList = (m.items || []).slice();
        renderWrites();
        renderAvailable();
    },
    writeResult: function (m) {
        onWriteResult(m);
    },
    availableVariables: function (m) {
        available = (m.symbols || []).slice();
        availableTypesReady = true;
        availableByName = new Map(available.map((symbol) => [symbol.name, symbol]));
        variableErrorKey = m.errorKey || "";
        variableErrorParams = m.params || null;
        variableError = m.errorKey ? t(m.errorKey, m.params) : m.error || "";
        renderAvailable();
        renderValues();
        renderWrites();
    },
    availableVariablesReset: function (m) {
        availableVersion = m.version || "";
        availableTypesReady = false;
        available = [];
        availableByName.clear();
        availableTypeChunks = 0;
        availableLayoutPending.clear();
        availableAddPending.clear();
        variableError = "";
        renderAvailable();
    },
    availableVariablesChunk: function (m) {
        if (m.version !== availableVersion) return;
        const symbols = m.symbols || [];
        available.push(...symbols);
        for (const symbol of symbols) availableByName.set(symbol.name, symbol);
        if (available.length <= 1000 || available.length % 10000 < symbols.length) renderAvailable();
    },
    availableVariablesDone: function (m) {
        if (m.version && m.version !== availableVersion) return;
        variableErrorKey = m.errorKey || "";
        variableErrorParams = m.params || null;
        variableError = m.errorKey ? t(m.errorKey, m.params) : m.error || "";
        renderAvailable();
    },
    availableVariableTypes: function (m) {
        if (m.version !== availableVersion) return;
        for (const update of m.symbols || []) {
            const symbol = availableByName.get(update.name);
            if (symbol) Object.assign(symbol, update);
        }
        if (++availableTypeChunks % 10 === 0) renderAvailable();
    },
    availableTypesDone: function (m) {
        if (m.version !== availableVersion) return;
        availableTypesReady = true;
        renderAvailable();
        renderValues();
        renderWrites();
    },
    compositeLayoutResult: function (m) {
        if (m.version !== availableVersion) return;
        availableLayoutPending.delete(m.name);
        const symbol = availableByName.get(m.name);
        if (!symbol) return;
        if (m.layout) {
            symbol.compositeLayout = m.layout;
            symbol.runtimeLayout = m.layout.runtimeLayout || null;
            symbol.unsupportedReason = "";
            symbol.layoutError = "";
        } else {
            symbol.layoutError = m.error || t("lw.compositeNoLayout");
            symbol.unsupportedReason = symbol.layoutError;
        }
        if (availableAddPending.delete(m.name) && m.layout && !sideWatch.some((item) => item.name === m.name))
            sbToggle({
                name: symbol.name,
                address: Number(symbol.address) || 0,
                size: Number(symbol.size) || 4,
                type: "",
                isComposite: true,
                compositeLayout: m.layout,
                ...(m.layout.runtimeLayout ? { runtimeLayout: m.layout.runtimeLayout } : {})
            });
        renderAvailable();
    },
    debugSessionChanged: function () {
        latest = Object.create(null);
        latestText = Object.create(null);
        compCells = Object.create(null);
        renderValues();
        renderWrites();
    },
    liveSample: function (m) {
        updateValues(m.samples);
    },
    liveCompositeSample: function (m) {
        sbOnComposite(m.samples || []);
    },
    liveStatus: function (m) {
        showProbeDiagnostic(m);
        liveStatus(m);
    },
    chipInfo: function (m) {
        renderChip(m.info);
    },
    chipInfoStatus: function (m) {
        showProbeDiagnostic(m);
        chipStatus(m);
    },
    svdStatus: function (m) {
        svdStatus(m);
    },
    peripheralCatalog: function (m) {
        peripheralView?.onCatalog(m);
    },
    rtosDebugStatus: function (m) {
        rtosView?.onDebug(m);
    },
    rtosSnapshot: function (m) {
        rtosView?.onSnapshot(m);
    },
    rtosError: function (m) {
        rtosView?.onError(m);
    },
    peripheralRegisters: function (m) {
        peripheralView?.onRegisters(m);
    },
    peripheralReadResult: function (m) {
        peripheralView?.onRead(m);
    },
    peripheralDebugStatus: function (m) {
        peripheralView?.onDebug(m);
    },
    peripheralWriteResult: function (m) {
        peripheralView?.onWrite(m);
    },
    peripheralError: function (m) {
        peripheralView?.onError(m);
    },
    liveError: function (m) {
        showProbeDiagnostic(m);
        liveStatus({
            running: liveRunning,
            error: true,
            key: m.key,
            params: m.params,
            message: m.message || t("sb.commandFailed")
        });
    },
    setLang: function (m) {
        setLang(m.lang, false);
    }
});
updateLangToggle();
if (uiState.sidebarStatus?.openocd) openocdStatus(uiState.sidebarStatus.openocd);
renderSkillStatus(uiState.sidebarStatus?.skill || lastSkill);
if (langToggle) langToggle.onclick = () => setLang(LANG === "zh" ? "en" : "zh", true);
if (api) api.postMessage({ type: "initCheck" });
else setStat("error", "sb.apiUnavailable");
