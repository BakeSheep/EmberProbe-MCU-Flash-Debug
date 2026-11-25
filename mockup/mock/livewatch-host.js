/*
 * Mock extension host for the EmberProbe Live Watch webview.
 * Streams simulated samples while sampling is running and answers the
 * import/export/style commands of the real renderer.
 */
(function (root) {
    "use strict";

    var data = root.EmberProbeLiveWatchData;
    var sampling = root.EmberProbeMockSampling;

    function createLiveWatchHost(iframe, options) {
        options = options || {};
        var notify = options.notify || function () {};
        var simulator = options.simulator || root.EmberProbeSidebarData.createSimulator();
        var symbols = root.EmberProbeSidebarData.SYMBOLS;
        var timer = null;
        var running = false;
        var settings = options.settings || sampling.createSettings();
        var meter = sampling.meter();
        var archiveMeter = sampling.meter();
        var observed = meter.record(0, 0);
        var nextTick = 0;
        var adaptiveEffectiveKhz = null;
        var watchItems = options.watchItems || data.watchList();
        var styles = Object.assign({}, data.seriesStyles);
        var stopped = false;
        var initialized = false;
        var archive = options.archive || root.EmberProbeMockArchive.create(options.archiveMaxBytes);
        var panelScope = options.scope || "panel-1";
        var scope = panelScope;
        var lastCsv = null;
        var expandedOnly = true;
        var expansions = {};
        var curveVisibility = {};
        var history = options.history || new root.EmberProbeMockHistory.ChartHistoryStore();
        var historyRevision = 0,
            configuredWatchItems,
            lastValues = 0,
            lastStatus = 0;
        var runtimeSeries = new Map();
        function configureHistory(samples = []) {
            const runtime = iframe.contentWindow?.EmberProbeRuntime;
            let changed = configuredWatchItems !== watchItems;
            const composites = watchItems.filter((item) => item.isComposite);
            const ownSeries = (name) =>
                composites.some((item) => name.startsWith(item.name + ".") || name.startsWith(item.name + "["));
            if (changed) {
                for (const name of runtimeSeries.keys()) if (!ownSeries(name)) runtimeSeries.delete(name);
            }
            for (const { name, address, type } of samples) {
                if (!type || !ownSeries(name)) continue;
                const old = runtimeSeries.get(name);
                if (old?.type === type && old.address === address) continue;
                runtimeSeries.set(name, { name, address, type });
                changed = true;
            }
            if (changed) {
                var items = new Map(runtimeSeries);
                watchItems.forEach(function (item) {
                    if (!runtime || !item.isComposite || !item.compositeLayout) return;
                    runtime
                        .displayLayoutLeaves(item, item.compositeLayout, item.name, Number(item.address))
                        .forEach(function (leaf) {
                            items.set(leaf.path, { name: leaf.path, address: leaf.address, type: leaf.type });
                        });
                });
                watchItems.forEach(function (item) {
                    if (!item.isComposite) items.set(item.name, item);
                });
                history.configure(scope, Array.from(items.values()));
                configuredWatchItems = watchItems;
            }
        }

        function send(message) {
            if (stopped || !iframe.contentWindow) return;
            try {
                iframe.contentWindow.postMessage(message, "*");
            } catch (error) {
                /* ignore detached frames */
            }
        }

        function sendVariableList() {
            send({ type: "variablesListReset", version: data.VERSION, warnings: [] });
            send({ type: "variablesListChunk", version: data.VERSION, symbols: symbols });
            send({ type: "variablesListDone", version: data.VERSION, total: symbols.length, warnings: [] });
            send({
                type: "variableTypes",
                version: data.VERSION,
                symbols: root.EmberProbeSidebarData.variableTypes()
            });
            send({ type: "variableTypesDone", version: data.VERSION });
        }

        let backgroundRequest = 0,
            backgroundPending = false;
        const backgroundKey = "emberprobe.mock.chartBackgroundIcon.v1";
        const backgroundEnabledKey = "emberprobe.mock.chartBackgroundIcon.enabled.v1";
        var mockBackgroundEnabled = true;
        function backgroundEnabled() {
            try {
                return root.localStorage.getItem(backgroundEnabledKey) !== "0";
            } catch {
                return mockBackgroundEnabled;
            }
        }
        function backgroundState() {
            var enabled = backgroundEnabled();
            try {
                return {
                    icon: enabled
                        ? iframe.contentWindow.EmberProbeBackgroundIcon.validate(
                              JSON.parse(root.localStorage.getItem(backgroundKey))
                          )
                        : null,
                    enabled: enabled
                };
            } catch {
                return { icon: null, enabled: enabled };
            }
        }
        function sendBackground() {
            send(Object.assign({ type: "chartBackgroundIcon" }, backgroundState()));
        }
        function backgroundStorage(event) {
            if (!event.key || event.key === backgroundKey || event.key === backgroundEnabledKey) sendBackground();
        }
        // The extension opens a native file dialog; the mock uses a browser file input (or a test hook).
        function chooseBackgroundPng(done) {
            if (options.selectBackgroundPng) {
                options.selectBackgroundPng(done);
                return;
            }
            try {
                var input = root.document.createElement("input");
                input.type = "file";
                input.accept = "image/png";
                input.style.display = "none";
                input.addEventListener("change", function () {
                    var file = input.files && input.files[0];
                    input.remove();
                    if (!file) return;
                    var reader = new root.FileReader();
                    reader.onload = function () {
                        done(String(reader.result || "").replace(/^data:[^,]*,/, ""));
                    };
                    reader.readAsDataURL(file);
                });
                root.document.body.appendChild(input);
                input.click();
            } catch {
                /* file selection is optional in the page preview */
            }
        }
        function requestBackgroundImport(pngBase64) {
            backgroundPending = true;
            send({ type: "importChartBackgroundIcon", requestId: ++backgroundRequest, pngBase64 });
        }

        function displayName(name) {
            var runtime = iframe.contentWindow && iframe.contentWindow.EmberProbeRuntime;
            var item = watchItems.find(function (entry) {
                return entry.name === name;
            }) || { name: name };
            return runtime ? runtime.variableDisplayName(item, symbols) : item.displayName || name;
        }
        function archiveInfo(openExport) {
            const status = archive.status(scope);
            return {
                type: "samplingArchiveInfo",
                openExport: !!openExport,
                ...status,
                displayNames: Object.fromEntries(status.variables.map((name) => [name, displayName(name)]))
            };
        }

        // The sidebar owns the connection in the shell; isolated frames can run on their own.
        var phase = "stopped";
        function readItems() {
            return watchItems.filter(
                (item) =>
                    !expandedOnly ||
                    !item.runtimeLayout ||
                    !Array.isArray(expansions[item.name]) ||
                    expansions[item.name].includes("")
            );
        }
        function readPlan() {
            return (
                options.readPlan?.(phase) ||
                sampling.plan(settings, sampling.workload(readItems()), new Map(), phase === "sampling")
            );
        }
        function rateStatus(plan) {
            return {
                frequencyHz: settings.frequencyHz,
                effectiveIntervalMs: plan.graphMs,
                p95DurationMs: plan.graphCost,
                adapterSpeedKhz: plan.khz,
                unlimitedActive: plan.unlimited,
                ...(settings.unlimited && phase === "debug-sampling" ? { unlimitedSuppressedReason: "debug" } : {}),
                ...(settings.adaptive && phase === "sampling"
                    ? { adaptiveSpeed: { state: "tuned", effectiveKhz: plan.khz } }
                    : {})
            };
        }
        function samplingSpeedState() {
            var adaptiveActiveKhz = settings.adaptive ? adaptiveEffectiveKhz : null;
            var configuredKhz = settings.adaptive ? 0 : settings.manualKhz;
            return {
                type: "samplingSpeedConfig",
                adaptive: settings.adaptive,
                samplingAdapterSpeedKhz: configuredKhz,
                adapterSpeedKhz: 0,
                effectiveKhz: running ? (settings.adaptive ? adaptiveEffectiveKhz : configuredKhz) : null,
                adaptiveEffectiveKhz: adaptiveActiveKhz,
                manualSpeedKhz: settings.manualKhz,
                locked: running
            };
        }

        function sendPhaseStatus() {
            var status = root.EmberProbeSidebarData.samplingStatus(phase);
            if (status.running) {
                const plan = readPlan();
                if (settings.adaptive && phase === "sampling") adaptiveEffectiveKhz = plan.khz;
                Object.assign(status, observed, rateStatus(plan));
            }
            send(status);
            send(samplingSpeedState());
        }

        function setSampling(next) {
            phase = next;
            running = root.EmberProbeSidebarData.samplingStatus(next).running;
            if (timer) clearTimeout(timer);
            timer = null;
            meter.reset();
            archiveMeter.reset();
            observed = meter.record(0, 0);
            nextTick = Date.now();
            sendPhaseStatus();
            if (root.EmberProbeSidebarData.samplingActive(next)) streamSamples();
            else if (next === "debug-ready") sendSnapshot();
        }

        function debugSessionChanged(debugId) {
            const nextScope = debugId ? panelScope + ":" + debugId : panelScope;
            if (scope === nextScope) return;
            history.resume(scope);
            scope = nextScope;
            configuredWatchItems = undefined;
            lastValues = lastStatus = 0;
            configureHistory();
            historyRevision++;
            send({ type: "debugSessionChanged" });
            send({ type: "chartHistoryReady", historyRevision: historyRevision });
            postHistoryStatus();
        }
        function postHistoryStatus() {
            send({ type: "chartHistoryStatus", ...history.status(scope), historyRevision: historyRevision });
        }

        function sendSnapshot() {
            publishSamples(Date.now());
        }

        function streamSamples() {
            if (!running) return;
            var t = Date.now();
            simulator.tick();
            if (!publishSamples(t)) return;
            const { graphMs } = readPlan();
            nextTick = Math.max(nextTick + graphMs, t + 1);
            timer = setTimeout(streamSamples, Math.max(1, nextTick - Date.now()));
        }

        function publishSamples(t) {
            var names = readItems().map(function (item) {
                return item.name;
            });
            var samples = simulator.scalarSamples(names, t);
            var composite = readItems()
                .map((item) =>
                    sampling.compositeSample(simulator, item, t, expandedOnly ? expansions[item.name] : undefined)
                )
                .filter(Boolean);
            var archivedSamples = samples.slice();
            function flatten(node, name) {
                if (
                    node.value !== undefined &&
                    !archivedSamples.some(function (sample) {
                        return sample.name === name;
                    })
                )
                    archivedSamples.push({
                        name: name,
                        value: node.value,
                        valueText: node.valueText,
                        t: t,
                        type: node.type,
                        address: node.address
                    });
                (node.members || []).forEach(function (member) {
                    flatten(member, name + "." + member.name);
                });
                (node.elements || []).forEach(function (element) {
                    flatten(element, name + "[" + element.index + "]");
                });
            }
            composite.forEach(function (sample) {
                flatten(sample.tree, sample.name);
            });
            configureHistory(archivedSamples);
            const bytes = archive.append(scope, t, archivedSamples);
            if (bytes === false) {
                stopSampling();
                reportFullArchive();
                return false;
            }
            history.append(scope, archivedSamples, t);
            observed = meter.record(
                t,
                archivedSamples.reduce((size, sample) => size + (Number(sample.type?.slice(1)) || 32) / 8, 0)
            );
            const budget = archive.budget(archiveMeter.record(t, bytes).bytesPerSecond);
            if (t - lastStatus >= 80) {
                postHistoryStatus();
                lastStatus = t;
            }
            if (t - lastValues >= 50 || phase === "debug-ready") {
                const plan = readPlan();
                if (settings.adaptive && phase === "sampling") adaptiveEffectiveKhz = plan.khz;
                send({ type: "chartValues", samples, t, ...observed, ...rateStatus(plan), archive: budget });
                if (composite.length) send({ type: "liveCompositeSample", samples: composite, t, ...observed });
                lastValues = t;
            }
            return true;
        }

        function reportFullArchive() {
            send({ type: "liveError", message: options.archiveFullMessage?.() || "Sampling archive is full" });
        }
        function startSampling(items, hz) {
            if (Array.isArray(items)) watchItems = items;
            settings.frequencyHz = sampling.frequency(hz, settings.frequencyHz);
            updateSettings();
            if (archive.limited()) return reportFullArchive();
            if (options.requestSampling) options.requestSampling(true);
            else setSampling("sampling");
        }

        function stopSampling() {
            if (options.requestSampling) options.requestSampling(false);
            else setSampling("stopped");
        }

        function settingsChanged() {
            send({ type: "liveFrequency", frequencyHz: settings.frequencyHz, intervalMs: 1000 / settings.frequencyHz });
            send({ type: "liveUnlimited", enabled: settings.unlimited });
            sendPhaseStatus();
            if (timer) {
                clearTimeout(timer);
                const { graphMs } = readPlan();
                nextTick = Date.now() + graphMs;
                timer = setTimeout(streamSamples, graphMs);
            }
        }
        function updateSettings() {
            if (options.settingsChanged) options.settingsChanged();
            else settingsChanged();
        }

        function triggerDownload(csv, fileName) {
            try {
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = fileName;
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return true;
            } catch {
                return false;
            }
        }

        function copyText(text) {
            root.navigator?.clipboard?.writeText(String(text || ""))?.catch(() => {});
        }

        function exportCsv(message) {
            const exportScope = scope;
            const revision = historyRevision;
            const requested = String(message.fileName || "emberprobe-sampling.csv")
                .split(/[\\/]/)
                .at(-1);
            const save = (name) => {
                if (!name) return send({ type: "exportCsvResult", ok: false, cancelled: true });
                if (exportScope !== scope || revision !== historyRevision)
                    return send({ type: "exportCsvResult", ok: false, message: "History changed before export" });
                const fileName = name.toLowerCase().endsWith(".csv") ? name : name + ".csv";
                const available = archive.status(scope).variables;
                const names = (Array.isArray(message.names) ? [...new Set(message.names)] : available).filter((key) =>
                    available.includes(key)
                );
                send({ type: "exportCsvProgress", percent: 0 });
                const series = new Map(names.map((key) => [key, []]));
                for (const row of archive.rows(scope)) {
                    if (row.t < message.fromMs || row.t > message.toMs) continue;
                    for (const sample of row.samples)
                        series.get(sample.name)?.push({ t: row.t, v: sample.value, valueText: sample.valueText });
                }
                const buffers = Array.from(series.values());
                const csv = root.EmberProbeMockCsv.buildCsv(names.map(displayName), buffers, {
                    from: message.fromMs,
                    to: message.toMs
                });
                const rows = root.EmberProbeMockCsv.csvDataRowCount(csv);
                const ok = rows > 0 && triggerDownload(csv, fileName);
                if (ok) lastCsv = { fileName, csv };
                else send({ type: "liveError", key: "lw.noDataToExport" });
                send({
                    type: "exportCsvResult",
                    ok,
                    file: ok ? fileName : undefined,
                    seriesCount: names.length,
                    rowCount: rows
                });
            };
            if (options.selectCsvFile) options.selectCsvFile(requested, save);
            else save(requested);
        }
        function sendReady() {
            sendBackground();
            configureHistory();
            send({ type: "chartHistoryReady", historyRevision: historyRevision });
            send({ type: "chartHistoryStatus", ...history.status(scope), historyRevision: historyRevision });
            send({ type: "curveVisibility", hidden: curveVisibility });
            send({ type: "pointerSampling", expandedOnly: expandedOnly });
            send({ type: "seriesStyles", styles: styles });
            send({ type: "watchList", items: watchItems, resetValues: true });
            sendVariableList();
            settingsChanged();
            send(archiveInfo(false));
        }

        function handle(message) {
            switch (message.type) {
                case "chartViewport":
                case "chartFreeze":
                case "chartResume": {
                    if (message.historyRevision !== historyRevision) break;
                    configureHistory();
                    try {
                        var result;
                        if (message.type === "chartViewport")
                            result = history.viewport(
                                scope,
                                message.names,
                                message.range,
                                message.width,
                                message.snapshotId
                            );
                        else if (message.type === "chartFreeze") result = history.freeze(scope);
                        else {
                            history.resume(scope);
                            result = {};
                        }
                        send({
                            type: message.type + "Result",
                            ...result,
                            requestId: message.requestId,
                            historyRevision: historyRevision,
                            snapshotId: result.snapshotId || message.snapshotId
                        });
                    } catch (error) {
                        send({
                            type: message.type + "Result",
                            error: error.message,
                            requestId: message.requestId,
                            historyRevision: historyRevision
                        });
                    }
                    break;
                }
                case "ready":
                    initialized = true;
                    sendReady();
                    break;
                case "selectChartBackgroundIcon":
                    chooseBackgroundPng(function (pngBase64) {
                        if (pngBase64) requestBackgroundImport(pngBase64);
                    });
                    break;
                case "setChartBackgroundEnabled":
                    mockBackgroundEnabled = message.enabled === true;
                    try {
                        root.localStorage.setItem(backgroundEnabledKey, mockBackgroundEnabled ? "1" : "0");
                    } catch {
                        /* storage is optional */
                    }
                    sendBackground();
                    break;
                case "chartBackgroundIconImported": {
                    if (message.requestId !== backgroundRequest || !backgroundPending) break;
                    backgroundPending = false;
                    if (message.errorCode) break;
                    try {
                        const icon = iframe.contentWindow.EmberProbeBackgroundIcon.validate(message.icon);
                        root.localStorage.setItem(backgroundKey, JSON.stringify(icon));
                        root.dispatchEvent(new root.Event("emberprobe-background"));
                    } catch {
                        /* An invalid processed mask leaves the previous icon intact. */
                    }
                    break;
                }
                case "start":
                    startSampling(message.items, message.frequencyHz);
                    break;
                case "stop":
                    stopSampling();
                    break;
                case "setFrequency":
                    settings.frequencyHz = sampling.frequency(message.frequencyHz, settings.frequencyHz);
                    updateSettings();
                    break;
                case "setUnlimitedSampling":
                    if (typeof message.enabled === "boolean") settings.unlimited = message.enabled;
                    updateSettings();
                    break;
                case "setSamplingSpeed":
                    if (!running && typeof message.adaptive === "boolean") {
                        settings.adaptive = message.adaptive;
                        if (!settings.adaptive && Number.isInteger(message.speedKhz)) {
                            settings.manualKhz = Math.min(
                                20000,
                                Math.max(1000, Math.round(message.speedKhz / 1000) * 1000)
                            );
                        }
                    }
                    updateSettings();
                    break;
                case "importVariables":
                    sendVariableList();
                    break;
                case "resolveVariable": {
                    var symbol = symbols.filter(function (entry) {
                        return entry.name === message.name;
                    })[0];
                    if (symbol) send({ type: "addResolved", version: message.version, symbol: symbol });
                    else send({ type: "liveError", key: "live.varNotFound", params: { name: message.name } });
                    break;
                }
                case "resolveCompositeLayout": {
                    send(
                        Object.assign(
                            { type: "compositeLayoutResult", name: message.name, version: message.version },
                            root.EmberProbeSidebarData.layoutResult(message.name)
                        )
                    );
                    break;
                }
                case "saveWatch":
                    watchItems = message.items || watchItems;
                    if (phase === "debug-ready") sendSnapshot();
                    break;
                case "setPointerExpandedOnly":
                    expandedOnly = message.enabled === true;
                    send({ type: "pointerSampling", expandedOnly: expandedOnly });
                    break;
                case "saveCurveVisibility":
                    if (message.hidden && typeof message.hidden === "object" && !Array.isArray(message.hidden))
                        curveVisibility = message.hidden;
                    break;
                case "saveRuntimeExpansions":
                    expansions = message.expansions || {};
                    if (phase === "debug-ready") sendSnapshot();
                    break;
                case "setSeriesStyle":
                    if (message.name && message.style) {
                        var previous = styles[message.name];
                        styles[message.name] =
                            previous && ["color", "line"].includes(message.field)
                                ? { ...previous, [message.field]: message.style[message.field] }
                                : { color: message.style.color, line: message.style.line };
                    }
                    send({ type: "seriesStyles", styles: styles });
                    break;
                case "importSidebarWatch": {
                    var current = Array.isArray(message.items) ? message.items.slice() : watchItems.slice();
                    var sidebarItems = options.getSidebarWatch ? options.getSidebarWatch() : [];
                    var existing = new Set(
                        current.map(function (item) {
                            return item.name;
                        })
                    );
                    var added = 0;
                    sidebarItems.forEach(function (item) {
                        if (!existing.has(item.name)) {
                            current.push(item);
                            existing.add(item.name);
                            added += 1;
                        }
                    });
                    watchItems = current;
                    send({ type: "watchList", items: watchItems });
                    send({ type: "sidebarImportResult", added: added, sourceCount: sidebarItems.length });
                    break;
                }
                case "samplingArchiveInfo":
                    send(Object.assign(archiveInfo(message.openExport), { historyRevision: message.historyRevision }));
                    break;
                case "clearSamplingHistory":
                    archive.clear(scope);
                    historyRevision = message.historyRevision;
                    history.clear(scope);
                    send({ type: "samplingHistoryCleared", historyRevision: message.historyRevision });
                    postHistoryStatus();
                    break;
                case "exportCsv":
                    exportCsv(message);
                    break;
                case "revealCsvExport":
                    if (lastCsv) notify({ action: "csvReveal", ...lastCsv });
                    break;
                case "copyText":
                    copyText(message.text);
                    break;
                case "setLang":
                    notify({ action: "setLang", lang: message.lang, page: "livewatch" });
                    break;
                default:
                    break;
            }
        }

        function onMessage(event) {
            if (stopped || !iframe.contentWindow || event.source !== iframe.contentWindow) return;
            var payload = event.data;
            if (!payload || payload.__emberprobeMock !== true || !payload.message) return;
            handle(payload.message);
        }

        root.addEventListener("message", onMessage);
        root.addEventListener("storage", backgroundStorage);
        root.addEventListener("emberprobe-background", sendBackground);

        return {
            setSampling: setSampling,
            debugSessionChanged: debugSessionChanged,
            settingsChanged,
            readItems,
            watchItems: () => watchItems,
            importBackgroundPng: requestBackgroundImport,
            removeBackground() {
                ++backgroundRequest;
                backgroundPending = false;
                root.localStorage.removeItem(backgroundKey);
                root.dispatchEvent(new root.Event("emberprobe-background"));
            },
            send: send,
            sendReady: sendReady,
            stop: stopSampling,
            isRunning: function () {
                return running;
            },
            isInitialized: function () {
                return initialized;
            },
            destroy: function () {
                stopped = true;
                if (timer) clearTimeout(timer);
                history.remove(scope);
                root.removeEventListener("message", onMessage);
                root.removeEventListener("storage", backgroundStorage);
                root.removeEventListener("emberprobe-background", sendBackground);
            }
        };
    }

    root.EmberProbeLiveWatchHost = { create: createLiveWatchHost };
})(typeof window !== "undefined" ? window : globalThis);
