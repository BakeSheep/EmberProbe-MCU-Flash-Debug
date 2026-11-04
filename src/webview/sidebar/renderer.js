"use strict";
const api = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null,
    dot = document.getElementById("statusDot"),
    text = document.getElementById("statusText"),
    flashStatus = document.getElementById("flashStatus"),
    liveBox = document.getElementById("liveValues"),
    liveCard = liveBox && liveBox.closest(".live-box"),
    writeBox = document.getElementById("writeValues"),
    availableBox = document.getElementById("availableVars"),
    liveState = document.getElementById("liveState"),
    liveLabel = document.getElementById("liveLabel"),
    liveToggle = document.getElementById("liveToggle"),
    langToggle = document.getElementById("langToggle");
const { isComposite } = EmberProbeValueTree;
// Notice boxes by area; the extension addresses them as { area, id } and the cards below own their slots.
const NOTICE_SLOTS = {
    global: "noticeGlobal",
    flash: "noticeFlash",
    config: "noticeConfig",
    chip: "noticeChip",
    live: "noticeLive",
    write: "noticeWrite"
};
const notices = Object.create(null);
function noticeArea(area) {
    if (notices[area]) return notices[area];
    const slot = document.getElementById(NOTICE_SLOTS[area] || NOTICE_SLOTS.global);
    if (!slot) return null;
    notices[area] = window.EmberProbeNotice.createNoticeArea(slot, {
        t: (key, params) => t(key, params),
        onCopy: (report) => api?.postMessage({ type: "copyText", text: report }),
        onAction: (action) => {
            if (!api) return;
            if (action.command) api.postMessage({ type: "executeCommand", cmd: action.command });
            else if (action.message) api.postMessage(action.message);
        },
        onDismiss: (id) => api?.postMessage({ type: "noticeDismiss", area, id })
    });
    return notices[area];
}
function setNotice(area, id, notice) {
    noticeArea(area)?.set(id, notice);
}
function clearNotice(area, id) {
    notices[area]?.clear(id);
}
let availableTypesReady = true,
    availableLayoutPending = new Set(),
    availableAddPending = new Set(),
    // Scalar pointer symbols whose runtime type graph was requested to offer expansion.
    sbPointerLayoutWaiters = new Set(),
    availableTypeChunks = 0,
    liveRunning = false,
    liveCanRead = false,
    liveCanWrite = false,
    liveSnapshotReady = true,
    variableError = "",
    variableErrorKey = "",
    variableErrorParams = null,
    variableWarnings = [],
    lastSkill = { state: "checking" },
    lastAgentAccess = null,
    uiState = api && api.getState ? api.getState() || {} : {};
// Watch and write lists, ELF symbols, readings and view expansion; the value tree reads them too.
const state = {
    watch: [],
    writeList: [],
    available: [],
    symbols: new Map(),
    version: "",
    generation: null,
    latest: Object.create(null),
    latestText: Object.create(null),
    latestEnum: Object.create(null),
    latestPointer: Object.create(null),
    expanded: (uiState && uiState.sbExpanded) || Object.create(null),
    rawMembers: uiState.sbRawMembers || Object.create(null),
    // Elements shown per static array path once "show more" was used.
    arrayShown: uiState.sbArrayShown || Object.create(null),
    availableExpanded: Object.create(null)
};
const valueTree = EmberProbeValueTree.create({
    t: (key, params) => t(key, params),
    classes: {
        row: "sb-mrow",
        name: "sb-mname",
        type: "sb-mtype",
        value: "sb-mval",
        nest: "",
        head: "sb-comp-head",
        arrow: "sb-arrow",
        headName: "sb-comp-name",
        headType: "sb-comp-type",
        members: "sb-members",
        note: "sb-note"
    },
    state,
    savedPointers: { pointers: uiState.sbLastPointers, version: uiState.sbLastPointersVersion },
    displayName: (path) => sbDisplayName({ name: path }),
    save: () => saveSbUi(),
    rerender: () => renderValues(),
    rerenderPicker: () => renderAvailable(),
    post: (message) => api?.postMessage(message),
    copy: (text) => api?.postMessage({ type: "copyText", text }),
    layoutExpansion: () => layoutExpansionUi,
    requestPointerLayout: (name) => {
        if (!api || !state.version || availableLayoutPending.has(name)) return;
        availableLayoutPending.add(name);
        sbPointerLayoutWaiters.add(name);
        api.postMessage({ type: "resolveCompositeLayout", name, version: state.version });
    },
    togglePointee: (entry) => sbTogglePointee(entry),
    decorateLeaf: (row, name) => name,
    scalarCell: (cell, name) => {
        cell.dataset.valueName = name;
    }
});
const valueRefresh = EmberProbeValueTree.createThrottle(100, () => refreshDisplayedValues());
const writes = EmberProbeWriteList.create({
    box: writeBox,
    count: document.getElementById("writeCount"),
    state,
    t: (key, params) => t(key, params),
    displayName: (item) => sbDisplayName(item),
    post: api && ((message) => api.postMessage(message)),
    changed: () => updateAvailableSelections(),
    notice: {
        set: (notice) => setNotice("write", "write", notice),
        clear: () => clearNotice("write", "write"),
        level: () => notices.write?.get("write")?.level
    }
});
// Members and pointees follow their card when it is dragged to a new place.
function sbAttachedEntry(entry, name) {
    return (
        EmberProbeRuntime.variableBaseName(entry.name) === name || EmberProbeRuntime.isPointeeDescendant(entry, name)
    );
}
const sbWatchReorder =
    liveBox &&
    EmberProbeCardReorder.attach(liveBox, {
        onMove: (name, target, after) => {
            const next = EmberProbeCardReorder.moveBlock(state.watch, name, target, after, sbAttachedEntry);
            if (next === state.watch) return;
            state.watch = next;
            renderValues();
            saveSideWatch();
        }
    });
var I18N = window.__I18N__ || { zh: {}, en: {} };
var LANG = window.__LANG__ === "en" ? "en" : "zh";
function t(k, p) {
    return window.EmberProbeRuntime.translate(I18N, LANG, k, p);
}
const layoutExpansionUi = EmberProbeRuntime.createLayoutExpansionUi({
    post: (message) => api?.postMessage(message),
    version: () => state.version,
    generation: () => state.generation,
    symbol: (path) => valueTree.layoutSymbol(path),
    displayName: (path) => sbDisplayName({ name: path }),
    changed: () => {
        for (const item of state.watch) {
            const symbol = state.symbols.get(item.name);
            if (
                symbol?.compositeLayout &&
                symbol.compositeLayout.expansionGeneration === item.compositeLayout?.expansionGeneration
            ) {
                item.layoutExpansions = symbol?.layoutExpansions;
                item.layoutExpansionGeneration = symbol?.layoutExpansionGeneration;
            }
        }
        renderAvailable();
        renderValues();
    }
});
function msgText(m) {
    return m && m.key ? t(m.key, m.params) : m && m.message != null ? m.message : "";
}
var lastOpenocd = { state: "checking" },
    lastLive = { running: false, key: "sb.waiting" },
    lastChip = { state: "idle" },
    lastSvd = { state: "idle", key: "svd.notConfigured" },
    lastChipInfo = null,
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
    jlinkDriverState = document.getElementById("jlinkDriverState"),
    probeConfig = document.getElementById("probeConfig"),
    connectedProbeList = document.getElementById("connectedProbeList"),
    connectedProbeAuto = document.getElementById("connectedProbeAuto"),
    connectedProbeRefresh = document.getElementById("connectedProbeRefresh"),
    probeDriverHome = document.getElementById("probeDriverHome"),
    otherConfig = document.getElementById("otherConfig");
const peripheralView = window.EmberProbePeripheralView?.create({ api, t, uiState });
const rtosView = window.EmberProbeRtosView?.create({ api, t, uiState });
const memoryView = window.EmberProbeMemoryView?.create({ api, t, uiState });
const agentControls = EmberProbeAgentControls.create({ document, api, state, uiState, setNotice, clearNotice, t });
const mcuConfigSection = document.getElementById("mcuConfigSection");
for (const id of [
    "mcuConfigSection",
    "agentConfigSection",
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
    // Refresh is reading the chip on each listed probe.
    probeTargetScan = false,
    // The connected-probe list last posted by the extension and the J-Link whose driver is switching. The list
    // and driver controls show confirmed state until the extension posts a new list.
    lastConnectedProbes = null,
    connectedProbeLocked = true,
    // Auto is pressed while no device is saved; pressing it again saves this automatically chosen device.
    connectedProbeAutomatic = false,
    connectedProbeKeepId = "",
    driverSwitchDeviceId = "";
function setProbeDriverBusy(busy) {
    probeDriverBusy = busy;
    if (jlinkDriverChoice) jlinkDriverChoice.disabled = busy;
    connectedProbeList?.querySelectorAll("select.jlink-driver-choice").forEach((control) => {
        control.disabled = busy;
    });
    connectedProbeList?.querySelectorAll("button.probe-card-main").forEach((button) => {
        button.disabled = busy || connectedProbeLocked || !button.dataset.selectable;
    });
    connectedProbeList?.querySelectorAll("button.probe-target-accept").forEach((button) => {
        button.disabled = busy;
    });
    if (connectedProbeAuto) connectedProbeAuto.disabled = busy || (connectedProbeAutomatic && !connectedProbeKeepId);
    if (connectedProbeRefresh) {
        connectedProbeRefresh.disabled = busy || probeTargetScan;
        connectedProbeRefresh.classList.toggle("scanning", probeTargetScan);
    }
    if (jlinkDriverBusy) jlinkDriverBusy.hidden = !busy;
    if (chipRead) chipRead.disabled = busy || lastChip.state === "reading";
    chipBody?.querySelectorAll(".chip-control").forEach((button) => {
        button.disabled = busy || lastChip.state === "reading";
    });
    liveToggle.disabled = busy;
    document.querySelectorAll(".primary-actions [data-command]").forEach((button) => (button.disabled = busy));
}
const PROBE_FAMILY_LABELS = {
    jlink: "J-Link",
    "cmsis-dap": "CMSIS-DAP",
    stlink: "ST-Link",
    xds110: "XDS110",
    nulink: "Nu-Link"
};
const PROBE_CARD_ICONS = {
    usb: '<path d="M12 3v13"/><circle cx="12" cy="19" r="2.5"/><path d="m9 6 3-3 3 3M12 13l-5-3V8M12 11l5-3V6"/><rect x="5.5" y="6" width="3" height="2"/><circle cx="17" cy="5" r="1.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    current: '<path d="m5 12.5 4.5 4.5L19 7.5"/>'
};
// Every entry of the list is the same card: a device the user can pick, the saved device that is not connected,
// or a line explaining why the list cannot pick one. Only a device card holds a button.
function probeCard({ deviceId, title, detail, tooltip, tag, tagClass, selected, current, selectable, info, warn }) {
    const card = document.createElement("div");
    card.className =
        "tree-row probe-card" +
        (info ? " probe-info-card" : "") +
        (warn ? " warn" : "") +
        (selected ? " selected" : "");
    const main = document.createElement(info ? "span" : "button");
    main.className = "probe-card-main";
    if (!info) {
        main.type = "button";
        main.dataset.deviceId = deviceId || "";
        main.dataset.selectable = selectable ? "1" : "";
        main.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    main.insertAdjacentHTML(
        "afterbegin",
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + PROBE_CARD_ICONS[info ? "info" : "usb"] + "</svg>"
    );
    const copy = document.createElement("span");
    copy.className = "row-copy";
    const name = document.createElement("span");
    name.textContent = title;
    copy.append(name);
    if (detail) {
        const small = document.createElement("small");
        small.textContent = detail;
        copy.append(small);
    }
    main.append(copy);
    card.append(main);
    // The device in use is marked by a check; its button is pressed and its tooltip says why it is used.
    if (current)
        card.insertAdjacentHTML(
            "beforeend",
            '<svg class="probe-current" viewBox="0 0 24 24" aria-hidden="true">' + PROBE_CARD_ICONS.current + "</svg>"
        );
    if (tag) {
        const label = document.createElement("span");
        label.className = "tag " + (tagClass || "");
        label.textContent = tag;
        card.append(label);
    }
    card.title = tooltip || "";
    return card;
}
// The driver a J-Link's control shows, or "" when the helper cannot switch it.
function switchableDriver(device) {
    const kind = device?.driver?.kind;
    return kind === "repair" ? "segger" : kind === "ready" ? "winusb" : "";
}
// Lists every connected probe whatever interface script is selected, with the chip refresh last read on it;
// each J-Link card carries its driver control. A device of another family names in its tooltip the interface
// script choosing it switches to.
function renderConnectedProbes(m) {
    lastConnectedProbes = m;
    if (!connectedProbeList) return;
    // Park the page's driver controls before the cards holding them are replaced.
    probeDriverHome?.append(...[jlinkDriverChoice, jlinkDriverState, jlinkDriverBusy].filter(Boolean));
    if (m.debugger !== undefined) showDebuggerConfig(m.debugger);
    const devices = m.devices || [];
    const selected = devices.find((device) => device.selected);
    // A custom interface script selects its own device; the list only shows it.
    const locked = m.state === "script";
    connectedProbeLocked = locked;
    const source = m.state === "script" ? t("probe.scriptDecides") : m.source ? t("probe.source." + m.source) : "";
    const error = m.error ? (m.error.i18nKey ? t(m.error.i18nKey, m.error.i18nParams) : m.error.message) : "";
    const cards = [];
    const cardsById = new Map();
    let selectedCard = null;
    if (m.state === "absent")
        cards.push(
            probeCard({
                title: PROBE_FAMILY_LABELS[m.family] || m.family || "USB",
                detail: m.probeSerial || t("probe.noSerialShort"),
                tooltip: error,
                tag: t("probe.absentTag"),
                tagClass: "warn",
                selected: true
            })
        );
    for (const device of locked ? (selected ? [selected] : []) : devices) {
        const switchesScript = m.state !== "unconfigured" && !device.matchesDebugger && device.defaultConfig;
        const card = probeCard({
            deviceId: device.id,
            title: PROBE_FAMILY_LABELS[device.family] || device.family || "USB",
            detail: [
                device.trustedSerial || device.serial || t("probe.noSerialShort"),
                device.targetCore || "",
                !device.selectable && device.reasonKey ? t(device.reasonKey) : ""
            ]
                .filter(Boolean)
                .join(" · "),
            tooltip: [
                device.name,
                device.id,
                device.targetLabel ? t("probe.targetFound", { chip: device.targetLabel }) : "",
                device.selected ? [t("probe.inUse"), source].filter(Boolean).join(" · ") : "",
                device.reasonKey ? t(device.reasonKey) : "",
                switchesScript ? t("probe.otherFamily", { name: device.defaultConfig }) : ""
            ]
                .filter(Boolean)
                .join("\n"),
            selected: device.selected,
            current: device.selected,
            selectable: device.selectable
        });
        if (device.selected) selectedCard = card;
        cardsById.set(device.id, card);
        cards.push(card);
    }
    // Explain why nothing is selected, why the list cannot change the selection, or what went wrong.
    const status =
        selected || m.state === "absent"
            ? ""
            : t(
                  m.state === "unavailable"
                      ? "probe.inventoryUnavailable"
                      : m.state === "identifying"
                        ? "probe.identifyingTargets"
                        : m.state === "script"
                          ? "probe.scriptDecides"
                          : devices.length
                            ? "probe.selectPrompt"
                            : "probe.noneConnected"
              );
    const notes = [...new Set([m.state === "absent" ? "" : error, locked ? source : "", status])].filter(Boolean);
    cards.unshift(...notes.map((note) => probeCard({ title: note, info: true })));
    connectedProbeAutomatic = !locked && m.source !== "remembered";
    // Automatic mode checks every operation's target chip against the one it recorded.
    if (connectedProbeAutomatic && m.targetMismatch) {
        const card = probeCard({
            title: t("probe.targetChanged"),
            detail: t("probe.targetChangedDetail", m.targetMismatch),
            tooltip: t("probe.targetChangedHint"),
            info: true,
            warn: true
        });
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "probe-more-button probe-target-accept";
        accept.textContent = t("probe.useCurrentTarget");
        accept.disabled = probeDriverBusy;
        card.append(accept);
        cards.push(card);
    } else if (connectedProbeAutomatic && m.autoTarget)
        cards.push(
            probeCard({
                title: t("probe.autoTarget"),
                detail: m.autoTarget,
                tooltip: t("probe.autoTargetHint"),
                info: true
            })
        );
    connectedProbeList.replaceChildren(...cards);
    // Only a device the extension can save by its serial can be kept.
    connectedProbeKeepId =
        connectedProbeAutomatic && selected?.selectable && selected.trustedSerial && selected.defaultConfig
            ? selected.id
            : "";
    if (connectedProbeAuto) {
        // Keep the entry hidden until automatic probe selection is revised.
        connectedProbeAuto.hidden = true;
        connectedProbeAuto.setAttribute("aria-pressed", connectedProbeAutomatic ? "true" : "false");
        connectedProbeAuto.title = t(
            !connectedProbeAutomatic
                ? "probe.resetAutomatic"
                : connectedProbeKeepId
                  ? "probe.autoKeepHint"
                  : "probe.autoPickHint"
        );
    }
    // Every J-Link carries its driver: a control when the helper can switch it, so a driver is changed without
    // first picking (and keeping) that J-Link, else a badge saying why. The selected one uses the page's own.
    if (jlinkDriverChoice) jlinkDriverChoice.hidden = !switchableDriver(selected);
    if (jlinkDriverState) jlinkDriverState.hidden = true;
    for (const [deviceId, card] of cardsById) {
        const device = devices.find((item) => item.id === deviceId);
        const shown = switchableDriver(device);
        const manual = !shown && !!device.driver && device.driver.kind !== "not-applicable";
        const own = shown ? jlinkDriverChoice : manual ? jlinkDriverState : null;
        if (!own) continue;
        const control = device.selected ? own : own.cloneNode(true);
        if (control !== own) {
            control.removeAttribute("id");
            control.hidden = false;
        }
        if (shown) {
            if (control !== own) control.onchange = () => changeProbeDriver(control);
            control.dataset.deviceId = device.id;
            control.dataset.confirmed = shown;
            control.value = shown;
        } else {
            control.hidden = false;
            control.textContent = t("probe.driverManual");
            control.title = t("probe.driverManualHint", {
                reason: t(device.driver.reasonKey || "probe.driverReasonInterface")
            });
        }
        card.querySelector(".probe-card-main").after(control);
    }
    // The busy indicator follows the J-Link whose driver is switching, else the selected one's control.
    const busyCard = cardsById.get(driverSwitchDeviceId) || selectedCard;
    const busyAnchor = busyCard?.querySelector("select.jlink-driver-choice, .jlink-driver-state:not([hidden])");
    if (busyAnchor && jlinkDriverBusy) busyAnchor.after(jlinkDriverBusy);
    setProbeDriverBusy(probeDriverBusy);
}
function configurationIncomplete() {
    if (!mcuConfigSection) return false;
    return ["mcu-vscode.selectElf", "mcu-vscode.selectDebugger", "mcu-vscode.selectMcuCore"].some((command) => {
        const row = mcuConfigSection.querySelector(`[data-command="${command}"]`);
        const value = row?.querySelector("small");
        return !value || value.dataset.i18n === "common.notSelected" || !value.textContent.trim();
    });
}
// The folded configuration card names the chip family and probe once ELF, debugger and target are all chosen.
function configName(row) {
    const value = mcuConfigSection?.querySelector(`${row} .row-copy > small`);
    if (!value || value.dataset.i18n === "common.notSelected") return "";
    return value.textContent
        .trim()
        .split(/[\\/]/)
        .pop()
        .replace(/\.cfg$/i, "");
}
const PROBE_NAMES = [
    [/^jlink/i, "J-Link"],
    [/^stlink/i, "ST-Link"],
    [/^cmsis-dap/i, "CMSIS-DAP"]
];
function renderConfigSummary() {
    const summary = document.getElementById("mcuConfigSummary");
    if (!summary) return;
    let shown = "";
    if (!configurationIncomplete()) {
        // OpenOCD names targets in lower case ("stm32f4x"); the family reads as STM32F4x.
        const chip = configName('[data-command="mcu-vscode.selectMcuCore"]');
        const probe = configName(".debugger-config-row");
        const family = chip === chip.toLowerCase() ? chip.toUpperCase().replace(/X$/, "x") : chip;
        shown = `${family} · ${PROBE_NAMES.find(([pattern]) => pattern.test(probe))?.[1] || probe}`;
    }
    summary.textContent = shown;
    summary.title = shown;
}
function revealIncompleteConfiguration(e) {
    if (e?.currentTarget?.hasAttribute?.("data-config-free")) return;
    if (!configurationIncomplete() || !mcuConfigSection || mcuConfigSection.open) return;
    mcuConfigSection.open = true;
    uiState.sections ||= {};
    uiState.sections.mcuConfigSection = true;
    api?.setState?.(uiState);
}
// An operation that cannot choose a probe opens the list where the user picks one.
// The configuration row's interface script, changed in place by choosing a probe of another family.
function showDebuggerConfig(name) {
    const value = document.querySelector(".debugger-config-row .row-copy > small");
    if (!value) return;
    value.textContent = name || t("common.notSelected");
    value.title = name;
    if (name) value.removeAttribute("data-i18n");
    else value.setAttribute("data-i18n", "common.notSelected");
    renderConfigSummary();
}
function revealConnectedProbes() {
    if (!probeConfig) return;
    if (mcuConfigSection && !mcuConfigSection.open) {
        mcuConfigSection.open = true;
        uiState.sections ||= {};
        uiState.sections.mcuConfigSection = true;
        api?.setState?.(uiState);
    }
    probeConfig.open = true;
    probeConfig.scrollIntoView?.({ block: "nearest" });
}
if (probeConfig) {
    probeConfig.open = !!(uiState && uiState.probeConfigOpen);
    probeConfig.addEventListener("toggle", () => {
        uiState.probeConfigOpen = probeConfig.open;
        if (api && api.setState) api.setState(uiState);
    });
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
    // The status line sits in the flash card's notice box, coloured like the toolbar dot.
    if (flashStatus) flashStatus.dataset.state = cls || "busy";
    lastStatus = { cls: cls, key: key || "", params: params || null, text: s };
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
    writes.render();
    renderAvailable();
    applyFolds();
    renderSkillStatus(lastSkill);
    renderAgentAccess(lastAgentAccess);
    liveStatus(lastLive);
    openocdStatus(lastOpenocd);
    chipStatus(lastChip);
    svdStatus(lastSvd);
    if (lastConnectedProbes) renderConnectedProbes(lastConnectedProbes);
    peripheralView?.render();
    rtosView?.render();
    memoryView?.render();
    if (chipHasData && lastChipInfo) renderChip(lastChipInfo);
    for (const area of Object.values(notices)) area.relocalize();
    if (lastStatus) setStat(lastStatus.cls, lastStatus.key, lastStatus.params, lastStatus.text);
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
function saveSideWatch() {
    if (api) api.postMessage({ type: "saveSidebarWatch", items: state.watch });
    valueTree.syncRuntimeExpansions();
}
function sbDisplayName(item) {
    return EmberProbeRuntime.variableDisplayName(item, {
        get: (name) => {
            const symbol = state.symbols.get(name);
            if (symbol?.displayName && symbol.displayName !== symbol.name) return symbol;
            return (
                state.watch.find((entry) => entry.name === name) ||
                state.writeList.find((entry) => entry.name === name) ||
                symbol
            );
        }
    });
}
function sbRemove(name, isComp) {
    if (isComp) {
        state.watch = state.watch.filter((w) => w.name !== name && EmberProbeRuntime.variableBaseName(w.name) !== name);
        delete state.rawMembers[name];
        for (const paths of [state.expanded, state.arrayShown])
            Object.keys(paths).forEach((key) => {
                if (key === name || key.startsWith(name + ".") || key.startsWith(name + "[")) delete paths[key];
            });
    } else {
        const removed = state.watch.filter((w) => EmberProbeRuntime.isPointeeDescendant(w, name));
        state.watch = state.watch.filter((w) => w.name !== name && !removed.includes(w));
        removed.forEach((w) => sbForgetValues(w.name));
    }
    sbForgetValues(name);
}
function sbForgetValues(name) {
    valueTree.pointers.forget(name);
    delete state.latest[name];
    delete state.latestText[name];
    delete state.latestEnum[name];
    delete state.latestPointer[name];
}
function sbToggle(entry) {
    if (state.watch.some((w) => w.name === entry.name)) {
        sbRemove(entry.name, !!entry.isComposite);
    } else {
        state.watch.push(entry);
        if (entry.isComposite) state.expanded[entry.name] = true;
    }
    renderValues();
    updateAvailableSelections();
    saveSideWatch();
    saveSbUi();
}
function renderValues() {
    valueTree.reset();
    liveBox.textContent = "";
    // Expanded pointees render inside their pointer rows while composites and rows are built.
    const topLevel = state.watch.filter((item) => !EmberProbeRuntime.isPointeeEntry(item));
    const rows = new Map();
    topLevel.filter(isComposite).forEach((item) => {
        sbRenderComposite(item);
        rows.set(item.name, [liveBox.lastChild]);
    });
    liveBox.textContent = "";
    topLevel.forEach((item) => {
        if (!isComposite(item) && !valueTree.isLeafChild(item.name)) rows.set(item.name, sbRenderScalarRow(item));
    });
    if (!state.watch.length) {
        document.getElementById("watchCount").textContent = "0";
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = t("sb.watchEmpty");
        liveBox.appendChild(e);
        return;
    }
    topLevel.forEach((item) => {
        const nodes = rows.get(item.name) || [];
        if (nodes[0])
            EmberProbeCardReorder.decorate(nodes[0], item.name, t("sb.dragToReorder", { name: sbDisplayName(item) }));
        liveBox.append(...nodes);
    });
    // Pointees whose pointer row is not shown (typed paths, older saved lists) stay cards; parents first.
    state.watch
        .filter(EmberProbeRuntime.isPointeeEntry)
        .sort((a, b) => a.name.length - b.name.length)
        .forEach((item) => {
            if (valueTree.placed.has(item.name)) return;
            valueTree.fallback.add(item.name);
            if (isComposite(item)) sbRenderComposite(item);
            else liveBox.append(...sbRenderScalarRow(item));
        });
    document.getElementById("watchCount").textContent = String(
        state.watch.filter((it) => !valueTree.isLeafChild(it.name) && !valueTree.placed.has(it.name)).length
    );
    sbWatchReorder?.refresh();
    valueTree.syncRuntimeExpansions();
}
function sbRenderScalarRow(item) {
    const row = document.createElement("div");
    row.className = "value-row";
    const n = document.createElement("span");
    n.className = "value-name";
    EmberProbeRuntime.renderVariableName(n, sbDisplayName(item), item.name);
    const val = document.createElement("span");
    val.className = "value-number";
    val.dataset.valueName = item.name;
    const ty = document.createElement("span");
    ty.className = "value-type";
    const info = valueTree.displayInfo(item);
    ty.textContent = (info.isPointer ? info.typeName : item.type) || "u32";
    ty.title = ty.textContent;
    const nameWrap = document.createElement("span");
    nameWrap.className = "value-name-wrap";
    nameWrap.append(n, ty);
    const rm = document.createElement("button");
    rm.className = "watch-remove";
    rm.textContent = "✕";
    rm.title = t("sb.removeFromWatch");
    rm.onclick = () => {
        sbRemove(item.name, false);
        renderValues();
        updateAvailableSelections();
        saveSideWatch();
    };
    val.addEventListener("click", (event) => {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: EmberProbeRuntime.copyValueText(val) });
    });
    row.append(nameWrap, val, rm);
    const footer = EmberProbeRuntime.createVariableNotices(
        row,
        t,
        document.createElement("div"),
        (text) => api?.postMessage({ type: "copyText", text }),
        item.name
    );
    // The pointee is part of the variable's card, on a second grid row below its value.
    const host = info.isPointer && valueTree.pointerPointee(row, item.name, sbDisplayName(item), info);
    if (host) row.appendChild(host);
    row.appendChild(footer);
    EmberProbeRuntime.setValueCell(val, valueTree.scalarDisplay(item));
    return [row];
}
function sbTogglePointee(entry) {
    if (state.watch.some((item) => item.name === entry.name)) {
        const removed = state.watch.filter(
            (item) => item.name === entry.name || EmberProbeRuntime.isPointeeDescendant(item, entry.name)
        );
        state.watch = state.watch.filter((item) => !removed.includes(item));
        removed.forEach((item) => sbForgetValues(item.name));
    } else state.watch.push(entry);
    renderValues();
    saveSideWatch();
}
// Heuristic origin filter; the extension classifies symbols from DWARF source paths, types and names.
let userVarsOnly = uiState.sbUserVarsOnly === true;
const variablePicker = EmberProbeSymbolPicker.create({
    t: (key, params) => t(key, params),
    state,
    valueTree,
    layoutExpansion: () => layoutExpansionUi,
    displayName: (item) => sbDisplayName(item),
    symbols: () => state.available,
    userOnly: () => userVarsOnly,
    expanded: () => state.availableExpanded,
    pending: availableLayoutPending,
    typesReady: () => availableTypesReady,
    post: api && ((message) => api.postMessage(message)),
    childrenClass: "av-children"
});
function availableOriginTitle(symbol) {
    const lines = [];
    if (!EmberProbeSymbolPicker.isUserVariable(symbol)) lines.push(t("sb.origin." + symbol.origin));
    if (symbol.sourceFile) lines.push(t("sb.sourceFile", { file: symbol.sourceFile }));
    return lines.length ? "\n" + lines.join("\n") : "";
}
function applyUserVarsOnly() {
    const button = document.getElementById("varUserOnly");
    button.classList.toggle("primary", userVarsOnly);
    button.setAttribute("aria-pressed", String(userVarsOnly));
}
function renderAvailable() {
    const scrollTop = availableBox.scrollTop;
    const scrollLeft = availableBox.scrollLeft;
    const content = document.createDocumentFragment();
    renderAvailableContents(content);
    availableBox.replaceChildren(content);
    availableBox.scrollTop = scrollTop;
    availableBox.scrollLeft = scrollLeft;
}
// The watch entry that adds a composite symbol as a whole.
function sbCompositeEntry(sym) {
    return {
        name: sym.name,
        displayName: sbDisplayName(sym),
        address: Number(sym.address) || 0,
        size: Number(sym.size) || 4,
        type: "",
        isComposite: true,
        compositeLayout: sym.compositeLayout || null,
        ...(EmberProbeRuntime.runtimeGraph(sym) ? { runtimeLayout: EmberProbeRuntime.runtimeGraph(sym) } : {})
    };
}
// The watch and write entry of one member row.
function sbLeafEntry(lf) {
    return {
        name: lf.path,
        displayName: sbDisplayName({ name: lf.displayPath || lf.path, displayName: lf.displayName }),
        address: lf.address,
        size: lf.size || EmberProbeRuntime.typeByteLength(lf.type),
        type: lf.type,
        ...(lf.isPointer ? { isPointer: true, typeName: lf.typeName, pointerTarget: lf.pointerTarget } : {}),
        ...(lf.layoutExpanded ? { layoutExpanded: true, staticRuntimeStorage: lf.staticRuntimeStorage } : {}),
        ...(lf.isBoolean ? { isBoolean: true } : {}),
        ...(Number.isInteger(lf.bitSize) ? { bitSize: lf.bitSize, bitOffset: lf.bitOffset } : {}),
        ...(lf.isConst ? { isConst: true } : {}),
        ...(lf.isReference ? { isReference: true } : {}),
        ...(lf.isMemberPointer ? { isMemberPointer: true } : {}),
        ...(lf.enumEncodingInferred ? { enumEncodingInferred: true } : {}),
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
}
function sbCompositeRow(sym, open, toggle, on) {
    const row = document.createElement("div");
    row.className = "available-row comp";
    const wrap = document.createElement("span");
    wrap.className = "av-name-wrap";
    const arrow = document.createElement("span");
    arrow.className = "av-arrow" + (open ? " open" : "");
    arrow.textContent = "\u25B6";
    const nm = document.createElement("span");
    nm.className = "available-name";
    EmberProbeRuntime.renderSymbolName(nm, sbDisplayName(sym), sym);
    nm.title += "\n" + (on ? t("sb.removeFromWatch") : t("sb.compositeAddWhole")) + availableOriginTitle(sym);
    wrap.append(
        arrow,
        mkWatchBtn(
            sym.name,
            !availableTypesReady || !!sym.layoutError,
            sym.layoutError || sym.unsupportedReason || t("lw.compositeNoLayout"),
            () => {
                if (state.watch.some((item) => item.name === sym.name) || sym.compositeLayout || sym.runtimeLayout) {
                    sbToggle(sbCompositeEntry(sym));
                } else {
                    // The add waits for the layout, also when expanding the row already asked for it.
                    availableAddPending.add(sym.name);
                    if (!availableLayoutPending.has(sym.name)) {
                        availableLayoutPending.add(sym.name);
                        api?.postMessage({ type: "resolveCompositeLayout", name: sym.name, version: state.version });
                    }
                }
            }
        ),
        nm
    );
    const ty = document.createElement("span");
    ty.className = "available-type";
    ty.textContent = sym.typeName || t("lw.unknownType");
    row.append(wrap, ty);
    arrow.onclick = toggle;
    nm.onclick = (event) => {
        if (!sym.compositeLayout && !sym.runtimeLayout) return toggle(event);
        sbToggle(sbCompositeEntry(sym));
    };
    return { row, arrow };
}
function sbLeafRow(lf) {
    const lb = document.createElement("div");
    lb.className = "available-row leaf";
    const cell = document.createElement("span");
    cell.className = "av-name-cell";
    const leafEntry = sbLeafEntry(lf);
    cell.appendChild(mkWriteBtn(leafEntry));
    cell.appendChild(mkWatchBtn(lf.path, false, "", () => sbToggle(leafEntry)));
    const ln = document.createElement("span");
    ln.className = "av-leaf-name";
    ln.textContent = lf.label;
    ln.title = leafEntry.displayName;
    cell.appendChild(ln);
    const lty = document.createElement("span");
    lty.className = "available-type";
    lty.textContent = (lf.isPointer ? lf.typeName : lf.type) || (lf.isComposite ? t("lw.compositeType") : "");
    lb.append(cell, lty);
    lb.onclick = () => sbToggle(leafEntry);
    return lb;
}
function sbScalarRow(sym, already) {
    const noLayout = sym.isComposite && !sym.compositeLayout && !sym.runtimeLayout;
    const b = document.createElement("div");
    b.className = "available-row" + (noLayout ? " off" : "");
    b.title = noLayout ? sym.unsupportedReason || t("sb.compositeUnsupported") : already ? t("sb.removeFromWatch") : "";
    const cell = document.createElement("span");
    cell.className = "av-name-cell";
    const entry = {
        name: sym.name,
        displayName: sbDisplayName(sym),
        address: Number(sym.address) || 0,
        size: Number(sym.size) || 4,
        type: sym.watchType,
        ...(sym.isPointer ? { isPointer: true, typeName: sym.typeName, pointerTarget: sym.pointerTarget } : {}),
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
    EmberProbeRuntime.renderSymbolName(n, sbDisplayName(sym), sym);
    n.title += availableOriginTitle(sym);
    cell.appendChild(n);
    const ty = document.createElement("span");
    ty.className = "available-type";
    ty.textContent = sym.typeName || sym.watchType || t("sb.composite");
    b.append(cell, ty);
    if (!noLayout) b.onclick = () => sbToggle(entry);
    return b;
}
function renderAvailableContents(content) {
    EmberProbeRuntime.renderElfDiagnostics(
        document.getElementById("availableDiagnostics"),
        variableWarnings,
        variableError,
        t("common.diagnostics"),
        t
    );
    const pool = variablePicker.pool();
    const allCount = document.getElementById("allCount");
    allCount.textContent = userVarsOnly ? pool.length + "/" + state.available.length : String(state.available.length);
    allCount.title = userVarsOnly ? t("sb.filteredCount", { shown: pool.length, total: state.available.length }) : "";
    // The error is in the diagnostics notice above the list.
    if (variableError) return;
    const query = document.getElementById("varSearch").value.trim().toLowerCase();
    const selected = new Set(state.watch.map((w) => w.name));
    const { matching, list } = variablePicker.render(content, query, {
        composite: (sym, open, toggle) => sbCompositeRow(sym, open, toggle, selected.has(sym.name)),
        leaf: (lf) => sbLeafRow(lf),
        scalar: (sym) => sbScalarRow(sym, selected.has(sym.name))
    });
    if (matching.length > list.length) {
        const note = document.createElement("div");
        note.className = "sb-note";
        note.textContent = t("lw.showingFirst", { n: list.length });
        content.appendChild(note);
    }
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
        !!entry.staticRuntimeStorage ||
        !!entry.isConst ||
        !!entry.isReference ||
        !!entry.isMemberPointer ||
        !!entry.isPointer ||
        !!entry.enumEncodingInferred ||
        Number.isInteger(entry.bitSize);
    const on = !disabled && writes.has(entry.name);
    const button = mkAvBtn(
        "av-write",
        "\u270e",
        on,
        disabled,
        disabled ? reason || t("sb.writeUnsupported") : on ? t("sb.removeFromWrite") : t("sb.addToWrite"),
        () => writes.toggle(entry)
    );
    button.dataset.selectionName = entry.name;
    return button;
}
function mkWatchBtn(name, disabled, reason, handler) {
    const on = !disabled && state.watch.some((w) => w.name === name);
    const button = mkAvBtn(
        "av-watch",
        on ? "\u2713" : "+",
        on,
        disabled,
        disabled ? reason || "" : on ? t("sb.removeFromWatch") : "",
        handler
    );
    button.dataset.selectionName = name;
    return button;
}
function updateAvailableSelections() {
    const watched = new Set(state.watch.map((item) => item.name));
    const written = new Set(state.writeList.map((item) => item.name));
    availableBox.querySelectorAll("[data-selection-name]").forEach((button) => {
        if (button.disabled) return;
        const isWrite = button.classList.contains("av-write");
        const on = (isWrite ? written : watched).has(button.dataset.selectionName);
        button.classList.toggle("on", on);
        button.textContent = isWrite ? "\u270e" : on ? "\u2713" : "+";
        button.title = isWrite ? t(on ? "sb.removeFromWrite" : "sb.addToWrite") : on ? t("sb.removeFromWatch") : "";
        const row = button.closest(".available-row");
        const name = row.querySelector(".available-name");
        if (!isWrite && name) {
            if (row.classList.contains("comp"))
                name.title =
                    name.getAttribute("aria-label") + "\n" + t(on ? "sb.removeFromWatch" : "sb.compositeAddWhole");
            else row.title = on ? t("sb.removeFromWatch") : "";
        }
    });
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
    uiState.sbExpanded = state.expanded;
    uiState.sbRawMembers = state.rawMembers;
    uiState.sbArrayShown = state.arrayShown;
    uiState.sbLastPointers = valueTree.pointers.saved().pointers;
    uiState.sbLastPointersVersion = valueTree.pointers.saved().version;
    if (api && api.setState) api.setState(uiState);
    valueTree.syncRuntimeExpansions();
}

function sbRenderComposite(item) {
    const row = document.createElement("div");
    row.className = "value-row composite" + (state.expanded[item.name] ? " open" : "");
    const head = document.createElement("div");
    head.className = "sb-comp-head";
    const arrow = document.createElement("span");
    arrow.className = "sb-arrow" + (state.expanded[item.name] ? " open" : "");
    arrow.textContent = "\u25B6";
    const nm = document.createElement("span");
    nm.className = "sb-comp-name";
    EmberProbeRuntime.renderVariableName(nm, sbDisplayName(item), item.name);
    const lay = item.compositeLayout || {};
    const ty = document.createElement("span");
    ty.className = "sb-comp-type";
    ty.textContent = item.typeName || lay.typeName || "";
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
        updateAvailableSelections();
        saveSideWatch();
        saveSbUi();
    };
    head.append(arrow, nm, ty, sp, rm);
    const body = document.createElement("div");
    body.className = "sb-body";
    head.onclick = () => {
        state.expanded[item.name] = !state.expanded[item.name];
        row.classList.toggle("open", state.expanded[item.name]);
        arrow.classList.toggle("open", state.expanded[item.name]);
        saveSbUi();
    };
    const footer = valueTree.renderCompositeBody(body, item);
    row.append(head, body, footer);
    liveBox.appendChild(row);
    valueTree.updateComposite(item.name);
}
function sbOnComposite(samples) {
    let refreshAvailable = false;
    const searching = !!document.getElementById("varSearch").value.trim();
    (samples || []).forEach((s) => {
        if (s && s.name) {
            if (
                (state.availableExpanded[s.name] || searching) &&
                EmberProbeRuntime.runtimeTreeShape(state.latest[s.name]) !==
                    EmberProbeRuntime.runtimeTreeShape(s.tree) &&
                EmberProbeRuntime.runtimeSelection(state.symbols.get(s.name), s.tree)
            )
                refreshAvailable = true;
            state.latest[s.name] = s.tree;
            valueTree.treeSampled(s.name, s.tree);
        }
    });
    if (refreshAvailable) renderAvailable();
    // A re-rendered tree can now show the pointer row of a pointee drawn as a stand-alone card.
    if ([...valueTree.fallback].some((name) => valueTree.placed.has(name))) renderValues();
    valueRefresh.schedule();
}
function updateValues(samples) {
    (samples || []).forEach((s) => {
        state.latest[s.name] = s.value;
        state.latestText[s.name] =
            s.diagnostic?.code === "LIVE_NULL_POINTER" ? t("lw.pointeeNull") : (s.valueText ?? null);
        state.latestEnum[s.name] = s.enumText ?? null;
        state.latestPointer[s.name] = EmberProbeValueTree.pointerReading(s);
        valueTree.pointers.rememberSample(s);
    });
    valueRefresh.schedule();
}
function refreshDisplayedValues() {
    const items = new Map(state.watch.map((item) => [item.name, item]));
    document.querySelectorAll("[data-value-name]").forEach((el) => {
        EmberProbeRuntime.setValueCell(
            el,
            valueTree.scalarDisplay(items.get(el.dataset.valueName) || { name: el.dataset.valueName })
        );
    });
    state.watch.forEach((it) => {
        if (isComposite(it)) valueTree.updateComposite(it.name);
    });
    if (liveCanRead) writes.sync();
}
// While sampling, write cards follow the current value; cards the user is editing (focused, write in flight or
// debouncing) are not overwritten
function liveStatus(m) {
    m = m || {};
    lastLive = m;
    const next = window.EmberProbeRuntime.liveState(
        { running: liveRunning, canRead: liveCanRead, canWrite: liveCanWrite },
        m
    );
    liveRunning = next.running;
    liveCanRead = next.canRead;
    liveCanWrite = next.canWrite;
    writes.setAccess({
        canWrite: liveCanWrite,
        haltWrite: next.haltWrite,
        halted: m.source === "dap" && String(m.mode || "").startsWith("debug-paused"),
        unavailableKey: EmberProbeRuntime.writeUnavailableKey({ ...m, running: liveRunning, canWrite: liveCanWrite })
    });
    liveSnapshotReady = next.fresh;
    const debugRunning = m.mode === "debug-running-waiting",
        debugReading = m.source === "dap" && liveRunning && !liveSnapshotReady;
    if (liveCard) liveCard.classList.toggle("debug-stale", !liveSnapshotReady);
    if (liveLabel.hasAttribute("data-i18n")) liveLabel.removeAttribute("data-i18n");
    liveToggle.textContent = liveRunning ? t("sb.stop") : t("sb.start");
    liveState.className =
        "live-state " +
        (m.error ? "err" : debugRunning || debugReading ? "busy" : liveCanRead ? "on" : liveRunning ? "busy" : "");
    // Errors go into the live notice box; the label keeps the sampling state.
    liveLabel.textContent = (!m.error && msgText(m)) || (liveRunning ? t("sb.sampling") : t("sb.stopped"));
    liveLabel.title = t("sb.samplingRate", { hz: Number(m.actualHz || 0).toFixed(1) });
}
function openocdStatus(m) {
    m = m || {};
    lastOpenocd = m;
    uiState.sidebarStatus ||= {};
    const { state, key, params, message } = m;
    uiState.sidebarStatus.openocd = { state, key, params, message };
    api?.setState?.(uiState);
    const k = m.state || "checking",
        busy = k === "checking" || k === "preparing";
    if (k === "ready") return clearNotice("global", "openocd");
    const action = (key, name, primary) => ({
        label: { key },
        primary,
        message: { type: "openocdAction", action: name }
    });
    setNotice("global", "openocd", {
        level: busy ? "info" : k === "missing" ? "warning" : "error",
        busy,
        title: { key: "sb.openocdEnv" },
        text: m.key ? { key: m.key, params: m.params } : m.message || { key: "oc.checking" },
        actions: busy ? [] : [action("sb.selectPath", "select", true), action("sb.recheck", "check")],
        dismissible: false
    });
}
function renderSkillStatus(m) {
    lastSkill = m || lastSkill;
    agentControls.renderSkills(lastSkill);
}
function renderAgentAccess(m) {
    lastAgentAccess = m || lastAgentAccess;
    agentControls.renderAccess(lastAgentAccess);
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
    // The header shows the state; an error's reason goes into the chip notice box.
    chipLabel.textContent = (st !== "error" && msgText(m)) || chipStatusLabel(st);
    chipLabel.title = chipLabel.textContent;
    if (st === "error" && (m.key || m.message))
        setNotice("chip", "chip", window.EmberProbeNotice.hostNotice({ error: m }));
    else if (st !== "error") clearNotice("chip", "chip");
    chipBody.querySelectorAll(".chip-control").forEach((button) => {
        button.disabled = probeDriverBusy || st === "reading";
    });
    // The header owns action errors; keep any previously read chip details without repeating the message.
    if (st === "error" && !chipHasData) chipBody.textContent = "";
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
        // A failure's reason is in the config notice; the row keeps a short state.
        svdStatusEl.textContent =
            st === "error"
                ? t("svd.statusFailed")
                : msgText(m) || (st === "configured" ? t("svd.configured") : t("svd.notConfigured"));
        svdStatusEl.title = m.path || (st === "error" ? msgText(m) : svdStatusEl.textContent);
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
// A J-Link card's driver control asks for that J-Link's driver; it shows the confirmed one until the new list.
function changeProbeDriver(control) {
    if (!api) return setStat("error", "sb.extNotConnected");
    const requested = control.value;
    if (control.dataset.confirmed) control.value = control.dataset.confirmed;
    driverSwitchDeviceId = control.dataset.deviceId || "";
    if (jlinkDriverBusy) control.after(jlinkDriverBusy);
    setProbeDriverBusy(true);
    api.postMessage({ type: "selectProbeDriver", driver: requested, deviceId: driverSwitchDeviceId });
}
if (jlinkDriverChoice) jlinkDriverChoice.onchange = () => changeProbeDriver(jlinkDriverChoice);
// The pressed row changes only when the extension posts the new selection.
function selectConnectedProbe(deviceId) {
    if (!api) return setStat("error", "sb.extNotConnected");
    setStat("", "sb.executing");
    api.postMessage({ type: "selectConnectedProbe", deviceId });
}
if (connectedProbeList)
    connectedProbeList.onclick = (e) => {
        const accept = e.target.closest("button.probe-target-accept");
        if (accept) {
            if (accept.disabled) return;
            if (!api) return setStat("error", "sb.extNotConnected");
            setStat("", "sb.executing");
            return api.postMessage({ type: "acceptTargetChip" });
        }
        const card = e.target.closest("button.probe-card-main");
        if (card && !card.disabled && card.getAttribute("aria-pressed") !== "true")
            selectConnectedProbe(card.dataset.deviceId);
    };
// Both buttons sit in the summary; using them must not fold the section.
if (connectedProbeAuto)
    connectedProbeAuto.onclick = (e) => {
        e.preventDefault();
        selectConnectedProbe(connectedProbeAutomatic ? connectedProbeKeepId : "");
    };
if (connectedProbeRefresh)
    connectedProbeRefresh.onclick = (e) => {
        e.preventDefault();
        if (api) api.postMessage({ type: "refreshConnectedProbes" });
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
renderConfigSummary();
document.querySelectorAll("[data-command]").forEach(
    (b) =>
        (b.onclick = (e) => {
            if (!api) return setStat("error", "sb.extNotConnected");
            revealIncompleteConfiguration(e);
            setStat("", "sb.executing");
            api.postMessage({ type: "executeCommand", cmd: b.dataset.command });
        })
);
liveToggle.onclick = () => {
    if (api) {
        revealIncompleteConfiguration();
        liveToggle.disabled = true;
        api.postMessage({ type: "liveToggle" });
        setTimeout(() => setProbeDriverBusy(probeDriverBusy), 500);
    }
};
for (const id of ["peripheralRefresh", "peripheralFormat", "rtosRefresh"]) {
    document.getElementById(id)?.addEventListener("click", revealIncompleteConfiguration);
}
document.getElementById("varSearch").oninput = () => {
    availableBox.scrollTop = 0;
    renderAvailable();
};
document.getElementById("varSearchClear").onclick = function () {
    const v = document.getElementById("varSearch");
    v.value = "";
    availableBox.scrollTop = 0;
    renderAvailable();
    v.focus();
};
applyUserVarsOnly();
document.getElementById("varUserOnly").onclick = () => {
    userVarsOnly = !userVarsOnly;
    uiState.sbUserVarsOnly = userVarsOnly;
    api?.setState?.(uiState);
    applyUserVarsOnly();
    availableBox.scrollTop = 0;
    renderAvailable();
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
    EmberProbePageZoom.resizeHandle(handle, box, Number(uiState[stateKey]), (height) => {
        uiState[stateKey] = height;
        api?.setState?.(uiState);
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
EmberProbePageZoom.create({
    target: window,
    api,
    state,
    saved: uiState.pageZoom,
    save: (factor) => {
        uiState.pageZoom = factor;
        api?.setState?.(uiState);
    }
});
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
    agentPermissions: (m) => agentControls.receive(m),
    mcpClients: (m) => agentControls.renderClients(m),
    agentAccess: (m) => renderAgentAccess(m),
    openocdStatus: function (m) {
        openocdStatus(m);
    },
    notice: function (m) {
        setNotice(m.area, m.id, window.EmberProbeNotice.hostNotice(m.notice));
    },
    noticeClear: function (m) {
        clearNotice(m.area, m.id);
    },
    // The driver's progress and result arrive as config notices; this only locks the probe controls.
    probeDriverStatus: function (m) {
        if (m.state === "installing" || m.state === "restoring") setProbeDriverBusy(true);
    },
    connectedProbes: function (m) {
        renderConnectedProbes(m);
    },
    revealConnectedProbes: function () {
        revealConnectedProbes();
    },
    debuggerConfig: function (m) {
        showDebuggerConfig(m.debugger || "");
    },
    probeDriverSwitch: function (m) {
        if (!m.busy) driverSwitchDeviceId = "";
        setProbeDriverBusy(!!m.busy);
    },
    // A command's outcome is a notice in its card; the footer only goes back to ready.
    commandSuccess: function () {
        setStat("ready", "sb.ready");
    },
    commandCancelled: function () {
        setStat("ready", "sb.ready");
    },
    commandError: function () {
        setStat("ready", "sb.ready");
    },
    sidebarWatchList: function (m) {
        const incoming = (m.items || []).slice();
        for (const item of state.watch)
            if (!incoming.some((next) => next.name === item.name)) valueTree.pointers.forget(item.name);
        state.watch = incoming;
        if (m.resetValues) {
            valueTree.pointers.clear();
            state.watch.forEach((item) => {
                delete state.latest[item.name];
                delete state.latestText[item.name];
                delete state.latestEnum[item.name];
                delete state.latestPointer[item.name];
            });
        }
        valueTree.runtimeExpansionsReady();
        renderValues();
        updateAvailableSelections();
    },
    sidebarWriteList: function (m) {
        writes.load(m.items || []);
        updateAvailableSelections();
    },
    writeResult: function (m) {
        writes.onResult(m);
    },
    availableVariables: function (m) {
        variableWarnings = m.warnings || [];
        state.available = (m.symbols || []).slice();
        availableTypesReady = true;
        state.symbols = new Map(state.available.map((symbol) => [symbol.name, symbol]));
        variableErrorKey = m.errorKey || "";
        variableErrorParams = m.params || null;
        variableError = m.errorKey ? t(m.errorKey, m.params) : m.error || "";
        renderAvailable();
        renderValues();
        writes.render();
    },
    availableVariablesReset: function (m) {
        variableWarnings = m.warnings || [];
        state.version = m.version || "";
        state.generation = m.generation ?? null;
        if (valueTree.pointers.expire()) saveSbUi();
        layoutExpansionUi.reset();
        for (const item of state.watch) {
            delete item.layoutExpansions;
            item.layoutExpansionGeneration = -1;
        }
        availableTypesReady = false;
        state.available = [];
        state.symbols.clear();
        renderValues();
        availableTypeChunks = 0;
        availableLayoutPending.clear();
        availableAddPending.clear();
        variableError = "";
        variableErrorKey = "";
        variableErrorParams = null;
        renderAvailable();
    },
    availableVariablesChunk: function (m) {
        if (m.version !== state.version) return;
        const symbols = m.symbols || [];
        state.available.push(...symbols);
        for (const symbol of symbols) state.symbols.set(symbol.name, symbol);
        if (state.available.length <= 1000 || state.available.length % 10000 < symbols.length) renderAvailable();
    },
    availableVariablesDone: function (m) {
        if (m.version && m.version !== state.version) return;
        if (Array.isArray(m.warnings)) variableWarnings = m.warnings;
        variableErrorKey = m.errorKey || "";
        variableErrorParams = m.params || null;
        variableError = m.errorKey ? t(m.errorKey, m.params) : m.error || "";
        renderAvailable();
    },
    availableVariableTypes: function (m) {
        if (m.version !== state.version) return;
        for (const update of m.symbols || []) {
            const symbol = state.symbols.get(update.name);
            if (symbol) Object.assign(symbol, update);
        }
        if (++availableTypeChunks % 10 === 0) renderAvailable();
    },
    availableTypesDone: function (m) {
        if (m.version !== state.version) return;
        if (Array.isArray(m.warnings)) variableWarnings = m.warnings;
        availableTypesReady = true;
        renderAvailable();
        renderValues();
        writes.render();
    },
    layoutExpansionResult: function (m) {
        layoutExpansionUi.receive(m);
    },
    compositeLayoutResult: function (m) {
        if (m.version !== state.version) return;
        availableLayoutPending.delete(m.name);
        const symbol = state.symbols.get(m.name);
        if (!symbol) return;
        const pointerWaiter = sbPointerLayoutWaiters.delete(m.name);
        if (pointerWaiter && !symbol.isComposite) {
            // Scalars keep their identity; only the type graph is needed to expand them.
            symbol.runtimeLayout = m.layout?.runtimeLayout || null;
            if (symbol.runtimeLayout) renderValues();
            else symbol.layoutError = m.error || t("lw.compositeNoLayout");
            return;
        }
        if (m.layout) {
            symbol.compositeLayout = m.layout;
            symbol.layoutExpansions = m.layoutExpansions;
            symbol.layoutExpansionGeneration = m.layoutExpansionGeneration;
            symbol.runtimeLayout = m.layout.runtimeLayout || null;
            symbol.unsupportedReason = "";
            symbol.layoutError = "";
        } else {
            symbol.layoutError = m.error || t("lw.compositeNoLayout");
            symbol.unsupportedReason = symbol.layoutError;
        }
        if (availableAddPending.delete(m.name) && m.layout && !state.watch.some((item) => item.name === m.name))
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
        state.latest = Object.create(null);
        state.latestText = Object.create(null);
        state.latestPointer = Object.create(null);
        state.latestEnum = Object.create(null);
        renderValues();
        writes.render();
    },
    liveSample: function (m) {
        updateValues(m.samples);
    },
    liveCompositeSample: function (m) {
        sbOnComposite(m.samples || []);
    },
    liveStatus: function (m) {
        if (m.error && (m.key || m.message))
            setNotice("live", "live", window.EmberProbeNotice.hostNotice({ error: m }));
        else if (m.running) clearNotice("live", "live");
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
    peripheralCatalog: function (m) {
        peripheralView?.onCatalog(m);
    },
    rtosDebugStatus: function (m) {
        rtosView?.onDebug(m);
    },
    probeOperationStatus: function (m) {
        probeTargetScan = !!m.operations?.targetScan;
        setProbeDriverBusy(probeDriverBusy);
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
        setNotice(
            "live",
            "live",
            window.EmberProbeNotice.hostNotice({ error: m.key || m.message ? m : { key: "sb.commandFailed" } })
        );
        liveStatus({ running: liveRunning, error: true });
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
