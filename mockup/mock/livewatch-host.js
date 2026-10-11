/*
 * Mock extension host for the EmberProbe Live Watch webview.
 * Streams simulated samples while sampling is running and answers the
 * import/export/style commands of the real renderer.
 */
(function (root) {
    "use strict";

    var data = root.EmberProbeLiveWatchData;

    function createLiveWatchHost(iframe, options) {
        options = options || {};
        var notify = options.notify || function () {};
        var simulator = options.simulator || root.EmberProbeSidebarData.createSimulator();
        var symbols = root.EmberProbeSidebarData.SYMBOLS;
        var timer = null;
        var running = false;
        var frequencyHz = 30;
        var watchItems = data.watchList();
        var styles = Object.assign({}, data.seriesStyles);
        var stopped = false;
        var initialized = false;
        var archive = [];
        var archiveLimit = Math.min(20000, Math.max(1, options.archiveLimit || 20000));
        var archiveTruncated = false;
        var history = root.EmberProbeMockHistory ? new root.EmberProbeMockHistory.ChartHistoryStore() : null;
        var historyRevision = 0,
            historySignature = "",
            snapshotId = null,
            lastValues = 0,
            lastStatus = 0;
        function configureHistory() {
            if (!history) return;
            var signature = JSON.stringify(watchItems);
            if (signature !== historySignature) {
                var items = new Map();
                watchItems.forEach(function (item) {
                    if (!item.isComposite || !item.compositeLayout) return;
                    iframe.contentWindow
                        .collectLeaves(item.compositeLayout, item.name, Number(item.address))
                        .forEach(function (leaf) {
                            items.set(leaf.path, { name: leaf.path, address: leaf.address, type: leaf.type });
                        });
                });
                watchItems.forEach(function (item) {
                    if (!item.isComposite) items.set(item.name, item);
                });
                history.configure("mock", Array.from(items.values()));
                historySignature = signature;
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
                symbols: symbols.map(function (symbol) {
                    return {
                        name: symbol.name,
                        displayName: symbol.displayName,
                        typeName: symbol.typeName,
                        watchType: symbol.watchType,
                        isComposite: !!symbol.isComposite,
                        hasRuntimeLayout: false,
                        unsupportedReason: "",
                        hasDwarfWriteType: !!symbol.hasDwarfWriteType,
                        isBoolean: !!symbol.isBoolean
                    };
                })
            });
            send({ type: "variableTypesDone", version: data.VERSION });
        }

        function displayName(name) {
            var runtime = iframe.contentWindow && iframe.contentWindow.EmberProbeRuntime;
            var item = watchItems.find(function (entry) {
                return entry.name === name;
            }) || { name: name };
            return runtime ? runtime.variableDisplayName(item, symbols) : item.displayName || name;
        }
        function archiveInfo(openExport) {
            var names = Array.from(
                new Set(
                    archive.flatMap(function (row) {
                        return row.samples.map(function (sample) {
                            return sample.name;
                        });
                    })
                )
            );
            var status = {
                rows: archive.length,
                bytes: JSON.stringify(archive).length,
                variables: names,
                displayNames: Object.fromEntries(
                    names.map(function (name) {
                        return [name, displayName(name)];
                    })
                ),
                firstTimestampMs: archive.length ? archive[0].t : null,
                lastTimestampMs: archive.length ? archive[archive.length - 1].t : null,
                limitReached: archiveTruncated
            };
            return Object.assign({ type: "samplingArchiveInfo", openExport: !!openExport }, status);
        }

        function streamSamples() {
            if (!running) return;
            var t = Date.now();
            simulator.tick();
            var names = watchItems.map(function (item) {
                return item.name;
            });
            var samples = simulator.scalarSamples(names, t);
            if (history) {
                configureHistory();
                if (t - lastStatus >= 80) {
                    send({ type: "chartHistoryStatus", ...history.status("mock"), historyRevision: historyRevision });
                    lastStatus = t;
                }
                if (t - lastValues >= 50) {
                    send({ type: "chartValues", samples: samples, t: t });
                    lastValues = t;
                }
            } else send({ type: "liveSample", samples: samples, t: t });
            var composite = names
                .map(function (name) {
                    return simulator.compositeSample(name, t);
                })
                .filter(Boolean);
            if (composite.length) send({ type: "liveCompositeSample", samples: composite, t: t });
            var archivedSamples = samples.slice();
            function flatten(node, name) {
                if (
                    node.value !== undefined &&
                    !archivedSamples.some(function (sample) {
                        return sample.name === name;
                    })
                )
                    archivedSamples.push({ name: name, value: node.value, valueText: node.valueText, t: t });
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
            if (history) history.append("mock", archivedSamples, t);
            if (archivedSamples.length) archive.push({ t: t, samples: archivedSamples });
            if (archive.length > archiveLimit) {
                archive.splice(0, archive.length - archiveLimit);
                archiveTruncated = true;
            }
            var interval = Math.max(5, Math.round(1000 / frequencyHz));
            timer = setTimeout(streamSamples, interval);
        }

        function startSampling(items, hz) {
            if (Array.isArray(items)) watchItems = items;
            if (Number.isFinite(Number(hz)) && Number(hz) > 0) frequencyHz = Number(hz);
            running = true;
            if (timer) clearTimeout(timer);
            send({
                type: "liveStatus",
                running: true,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                key: "sb.sampling",
                actualHz: frequencyHz,
                frequencyHz: frequencyHz,
                effectiveIntervalMs: Math.round(1000 / frequencyHz),
                p95DurationMs: Math.round((1000 / frequencyHz) * 0.85),
                missedDeadlines: 0
            });
            streamSamples();
        }

        function stopSampling() {
            running = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            send({
                type: "liveStatus",
                running: false,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                key: "sb.stopped"
            });
        }

        function triggerDownload(csv) {
            try {
                var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                var url = URL.createObjectURL(blob);
                var anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "emberprobe-live-watch.csv";
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(function () {
                    URL.revokeObjectURL(url);
                }, 4000);
                return true;
            } catch (error) {
                return false;
            }
        }

        function copyText(text) {
            try {
                if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(String(text || ""));
            } catch (error) {
                /* clipboard is optional */
            }
        }

        function sendReady() {
            configureHistory();
            if (history)
                send({ type: "chartHistoryStatus", ...history.status("mock"), historyRevision: historyRevision });
            send({ type: "seriesStyles", styles: styles });
            send({ type: "watchList", items: watchItems, resetValues: true });
            sendVariableList();
            send({ type: "liveFrequency", frequencyHz: frequencyHz, intervalMs: Math.round(1000 / frequencyHz) });
            send({
                type: "liveStatus",
                running: false,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                key: "sb.stopped"
            });
            send(archiveInfo(false));
        }

        function handle(message) {
            switch (message.type) {
                case "chartViewport":
                case "chartFreeze":
                case "chartResume":
                case "chartExportInfo": {
                    if (!history || message.historyRevision !== historyRevision) break;
                    configureHistory();
                    try {
                        var result;
                        if (message.type === "chartViewport")
                            result = history.viewport(
                                "mock",
                                message.names,
                                message.range,
                                message.width,
                                message.snapshotId
                            );
                        else if (message.type === "chartFreeze") {
                            result = history.freeze("mock");
                            snapshotId = result.snapshotId;
                        } else if (message.type === "chartResume") {
                            history.resume("mock");
                            snapshotId = null;
                            result = {};
                        } else result = history.status("mock", message.snapshotId);
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
                case "start":
                    startSampling(message.items, message.frequencyHz);
                    break;
                case "stop":
                    stopSampling();
                    break;
                case "setFrequency":
                    if (Number.isFinite(Number(message.frequencyHz)) && Number(message.frequencyHz) > 0) {
                        frequencyHz = Number(message.frequencyHz);
                        send({
                            type: "liveFrequency",
                            frequencyHz: frequencyHz,
                            intervalMs: Math.round(1000 / frequencyHz)
                        });
                    }
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
                    var symbol = symbols.find(function (entry) {
                        return entry.name === message.name;
                    });
                    send({
                        type: "compositeLayoutResult",
                        name: message.name,
                        version: message.version,
                        layout: symbol && symbol.compositeLayout,
                        error: symbol && symbol.compositeLayout ? undefined : "未找到复合布局"
                    });
                    break;
                }
                case "saveWatch":
                    watchItems = message.items || watchItems;
                    break;
                case "setSeriesStyle":
                    if (message.name && message.style)
                        styles[message.name] = { color: message.style.color, line: message.style.line };
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
                    archive = [];
                    archiveTruncated = false;
                    historyRevision = message.historyRevision;
                    if (history) history.clear("mock");
                    snapshotId = null;
                    send({ type: "samplingHistoryCleared", historyRevision: message.historyRevision });
                    break;
                case "exportCsv": {
                    var csv = message.csv;
                    var names = Array.isArray(message.names) ? message.names : [];
                    if (typeof csv !== "string") {
                        if (history && message.backendHistory) {
                            var source = history._source("mock", message.source === "snapshot" ? snapshotId : null);
                            csv = root.EmberProbeMockCsv.buildCsv(
                                names.map(displayName),
                                names.map(function (name) {
                                    return source.series.has(name)
                                        ? Array.from(history.points(source.series.get(name)))
                                        : [];
                                }),
                                { from: message.fromMs, to: message.toMs }
                            );
                        } else {
                            var available = archiveInfo(false).variables;
                            names = Array.from(new Set(names)).filter(function (name) {
                                return available.indexOf(name) >= 0;
                            });
                            var buffers = names.map(function (name) {
                                return archive.flatMap(function (row) {
                                    return row.samples
                                        .filter(function (sample) {
                                            return sample.name === name;
                                        })
                                        .map(function (sample) {
                                            return { t: row.t, v: sample.value };
                                        });
                                });
                            });
                            csv = root.EmberProbeMockCsv.buildCsv(names.map(displayName), buffers, {
                                from: message.fromMs,
                                to: message.toMs
                            });
                        }
                    }
                    var rows = root.EmberProbeMockCsv.csvDataRowCount(csv);
                    var ok = rows > 0 && triggerDownload(csv);
                    if (!ok) send({ type: "liveError", key: "lw.noDataToExport" });
                    send({
                        type: "exportCsvResult",
                        ok: ok,
                        seriesCount: names.length || watchItems.length,
                        rowCount: rows
                    });
                    break;
                }
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

        return {
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
                root.removeEventListener("message", onMessage);
            }
        };
    }

    root.EmberProbeLiveWatchHost = { create: createLiveWatchHost };
})(typeof window !== "undefined" ? window : globalThis);
