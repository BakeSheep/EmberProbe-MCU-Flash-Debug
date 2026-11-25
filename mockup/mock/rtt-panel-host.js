/*
 * Mock extension host for the bottom panel's "RTT 终端" view (src/rttPanelView.js).
 * Plays the part of src/services/rttTerminalService.js: keeps each up channel's
 * scrollback, feeds the firmware's output while RTT runs and answers lines typed
 * into the input box with what the demo firmware's shell would print.
 */
(function (root) {
    "use strict";

    var MAX_SCROLLBACK = 256 * 1024;
    var MAX_HISTORY = 100;

    function createRttPanelHost(iframe, options) {
        options = options || {};
        var simulator = options.simulator;
        var tr =
            options.translate ||
            function (key) {
                return key;
            };
        var stopped = false;
        var ready = false;
        var state = "stopped";
        const { createRttFormatter, AnsiStripper } = root.EmberProbeMockRttFormatter;
        const bytes = (text) => Uint8Array.from(new TextEncoder().encode(text));
        let settings = root.EmberProbeMockRttSettings.defaults;
        let logFile = "";
        const logs = new Map();
        const rawInput = new Map();
        var targetRunning = true;
        var channels = new Map(); // up channel index -> { index, name, active, down, scrollback, lineStart, booted }
        var history = {};
        var timer = null;
        var ticks = 0;

        function send(message) {
            if (stopped || !iframe || !iframe.contentWindow) return;
            try {
                iframe.contentWindow.postMessage(message, "*");
            } catch (error) {
                /* ignore detached frames */
            }
        }

        function channelList(withText) {
            return Array.from(channels.values()).map(function (channel) {
                var item = {
                    index: channel.index,
                    name: channel.name,
                    active: channel.active,
                    hasInput: channel.down > 0
                };
                if (withText) item.text = channel.scrollback;
                return item;
            });
        }

        function panelStatus() {
            return {
                type: "rttPanelStatus",
                state: state,
                inputMode: settings["input.mode"],
                history: history,
                channels: channelList(false)
            };
        }

        function postStatus() {
            if (ready) send(panelStatus());
        }

        function append(channel, text) {
            channel.scrollback = (channel.scrollback + text).slice(-MAX_SCROLLBACK);
            if (ready) send({ type: "rttOutput", channel: channel.index, text: text });
        }

        function writeLog(channel, chunk) {
            if (!logFile || !chunk.length) return;
            let log = logs.get(channel.index);
            if (!log) {
                log = { chunks: [], length: 0, previous: null };
                logs.set(channel.index, log);
            }
            const max = settings["logFile.maxBytes"];
            for (let start = 0; start < chunk.length;) {
                if (log.length >= max) {
                    log.previous = log.chunks;
                    log.chunks = [];
                    log.length = 0;
                }
                const copy = chunk.slice(start, start + max - log.length);
                log.chunks.push(copy);
                log.length += copy.length;
                start += copy.length;
            }
        }

        function flushLogs() {
            for (const [index, log] of logs) {
                const name = logFile.split(/[\\/]/).at(-1);
                const file = logs.size > 1 ? name.replace(/(\.[^.]+)$/, "-ch" + index + "$1") : name;
                if (log.previous) options.saveLog?.(file + ".1", log.previous);
                options.saveLog?.(file, log.chunks);
            }
            logs.clear();
        }

        function emit(channel, text) {
            const chunk = typeof text === "string" ? bytes(text) : text;
            const rendered = channel.formatter.push(chunk, channel.offset);
            channel.offset += chunk.length;
            if (settings["logFile.raw"]) writeLog(channel, chunk);
            else if (logFile)
                writeLog(channel, bytes(settings["logFile.stripAnsi"] ? channel.ansi.push(rendered) : rendered));
            if (rendered) append(channel, rendered);
        }

        function sample(name) {
            if (!simulator) return 0;
            var item = simulator.scalarSamples([name], Date.now())[0];
            return item ? Number(item.value) : 0;
        }

        function boot(channel) {
            if (channel.booted) return;
            channel.booted = true;
            if (channel.index === 0)
                emit(
                    channel,
                    "\x1b[1;36mEmberProbe Demo\x1b[0m v1.4.2 (STM32F407, " +
                        tr("mock.rtt.built") +
                        " 2026-11-10)\r\n" +
                        "\x1b[32m[I]\x1b[0m clock: SYSCLK 168 MHz, HCLK 168 MHz\r\n" +
                        "\x1b[32m[I]\x1b[0m rtos: scheduler started, 6 tasks\r\n" +
                        "\x1b[32m[I]\x1b[0m shell: " +
                        tr("mock.rtt.helpHint") +
                        "\r\n"
                );
            else emit(channel, "trace: stream v2, 1 kHz tick\r\n");
        }

        // One 100 ms step of the demo firmware: a control log line each second, a late ADC warning now and
        // then, and the trace channel's task records. A halted target prints nothing.
        function tick() {
            if (state !== "running" || !targetRunning) return;
            ticks += 1;
            channels.forEach(function (channel) {
                if (!channel.active) return;
                if (channel.index === 0 && ticks % 10 === 0) {
                    // The firmware runs without sampling too: its log moves the shared simulation on.
                    if (simulator) simulator.tick();
                    emit(
                        channel,
                        "\x1b[32m[I]\x1b[0m ctrl: rpm=" +
                            Math.round(sample("g_motor_rpm")) +
                            " target=" +
                            Math.round(sample("g_target_rpm")) +
                            " temp=" +
                            sample("g_sensor_temp").toFixed(1) +
                            "°C\r\n"
                    );
                }
                if (channel.index === 0 && ticks % 70 === 35)
                    emit(
                        channel,
                        "\x1b[33m[W]\x1b[0m adc: DMA half-transfer late by " + (40 + (ticks % 7) * 9) + " us\r\n"
                    );
                if (channel.index === 1 && ticks % 5 === 0)
                    emit(
                        channel,
                        "t=" +
                            pad(ticks * 100, 7) +
                            " ControlTask dt=" +
                            (998 + (ticks % 5)) +
                            "us SensorTask dt=" +
                            (4995 + (ticks % 11)) +
                            "us\r\n"
                    );
            });
        }

        function ensureTimer() {
            if (state === "running" && !timer) timer = setInterval(tick, 100);
            if (state !== "running" && timer) {
                clearInterval(timer);
                timer = null;
            }
        }

        // The sidebar host's RTT state: { state, channels: [{ index, name, down }], timestamps, targetRunning }.
        function sync(next) {
            next = next || {};
            if (next.logFile !== undefined && next.logFile !== logFile) {
                flushLogs();
                logFile = next.logFile;
            }
            settings = next.settings || settings;
            targetRunning = next.targetRunning !== false;
            var nextState = next.state || "stopped";
            if (nextState === "running") {
                var wanted = new Set();
                (next.channels || []).forEach(function (item) {
                    wanted.add(item.index);
                    var channel = channels.get(item.index);
                    if (!channel) {
                        channel = {
                            index: item.index,
                            scrollback: "",
                            booted: false,
                            ansi: new AnsiStripper()
                        };
                        channels.set(item.index, channel);
                    }
                    channel.name = item.name || "";
                    channel.down = item.down || 0;
                    channel.downChannel = item.downChannel ?? item.index;
                    const format = item.format || "text";
                    const encoding = item.encoding || settings.encoding;
                    const virtualTerminals = settings.virtualTerminals && item.index === 0;
                    const formatKey = JSON.stringify([format, encoding, virtualTerminals]);
                    if (!channel.active || channel.formatKey !== formatKey) {
                        channel.formatter = createRttFormatter({ format, encoding, virtualTerminals });
                        channel.formatKey = formatKey;
                        channel.offset = 0;
                    }
                    channel.formatter.setTimestamps(next.timestamps === true);
                    channel.active = true;
                });
                channels.forEach(function (channel) {
                    if (!wanted.has(channel.index)) channels.delete(channel.index);
                });
                // Keep the tab order of the real view: ascending channel index.
                channels = new Map(
                    Array.from(channels.entries()).sort(function (a, b) {
                        return a[0] - b[0];
                    })
                );
            } else if (state === "running") {
                channels.forEach(function (channel) {
                    if (channel.active) stopChannel(channel, nextState);
                });
            }
            var started = nextState === "running" && state !== "running";
            state = nextState;
            postStatus();
            if (started)
                channels.forEach(function (channel) {
                    if (channel.active) boot(channel);
                });
            ensureTimer();
        }

        function stopChannel(channel, nextState) {
            channel.active = false;
            const tail = channel.formatter.flush();
            if (tail) append(channel, tail);
            const note = nextState === "pending-host" ? "rtt.termPending" : "rtt.termStopped";
            append(channel, "\r\n" + tr(note) + "\r\n");
            rawInput.clear();
            channel.lineStart = true;
        }

        function remember(index, line) {
            if (!line) return;
            var sent = history[index] || [];
            if (sent[sent.length - 1] !== line) sent.push(line);
            if (sent.length > MAX_HISTORY) sent.shift();
            history[index] = sent;
        }

        // What the demo firmware's shell answers on channel 0.
        function reply(channel, line) {
            var words = line.trim().split(/\s+/);
            var command = (words[0] || "").toLowerCase();
            if (!command) return;
            if (command === "help")
                return emit(
                    channel,
                    "commands:\r\n  help            " +
                        tr("mock.rtt.cmdHelp") +
                        "\r\n  status          " +
                        tr("mock.rtt.cmdStatus") +
                        "\r\n  rpm <0-3000>    " +
                        tr("mock.rtt.cmdRpm") +
                        "\r\n  version         " +
                        tr("mock.rtt.cmdVersion") +
                        "\r\n"
                );
            if (command === "status")
                return emit(
                    channel,
                    "rpm=" +
                        Math.round(sample("g_motor_rpm")) +
                        " target=" +
                        Math.round(sample("g_target_rpm")) +
                        " bus=" +
                        sample("g_bus_voltage").toFixed(2) +
                        "V errors=" +
                        Math.round(sample("g_error_count")) +
                        "\r\n"
                );
            if (command === "version") return emit(channel, "EmberProbe Demo v1.4.2 (gcc 13.3.1)\r\n");
            if (command === "rpm") {
                var value = Number(words[1]);
                if (!Number.isInteger(value) || value < 0 || value > 3000)
                    return emit(channel, "\x1b[31mrpm: expected 0-3000\x1b[0m\r\n");
                if (simulator) simulator.write("g_target_rpm", value);
                return emit(channel, "target rpm = " + value + "\r\n");
            }
            emit(channel, "\x1b[31munknown command: " + command + "\x1b[0m (try 'help')\r\n");
        }

        // src/services/rttTerminalService.js sendInput: refused when it cannot reach a down buffer or does not fit.
        function sendInput(index, text, raw) {
            if (state !== "running") return { ok: false, message: tr("rtt.err.notRunning") };
            var channel = channels.get(index);
            if (!channel || !channel.active || !channel.down)
                return { ok: false, message: tr("rtt.inputUnavailable", { channel: index }) };
            const ending = root.EmberProbeMockRttSettings.endings[settings["input.lineEnding"]];
            const data = raw ? text : text + ending;
            const length = bytes(data).length;
            const max = Math.min(channel.down - 1, 1024);
            if (length > max) return { ok: false, message: tr("rtt.inputTooLong", { bytes: length, max }) };
            if (!raw) {
                append(channel, "\x1b[2m> " + text + "\x1b[0m\r\n");
                if (logFile && !settings["logFile.raw"]) writeLog(channel, bytes(text + "\r\n"));
                remember(index, text);
                postStatus();
            }
            if (targetRunning && channel.downChannel === 0) {
                const lines = ((rawInput.get(0) || "") + data).split(/\r\n|\r|\n/);
                rawInput.set(0, lines.pop().slice(-channel.down));
                const terminal = channels.get(0);
                for (const line of lines)
                    setTimeout(() => {
                        if (!stopped && terminal?.active) reply(terminal, line);
                    }, 40);
            }
            return { ok: true };
        }

        // Everything the page needs when it (re)loads; from then on it takes output as it comes.
        function sendSnapshot() {
            ready = false;
            send({
                type: "rttPanelSnapshot",
                state: state,
                inputMode: settings["input.mode"],
                history: history,
                channels: channelList(true)
            });
            ready = true;
        }

        function handle(message) {
            switch (message.type) {
                case "ready":
                    sendSnapshot();
                    break;
                case "rttSend": {
                    var valid =
                        Number.isSafeInteger(message.channel) &&
                        message.channel >= 0 &&
                        message.channel <= 255 &&
                        typeof message.text === "string" &&
                        !/[\x00-\x1f\x7f]/.test(message.text) &&
                        bytes(message.text).length <= 1022;
                    var result = valid
                        ? sendInput(message.channel, message.text)
                        : { ok: false, message: tr("rtt.input.invalid") };
                    send({ type: "rttSendResult", id: message.id, ok: result.ok, message: result.message });
                    break;
                }
                case "rttSendRaw": {
                    const { channel, data } = message;
                    const valid =
                        Number.isInteger(channel) &&
                        channel >= 0 &&
                        channel <= 255 &&
                        typeof data === "string" &&
                        data.length &&
                        bytes(data).length <= 1024;
                    const result = valid
                        ? sendInput(channel, data, true)
                        : { ok: false, message: tr("rtt.input.invalid") };
                    if (!result.ok) send({ type: "rttInputProblem", channel, message: result.message });
                    break;
                }
                case "rttClear": {
                    var channel = channels.get(message.channel);
                    if (channel) channel.scrollback = "";
                    break;
                }
                default:
                    break;
            }
        }

        function onMessage(event) {
            if (stopped || !iframe || !iframe.contentWindow || event.source !== iframe.contentWindow) return;
            var payload = event.data;
            if (!payload || payload.__emberprobeMock !== true || !payload.message) return;
            handle(payload.message);
        }

        root.addEventListener("message", onMessage);

        return {
            sync: sync,
            setInputMode(next) {
                settings = next;
                postStatus();
            },
            // A page that loaded before this host listened has sent its ready already.
            sendSnapshot: sendSnapshot,
            isReady: function () {
                return ready;
            },
            // The page is rebuilt (language switch) and asks for its snapshot again.
            reload: function () {
                ready = false;
            },
            // The view/title clear button.
            clear: function () {
                send({ type: "rttClearRequest" });
            },
            hasChannels: function () {
                return channels.size > 0;
            },
            destroy: function () {
                stopped = true;
                if (timer) clearInterval(timer);
                timer = null;
                root.removeEventListener("message", onMessage);
            }
        };
    }

    root.EmberProbeRttPanelHost = { create: createRttPanelHost };
})(typeof window !== "undefined" ? window : globalThis);
