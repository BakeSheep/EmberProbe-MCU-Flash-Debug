var api = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null,
    CFG = window.__CFG__,
    MAXPTS = CFG.maxSamples;
var I18N = window.__I18N__ || { zh: {}, en: {} };
var LANG = window.__LANG__ === "en" ? "en" : "zh";
function t(k, p) {
    return window.EmberProbeRuntime.translate(I18N, LANG, k, p);
}
function msgText(m) {
    return m && m.key ? t(m.key, m.params) : m && m.message != null ? m.message : "";
}
var statusMsg = { key: "lw.ready" };
var TYPES = window.EmberProbeRuntime.SUPPORTED_TYPES,
    COLORS = ["#4FC1FF", "#F14C4C", "#73C991", "#FFCC00", "#C586C0", "#CE9178", "#569CD6", "#DCDCAA"];
var watch = [],
    data = Object.create(null),
    latest = Object.create(null),
    latestText = Object.create(null),
    valueCells = Object.create(null),
    hidden = Object.create(null),
    expanded = Object.create(null),
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
    lastDraw = 0;
var MAX_ARR_SHOWN = 16;
var wantImportOpen = false,
    impWarnings = [];
var saved = api && api.getState ? api.getState() : null,
    sideWidth = (saved && Number(saved.sideWidth)) || 260,
    sideCollapsed = !!(saved && saved.sideCollapsed),
    windowPreset = saved && saved.timeWindow && saved.timeWindow !== "custom" ? String(saved.timeWindow) : "30";
if (saved && saved.hidden) hidden = saved.hidden;
if (saved && typeof saved.norm === "boolean") norm = saved.norm;
if (saved && saved.expanded) expanded = saved.expanded;
if (saved && saved.dispSpec) dispSpec = saved.dispSpec;
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
    return i < COLORS.length ? COLORS[i] : "hsl(" + ((i * 47) % 360) + ",65%,60%)";
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
function fmtExact(v, valueText) {
    return valueText !== null && valueText !== undefined ? String(valueText) : fmtNum(v);
}
var buildCsv = window.__BUILD_CSV__;
function defType(size) {
    return window.EmberProbeRuntime.defaultType(size);
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
function saveUi() {
    if (api && api.setState)
        api.setState({
            hidden: hidden,
            expanded: expanded,
            dispSpec: dispSpec,
            timeWindow: windowPreset,
            sideWidth: sideWidth,
            sideCollapsed: sideCollapsed,
            norm: norm
        });
}
function ensureBuf(n) {
    if (!Object.prototype.hasOwnProperty.call(data, n)) data[n] = [];
}
function renderStatus() {
    var txt = statusMsg.key ? t(statusMsg.key, statusMsg.params) : statusMsg.message != null ? statusMsg.message : "";
    $("status").textContent = txt;
    $("dot").className = "status-dot " + (statusMsg.kind === "error" ? "err" : running ? "on" : "");
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
    renderVars();
    if (!$("overlay").classList.contains("hidden")) renderImport();
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
function addSymbol(sym) {
    if (
        !sym ||
        !sym.name ||
        watch.some(function (w) {
            return w.name === sym.name;
        })
    )
        return;
    if (sym.isComposite) {
        if (!sym.compositeLayout) {
            setStatusMsg({ message: sym.unsupportedReason || t("lw.compositeNoLayout") }, "error");
            return;
        }
        var lay = sym.compositeLayout;
        var addComp = function (disp) {
            if (disp) dispSpec[sym.name] = disp;
            else delete dispSpec[sym.name];
            watch.push({
                name: sym.name,
                address: Number(sym.address) || 0,
                size: Number(sym.size) || 4,
                type: "",
                isComposite: true,
                compositeLayout: lay
            });
            expanded[sym.name] = true;
            renderVars();
            saveWatch();
            saveUi();
            dirty = true;
        };
        if (lay.kind === "array" && (Number(lay.totalElements) || 0) > MAX_ARR_SHOWN)
            showArraySelectDialog(sym, addComp);
        else addComp(null);
        return;
    }
    watch.push({
        name: sym.name,
        address: Number(sym.address) || 0,
        size: Number(sym.size) || 4,
        type: sym.watchType || defType(sym.size || 4)
    });
    ensureBuf(sym.name);
    renderVars();
    saveWatch();
    dirty = true;
}
function removeVar(name) {
    var rmv = watch.filter(function (w) {
        return w.name === name || baseNameOf(w.name) === name;
    });
    watch = watch.filter(function (w) {
        return rmv.indexOf(w) < 0;
    });
    rmv.forEach(function (w) {
        delete data[w.name];
        delete latest[w.name];
        delete latestText[w.name];
        delete hidden[w.name];
    });
    delete expanded[name];
    delete dispSpec[name];
    renderVars();
    saveWatch();
    saveUi();
    dirty = true;
}
function renderVars() {
    var box = $("vars");
    box.textContent = "";
    valueCells = Object.create(null);
    compCells = Object.create(null);
    $("count").textContent = String(
        watch.filter(function (it) {
            return !isLeafChild(it.name);
        }).length
    );
    if (!watch.length) {
        var empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("lw.varListEmpty");
        box.appendChild(empty);
        return;
    }
    watch.forEach(function (item, idx) {
        if (isCompositeItem(item)) {
            renderCompositeCard(item, idx, box);
            return;
        }
        if (isLeafChild(item.name)) return;
        var card = document.createElement("div");
        card.className = "var-card";
        var sw = document.createElement("button");
        sw.className = "swatch" + (hidden[item.name] ? " off" : "");
        sw.style.background = colorFor(idx);
        sw.title = hidden[item.name] ? t("lw.showCurve") : t("lw.hideCurve");
        sw.onclick = function () {
            hidden[item.name] = !hidden[item.name];
            saveUi();
            renderVars();
            dirty = true;
        };
        var main = document.createElement("div");
        main.className = "var-main";
        var name = document.createElement("div");
        name.className = "var-name";
        name.textContent = item.name;
        name.title = item.name + " \u00b7 " + fmtAddr(item.address);
        var val = document.createElement("div");
        val.className = "var-value";
        val.textContent = fmtExact(latest[item.name], latestText[item.name]);
        valueCells[item.name] = val;
        main.append(name, val);
        var sel = document.createElement("select");
        sel.className = "type";
        TYPES.forEach(function (t) {
            var o = document.createElement("option");
            o.value = t;
            o.textContent = t;
            o.selected = t === item.type;
            sel.appendChild(o);
        });
        sel.onchange = function () {
            item.type = sel.value;
            data[item.name] = [];
            latest[item.name] = null;
            latestText[item.name] = null;
            updateValues();
            saveWatch();
            dirty = true;
        };
        var rm = document.createElement("button");
        rm.className = "remove";
        rm.textContent = "-";
        rm.title = t("lw.removeVar");
        rm.setAttribute("aria-label", t("lw.removeVarName", { name: item.name }));
        rm.onclick = function () {
            removeVar(item.name);
        };
        card.append(rm, sw, main, sel);
        box.appendChild(card);
    });
}
function updateValues() {
    Object.keys(valueCells).forEach(function (n) {
        valueCells[n].textContent = fmtExact(latest[n], latestText[n]);
    });
    watch.forEach(function (it) {
        if (isCompositeItem(it)) updateCompositeValues(it.name);
    });
}
function onSamples(samples) {
    if (frozen) return;
    var now = Date.now();
    sampleTimes.push(now);
    while (sampleTimes.length && sampleTimes[0] < now - 3000) sampleTimes.shift();
    $("rate").textContent = (sampleTimes.length / 3).toFixed(1) + " Hz";
    (samples || []).forEach(function (s) {
        var time = Number(s.t) || now;
        if (samplingOrigin === null) samplingOrigin = time;
        latest[s.name] = s.value;
        latestText[s.name] = s.valueText ?? null;
        if (s.value === null || s.value === undefined) return;
        ensureBuf(s.name);
        var arr = data[s.name];
        arr.push({ t: time, v: Number(s.value), valueText: s.valueText ?? null });
        if (arr.length > MAXPTS) arr.splice(0, arr.length - MAXPTS);
    });
    updateValues();
    dirty = true;
}
function isCompositeItem(it) {
    return !!(it && it.isComposite && it.compositeLayout);
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
    if (node.members) {
        node.members.forEach(function (m) {
            walkTreeLeaves(m, path + "." + m.name, cb);
        });
    } else if (node.elements) {
        node.elements.forEach(function (e) {
            walkTreeLeaves(e, path + "[" + e.index + "]", cb);
        });
    } else if ("value" in node) {
        cb(path, node);
    }
}
function updateCompositeValues(name) {
    var tree = latest[name];
    if (!tree) return;
    walkTreeLeaves(tree, name, function (path, node) {
        var cell = compCells[path];
        if (cell) cell.textContent = fmtExact(node.value, node.valueText);
    });
}
function renderLeafInto(container, label, typeName, path, watchType, address) {
    var row = document.createElement("div");
    row.className = "member-row";
    var wi = watch.findIndex(function (w) {
        return w.name === path;
    });
    var sw = document.createElement("button");
    sw.className = "member-swatch" + (wi < 0 ? " off" : "");
    if (wi >= 0) sw.style.background = colorFor(wi);
    sw.title = wi >= 0 ? t("lw.removeFromChart") : t("lw.addToChart");
    sw.onclick = function (e) {
        e.stopPropagation();
        toggleLeafInChart(path, address, watchType);
    };
    var nm = document.createElement("span");
    nm.className = "member-name";
    nm.textContent = label;
    nm.title = path;
    var ty = document.createElement("span");
    ty.className = "member-type";
    ty.textContent = typeName || watchType;
    var val = document.createElement("span");
    val.className = "member-value";
    val.textContent = "\u2014";
    compCells[path] = val;
    row.append(sw, nm, ty, val);
    container.appendChild(row);
}
function renderNestInto(container, layout, fieldName, path, baseAddr, offset) {
    var wrap = document.createElement("div");
    wrap.className = "comp-nest";
    var head = document.createElement("div");
    head.className = "comp-head";
    var arrow = document.createElement("span");
    arrow.className = "comp-arrow";
    arrow.textContent = "\u25B6";
    var nm = document.createElement("span");
    nm.className = "comp-name";
    nm.textContent = fieldName;
    var ty = document.createElement("span");
    ty.className = "comp-type";
    ty.textContent = layout.typeName || "";
    head.append(arrow, nm, ty);
    var body = document.createElement("div");
    body.className = "comp-members";
    head.onclick = function () {
        var open = body.classList.toggle("open");
        arrow.classList.toggle("open", open);
    };
    renderLayoutInto(body, layout, path, baseAddr, offset, null);
    wrap.append(head, body);
    container.appendChild(wrap);
}
function renderLayoutInto(container, layout, path, baseAddr, offset, disp) {
    if (!layout) return;
    if (layout.kind === "struct" || layout.kind === "union") {
        var ms = layout.members || [];
        ms.forEach(function (m) {
            var cp = path + "." + m.name,
                off = offset + (Number(m.offset) || 0);
            if (m.compositeLayout) renderNestInto(container, m.compositeLayout, m.name, cp, baseAddr, off);
            else if (m.watchType)
                renderLeafInto(container, m.name, m.typeName || m.watchType, cp, m.watchType, baseAddr + off);
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
        if (!et.watchType && !et.compositeLayout) {
            appendNote(container, t("lw.compositeNoLayout"));
            return;
        }
        for (var i = start; i < end; i++) {
            var cp = path + "[" + i + "]",
                off = offset + i * es;
            if (et.compositeLayout) renderNestInto(container, et.compositeLayout, "[" + i + "]", cp, baseAddr, off);
            else
                renderLeafInto(container, "[" + i + "]", et.typeName || et.watchType, cp, et.watchType, baseAddr + off);
        }
        if (total > end) appendNote(container, t("lw.arrayMore", { n: total - end }));
    }
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
    rm.textContent = "-";
    rm.title = t("lw.removeVar");
    rm.setAttribute("aria-label", t("lw.removeVarName", { name: item.name }));
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
    nm.textContent = item.name;
    var lay = item.compositeLayout || {};
    var ty = document.createElement("span");
    ty.className = "comp-type";
    ty.textContent = lay.typeName || "";
    var sz = document.createElement("span");
    sz.className = "comp-size";
    sz.textContent = (Number(item.size) || 0) + "B";
    sz.title = fmtAddr(item.address);
    head.append(arrow, nm, ty, sz);
    var body = document.createElement("div");
    body.className = "comp-body";
    head.onclick = function () {
        expanded[item.name] = !expanded[item.name];
        card.classList.toggle("open", expanded[item.name]);
        arrow.classList.toggle("open", expanded[item.name]);
        saveUi();
        dirty = true;
    };
    renderLayoutInto(body, lay, item.name, Number(item.address) >>> 0, 0, dispSpec[item.name] || null);
    content.append(head, body);
    card.append(rm, content);
    box.appendChild(card);
    updateCompositeValues(item.name);
}
function baseNameOf(n) {
    n = String(n);
    var d = n.indexOf("."),
        b = n.indexOf("[");
    var i = d < 0 ? b : b < 0 ? d : Math.min(d, b);
    return i < 0 ? n : n.slice(0, i);
}
function isLeafChild(name) {
    var b = baseNameOf(name);
    if (b === name) return false;
    return watch.some(function (w) {
        return w.name === b && isCompositeItem(w);
    });
}
function addLeafWatch(path, address, watchType) {
    if (
        watch.some(function (w) {
            return w.name === path;
        })
    )
        return false;
    watch.push({ name: path, address: Number(address) >>> 0, size: defW(watchType), type: watchType });
    ensureBuf(path);
    return true;
}
function toggleLeafInChart(path, address, watchType) {
    var i = watch.findIndex(function (w) {
        return w.name === path;
    });
    if (i >= 0) {
        watch.splice(i, 1);
        delete data[path];
        delete latest[path];
        delete latestText[path];
        delete hidden[path];
    } else {
        addLeafWatch(path, address, watchType);
    }
    renderVars();
    saveWatch();
    dirty = true;
}
function collectLeaves(layout, name, baseAddr) {
    var out = [];
    (function walk(lyt, path, off) {
        if (!lyt) return;
        if (lyt.kind === "struct" || lyt.kind === "union") {
            (lyt.members || []).forEach(function (m) {
                var cp = path + "." + m.name,
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
            var et = lyt.elementType || {},
                total = Number(lyt.totalElements) || 0,
                es = Number(et.byteSize) || 0,
                end = Math.min(total, MAX_ARR_SHOWN);
            for (var i = 0; i < end; i++) {
                var cp = path + "[" + i + "]",
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
function onCompositeSamples(samples) {
    if (frozen) return;
    (samples || []).forEach(function (s) {
        if (s && s.name) latest[s.name] = s.tree;
    });
    watch.forEach(function (it) {
        if (isCompositeItem(it)) updateCompositeValues(it.name);
    });
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
    h.textContent = t("lw.arraySelectTitle") + " \u00b7 " + sym.name + "[" + total + "]";
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
    var iv = Math.min(10000, Math.max(20, parseInt($("interval").value, 10) || CFG.intervalMs));
    $("interval").value = String(iv);
    starting = true;
    updateRun();
    setStatusKey("lw.starting");
    post({ type: "start", items: watch, intervalMs: iv });
}
function stop() {
    if (!running && !starting) return;
    starting = false;
    post({ type: "stop" });
    setStatusKey("lw.stopping");
    updateRun();
}
function clearHistory() {
    Object.keys(data).forEach(function (n) {
        data[n] = [];
    });
    Object.keys(latest).forEach(function (n) {
        latest[n] = null;
        latestText[n] = null;
    });
    sampleTimes = [];
    samplingOrigin = null;
    $("rate").textContent = "0 Hz";
    updateValues();
    resetChartView();
    dirty = true;
}
function renderImport() {
    var f = ($("impFilter").value || "").toLowerCase(),
        box = $("impList");
    box.textContent = "";
    var matched = allSymbols.filter(function (s) {
            return !f || s.name.toLowerCase().indexOf(f) >= 0;
        }),
        shown = matched.slice(0, 1000);
    shown.forEach(function (s) {
        var gi = allSymbols.indexOf(s);
        if (s.isComposite && s.compositeLayout) {
            var row = document.createElement("div");
            row.className = "imp-row";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.dataset.idx = String(gi);
            cb.title = t("lw.compositeExpandable");
            var nmWrap = document.createElement("span");
            nmWrap.className = "imp-name-wrap";
            var arrow = document.createElement("span");
            arrow.className = "imp-arrow";
            arrow.textContent = "\u25B6";
            var nm = document.createElement("span");
            nm.className = "imp-name";
            nm.textContent = "\u25c7 " + s.name;
            nmWrap.append(arrow, nm);
            var ty = document.createElement("span");
            ty.className = "ty";
            ty.textContent = s.typeName || t("sb.composite");
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
            collectLeaves(s.compositeLayout, s.name, s.address).forEach(function (lf) {
                var lr = document.createElement("label");
                lr.className = "imp-row leaf";
                var lcb = document.createElement("input");
                lcb.type = "checkbox";
                lcb.dataset.leafPath = lf.path;
                lcb.dataset.leafAddr = String(lf.address);
                lcb.dataset.leafType = lf.type;
                var ln = document.createElement("span");
                ln.className = "imp-leaf-name";
                ln.textContent = lf.label;
                var lty = document.createElement("span");
                lty.className = "ty";
                lty.textContent = lf.type;
                var la = document.createElement("span");
                la.className = "address";
                la.textContent = fmtAddr(lf.address);
                var lz = document.createElement("span");
                lz.className = "size";
                lr.append(lcb, ln, lty, la, lz);
                kids.appendChild(lr);
            });
            box.appendChild(kids);
            var toggle = function (e) {
                e.preventDefault();
                e.stopPropagation();
                var open = kids.classList.toggle("open");
                arrow.classList.toggle("open", open);
            };
            arrow.onclick = toggle;
            nm.onclick = toggle;
        } else {
            var row2 = document.createElement("label");
            row2.className = "imp-row";
            if (s.isComposite && !s.compositeLayout) row2.title = s.unsupportedReason || t("lw.compositeNoLayout");
            var cb2 = document.createElement("input");
            cb2.type = "checkbox";
            cb2.disabled = !!(s.isComposite && !s.compositeLayout);
            cb2.dataset.idx = String(gi);
            var nm2 = document.createElement("span");
            nm2.textContent = (s.isComposite ? "\u25c7 " : "") + s.name;
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
    $("impCount").textContent =
        t("lw.totalVars", { n: allSymbols.length }) +
        (matched.length > shown.length ? t("lw.showingFirst", { n: shown.length }) : "");
}
function showImport(symbols, warnings) {
    allSymbols = symbols || [];
    impWarnings = warnings || [];
    openImport();
}
function openImport() {
    $("impFilter").value = "";
    $("impWarn").textContent = impWarnings && impWarnings.length ? impWarnings.join("；") : "";
    renderImport();
    $("overlay").classList.remove("hidden");
}
function hideImport() {
    $("overlay").classList.add("hidden");
}
function renderAutocomplete() {
    var drop = $("acDrop");
    if (!drop) return;
    var q = ($("addName").value || "").trim().toLowerCase();
    drop.textContent = "";
    if (!q) {
        drop.classList.remove("open");
        return;
    }
    var matches = allSymbols
        .filter(function (s) {
            return s.name.toLowerCase().indexOf(q) >= 0;
        })
        .slice(0, 12);
    if (!matches.length) {
        drop.classList.remove("open");
        return;
    }
    matches.forEach(function (s) {
        var it = document.createElement("div");
        it.className = "ac-item";
        var nm = document.createElement("span");
        nm.className = "ac-name";
        nm.textContent = (s.isComposite ? "\u25c7 " : "") + s.name;
        var ty = document.createElement("span");
        ty.className = "ac-type";
        ty.textContent = s.typeName || s.watchType || defType(s.size);
        it.append(nm, ty);
        it.onmousedown = function (e) {
            e.preventDefault();
            addSymbol(s);
            $("addName").value = "";
            drop.classList.remove("open");
        };
        drop.appendChild(it);
    });
    drop.classList.add("open");
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
        if (addLeafWatch(cb.dataset.leafPath, Number(cb.dataset.leafAddr) || 0, cb.dataset.leafType)) changed = true;
    });
    syms.forEach(function (s) {
        addSymbol(s);
    });
    if (changed) {
        renderVars();
        saveWatch();
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
function csvDataRows(candidates, opts) {
    var times = new Set(),
        from = Number.isFinite(opts && opts.from) ? opts.from : -Infinity,
        to = Number.isFinite(opts && opts.to) ? opts.to : Infinity;
    (candidates || []).forEach(function (c) {
        (c.buffer || []).forEach(function (p) {
            var time = Number(p && p.t);
            if (Number.isFinite(time) && time >= from && time <= to) times.add(time);
        });
    });
    return times.size;
}
function hideExport() {
    $("exportOverlay").classList.add("hidden");
    $("exportWarn").textContent = "";
}
function showExport() {
    post({ type: "samplingArchiveInfo", openExport: true });
}
function showArchiveExport(info) {
    var names = Array.isArray(info && info.variables) ? info.variables : [],
        first = Number(info && info.firstTimestampMs),
        last = Number(info && info.lastTimestampMs);
    if (!names.length || !Number.isFinite(first) || !Number.isFinite(last)) {
        setStatusKey("lw.noDataToExport", null, "error");
        return;
    }
    exportCandidates = names.map(function (name) {
        return { name: name, buffer: [{ t: first }, { t: last }] };
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
        name.textContent = item.name;
        label.append(cb, name);
        box.appendChild(label);
    });
    setupExportTimeline(exportCandidates);
    var all = $("exportRanges").querySelector("input[value=all]");
    if (all) all.checked = true;
    setExportTimelineMode();
    $("exportWarn").textContent = "";
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
        names: selected.map(function (c) {
            return c.name;
        }),
        fromMs: opts.from,
        toMs: opts.to
    });
    hideExport();
}
function agentExportCsv(m) {
    var requested = Array.isArray(m.names) ? m.names.filter(Boolean) : [],
        available = [];
    watch.forEach(function (item) {
        var buffer = data[item.name];
        if (buffer && buffer.length) available.push({ name: item.name, buffer: buffer });
    });
    var byName = new Map(
            available.map(function (item) {
                return [item.name, item];
            })
        ),
        missing = requested.filter(function (name) {
            return !byName.has(name);
        }),
        selected = requested.length
            ? requested
                  .map(function (name) {
                      return byName.get(name);
                  })
                  .filter(Boolean)
            : available;
    if (missing.length) {
        post({
            type: "agentExportCsvResult",
            requestId: m.requestId,
            ok: false,
            code: "CSV_SERIES_NOT_FOUND",
            message: "Chart series not found: " + missing.join(", "),
            details: { missing: missing }
        });
        return;
    }
    if (!selected.length) {
        post({
            type: "agentExportCsvResult",
            requestId: m.requestId,
            ok: false,
            code: "CSV_EXPORT_EMPTY",
            message: "The selected chart has no sampled series"
        });
        return;
    }
    var opts = {},
        from = Number(m.from),
        to = Number(m.to);
    if (Number.isFinite(from)) opts.from = from;
    if (Number.isFinite(to)) opts.to = to;
    if (opts.from !== undefined && opts.to !== undefined && opts.from > opts.to) {
        post({
            type: "agentExportCsvResult",
            requestId: m.requestId,
            ok: false,
            code: "INVALID_CSV_RANGE",
            message: "CSV export time range is invalid"
        });
        return;
    }
    var rows = csvDataRows(selected, opts);
    if (!rows) {
        post({
            type: "agentExportCsvResult",
            requestId: m.requestId,
            ok: false,
            code: "CSV_EXPORT_EMPTY",
            message: "The selected range has no chart samples"
        });
        return;
    }
    var bounds = exportBounds(selected);
    post({
        type: "agentExportCsvResult",
        requestId: m.requestId,
        ok: true,
        names: selected.map(function (item) {
            return item.name;
        }),
        from: opts.from === undefined ? bounds.from : opts.from,
        to: opts.to === undefined ? bounds.to : opts.to,
        seriesCount: selected.length,
        rowCount: rows,
        csv: buildCsv(
            selected.map(function (item) {
                return item.name;
            }),
            selected.map(function (item) {
                return item.buffer;
            }),
            opts
        )
    });
}
var VP = window.EmberChartViewport,
    canvas = $("chart"),
    ctx = canvas.getContext("2d"),
    chartStage = $("chartStage");
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
    $("chartOverview").classList.add("disabled");
}
function chartData() {
    var series = [];
    watch.forEach(function (item, idx) {
        if (hidden[item.name]) return;
        var arr = data[item.name] || [],
            segment = [];
        function flush() {
            if (segment.length) {
                series.push({ item: item, idx: idx, arr: segment });
                segment = [];
            }
        }
        arr.forEach(function (point) {
            if (point && Number.isFinite(point.v) && Number.isFinite(point.t)) segment.push(point);
            else flush();
        });
        flush();
    });
    return series;
}
function retainedTimeBounds() {
    var lo = Infinity,
        hi = -Infinity;
    watch.forEach(function (item) {
        (data[item.name] || []).forEach(function (p) {
            var tt = Number(p && p.t);
            if (Number.isFinite(tt)) {
                lo = Math.min(lo, tt);
                hi = Math.max(hi, tt);
            }
        });
    });
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return { min: lo, max: Math.max(lo + 1, hi) };
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
        if ($("timeWindow").value !== "custom") applyWindowPreset(windowPreset);
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
        $("chartTimelineSelection").textContent = "—";
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
    $("chartTimelineSelection").textContent = t("lw.chartSelectedRange", {
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
    var series = chartData(),
        hasBounds = syncTimeBounds();
    refreshChartTimeline();
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
        formatChartTime,
        t
    });
}
function chartRegion(x, y) {
    var g = chartState.geometry;
    if (!g) return "none";
    if (x >= g.padL && x <= g.padL + g.pw && y >= g.padT && y <= g.padT + g.ph) return "plot";
    if (x >= g.padL && x <= g.padL + g.pw && y > g.padT + g.ph && y <= g.h) return "x";
    if (x < g.padL && y >= g.padT && y <= g.padT + g.ph) return "y";
    return "none";
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
            dx = p.x - chartState.drag.start.x,
            dy = p.y - chartState.drag.start.y,
            center = (chartState.drag.y.min + chartState.drag.y.max) / 2,
            minY = Math.max(Number.EPSILON, Math.abs(center) * 1e-12),
            factor = Math.exp(Math.max(-4, Math.min(4, (dy / g.ph) * 4)));
        chartState.x = VP.panClamped(
            chartState.drag.x,
            (-dx / g.pw) * VP.span(chartState.drag.x),
            chartState.bounds,
            minimumXSpan()
        );
        chartState.y = VP.zoomCentered(chartState.drag.y, factor, minY);
        chartState.autoY = false;
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
    if (e.button !== 2 || chartRegion(p.x, p.y) !== "plot" || !chartState.x || !chartState.y) return;
    e.preventDefault();
    chartState.drag = {
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
    chartState.drag = null;
    chartStage.classList.remove("dragging");
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    setCanvasCursor(chartState.pointer ? "plot" : "none");
    chartState.fastDirty = true;
    dirty = true;
}
canvas.addEventListener("pointerup", endChartDrag);
canvas.addEventListener("pointercancel", endChartDrag);
canvas.addEventListener("contextmenu", function (e) {
    var p = canvasPoint(e);
    if (chartState.drag || chartRegion(p.x, p.y) === "plot") e.preventDefault();
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
            chartState.y = VP.zoomCentered(chartState.y, factor, minY);
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
    chartState.follow = !chartState.endpointDrag && chartState.x.max === chartState.bounds.max;
    setWindowCustom();
    chartState.fastDirty = true;
    dirty = true;
}
function beginTimelineEndpoint(edge) {
    chartState.endpointDrag = edge;
    chartState.follow = false;
}
function endTimelineEndpoint() {
    chartState.endpointDrag = null;
    chartState.follow = !!(chartState.x && chartState.bounds && chartState.x.max === chartState.bounds.max);
    chartState.fastDirty = true;
    dirty = true;
}
$("chartFromRange").onpointerdown = function () {
    beginTimelineEndpoint("min");
};
$("chartToRange").onpointerdown = function () {
    beginTimelineEndpoint("max");
};
$("chartFromRange").oninput = function () {
    updateTimelineEndpoint("min");
};
$("chartToRange").oninput = function () {
    updateTimelineEndpoint("max");
};
$("chartFromRange").onpointerup =
    $("chartFromRange").onpointercancel =
    $("chartFromRange").onchange =
        endTimelineEndpoint;
$("chartToRange").onpointerup = $("chartToRange").onpointercancel = $("chartToRange").onchange = endTimelineEndpoint;
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
    requestAnimationFrame(loop);
}
window.EmberProbeMessages.connect(window, {
    watchList: function (m) {
        watch = (m.items || []).slice();
        if (m.resetValues) {
            watch.forEach(function (item) {
                delete latest[item.name];
                delete latestText[item.name];
            });
        }
        Object.keys(hidden).forEach(function (n) {
            if (
                !watch.some(function (w) {
                    return w.name === n;
                })
            )
                delete hidden[n];
        });
        watch.forEach(function (w) {
            ensureBuf(w.name);
        });
        renderVars();
        dirty = true;
    },
    variablesList: function (m) {
        allSymbols = m.symbols || [];
        impWarnings = m.warnings || [];
        if (wantImportOpen) {
            wantImportOpen = false;
            openImport();
        } else renderAutocomplete();
    },
    addResolved: function (m) {
        addSymbol(m.symbol);
    },
    liveSample: function (m) {
        onSamples(m.samples || []);
    },
    liveCompositeSample: function (m) {
        onCompositeSamples(m.samples || []);
    },
    agentExportCsv: function (m) {
        agentExportCsv(m);
    },
    liveStatus: function (m) {
        var fresh = window.EmberProbeRuntime.liveState({ running: running }, m).fresh;
        document.body.classList.toggle("debug-stale", !fresh);
        if (typeof m.running === "boolean") {
            running = m.running;
            if (!running) {
                sampleTimes = [];
                $("rate").textContent = "0 Hz";
            }
        }
        starting = false;
        updateRun();
        m.key || m.message != null
            ? setStatusMsg({ key: m.key, params: m.params, message: m.message }, m.error ? "error" : "")
            : setStatusKey(running ? "sb.sampling" : "sb.stopped", null, m.error ? "error" : "");
    },
    liveError: function (m) {
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
    post({ type: "importVariables" });
};
$("addBtn").onclick = function () {
    var n = $("addName").value.trim();
    if (!n) return;
    var sym = allSymbols.find(function (s) {
        return s.name === n;
    });
    if (sym) addSymbol(sym);
    else post({ type: "resolveVariable", name: n });
    $("addName").value = "";
    var d = $("acDrop");
    if (d) d.classList.remove("open");
};
$("addName").oninput = function () {
    if (!allSymbols.length) post({ type: "importVariables" });
    renderAutocomplete();
};
$("addName").onblur = function () {
    setTimeout(function () {
        var d = $("acDrop");
        if (d) d.classList.remove("open");
    }, 150);
};
$("addName").onkeydown = function (e) {
    if (e.key === "Enter") $("addBtn").click();
    else if (e.key === "Escape") {
        var d = $("acDrop");
        if (d) d.classList.remove("open");
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
$("clear").onclick = clearHistory;
$("export").onclick = function () {
    var names = [],
        bufs = [];
    watch.forEach(function (w) {
        var arr = data[w.name];
        if (arr && arr.length) {
            names.push(w.name);
            bufs.push(arr);
        }
    });
    if (!names.length) {
        setStatusKey("lw.noDataToExport", null, "error");
        return;
    }
    post({ type: "exportCsv", csv: buildCsv(names, bufs) });
};
$("freeze").onclick = function () {
    frozen = !frozen;
    this.textContent = frozen ? t("lw.resume") : t("lw.freeze");
    chartState.fastDirty = true;
    dirty = true;
};
$("timeWindow").onchange = function () {
    if (this.value !== "custom") {
        applyWindowPreset(this.value);
        saveUi();
    }
};
$("interval").onchange = function () {
    var iv = Math.min(10000, Math.max(20, parseInt($("interval").value, 10) || CFG.intervalMs));
    $("interval").value = String(iv);
    post({ type: "setInterval", intervalMs: iv });
};
$("norm").onclick = function () {
    norm = !norm;
    chartState.autoY = true;
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
    samplingArchiveInfo: function (m) {
        var first = Number(m.firstTimestampMs);
        if (Number(m.rows) > 0 && Number.isFinite(first)) samplingOrigin = first;
        if (m.openExport) showArchiveExport(m);
    },
    exportCsvResult: function (m) {
        if (m.ok) {
            setStatusKey("lw.exportSuccess", { series: m.seriesCount, rows: m.rowCount });
        }
    },
    liveInterval: function (m) {
        $("interval").value = String(m.intervalMs);
    }
});
var layout = $("layout"),
    sideSplitter = $("sideSplitter"),
    sideToggle = $("sideToggle");
function applySideLayout() {
    layout.style.setProperty("--side-width", sideWidth + "px");
    layout.classList.toggle("side-collapsed", sideCollapsed);
    sideToggle.textContent = (sideCollapsed ? "› " : "‹ ") + t("lw.valuePane");
    sideToggle.title = sideCollapsed ? t("lw.expandPane") : t("lw.collapsePane");
    dirty = true;
}
sideToggle.onclick = function () {
    sideCollapsed = !sideCollapsed;
    applySideLayout();
    saveUi();
};
sideSplitter.addEventListener("pointerdown", function (e) {
    if (window.innerWidth <= 760) return;
    e.preventDefault();
    if (sideCollapsed) {
        sideCollapsed = false;
        applySideLayout();
    }
    var startX = e.clientX,
        startWidth = document.querySelector(".side").getBoundingClientRect().width;
    sideSplitter.classList.add("dragging");
    sideSplitter.setPointerCapture(e.pointerId);
    var move = function (ev) {
        var max = Math.max(220, layout.getBoundingClientRect().width - 300);
        sideWidth = Math.min(max, Math.max(220, startWidth + ev.clientX - startX));
        layout.style.setProperty("--side-width", sideWidth + "px");
        dirty = true;
    };
    var end = function (ev) {
        sideSplitter.classList.remove("dragging");
        sideSplitter.releasePointerCapture(ev.pointerId);
        sideSplitter.removeEventListener("pointermove", move);
        sideSplitter.removeEventListener("pointerup", end);
        sideSplitter.removeEventListener("pointercancel", end);
        sideWidth = Math.round(document.querySelector(".side").getBoundingClientRect().width);
        saveUi();
    };
    sideSplitter.addEventListener("pointermove", move);
    sideSplitter.addEventListener("pointerup", end);
    sideSplitter.addEventListener("pointercancel", end);
});
applySideLayout();
new ResizeObserver(function () {
    dirty = true;
}).observe($("chartWrap"));
updateRun();
updateLangToggle();
if (norm) $("norm").classList.remove("ghost");
var _lt = $("langToggle");
if (_lt)
    _lt.onclick = function () {
        setLang(LANG === "zh" ? "en" : "zh", true);
    };
post({ type: "samplingArchiveInfo" });
post({ type: "ready" });
requestAnimationFrame(loop);
