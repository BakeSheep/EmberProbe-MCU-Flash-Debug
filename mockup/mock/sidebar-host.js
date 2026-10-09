/*
 * Mock extension host for the EmberProbe sidebar webview.
 * Attaches to the generated sidebar iframe, answers its commands and pushes
 * simulated payloads (variables, samples, peripherals, RTOS tasks, logs).
 */
(function (root) {
    "use strict";

    var data = root.EmberProbeSidebarData;
    var output = root.EmberProbeMockOutput;

    function createSidebarHost(iframe, options) {
        options = options || {};
        var notify = options.notify || function () {};
        var simulator = options.simulator || data.createSimulator();
        var coordinator = options.coordinator || root.EmberProbeMockCoordinator.create({ simulator: simulator });
        var liveRunning = false;
        var liveTimer = null;
        var watchItems = data.sidebarWatchList();
        var watchNames = watchItems.map(function (item) {
            return item.name;
        });
        var writeItems = data.sidebarWriteList();
        var writeNames = writeItems.map(function (item) {
            return item.name;
        });
        var stopped = false;
        var initialized = false;
        var debugTimer = null;
        var targetState = "running";
        var stopEpoch = 1;
        var targetLine = 103;
        var lastMemory = data.memoryAnalysis();
        var tasks = new Map();
        var cpuState = "stopped";
        var cpuStartedAt = 0;
        var chipReadAt = Date.now() - 45000;
        var lastSamplingLog = null;
        var lastCpuLog = "";
        var lastSvd = { type: "svdStatus", state: "configured", path: data.SVD_PATH, key: "svd.configured" };

        function beginTask(name) {
            if (stopped || tasks.has(name)) return null;
            var task = { name: name, timers: new Set() };
            tasks.set(name, task);
            return task;
        }

        function later(task, callback, delay) {
            var timer = setTimeout(function () {
                task.timers.delete(timer);
                if (stopped || tasks.get(task.name) !== task) return;
                callback();
            }, delay);
            task.timers.add(timer);
            return timer;
        }

        function cancelTask(name) {
            var task = tasks.get(name);
            if (!task) return false;
            task.timers.forEach(clearTimeout);
            tasks.delete(name);
            return true;
        }

        function reject(cmd, type) {
            var operation = cmd === "mcu-vscode.download" ? "download" : cmd;
            send({
                type: type || "commandError",
                cmd: cmd,
                key: coordinator.blockedKey(operation),
                code: "PROBE_BUSY"
            });
            logStatus(coordinator.blockedKey(operation), null, "warn");
        }

        function emitOutput(panel, lines, settings) {
            if (stopped) return;
            notify(Object.assign({ action: "operationOutput", panel: panel, lines: lines }, settings));
        }

        function messageText(key, params) {
            return (output.messages[key] || key).replace(/\{(\w+)\}/g, function (_match, name) {
                return params && params[name] !== undefined ? params[name] : _match;
            });
        }

        function logStatus(key, params, cls, show) {
            emitOutput("output", [{ text: messageText(key, params), cls: cls || "info" }], {
                channel: "EmberProbe",
                show: !!show
            });
        }

        function send(message) {
            if (stopped || !iframe.contentWindow) return;
            if (message.type === "svdStatus") {
                if (
                    message.state !== lastSvd.state ||
                    JSON.stringify(message.params) !== JSON.stringify(lastSvd.params)
                )
                    logStatus(message.key, message.params);
                lastSvd = message;
            }
            try {
                iframe.contentWindow.postMessage(message, "*");
            } catch (error) {
                /* ignore detached frames */
            }
        }

        function sendVariableList() {
            var symbols = data.SYMBOLS;
            send({ type: "availableVariablesReset", version: data.VERSION, warnings: [] });
            send({ type: "availableVariablesChunk", version: data.VERSION, symbols: symbols });
            send({ type: "availableVariablesDone", version: data.VERSION, total: symbols.length, warnings: [] });
            send({
                type: "availableVariableTypes",
                version: data.VERSION,
                symbols: symbols.map(function (symbol) {
                    return {
                        name: symbol.name,
                        displayName: symbol.displayName,
                        typeName: symbol.typeName,
                        watchType: symbol.watchType,
                        isComposite: symbol.isComposite,
                        hasRuntimeLayout: !!symbol.hasRuntimeLayout,
                        unsupportedReason: symbol.unsupportedReason || "",
                        hasDwarfWriteType: !!symbol.hasDwarfWriteType,
                        isBoolean: !!symbol.isBoolean,
                        isConst: !!symbol.isConst
                    };
                })
            });
            send({ type: "availableTypesDone", version: data.VERSION });
        }

        function sendInitialState() {
            send({
                type: "backendStatus",
                backend: "openocd",
                state: "ready",
                key: "oc.readyVer",
                params: { version: "0.12.0" }
            });
            send({
                type: "skillStatus",
                state: "installed",
                busy: false,
                scopes: { workspace: { state: "installed" } }
            });
            sendVariableList();
            send({ type: "sidebarWatchList", items: watchItems, resetValues: true });
            send({ type: "sidebarWriteList", items: writeItems });
            send(lastMemory);
            send(lastSvd);
            send({ type: "chipInfo", info: currentChipInfo() });
            send({
                type: "chipInfoStatus",
                state: tasks.has("chipInfo") ? "reading" : "ready",
                key: tasks.has("chipInfo") ? "chip.reading" : "chip.done"
            });
            sendDebugStatus();
            syncState();
            var task = beginTask("initialize");
            if (task)
                later(
                    task,
                    function () {
                        tasks.delete(task.name);
                        if (!coordinator.snapshot().operation) send({ type: "initSuccess" });
                    },
                    480
                );
        }

        function setDebugPending(busy) {
            send({ type: "mockDebugPending", busy: busy });
            notify({ action: "debugPending", busy: busy });
        }

        function startDebug(restart) {
            if (stopped || debugTimer !== null) return;
            if (restart && ["paused", "running"].includes(coordinator.snapshot().debug)) coordinator.stopDebug();
            if (!coordinator.acquire("debugStart")) return reject("mcu-vscode.debug");
            var task = beginTask("debugStart");
            emitOutput("debug-console", output.debug.start, { clear: true, show: true });
            output.debug.steps.forEach(function (step) {
                later(
                    task,
                    function () {
                        emitOutput("debug-console", step.lines);
                    },
                    step.at
                );
            });
            debugTimer = later(
                task,
                function () {
                    debugTimer = null;
                    tasks.delete(task.name);
                    coordinator.completeDebug();
                    setDebugPending(false);
                    send({ type: "commandSuccess", cmd: "mcu-vscode.debug" });
                    notify({ action: "debugStart" });
                },
                2200
            );
            setDebugPending(true);
            send({ type: "openocdProgress", stage: "debug", key: "sb.executing", level: "info" });
        }

        function cancelDebugStart() {
            if (debugTimer === null) return false;
            cancelTask("debugStart");
            debugTimer = null;
            coordinator.release("debugStart");
            setDebugPending(false);
            send({ type: "openocdProgress", stage: "debug", key: "sb.stopped", level: "info" });
            emitOutput("debug-console", [{ text: "Debug session cancelled.", cls: "warn" }]);
            return true;
        }

        function stopSampling() {
            if (!stopped) coordinator.setIntent("sidebar", false);
        }

        function startSampling() {
            if (stopped) return;
            if (!coordinator.setIntent("sidebar", true)) return reject("liveToggle", "liveError");
            emitOutput("output", [], { channel: "EmberProbe", show: true });
        }

        function sendSamples() {
            if (!coordinator.liveStatus("sidebar", 10).canRead) return;
            coordinator.tick();
            var t = Date.now();
            var names = Array.from(new Set(watchNames.concat(writeNames)));
            send({ type: "liveSample", samples: simulator.scalarSamples(names, t), t: t });
            var composite = watchNames
                .map(function (name) {
                    return simulator.compositeSample(name, t);
                })
                .filter(Boolean);
            if (composite.length) send({ type: "liveCompositeSample", samples: composite, t: t });
        }

        function currentChipInfo() {
            var info = data.chipInfo().info;
            info.readAt = chipReadAt;
            info.targetState = targetState;
            info.haltReason =
                targetState === "halted"
                    ? coordinator.snapshot().debug === "paused"
                        ? "断点命中 · main.c:" + targetLine
                        : "用户暂停"
                    : "";
            if (targetState !== "halted") {
                info.pc = "";
                info.sp = "";
                info.lr = "";
            }
            return info;
        }

        function writeChipDiagnostics(info) {
            var parsed = [
                [messageText("diag.kvCore"), info.core],
                [messageText("diag.kvCoreRev"), info.coreRevision],
                ["Device ID", info.deviceId],
                ["Revision ID", info.revId],
                [messageText("diag.kvFlash"), info.flashSize],
                ["UID", info.uid],
                [messageText("diag.kvState"), info.targetState]
            ]
                .map(function (pair) {
                    return pair.join("=");
                })
                .join("，");
            var lines = [
                messageText("diag.title"),
                messageText("diag.time", { time: new Date(chipReadAt).toLocaleString() }),
                messageText("diag.target", { target: output.connection.target }),
                messageText("diag.timings", { config: 0, preflight: 0, read: 700, save: 0, total: 700 }),
                messageText("diag.parsed", { content: parsed }),
                "",
                messageText("diag.commands")
            ].concat(
                output.chipCommands.map(function (command) {
                    return "  -c " + command;
                })
            );
            lines.push("", messageText("diag.rawOutput"));
            var raw = output.chipRaw.concat([
                "EP_KV name stm32f4x.cpu",
                "EP_KV state " + info.targetState,
                "EP_KV endian little",
                "EP_KV transport swd"
            ]);
            if (info.targetState === "halted")
                raw.push("pc (/32): " + info.pc, "sp (/32): " + info.sp, "lr (/32): " + info.lr);
            emitOutput(
                "output",
                lines
                    .concat(
                        raw.map(function (line) {
                            return "  " + line;
                        })
                    )
                    .map(function (text) {
                        return { text: text };
                    }),
                { channel: output.chipChannel, clear: true }
            );
        }

        function sendDebugStatus() {
            var debug = coordinator.snapshot().debug;
            var paused = debug === "paused";
            send(data.rtosDebugStatus(debug === "starting" ? "none" : debug, stopEpoch));
            send({
                type: "peripheralDebugStatus",
                state: debug,
                epoch: stopEpoch,
                canRead: paused,
                canWrite: paused
            });
        }

        function setTargetState(next, settings) {
            if (stopped) return false;
            settings = settings || {};
            if (!coordinator.setTarget(next, settings)) return false;
            if (settings.notify !== false)
                notify({ action: "targetState", state: next, debug: coordinator.snapshot().debug });
            return true;
        }

        function sendCpuStatus() {
            var ownsProbe = coordinator.snapshot().operation === "cpuLoad";
            var measured = ownsProbe && cpuState === "running";
            var workload = measured ? 37 + Math.sin((Date.now() - cpuStartedAt) / 3000) * 6 : null;
            send({
                type: "cpuLoad",
                state: ownsProbe ? cpuState : "stopped",
                intentEnabled: ownsProbe,
                ownsProbe: ownsProbe,
                canStart: coordinator.allowed("cpuLoad"),
                canStop: ownsProbe,
                coveragePercent: measured ? 96.5 : null,
                workloadPercent: workload,
                blockedReason:
                    !ownsProbe && !coordinator.allowed("cpuLoad")
                        ? { i18nKey: coordinator.blockedKey("cpuLoad") }
                        : null
            });
            var signature = ownsProbe ? cpuState + (measured ? ":" + workload.toFixed(1) : "") : "stopped";
            if (signature !== lastCpuLog && (ownsProbe || (lastCpuLog && lastCpuLog !== "stopped"))) {
                logStatus("cpu.state." + (ownsProbe ? cpuState : "stopped"));
                if (measured)
                    emitOutput(
                        "output",
                        [{ text: "CPU负载: " + workload.toFixed(1) + "%; 计算覆盖率: 96.5%", cls: "info" }],
                        { channel: "EmberProbe" }
                    );
            }
            lastCpuLog = signature;
        }

        function syncState() {
            if (stopped) return;
            var state = coordinator.snapshot();
            targetState = state.target;
            stopEpoch = state.epoch;
            targetLine = state.line;
            liveRunning = coordinator.intent("sidebar");
            send({ type: "chipInfo", info: currentChipInfo() });
            sendDebugStatus();
            var status = coordinator.liveStatus("sidebar", 10);
            send(status);
            var samplingSignature = [status.intentEnabled, status.canRead, status.source, status.key].join(":");
            if (samplingSignature !== lastSamplingLog && (lastSamplingLog !== null || status.intentEnabled)) {
                if (
                    status.canRead &&
                    lastSamplingLog &&
                    lastSamplingLog.startsWith("false:") &&
                    coordinator.snapshot().debug === "none" &&
                    !coordinator.intent("livewatch")
                ) {
                    logStatus("lw.connecting");
                    logStatus("lw.connected");
                }
                emitOutput("output", [{ text: "[侧栏] " + messageText(status.key), cls: "info" }], {
                    channel: "EmberProbe"
                });
            }
            lastSamplingLog = samplingSignature;
            if (liveTimer && !status.canRead) {
                clearInterval(liveTimer);
                liveTimer = null;
            }
            if (!liveTimer && status.canRead) {
                sendSamples();
                liveTimer = setInterval(sendSamples, 100);
            }
            sendCpuStatus();
            var availability = {
                download: coordinator.allowed("download"),
                debug: coordinator.allowed("debugStart"),
                chipRead: !tasks.has("chipInfo"),
                chipControl: !tasks.has("chipInfo") && coordinator.allowed("chipInfo"),
                driver: coordinator.allowed("driver"),
                backend: false,
                live: liveRunning || !state.operation
            };
            send({
                type: "mockOperationStatus",
                operation: state.operation,
                epoch: state.epoch,
                availability: availability
            });
            notify({ action: "operationStatus", state: state, availability: availability });
        }

        var unsubscribe = coordinator.subscribe(syncState);

        function startCpu() {
            if (!coordinator.allowed("cpuLoad")) {
                sendCpuStatus();
                return reject("cpuLoadStart");
            }
            cpuState = "checking";
            cpuStartedAt = Date.now();
            coordinator.acquire("cpuLoad");
            emitOutput("output", [], { channel: "EmberProbe", show: true });
            var task = beginTask("cpuLoad");
            later(
                task,
                function () {
                    cpuState = "collecting";
                    sendCpuStatus();
                },
                300
            );
            function measure() {
                cpuState = "running";
                sendCpuStatus();
                later(task, measure, 1000);
            }
            later(task, measure, 10300);
        }

        function stopCpu() {
            cancelTask("cpuLoad");
            cpuState = "stopped";
            coordinator.release("cpuLoad");
        }

        function simulateDownload(cmd) {
            if (!coordinator.acquire("download")) return reject(cmd);
            var task = beginTask("download");
            emitOutput("terminal", output.download.header, { name: output.terminalName, show: true });
            send({ type: "openocdProgress", cmd: cmd, stage: "download", key: "sb.executing", level: "info" });
            output.download.steps.forEach(function (step) {
                later(
                    task,
                    function () {
                        emitOutput("terminal", [step.line]);
                        send(Object.assign({ type: "openocdProgress", cmd: cmd }, step.event));
                        if (step.event.stage === "target") coordinator.setOperationTarget("download", "halted");
                        if (step.event.stage === "reset_run") coordinator.setOperationTarget("download", "running");
                    },
                    step.at
                );
            });
            later(
                task,
                function () {
                    tasks.delete(task.name);
                    emitOutput("terminal", output.download.summary);
                    coordinator.completeDownload();
                    send({
                        type: "openocdProgress",
                        cmd: cmd,
                        stage: "done",
                        level: "success",
                        key: "run.downloadSuccess"
                    });
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "toast", text: "烧录完成：EmberProbeDemo.elf (917504 字节)" });
                },
                4800
            );
        }

        function simulateSvdDownload(cmd) {
            var task = beginTask("svdDownload");
            if (!task) return;
            send({ type: "svdStatus", state: "downloading", key: "svd.downloadingPercent", params: { percent: 0 } });
            var percents = [8, 26, 51, 77, 94];
            percents.forEach(function (percent, index) {
                later(
                    task,
                    function () {
                        send({
                            type: "svdStatus",
                            state: "downloading",
                            key: "svd.downloadingPercent",
                            params: { percent: percent },
                            path: data.SVD_PATH
                        });
                    },
                    300 + index * 320
                );
            });
            later(
                task,
                function () {
                    send({ type: "svdStatus", state: "validating", key: "svd.validating", path: data.SVD_PATH });
                },
                300 + percents.length * 320
            );
            later(
                task,
                function () {
                    tasks.delete(task.name);
                    send({ type: "svdStatus", state: "configured", key: "svd.configured", path: data.SVD_PATH });
                    send({ type: "commandSuccess", cmd: cmd });
                    send({
                        type: "peripheralCatalog",
                        svd: { path: data.SVD_PATH, sha256: "mock-svd-sha256" },
                        peripherals: data.peripheralCatalog().peripherals
                    });
                },
                300 + (percents.length + 1) * 320
            );
        }

        function simulateSkillToggle(cmd) {
            var task = beginTask("skills");
            if (!task) return;
            send({
                type: "skillStatus",
                state: "installed",
                busy: true,
                scopes: { workspace: { state: "installed" } }
            });
            later(
                task,
                function () {
                    tasks.delete(task.name);
                    send({
                        type: "skillStatus",
                        state: "installed",
                        busy: false,
                        scopes: { workspace: { state: "installed" } }
                    });
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "toast", text: "Agent Skill 已安装到当前工作区" });
                },
                900
            );
        }

        function handleCommand(message) {
            switch (message.type) {
                case "initCheck":
                    initialized = true;
                    sendInitialState();
                    break;
                case "liveToggle":
                    if (liveRunning) stopSampling();
                    else startSampling();
                    break;
                case "writeVariable": {
                    var name = message.name;
                    var seq = message.seq;
                    var value = Number(message.value);
                    if (
                        !coordinator.liveStatus("sidebar", 10).canWrite ||
                        (message.mockEpoch !== undefined && message.mockEpoch !== stopEpoch)
                    ) {
                        send({ type: "writeResult", ok: false, name: name, seq: seq, key: "sb.writeNeedSampling" });
                        break;
                    }
                    if (!Number.isFinite(value)) {
                        send({ type: "writeResult", ok: false, name: name, seq: seq, message: "无效的写入值" });
                        break;
                    }
                    if (writeNames.indexOf(name) >= 0 && simulator.write(name, value)) {
                        send({ type: "writeResult", ok: true, name: name, value: value, valueText: null, seq: seq });
                        sendSamples();
                        notify({ action: "toast", text: "已写入 " + name + " = " + value });
                    } else {
                        send({ type: "writeResult", ok: false, name: name, seq: seq, key: "sb.writeUnsupported" });
                    }
                    break;
                }
                case "executeCommand":
                    handleExecute(message.cmd);
                    break;
                case "readChipInfo": {
                    // Refresh the shared target snapshot without claiming another probe session.
                    var readTask = beginTask("chipInfo");
                    if (!readTask) break;
                    send({ type: "chipInfoStatus", state: "reading", key: "chip.reading" });
                    logStatus("chip.reading");
                    syncState();
                    later(
                        readTask,
                        function () {
                            tasks.delete(readTask.name);
                            chipReadAt = Date.now();
                            var info = currentChipInfo();
                            send({ type: "chipInfo", info: info });
                            send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
                            writeChipDiagnostics(info);
                            logStatus("chip.done");
                            syncState();
                            notify({ action: "toast", text: "芯片信息读取完成：STM32F407ZGTx" });
                        },
                        700
                    );
                    break;
                }
                case "chipControl":
                    if (tasks.has("chipInfo") || !coordinator.allowed("chipInfo")) {
                        send({ type: "chipInfoStatus", state: "error", key: coordinator.blockedKey("chipInfo") });
                        break;
                    }
                    if (["pause", "continue", "reset"].indexOf(message.action) >= 0) {
                        setTargetState(message.action === "pause" ? "halted" : "running", {
                            reset: message.action === "reset"
                        });
                        send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
                    }
                    break;
                case "cpuLoadStart":
                    startCpu();
                    break;
                case "cpuLoadStop":
                    stopCpu();
                    break;
                case "memoryRefresh": {
                    lastMemory = data.memoryAnalysis();
                    lastMemory.requestId = Date.now();
                    send(lastMemory);
                    break;
                }
                case "memorySelectSource":
                    send({ type: "commandSuccess", cmd: "memorySelectSource" });
                    notify({ action: "toast", text: "内存分析来源：EmberProbeDemo.map" });
                    break;
                case "peripheralCatalogRequest":
                    send({
                        type: "peripheralCatalog",
                        svd: { path: data.SVD_PATH, sha256: "mock-svd-sha256" },
                        peripherals: data.peripheralCatalog().peripherals
                    });
                    break;
                case "peripheralRegistersRequest":
                    send(data.peripheralRegisters(message.name));
                    break;
                case "peripheralReadRequest": {
                    if (
                        coordinator.snapshot().debug !== "paused" ||
                        (message.mockEpoch !== undefined && message.mockEpoch !== stopEpoch)
                    ) {
                        send({ type: "peripheralError", operation: message.type, message: "暂停调试器后才能读取外设" });
                        break;
                    }
                    var result = data.peripheralReadResult(message.targets, false);
                    result.session.epoch = stopEpoch;
                    send(result);
                    break;
                }
                case "peripheralWriteRequest": {
                    if (
                        coordinator.snapshot().debug !== "paused" ||
                        (message.mockEpoch !== undefined && message.mockEpoch !== stopEpoch)
                    ) {
                        send({ type: "peripheralError", operation: message.type, message: "暂停调试器后才能写入外设" });
                        break;
                    }
                    var writeResult = data.peripheralWriteResult(message.target, message.value);
                    send(writeResult);
                    if (writeResult.type === "peripheralError") break;
                    var writeEpoch = stopEpoch;
                    var writeTask = beginTask("peripheral:" + message.target);
                    if (!writeTask) break;
                    later(
                        writeTask,
                        function () {
                            tasks.delete(writeTask.name);
                            if (coordinator.snapshot().debug !== "paused" || stopEpoch !== writeEpoch) return;
                            var base = String(message.target || "")
                                .split(".")
                                .slice(0, 2)
                                .join(".");
                            var result = data.peripheralReadResult([base], false);
                            result.session.epoch = stopEpoch;
                            send(result);
                        },
                        60
                    );
                    break;
                }
                case "rtosRefresh":
                    if (
                        coordinator.snapshot().debug === "paused" &&
                        (message.mockEpoch === undefined || message.mockEpoch === stopEpoch)
                    )
                        send(data.rtosSnapshot(stopEpoch));
                    else
                        send(
                            Object.assign(data.rtosDebugStatus(coordinator.snapshot().debug, stopEpoch), {
                                type: "rtosError",
                                message: "暂停调试器后才能刷新 RTOS 任务"
                            })
                        );
                    break;
                case "debugSelectSession":
                    if (
                        message.sessionId === data.rtosDebugStatus("paused", stopEpoch).sessionId &&
                        ["paused", "running"].includes(coordinator.snapshot().debug)
                    )
                        sendDebugStatus();
                    else reject("debugSelectSession");
                    break;
                case "resolveCompositeLayout": {
                    var symbol = data.SYMBOLS.filter(function (item) {
                        return item.name === message.name;
                    })[0];
                    if (symbol && symbol.isComposite)
                        send({
                            type: "compositeLayoutResult",
                            name: message.name,
                            version: message.version,
                            layout: symbol.compositeLayout
                        });
                    else
                        send({
                            type: "compositeLayoutResult",
                            name: message.name,
                            version: message.version,
                            error: "未找到复合布局"
                        });
                    break;
                }
                case "refreshVariables":
                    sendVariableList();
                    notify({ action: "toast", text: "已从 ELF 重新读取 " + data.SYMBOLS.length + " 个变量" });
                    break;
                case "saveSidebarWatch": {
                    watchItems = message.items || [];
                    watchNames = (message.items || []).map(function (item) {
                        return item.name;
                    });
                    sendSamples();
                    break;
                }
                case "saveSidebarWrite":
                    writeItems = message.items || [];
                    writeNames = writeItems.map(function (item) {
                        return item.name;
                    });
                    sendSamples();
                    break;
                case "setLang":
                    notify({ action: "setLang", lang: message.lang, page: "sidebar" });
                    break;
                case "openGitHub":
                    notify({ action: "toast", text: "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug" });
                    break;
                case "copyText":
                    copyText(message.text);
                    break;
                case "openocdAction":
                case "backendAction":
                    send({
                        type: "backendStatus",
                        backend: "openocd",
                        state: "ready",
                        key: "oc.readyVer",
                        params: { version: "0.12.0" }
                    });
                    send({ type: "commandSuccess", cmd: "openocdAction" });
                    break;
                case "selectBackend":
                    send({ type: "commandError", cmd: "selectBackend", error: "当前演示工程使用 OpenOCD 后端" });
                    break;
                case "selectProbeDriver": {
                    if (!coordinator.acquire("driver")) return reject("selectProbeDriver");
                    var driverTask = beginTask("driver");
                    send({ type: "probeDriverChoice", driver: message.driver });
                    send({ type: "probeDriverSwitch", busy: true });
                    later(
                        driverTask,
                        function () {
                            tasks.delete(driverTask.name);
                            send({ type: "probeDriverSwitch", busy: false });
                            coordinator.release("driver");
                            send({ type: "probeDriverStatus", state: "ready" });
                            send({ type: "commandSuccess", cmd: "selectProbeDriver" });
                        },
                        900
                    );
                    break;
                }
                case "cancelSvdDownload":
                    if (cancelTask("svdDownload")) logStatus("svd.cancelled");
                    send({ type: "svdStatus", state: "configured", key: "svd.configured", path: data.SVD_PATH });
                    break;
                default:
                    break;
            }
        }

        function handleExecute(cmd) {
            switch (cmd) {
                case "mcu-vscode.download":
                    simulateDownload(cmd);
                    break;
                case "mcu-vscode.debug":
                    startDebug();
                    break;
                case "mcu-vscode.openLiveWatch":
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "openLiveWatch" });
                    break;
                case "mcu-vscode.manageAgentSkills":
                    simulateSkillToggle(cmd);
                    break;
                case "mcu-vscode.downloadOfficialSvd":
                    simulateSvdDownload(cmd);
                    break;
                case "mcu-vscode.selectExistingSvd":
                    cancelTask("svdDownload");
                    send({ type: "svdStatus", state: "configured", key: "svd.configured", path: data.SVD_PATH });
                    send({ type: "commandSuccess", cmd: cmd });
                    send({
                        type: "peripheralCatalog",
                        svd: { path: data.SVD_PATH, sha256: "mock-svd-sha256" },
                        peripherals: data.peripheralCatalog().peripherals
                    });
                    break;
                case "mcu-vscode.autoDetect":
                    notify({
                        action: "toast",
                        text: "自动检测完成：" + output.connection.probeName + " · STM32F407ZGTx"
                    });
                    send({ type: "commandSuccess", cmd: cmd });
                    break;
                default:
                    send({ type: "commandError", cmd: cmd, error: "网页演示使用固定工程，此命令暂不支持：" + cmd });
                    break;
            }
        }

        function copyText(text) {
            try {
                if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(String(text || ""));
            } catch (error) {
                /* clipboard is optional */
            }
        }

        function onMessage(event) {
            if (stopped || !iframe.contentWindow || event.source !== iframe.contentWindow) return;
            var payload = event.data;
            if (!payload || payload.__emberprobeMock !== true || !payload.message) return;
            handleCommand(payload.message);
        }

        root.addEventListener("message", onMessage);

        return {
            send: send,
            sendInitialState: sendInitialState,
            setTargetState: setTargetState,
            startDebug: startDebug,
            stopDebug: function () {
                if (stopped) return;
                cancelDebugStart();
                coordinator.stopDebug();
            },
            download: function () {
                if (!stopped) simulateDownload("mcu-vscode.download");
            },
            executeCommand: function (cmd) {
                if (!stopped) handleExecute(cmd);
            },
            cancelDebugStart: cancelDebugStart,
            isDebugStarting: function () {
                return debugTimer !== null;
            },
            startSampling: startSampling,
            stopSampling: stopSampling,
            getWatchList: function () {
                return watchItems.slice();
            },
            isLiveRunning: function () {
                return liveRunning;
            },
            isInitialized: function () {
                return initialized;
            },
            destroy: function () {
                if (stopped) return;
                cancelDebugStart();
                stopped = true;
                unsubscribe();
                tasks.forEach(function (_task, name) {
                    cancelTask(name);
                });
                if (liveTimer) clearInterval(liveTimer);
                coordinator.stopDebug();
                coordinator.setIntent("sidebar", false);
                ["download", "driver", "cpuLoad"].forEach(coordinator.release);
                root.removeEventListener("message", onMessage);
            }
        };
    }

    root.EmberProbeSidebarHost = { create: createSidebarHost };
})(typeof window !== "undefined" ? window : globalThis);
