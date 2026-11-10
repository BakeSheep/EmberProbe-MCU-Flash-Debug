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
        var probesRead = false; // The refresh button reads each probe's chip (connectedProbes.js).
        var isEnglish =
            options.isEnglish ||
            function () {
                return false;
            };
        // The terminal and these notices are the extension's own localized text.
        function say(zh, en) {
            return isEnglish() ? en : zh;
        }
        var simulator = options.simulator || data.createSimulator();
        // One sampling session per window: this host owns its state and the waveform panel follows it.
        var samplingPhase = "stopped";
        var samplingIntent = false;
        var liveTimer = null;
        var phaseTimer = null;
        var watchItems = data.sidebarWatchList();
        var watchNames = watchItems.map(function (item) {
            return item.name;
        });
        var writeItems = data.sidebarWriteList();
        var writeNames = writeItems.map(function (item) {
            return item.name;
        });
        var stopped = false;
        var rtt = { running: false, terminals: false, saving: false, timestamps: false };
        var initialized = false;
        var agentFullAccess = false;
        var mcpClientStates = {
            claude: "installed",
            codex: "outdated",
            gemini: "notInstalled",
            opencode: "notInstalled",
            cursor: "notInstalled",
            antigravity: "notInstalled",
            dsh: "notInstalled"
        };
        var MCP_ACTIONS = {
            notInstalled: ["install"],
            installed: ["uninstall"],
            outdated: ["upgrade", "uninstall"],
            manual: ["copy"],
            builtin: []
        };
        var debugTimer = null;
        // "none" outside a debug session; the chip card's own state only matters there.
        var debugState = "none";
        var debugStarting = false;
        var chipState = "running";
        var flashRunning = false;
        var skillsInstalled = true;
        var stopEpoch = 1;
        var targetLine = 103;
        var lastMemory = data.memoryAnalysis();
        // The connected probe the mock workspace uses and the J-Link USB drivers switched in this page.
        var selectedProbe = data.PROBES[0].id;
        // Auto forgets the saved device; the mock then uses the first probe as the automatic choice.
        var probeAutomatic = false;
        var probeDrivers = {};

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
                symbols: data.variableTypes()
            });
            send({ type: "availableTypesDone", version: data.VERSION });
        }

        function sendInitialState() {
            send({ type: "openocdStatus", state: "ready", key: "oc.readyVer", params: { version: "0.12.0" } });
            send(data.connectedProbes(selectedProbe, probeDrivers, probeAutomatic, probesRead));
            send({
                type: "skillStatus",
                state: "installed",
                busy: false,
                scopes: { workspace: { state: skillsInstalled ? "installed" : "notInstalled" } }
            });
            sendVariableList();
            send({ type: "sidebarWatchList", items: watchItems, resetValues: true });
            send({ type: "sidebarWriteList", items: writeItems });
            send(lastMemory);
            send({ type: "svdStatus", state: "configured", path: data.SVD_PATH, key: "svd.configured" });
            send({ type: "chipInfo", info: currentChipInfo() });
            send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
            sendDebugStatus();
            send(sidebarStatus(samplingPhase));
            if (data.samplingStatus(samplingPhase).snapshotReady) sendSamples();
            setTimeout(function () {
                if (debugTimer === null) send({ type: "initSuccess" });
            }, 480);
        }

        function setDebugPending(busy) {
            send({ type: "mockDebugPending", busy: busy });
            notify({ action: "debugPending", busy: busy });
        }

        // kind "reset" is the debug command (reset, then run to main); "attach" halts the target where it is.
        function startDebug(kind) {
            if (stopped || debugTimer !== null || flashRunning) return;
            if (debugState !== "none") {
                send({
                    type: "notice",
                    area: "flash",
                    id: "mcu-vscode.debug",
                    notice: { level: "warning", key: "msg.debugBusy" }
                });
                return;
            }
            var cmd = kind === "attach" ? "mcu-vscode.attachDebug" : "mcu-vscode.debug";
            debugStarting = true;
            if (samplingIntent) setPhase("debug-waiting");
            debugTimer = setTimeout(function () {
                debugTimer = null;
                debugStarting = false;
                if (stopped) return;
                setDebugPending(false);
                if (kind !== "attach") simulator.reset();
                notify({ action: "debugSessionChanged" });
                send({ type: "commandSuccess", cmd: cmd });
                notify({ action: "debugStart", kind: kind === "attach" ? "attach" : "reset" });
            }, 2200);
            setDebugPending(true);
        }

        function cancelDebugStart() {
            if (debugTimer === null) return false;
            clearTimeout(debugTimer);
            debugTimer = null;
            debugStarting = false;
            setDebugPending(false);
            if (samplingIntent) setPhase("sampling");
            return true;
        }

        function clearSamplingTimers() {
            if (liveTimer) clearInterval(liveTimer);
            if (phaseTimer) clearTimeout(phaseTimer);
            liveTimer = phaseTimer = null;
        }

        function sidebarStatus(phase) {
            var status = data.samplingStatus(phase);
            // The sidebar reads at a fixed 20 Hz, whatever the waveform panel's frequency is.
            if (status.running) {
                status.frequencyHz = 20;
                status.actualHz = data.samplingActive(phase) ? 20 : 0;
            }
            return status;
        }

        function setPhase(phase) {
            clearSamplingTimers();
            samplingPhase = phase;
            send(sidebarStatus(phase));
            notify({ action: "sampling", phase: phase });
            sendDebugStatus();
            if (data.samplingActive(phase)) {
                sendSamples();
                liveTimer = setInterval(function () {
                    simulator.tick();
                    sendSamples();
                }, 50);
            }
        }

        // Each stop gets one DAP snapshot: memory is frozen until the next step or continue.
        function readSnapshot() {
            setPhase("debug-reading");
            phaseTimer = setTimeout(function () {
                phaseTimer = null;
                setPhase("debug-ready");
                sendSamples();
            }, 120);
        }

        function stopSampling() {
            samplingIntent = false;
            setPhase(debugState === "none" ? "stopped" : "debug-disabled");
        }

        function startSampling() {
            if (samplingIntent) return;
            samplingIntent = true;
            if (debugStarting) setPhase("debug-waiting");
            else if (debugState === "paused") readSnapshot();
            else if (debugState === "running") resumeRuntimeSampling();
            else connectStandalone();
        }

        function connectStandalone() {
            setPhase("connecting");
            phaseTimer = setTimeout(function () {
                phaseTimer = null;
                setPhase("sampling");
            }, 400);
        }

        // Sampling restarts only once the target really runs again; a step never reaches here.
        function resumeRuntimeSampling() {
            setPhase("debug-waiting");
            phaseTimer = setTimeout(function () {
                phaseTimer = null;
                setPhase("debug-sampling");
            }, 150);
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
            info.targetState = chipState;
            if (chipState === "halted") {
                info.haltReason =
                    debugState === "none"
                        ? "debug-request"
                        : say("断点命中", "Breakpoint hit") + " · main.c:" + targetLine;
                info.pc = "0x08001a3c";
                info.sp = "0x2001ffb0";
                info.lr = "0x080012b7";
            }
            return info;
        }

        // src/services/peripheralAccessService.js: no debug session needs a connected sampling session.
        function peripheralAccess() {
            var standalone = debugState === "none";
            var connected = samplingPhase === "sampling";
            var allowed = !standalone || connected;
            return {
                mode: standalone ? "standalone" : debugState === "paused" ? "debug-paused" : "debug-running",
                generation: stopEpoch,
                canRead: allowed,
                canWrite: allowed,
                reason: allowed ? "" : "PERIPHERAL_SAMPLING_REQUIRED"
            };
        }

        function sendDebugStatus() {
            send(data.rtosDebugStatus(debugState, stopEpoch));
            send(
                Object.assign(
                    { type: "peripheralDebugStatus", state: debugState, epoch: stopEpoch },
                    peripheralAccess()
                )
            );
        }

        // Follows the debug session the shell drives. settings.step: the stop came from a step;
        // settings.ended: the session is over and the target keeps running.
        function setTargetState(next, settings) {
            settings = settings || {};
            chipState = next;
            if (next === "halted") stopEpoch += 1;
            if (Number.isInteger(settings.line)) targetLine = settings.line;
            debugState = settings.ended ? "none" : next === "halted" ? "paused" : "running";
            if (next === "running") simulator.boot();
            if (settings.step) simulator.tick();
            send({ type: "chipInfo", info: currentChipInfo() });
            send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
            if (settings.ended) notify({ action: "debugSessionChanged" });
            if (samplingIntent) {
                if (settings.ended) {
                    setPhase("restoring");
                    phaseTimer = setTimeout(function () {
                        phaseTimer = null;
                        setPhase("sampling");
                    }, 600);
                } else if (next === "running") resumeRuntimeSampling();
                else readSnapshot();
            } else {
                if (settings.ended) setPhase("stopped");
                else setPhase("debug-disabled");
            }
            if (settings.notify !== false) notify({ action: "targetState", state: next });
        }

        function flashNotice(notice) {
            send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: notice });
        }

        // The real run: each step is what src/openocdRunner.js makes of an OpenOCD line, in the terminal and,
        // replaced in place, in the sidebar's notice (src/services/flashCommand.js). Only the wait inside
        // the write and the verify takes time.
        function simulateDownload(cmd) {
            if (flashRunning) return flashNotice({ level: "warning", key: "msg.downloadBusy" });
            if (debugStarting || debugState !== "none")
                return flashNotice({ level: "warning", key: "msg.debugBusyForDownload" });
            var resume = samplingIntent;
            if (resume) stopSampling();
            flashRunning = true;
            setDebugPending(true);
            var elf = data.ELF_PATH.replace(/\\/g, "/");
            notify({
                action: "flashLog",
                start: true,
                lines: [
                    { cls: "info", text: say("EmberProbe 固件下载", "EmberProbe firmware download") },
                    { cls: "", text: say("固件 ", "Firmware ") + elf },
                    {
                        cls: "",
                        text: say(
                            "探针 interface/jlink.cfg · 目标 target/stm32f4x.cfg",
                            "Probe interface/jlink.cfg · Target target/stm32f4x.cfg"
                        )
                    },
                    { cls: "", text: "" }
                ]
            });
            var wrote = { bytes: 917504, seconds: 6.201542, speed: "144.480 KiB/s" };
            var verified = { bytes: 917504, seconds: 0.912345, speed: "982.085 KiB/s" };
            var steps = [
                { at: 0, key: "run.starting", message: say("正在启动 OpenOCD", "Starting OpenOCD") },
                { at: 240, message: "Open On-Chip Debugger 0.12.0 (2024-11-24-10:12)" },
                { at: 400, message: "J-Link V11 compiled Nov 24 2024 10:12:05" },
                {
                    at: 520,
                    key: "run.voltage",
                    params: { volts: "3.30" },
                    message: say("目标电压 3.30 V", "Target voltage 3.30 V")
                },
                {
                    at: 640,
                    key: "run.adapterClock",
                    params: { clock: "4000 kHz" },
                    message: say("适配器时钟 4000 kHz", "Adapter clock 4000 kHz")
                },
                { at: 820, message: "EP_FLASH_STAGE=init" },
                { at: 960, message: "EP_FLASH_STAGE=reset_init" },
                { at: 1100, message: "target halted due to debug-request, current mode: Thread" },
                {
                    at: 1240,
                    key: "run.deviceId",
                    params: { id: "0x10076413" },
                    message: say("器件 ID 0x10076413", "Device ID 0x10076413")
                },
                {
                    at: 1380,
                    key: "run.flash",
                    params: { size: "1024 kbytes" },
                    message: say("Flash 容量 1024 kbytes", "Flash size 1024 kbytes")
                },
                { at: 1560, key: "run.programStart", message: say("开始写入固件", "Writing firmware") },
                {
                    at: 7760,
                    done: true,
                    key: "run.wrote",
                    params: wrote,
                    message: say(
                        "已写入 917504 bytes（6.201542s，144.480 KiB/s）",
                        "Wrote 917504 bytes (6.201542s, 144.480 KiB/s)"
                    )
                },
                { at: 7820, message: "** Verify Started **" },
                {
                    at: 8730,
                    done: true,
                    key: "run.verified",
                    params: verified,
                    message: say(
                        "已校验 917504 bytes（0.912345s，982.085 KiB/s）",
                        "Verified 917504 bytes (0.912345s, 982.085 KiB/s)"
                    )
                },
                { at: 8760, done: true, key: "run.verifyOk", message: say("固件校验通过", "Firmware verified") },
                { at: 8860, message: "** Resetting Target **" }
            ];
            steps.forEach(function (step) {
                setTimeout(function () {
                    flashNotice({
                        level: "info",
                        busy: true,
                        key: step.key,
                        params: step.params,
                        message: step.message
                    });
                    notify({
                        action: "flashLog",
                        lines: [{ cls: step.done ? "ok" : "", text: (step.done ? "✓ " : "→ ") + step.message }]
                    });
                }, step.at);
            });
            setTimeout(function () {
                flashRunning = false;
                setDebugPending(false);
                notify({
                    action: "flashLog",
                    lines: [
                        { cls: "", text: "" },
                        { cls: "ok", text: say("✓ 固件下载并校验成功", "✓ Firmware downloaded and verified") },
                        { cls: "", text: say("  固件 ", "  Firmware ") + elf.split("/").pop() },
                        { cls: "", text: say("  芯片 0x10076413", "  Chip 0x10076413") },
                        { cls: "", text: say("  Flash 容量 1024 kbytes", "  Flash size 1024 kbytes") },
                        { cls: "", text: say("  探针 ", "  Probe ") + "J-Link V11 compiled Nov 24 2024 10:12:05" },
                        { cls: "", text: say("  时钟 4000 kHz", "  Clock 4000 kHz") },
                        {
                            cls: "",
                            text: say(
                                "  写入 917504 bytes，耗时 6.201542s（144.480 KiB/s）",
                                "  Wrote 917504 bytes in 6.201542s (144.480 KiB/s)"
                            )
                        },
                        {
                            cls: "",
                            text: say(
                                "  校验 917504 bytes，耗时 0.912345s（982.085 KiB/s）",
                                "  Verified 917504 bytes in 0.912345s (982.085 KiB/s)"
                            )
                        },
                        {
                            cls: "",
                            text: say(
                                "  目标 target/stm32f4x.cfg · 探针配置 interface/jlink.cfg",
                                "  Target target/stm32f4x.cfg · Probe script interface/jlink.cfg"
                            )
                        }
                    ]
                });
                flashNotice({ level: "success", key: "msg.downloadSuccess" });
                send({ type: "commandSuccess", cmd: cmd });
                if (resume) startSampling();
            }, 9100);
        }

        function simulateSvdDownload(cmd) {
            var percents = [8, 26, 51, 77, 94];
            percents.forEach(function (percent, index) {
                setTimeout(
                    function () {
                        send({
                            type: "svdStatus",
                            state: "downloading",
                            key: "svd.downloading",
                            percent: percent,
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

        // The switch installs or removes the workspace's skills, whichever it does not have.
        function simulateSkillToggle(cmd) {
            function status(installed, busy) {
                var state = installed ? "installed" : "notInstalled";
                return { type: "skillStatus", state: state, busy: busy, scopes: { workspace: { state: state } } };
            }
            send(status(skillsInstalled, true));
            setTimeout(function () {
                skillsInstalled = !skillsInstalled;
                send(status(skillsInstalled, false));
                send({ type: "commandSuccess", cmd: cmd });
            }, 900);
        }

        function sendMcpClients() {
            var clients = Object.keys(mcpClientStates).map(function (client) {
                var state = mcpClientStates[client];
                return { client: client, state: state, actions: MCP_ACTIONS[state], files: [] };
            });
            clients.unshift({ client: "copilot", state: "builtin", actions: MCP_ACTIONS.builtin, files: [] });
            clients.push({ client: "json", state: "manual", actions: MCP_ACTIONS.manual, files: [] });
            send({ type: "mcpClients", clients: clients, busy: "" });
        }

        function handleCommand(message) {
            switch (message.type) {
                case "getMcpClients":
                    sendMcpClients();
                    break;
                case "mcpClientAction":
                    if (message.client !== "json")
                        mcpClientStates[message.client] = message.action === "uninstall" ? "notInstalled" : "installed";
                    sendMcpClients();
                    break;
                case "getAgentPermissions":
                    send({ type: "agentPermissions", fullAccess: agentFullAccess, available: true });
                    break;
                case "setAgentFullAccess":
                    agentFullAccess = message.enabled === true;
                    send({ type: "agentPermissions", fullAccess: agentFullAccess, available: true });
                    break;
                case "initCheck":
                    initialized = true;
                    sendInitialState();
                    break;
                case "liveToggle":
                    if (samplingIntent) stopSampling();
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
                    if (!data.samplingStatus(samplingPhase).canWrite) {
                        send({ type: "writeResult", ok: false, name: name, seq: seq, key: "sb.writeNeedSampling" });
                        break;
                    }
                    if (writeNames.indexOf(name) >= 0 && simulator.write(name, value)) {
                        send({ type: "writeResult", ok: true, name: name, value: value, valueText: null, seq: seq });
                        sendSamples();
                        if (samplingPhase === "debug-ready") notify({ action: "sampling", phase: samplingPhase });
                    } else {
                        send({ type: "writeResult", ok: false, name: name, seq: seq, key: "sb.writeUnsupported" });
                    }
                    break;
                }
                case "executeCommand":
                    handleExecute(message.cmd);
                    break;
                case "readChipInfo":
                    if (chipBusy()) break;
                    send({ type: "chipInfoStatus", state: "reading", key: "chip.reading" });
                    setTimeout(function () {
                        send({ type: "chipInfo", info: currentChipInfo() });
                        send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
                    }, 700);
                    break;
                case "chipControl":
                    if (["pause", "continue", "reset"].indexOf(message.action) < 0 || chipBusy()) break;
                    send({ type: "chipInfoStatus", state: "reading", key: "chip.controlling" });
                    setTimeout(function () {
                        chipState = message.action === "pause" ? "halted" : "running";
                        send({ type: "chipInfo", info: currentChipInfo() });
                        send({ type: "chipInfoStatus", state: "ready", key: "chip.done" });
                    }, 500);
                    break;
                case "memoryRefresh": {
                    lastMemory = data.memoryAnalysis();
                    lastMemory.requestId = Date.now();
                    send(lastMemory);
                    break;
                }
                case "memorySelectSource":
                    send({ type: "commandSuccess", cmd: "memorySelectSource" });
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
                    if (!peripheralAccess().canRead) {
                        send({
                            type: "peripheralError",
                            operation: message.type,
                            code: peripheralAccess().reason,
                            message: "请先开启采样",
                            requestPoll: message.poll === true
                        });
                        break;
                    }
                    // Hardware registers keep moving while the core runs; a paused target reads the same values.
                    var result = data.peripheralReadResult(message.targets, debugState !== "paused");
                    result.session.epoch = stopEpoch;
                    // src/controllers/sidebarRoutes.js: the poll loop waits for this answer before the next round.
                    if (message.poll === true) result.requestPoll = true;
                    send(result);
                    break;
                }
                case "peripheralWriteRequest": {
                    if (!peripheralAccess().canWrite) {
                        send({
                            type: "peripheralError",
                            operation: message.type,
                            target: message.target,
                            code: peripheralAccess().reason,
                            message: "请先开启采样"
                        });
                        break;
                    }
                    var writeResult = data.peripheralWriteResult(message.target, message.value);
                    send(writeResult);
                    if (writeResult.type === "peripheralError") break;
                    var writeEpoch = stopEpoch;
                    setTimeout(function () {
                        if (!peripheralAccess().canRead || stopEpoch !== writeEpoch) return;
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
                    if (debugState === "paused") send(data.rtosSnapshot(stopEpoch));
                    else
                        send(
                            Object.assign(data.rtosDebugStatus(debugState, stopEpoch), {
                                type: "rtosError",
                                message: "暂停调试器后才能刷新 RTOS 任务"
                            })
                        );
                    break;
                case "debugSelectSession":
                    send(data.rtosDebugStatus(debugState, stopEpoch));
                    break;
                case "resolveCompositeLayout": {
                    send(
                        Object.assign(
                            { type: "compositeLayoutResult", name: message.name, version: message.version },
                            data.layoutResult(message.name)
                        )
                    );
                    break;
                }
                case "refreshVariables":
                    sendVariableList();
                    break;
                case "saveSidebarWatch": {
                    watchItems = message.items || [];
                    watchNames = (message.items || []).map(function (item) {
                        return item.name;
                    });
                    if (data.samplingStatus(samplingPhase).snapshotReady) sendSamples();
                    break;
                }
                case "saveSidebarWrite":
                    writeItems = message.items || [];
                    writeNames = writeItems.map(function (item) {
                        return item.name;
                    });
                    if (data.samplingStatus(samplingPhase).snapshotReady) sendSamples();
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
                    send({ type: "probeDriverSwitch", busy: true });
                    setTimeout(function () {
                        probeDrivers[message.deviceId] = message.driver === "winusb" ? "ready" : "repair";
                        send({ type: "probeDriverSwitch", busy: false });
                        send(data.connectedProbes(selectedProbe, probeDrivers, probeAutomatic, probesRead));
                        send({ type: "probeDriverStatus", state: message.driver === "winusb" ? "ready" : "restored" });
                        send({ type: "commandSuccess", cmd: "selectProbeDriver" });
                    }, 900);
                    break;
                case "selectConnectedProbe":
                    selectedProbe = message.deviceId || data.PROBES[0].id;
                    probeAutomatic = !message.deviceId;
                    send(data.connectedProbes(selectedProbe, probeDrivers, probeAutomatic, probesRead));
                    send({ type: "commandSuccess", cmd: "selectConnectedProbe" });
                    break;
                case "refreshConnectedProbes":
                    probesRead = true;
                    send(data.connectedProbes(selectedProbe, probeDrivers, probeAutomatic, probesRead));
                    break;
                case "acceptTargetChip":
                    send(data.connectedProbes(selectedProbe, probeDrivers, probeAutomatic, probesRead));
                    break;
                case "cancelSvdDownload":
                    send({ type: "svdStatus", state: "configured", key: "svd.configured", path: data.SVD_PATH });
                    break;
                default:
                    break;
            }
        }

        // RTT card: the channels a demo firmware would configure, with the view fields the host adds.
        function postRttStatus() {
            var up = [
                { index: 0, name: "Terminal", mode: "skip" },
                { index: 1, name: "Trace", mode: "block" }
            ];
            send({
                type: "rttStatus",
                state: rtt.running ? "running" : "stopped",
                channels: rtt.running ? { up: up, down: [{ index: 0, size: 64 }] } : null,
                buffers: rtt.running
                    ? up.map(function (channel) {
                          return { channel: channel.index, connected: true };
                      })
                    : [],
                view: {
                    terminals: rtt.terminals ? up.length : 0,
                    timestamps: rtt.timestamps,
                    log: { enabled: rtt.saving, directory: rtt.saving ? "D:/work/firmware/logs" : "" }
                }
            });
        }

        function handleRtt(cmd) {
            if (cmd === "mcu-vscode.startRtt") rtt.running = rtt.terminals = true;
            else if (cmd === "mcu-vscode.stopRtt") rtt.running = false;
            else if (cmd === "mcu-vscode.rttSaveLog") rtt.saving = !rtt.saving;
            else if (cmd === "mcu-vscode.rttToggleTimestamps") rtt.timestamps = !rtt.timestamps;
            postRttStatus();
        }

        function handleExecute(cmd) {
            switch (cmd) {
                case "mcu-vscode.download":
                    simulateDownload(cmd);
                    break;
                case "mcu-vscode.debug":
                    startDebug("reset");
                    break;
                case "mcu-vscode.attachDebug":
                    startDebug("attach");
                    break;
                case "mcu-vscode.openLiveWatch":
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "openLiveWatch" });
                    break;
                case "mcu-vscode.startRtt":
                case "mcu-vscode.stopRtt":
                case "mcu-vscode.showRttTerminals":
                case "mcu-vscode.rttSaveLog":
                case "mcu-vscode.rttToggleTimestamps":
                    handleRtt(cmd);
                    send({ type: "commandSuccess", cmd: cmd });
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
                    // src/mainViewProvider.js reports everything it found in one notice.
                    send({
                        type: "notice",
                        area: "config",
                        id: cmd,
                        notice: {
                            level: "success",
                            key: "msg.autoDoneWith",
                            params: {
                                found: [
                                    "ELF: " + data.ELF_PATH.replace(/\\/g, "/").split("/").pop(),
                                    "MCU: stm32f4x.cfg",
                                    say("调试器: ", "Debugger: ") + "jlink.cfg"
                                ].join(", ")
                            }
                        }
                    });
                    send({ type: "commandSuccess", cmd: cmd });
                    break;
                default:
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "toast", text: "已执行命令 " + cmd });
                    break;
            }
        }

        // src/services/chipInfoService.js refuses while anything else holds the probe.
        function chipBusy() {
            var key = flashRunning
                ? "chip.busyDownload"
                : debugStarting || debugState !== "none"
                  ? "chip.busyDebug"
                  : samplingIntent
                    ? "chip.busyLive"
                    : "";
            if (key) send({ type: "chipInfoStatus", state: "error", key: key });
            return !!key;
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
            download: function () {
                simulateDownload("mcu-vscode.download");
            },
            startSampling: startSampling,
            stopSampling: stopSampling,
            getWatchList: function () {
                return watchItems.slice();
            },
            isLiveRunning: function () {
                return samplingIntent;
            },
            isInitialized: function () {
                return initialized;
            },
            destroy: function () {
                cancelDebugStart();
                stopped = true;
                clearSamplingTimers();
                root.removeEventListener("message", onMessage);
            }
        };
    }

    root.EmberProbeSidebarHost = { create: createSidebarHost };
})(typeof window !== "undefined" ? window : globalThis);
