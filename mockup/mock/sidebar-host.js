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
        // src/services/rttTerminalService.js: the channels to read, the terminals made so far, the chosen log file.
        var rtt = {
            state: "stopped",
            selected: [0],
            listed: false,
            terminals: 0,
            logFile: "",
            timestamps: false,
            timer: null,
            ticker: null,
            received: {}
        };
        var tr = (root.EmberProbeMockText && root.EmberProbeMockText.create(isEnglish)) || String;
        var quickPick =
            options.quickPick ||
            function (_items, _settings, done) {
                done(undefined);
            };
        var inputBox =
            options.inputBox ||
            function (_settings, done) {
                done(undefined);
            };
        // Sidebar data breakpoints (src/services/sidebarDataBreakpoints.js and src/debug/dataBreakpointGroups.js).
        var dataBreakpoints = { session: 0, entries: [], nextId: 1, issued: {}, nextDataId: 1 };
        var initialized = false;
        var agentFullAccess = false;
        var agentAccessEnabled = true;
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
            send({ type: "agentAccess", enabled: agentAccessEnabled });
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
                dataBreakpoints.session += 1;
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
            // A halted target prints nothing over RTT; the panel follows.
            if (rtt.state === "running") postRttStatus();
            dataBreakpointsChanged(settings.ended);
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
                    send({
                        type: "agentPermissions",
                        fullAccess: agentFullAccess && agentAccessEnabled,
                        available: true
                    });
                    break;
                case "setAgentFullAccess":
                    agentFullAccess = message.enabled === true;
                    if (agentFullAccess) agentAccessEnabled = true;
                    send({ type: "agentAccess", enabled: agentAccessEnabled });
                    send({ type: "agentPermissions", fullAccess: agentFullAccess, available: true });
                    break;
                case "sidebarDataBreakpoint":
                    handleDataBreakpoint(message);
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
                    var previousWatch = watchNames;
                    watchItems = message.items || [];
                    watchNames = (message.items || []).map(function (item) {
                        return item.name;
                    });
                    pruneDataBreakpoints(previousWatch, watchNames);
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

        // RTT card: what the demo firmware's control block lists, with the view fields the host adds.
        var RTT_FIRMWARE = [
            { index: 0, name: "Terminal", mode: "skip", size: 1024, down: 64 },
            { index: 1, name: "Trace", mode: "block", size: 4096, down: 0 }
        ];
        var RTT_MAX_CHANNELS = 16;
        // Bytes per second the demo firmware writes to each up channel (its log line and trace records).
        var RTT_RATE = { 0: 52, 1: 168 };

        function rttTargetRunning() {
            return chipState !== "halted";
        }

        // The card's counters refresh once a second while RTT runs.
        function rttTick() {
            if (rtt.state !== "running") return;
            if (rttTargetRunning())
                rttUp().forEach(function (channel) {
                    rtt.received[channel.index] = (rtt.received[channel.index] || 0) + (RTT_RATE[channel.index] || 0);
                });
            postRttStatus();
        }
        var RTT_LOG_DIR = "D:/work/firmware/logs";

        function rttUp() {
            return RTT_FIRMWARE.filter(function (channel) {
                return rtt.selected.indexOf(channel.index) >= 0;
            });
        }

        function postRttStatus() {
            var running = rtt.state === "running";
            var up = running
                ? rttUp().map(function (channel) {
                      return { index: channel.index, name: channel.name, mode: channel.mode, size: channel.size };
                  })
                : [];
            send({
                type: "rttStatus",
                state: rtt.state,
                channels: running
                    ? {
                          up: up,
                          down: RTT_FIRMWARE.filter(function (channel) {
                              return channel.down > 0;
                          }).map(function (channel) {
                              return { index: channel.index, size: channel.down };
                          })
                      }
                    : null,
                buffers: up.map(function (channel) {
                    return {
                        channel: channel.index,
                        connected: true,
                        rateBytesPerSecond: rttTargetRunning() ? RTT_RATE[channel.index] || 0 : 0,
                        receivedBytes: rtt.received[channel.index] || 0,
                        start: 0
                    };
                }),
                // What the host last read of each up buffer's fill level in target RAM.
                targetTelemetry: running
                    ? {
                          available: true,
                          sampledAt: Date.now(),
                          channels: up.map(function (channel) {
                              return {
                                  index: channel.index,
                                  usedBytes: rttTargetRunning() ? (channel.index === 0 ? 48 : 212) : 0,
                                  capacity: channel.size
                              };
                          })
                      }
                    : null,
                firmwareChannels: rtt.listed
                    ? RTT_FIRMWARE.map(function (channel) {
                          return { index: channel.index, name: channel.name, size: channel.size };
                      })
                    : [],
                view: {
                    selectedChannels: rtt.selected.slice(),
                    terminals: rtt.terminals,
                    timestamps: rtt.timestamps,
                    log: {
                        enabled: !!rtt.logFile,
                        directory: rtt.logFile ? RTT_LOG_DIR : "",
                        file: rtt.logFile
                    }
                }
            });
            notify({
                action: "rtt",
                state: rtt.state,
                timestamps: rtt.timestamps,
                targetRunning: chipState !== "halted",
                channels: running
                    ? rttUp().map(function (channel) {
                          return { index: channel.index, name: channel.name, down: channel.down };
                      })
                    : []
            });
        }

        function rttNotice(id, notice) {
            send({ type: "notice", area: "rtt", id: id, notice: notice });
        }

        function rttClearNotices() {
            ["rtt", "rtt-channels", "rtt-log"].forEach(function (id) {
                send({ type: "noticeClear", area: "rtt", id: id });
            });
        }

        // The control block is found after a short search; the panel tab appears and comes forward without focus.
        function startRtt() {
            if (rtt.state !== "stopped") return;
            rttClearNotices();
            rtt.state = "starting";
            postRttStatus();
            rtt.timer = setTimeout(function () {
                rtt.timer = null;
                if (stopped || rtt.state !== "starting") return;
                rtt.state = "running";
                rtt.listed = true;
                rtt.terminals = Math.max(rtt.terminals, rttUp().length);
                postRttStatus();
                notify({ action: "rttReveal", focus: false });
                if (!rtt.ticker) rtt.ticker = setInterval(rttTick, 1000);
            }, 500);
        }

        function stopRtt() {
            if (rtt.timer) clearTimeout(rtt.timer);
            if (rtt.ticker) clearInterval(rtt.ticker);
            rtt.timer = rtt.ticker = null;
            if (rtt.state === "stopped") return;
            rtt.state = "stopped";
            postRttStatus();
        }

        function fileStamp(ms) {
            var date = new Date(ms);
            function two(value) {
                return (value < 10 ? "0" : "") + value;
            }
            return (
                date.getFullYear() +
                two(date.getMonth() + 1) +
                two(date.getDate()) +
                "-" +
                two(date.getHours()) +
                two(date.getMinutes()) +
                two(date.getSeconds())
            );
        }

        function parseTypedChannels(text) {
            var parts = String(text || "")
                .split(",")
                .map(function (part) {
                    return part.trim();
                })
                .filter(Boolean);
            if (!parts.length) return null;
            var out = [];
            for (var i = 0; i < parts.length; i++) {
                if (!/^\d+$/.test(parts[i]) || Number(parts[i]) > 255) return null;
                out.push(Number(parts[i]));
            }
            return out;
        }

        // src/services/rttTerminalService.js selectChannels: a multi-select of the firmware's channels plus the
        // configured ones, an "other" entry for typed numbers, and a restart when RTT is not stopped.
        function selectRttChannels(cmd) {
            var listed = new Map();
            if (rtt.listed)
                RTT_FIRMWARE.forEach(function (channel) {
                    listed.set(channel.index, channel);
                });
            var indices = Array.from(new Set(Array.from(listed.keys()).concat(rtt.selected))).sort(function (a, b) {
                return a - b;
            });
            var items = indices.map(function (index) {
                var channel = listed.get(index);
                return {
                    label: tr("rtt.channelPick", { n: index }),
                    description: channel
                        ? channel.name || tr("rtt.channelDefault")
                        : listed.size
                          ? tr("rtt.channelNotListed")
                          : "",
                    detail: channel && channel.size ? tr("rtt.channelSize", { size: channel.size }) : "",
                    picked: rtt.selected.indexOf(index) >= 0,
                    index: index
                };
            });
            items.push({ label: tr("rtt.channelOther"), other: true });
            function finish(next) {
                send({ type: "commandSuccess", cmd: cmd });
                if (!next) return;
                send({ type: "noticeClear", area: "rtt", id: "rtt-channels" });
                if (!next.length || next.length > RTT_MAX_CHANNELS) {
                    rttNotice("rtt-channels", {
                        level: "warning",
                        key: next.length ? "rtt.channelsTooMany" : "rtt.channelsNone",
                        params: { max: RTT_MAX_CHANNELS }
                    });
                    return;
                }
                var order = next.slice().sort(function (a, b) {
                    return a - b;
                });
                if (order.join(",") === rtt.selected.join(",")) return;
                rtt.selected = order;
                postRttStatus();
                if (rtt.state !== "stopped") {
                    stopRtt();
                    startRtt();
                }
            }
            quickPick(
                items,
                {
                    canPickMany: true,
                    title: tr("rtt.channelsTitle"),
                    placeHolder: tr(listed.size ? "rtt.channelsPlaceholder" : "rtt.channelsPlaceholderUnknown")
                },
                function (picked) {
                    if (!picked) return finish(null);
                    var next = new Set();
                    var other = false;
                    picked.forEach(function (item) {
                        if (item.other) other = true;
                        else next.add(item.index);
                    });
                    if (!other) return finish(Array.from(next));
                    inputBox(
                        {
                            title: tr("rtt.channelsTitle"),
                            prompt: tr("rtt.channelOtherPrompt"),
                            validate: function (value) {
                                return parseTypedChannels(value) ? "" : tr("rtt.channelOtherInvalid");
                            }
                        },
                        function (typed) {
                            if (typed === undefined) return finish(null);
                            parseTypedChannels(typed).forEach(function (index) {
                                next.add(index);
                            });
                            finish(Array.from(next));
                        }
                    );
                }
            );
        }

        // While saving, the button stops; otherwise the save dialog's suggested file (rtt-<time>.log) is taken.
        function toggleRttLog() {
            rtt.logFile = rtt.logFile ? "" : RTT_LOG_DIR + "/rtt-" + fileStamp(Date.now()) + ".log";
            postRttStatus();
        }

        function showRttTerminals() {
            if (!rtt.terminals) {
                rttNotice(
                    "rtt",
                    rtt.state === "starting"
                        ? { level: "info", key: "rtt.terminalsPending" }
                        : { level: "warning", key: "rtt.err.notRunning" }
                );
                return;
            }
            notify({ action: "rttReveal", focus: true });
        }

        /* ------------------------------------------------- sidebar data breakpoints */

        // Cortex-M4 has four DWT comparators; GDB reports the fifth watchpoint as not set in hardware.
        var DWT_COMPARATORS = 4;
        var WATCH_WIDTH = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 };
        var dataHitTimer = null;

        function dataStatus() {
            var inSession = debugState !== "none" && dataBreakpoints.session > 0;
            return {
                sessionId: inSession ? "mock-debug-" + dataBreakpoints.session : null,
                paused: debugState === "paused",
                epoch: stopEpoch,
                available: inSession && !debugStarting
            };
        }

        function dataGeneration() {
            return JSON.stringify([stopEpoch, data.VERSION]);
        }

        function dataSnapshot() {
            var enabled = 0;
            return {
                generation: dataGeneration(),
                entries: dataBreakpoints.entries.map(function (entry) {
                    var fits = entry.enabled && ++enabled <= DWT_COMPARATORS;
                    return Object.assign({}, entry, {
                        verified: fits,
                        message: entry.enabled && !fits ? tr("debug.dataBreakpointHardware") : ""
                    });
                })
            };
        }

        function postDataBreakpoints(body) {
            send(Object.assign({ type: "sidebarDataBreakpoints" }, body || {}, dataStatus()));
            // VS Code's Breakpoints view lists them too (the debug sidebar in the shell).
            notify({ action: "dataBreakpoints", entries: dataSnapshot().entries });
        }

        function dataError(requestId, key) {
            send({ type: "sidebarDataBreakpointError", requestId: requestId, message: tr(key) });
        }

        // Status changes invalidate open menus; a finished session drops its rows, as the adapter's clear() does.
        function dataBreakpointsChanged(ended) {
            if (dataHitTimer) clearTimeout(dataHitTimer);
            dataHitTimer = null;
            if (ended) {
                dataBreakpoints.entries = [];
                dataBreakpoints.issued = {};
            }
            postDataBreakpoints({ invalidated: true });
            if (debugState === "running") scheduleDataHit();
        }

        // The storage behind a display path: a scalar global, or a member/element reached through its layout.
        function resolveStorage(name) {
            var match = /^([A-Za-z_]\w*)(.*)$/.exec(String(name || ""));
            var symbol =
                match &&
                data.SYMBOLS.find(function (item) {
                    return item.name === match[1];
                });
            if (!symbol || symbol.runtimeLayout) return null;
            var address = symbol.address;
            var width = symbol.isComposite ? 0 : symbol.size;
            var layout = symbol.compositeLayout || null;
            var rest = match[2];
            var token;
            var pattern = /^(?:\.([A-Za-z_]\w*)|\[(\d+)\])/;
            while (rest && (token = pattern.exec(rest))) {
                rest = rest.slice(token[0].length);
                if (!layout) return null;
                if (token[1] !== undefined) {
                    var member = (layout.members || []).find(function (item) {
                        return item.name === token[1];
                    });
                    if (!member) return null;
                    address += member.offset;
                    layout = member.compositeLayout || null;
                    width = layout ? 0 : WATCH_WIDTH[member.watchType] || 0;
                } else {
                    var element = layout.elementType;
                    var index = Number(token[2]);
                    if (!element || layout.kind !== "array" || index >= layout.totalElements) return null;
                    address += index * element.byteSize;
                    layout = element.compositeLayout || null;
                    width = layout ? 0 : element.byteSize;
                }
            }
            if (rest || !width) return null;
            return { address: address, width: width, constant: !!symbol.isConst };
        }

        function dataInfo(name) {
            var storage = resolveStorage(name);
            if (!storage)
                return {
                    dataId: null,
                    canPersist: false,
                    description: tr("debug.dataBreakpointUnavailable", { error: tr("sb.dataUnsupported") })
                };
            if ([1, 2, 4].indexOf(storage.width) < 0 || storage.address % storage.width)
                return {
                    dataId: null,
                    canPersist: false,
                    description: tr("debug.dataBreakpointUnavailable", { error: tr("debug.dataBreakpointSize") })
                };
            var address = "0x" + storage.address.toString(16).padStart(8, "0");
            var identity = address + ":" + storage.width;
            var issued = dataBreakpoints.issued[identity];
            if (!issued) {
                issued = { dataId: "sidebar:" + dataBreakpoints.nextDataId++, address: address, bytes: storage.width };
                dataBreakpoints.issued[identity] = issued;
            }
            return {
                dataId: issued.dataId,
                description: tr("debug.dataBreakpointStorage", { name: name, address: address, bytes: storage.width }),
                // Mirrors the adapter: one address takes a single armed access type.
                accessTypes: ["write", "read", "readWrite"].filter(function (type) {
                    return !dataBreakpoints.entries.some(function (entry) {
                        return entry.enabled && entry.dataId === issued.dataId && entry.accessType !== type;
                    });
                }),
                canPersist: false,
                address: address,
                bytes: storage.width,
                constant: storage.constant
            };
        }

        // The first enabled, armed watchpoint whose storage the running firmware touches stops the target.
        function scheduleDataHit() {
            var armed = dataSnapshot().entries.filter(function (entry) {
                return entry.verified && !(entry.accessType === "write" && entry.constant);
            });
            if (!armed.length) return;
            var hit = armed[0];
            dataHitTimer = setTimeout(function () {
                dataHitTimer = null;
                if (stopped || debugState !== "running") return;
                notify({
                    action: "dataBreakpointHit",
                    name: hit.name,
                    accessType: hit.accessType,
                    condition: hit.condition
                });
            }, 700);
        }

        // Removing a watch row removes the watchpoints set on it and its members, without pausing the target.
        function pruneDataBreakpoints(previous, names) {
            var removed = previous.filter(function (name) {
                return names.indexOf(name) < 0;
            });
            var before = dataBreakpoints.entries.length;
            dataBreakpoints.entries = dataBreakpoints.entries.filter(function (entry) {
                return !removed.some(function (name) {
                    return (
                        entry.name === name ||
                        entry.name.indexOf(name + ".") === 0 ||
                        entry.name.indexOf(name + "[") === 0
                    );
                });
            });
            if (dataBreakpoints.entries.length !== before) postDataBreakpoints(dataSnapshot());
        }

        function handleDataBreakpoint(message) {
            var requestId = message.requestId;
            var status = dataStatus();
            if (!status.available) return dataError(requestId, "sb.dataNoSession");
            if (message.sessionId !== status.sessionId || message.epoch !== status.epoch)
                return dataError(requestId, "sb.dataStale");
            var action = message.action;
            if (action === "pause") {
                // The adapter pauses the target; the shell's debug toolbar shows the stop like any other.
                if (debugState === "running") notify({ action: "pauseDebug" });
                return postDataBreakpoints({ requestId: requestId, action: "pause" });
            }
            if (action === "list") return postDataBreakpoints(Object.assign(dataSnapshot(), { requestId: requestId }));
            if (debugState !== "paused") return dataError(requestId, "sb.dataStale");
            if (action === "info") {
                var info = dataInfo(message.name);
                return postDataBreakpoints(
                    Object.assign(dataSnapshot(), { requestId: requestId, action: action, info: info })
                );
            }
            if (message.generation !== dataGeneration()) return dataError(requestId, "sb.dataStale");
            function reply() {
                postDataBreakpoints(Object.assign(dataSnapshot(), { requestId: requestId, action: action }));
            }
            if (action === "add") {
                var resolved = dataInfo(message.name);
                if (!resolved.dataId || resolved.dataId !== message.dataId) return dataError(requestId, "sb.dataStale");
                if (resolved.accessTypes.indexOf(message.accessType) < 0)
                    return dataError(requestId, "sb.dataUnsupported");
                var duplicate = dataBreakpoints.entries.some(function (entry) {
                    return entry.dataId === resolved.dataId && entry.accessType === message.accessType;
                });
                if (!duplicate)
                    dataBreakpoints.entries.push({
                        id: String(dataBreakpoints.nextId++),
                        name: message.name,
                        dataId: resolved.dataId,
                        accessType: message.accessType,
                        condition: "",
                        enabled: true,
                        constant: resolved.constant,
                        description: resolved.description
                    });
                return reply();
            }
            var entry = dataBreakpoints.entries.find(function (item) {
                return item.id === message.id;
            });
            if (!entry) return dataError(requestId, "sb.dataStale");
            if (action === "remove") {
                dataBreakpoints.entries.splice(dataBreakpoints.entries.indexOf(entry), 1);
                return reply();
            }
            if (action === "enable" && typeof message.enabled === "boolean") {
                entry.enabled = message.enabled;
                return reply();
            }
            if (action === "condition") {
                // VS Code's input box comes first; the request is re-checked once it closes.
                return inputBox(
                    {
                        prompt: tr("sb.dataConditionPrompt"),
                        value: entry.condition || "",
                        validate: function (value) {
                            return value.length > 1024 || /[\x00-\x1f\x7f]/.test(value) ? tr("sb.dataUnsupported") : "";
                        }
                    },
                    function (condition) {
                        if (condition === undefined)
                            return postDataBreakpoints({ requestId: requestId, cancelled: true });
                        if (
                            debugState !== "paused" ||
                            message.epoch !== stopEpoch ||
                            dataBreakpoints.entries.indexOf(entry) < 0
                        )
                            return dataError(requestId, "sb.dataStale");
                        entry.condition = condition.trim();
                        reply();
                    }
                );
            }
            dataError(requestId, "sb.dataUnsupported");
        }

        function handleRtt(cmd) {
            if (cmd === "mcu-vscode.startRtt") startRtt();
            else if (cmd === "mcu-vscode.stopRtt") stopRtt();
            else if (cmd === "mcu-vscode.showRttTerminals") showRttTerminals();
            else if (cmd === "mcu-vscode.rttSaveLog") toggleRttLog();
            else if (cmd === "mcu-vscode.rttToggleTimestamps") {
                rtt.timestamps = !rtt.timestamps;
                postRttStatus();
            }
        }

        function handleExecute(cmd) {
            switch (cmd) {
                case "mcu-vscode.enableAgentAccess":
                case "mcu-vscode.disableAgentAccess":
                    agentAccessEnabled = cmd === "mcu-vscode.enableAgentAccess";
                    send({ type: "agentAccess", enabled: agentAccessEnabled });
                    send({ type: "commandSuccess", cmd: cmd });
                    break;
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
                case "mcu-vscode.rttSelectChannels":
                    selectRttChannels(cmd);
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
            // The Breakpoints view's checkbox toggles a sidebar watchpoint like the menu does.
            setDataBreakpointEnabled: function (id, enabled) {
                var entry = dataBreakpoints.entries.find(function (item) {
                    return item.id === id;
                });
                if (!entry || debugState === "none") return;
                entry.enabled = enabled === true;
                postDataBreakpoints(dataSnapshot());
                if (debugState === "running") {
                    if (dataHitTimer) clearTimeout(dataHitTimer);
                    dataHitTimer = null;
                    scheduleDataHit();
                }
            },
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
                if (rtt.timer) clearTimeout(rtt.timer);
                if (rtt.ticker) clearInterval(rtt.ticker);
                stopped = true;
                clearSamplingTimers();
                root.removeEventListener("message", onMessage);
            }
        };
    }

    root.EmberProbeSidebarHost = { create: createSidebarHost };
})(typeof window !== "undefined" ? window : globalThis);
