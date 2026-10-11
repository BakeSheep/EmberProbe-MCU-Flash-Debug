/*
 * Mock extension host for the EmberProbe sidebar webview.
 * Attaches to the generated sidebar iframe, answers its commands and pushes
 * simulated payloads (variables, samples, peripherals, RTOS tasks, logs).
 */
(function (root) {
    "use strict";

    var data = root.EmberProbeSidebarData;

    function createSidebarHost(iframe, options) {
        options = options || {};
        var notify = options.notify || function () {};
        var simulator = options.simulator || data.createSimulator();
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
        var targetState = "halted";
        var stopEpoch = 1;
        var targetLine = 103;
        var lastMemory = data.memoryAnalysis();

        function send(message) {
            if (stopped || !iframe.contentWindow) return;
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
            send({ type: "openocdStatus", state: "ready", key: "oc.readyVer", params: { version: "0.12.0" } });
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
            send({ type: "svdStatus", state: "configured", path: data.SVD_PATH, key: "svd.configured" });
            send({ type: "chipInfo", info: currentChipInfo() });
            send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
            sendDebugStatus();
            send({
                type: "liveStatus",
                running: false,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                key: "sb.stopped"
            });
            sendSamples();
            setTimeout(function () {
                if (debugTimer === null) send({ type: "initSuccess" });
            }, 480);
        }

        function setDebugPending(busy) {
            send({ type: "mockDebugPending", busy: busy });
            notify({ action: "debugPending", busy: busy });
        }

        function startDebug() {
            if (stopped || debugTimer !== null) return;
            debugTimer = setTimeout(function () {
                debugTimer = null;
                if (stopped) return;
                setDebugPending(false);
                send({ type: "commandSuccess", cmd: "mcu-vscode.debug" });
                notify({ action: "debugStart" });
            }, 2200);
            setDebugPending(true);
            send({ type: "openocdProgress", stage: "debug", key: "sb.executing", level: "info" });
        }

        function cancelDebugStart() {
            if (debugTimer === null) return false;
            clearTimeout(debugTimer);
            debugTimer = null;
            setDebugPending(false);
            send({ type: "openocdProgress", stage: "debug", key: "sb.stopped", level: "info" });
            return true;
        }

        function stopSampling(key) {
            liveRunning = false;
            if (liveTimer) {
                clearInterval(liveTimer);
                liveTimer = null;
            }
            send({
                type: "liveStatus",
                running: false,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                key: key || "sb.stopped"
            });
        }

        function startSampling() {
            liveRunning = true;
            send({
                type: "liveStatus",
                running: true,
                canRead: true,
                canWrite: true,
                source: "dap",
                snapshotReady: true,
                key: "sb.sampling",
                actualHz: 10
            });
            if (liveTimer) clearInterval(liveTimer);
            sendSamples();
            liveTimer = setInterval(function () {
                simulator.tick();
                sendSamples();
            }, 100);
        }

        function sendSamples() {
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
            info.targetState = targetState;
            info.haltReason = targetState === "halted" ? "断点命中 · main.c:" + targetLine : "";
            if (targetState !== "halted") {
                info.pc = "";
                info.sp = "";
                info.lr = "";
            }
            return info;
        }

        function sendDebugStatus() {
            send(data.rtosDebugStatus(targetState === "halted" ? "paused" : "running", stopEpoch));
            send({
                type: "peripheralDebugStatus",
                state: targetState === "halted" ? "paused" : "running",
                epoch: stopEpoch,
                canRead: targetState === "halted",
                canWrite: targetState === "halted"
            });
        }

        function setTargetState(next, settings) {
            settings = settings || {};
            targetState = next;
            if (next === "halted") stopEpoch += 1;
            if (Number.isInteger(settings.line)) targetLine = settings.line;
            send({ type: "chipInfo", info: currentChipInfo() });
            send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
            sendDebugStatus();
            if (settings.notify !== false) notify({ action: "targetState", state: next });
        }

        function simulateDownload(cmd) {
            var steps = [
                { level: "info", message: "正在解析 ELF：build/Debug/EmberProbeDemo.elf" },
                { level: "info", message: "连接探针 J-Link V11 (SWD 4000 kHz)…" },
                { level: "info", message: "擦除扇区 0-7 (0x08000000 - 0x080FFFFF)…" },
                { level: "info", message: "写入 917504 字节 (87.5%)…" },
                { level: "success", message: "校验通过：CRC32 0x8F3C21A7" },
                { level: "success", message: "烧录完成，耗时 4.8s" }
            ];
            steps.forEach(function (step, index) {
                setTimeout(
                    function () {
                        send({ type: "openocdProgress", cmd: cmd, level: step.level, message: step.message });
                        if (index === steps.length - 1) {
                            send({ type: "commandSuccess", cmd: cmd });
                            notify({ action: "toast", text: "烧录完成：EmberProbeDemo.elf (917504 字节)" });
                        }
                    },
                    350 + index * 420
                );
            });
        }

        function simulateSvdDownload(cmd) {
            var percents = [8, 26, 51, 77, 94];
            percents.forEach(function (percent, index) {
                setTimeout(
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
            setTimeout(
                function () {
                    send({ type: "svdStatus", state: "validating", key: "svd.validating", path: data.SVD_PATH });
                },
                300 + percents.length * 320
            );
            setTimeout(
                function () {
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
            send({
                type: "skillStatus",
                state: "installed",
                busy: true,
                scopes: { workspace: { state: "installed" } }
            });
            setTimeout(function () {
                send({
                    type: "skillStatus",
                    state: "installed",
                    busy: false,
                    scopes: { workspace: { state: "installed" } }
                });
                send({ type: "commandSuccess", cmd: cmd });
                notify({ action: "toast", text: "Agent Skill 已安装到当前工作区" });
            }, 900);
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
                case "readChipInfo":
                    send({ type: "chipInfoStatus", state: "reading", key: "chip.reading" });
                    setTimeout(function () {
                        send({ type: "chipInfo", info: currentChipInfo() });
                        send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
                        notify({ action: "toast", text: "芯片信息读取完成：STM32F407ZGTx" });
                    }, 700);
                    break;
                case "chipControl":
                    if (["pause", "continue", "reset"].indexOf(message.action) >= 0)
                        setTargetState(message.action === "pause" ? "halted" : "running");
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
                    if (targetState !== "halted") break;
                    var result = data.peripheralReadResult(message.targets, true);
                    result.session.epoch = stopEpoch;
                    send(result);
                    break;
                }
                case "peripheralWriteRequest": {
                    if (targetState !== "halted") break;
                    var writeResult = data.peripheralWriteResult(message.target, message.value);
                    send(writeResult);
                    if (writeResult.type === "peripheralError") break;
                    var writeEpoch = stopEpoch;
                    setTimeout(function () {
                        if (targetState !== "halted" || stopEpoch !== writeEpoch) return;
                        var base = String(message.target || "")
                            .split(".")
                            .slice(0, 2)
                            .join(".");
                        var result = data.peripheralReadResult([base], false);
                        result.session.epoch = stopEpoch;
                        send(result);
                    }, 60);
                    break;
                }
                case "rtosRefresh":
                    if (targetState === "halted") send(data.rtosSnapshot(stopEpoch));
                    else
                        send(
                            Object.assign(data.rtosDebugStatus("running", stopEpoch), {
                                type: "rtosError",
                                message: "暂停调试器后才能刷新 RTOS 任务"
                            })
                        );
                    break;
                case "debugSelectSession":
                    send(data.rtosDebugStatus(targetState === "halted" ? "paused" : "running", stopEpoch));
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
                    notify({ action: "toast", text: "已从 ELF 重新读取 28 个变量" });
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
                    send({ type: "openocdStatus", state: "ready", key: "oc.readyVer", params: { version: "0.12.0" } });
                    send({ type: "commandSuccess", cmd: "openocdAction" });
                    break;
                case "selectProbeDriver":
                    send({ type: "probeDriverChoice", driver: message.driver });
                    send({ type: "probeDriverSwitch", busy: true });
                    setTimeout(function () {
                        send({ type: "probeDriverSwitch", busy: false });
                        send({ type: "probeDriverStatus", state: "ready" });
                        send({ type: "commandSuccess", cmd: "selectProbeDriver" });
                    }, 900);
                    break;
                case "cancelSvdDownload":
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
                    send({ type: "svdStatus", state: "configured", key: "svd.configured", path: data.SVD_PATH });
                    send({ type: "commandSuccess", cmd: cmd });
                    send({
                        type: "peripheralCatalog",
                        svd: { path: data.SVD_PATH, sha256: "mock-svd-sha256" },
                        peripherals: data.peripheralCatalog().peripherals
                    });
                    break;
                case "mcu-vscode.autoDetect":
                    notify({ action: "toast", text: "自动检测完成：J-Link V11 · STM32F407ZGTx" });
                    send({ type: "commandSuccess", cmd: cmd });
                    break;
                default:
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "toast", text: "已执行命令 " + cmd });
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
                cancelDebugStart();
                stopped = true;
                if (liveTimer) clearInterval(liveTimer);
                root.removeEventListener("message", onMessage);
            }
        };
    }

    root.EmberProbeSidebarHost = { create: createSidebarHost };
})(typeof window !== "undefined" ? window : globalThis);
