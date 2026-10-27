const api = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null,
    dot = document.getElementById("statusDot"),
    text = document.getElementById("statusText"),
    liveBox = document.getElementById("liveValues"),
    liveCard = liveBox && liveBox.closest(".live-box"),
    writeBox = document.getElementById("writeValues"),
    availableBox = document.getElementById("availableVars"),
    liveState = document.getElementById("liveState"),
    liveLabel = document.getElementById("liveLabel"),
    liveToggle = document.getElementById("liveToggle"),
    langToggle = document.getElementById("langToggle");
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
let sideWatch = [],
    writeList = [],
    available = [],
    availableByName = new Map(),
    availableVersion = "",
    availableGeneration = null,
    availableTypesReady = true,
    availableLayoutPending = new Set(),
    availableAddPending = new Set(),
    // Scalar pointer symbols whose runtime type graph was requested to offer expansion.
    sbPointerLayoutWaiters = new Set(),
    availableTypeChunks = 0,
    availableSearchTimer = null,
    availableSearchQuery = "",
    latest = Object.create(null),
    latestText = Object.create(null),
    latestEnum = Object.create(null),
    latestPointer = Object.create(null),
    liveRunning = false,
    liveCanRead = false,
    liveCanWrite = false,
    liveWriteUnavailableKey = "sb.writeNeedSampling",
    liveHaltWrite = false,
    liveTargetHalted = false,
    liveSnapshotReady = true,
    variableError = "",
    variableErrorKey = "",
    variableErrorParams = null,
    variableWarnings = [],
    lastSkill = { state: "checking" },
    lastAgentAccess = null,
    uiState = api && api.getState ? api.getState() || {} : {};
let sbExpanded = (uiState && uiState.sbExpanded) || Object.create(null),
    // Last sampled pointer targets by watch path; restored with the view so a reopened sidebar still names them.
    // They belong to the ELF version they were sampled from and are shown only while it is loaded.
    sbLastPointers = (uiState.sbLastPointersVersion && uiState.sbLastPointers) || Object.create(null),
    sbLastPointersVersion = (uiState.sbLastPointers && uiState.sbLastPointersVersion) || "",
    sbRawMembers = uiState.sbRawMembers || Object.create(null),
    // Elements shown per static array path once "show more" was used.
    sbArrayShown = uiState.sbArrayShown || Object.create(null),
    compCells = Object.create(null),
    avExpanded = Object.create(null),
    writeCells = Object.create(null),
    writeTimers = Object.create(null),
    writeLastAt = Object.create(null),
    latestWriteSeq = Object.create(null),
    // Last value known to be on the target per write card; a failed write rolls back to it.
    writeConfirmed = Object.create(null),
    writeSeq = 0,
    runtimeBodies = Object.create(null),
    // Expanded pointee entries rendered inside their pointer rows / as stand-alone cards.
    sbPlacedPointees = new Set(),
    sbFallbackPointees = new Set();
// Members and pointees follow their card when it is dragged to a new place.
function sbAttachedEntry(entry, name) {
    return sbBaseNameOf(entry.name) === name || EmberProbeRuntime.isPointeeDescendant(entry, name);
}
const sbWatchReorder =
    liveBox &&
    EmberProbeCardReorder.attach(liveBox, {
        onMove: (name, target, after) => {
            const next = EmberProbeCardReorder.moveBlock(sideWatch, name, target, after, sbAttachedEntry);
            if (next === sideWatch) return;
            sideWatch = next;
            renderValues();
            saveSideWatch();
        }
    });
const sbWriteReorder =
    writeBox &&
    EmberProbeCardReorder.attach(writeBox, {
        onMove: (name, target, after) => {
            const next = EmberProbeCardReorder.moveBlock(writeList, name, target, after);
            if (next === writeList) return;
            writeList = next;
            renderWrites();
            saveWriteList();
        }
    });
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
function sbLayoutSymbol(path) {
    const name = EmberProbeRuntime.variableBaseName(path);
    const symbol = availableByName.get(name);
    return symbol?.compositeLayout ? symbol : sideWatch.find((item) => item.name === name) || symbol;
}
const layoutExpansionUi = EmberProbeRuntime.createLayoutExpansionUi({
    post: (message) => api?.postMessage(message),
    version: () => availableVersion,
    generation: () => availableGeneration,
    symbol: sbLayoutSymbol,
    changed: () => {
        for (const item of sideWatch) {
            const symbol = availableByName.get(item.name);
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
function sbShowRawFor(path) {
    return !!sbRawMembers[sbBaseNameOf(path)];
}
function sbRenderRawMembersUi(container, node, name) {
    const base = sbBaseNameOf(name);
    EmberProbeRuntime.renderMemberVisibility(container, node, name, sbShowRawFor(name), t, () => {
        sbRawMembers[base] = !sbShowRawFor(name);
        saveSbUi();
        renderValues();
        renderAvailable();
    });
}
function sbFmtDisplayNode(node) {
    if (node?.functionEmpty) return t("lw.functionEmpty");
    if (node?.isPointer) return EmberProbeRuntime.pointerLabel(node, t);
    return node ? fmtExact(node.value, node.valueText, node.enumText) : "—";
}
// Pointer metadata for a scalar watch; the layout walk runs once per render, not per refresh.
let sbDisplayInfos = new WeakMap();
function sbWatchDisplayInfo(item) {
    if (!sbDisplayInfos.has(item)) sbDisplayInfos.set(item, sbResolveWatchDisplayInfo(item));
    return sbDisplayInfos.get(item);
}
function sbResolveWatchDisplayInfo(item) {
    if (item.isPointer) return item;
    const direct = availableByName.get(item.name);
    if (direct?.isPointer) return direct;
    const symbol = sbLayoutSymbol(item.name);
    return (
        EmberProbeRuntime.displayLayoutLeaves(
            symbol,
            symbol?.compositeLayout,
            sbBaseNameOf(item.name),
            symbol?.address,
            { showRaw: true, includePointers: true }
        ).find((leaf) => leaf.path === item.name) || item
    );
}
function sbScalarDisplay(item) {
    const info = sbWatchDisplayInfo(item);
    // Before the first sample a pointer shows the target it had when last sampled.
    const last = info.isPointer && latest[item.name] === undefined && sbShownLastPointers()[item.name];
    if (last) return sbFmtDisplayNode({ ...info, ...last, stale: true });
    return sbFmtDisplayNode({
        ...info,
        ...latestPointer[item.name],
        value: latest[item.name],
        valueText: latestText[item.name],
        enumText: latestEnum[item.name]
    });
}
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
    // A settings override or a custom interface script selects the device; the list only shows it.
    const locked = !!m.override || m.state === "script";
    connectedProbeLocked = locked;
    const source = m.override
        ? t("probe.lockedBySetting")
        : m.state === "script"
          ? t("probe.scriptDecides")
          : m.source
            ? t("probe.source." + m.source)
            : "";
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
function revealIncompleteConfiguration() {
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
function fmtExact(value, valueText, enumText) {
    if (enumText) return String(enumText);
    return valueText !== null && valueText !== undefined ? String(valueText) : fmt(value);
}
function setDisplayedValue(cell, value) {
    EmberProbeRuntime.setValueCell(cell, value);
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
    const parent = sideWatch.find((w) => w.name === b && sbIsComposite(w));
    return (
        !!parent &&
        !!compCells[name] &&
        !(parent.runtimeLayout && sideWatch.find((w) => w.name === name)?.layoutExpanded)
    );
}
function sbCollectLeaves(layout, name, baseAddr, options = {}) {
    return EmberProbeRuntime.displayLayoutLeaves(sbLayoutSymbol(name), layout, name, baseAddr, options);
}
function sbSelectionLeaves(symbol, runtime) {
    const showRaw = sbShowRawFor(symbol.name);
    const statics = sbCollectLeaves(symbol.compositeLayout, symbol.name, symbol.address, {
        showRaw,
        includePointers: true
    });
    const visibleRuntime = EmberProbeRuntime.displayRuntimeSelection(symbol, latest[symbol.name], showRaw);
    return runtime ? (visibleRuntime?.entries || []).concat(statics.filter((leaf) => leaf.layoutExpanded)) : statics;
}
const LEAF_W = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 };
function sbRemove(name, isComp) {
    if (isComp) {
        sideWatch = sideWatch.filter((w) => w.name !== name && sbBaseNameOf(w.name) !== name);
        delete sbRawMembers[name];
        for (const state of [sbExpanded, sbArrayShown])
            Object.keys(state).forEach((key) => {
                if (key === name || key.startsWith(name + ".") || key.startsWith(name + "[")) delete state[key];
            });
    } else {
        const removed = sideWatch.filter((w) => EmberProbeRuntime.isPointeeDescendant(w, name));
        sideWatch = sideWatch.filter((w) => w.name !== name && !removed.includes(w));
        removed.forEach((w) => sbForgetValues(w.name));
    }
    sbForgetValues(name);
}
let sbPointerSaveTimer = null;
// Snapshots sampled from another ELF never name targets in the loaded one.
function sbShownLastPointers() {
    return availableVersion && sbLastPointersVersion === availableVersion ? sbLastPointers : Object.create(null);
}
function sbResetLastPointers(version) {
    sbLastPointers = Object.create(null);
    sbLastPointersVersion = version || "";
    uiState.sbLastPointers = sbLastPointers;
    uiState.sbLastPointersVersion = sbLastPointersVersion;
}
function sbRememberPointers(entries) {
    if (!availableVersion) return;
    let changed = false;
    if (sbLastPointersVersion !== availableVersion) {
        sbResetLastPointers(availableVersion);
        changed = true;
    }
    for (const [path, next] of Object.entries(entries)) {
        if (JSON.stringify(sbLastPointers[path]) !== JSON.stringify(next)) {
            sbLastPointers[path] = next;
            changed = true;
        }
    }
    if (!changed || sbPointerSaveTimer !== null) return;
    sbPointerSaveTimer = setTimeout(() => {
        sbPointerSaveTimer = null;
        saveSbUi();
    }, 2000);
}
function sbForgetPointers(name) {
    for (const path of Object.keys(sbLastPointers))
        if (path === name || path.startsWith(name + ".") || path.startsWith(name + "[")) delete sbLastPointers[path];
}
function sbForgetValues(name) {
    sbForgetPointers(name);
    delete latest[name];
    delete latestText[name];
    delete latestEnum[name];
    delete latestPointer[name];
}
function sbToggle(entry) {
    if (sideWatch.some((w) => w.name === entry.name)) {
        sbRemove(entry.name, !!entry.isComposite);
    } else {
        sideWatch.push(entry);
        if (entry.isComposite) sbExpanded[entry.name] = true;
    }
    renderValues();
    updateAvailableSelections();
    saveSideWatch();
    saveSbUi();
}
function renderValues() {
    sbDisplayInfos = new WeakMap();
    liveBox.textContent = "";
    compCells = Object.create(null);
    runtimeBodies = Object.create(null);
    sbPlacedPointees = new Set();
    sbFallbackPointees = new Set();
    // Expanded pointees render inside their pointer rows while composites and rows are built.
    const topLevel = sideWatch.filter((item) => !EmberProbeRuntime.isPointeeEntry(item));
    const rows = new Map();
    topLevel.filter(sbIsComposite).forEach((item) => {
        sbRenderComposite(item);
        rows.set(item.name, [liveBox.lastChild]);
    });
    liveBox.textContent = "";
    topLevel.forEach((item) => {
        if (!sbIsComposite(item) && !sbIsLeafChild(item.name)) rows.set(item.name, sbRenderScalarRow(item));
    });
    if (!sideWatch.length) {
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
    sideWatch
        .filter(EmberProbeRuntime.isPointeeEntry)
        .sort((a, b) => a.name.length - b.name.length)
        .forEach((item) => {
            if (sbPlacedPointees.has(item.name)) return;
            sbFallbackPointees.add(item.name);
            if (sbIsComposite(item)) sbRenderComposite(item);
            else liveBox.append(...sbRenderScalarRow(item));
        });
    document.getElementById("watchCount").textContent = String(
        sideWatch.filter((it) => !sbIsLeafChild(it.name) && !sbPlacedPointees.has(it.name)).length
    );
    sbWatchReorder?.refresh();
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
    const info = sbWatchDisplayInfo(item);
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
    // The pointee is part of the variable's card, on a second grid row below its value.
    const host = info.isPointer && sbPointerPointee(row, item.name, sbDisplayName(item), info);
    if (host) row.appendChild(host);
    setDisplayedValue(val, sbScalarDisplay(item));
    return [row];
}
// Pointer rows expand in place. A pointee already present in the sampled tree toggles
// locally; otherwise opening adds the read-only `<path>.value` watch, nested here.
function sbPointerPointee(row, path, label, node, renderInline) {
    const host = document.createElement("div");
    if (renderInline) {
        const toggle = EmberProbeRuntime.renderPointerToggle(row, path, !!sbExpanded[path], t, () => {
            sbExpanded[path] = !sbExpanded[path];
            host.classList.toggle("open", sbExpanded[path]);
            toggle.classList.toggle("open", sbExpanded[path]);
            toggle.setAttribute("aria-expanded", String(sbExpanded[path]));
            saveSbUi();
        });
        host.className = "pointer-pointee" + (sbExpanded[path] ? " open" : "");
        renderInline(host);
        return host;
    }
    row.classList.add("pointer-row");
    const entry = node?.isPointer && EmberProbeRuntime.pointerDerefEntry(path, sbPointerSymbol(path));
    if (!entry) return null;
    const item = sideWatch.find((w) => w.name === entry.name);
    EmberProbeRuntime.renderPointerToggle(row, path, !!item, t, () => sbTogglePointee(entry));
    if (!item) return null;
    host.className = "pointer-pointee open";
    sbRenderPointee(host, item, label);
    return host;
}
// Expansion needs the base symbol's runtime type graph. Composite watches load it with their
// layout; a scalar pointer variable requests it once here and re-renders when it arrives.
function sbPointerSymbol(path) {
    const symbol = availableByName.get(sbBaseNameOf(path));
    if (EmberProbeRuntime.runtimeGraph(symbol)) return symbol;
    const fallback = sbLayoutSymbol(path);
    if (
        !EmberProbeRuntime.runtimeGraph(fallback) &&
        symbol?.hasRuntimeLayout &&
        !symbol.layoutError &&
        api &&
        availableVersion &&
        !availableLayoutPending.has(symbol.name)
    ) {
        availableLayoutPending.add(symbol.name);
        sbPointerLayoutWaiters.add(symbol.name);
        api.postMessage({ type: "resolveCompositeLayout", name: symbol.name, version: availableVersion });
    }
    return fallback;
}
function sbTogglePointee(entry) {
    if (sideWatch.some((item) => item.name === entry.name)) {
        const removed = sideWatch.filter(
            (item) => item.name === entry.name || EmberProbeRuntime.isPointeeDescendant(item, entry.name)
        );
        sideWatch = sideWatch.filter((item) => !removed.includes(item));
        removed.forEach((item) => sbForgetValues(item.name));
    } else sideWatch.push(entry);
    renderValues();
    saveSideWatch();
}
function sbRenderPointee(host, item, label) {
    sbPlacedPointees.add(item.name);
    if (sbIsComposite(item)) {
        runtimeBodies[item.name] = host;
        sbRenderRuntimeBody(host, latest[item.name], item.name);
        return;
    }
    // A scalar target (`int *`, `char *` string preview, pointer to pointer) is one row.
    const row = document.createElement("div");
    row.className = "sb-mrow";
    row.dataset.path = item.name;
    const nm = document.createElement("span");
    nm.className = "sb-mname";
    nm.textContent = "*" + EmberProbeRuntime.shortVariableName(label).replace(/^./, "");
    nm.title = sbDisplayName(item);
    const ty = document.createElement("span");
    ty.className = "sb-mtype";
    ty.textContent = item.typeName || item.type || "";
    ty.title = ty.textContent;
    const val = document.createElement("span");
    val.className = "sb-mval";
    val.dataset.valueName = item.name;
    val.addEventListener("click", (event) => {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: EmberProbeRuntime.copyValueText(val) });
    });
    row.append(nm, ty, val);
    host.appendChild(row);
    const nested = sbPointerPointee(row, item.name, nm.textContent, sbWatchDisplayInfo(item));
    if (nested) host.appendChild(nested);
    setDisplayedValue(val, sbScalarDisplay(item));
}
const AVAILABLE_VARIABLE_LIMIT = 500;
const AVAILABLE_ROW_LIMIT = AVAILABLE_VARIABLE_LIMIT * 2;
// Heuristic origin filter; the extension classifies symbols from DWARF source paths, types and names.
let userVarsOnly = uiState.sbUserVarsOnly === true;
function isUserVariable(symbol) {
    return !symbol.origin || symbol.origin === "user";
}
function visibleAvailable() {
    return userVarsOnly ? available.filter(isUserVariable) : available;
}
function availableOriginTitle(symbol) {
    const lines = [];
    if (!isUserVariable(symbol)) lines.push(t("sb.origin." + symbol.origin));
    if (symbol.sourceFile) lines.push(t("sb.sourceFile", { file: symbol.sourceFile }));
    return lines.length ? "\n" + lines.join("\n") : "";
}
function applyUserVarsOnly() {
    const button = document.getElementById("varUserOnly");
    button.classList.toggle("primary", userVarsOnly);
    button.setAttribute("aria-pressed", String(userVarsOnly));
}
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
        visibleAvailable()
            .filter((symbol) => needsAvailableLayout(symbol) && !availableLayoutPending.has(symbol.name))
            .slice(0, slots)
            .forEach((symbol) => {
                availableLayoutPending.add(symbol.name);
                api.postMessage({ type: "resolveCompositeLayout", name: symbol.name, version: availableVersion });
            });
    }, 180);
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
function renderAvailableContents(content) {
    EmberProbeRuntime.renderElfDiagnostics(
        document.getElementById("availableDiagnostics"),
        variableWarnings,
        variableError,
        t("common.diagnostics"),
        t
    );
    const pool = visibleAvailable();
    const allCount = document.getElementById("allCount");
    allCount.textContent = userVarsOnly ? pool.length + "/" + available.length : String(available.length);
    allCount.title = userVarsOnly ? t("sb.filteredCount", { shown: pool.length, total: available.length }) : "";
    // The error is in the diagnostics notice above the list.
    if (variableError) return;
    const query = document.getElementById("varSearch").value.trim().toLowerCase();
    scheduleAvailableMemberSearch(query);
    const selected = new Set(sideWatch.map((w) => w.name));
    const nameMatches = (symbol) =>
        symbol.name.toLowerCase().includes(query) || sbDisplayName(symbol).toLowerCase().includes(query);
    const memberMatches = new Map();
    const matching = pool.filter((symbol) => {
        if (!query || nameMatches(symbol)) return true;
        if (!symbol.isComposite) return false;
        const runtime = EmberProbeRuntime.runtimeSelection(symbol, latest[symbol.name]);
        const leaves = sbSelectionLeaves(symbol, runtime);
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
            query && (!availableTypesReady || pool.some(needsAvailableLayout))
                ? t("sb.searchingMembers")
                : !pool.length && available.length
                  ? t("sb.noUserVars", { count: available.length })
                  : available.length
                    ? t("sb.noMatch")
                    : t("sb.noImportable");
        content.appendChild(e);
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
            EmberProbeRuntime.renderSymbolName(nm, sbDisplayName(sym), sym);
            nm.title += "\n" + (on ? t("sb.removeFromWatch") : t("sb.compositeAddWhole")) + availableOriginTitle(sym);
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
            content.appendChild(row);
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
                sbRenderRawMembersUi(kids, latest[sym.name] || sym.compositeLayout, sym.name);
                const runtime = EmberProbeRuntime.runtimeSelection(sym, latest[sym.name]);
                const leaves = memberMatches.get(sym.name) || sbSelectionLeaves(sym, runtime);
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
                if (runtime && leaves.some((leaf) => leaf.layoutExpanded)) sbNote(kids, t("lw.layoutStaticStorage"));
                if (sym.compositeLayout?.truncated || sym.runtimeLayout?.truncated) sbNote(kids, t("lw.layoutPartial"));
                for (const entry of EmberProbeRuntime.displayUnavailableRows(
                    sym.compositeLayout,
                    sym.name,
                    64,
                    sym,
                    sbShowRawFor(sym.name)
                ))
                    layoutExpansionUi.render(kids, entry, sym.name, t);
                const shownLeaves = Math.min(leaves.length, Math.max(0, AVAILABLE_ROW_LIMIT - list.length - leafRows));
                leaves.slice(0, shownLeaves).forEach((lf) => {
                    const lb = document.createElement("div");
                    lb.className = "available-row leaf";
                    const cell = document.createElement("span");
                    cell.className = "av-name-cell";
                    const leafEntry = {
                        name: lf.path,
                        displayName: sbDisplayName({ name: lf.displayPath || lf.path, displayName: lf.displayName }),
                        address: lf.address,
                        size: lf.size || LEAF_W[lf.type] || 4,
                        type: lf.type,
                        ...(lf.isPointer
                            ? { isPointer: true, typeName: lf.typeName, pointerTarget: lf.pointerTarget }
                            : {}),
                        ...(lf.layoutExpanded
                            ? { layoutExpanded: true, staticRuntimeStorage: lf.staticRuntimeStorage }
                            : {}),
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
                    cell.appendChild(mkWriteBtn(leafEntry));
                    cell.appendChild(mkWatchBtn(lf.path, false, "", () => sbToggle(leafEntry)));
                    const ln = document.createElement("span");
                    ln.className = "av-leaf-name";
                    ln.textContent = lf.label;
                    ln.title = leafEntry.displayName;
                    cell.appendChild(ln);
                    const lty = document.createElement("span");
                    lty.className = "available-type";
                    lty.textContent =
                        (lf.isPointer ? lf.typeName : lf.type) || (lf.isComposite ? t("lw.compositeType") : "");
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
            content.appendChild(kids);
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
            content.appendChild(b);
        }
    });
    if (matching.length > list.length) {
        const note = document.createElement("div");
        note.className = "sb-note";
        note.textContent = t("lw.showingFirst", { n: list.length });
        content.appendChild(note);
    }
}
function sbIsComposite(it) {
    return !!(it && it.isComposite && (it.compositeLayout || it.runtimeLayout));
}
// 写入列表：与查看列表共用 ELF 变量栏添加；拖动时最多 10 Hz 连续写入，结果由 writeResult 反馈
const WRITE_INTERVAL_MS = 100;
// 调试暂停时 CPU 看不到拖动中的中间值，每次写入却会让调试器刷新变量与 RTOS 视图；只写停稳后的值
const PAUSED_WRITE_SETTLE_MS = 300;
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
// 采样值或回读值超出滑块范围时扩展范围，使滑块位置可表示当前值（与加入写入列表时的初始范围规则一致）
function widenWriteBounds(item, v) {
    let min = Number(item.min),
        max = Number(item.max);
    if (!Number.isFinite(v) || !Number.isFinite(min) || !Number.isFinite(max) || (v >= min && v <= max)) return false;
    if (v > max) max = 2 * Math.abs(v);
    if (v < min) min = -2 * Math.abs(v) || 0;
    const range = TYPE_RANGE[item.type];
    if (range) {
        min = Math.max(range[0], min);
        max = Math.min(range[1], max);
    }
    item.min = min;
    item.max = max;
    return true;
}
function typedWriteValueError(item, value) {
    if (isFloat(item.type)) return "";
    const type = item.isBoolean ? "bool" : item.type;
    if (!Number.isInteger(value)) return t("sb.writeValueNotInteger", { type, value });
    const [min, max] = item.isBoolean ? [0, 1] : TYPE_RANGE[item.type] || [value, value];
    return value < min || value > max ? t("sb.writeValueOutOfRange", { type, value, min, max }) : "";
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
// 对齐的 32 位变量可在 CPU 运行时直接写入；8/16 位、未对齐与 64 位写入需短暂 halt 执行读-改-写
function writeRisk(item) {
    return EmberProbeRuntime.writeHaltRisk(item.address, LEAF_W[item.type] || item.size);
}
function writeGateKey(item) {
    if (!liveCanWrite) return liveWriteUnavailableKey;
    return !liveHaltWrite && writeRisk(item) ? "sb.writeNeedHalt" : "";
}
// 风险说明用自绘浮层：原生 title 无法限制宽度，且会与名称的 title 叠加
let writeRiskTip = null;
function showWriteRiskTip(icon) {
    if (!writeRiskTip) {
        writeRiskTip = document.createElement("div");
        writeRiskTip.className = "write-risk-tip";
        writeRiskTip.id = "writeRiskTip";
        writeRiskTip.setAttribute("role", "tooltip");
        document.body.appendChild(writeRiskTip);
    }
    writeRiskTip.textContent = icon.dataset.tip;
    writeRiskTip.hidden = false;
    icon.setAttribute("aria-describedby", writeRiskTip.id);
    const anchor = icon.getBoundingClientRect(),
        width = writeRiskTip.offsetWidth,
        height = writeRiskTip.offsetHeight,
        viewWidth = document.documentElement.clientWidth || window.innerWidth,
        viewHeight = document.documentElement.clientHeight || window.innerHeight;
    const left = Math.max(4, Math.min(anchor.left, viewWidth - width - 4));
    const below = anchor.bottom + 4;
    writeRiskTip.style.left = left + "px";
    writeRiskTip.style.top = (below + height > viewHeight - 4 ? Math.max(4, anchor.top - height - 4) : below) + "px";
}
function hideWriteRiskTip(icon) {
    if (writeRiskTip) writeRiskTip.hidden = true;
    icon?.removeAttribute("aria-describedby");
}
function writeRiskIcon(item) {
    const risk = writeRisk(item);
    if (!risk) return null;
    const bytes = LEAF_W[item.type] || Number(item.size) || 0;
    const icon = document.createElement("span");
    icon.className = "write-risk";
    icon.tabIndex = 0;
    icon.setAttribute("role", "img");
    icon.innerHTML = EmberProbeRuntime.warningIconSvg("write-risk-icon");
    icon.dataset.tip = t("sb.writeRisk." + risk, {
        bits: bytes * 8,
        addr: "0x" + ((Number(item.address) || 0) >>> 0).toString(16).toUpperCase()
    });
    icon.setAttribute("aria-label", icon.dataset.tip);
    icon.addEventListener("mouseenter", () => showWriteRiskTip(icon));
    icon.addEventListener("focus", () => showWriteRiskTip(icon));
    icon.addEventListener("mouseleave", () => hideWriteRiskTip(icon));
    icon.addEventListener("blur", () => hideWriteRiskTip(icon));
    return icon;
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
    const on = !disabled && inWriteList(entry.name);
    const button = mkAvBtn(
        "av-write",
        "\u270e",
        on,
        disabled,
        disabled ? reason || t("sb.writeUnsupported") : on ? t("sb.removeFromWrite") : t("sb.addToWrite"),
        () => wToggle(entry)
    );
    button.dataset.selectionName = entry.name;
    return button;
}
function mkWatchBtn(name, disabled, reason, handler) {
    const on = !disabled && sideWatch.some((w) => w.name === name);
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
    const watched = new Set(sideWatch.map((item) => item.name));
    const written = new Set(writeList.map((item) => item.name));
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
    delete writeConfirmed[name];
    writeList = writeList.filter((w) => w.name !== name);
    renderWrites();
    updateAvailableSelections();
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
                displayName: sbDisplayName(entry),
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
            writeList.push({
                name: entry.name,
                displayName: sbDisplayName(entry),
                address: entry.address,
                size: entry.size,
                type,
                value: v
            });
        } else {
            let v = Number(latest[entry.name]);
            if (!Number.isFinite(v)) v = 0;
            const item = {
                name: entry.name,
                displayName: sbDisplayName(entry),
                address: entry.address,
                size: entry.size,
                type: type,
                min: nb[0],
                max: nb[1],
                value: v
            };
            widenWriteBounds(item, v);
            writeList.push(item);
        }
        renderWrites();
        updateAvailableSelections();
        saveWriteList();
    }
}
function postWrite(item) {
    if (!api || !inWriteList(item.name)) return;
    const gate = writeGateKey(item);
    if (gate) {
        setWriteFeedback({ key: gate });
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
    if (liveTargetHalted) {
        writeTimers[name] = setTimeout(() => {
            delete writeTimers[name];
            writeLastAt[name] = Date.now();
            postWrite(item);
        }, PAUSED_WRITE_SETTLE_MS);
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
function buildWriteCard(item, label) {
    const wide = isWideInt(item.type),
        row = document.createElement("div");
    row.className = "write-row" + (wide ? " wide" : "");
    const main = document.createElement("div");
    main.className = "write-main";
    const top = document.createElement("div");
    top.className = "write-top";
    const nm = document.createElement("span");
    nm.className = "value-name";
    const displayName = sbDisplayName(item);
    nm.textContent = label || EmberProbeRuntime.shortVariableName(displayName);
    nm.title = displayName;
    nm.dataset.rawName = item.name;
    nm.setAttribute("aria-label", displayName);
    const dot = document.createElement("span");
    dot.className = "write-dot";
    const nmWrap = document.createElement("span");
    nmWrap.className = "write-name-wrap";
    const riskIcon = writeRiskIcon(item);
    if (riskIcon) {
        // The icon sits beside the name, not inside it, so the name's title never covers the risk tip.
        const line = document.createElement("span");
        line.className = "write-name-line";
        line.append(riskIcon, nm);
        nmWrap.append(dot, line);
    } else nmWrap.append(dot, nm);
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
    if (!(item.name in writeConfirmed)) writeConfirmed[item.name] = item.value;
    writeCells[item.name] = {
        item,
        row,
        input,
        slider,
        dot,
        controls: [minus, plus, input, slider],
        setVal: (v) => {
            if (item.isBoolean) v = Number(v) ? 1 : 0;
            item.value = v;
            input.value = wide ? String(v) : fmt(v);
            if (wide) return;
            if (!item.isBoolean && widenWriteBounds(item, Number(v))) {
                writeCells[item.name].syncSlider();
                saveWriteList();
            } else slider.value = String(Math.min(Number(item.max), Math.max(Number(item.min), v)));
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
                setWriteFeedback({ key: "sb.invalidWriteValue" });
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
        writeCells[item.name].syncSlider = syncSlider;
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
            const text = input.value.trim();
            if (text === fmt(item.value)) return;
            const raw = Number(text);
            // An emptied box is not a request to write 0.
            if (!text || !Number.isFinite(raw)) {
                input.value = fmt(item.value);
                return;
            }
            // Typed values are written exactly or not at all; never clamp or round them silently.
            const invalid = typedWriteValueError(item, raw);
            if (invalid) {
                input.value = fmt(item.value);
                setWriteFeedback({ text: invalid });
                return;
            }
            const v = raw;
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
                // Scrolling the panel across an unfocused value box must not write to the target.
                if (writeGateKey(item) || document.activeElement !== input) return;
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
    applyWriteGate(writeCells[item.name]);
    return row;
}
function renderWrites() {
    hideWriteRiskTip();
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
    const labels = EmberProbeRuntime.uniqueShortVariableNames(writeList.map((item) => sbDisplayName(item)));
    writeList.forEach((item, index) => {
        const card = buildWriteCard(item, labels[index]);
        EmberProbeCardReorder.decorate(card, item.name, t("sb.dragToReorder", { name: sbDisplayName(item) }));
        writeBox.appendChild(card);
    });
    sbWriteReorder?.refresh();
}
function applyWriteGate(cells) {
    const gate = writeGateKey(cells.item),
        title = gate ? t(gate) : "";
    cells.row.classList.toggle("gated", !!gate);
    cells.controls.forEach((control) => {
        control.disabled = !!gate;
        control.title = title;
    });
}
function updateWriteAvailability() {
    Object.values(writeCells).forEach(applyWriteGate);
}
// Input checks fade on their own; a failed write stays until dismissed or the next write succeeds.
function setWriteFeedback(notice) {
    if (!notice) return clearNotice("write", "write");
    setNotice("write", "write", notice.level === "error" ? notice : { level: "warning", timeoutMs: 5000, ...notice });
}
// 写入结果反馈：变量名前的小圆点渐亮后消失（成功绿点/失败红点）；失败另在标题区显示错误原因
function knownWriteValue(item) {
    if (isWideInt(item.type)) return latestText[item.name] ?? writeConfirmed[item.name];
    const sampled = latest[item.name];
    const value = sampled === null || sampled === undefined ? NaN : Number(sampled);
    if (Number.isFinite(value)) return isFloat(item.type) ? value : Math.round(value);
    return writeConfirmed[item.name];
}
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
            latestEnum[m.name] = m.enumText ?? null;
            cells.setVal(m.valueText ?? m.value);
            writeConfirmed[m.name] = m.valueText ?? m.value;
        } else {
            // Show what the target still holds, not the rejected value, so steps start from it.
            cancelPendingWrite(m.name);
            const known = knownWriteValue(cells.item);
            if (known !== undefined) {
                cells.setVal(known);
                saveWriteList();
            }
        }
    }
    if (m.ok) {
        if (notices.write?.get("write")?.level === "error") setWriteFeedback(null);
    } else
        setWriteFeedback(
            window.EmberProbeNotice.hostNotice({
                error: m.key || m.message ? m : { key: "sb.commandFailed" },
                title: { key: "sb.writeFailTitle", params: { name: m.name } }
            })
        );
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
    uiState.sbRawMembers = sbRawMembers;
    uiState.sbArrayShown = sbArrayShown;
    uiState.sbLastPointers = sbLastPointers;
    uiState.sbLastPointersVersion = sbLastPointersVersion;
    if (api && api.setState) api.setState(uiState);
}
function sbWalkLeaves(node, path, cb) {
    if (!node) return;
    cb(path, node);
    for (const member of node.members || []) sbWalkLeaves(member, EmberProbeRuntime.layoutMemberPath(path, member), cb);
    for (const element of node.elements || []) sbWalkLeaves(element, path + "[" + element.index + "]", cb);
}
function sbUpdateComposite(name) {
    const tree = latest[name];
    if (!tree) return;
    const nodes = new Map();
    sbWalkLeaves(tree, name, (path, node) => nodes.set(path, node));
    nodes.forEach((node, path) => {
        const cell = compCells[path];
        if (!cell) return;
        const summary = cell.summaryPath && EmberProbeRuntime.summaryRow(nodes.get(cell.summaryPath), cell.summaryPath);
        setDisplayedValue(
            cell,
            sbFmtDisplayNode({
                ...cell.displayNode,
                ...node,
                ...(summary ? { functionEmpty: summary.empty } : {})
            })
        );
    });
}
function sbNote(container, txt) {
    const n = document.createElement("div");
    n.className = "sb-note";
    n.textContent = txt;
    container.appendChild(n);
}
function sbRenderLeaf(container, label, typeName, path, watchType, node, renderInline) {
    const row = document.createElement("div");
    row.className = "sb-mrow";
    const nm = document.createElement("span");
    nm.className = "sb-mname";
    nm.textContent = label;
    nm.title = sbDisplayName({ name: node?.displayPath || path });
    nm.setAttribute("aria-label", nm.title);
    const ty = document.createElement("span");
    ty.className = "sb-mtype";
    ty.textContent = typeName || watchType;
    const val = document.createElement("span");
    val.className = "sb-mval";
    val.displayNode = node;
    val.summaryPath = node?.summaryPath;
    val.addEventListener("click", (event) => {
        event.stopPropagation();
        if (api && val.textContent) api.postMessage({ type: "copyText", text: EmberProbeRuntime.copyValueText(val) });
    });
    compCells[path] = val;
    row.dataset.path = path;
    ty.title = ty.textContent;
    row.append(nm, ty, val);
    container.appendChild(row);
    const host = node?.isPointer && sbPointerPointee(row, path, label, node, renderInline);
    if (host) container.appendChild(host);
    setDisplayedValue(val, sbFmtDisplayNode(sbWithLastPointer(node, path)));
}
// A static layout row has no value until sampled; a pointer in it shows its last known target.
function sbWithLastPointer(node, path) {
    const last = node?.isPointer && node.value == null && !node.stale && sbShownLastPointers()[path];
    return last && latest[sbBaseNameOf(path)] === undefined ? { ...node, ...last, stale: true } : node;
}
function sbRenderLayout(container, layout, path, displayPath = path) {
    if (!layout) return;
    const promoted = !sbShowRawFor(path) && EmberProbeRuntime.summaryRow(layout, path);
    if (promoted) {
        sbRenderSummary(container, promoted, path);
        return;
    }
    if (layout.kind === "struct" || layout.kind === "union" || layout.kind === "class") {
        const ms = layout.members || [];
        ms.forEach((original) => {
            if (!EmberProbeRuntime.memberVisible(original, sbShowRawFor(path))) return;
            const symbol = sbLayoutSymbol(path);
            const m = EmberProbeRuntime.layoutBranch(
                symbol,
                original,
                EmberProbeRuntime.layoutMemberPath(path, original)
            );
            const cp = EmberProbeRuntime.layoutMemberPath(path, m);
            const summary = !sbShowRawFor(path) && EmberProbeRuntime.summaryRow(m, cp);
            if (summary) sbRenderSummary(container, summary, m.name, m.typeName);
            else if (m.unobservable)
                layoutExpansionUi.render(container, { ...m, path: cp }, EmberProbeRuntime.variableBaseName(path), t);
            else if (m.compositeLayout && !m.name) sbRenderLayout(container, m.compositeLayout, cp, displayPath);
            else if (m.compositeLayout)
                sbRenderNest(
                    container,
                    m.compositeLayout,
                    m.name,
                    cp,
                    EmberProbeRuntime.layoutMemberPath(displayPath, m)
                );
            else if (m.watchType)
                sbRenderLeaf(container, m.name, m.typeName || m.watchType, cp, m.watchType, {
                    ...m,
                    ...(displayPath !== path ? { displayPath: EmberProbeRuntime.layoutMemberPath(displayPath, m) } : {})
                });
        });
        if (!ms.length) sbNote(container, t("lw.compositeNoLayout"));
    } else if (layout.kind === "array") {
        const et = layout.elementType || {},
            total = Number(layout.totalElements) || 0;
        if (!et.watchType && !et.compositeLayout && !et.unobservable) {
            sbNote(container, t("lw.compositeNoLayout"));
            return;
        }
        const shown = EmberProbeRuntime.arrayShownCount(total, sbArrayShown[path]);
        for (let i = 0; i < shown; i++) {
            const p = path + "[" + i + "]";
            const element = EmberProbeRuntime.layoutBranch(sbLayoutSymbol(path), et, p);
            if (element.unobservable)
                layoutExpansionUi.render(
                    container,
                    { ...element, path: p },
                    EmberProbeRuntime.variableBaseName(path),
                    t
                );
            else if (element.compositeLayout)
                sbRenderNest(container, element.compositeLayout, "[" + i + "]", p, displayPath + "[" + i + "]");
            else
                sbRenderLeaf(container, "[" + i + "]", et.typeName || et.watchType, p, et.watchType, {
                    ...element,
                    ...(displayPath !== path ? { displayPath: displayPath + "[" + i + "]" } : {})
                });
        }
        if (total > shown)
            EmberProbeRuntime.renderArrayMore(container, total - shown, t, (page) => {
                sbArrayShown[path] = shown + page;
                saveSbUi();
                renderValues();
            });
    }
}
function sbRenderSummary(container, summary, label, typeName) {
    const node = {
        ...summary.node,
        displayPath: summary.displayPath,
        summaryPath: summary.displayPath,
        functionEmpty: summary.empty
    };
    const layout = node.compositeLayout || ((node.members || node.elements || node.kind === "array") && node);
    if (node.unobservable)
        layoutExpansionUi.render(container, { ...node, path: summary.path }, sbBaseNameOf(summary.path), t);
    else if (layout) sbRenderNest(container, layout, label, summary.path, summary.displayPath);
    else
        sbRenderLeaf(
            container,
            label,
            typeName || node.typeName || node.watchType,
            summary.path,
            node.watchType || node.type,
            node
        );
}
// Nested structs and array elements get a collapsible head, as in static layouts; base
// classes, anonymous members and a pointer's own target stay flat.
function sbRenderRuntimeTree(container, tree, path, label = "value", promoted = false, nest = false) {
    if (!tree) return;
    const summary = !promoted && !sbShowRawFor(path) && EmberProbeRuntime.summaryRow(tree, path);
    if (summary) {
        const target = { ...summary.node, displayPath: path, summaryPath: path, functionEmpty: summary.empty };
        if (target.members || target.elements) {
            const wrap = document.createElement("div");
            const head = document.createElement("button");
            head.type = "button";
            head.className = "sb-comp-head summary-head";
            head.textContent = label;
            head.title = sbDisplayName({ name: path });
            const body = document.createElement("div");
            body.className = "sb-members" + (sbExpanded[path] ? " open" : "");
            head.setAttribute("aria-expanded", String(!!sbExpanded[path]));
            head.onclick = () => {
                sbExpanded[path] = !sbExpanded[path];
                body.classList.toggle("open", sbExpanded[path]);
                head.setAttribute("aria-expanded", String(sbExpanded[path]));
                saveSbUi();
            };
            sbRenderRuntimeTree(body, target, summary.path, label, true);
            wrap.append(head, body);
            container.appendChild(wrap);
        } else sbRenderRuntimeTree(container, target, summary.path, label, true);
        return;
    }
    const pointer = tree.isPointer || tree.valueText === "nullptr";
    if (nest && !pointer && !Object.prototype.hasOwnProperty.call(tree, "value") && (tree.members || tree.elements)) {
        const body = sbNestShell(container, label, tree.typeName, path, tree.displayPath || path);
        sbRenderRuntimeTree(body, tree, path, label, promoted);
        return;
    }
    const renderMembers = (target) =>
        tree.members.forEach((member) => {
            if (!EmberProbeRuntime.memberVisible(member, sbShowRawFor(path))) return;
            const childPath = EmberProbeRuntime.layoutMemberPath(path, member);
            if (member.unobservable)
                sbNote(
                    target,
                    (member.name || "?") + ": " + EmberProbeRuntime.unobservableReason(member.unobservable, t)
                );
            else
                sbRenderRuntimeTree(
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
    const inline = pointer && tree.members?.length ? renderMembers : null;
    if (pointer || Object.prototype.hasOwnProperty.call(tree, "value"))
        sbRenderLeaf(
            container,
            label,
            tree.typeName || tree.type || "",
            path,
            tree.type || (pointer ? "u32" : undefined),
            { ...tree, ...(pointer ? { isPointer: true } : {}) },
            inline
        );
    if (tree.members && !inline) renderMembers(container);
    else if (tree.elements)
        tree.elements.forEach((element) => {
            sbRenderRuntimeTree(
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
    if (tree.unobservable) sbNote(container, EmberProbeRuntime.unobservableReason(tree.unobservable, t));
    else if (tree.unavailable)
        sbNote(container, tree.unavailableCode === "LIVE_NULL_POINTER" ? t("lw.pointeeNull") : tree.unavailable);
}
function sbRenderRuntimeBody(body, sampled, name) {
    // Without a sample the type graph still yields the rows, so pointer rows keep their pointees.
    const tree =
        sampled ||
        EmberProbeRuntime.placeholderRuntimeTree(
            sideWatch.find((item) => item.name === name),
            sbShownLastPointers()
        );
    const shape = JSON.stringify([sbShowRawFor(name), !sampled, EmberProbeRuntime.displayTreeShape(tree)]);
    if (body.dataset.runtimeShape === shape) return;
    for (const path of Object.keys(compCells)) {
        if (body.contains(compCells[path])) delete compCells[path];
    }
    body.textContent = "";
    body.dataset.runtimeShape = shape;
    if (tree?.truncated) sbNote(body, t("lw.layoutPartial"));
    sbRenderRawMembersUi(body, sampled || sbLayoutSymbol(name)?.compositeLayout, name);
    sbRenderRuntimeTree(body, tree, name);
    const symbol = sbLayoutSymbol(name);
    for (const entry of EmberProbeRuntime.displayUnavailableRows(
        symbol?.compositeLayout,
        name,
        64,
        symbol,
        sbShowRawFor(name)
    ))
        layoutExpansionUi.render(body, entry, name, t);
    if (!sampled) sbNote(body, t("lw.waitSamples"));
}
function sbRenderNest(container, layout, fieldName, path, displayPath = path) {
    sbRenderLayout(sbNestShell(container, fieldName, layout.typeName, path, displayPath), layout, path, displayPath);
}
// Collapsible head + body for a nested composite; returns the body to render into.
function sbNestShell(container, fieldName, typeName, path, displayPath = path) {
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
    nm.title = sbDisplayName({ name: displayPath });
    const ty = document.createElement("span");
    ty.className = "sb-comp-type";
    ty.textContent = typeName || "";
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
    wrap.append(head, body);
    container.appendChild(wrap);
    return body;
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
        sbExpanded[item.name] = !sbExpanded[item.name];
        row.classList.toggle("open", sbExpanded[item.name]);
        arrow.classList.toggle("open", sbExpanded[item.name]);
        saveSbUi();
    };
    if (item.runtimeLayout) {
        runtimeBodies[item.name] = body;
        sbRenderRuntimeBody(body, latest[item.name], item.name);
    } else {
        sbRenderRawMembersUi(body, lay, item.name);
        if (lay.truncated) sbNote(body, t("lw.layoutPartial"));
        sbRenderLayout(body, lay, item.name);
    }
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
            sbRememberPointers(EmberProbeRuntime.pointerSnapshots(s.tree, s.name));
            const body = runtimeBodies[s.name];
            if (body) sbRenderRuntimeBody(body, s.tree, s.name);
        }
    });
    if (refreshAvailable) renderAvailable();
    // A re-rendered tree can now show the pointer row of a pointee drawn as a stand-alone card.
    if ([...sbFallbackPointees].some((name) => sbPlacedPointees.has(name))) renderValues();
    scheduleValueRefresh();
}
function updateValues(samples) {
    (samples || []).forEach((s) => {
        latest[s.name] = s.value;
        latestText[s.name] = s.diagnostic?.code === "LIVE_NULL_POINTER" ? t("lw.pointeeNull") : (s.valueText ?? null);
        latestEnum[s.name] = s.enumText ?? null;
        latestPointer[s.name] = {
            ...(s.isPointer || s.pointerText ? { isPointer: true } : {}),
            pointerText: s.pointerText,
            pointerInfo: s.pointerInfo,
            pointerString: s.pointerString
        };
        if ((s.isPointer || s.pointerText) && s.value != null && !s.diagnostic)
            sbRememberPointers({
                [s.name]: {
                    value: s.value,
                    ...(s.valueText != null ? { valueText: s.valueText } : {}),
                    ...(s.pointerText ? { pointerText: s.pointerText } : {}),
                    ...(s.pointerInfo ? { pointerInfo: s.pointerInfo } : {}),
                    ...(s.pointerString ? { pointerString: s.pointerString } : {})
                }
            });
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
    const items = new Map(sideWatch.map((item) => [item.name, item]));
    document.querySelectorAll("[data-value-name]").forEach((el) => {
        setDisplayedValue(el, sbScalarDisplay(items.get(el.dataset.valueName) || { name: el.dataset.valueName }));
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
            if (text != null) {
                c.setVal(text);
                writeConfirmed[item.name] = text;
            }
            return;
        }
        const sampled = latest[item.name];
        if (sampled === null || sampled === undefined) return;
        let v = Number(sampled);
        if (!Number.isFinite(v)) return;
        if (!isFloat(item.type)) v = Math.round(v);
        c.setVal(v);
        writeConfirmed[item.name] = v;
    });
}
function liveStatus(m) {
    m = m || {};
    lastLive = m;
    const wasWrite = liveCanWrite,
        wasHaltWrite = liveHaltWrite,
        wasWriteUnavailableKey = liveWriteUnavailableKey;
    const next = window.EmberProbeRuntime.liveState(
        { running: liveRunning, canRead: liveCanRead, canWrite: liveCanWrite },
        m
    );
    liveRunning = next.running;
    liveCanRead = next.canRead;
    liveCanWrite = next.canWrite;
    liveHaltWrite = next.haltWrite;
    liveTargetHalted = m.source === "dap" && String(m.mode || "").startsWith("debug-paused");
    liveWriteUnavailableKey = EmberProbeRuntime.writeUnavailableKey({
        ...m,
        running: liveRunning,
        canWrite: liveCanWrite
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
    if (
        wasWrite !== liveCanWrite ||
        wasHaltWrite !== liveHaltWrite ||
        wasWriteUnavailableKey !== liveWriteUnavailableKey
    )
        updateWriteAvailability();
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
    if (k === "ready") return clearNotice("global", "openocd");
    const action = (key, name, primary) => ({
        label: { key },
        primary,
        message: { type: "openocdAction", action: name }
    });
    const install = m.canInstall !== false;
    setNotice("global", "openocd", {
        level: busy ? "info" : k === "missing" ? "warning" : "error",
        busy,
        title: { key: "sb.openocdEnv" },
        text: m.key ? { key: m.key, params: m.params } : m.message || { key: "oc.checking" },
        actions: busy
            ? []
            : [
                  ...(install ? [action("sb.install", "install", true)] : []),
                  action("sb.selectPath", "select", !install),
                  action("sb.recheck", "check")
              ],
        dismissible: false
    });
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
// Agent 访问开关与遗留全局 skills 提示；状态只来自扩展推送的 agentAccess 消息。
function renderAgentAccess(m) {
    lastAgentAccess = m || lastAgentAccess;
    const state = lastAgentAccess?.card || "";
    if (!state) clearNotice("global", "agent-access");
    else
        setNotice("global", "agent-access", {
            level: "info",
            text: { key: state === "enabled" ? "agent.accessEnabled" : "agent.accessDisabled" },
            actions: [
                {
                    label: { key: state === "enabled" ? "agent.disable" : "agent.enable" },
                    primary: state !== "enabled",
                    command: state === "enabled" ? "mcu-vscode.disableAgentAccess" : "mcu-vscode.enableAgentAccess"
                }
            ],
            dismissible: false
        });
    const old = lastAgentAccess?.legacyGlobal;
    if (!old) clearNotice("global", "agent-legacy");
    else
        setNotice("global", "agent-legacy", {
            level: "warning",
            text: { key: "agent.legacyGlobal", params: { version: old.version || "?" } },
            actions: [{ label: { key: "agent.cleanup" }, command: "mcu-vscode.cleanupGlobalSkills" }],
            dismissible: false
        });
}
const skillToggle = document.getElementById("skillStatus");
if (skillToggle)
    skillToggle.onclick = () => {
        if (skillToggle.disabled || !api) return;
        skillToggle.classList.add("animate");
        skillToggle.disabled = true;
        api.postMessage({ type: "executeCommand", cmd: "mcu-vscode.manageAgentSkills" });
    };
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
document.querySelectorAll("[data-command]").forEach(
    (b) =>
        (b.onclick = () => {
            if (!api) return setStat("error", "sb.extNotConnected");
            revealIncompleteConfiguration();
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
    agentAccess: function (m) {
        renderAgentAccess(m);
    },
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
        for (const item of sideWatch)
            if (!incoming.some((next) => next.name === item.name)) sbForgetPointers(item.name);
        sideWatch = incoming;
        if (m.resetValues) {
            sbResetLastPointers(sbLastPointersVersion);
            sideWatch.forEach((item) => {
                delete latest[item.name];
                delete latestText[item.name];
                delete latestEnum[item.name];
                delete latestPointer[item.name];
            });
        }
        renderValues();
        updateAvailableSelections();
    },
    sidebarWriteList: function (m) {
        writeList = (m.items || []).slice();
        writeConfirmed = Object.create(null);
        renderWrites();
        updateAvailableSelections();
    },
    writeResult: function (m) {
        onWriteResult(m);
    },
    availableVariables: function (m) {
        variableWarnings = m.warnings || [];
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
        variableWarnings = m.warnings || [];
        availableVersion = m.version || "";
        availableGeneration = m.generation ?? null;
        if (availableVersion && sbLastPointersVersion && sbLastPointersVersion !== availableVersion) {
            sbResetLastPointers(availableVersion);
            saveSbUi();
        }
        layoutExpansionUi.reset();
        for (const item of sideWatch) {
            delete item.layoutExpansions;
            item.layoutExpansionGeneration = -1;
        }
        availableTypesReady = false;
        available = [];
        availableByName.clear();
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
        if (m.version !== availableVersion) return;
        const symbols = m.symbols || [];
        available.push(...symbols);
        for (const symbol of symbols) availableByName.set(symbol.name, symbol);
        if (available.length <= 1000 || available.length % 10000 < symbols.length) renderAvailable();
    },
    availableVariablesDone: function (m) {
        if (m.version && m.version !== availableVersion) return;
        if (Array.isArray(m.warnings)) variableWarnings = m.warnings;
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
        if (Array.isArray(m.warnings)) variableWarnings = m.warnings;
        availableTypesReady = true;
        renderAvailable();
        renderValues();
        renderWrites();
    },
    layoutExpansionResult: function (m) {
        layoutExpansionUi.receive(m);
    },
    compositeLayoutResult: function (m) {
        if (m.version !== availableVersion) return;
        availableLayoutPending.delete(m.name);
        const symbol = availableByName.get(m.name);
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
        latestPointer = Object.create(null);
        latestEnum = Object.create(null);
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
