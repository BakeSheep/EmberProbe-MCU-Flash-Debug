"use strict";

// Terminal UI for RTT: the "RTT 终端" view in VS Code's bottom panel (RttPanelHost), fed by cursor reads of the
// controller's channel buffer on an injected clock, formatted per channel (createRttFormatter: text, raw or hex, with
// optional host timestamps) and with an optional log file per channel, formatted or as received (RttLogWriter). With
// timestamps on, each socket chunk is read as it arrives, so its time is when the bytes reached the host and not the
// next poll tick. Each up channel keeps a bounded scrollback here, so the panel can be rebuilt whenever its page loads,
// and the panel gets what arrived since as one message per channel and read pass. The panel's input box sends a line
// plus the configured ending to the channel's down channel; raw input sends each keystroke as typed and leaves the
// echo to the firmware. The controller's statuses drive the lifecycle: the panel tab appears with the first start and
// stays for the window's life, channels pause with a notice line across yields and stay readable after RTT stops, with
// the reason as their last line; the next start reuses them.
//
// Failures reach the user once: the sidebar's notice box through onNotice, keyed by what they concern ("rtt" for the
// session, "rtt-log" for the log files, "rtt-channels" for the channel selection). Input problems stay in the panel,
// next to the box they were typed in.

const fs = require("fs");
const path = require("path");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { AnsiStripper, createRttFormatter } = require("../rttLineFormatter");
const { RttLogWriter } = require("./rttLogWriter");
const { MAX_SERVER_COMMANDS: MAX_CHANNELS } = require("../rttControl");

// Terminal responsiveness versus host wakeups; every read is a plain buffer access, so this stays cheap.
const POLL_INTERVAL_MS = 50;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READS_PER_TICK = 4;
// The input box's bound; the controller's write cap is the hard safety net behind it.
const MAX_INPUT_BYTES = 1022; // Reserve room for the longest line ending in the controller's 1024-byte cap.
const MAX_WRITE_BYTES = 1024;
const LINE_ENDINGS = Object.freeze({ lf: "\n", crlf: "\r\n", cr: "\r", none: "" });
const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;

const RTT_ERROR_KEYS = Object.freeze({
    RTT_MULTICORE_UNSUPPORTED: "rtt.err.multicore",
    PROBE_BUSY: "rtt.err.probeBusy",
    CONFIG_INCOMPLETE: "rtt.err.configIncomplete",
    OPENOCD_NOT_READY: "rtt.err.openocdMissing",
    RTT_START_TIMEOUT: "rtt.err.startTimeout",
    RTT_PORT_UNAVAILABLE: "rtt.err.portUnavailable",
    RTT_SCAN_RANGE_TOO_LARGE: "rtt.err.scanTooLarge",
    RTT_SCAN_TIMEOUT: "rtt.err.scanTimeout",
    RTT_CONTROL_BLOCK_AMBIGUOUS: "rtt.err.ambiguous",
    RTT_CONTROL_BLOCK_UNKNOWN: "rtt.err.blockUnknown",
    RTT_INVALID_ADDRESS: "rtt.err.invalidAddress",
    RTT_INVALID_RANGE: "rtt.err.invalidRange",
    RTT_INVALID_INTERVAL: "rtt.err.invalidInterval",
    RTT_PARSE_ERROR: "rtt.err.parse",
    RTT_CANCELLED: "rtt.err.cancelled",
    RTT_CHANNEL_DISCONNECTED: "rtt.err.channelDisconnected",
    RTT_STREAM_STALLED: "rtt.err.streamStalled",
    RTT_WRITE_TOO_LARGE: "rtt.err.writeTooLarge",
    RTT_NOT_RUNNING: "rtt.err.notRunning",
    RTT_DISCONNECTED: "rtt.err.hostLost",
    RTT_UNKNOWN_CHANNEL: "rtt.err.unknownChannel",
    RTT_INPUT_UNAVAILABLE: "rtt.inputUnavailable",
    RTT_INPUT_BUSY: "rtt.err.inputBusy",
    RTT_INVALID_CHANNELS: "rtt.err.invalidChannels",
    RTT_EXACT_ADDRESS_REQUIRED: "rtt.err.exactAddressRequired",
    RTT_TARGET_INVALID: "rtt.err.targetInvalid",
    RTT_MODE_REQUIRES_UI_START: "rtt.err.modeRequiresUiStart",
    RTT_MODE_TARGET_CHANGED: "rtt.err.modeTargetChanged",
    RTT_ACCESS_UNSUPPORTED: "rtt.err.accessUnsupported",
    RTT_CHANNEL_UNINITIALIZED: "rtt.err.unknownChannel",
    RTT_INVALID_LAYOUT: "rtt.err.targetInvalid",
    RTT_READ_FAILED: "rtt.err.targetInvalid",
    RTT_VALUE_CHANGED: "rtt.err.targetChanged",
    RTT_IDENTITY_CHANGED: "rtt.err.targetChanged",
    RTT_READBACK_MISMATCH: "rtt.err.modeVerifyFailed",
    RTT_WRITE_FAILED: "rtt.err.modeVerifyFailed",
    RTT_TARGET_BUDGET_EXCEEDED: "rtt.err.targetBudget",
    LIVE_READ_BUDGET_EXCEEDED: "rtt.err.targetBudget",
    PROBE_CONNECTION_BUSY_TIMEOUT: "rtt.err.targetBudget",
    LIVE_READ_CANCELLED: "rtt.err.cancelled"
});

const clampLogBytes = (value) => {
    if (!Number.isSafeInteger(value) || value < 4) return DEFAULT_LOG_MAX_BYTES;
    return Math.min(value, 1024 * 1024 * 1024);
};

// The size of the down buffer behind an up channel's input, if the firmware configured one.
const downSize = (status, channel) => {
    const index = channel.downChannel ?? channel.index;
    return (status?.channels?.down || []).find((entry) => entry.index === index)?.size || 0;
};

const MAX_HISTORY = 100;
// Text kept per channel for rebuilding the panel; older rows are dropped at a line boundary.
const MAX_SCROLLBACK_CHARS = 1024 * 1024;

class RttTerminalService {
    // options: { vscode, clock, controller, t, settings, onNotice, clearNotice, post, panel }. controller() returns the
    // RttController; settings() returns { timestamps, logFile, logEnabled, logDirectory, logMaxBytes, stripAnsi, ... };
    // onNotice(notice, id) and clearNotice(id) address the sidebar's RTT notices; post reaches the sidebar; panel()
    // returns the bottom panel view: { post(message), ensureVisible(), reveal(preserveFocus) }.
    constructor({
        vscode,
        clock = undefined,
        controller,
        t,
        settings,
        onNotice,
        clearNotice = (_id) => {},
        post = (_message) => {},
        panel = () => null
    }) {
        this._vscode = vscode;
        this.clock = { ...SYSTEM_CLOCK, ...clock };
        this._controller = controller;
        this._t = t || ((key) => key);
        // The file the save button chose applies to this window only and overrides the logFile settings.
        this._logChoice = null;
        this._lastLogDirectory = null;
        const configured = settings || (() => ({}));
        this._settings = () => this._withLogChoice(configured());
        this._onNotice = onNotice || (() => {});
        this._clearNotice = clearNotice;
        this._post = post;
        this._panel = panel;
        this._status = { state: "stopped" };
        this._history = new Map(); // up channel index -> lines sent, oldest first
        this._channels = new Map(); // up channel index -> entry, including stopped entries kept for their text
        this._timer = null;
        this._paused = false;
        this._failureNoticed = null; // The code a failed start already reported through its status.
        this._warnedError = null;
        this._warnedMissing = "";
    }

    get state() {
        return this._status?.state || "stopped";
    }

    // Starts RTT and reveals the panel; starting an already running attachment only reveals it. A failure is reported
    // here, once, whichever path it arrived on, so callers get false and report nothing further.
    async startCommand() {
        return this._startCommand("user");
    }

    // Agent callers share panel/card/notice updates but must receive the original failure.
    async startAgentCommand() {
        return this._startCommand("agent");
    }

    // A session appeared and automatic start is on; failures reach the sidebar like a manual start's.
    async startAutoCommand() {
        return this._startCommand("auto");
    }

    async _startCommand(origin) {
        this._failureNoticed = null;
        for (const id of ["rtt", "rtt-channels", "rtt-log"]) this._clearNotice(id);
        let status;
        try {
            status = await this._controller().start({ origin });
        } catch (error) {
            if (this._failureNoticed !== error?.code)
                this._notice({ level: "error", titleKey: "notice.rttStartFailed", error: this._withErrorKey(error) });
            if (origin === "agent") throw error;
            return false;
        }
        this.sync(status, origin !== "auto");
        return status;
    }

    async stopCommand() {
        await this._controller().stop(); // The stopped status notes the end in the panel.
    }

    postStatus(post = this._post) {
        post(rttStatusMessage(this._controller().status(), this._view()));
    }

    async toggleTimestamps() {
        const config = this._vscode.workspace.getConfiguration("emberprobe");
        await config.update("rtt.timestamps", !config.get("rtt.timestamps", false), this._configurationTarget());
        this.settingsChanged();
    }

    // While saving, the button stops. Otherwise every start asks for the file, offering a timestamped name in the
    // folder used last; the choice is not written to the settings, so the next start asks again.
    async saveLog() {
        const config = this._vscode.workspace.getConfiguration("emberprobe");
        if (this._logChoice || config.get("rtt.logFile.enabled", false)) {
            this._logChoice = null;
            if (config.get("rtt.logFile.enabled", false))
                await config.update("rtt.logFile.enabled", false, this._configurationTarget());
            this.settingsChanged();
            return false;
        }
        const settings = this._settings();
        const raw = settings.logRaw === true;
        const folder = this._lastLogDirectory || settings.logDirectory || "";
        const name = `rtt-${fileStamp(this.clock.now())}.${raw ? "bin" : "log"}`;
        const uri = await this._vscode.window.showSaveDialog({
            defaultUri: folder ? this._vscode.Uri.file(path.join(folder, name)) : undefined,
            filters: raw
                ? { [this._t("rtt.logFilterRaw")]: ["bin"] }
                : { [this._t("rtt.logFilterText")]: ["log", "txt"] },
            saveLabel: this._t("rtt.saveLog"),
            title: this._t("rtt.saveLogDialogTitle")
        });
        if (!uri?.fsPath) return false;
        // The dialog already confirmed replacing an existing file, so the log starts empty instead of appending.
        try {
            fs.rmSync(uri.fsPath, { force: true });
        } catch {
            /* The writer reports a path it cannot use. */
        }
        this._logChoice = uri.fsPath;
        this._lastLogDirectory = path.dirname(uri.fsPath);
        this.settingsChanged();
        return true;
    }

    _withLogChoice(settings) {
        if (!this._logChoice) return settings;
        return {
            ...settings,
            logEnabled: true,
            logFile: this._logChoice,
            logDirectory: path.dirname(this._logChoice)
        };
    }

    // Picks the up channels to read from what the firmware listed last plus the configured ones. Configured entries
    // keep their object options; a running attachment restarts so the new set applies.
    async selectChannels() {
        const config = this._vscode.workspace.getConfiguration("emberprobe");
        const configured = channelEntries(config.get("rtt.channels", [0]));
        const firmware = new Map((this._controller().status()?.firmwareChannels || []).map((ch) => [ch.index, ch]));
        const selected = new Set(configured.map((entry) => entry.index));
        const indices = [...new Set([...firmware.keys(), ...selected])].sort((a, b) => a - b);
        const items = indices.map((index) => {
            const channel = firmware.get(index);
            return {
                label: this._t("rtt.channelPick", { n: index }),
                description: channel
                    ? channel.name || this._t("rtt.channelDefault")
                    : firmware.size
                      ? this._t("rtt.channelNotListed")
                      : "",
                detail: channel?.size ? this._t("rtt.channelSize", { size: channel.size }) : undefined,
                picked: selected.has(index),
                index
            };
        });
        const other = { label: this._t("rtt.channelOther"), alwaysShow: true, other: true };
        const picked = await this._vscode.window.showQuickPick([...items, other], {
            canPickMany: true,
            title: this._t("rtt.channelsTitle"),
            placeHolder: this._t(firmware.size ? "rtt.channelsPlaceholder" : "rtt.channelsPlaceholderUnknown")
        });
        if (!picked) return false;
        const next = new Set(picked.filter((item) => !item.other).map((item) => item.index));
        if (picked.some((item) => item.other)) {
            const typed = await this._vscode.window.showInputBox({
                title: this._t("rtt.channelsTitle"),
                prompt: this._t("rtt.channelOtherPrompt"),
                validateInput: (value) => (parseTypedChannels(value) ? null : this._t("rtt.channelOtherInvalid"))
            });
            if (typed === undefined) return false;
            for (const index of parseTypedChannels(typed)) next.add(index);
        }
        this._clearNotice("rtt-channels");
        if (!next.size || next.size > MAX_CHANNELS) {
            this._notice(
                {
                    level: "warning",
                    key: next.size ? "rtt.channelsTooMany" : "rtt.channelsNone",
                    params: { max: MAX_CHANNELS }
                },
                "rtt-channels"
            );
            return false;
        }
        const order = [...next].sort((a, b) => a - b);
        if (order.length === selected.size && order.every((index) => selected.has(index))) return true;
        const kept = new Map(configured.map((entry) => [entry.index, entry.raw]));
        await config.update(
            "rtt.channels",
            order.map((index) => kept.get(index) ?? index),
            this._configurationTarget()
        );
        this._postStatus();
        if (this.state !== "stopped") {
            await this.stopCommand();
            await this.startCommand();
        }
        return true;
    }

    _configurationTarget() {
        return this._vscode.workspace.workspaceFolders?.length
            ? this._vscode.ConfigurationTarget.Workspace
            : this._vscode.ConfigurationTarget.Global;
    }

    // Brings the panel to the front; reports when there is nothing to show yet.
    showTerminals() {
        if (!this._channels.size) {
            const waiting = this.state === "starting" || this.state === "pending-host";
            this._notice(
                waiting
                    ? { level: "info", key: "rtt.terminalsPending" }
                    : { level: "warning", key: "rtt.err.notRunning" }
            );
            return false;
        }
        this._callPanel((panel) => panel.reveal(false));
        return true;
    }

    // Applies the current status and optionally brings the panel to the front without taking focus.
    sync(status, reveal = false) {
        this.onStatus(status);
        if (reveal) this._callPanel((panel) => panel.reveal(true));
    }

    onStatus(status) {
        const previous = this.state;
        this._status = status || { state: "stopped" };
        const state = this.state;
        if (state !== "stopped") this._callPanel((panel) => panel.ensureVisible());
        if (state === "running") {
            this._paused = false;
            if (previous !== "running") this._enterRunning();
            this._syncChannels(this._status);
            this._warnRunning();
            this._ensureTick();
        } else {
            this._stopTick();
            if (state !== "stopped") this._notePaused();
            else if (previous !== "stopped") this._enterStopped();
        }
        this._flushPanel();
        this._postStatus();
    }

    _postStatus() {
        this._post(rttStatusMessage(this._status, this._view()));
        this._postPanel(this._panelStatus());
    }

    // What the sidebar shows besides the controller's status.
    _view() {
        const settings = this._settings();
        return {
            selectedChannels: channelEntries(settings.channels ?? [0]).map((entry) => entry.index),
            terminals: this._channels.size,
            timestamps: settings.timestamps === true,
            log: {
                enabled: settings.logEnabled === true,
                directory: settings.logDirectory || "",
                file: settings.logEnabled === true ? settings.logFile || "" : ""
            }
        };
    }

    // What the panel shows besides each channel's text.
    _panelStatus() {
        return {
            type: "rttPanelStatus",
            state: this.state,
            inputMode: this._settings().inputMode === "raw" ? "raw" : "line",
            history: Object.fromEntries(this._history),
            channels: [...this._channels.values()].map((entry) => ({
                index: entry.channel,
                name: entry.name,
                active: entry.active,
                hasInput: entry.down > 0
            }))
        };
    }

    // Everything the panel needs when its page (re)loads: the status and each channel's scrollback.
    panelSnapshot() {
        const status = this._panelStatus();
        const text = new Map([...this._channels.values()].map((entry) => [entry.channel, entry.scrollback]));
        return {
            ...status,
            type: "rttPanelSnapshot",
            channels: status.channels.map((channel) => ({ ...channel, text: text.get(channel.index) || "" }))
        };
    }

    // The panel cleared what it shows of a channel; a reload must not bring it back.
    clearChannel(channel) {
        const entry = this._channels.get(channel);
        if (!entry) return;
        entry.scrollback = "";
        entry.pending = "";
    }

    _active() {
        return [...this._channels.values()].filter((entry) => entry.active);
    }

    // A new attachment starts: channels it no longer has drop out of the panel.
    _enterRunning() {
        this._clearNotice("rtt");
        this._clearNotice("rtt-channels");
        this._warnedError = null;
        this._warnedMissing = "";
        const live = new Set((this._status.channels?.up || []).map((channel) => channel.index));
        for (const entry of [...this._channels.values()])
            if (!entry.active && !live.has(entry.channel)) this._disposeEntry(entry);
        this._warnLogTarget(this._settings());
    }

    // Conditions of a live attachment, each reported when it appears.
    _warnRunning() {
        const error = this._status.error;
        if (error && error.code !== this._warnedError)
            this._notice({ level: "warning", error: this._withErrorKey({ ...error }) });
        this._warnedError = error?.code || null;
        const missing = (this._status.missingChannels || []).join(", ");
        if (missing && missing !== this._warnedMissing)
            this._notice(
                { level: "warning", key: "rtt.channelsMissing", params: { channels: missing } },
                "rtt-channels"
            );
        this._warnedMissing = missing;
    }

    _enterStopped() {
        const { reason, error } = this._status;
        const note = this._stopNote();
        for (const entry of this._active()) this._stopEntry(entry, note);
        if (error) {
            this._failureNoticed = error.code;
            this._notice({
                level: "error",
                titleKey: reason === "start-failed" ? "notice.rttStartFailed" : "notice.rttStopped",
                error: this._withErrorKey({ ...error })
            });
        } else if (reason === "host-lost") {
            this._notice({ level: "warning", key: "rtt.err.hostLost" });
        }
    }

    // A channel's last words: why RTT ended, and the failure when there was one.
    _stopNote() {
        const { reason, error } = this._status;
        const key =
            reason === "host-ended"
                ? "rtt.termHostEnded"
                : reason === "host-lost"
                  ? "rtt.termHostLost"
                  : "rtt.termStopped";
        return this._t(key) + (error ? `\r\n${this._errorText(error)}` : "");
    }

    _errorText(error) {
        const key = RTT_ERROR_KEYS[error?.code];
        return key ? this._t(key, error.details) : String(error?.message || error);
    }

    // Live setting changes: timestamps apply to the running formatters, log changes reopen the writers and retry a
    // path that failed.
    settingsChanged() {
        const settings = this._settings();
        this._clearNotice("rtt-log");
        const active = this._active();
        for (const entry of active) {
            entry.formatter.setTimestamps(settings.timestamps === true);
            entry.logFailed = null;
            this._applyLog(entry, settings);
        }
        if (active.length) this._warnLogTarget(settings);
        this._postStatus();
    }

    // Saving was asked for, but there is no directory to resolve the log file in.
    _warnLogTarget(settings) {
        if (settings.logEnabled === true && !settings.logFile)
            this._notice({ level: "warning", key: "rtt.logNoDirectory" }, "rtt-log");
    }

    flush() {
        this._poll();
    }

    // Extension shutdown: no stop notes, the panel goes with the window.
    dispose() {
        this.flush();
        this._stopTick();
        this._status = { state: "stopped" };
        this._paused = false;
        for (const entry of [...this._channels.values()]) {
            if (entry.active) this._appendLog(entry, entry.formatter.flush());
            this._disposeEntry(entry);
        }
    }

    // Brings the channel set of the running attachment and the entries in line: new channels get an entry, stopped
    // entries resume where they left off, vanished channels stop, and a new buffer generation restarts its entry at the
    // attachment's first byte.
    _syncChannels(status) {
        const up = status.channels?.up || [];
        const live = new Set(up.map((channel) => channel.index));
        for (const entry of this._active())
            if (!live.has(entry.channel)) this._stopEntry(entry, this._t("rtt.termStopped"));
        const generations = new Map((status.buffers || []).map((buffer) => [buffer.channel, buffer.generation]));
        const settings = this._settings();
        for (const channel of up) {
            const entry = this._channels.get(channel.index) || this._createEntry(channel, status);
            entry.name = channel.name || "";
            entry.active = true;
            this._applyLog(entry, settings);
            entry.down = downSize(status, channel);
            const generation = generations.get(channel.index);
            if (generation === undefined) continue;
            const formatChanged = entry.format !== channel.format || entry.encoding !== channel.encoding;
            entry.format = channel.format;
            entry.encoding = channel.encoding;
            if (entry.generation !== undefined && entry.generation !== generation) {
                // A new attachment replaced the buffers; mark the boundary and read from its beginning.
                this._mark(entry, "rtt.termReattached");
                entry.formatter = this._newFormatter(entry);
            } else if (formatChanged) entry.formatter = this._newFormatter(entry);
            // A known generation starts at zero, even if its first poll follows an eviction.
            if (entry.generation !== generation) entry.cursor = 0;
            entry.generation = generation;
        }
    }

    _newFormatter({ channel, format, encoding }) {
        const settings = this._settings();
        return createRttFormatter({
            format,
            encoding,
            timestamps: settings.timestamps === true,
            virtualTerminals: channel === 0 && settings.virtualTerminals !== false,
            clock: this.clock
        });
    }

    _createEntry(channel, status) {
        const entry = {
            channel: channel.index,
            name: channel.name || "",
            down: downSize(status, channel),
            format: channel.format,
            encoding: channel.encoding,
            formatter: null,
            generation: undefined,
            cursor: undefined,
            ansi: new AnsiStripper(),
            active: true,
            log: null,
            logFailed: null,
            scrollback: "",
            pending: ""
        };
        entry.formatter = this._newFormatter(entry);
        this._channels.set(entry.channel, entry);
        return entry;
    }

    // Keeps the writer unless its target changed. A path that failed stays off until the settings change or RTT
    // restarts, so the statuses of a running attachment do not retry and re-report it.
    _applyLog(entry, settings) {
        const file = this._logFileFor(entry.channel, settings);
        const maxBytes = clampLogBytes(settings.logMaxBytes);
        if (file && file === entry.logFailed) return;
        const raw = settings.logRaw === true;
        if (entry.log && entry.log.file === file && entry.log.maxBytes === maxBytes && entry.log.raw === raw) return;
        entry.log?.close();
        entry.log = null;
        entry.ansi.reset();
        if (!file) return;
        const log = new RttLogWriter({
            maxBytes,
            raw,
            onError: (error) => {
                entry.logFailed = file;
                if (entry.log === log) entry.log = null;
                this._notice(
                    {
                        level: "error",
                        key: "rtt.logFailed",
                        params: { file: path.basename(file) || "?" },
                        error: this._withErrorKey(error)
                    },
                    "rtt-log"
                );
            }
        });
        entry.log = log;
        log.open(file);
    }

    // One channel logs to the configured path; with several up channels each file gets "-chN" before the extension.
    _logFileFor(channel, settings) {
        const file = String(settings?.logFile || "").trim();
        if (!file) return null;
        const count = Math.max(this._active().length, this._status?.channels?.up?.length || 0);
        if (count <= 1) return file;
        const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
        const dot = file.lastIndexOf(".");
        return dot > separator ? `${file.slice(0, dot)}-ch${channel}${file.slice(dot)}` : `${file}-ch${channel}`;
    }

    _ensureTick() {
        if (this._timer !== null || this.state !== "running" || !this._active().length) return;
        this._timer = this.clock.schedule(() => {
            this._timer = null;
            this._poll();
            this._ensureTick();
        }, POLL_INTERVAL_MS);
    }

    _stopTick() {
        if (this._timer === null) return;
        this.clock.cancel(this._timer);
        this._timer = null;
    }

    _poll() {
        if (this.state !== "running") return;
        for (const entry of this._active()) if (!this._drain(entry)) break;
        this._flushPanel();
    }

    // Bytes reached the host: a timestamped line takes its time now rather than at the next tick.
    dataArrived(channel) {
        const entry = this._channels.get(channel);
        if (this.state !== "running" || !entry?.active || !entry.formatter.timestamps) return;
        this._drain(entry);
        this._flushPanel();
    }

    // Reads what arrived since the last drain; the bound keeps one channel from starving the others. False when RTT
    // left the running state mid-read: its status stops the tick.
    _drain(entry) {
        const controller = this._controller();
        for (let read = 0; read < MAX_READS_PER_TICK; read++) {
            let result;
            const hadCursor = entry.cursor !== undefined;
            try {
                result = controller.read(entry.channel, {
                    generation: entry.generation,
                    cursor: entry.cursor,
                    maxBytes: READ_CHUNK_BYTES
                });
            } catch {
                return false;
            }
            // A reset cannot quantify unread bytes in the old generation. Its retained start still tells us
            // exactly how much history the new generation evicted. Report both even without any payload.
            const reset = result.reset && hadCursor;
            const gap = result.droppedBytes || (reset ? result.cursor : 0);
            if (reset || gap) {
                const tail = entry.formatter.flush();
                this._emit(entry, tail);
                this._appendLog(entry, tail);
                entry.formatter = this._newFormatter(entry);
            }
            if (reset) this._mark(entry, "rtt.termReattached");
            if (gap) this._mark(entry, "rtt.termGap", { bytes: gap });
            entry.generation = result.generation;
            entry.cursor = result.nextCursor;
            if (result.data?.length) {
                if (entry.log?.raw) entry.log.appendBytes(result.data);
                const text = entry.formatter.push(result.data, result.cursor);
                this._emit(entry, text);
                this._appendLog(entry, text);
            }
            if (!result.more) break;
        }
        return true;
    }

    _remember(channel, line) {
        if (!line) return;
        const history = this._history.get(channel) ?? [];
        if (history[history.length - 1] !== line) history.push(line);
        if (history.length > MAX_HISTORY) history.shift();
        this._history.set(channel, history);
    }

    // Sends one line from the panel's input box to a channel's down buffer. OpenOCD drops what does not fit the down
    // buffer, so a line that cannot fit is refused rather than truncated. A sent line is echoed, dimmed, so the
    // transcript tells what went out. Returns { ok: true } or { ok: false, message } with the translated reason.
    sendInput(channel, line, { echo = true } = {}) {
        if (this.state !== "running") return { ok: false, message: this._t("rtt.err.notRunning") };
        const up = (this._status?.channels?.up || []).find((candidate) => candidate.index === channel);
        const down = up ? downSize(this._status, up) : 0;
        if (!down) return { ok: false, message: this._t("rtt.inputUnavailable", { channel }) };
        const text = String(line ?? "");
        const ending = LINE_ENDINGS[this._settings().inputLineEnding] ?? LINE_ENDINGS.lf;
        if (!text && !ending) return { ok: true };
        const bytes = Buffer.byteLength(text + ending, "utf8");
        const max = down - 1; // A ring buffer holds one byte less than its size.
        if (bytes > max) return { ok: false, message: this._t("rtt.inputTooLong", { bytes, max }) };
        try {
            this._controller().write(channel, text + ending);
        } catch (error) {
            return { ok: false, message: `${this._t("rtt.writeFailed")}: ${this._errorText(error)}` };
        }
        const entry = this._channels.get(channel);
        if (entry) {
            this._appendLog(entry, `${text}\r\n`);
            if (echo) this._emit(entry, `\x1b[2m> ${text}\x1b[0m\r\n`);
        }
        this._remember(channel, text);
        this._flushPanel();
        this._postStatus();
        return { ok: true };
    }

    // Keystrokes, including control characters, go out as typed. The firmware echoes what it wants shown.
    sendRaw(channel, data) {
        if (this.state !== "running") return { ok: false, message: this._t("rtt.err.notRunning") };
        const entry = this._channels.get(channel);
        if (!entry?.active || !entry.down) return { ok: false, message: this._t("rtt.inputUnavailable", { channel }) };
        const bytes = Buffer.from(String(data ?? ""), "utf8");
        const max = Math.min(entry.down - 1, MAX_WRITE_BYTES);
        if (bytes.length > max)
            return { ok: false, message: this._t("rtt.inputTooLong", { bytes: bytes.length, max }) };
        try {
            this._controller().write(channel, bytes);
        } catch (error) {
            return { ok: false, message: `${this._t("rtt.writeFailed")}: ${this._errorText(error)}` };
        }
        return { ok: true };
    }

    // The line ending the input box appends (emberprobe.rtt.input.lineEnding), for Agent text input.
    configuredLineEnding() {
        return LINE_ENDINGS[this._settings().inputLineEnding] ?? LINE_ENDINGS.lf;
    }

    // Agent input (rtt.write), already authorized. The same checks as the input box, but failures throw coded errors
    // for the Bridge. Text input is echoed and logged like a typed line, marked as coming from the Agent, so the user
    // sees in the panel what was sent; raw bytes are not echoed (the firmware echoes what it wants shown).
    /** @param {number} channel @param {Buffer} bytes @param {{ echo?: string }} [options] */
    writeAgentInput(channel, bytes, { echo = undefined } = {}) {
        const fail = (code, message, details) => Object.assign(new Error(message), { code, details });
        if (this.state !== "running") throw fail("RTT_NOT_RUNNING", "RTT is not running", { state: this.state });
        const up = (this._status?.channels?.up || []).find((candidate) => candidate.index === channel);
        if (!up) throw fail("RTT_UNKNOWN_CHANNEL", `RTT channel ${channel} is not available`, { channel });
        const down = downSize(this._status, up);
        if (!down) throw fail("RTT_INPUT_UNAVAILABLE", `RTT channel ${channel} has no down buffer`, { channel });
        const max = Math.min(down - 1, MAX_WRITE_BYTES); // A ring buffer holds one byte less than its size.
        if (bytes.length > max)
            throw fail("RTT_WRITE_TOO_LARGE", `RTT input of ${bytes.length} bytes exceeds ${max}`, {
                channel,
                bytes: bytes.length,
                maxBytes: max
            });
        const written = this._controller().write(channel, bytes);
        const entry = this._channels.get(channel);
        if (entry && typeof echo === "string") {
            this._appendLog(entry, `${echo}\r\n`);
            this._emit(entry, `\x1b[2m${this._t("rtt.agentInputEcho", { text: echo })}\x1b[0m\r\n`);
            this._flushPanel();
        }
        this._postStatus();
        return { bytes: written, maxBytes: max };
    }

    _notePaused() {
        const active = this._active();
        if (this._paused || !active.length) return;
        this._paused = true;
        for (const entry of active) this._emit(entry, `\r\n${this._t("rtt.termPending")}\r\n`);
    }

    // A session boundary shown in the panel and recorded in its log.
    _mark(entry, key, params = undefined) {
        const line = `\r\n${this._t(key, params)}\r\n`;
        entry.ansi.reset();
        this._emit(entry, line);
        if (!entry.log?.raw) entry.log?.append(line);
    }

    // RTT ended for this channel: what the formatter held goes out, and the channel stays readable with the reason as
    // its last line.
    _stopEntry(entry, note) {
        entry.active = false;
        const tail = entry.formatter.flush();
        this._appendLog(entry, tail);
        entry.log?.close();
        entry.log = null;
        entry.logFailed = null;
        entry.ansi.reset();
        this._emit(entry, `${tail}\r\n${note}\r\n`);
    }

    _disposeEntry(entry) {
        this._channels.delete(entry.channel);
        entry.active = false;
        entry.log?.close();
        entry.log = null;
    }

    // Keeps partial escape sequences across chunks so ANSI never leaks into plain-text logs.
    _appendLog(entry, text) {
        if (!entry.log || entry.log.raw) return;
        if (this._settings().stripAnsi === false) {
            entry.ansi.reset();
            entry.log.append(text);
        } else entry.log.append(entry.ansi.push(text));
    }

    // Output for the panel: kept in the scrollback and queued until the next flush.
    _emit(entry, text) {
        if (!text) return;
        entry.pending += text;
        let scrollback = entry.scrollback + text;
        if (scrollback.length > MAX_SCROLLBACK_CHARS) {
            const cut = scrollback.length - MAX_SCROLLBACK_CHARS;
            const line = scrollback.indexOf("\n", cut);
            scrollback = scrollback.slice(line >= 0 ? line + 1 : cut);
        }
        entry.scrollback = scrollback;
    }

    // One message per channel with what it gained since the last flush.
    _flushPanel() {
        for (const entry of this._channels.values()) {
            if (!entry.pending) continue;
            const text = entry.pending;
            entry.pending = "";
            this._postPanel({ type: "rttOutput", channel: entry.channel, text });
        }
    }

    _postPanel(message) {
        this._callPanel((panel) => panel.post(message));
    }

    // The panel is UI: its failures must not break the channel.
    _callPanel(action) {
        try {
            const panel = this._panel();
            if (panel) void Promise.resolve(action(panel)).catch(() => {});
        } catch {
            /* A panel that cannot be reached shows the scrollback when it loads. */
        }
    }

    _withErrorKey(error) {
        const key = error && typeof error === "object" ? RTT_ERROR_KEYS[error.code] : null;
        if (key && error.i18nKey === undefined) error.i18nKey = key;
        if (key && error.i18nParams === undefined) error.i18nParams = error.details;
        return error;
    }

    _notice(notice, id = "rtt") {
        try {
            this._onNotice(notice, id);
        } catch {
            /* A notice consumer must not break the service. */
        }
    }
}

// 2026-11-10 14:05:09 local time -> "20261110-140509".
function fileStamp(ms) {
    const date = new Date(ms);
    const two = (value) => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
        `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
    );
}

// The configured up channels as { index, raw }; malformed entries are left to the controller's validation.
function channelEntries(value) {
    return (Array.isArray(value) ? value : [])
        .map((raw) => ({ index: typeof raw === "object" && raw ? raw.index : raw, raw }))
        .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index <= 255);
}

// "1, 3" -> [1, 3]; anything else, including an empty list, is null.
function parseTypedChannels(value) {
    const parts = String(value || "")
        .split(/[\s,，]+/)
        .filter(Boolean);
    if (!parts.length || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    return parts.map(Number);
}

function rttStatusMessage(status, view) {
    return { type: "rttStatus", ...(status || {}), view };
}

module.exports = {
    MAX_INPUT_BYTES,
    MAX_WRITE_BYTES,
    POLL_INTERVAL_MS,
    RTT_ERROR_KEYS,
    RttTerminalService,
    rttStatusMessage
};
