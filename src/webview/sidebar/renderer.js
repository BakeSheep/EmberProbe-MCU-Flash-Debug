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
let sideWatch = [],
    writeList = [],
    available = [],
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
    writeFbTimer = null;
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
    otherConfig = document.getElementById("otherConfig");
let chipHasData = false,
    chipMoreOpen = !!(uiState && uiState.chipMoreOpen);
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
    if (chipHasData && lastChipInfo) renderChip(lastChipInfo);
    renderLog();
    if (lastFeedbackPrompt) renderFeedbackPrompt(lastFeedbackPrompt);
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
function addr(v) {
    return "0x" + (Number(v) >>> 0).toString(16).toUpperCase();
}
function saveSideWatch() {
    if (api) api.postMessage({ type: "saveSidebarWatch", items: sideWatch });
}
function saveWriteList() {
    if (api) api.postMessage({ type: "saveSidebarWrite", items: writeList });
}
function sbBaseNameOf(n) {
    n = String(n);
    const d = n.indexOf("."),
        b = n.indexOf("[");
    const i = d < 0 ? b : b < 0 ? d : Math.min(d, b);
    return i < 0 ? n : n.slice(0, i);
}
function sbIsLeafChild(name) {
    const b = sbBaseNameOf(name);
    if (b === name) return false;
    return sideWatch.some((w) => w.name === b && sbIsComposite(w));
}
function sbCollectLeaves(layout, name, baseAddr) {
    const out = [];
    (function walk(lyt, path, off) {
        if (!lyt) return;
        if (lyt.kind === "struct" || lyt.kind === "union") {
            (lyt.members || []).forEach((m) => {
                const cp = path + "." + m.name,
                    mo = off + (Number(m.offset) || 0);
                if (m.compositeLayout) walk(m.compositeLayout, cp, mo);
                else if (m.watchType)
                    out.push({
                        path: cp,
                        label: cp.slice(name.length),
                        address: (baseAddr + mo) >>> 0,
                        type: m.watchType
                    });
            });
        } else if (lyt.kind === "array") {
            const et = lyt.elementType || {},
                total = Number(lyt.totalElements) || 0,
                es = Number(et.byteSize) || 0,
                end = Math.min(total, 16);
            for (let i = 0; i < end; i++) {
                const cp = path + "[" + i + "]",
                    eo = off + i * es;
                if (et.compositeLayout) walk(et.compositeLayout, cp, eo);
                else if (et.watchType)
                    out.push({
                        path: cp,
                        label: cp.slice(name.length),
                        address: (baseAddr + eo) >>> 0,
                        type: et.watchType
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
        delete sbExpanded[name];
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
        n.textContent = item.name;
        const val = document.createElement("span");
        val.className = "value-number";
        val.dataset.valueName = item.name;
        val.textContent = fmtExact(latest[item.name], latestText[item.name]);
        const ty = document.createElement("span");
        ty.className = "value-type";
        ty.textContent = item.type || "u32";
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
        row.append(n, val, ty, rm);
        liveBox.appendChild(row);
    });
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
    const selected = new Set(sideWatch.map((w) => w.name));
    const list = available.filter((s) => !query || s.name.toLowerCase().includes(query));
    if (!list.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = available.length ? t("sb.noMatch") : t("sb.noImportable");
        availableBox.appendChild(e);
        return;
    }
    list.forEach((sym) => {
        if (sym.isComposite && sym.compositeLayout) {
            const row = document.createElement("div");
            row.className = "available-row comp";
            const wrap = document.createElement("span");
            wrap.className = "av-name-wrap";
            const arrow = document.createElement("span");
            arrow.className = "av-arrow" + (avExpanded[sym.name] ? " open" : "");
            arrow.textContent = "\u25B6";
            const nm = document.createElement("span");
            nm.className = "available-name";
            const on = selected.has(sym.name);
            nm.textContent = sym.name;
            nm.title = on ? t("sb.removeFromWatch") : t("sb.compositeAddWhole");
            const compEntry = {
                name: sym.name,
                address: Number(sym.address) || 0,
                size: Number(sym.size) || 4,
                type: "",
                isComposite: true,
                compositeLayout: sym.compositeLayout
            };
            wrap.append(
                arrow,
                mkWatchBtn(sym.name, false, "", () => sbToggle(compEntry)),
                nm
            );
            const ty = document.createElement("span");
            ty.className = "available-type";
            ty.textContent = sym.typeName || t("sb.composite");
            const ad = document.createElement("span");
            ad.className = "available-address";
            ad.textContent = addr(sym.address);
            row.append(wrap, ty, ad);
            availableBox.appendChild(row);
            const kids = document.createElement("div");
            kids.className = "av-children" + (avExpanded[sym.name] ? " open" : "");
            sbCollectLeaves(sym.compositeLayout, sym.name, sym.address).forEach((lf) => {
                const lb = document.createElement("div");
                lb.className = "available-row leaf";
                const cell = document.createElement("span");
                cell.className = "av-name-cell";
                const leafEntry = { name: lf.path, address: lf.address, size: LEAF_W[lf.type] || 4, type: lf.type };
                cell.appendChild(mkWriteBtn(leafEntry));
                cell.appendChild(mkWatchBtn(lf.path, false, "", () => sbToggle(leafEntry)));
                const ln = document.createElement("span");
                ln.className = "av-leaf-name";
                ln.textContent = lf.label;
                cell.appendChild(ln);
                const lty = document.createElement("span");
                lty.className = "available-type";
                lty.textContent = lf.type;
                const la = document.createElement("span");
                la.className = "available-address";
                la.textContent = addr(lf.address);
                lb.append(cell, lty, la);
                lb.onclick = () => sbToggle(leafEntry);
                kids.appendChild(lb);
            });
            availableBox.appendChild(kids);
            const toggle = (e) => {
                e.preventDefault();
                e.stopPropagation();
                avExpanded[sym.name] = !avExpanded[sym.name];
                arrow.classList.toggle("open", avExpanded[sym.name]);
                kids.classList.toggle("open", avExpanded[sym.name]);
            };
            arrow.onclick = toggle;
            nm.onclick = () =>
                sbToggle({
                    name: sym.name,
                    address: Number(sym.address) || 0,
                    size: Number(sym.size) || 4,
                    type: "",
                    isComposite: true,
                    compositeLayout: sym.compositeLayout
                });
        } else {
            const noLayout = sym.isComposite && !sym.compositeLayout;
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
                address: Number(sym.address) || 0,
                size: Number(sym.size) || 4,
                type: sym.watchType
            };
            cell.appendChild(
                mkWriteBtn(
                    entry,
                    noLayout || !sym.hasDwarfWriteType,
                    noLayout ? sym.unsupportedReason || t("sb.compositeUnsupported") : t("sb.writeUnsupported")
                )
            );
            cell.appendChild(
                mkWatchBtn(sym.name, noLayout, sym.unsupportedReason || t("sb.compositeUnsupported"), () =>
                    sbToggle(entry)
                )
            );
            const n = document.createElement("span");
            n.className = "available-name";
            n.textContent = sym.name;
            cell.appendChild(n);
            const ty = document.createElement("span");
            ty.className = "available-type";
            ty.textContent = sym.typeName || sym.watchType || t("sb.composite");
            const ad = document.createElement("span");
            ad.className = "available-address";
            ad.textContent = addr(sym.address);
            b.append(cell, ty, ad);
            if (!noLayout) b.onclick = () => sbToggle(entry);
            availableBox.appendChild(b);
        }
    });
}
function sbIsComposite(it) {
    return !!(it && it.isComposite && it.compositeLayout);
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
    if (item.type === "f32") return (Number(item.max) - Number(item.min)) / 100 || 0.1;
    const v = Math.abs(Math.trunc(Number(item.value) || 0));
    return v < 100 ? 1 : Math.pow(10, Math.floor(Math.log10(v)) - 1);
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
        if (isWideInt(type)) {
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
    if (!Number.isFinite(v)) return;
    if (item.type !== "f32") v = Math.round(v);
    if (key === "min") item.min = Math.min(v, Number(item.max));
    else item.max = Math.max(v, Number(item.min));
}
function bindBound(el, item, key, sync) {
    el.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            setBound(item, key, (Number(item[key]) || 0) + (e.deltaY < 0 ? stepFor(item) : -stepFor(item)));
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
    nm.textContent = item.name;
    nm.title = item.name;
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
    ctl.append(minus, input, plus);
    top.append(nmWrap, ctl);
    const bottom = document.createElement("div");
    bottom.className = "write-bottom";
    const ty = document.createElement("span");
    ty.className = "value-type";
    ty.textContent = item.type || "u32";
    const minL = document.createElement("span");
    minL.className = "bound";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "write-slider";
    const maxL = document.createElement("span");
    maxL.className = "bound";
    bottom.append(ty, minL, slider, maxL);
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
            slider.min = String(item.min);
            slider.max = String(item.max);
            slider.step = isFloat(item.type) ? "any" : "1";
            slider.value = String(Math.min(Number(item.max), Math.max(Number(item.min), Number(item.value) || 0)));
            minL.textContent = fmt(item.min);
            maxL.textContent = fmt(item.max);
        };
        syncSlider();
        const setValue = (v, immediate) => {
            v = isFloat(item.type) ? Number(v) : clampToType(Number(v), item.type);
            if (!Number.isFinite(v)) v = 0;
            item.value = v;
            input.value = fmt(v);
            syncSlider();
            saveWriteList();
            sendWrite(item, immediate);
        };
        const commitInput = () => {
            const raw = Number(input.value.trim());
            if (!Number.isFinite(raw)) {
                input.value = fmt(item.value);
                return;
            }
            const v = isFloat(item.type) ? raw : clampToType(raw, item.type);
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
                setValue((Number(item.value) || 0) + (e.deltaY < 0 ? stepFor(item) : -stepFor(item)), false);
            },
            { passive: false }
        );
        minus.onclick = () => setValue((Number(item.value) || 0) - stepFor(item), true);
        plus.onclick = () => setValue((Number(item.value) || 0) + stepFor(item), true);
        slider.addEventListener("input", () => {
            const v = isFloat(item.type) ? Number(slider.value) : clampToType(Number(slider.value), item.type);
            item.value = v;
            input.value = fmt(v);
            sendWrite(item, false);
        });
        slider.addEventListener("change", () => setValue(Number(slider.value), true));
        bindBound(minL, item, "min", syncSlider);
        bindBound(maxL, item, "max", syncSlider);
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
        node.members.forEach((m) => sbWalkLeaves(m, path + "." + m.name, cb));
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
        if (cell) cell.textContent = fmtExact(node.value, node.valueText);
    });
}
function sbNote(container, txt) {
    const n = document.createElement("div");
    n.className = "sb-note";
    n.textContent = txt;
    container.appendChild(n);
}
function sbRenderLeaf(container, label, typeName, path, watchType) {
    const row = document.createElement("div");
    row.className = "sb-mrow";
    const nm = document.createElement("span");
    nm.className = "sb-mname";
    nm.textContent = label;
    nm.title = path;
    const ty = document.createElement("span");
    ty.className = "sb-mtype";
    ty.textContent = typeName || watchType;
    const val = document.createElement("span");
    val.className = "sb-mval";
    val.textContent = "\u2014";
    compCells[path] = val;
    row.append(nm, ty, val);
    container.appendChild(row);
}
function sbRenderLayout(container, layout, path) {
    if (!layout) return;
    if (layout.kind === "struct" || layout.kind === "union") {
        const ms = layout.members || [];
        ms.forEach((m) => {
            const cp = path + "." + m.name;
            if (m.compositeLayout) sbRenderNest(container, m.compositeLayout, m.name, cp);
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
function sbRenderNest(container, layout, fieldName, path) {
    const wrap = document.createElement("div");
    const head = document.createElement("div");
    head.className = "sb-comp-head";
    const arrow = document.createElement("span");
    arrow.className = "sb-arrow";
    arrow.textContent = "\u25B6";
    const nm = document.createElement("span");
    nm.className = "sb-comp-name";
    nm.textContent = fieldName;
    const ty = document.createElement("span");
    ty.className = "sb-comp-type";
    ty.textContent = layout.typeName || "";
    head.append(arrow, nm, ty);
    const body = document.createElement("div");
    body.className = "sb-members";
    head.onclick = () => {
        const open = body.classList.toggle("open");
        arrow.classList.toggle("open", open);
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
    nm.textContent = item.name;
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
    sbRenderLayout(body, lay, item.name);
    row.append(head, body);
    liveBox.appendChild(row);
    sbUpdateComposite(item.name);
}
function sbOnComposite(samples) {
    (samples || []).forEach((s) => {
        if (s && s.name) latest[s.name] = s.tree;
    });
    sideWatch.forEach((it) => {
        if (sbIsComposite(it)) sbUpdateComposite(it.name);
    });
}
function updateValues(samples) {
    (samples || []).forEach((s) => {
        latest[s.name] = s.value;
        latestText[s.name] = s.valueText ?? null;
    });
    document
        .querySelectorAll("[data-value-name]")
        .forEach((el) => (el.textContent = fmtExact(latest[el.dataset.valueName], latestText[el.dataset.valueName])));
    syncWriteValues();
}
// 采样运行时写入卡片实时同步当前值；用户正在编辑（聚焦/写入在途/防抖中）的卡片不覆盖
function syncWriteValues() {
    if (!liveCanRead) return;
    writeList.forEach((item) => {
        const c = writeCells[item.name];
        if (!c) return;
        if (writeTimers[item.name]) return;
        if (c.input.classList.contains("pending")) return;
        const ae = document.activeElement;
        if (ae === c.input || ae === c.slider) return;
        if (isWideInt(item.type)) {
            const text = latestText[item.name];
            if (text != null) c.setVal(text);
            return;
        }
        let v = Number(latest[item.name]);
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
    if (wasRunning !== liveRunning || wasWrite !== liveCanWrite || wasFresh !== liveSnapshotReady) renderWrites();
}
function openocdStatus(m) {
    m = m || {};
    lastOpenocd = m;
    const k = m.state || "checking",
        busy = k === "checking" || k === "installing";
    openocdCard.className = "openocd-card " + (k === "incompatible" ? "error" : k);
    openocdCard.style.display = k === "ready" ? "none" : "";
    openocdMessage.textContent = msgText(m) || t("oc.checking");
    openocdInstall.style.display = m.canInstall === false ? "none" : "";
    openocdCard.querySelectorAll("button").forEach((b) => (b.disabled = busy));
}
function renderSkillStatus(m) {
    lastSkill = m || lastSkill;
    const el = document.getElementById("skillStatus");
    if (!el) return;
    const status = lastSkill || {},
        state = status.state || "checking",
        keys = {
            outdated: "skill.outdated",
            modified: "skill.modified",
            notInstalled: "skill.notInstalled",
            noWorkspace: "skill.noWorkspace",
            checking: "skill.checking"
        };
    const hasCount = Number.isFinite(status.installed) && Number.isFinite(status.total) && status.total > 0;
    const label =
        state === "installed" && hasCount
            ? t("skill.statusInstalled")
            : state === "partial" && hasCount
              ? t("skill.statusPartial")
              : t(keys[state] || "skill.partial", status);
    el.textContent = "";
    const labelEl = document.createElement("span");
    labelEl.className = "skill-status-label";
    labelEl.textContent = label;
    el.appendChild(labelEl);
    if (hasCount) {
        const countEl = document.createElement("strong");
        countEl.className = "skill-status-count";
        countEl.textContent = status.installed + "/" + status.total;
        el.appendChild(countEl);
    }
    const scopeLine = (labelText, sc) => {
        if (!sc) return labelText + ": " + t("skill.noWorkspace");
        const cnt = Number.isFinite(sc.installed) && Number.isFinite(sc.total) && sc.total > 0;
        const txt =
            sc.state === "installed" && cnt
                ? t("skill.installed", { installed: sc.installed, total: sc.total })
                : sc.state === "partial" && cnt
                  ? t("skill.partial", { installed: sc.installed, total: sc.total })
                  : t(keys[sc.state] || "skill.notInstalled");
        return labelText + ": " + txt;
    };
    const skillLines = status.skills ? status.skills.map((s) => s.name + ": " + s.state) : [];
    el.title = status.scopes
        ? [
              scopeLine(t("skill.scopeWorkspace"), status.scopes.workspace),
              scopeLine(t("skill.scopeGlobal"), status.scopes.global)
          ]
              .concat(skillLines)
              .join("\\n")
        : skillLines.join("\\n");
    el.classList.toggle("accent", state === "installed");
}
function progress(m) {
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
        chipRead.disabled = st === "reading";
        chipRead.textContent = st === "reading" ? t("sb.readingEllipsis") : chipHasData ? t("sb.reread") : t("sb.read");
    }
    chipLabel.textContent = chipStatusLabel(st);
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
}
if (chipRead)
    chipRead.onclick = () => {
        if (!api) return setStat("error", "sb.extNotConnected");
        chipStatus({ state: "reading" });
        api.postMessage({ type: "readChipInfo" });
    };
if (svdSelect)
    svdSelect.onclick = () => api && api.postMessage({ type: "executeCommand", cmd: "mcu-vscode.selectExistingSvd" });
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
        liveToggle.disabled = true;
        api.postMessage({ type: "liveToggle" });
        setTimeout(() => (liveToggle.disabled = false), 500);
    }
};
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
const resizeHandle = document.getElementById("varResizeHandle"),
    variableBrowser = document.querySelector(".variable-browser");
if (uiState.variableHeight) availableBox.style.height = Math.max(80, Number(uiState.variableHeight)) + "px";
if (uiState.variableBrowserOpen === false) variableBrowser.open = false;
variableBrowser.addEventListener("toggle", () => {
    uiState.variableBrowserOpen = variableBrowser.open;
    if (api && api.setState) api.setState(uiState);
});
resizeHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startY = e.clientY,
        startHeight = availableBox.getBoundingClientRect().height;
    resizeHandle.classList.add("dragging");
    resizeHandle.setPointerCapture(e.pointerId);
    const move = (ev) => {
        const max = Math.max(120, window.innerHeight * 0.7),
            height = Math.min(max, Math.max(80, startHeight + ev.clientY - startY));
        availableBox.style.height = height + "px";
    };
    const end = (ev) => {
        resizeHandle.classList.remove("dragging");
        resizeHandle.releasePointerCapture(ev.pointerId);
        resizeHandle.removeEventListener("pointermove", move);
        resizeHandle.removeEventListener("pointerup", end);
        resizeHandle.removeEventListener("pointercancel", end);
        uiState.variableHeight = Math.round(availableBox.getBoundingClientRect().height);
        if (api && api.setState) api.setState(uiState);
    };
    resizeHandle.addEventListener("pointermove", move);
    resizeHandle.addEventListener("pointerup", end);
    resizeHandle.addEventListener("pointercancel", end);
});
// GitHub 反馈提示条:显示哪条由 host 决策(feedbackPrompt 消息),点击经 feedbackPromptAction 回传 host 执行跳转/静默
const feedbackPromptEl = document.getElementById("feedbackPrompt");
let lastFeedbackPrompt = null;
const FEEDBACK_GITHUB_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const FEEDBACK_ARROW_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>';
const FEEDBACK_TEXT_KEYS = { star: "fb.starText", issue: "fb.issueText", feature: "fb.featureText" };
function hideFeedbackPrompt() {
    lastFeedbackPrompt = null;
    if (feedbackPromptEl) feedbackPromptEl.hidden = true;
}
function renderFeedbackPrompt(m) {
    if (!feedbackPromptEl || !api) return;
    const kind = m && FEEDBACK_TEXT_KEYS[m.kind] ? m.kind : null;
    if (!kind) {
        hideFeedbackPrompt();
        return;
    }
    lastFeedbackPrompt = m;
    feedbackPromptEl.textContent = "";
    const txt = document.createElement("span");
    txt.className = "fp-text";
    txt.textContent = t(FEEDBACK_TEXT_KEYS[kind]);
    const link = document.createElement("button");
    link.type = "button";
    link.className = "fp-link";
    link.title = t("fb.openTitle");
    const ico = document.createElement("span");
    ico.className = "fp-ico";
    ico.innerHTML = FEEDBACK_GITHUB_SVG;
    const lbl = document.createElement("span");
    lbl.textContent = "Github";
    const arrow = document.createElement("span");
    arrow.className = "fp-arrow";
    arrow.innerHTML = FEEDBACK_ARROW_SVG;
    link.append(ico, lbl, arrow);
    link.onclick = () => {
        hideFeedbackPrompt();
        if (api) api.postMessage({ type: "feedbackPromptAction", kind: kind, action: "open" });
    };
    const close = document.createElement("button");
    close.type = "button";
    close.className = "fp-close";
    close.textContent = "\u2715";
    close.title = t("fb.dismissTitle");
    close.setAttribute("aria-label", t("fb.dismissTitle"));
    close.onclick = () => {
        hideFeedbackPrompt();
        if (api) api.postMessage({ type: "feedbackPromptAction", kind: kind, action: "dismiss" });
    };
    feedbackPromptEl.append(txt, link, close);
    feedbackPromptEl.hidden = false;
}
window.EmberProbeMessages.connect(window, {
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
        progress(m);
    },
    commandSuccess: function (m) {
        setStat("ready", "sb.commandDone");
    },
    commandError: function (m) {
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
        variableErrorKey = m.errorKey || "";
        variableErrorParams = m.params || null;
        variableError = m.errorKey ? t(m.errorKey, m.params) : m.error || "";
        renderAvailable();
    },
    liveSample: function (m) {
        updateValues(m.samples);
    },
    liveCompositeSample: function (m) {
        sbOnComposite(m.samples || []);
    },
    liveStatus: function (m) {
        liveStatus(m);
    },
    chipInfo: function (m) {
        renderChip(m.info);
    },
    chipInfoStatus: function (m) {
        chipStatus(m);
    },
    svdStatus: function (m) {
        svdStatus(m);
    },
    liveError: function (m) {
        liveStatus({
            running: liveRunning,
            error: true,
            key: m.key,
            params: m.params,
            message: m.message || t("sb.commandFailed")
        });
    },
    feedbackPrompt: function (m) {
        renderFeedbackPrompt(m);
    },
    setLang: function (m) {
        setLang(m.lang, false);
    }
});
updateLangToggle();
if (langToggle) langToggle.onclick = () => setLang(LANG === "zh" ? "en" : "zh", true);
if (api) api.postMessage({ type: "initCheck" });
else setStat("error", "sb.apiUnavailable");
