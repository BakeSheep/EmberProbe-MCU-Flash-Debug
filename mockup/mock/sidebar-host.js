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
        // One id per probe/target context; write cards sampled in an older context stop writing (src/services/writeExecution.js).
        var writeContext = 1;
        var liveTimer = null;
        var phaseTimer = null;
        var svdTimers = [];
        var flashTimers = [];
        var expansions = {};
        var readMeter = root.EmberProbeMockSampling.meter();
        var measured = readMeter.record(0, 0);
        var lastSampleStatus = 0;
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
            intent: false,
            yieldedFor: null,
            selected: [0],
            listed: false,
            terminals: 0,
            logFile: "",
            timestamps: false,
            timer: null,
            ticker: null,
            received: {}
        };
        var rttSettings = { ...root.EmberProbeMockRttSettings.defaults };
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
        var dataBreakpoints = { session: 0, entries: [], native: [], nextId: 1, issued: {}, nextDataId: 1 };
        var debugCore = 0;
        var debugCores = options.debugCores === 2 ? 2 : 1;
        var coreBreakpoints = new Map();
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
            dsh: "notInstalled",
            workbuddy: "notInstalled"
        };
        var MCP_ACTIONS = {
            notInstalled: ["install"],
            installed: ["uninstall"],
            outdated: ["upgrade", "uninstall"],
            manual: ["copy"],
            builtin: []
        };
        var mcpBusyClient = "";
        var mcpCheckTimer = null;
        var debugTimer = null;
        // "none" outside a debug session; the chip card's own state only matters there.
        var debugState = "none";
        var debugStarting = false;
        var chipState = "running";
        var chipRead = false;
        var flashRunning = false;
        var skillsInstalled = true;
        var stopEpoch = 1;
        var targetFile = "main.c";
        var targetLine = 103;
        var configuration = root.EmberProbeMockConfiguration.create({
            data,
            quickPick,
            send,
            tr,
            onChange(field) {
                if (field === "elf") {
                    sendVariableList();
                    send(configuration.readMemory());
                }
                if (field === "debugger") {
                    selectedProbe = probes.find((probe) => probe.defaultConfig === configuration.values.debugger)?.id;
                    probeAutomatic = true;
                    publishProbes();
                }
            }
        });
        // The connected probe the mock workspace uses and the J-Link USB drivers switched in this page.
        var probes = data.PROBES;
        var selectedProbe = probes[0].id;
        // Auto forgets the saved device; the mock then uses the first probe as the automatic choice.
        var probeAutomatic = false;
        var probeDrivers = {};

        function publishProbes() {
            const devices = data.connectedProbes(selectedProbe, probeDrivers, probeAutomatic, probesRead);
            devices.debugger = configuration.values.debugger;
            if (!selectedProbe) {
                devices.state = "none";
                devices.deviceId = devices.probeSerial = devices.autoTarget = "";
                for (const device of devices.devices) device.selected = device.matchesDebugger = false;
            }
            send(devices);
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
            configuration.publish();
            send({ type: "agentAccess", enabled: agentAccessEnabled });
            send({ type: "openocdStatus", state: "ready", key: "oc.readyVer", params: { version: "0.12.0" } });
            publishProbes();
            send({
                type: "skillStatus",
                state: "installed",
                busy: false,
                scopes: { workspace: { state: skillsInstalled ? "installed" : "notInstalled" } }
            });
            sendVariableList();
            send({ type: "sidebarWatchList", items: watchItems, resetValues: true });
            send({ type: "sidebarWriteList", items: writeItems });
            send(configuration.readMemory());
            send({ type: "svdStatus", state: "configured", path: data.SVD_PATH, key: "svd.configured" });
            sendChipState();
            sendDebugStatus();
            send(sidebarStatus(samplingPhase));
            if (data.samplingStatus(samplingPhase).snapshotReady) sendSamples();
            setTimeout(function () {
                if (debugTimer === null) send({ type: "initSuccess" });
            }, 480);
        }

        function setDebugPending(busy) {
            send({ type: "mockDebugPending", busy: busy, text: busy ? tr("sb.executing") : "" });
            notify({ action: "debugPending", busy: busy });
        }

        function requireProbe(cmd, titleKey) {
            const probe = probes.find((device) => device.id === selectedProbe);
            const driver = probe && (probeDrivers[probe.id] || probe.driver);
            if (probe && driver !== "repair") return true;
            send({
                type: "notice",
                area: "flash",
                id: cmd,
                notice: {
                    level: "error",
                    titleKey,
                    key: probe ? "probe.driverUnsupported" : "probe.noneConnected"
                }
            });
            send({ type: "revealConnectedProbes" });
            send({ type: "commandError", cmd });
            return false;
        }

        // kind "reset" is the debug command (reset, then run to main); "attach" halts the target where it is.
        function startDebug(kind) {
            if (stopped || debugTimer !== null) return;
            var cmd = kind === "attach" ? "mcu-vscode.attachDebug" : "mcu-vscode.debug";
            if (flashRunning) {
                send({
                    type: "notice",
                    area: "flash",
                    id: cmd,
                    notice: { level: "warning", key: "msg.downloadBusy" }
                });
                send({ type: "commandError", cmd: cmd });
                return;
            }
            if (debugState !== "none") {
                send({
                    type: "notice",
                    area: "flash",
                    id: "mcu-vscode.debug",
                    notice: { level: "warning", key: "msg.debugBusy" }
                });
                send({ type: "commandError", cmd: cmd });
                return;
            }
            if (!requireProbe(cmd, kind === "attach" ? "notice.attachFailed" : "notice.debugFailed")) return;
            send({ type: "noticeClear", area: "flash", id: "mcu-vscode.download" });
            send({ type: "noticeClear", area: "flash", id: "mcu-vscode.debug" });
            send({ type: "noticeClear", area: "flash", id: "mcu-vscode.attachDebug" });
            debugStarting = true;
            yieldRtt("debug");
            if (samplingIntent) setPhase("debug-waiting");
            debugTimer = setTimeout(
                function () {
                    debugTimer = null;
                    debugStarting = false;
                    if (stopped) return;
                    setDebugPending(false);
                    if (kind !== "attach") simulator.reset();
                    writeContext += 1;
                    dataBreakpoints.session += 1;
                    debugCore = 0;
                    coreBreakpoints.clear();
                    notify({ action: "debugSessionChanged", id: debugScope() });
                    send({ type: "commandSuccess", cmd: cmd });
                    notify({ action: "debugStart", kind: kind === "attach" ? "attach" : "reset", cores: debugCores });
                },
                kind === "attach" ? 1400 : 2200
            );
            setDebugPending(true);
        }

        function cancelDebugStart() {
            if (debugTimer === null) return false;
            clearTimeout(debugTimer);
            debugTimer = null;
            debugStarting = false;
            setDebugPending(false);
            send({ type: "initSuccess" });
            updateRttHost();
            if (samplingIntent) setPhase("sampling");
            return true;
        }

        function clearSamplingTimers() {
            if (liveTimer) clearTimeout(liveTimer);
            if (phaseTimer) clearTimeout(phaseTimer);
            liveTimer = phaseTimer = null;
        }

        function sidebarStatus(phase) {
            var status = data.samplingStatus(phase);
            if (status.running) {
                status.frequencyHz = 20;
                Object.assign(status, measured);
            }
            status.writeContext = writeContext;
            return status;
        }

        function setPhase(phase) {
            clearSamplingTimers();
            readMeter.reset();
            measured = readMeter.record(0, 0);
            lastSampleStatus = Date.now();
            samplingPhase = phase;
            send(sidebarStatus(phase));
            notify({ action: "sampling", phase: phase });
            sendDebugStatus();
            if (data.samplingActive(phase)) streamSidebar();
            if (phase === "sampling" || phase === "debug-sampling") updateRttHost(true);
        }

        function streamSidebar() {
            simulator.tick();
            sendSamples();
            liveTimer = setTimeout(streamSidebar, options.sidebarInterval?.(samplingPhase) || 50);
        }

        function readItems() {
            return watchItems.filter(
                (item) => !Array.isArray(expansions[item.name]) || expansions[item.name].includes("")
            );
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
            writeContext += 1;
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
            var openNames = readItems().map((item) => item.name);
            var names = Array.from(new Set(openNames.concat(writeNames)));
            var samples = simulator.scalarSamples(names, t, { writeContext: writeContext });
            send({
                type: "liveSample",
                samples,
                t: t
            });
            var composite = openNames
                .map(function (name) {
                    return simulator.compositeSample(name, t);
                })
                .filter(Boolean);
            composite.forEach(function (sample) {
                sample.writeContext = writeContext;
            });
            if (composite.length) send({ type: "liveCompositeSample", samples: composite, t: t });
            measured = readMeter.record(t, samples.length * 4 + composite.length * 16);
            if (data.samplingActive(samplingPhase) && t - lastSampleStatus >= 1000) {
                lastSampleStatus = t;
                send(sidebarStatus(samplingPhase));
            }
        }

        function currentChipInfo() {
            var info = data.chipInfo().info;
            info.targetState = chipState;
            if (chipState === "halted") {
                info.haltReason =
                    debugState === "none"
                        ? "debug-request"
                        : say("断点命中", "Breakpoint hit") + " · " + targetFile + ":" + targetLine;
                info.pc = "0x08001a3c";
                info.sp = "0x2001ffb0";
                info.lr = "0x080012b7";
            }
            return info;
        }

        function sendChipState() {
            if (chipRead) send({ type: "chipInfo", info: currentChipInfo() });
            send(
                chipRead
                    ? { type: "chipInfoStatus", state: "ready", key: "chip.done" }
                    : {
                          type: "chipInfoStatus",
                          state: "idle",
                          key: "chip.notRead"
                      }
            );
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

        function debugScope() {
            return dataBreakpoints.session + "-" + debugCore;
        }

        function coreId(core) {
            return "mock-debug-session-" + (core + 1);
        }

        function rtosStatus() {
            const status = data.rtosDebugStatus(debugState, stopEpoch);
            if (debugCores === 1 || debugState === "none") return status;
            return {
                ...status,
                sessionId: coreId(debugCore),
                sessions: [0, 1].map((core) => ({
                    id: coreId(core),
                    name: "EmberProbe (Cortex-M" + (core === 0 ? 7 : 4) + ")",
                    serverGroup: "STM32H7",
                    targetProcessor: core
                }))
            };
        }

        function selectCore(index) {
            if (debugState === "none" || index === debugCore || index < 0 || index >= debugCores) return;
            const { entries, native, issued } = dataBreakpoints;
            coreBreakpoints.set(debugCore, { entries, native, issued });
            debugCore = index;
            Object.assign(dataBreakpoints, coreBreakpoints.get(index) || { entries: [], native: [], issued: {} });
            stopEpoch++;
            notify({ action: "debugSessionChanged", id: debugScope() });
            notify({ action: "debugCoreSelected", core: index });
            dataBreakpointsChanged(false);
        }

        function sendDebugStatus() {
            send(rtosStatus());
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
            var previousState = chipState;
            chipState = next;
            if (previousState !== next || next === "halted" || settings.ended) writeContext += 1;
            if (next === "halted") stopEpoch += 1;
            if (typeof settings.file === "string" && settings.file) targetFile = settings.file;
            else if (Number.isInteger(settings.line)) targetFile = "main.c";
            if (Number.isInteger(settings.line)) targetLine = settings.line;
            debugState = settings.ended ? "none" : next === "halted" ? "paused" : "running";
            if (settings.ended) yieldRtt("debug");
            if (next === "running" && !settings.starting) simulator.boot();
            if (settings.step) simulator.tick();
            sendChipState();
            if (settings.ended) notify({ action: "debugSessionChanged" });
            if (samplingIntent) {
                if (settings.ended) {
                    setPhase("restoring");
                    phaseTimer = setTimeout(function () {
                        phaseTimer = null;
                        setPhase("sampling");
                    }, 600);
                } else if (settings.starting) setPhase("debug-waiting");
                else if (next === "running") resumeRuntimeSampling();
                else readSnapshot();
            } else {
                if (settings.ended) setPhase("stopped");
                else setPhase("debug-disabled");
            }
            // A halted target prints nothing over RTT; the panel follows.
            if (rtt.state === "running") postRttStatus();
            updateRttHost(!settings.ended && previousState !== next && debugState !== "none");
            dataBreakpointsChanged(settings.ended);
            if (settings.notify !== false) notify({ action: "targetState", state: next });
        }

        function flashNotice(notice) {
            send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: notice });
        }

        function queueFlash(delay, callback) {
            flashTimers.push(setTimeout(callback, delay));
        }

        function finishFlash(cmd, resume, lines) {
            flashRunning = false;
            flashTimers = [];
            chipState = "running";
            simulator.reset();
            simulator.boot();
            sendChipState();
            setDebugPending(false);
            notify({ action: "flashLog", lines });
            flashNotice({ level: "success", key: "msg.downloadSuccess" });
            send({ type: "commandSuccess", cmd });
            if (resume) startSampling();
            else updateRttHost();
        }

        // The real run: each step matches what src/openocdRunner.js prints to the terminal and
        // forwards to the sidebar notice (src/services/flashCommand.js).
        function simulateDownload(cmd) {
            if (flashRunning) {
                flashNotice({ level: "warning", key: "msg.downloadBusy" });
                send({ type: "commandError", cmd });
                return;
            }
            if (debugStarting || debugState !== "none") {
                flashNotice({ level: "warning", key: "msg.debugBusyForDownload" });
                send({ type: "commandError", cmd });
                return;
            }
            if (!requireProbe(cmd, "notice.downloadFailed")) return;
            send({ type: "noticeClear", area: "flash", id: cmd });
            send({ type: "noticeClear", area: "flash", id: "mcu-vscode.debug" });
            send({ type: "noticeClear", area: "flash", id: "mcu-vscode.attachDebug" });
            var resume = samplingIntent;
            if (resume) stopSampling();
            flashRunning = true;
            yieldRtt("download");
            setDebugPending(true);
            var elf = configuration.values.elf.replace(/\\/g, "/");
            const { debugger: probe, mcu: target } = configuration.values;
            const cmsisDap = probe === "cmsis-dap.cfg";
            const probeDescription = cmsisDap
                ? "Using CMSIS-DAPv2 interface with VID:PID=0x1209:0xda42, serial=202008431041543838597586"
                : "J-Link V11 compiled Nov 24 2024 10:12:05";
            const baseClock = cmsisDap ? "1800 kHz" : "4000 kHz";
            const flashClock = cmsisDap ? "10000 kHz" : "15000 kHz";
            const cmsisLines = cmsisDap
                ? [
                      "CMSIS-DAP: SWD supported",
                      "CMSIS-DAP: Atomic commands supported",
                      "CMSIS-DAP: Test domain timer supported",
                      "CMSIS-DAP: FW Version = 2.1.0",
                      "CMSIS-DAP: Serial# = 202008431041543838597586",
                      "CMSIS-DAP: Interface Initialised (SWD)",
                      "CMSIS-DAP: Interface ready"
                  ]
                : [];
            flashNotice({ level: "info", busy: true, key: "run.starting" });
            queueFlash(180, () => {
                notify({
                    action: "flashLog",
                    start: true,
                    lines: [
                        { cls: "info", text: say("EmberProbe 固件下载", "EmberProbe firmware download") },
                        { cls: "", text: say("固件 ", "Firmware ") + elf },
                        { cls: "", text: say("探针 ", "Probe ") + probe + say(" · 目标 ", " · Target ") + target },
                        { cls: "", text: "" },
                        { cls: "", text: "→ " + probeDescription },
                        ...cmsisLines.map((line) => ({ cls: "", text: "→ " + line }))
                    ]
                });
            });
            var steps = [
                ...(cmsisDap
                    ? []
                    : [
                          {
                              at: 300,
                              key: "run.voltage",
                              params: { volts: "3.30" },
                              message: say("目标电压 3.30 V", "Target voltage 3.30 V")
                          }
                      ]),
                {
                    at: 420,
                    key: "run.adapterClock",
                    params: { clock: baseClock },
                    message: say("适配器时钟 " + baseClock, "Adapter clock " + baseClock)
                },
                {
                    at: 580,
                    key: "run.flashClock",
                    params: { clock: flashClock },
                    message: say("烧录时钟 " + flashClock, "Flash clock " + flashClock)
                },
                {
                    at: 720,
                    key: "run.chip",
                    params: { chip: "STM32F40x" },
                    message: say("识别芯片 STM32F40x", "Detected chip STM32F40x")
                },
                {
                    at: 820,
                    key: "run.flash",
                    params: { size: "1024 kbytes" },
                    message: say("Flash 容量 1024 kbytes", "Flash size 1024 kbytes")
                },
                { at: 960, key: "run.programStart", message: say("开始写入固件", "Writing firmware") },
                { at: 2460, key: "run.verifyStart", message: say("开始校验固件", "Verifying firmware") },
                { at: 2820, done: true, key: "run.verifyOk", message: say("固件校验通过", "Firmware verified") },
                { at: 2940, key: "run.resetTarget", message: say("正在复位目标芯片", "Resetting target") }
            ];
            steps.forEach(function (step) {
                queueFlash(step.at, function () {
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
                });
            });
            queueFlash(3200, function () {
                finishFlash(cmd, resume, [
                    { cls: "", text: "" },
                    { cls: "ok", text: say("✓ 固件下载并校验成功", "✓ Firmware downloaded and verified") },
                    { cls: "", text: say("  固件 ", "  Firmware ") + elf.split("/").pop() },
                    { cls: "", text: say("  芯片 STM32F40x", "  Chip STM32F40x") },
                    { cls: "", text: say("  Flash 容量 1024 kbytes", "  Flash size 1024 kbytes") },
                    { cls: "", text: say("  探针 ", "  Probe ") + probeDescription },
                    { cls: "", text: say("  时钟 ", "  Clock ") + baseClock },
                    { cls: "", text: say("  烧录时钟 ", "  Flash clock ") + flashClock },
                    {
                        cls: "",
                        text: say("  目标 ", "  Target ") + target + say(" · 探针配置 ", " · Probe script ") + probe
                    }
                ]);
            });
        }

        function simulateSvdDownload(cmd) {
            if (svdTimers.length) return;
            var percents = [8, 26, 51, 77, 94];
            function schedule(fn, delay) {
                svdTimers.push(setTimeout(fn, delay));
            }
            send({ type: "svdStatus", state: "downloading", key: "svd.downloading", percent: 0 });
            percents.forEach(function (percent, index) {
                schedule(
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
            schedule(
                function () {
                    send({ type: "svdStatus", state: "validating", key: "svd.validating", path: data.SVD_PATH });
                },
                300 + percents.length * 320
            );
            schedule(
                function () {
                    svdTimers = [];
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

        function cancelSvdDownload() {
            if (!svdTimers.length) return;
            svdTimers.forEach(clearTimeout);
            svdTimers = [];
            send({ type: "svdStatus", state: "idle", key: "svd.cancelled" });
            send({ type: "commandCancelled", cmd: "mcu-vscode.downloadOfficialSvd" });
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
            var clients = root.EmberProbeMockMcp.clients.map(function (client) {
                var state = client === "json" ? "manual" : mcpClientStates[client] || "notInstalled";
                return { client: client, state: state, actions: MCP_ACTIONS[state], files: [] };
            });
            clients.unshift({ client: "copilot", state: "builtin", actions: MCP_ACTIONS.builtin, files: [] });
            send({ type: "mcpClients", clients: clients, busy: mcpBusyClient });
        }

        function checkMcpConnection() {
            if (mcpCheckTimer !== null) return;
            const { serverName, tools } = root.EmberProbeMockMcp;
            const outcome = options.mcpOutcome;
            const request = (method) => {
                if (method === "initialize")
                    return outcome === "initialize" ? null : { serverInfo: { name: serverName } };
                if (method === "tools/list") return { tools: outcome === "tools" ? [] : tools };
            };
            mcpCheckTimer = setTimeout(
                () => {
                    mcpCheckTimer = null;
                    if (outcome === "timeout") return send({ type: "mcpConnection", state: "timeout" });
                    const init = request("initialize");
                    if (init?.serverInfo.name !== serverName)
                        return send({ type: "mcpConnection", state: "initialize" });
                    const count = request("tools/list").tools.length;
                    send({
                        type: "mcpConnection",
                        state: count ? "connected" : "tools",
                        ...(count ? { toolCount: count } : {})
                    });
                },
                outcome === "timeout" ? 10000 : 350
            );
        }

        function changeMcpClient(client, action) {
            if (mcpBusyClient) return;
            if (client === "json" && action === "copy") {
                copyText(root.EmberProbeMockMcp.snippet);
                sendMcpClients();
                return;
            }
            const actions = MCP_ACTIONS[mcpClientStates[client] || "notInstalled"];
            if (!root.EmberProbeMockMcp.clients.includes(client) || !actions?.includes(action)) return sendMcpClients();
            mcpBusyClient = client;
            sendMcpClients();
            setTimeout(() => {
                mcpClientStates[client] = action === "uninstall" ? "notInstalled" : "installed";
                mcpBusyClient = "";
                sendMcpClients();
            }, 350);
        }

        function handleCommand(message) {
            switch (message.type) {
                case "getMcpClients":
                    sendMcpClients();
                    break;
                case "checkMcpConnection":
                    checkMcpConnection();
                    break;
                case "mcpClientAction":
                    changeMcpClient(message.client, message.action);
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
                    if (message.fromWatch && message.writeContext !== writeContext) {
                        send({ type: "writeResult", ok: false, name: name, seq: seq, key: "sb.writeBindingChanged" });
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
                        chipRead = true;
                        sendChipState();
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
                case "memoryRefresh":
                    send(configuration.readMemory());
                    break;
                case "memorySelectSource":
                    configuration.selectMemory();
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
                    if (debugState === "paused") {
                        const result = data.rtosSnapshot(stopEpoch);
                        send(
                            debugCore === 0
                                ? result
                                : {
                                      ...result,
                                      sessionId: coreId(debugCore),
                                      tasks: result.tasks.slice(0, 2)
                                  }
                        );
                    } else
                        send(
                            Object.assign(rtosStatus(), {
                                type: "rtosError",
                                message: "暂停调试器后才能刷新 RTOS 任务"
                            })
                        );
                    break;
                case "debugSelectSession":
                    selectCore([coreId(0), coreId(1)].indexOf(message.sessionId));
                    sendDebugStatus();
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
                case "saveRuntimeExpansions":
                    expansions = message.expansions || {};
                    if (samplingPhase === "debug-ready") sendSamples();
                    break;
                case "saveSidebarWatch": {
                    var previousWatch = watchNames;
                    watchItems = message.items || [];
                    watchNames = (message.items || []).map(function (item) {
                        return item.name;
                    });
                    pruneDataBreakpoints(previousWatch, watchNames);
                    if (samplingPhase === "debug-ready") sendSamples();
                    break;
                }
                case "saveSidebarWrite":
                    writeItems = message.items || [];
                    writeNames = writeItems.map(function (item) {
                        return item.name;
                    });
                    if (samplingPhase === "debug-ready") sendSamples();
                    break;
                case "cancelSidebarWrite":
                    // Writes are immediate in the mock, so there is no queued value left to cancel.
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
                        publishProbes();
                        send({ type: "commandSuccess", cmd: "selectProbeDriver" });
                    }, 900);
                    break;
                case "selectConnectedProbe": {
                    const selected = message.deviceId
                        ? probes.find((probe) => probe.id === message.deviceId)
                        : probes.find((probe) => probe.defaultConfig === configuration.values.debugger);
                    if (message.deviceId && !selected) break;
                    selectedProbe = selected?.id;
                    probeAutomatic = !message.deviceId;
                    if (selected) configuration.values.debugger = selected.defaultConfig;
                    configuration.publish();
                    publishProbes();
                    send({ type: "commandSuccess", cmd: "selectConnectedProbe" });
                    break;
                }
                case "refreshConnectedProbes":
                    probesRead = true;
                    publishProbes();
                    break;
                case "acceptTargetChip":
                    publishProbes();
                    break;
                case "cancelSvdDownload":
                    cancelSvdDownload();
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
            }).map((channel) => {
                const setting = rttSettings.channels.find((entry) => entry.index === channel.index);
                const downChannel = setting?.down ?? channel.index;
                return {
                    ...channel,
                    mode: setting?.mode ?? channel.mode,
                    format: setting?.format ?? "text",
                    encoding: setting?.encoding ?? rttSettings.encoding,
                    downChannel,
                    down: RTT_FIRMWARE.find((item) => item.index === downChannel)?.down || 0
                };
            });
        }

        function postRttStatus() {
            var running = rtt.state === "running";
            var up = running
                ? rttUp().map(function (channel) {
                      const { index, name, mode, size, format, encoding, downChannel } = channel;
                      return { index, name, mode, size, format, encoding, downChannel };
                  })
                : [];
            send({
                type: "rttStatus",
                state: rtt.state,
                yieldedFor: rtt.yieldedFor,
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
                settings: rttSettings,
                logFile: rtt.logFile,
                targetRunning: chipState !== "halted",
                channels: running ? rttUp() : []
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
        function startRtt(reveal = true) {
            if (debugState !== "none" && debugCores > 1) {
                if (rtt.state !== "stopped") stopRtt();
                rttNotice("rtt", { level: "error", key: "rtt.err.multicore" });
                return;
            }
            rtt.intent = true;
            if (rtt.state === "running" || rtt.state === "starting") return;
            if (flashRunning || debugStarting || samplingPhase === "restoring") {
                yieldRtt(flashRunning ? "download" : "debug");
                return;
            }
            rttClearNotices();
            rtt.state = "starting";
            rtt.yieldedFor = null;
            postRttStatus();
            rtt.timer = setTimeout(function () {
                rtt.timer = null;
                if (stopped || rtt.state !== "starting") return;
                rtt.state = "running";
                rtt.listed = true;
                rtt.terminals = Math.max(rtt.terminals, rttUp().length);
                postRttStatus();
                if (reveal) notify({ action: "rttReveal", focus: false });
                if (!rtt.ticker) rtt.ticker = setInterval(rttTick, 1000);
            }, 500);
        }

        function setRttInactive(state) {
            if (rtt.timer) clearTimeout(rtt.timer);
            if (rtt.ticker) clearInterval(rtt.ticker);
            rtt.timer = rtt.ticker = null;
            if (rtt.state === state) return;
            rtt.state = state;
            postRttStatus();
        }

        function stopRtt() {
            rtt.intent = false;
            rtt.yieldedFor = null;
            setRttInactive("stopped");
        }

        function yieldRtt(command) {
            if (!rtt.intent) return;
            rtt.yieldedFor = command;
            setRttInactive("pending-host");
        }

        function updateRttHost(auto = false) {
            if (rtt.intent && rtt.state === "pending-host") startRtt(false);
            else if (
                auto &&
                rtt.state === "stopped" &&
                rttSettings.autoStart &&
                !rttSettings.channels.some((channel) => channel.mode)
            )
                startRtt(false);
        }

        function applyRttSettings(next) {
            const restart =
                rtt.state === "running" &&
                ["channels", "encoding", "virtualTerminals"].some(
                    (key) => JSON.stringify(next[key]) !== JSON.stringify(rttSettings[key])
                );
            if (next["logFile.raw"] !== rttSettings["logFile.raw"]) rtt.logFile = "";
            rttSettings = next;
            rtt.selected = next.channels.map((entry) => entry.index ?? entry).sort((a, b) => a - b);
            if (restart) {
                stopRtt();
                startRtt(false);
            } else postRttStatus();
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
                rttSettings = {
                    ...rttSettings,
                    channels: order.map((index) => rttSettings.channels.find((entry) => entry.index === index) ?? index)
                };
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
        function toggleRttLog(cmd) {
            if (rtt.logFile) {
                rtt.logFile = "";
                postRttStatus();
                send({ type: "commandSuccess", cmd });
                return;
            }
            const extension = rttSettings["logFile.raw"] ? ".bin" : ".log";
            const suggested = "rtt-" + fileStamp(Date.now()) + extension;
            const select = (name) => {
                if (name) {
                    rtt.logFile = RTT_LOG_DIR + "/" + name;
                    postRttStatus();
                }
                send({ type: name ? "commandSuccess" : "commandCancelled", cmd });
            };
            if (options.selectLogFile) options.selectLogFile(suggested, select);
            else select(suggested);
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
                sessionId: inSession ? "mock-debug-" + debugScope() : null,
                paused: debugState === "paused",
                epoch: stopEpoch,
                available: inSession && !debugStarting
            };
        }

        function dataGeneration() {
            return JSON.stringify([stopEpoch, data.VERSION]);
        }

        function verifiedBreakpoints() {
            var enabled = 0;
            return dataBreakpoints.entries
                .concat(dataBreakpoints.native)
                .sort((a, b) => a.order - b.order)
                .map(function (entry) {
                    var fits = entry.enabled && ++enabled <= DWT_COMPARATORS;
                    return Object.assign({}, entry, {
                        verified: fits,
                        message: entry.enabled && !fits ? tr("debug.dataBreakpointHardware") : ""
                    });
                });
        }

        function dataSnapshot() {
            return { generation: dataGeneration(), entries: verifiedBreakpoints().filter((entry) => !entry.native) };
        }

        function postDataBreakpoints(body) {
            send(Object.assign({ type: "sidebarDataBreakpoints" }, body || {}, dataStatus()));
            // VS Code's Breakpoints view lists them too (the debug sidebar in the shell).
            notify({ action: "dataBreakpoints", entries: verifiedBreakpoints() });
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
                dataBreakpoints.native = [];
                dataBreakpoints.issued = {};
                coreBreakpoints.clear();
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
                    return !dataBreakpoints.entries.concat(dataBreakpoints.native).some(function (entry) {
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
            var armed = verifiedBreakpoints().filter(function (entry) {
                return entry.verified && !(entry.accessType === "write" && entry.constant);
            });
            if (!armed.length) return;
            const before = new Map(
                simulator
                    .scalarSamples(
                        armed.map((entry) => entry.name),
                        Date.now()
                    )
                    .map((sample) => [sample.name, sample.value])
            );
            dataHitTimer = setTimeout(function () {
                dataHitTimer = null;
                if (stopped || debugState !== "running") return;
                simulator.tick();
                const hit = armed.find((entry) => conditionMatches(entry.condition));
                if (!hit) return scheduleDataHit();
                const next = simulator.scalarSamples([hit.name], Date.now())[0]?.value;
                notify({
                    action: "dataBreakpointHit",
                    name: hit.name,
                    accessType: hit.accessType,
                    oldValue: before.get(hit.name),
                    newValue: next
                });
            }, 700);
        }

        const conditionPattern = /^([\w.\[\]]+)\s*(>=|<=|==|!=|>|<)\s*(-?(?:\d+\.?\d*|\.\d+))$/;
        function conditionMatches(condition) {
            if (!condition) return true;
            const match = conditionPattern.exec(condition.trim());
            if (!match) return false;
            const [, name, operator, expected] = match;
            const actual = simulator.scalarSamples([name], Date.now())[0]?.value;
            if (!Number.isFinite(actual)) return false;
            const target = Number(expected);
            return {
                ">": actual > target,
                "<": actual < target,
                ">=": actual >= target,
                "<=": actual <= target,
                "==": actual === target,
                "!=": actual !== target
            }[operator];
        }

        function nativeBreakpoint(name, operation, value, identity = stopEpoch) {
            if (debugState !== "paused" || identity !== stopEpoch) return false;
            const entries = dataBreakpoints.native;
            if (operation === "add") {
                const info = dataInfo(name);
                if (!info.dataId || !info.accessTypes.includes(value)) return false;
                if (!entries.some((entry) => entry.dataId === info.dataId && entry.accessType === value)) {
                    const order = dataBreakpoints.nextId++;
                    entries.push({
                        id: "native:" + order,
                        order,
                        native: true,
                        name,
                        accessType: value,
                        dataId: info.dataId,
                        description: info.description,
                        constant: info.constant,
                        enabled: true,
                        condition: ""
                    });
                }
            } else {
                const entry = entries.find((entry) => entry.id === name);
                if (!entry) return false;
                if (operation === "remove") entries.splice(entries.indexOf(entry), 1);
                else if (operation === "condition") entry.condition = value;
            }
            postDataBreakpoints(dataSnapshot());
            return true;
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
                if (!duplicate) {
                    const order = dataBreakpoints.nextId++;
                    dataBreakpoints.entries.push({
                        id: String(order),
                        order,
                        name: message.name,
                        dataId: resolved.dataId,
                        accessType: message.accessType,
                        condition: "",
                        enabled: true,
                        constant: resolved.constant,
                        description: resolved.description
                    });
                }
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
            else if (cmd === "mcu-vscode.rttToggleTimestamps") {
                rtt.timestamps = !rtt.timestamps;
                postRttStatus();
            }
        }

        function handleExecute(cmd) {
            switch (cmd) {
                case "mcu-vscode.selectElf":
                case "mcu-vscode.selectDebugger":
                case "mcu-vscode.selectMcuCore":
                case "mcu-vscode.selectIoc":
                    configuration.select(cmd);
                    break;
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
                case "mcu-vscode.rttToggleTimestamps":
                    handleRtt(cmd);
                    send({ type: "commandSuccess", cmd: cmd });
                    break;
                case "mcu-vscode.rttSaveLog":
                    toggleRttLog(cmd);
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
                case "mcu-vscode.refreshCubeMxFirmware":
                    configuration.publish();
                    send({ type: "commandSuccess", cmd: cmd });
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
                    send({
                        type: "notice",
                        area: "global",
                        id: cmd,
                        notice: {
                            level: "error",
                            key: "msg.commandNotRegistered",
                            params: { cmd }
                        }
                    });
                    send({ type: "commandError", cmd: cmd });
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
                var entry = dataBreakpoints.entries.concat(dataBreakpoints.native).find(function (item) {
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
            nativeBreakpoint,
            nativeBreakpointInfo(name) {
                if (debugState !== "paused") return null;
                return { ...dataInfo(name), epoch: stopEpoch };
            },
            breakpointEpoch: () => stopEpoch,
            getWatchList: function () {
                return watchItems.slice();
            },
            readItems: () => readItems().concat(writeItems),
            applyRttSettings,
            selectCore,
            isLiveRunning: function () {
                return samplingIntent;
            },
            isInitialized: function () {
                return initialized;
            },
            destroy: function () {
                cancelDebugStart();
                flashTimers.forEach(clearTimeout);
                if (mcpCheckTimer !== null) clearTimeout(mcpCheckTimer);
                svdTimers.forEach(clearTimeout);
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
