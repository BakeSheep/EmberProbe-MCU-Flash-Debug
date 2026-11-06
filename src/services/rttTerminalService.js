"use strict";

// Terminal UI for RTT: one VS Code pseudoterminal per up channel, fed by cursor reads of the controller's channel
// buffer on an injected clock, formatted per channel (createRttFormatter: text, raw or hex, with optional host
// timestamps) and with an optional log file per channel, formatted or as received (RttLogWriter). With timestamps on,
// each socket chunk is read as it arrives, so its time is when the bytes reached the host and not the next poll tick.
// Line input echoes printable characters locally and Enter sends the line plus the configured ending to the channel's
// down channel; raw input sends each keystroke as typed and leaves the echo to the firmware. The controller's statuses
// drive the lifecycle: terminals appear when an attachment runs, stay open across yields (paused with a notice line)
// and stay readable after RTT stops, with the reason as their last line; the next start reuses them. A terminal the
// user closed does not stop the channel; its cursor, formatter and log keep running, and a fresh terminal can be
// opened for the same entry at any time. Once stopped, closing a terminal removes its entry.
//
// Failures reach the user once: the sidebar's notice box through onNotice, keyed by what they concern ("rtt" for the
// session, "rtt-log" for the log files, "rtt-channels" for the channel selection). Line input problems stay in the
// terminal the user is typing in.

const path = require("path");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { AnsiStripper, createRttFormatter } = require("../rttLineFormatter");
const { RttLogWriter } = require("./rttLogWriter");

// Terminal responsiveness versus host wakeups; every read is a plain buffer access, so this stays cheap.
const POLL_INTERVAL_MS = 50;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READS_PER_TICK = 4;
// The line editor's bound; the controller's write cap is the hard safety net behind it.
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

const channelName = (channel) => `EmberProbe RTT #${channel.index}${channel.name ? ` ${channel.name}` : ""}`;

// East Asian wide and emoji ranges: these take two terminal cells, so erasing one takes two.
const WIDE_RANGES = [
    [0x1100, 0x115f],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f300, 0x1f64f],
    [0x1f900, 0x1f9ff],
    [0x20000, 0x3fffd]
];
const isWide = (char) => {
    const code = char.codePointAt(0);
    return WIDE_RANGES.some(([first, last]) => code >= first && code <= last);
};

class RttTerminalService {
    // options: { vscode, clock, controller, t, settings, onNotice, clearNotice, post }. controller() returns the
    // RttController; settings() returns { timestamps, logFile, logEnabled, logDirectory, logMaxBytes, stripAnsi };
    // onNotice(notice, id) and clearNotice(id) address the sidebar's RTT notices.
    constructor({
        vscode,
        clock = undefined,
        controller,
        t,
        settings,
        onNotice,
        clearNotice = (_id) => {},
        post = (_message) => {}
    }) {
        this._vscode = vscode;
        this.clock = { ...SYSTEM_CLOCK, ...clock };
        this._controller = controller;
        this._t = t || ((key) => key);
        this._settings = settings || (() => ({}));
        this._onNotice = onNotice || (() => {});
        this._clearNotice = clearNotice;
        this._post = post;
        this._status = { state: "stopped" };
        this._channels = new Map(); // up channel index -> entry, including stopped entries kept for their terminal
        this._timer = null;
        this._paused = false;
        this._failureNoticed = null; // The code a failed start already reported through its status.
        this._warnedError = null;
        this._warnedMissing = "";
    }

    get state() {
        return this._status?.state || "stopped";
    }

    // Starts RTT and reveals the terminals; starting an already running attachment only reveals them. A failure is
    // reported here, once, whichever path it arrived on, so callers get false and report nothing further.
    async startCommand() {
        return this._startCommand("user");
    }

    // Agent callers share terminal/card/notice updates but must receive the original failure.
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
        await this._controller().stop(); // The stopped status notes the end in the terminals.
    }

    postStatus(post = this._post) {
        post(rttStatusMessage(this._controller().status(), this._view()));
    }

    async toggleTimestamps() {
        const config = this._vscode.workspace.getConfiguration("emberprobe");
        await config.update("rtt.timestamps", !config.get("rtt.timestamps", false), this._configurationTarget());
        this.settingsChanged();
    }

    async saveLog() {
        const config = this._vscode.workspace.getConfiguration("emberprobe");
        if (config.get("rtt.logFile.enabled", false)) {
            await config.update("rtt.logFile.enabled", false, this._configurationTarget());
        } else {
            const folders = await this._vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: this._vscode.workspace.workspaceFolders?.[0]?.uri,
                openLabel: this._t("rtt.saveLog")
            });
            if (!folders?.length) return;
            await config.update("rtt.logFile.directory", folders[0].fsPath, this._configurationTarget());
            await config.update("rtt.logFile.enabled", true, this._configurationTarget());
        }
        this.settingsChanged();
    }

    _configurationTarget() {
        return this._vscode.workspace.workspaceFolders?.length
            ? this._vscode.ConfigurationTarget.Workspace
            : this._vscode.ConfigurationTarget.Global;
    }

    // Reveals the terminals, recreating any the user closed; reports when there is nothing to show yet.
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
        for (const entry of this._channels.values()) this._revealEntry(entry);
        return true;
    }

    // Applies the current status and optionally brings the terminals to the front.
    sync(status, reveal = false) {
        this.onStatus(status);
        if (reveal) for (const entry of this._channels.values()) this._revealEntry(entry);
    }

    onStatus(status) {
        const previous = this.state;
        this._status = status || { state: "stopped" };
        const state = this.state;
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
        this._postStatus();
    }

    _postStatus() {
        this._post(rttStatusMessage(this._status, this._view()));
    }

    // What the sidebar shows besides the controller's status.
    _view() {
        const settings = this._settings();
        return {
            terminals: this._channels.size,
            timestamps: settings.timestamps === true,
            log: { enabled: settings.logEnabled === true, directory: settings.logDirectory || "" }
        };
    }

    _active() {
        return [...this._channels.values()].filter((entry) => entry.active);
    }

    _enterRunning() {
        this._clearNotice("rtt");
        this._clearNotice("rtt-channels");
        this._warnedError = null;
        this._warnedMissing = "";
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

    // The terminal's last words: why RTT ended, and the failure when there was one.
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

    // Extension shutdown: no stop notes, terminals close with the window.
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

    // Brings the channel set of the running attachment and the entries in line: new channels get terminals, stopped
    // entries resume in the terminal they left open, vanished channels stop, and a new buffer generation restarts its
    // entry at the attachment's first byte.
    _syncChannels(status) {
        const up = status.channels?.up || [];
        const live = new Set(up.map((channel) => channel.index));
        for (const entry of this._active())
            if (!live.has(entry.channel)) this._stopEntry(entry, this._t("rtt.termStopped"));
        const generations = new Map((status.buffers || []).map((buffer) => [buffer.channel, buffer.generation]));
        const settings = this._settings();
        for (const channel of up) {
            let entry = this._channels.get(channel.index);
            // VS Code cannot rename a terminal, so a channel the firmware renamed starts a new one.
            if (entry && !entry.active && entry.name !== channelName(channel)) {
                this._disposeEntry(entry);
                entry = null;
            }
            if (!entry) entry = this._createEntry(channel, status);
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
                entry.input = "";
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
            name: channelName(channel),
            down: downSize(status, channel),
            format: channel.format,
            encoding: channel.encoding,
            formatter: null,
            generation: undefined,
            cursor: undefined,
            input: "",
            ansi: new AnsiStripper(),
            active: true,
            open: true,
            log: null,
            logFailed: null,
            write: null,
            close: null,
            pty: null,
            terminal: null
        };
        entry.formatter = this._newFormatter(entry);
        this._channels.set(entry.channel, entry);
        this._attachTerminal(entry);
        return entry;
    }

    // (Re)creates the pseudoterminal of an entry. Reused when the user closed the terminal but the channel runs on.
    _attachTerminal(entry) {
        entry.write?.dispose?.();
        entry.close?.dispose?.();
        const write = new this._vscode.EventEmitter();
        const close = new this._vscode.EventEmitter();
        entry.write = write;
        entry.close = close;
        entry.open = true;
        entry.input = "";
        entry.ready = false;
        entry.pendingText = "";
        const pty = {
            onDidWrite: write.event,
            onDidClose: close.event,
            open: () => {
                if (entry.pty !== pty) return;
                entry.open = true;
                entry.ready = true;
                write.fire(entry.pendingText);
                entry.pendingText = "";
            },
            close: () => {
                if (entry.pty !== pty) return;
                // The user closed the terminal; a live channel, its cursor and log continue without it.
                entry.open = false;
                entry.input = "";
                if (entry.active) return;
                this._disposeEntry(entry);
                this._postStatus();
            },
            handleInput: (data) => {
                if (entry.pty === pty) this._handleInput(entry, data);
            }
        };
        entry.pty = pty;
        entry.terminal = this._vscode.window.createTerminal({ name: entry.name, pty: entry.pty });
        entry.terminal.show?.(true);
    }

    _revealEntry(entry) {
        if (entry.open) {
            entry.terminal?.show?.();
            return;
        }
        this._attachTerminal(entry);
        entry.terminal?.show?.();
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
        for (const entry of this._active()) if (!this._drain(entry)) return;
    }

    // Bytes reached the host: a timestamped line takes its time now rather than at the next tick.
    dataArrived(channel) {
        const entry = this._channels.get(channel);
        if (this.state === "running" && entry?.active && entry.formatter.timestamps) this._drain(entry);
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
                this._fire(entry, tail);
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
                this._fire(entry, text);
                this._appendLog(entry, text);
            }
            if (!result.more) break;
        }
        return true;
    }

    // Line editor: printable input is echoed locally, Enter sends the line to the down channel, backspace edits;
    // control characters and escape sequences are not part of the line and are dropped. VS Code delivers a key's
    // whole sequence in one call, so a lone Esc cannot swallow the next key.
    _handleInput(entry, data) {
        if (!entry.open || !entry.active || this.state !== "running") return;
        if (this._settings().inputMode === "raw") {
            this._sendRaw(entry, data);
            return;
        }
        let escape = null;
        for (const char of String(data ?? "")) {
            if (escape === "csi") {
                if (/[@-~]/.test(char)) escape = null;
                continue;
            }
            if (escape === "esc") {
                escape = char === "[" || char === "O" ? "csi" : null;
                continue;
            }
            if (char === "\x1b") {
                escape = "esc";
                continue;
            }
            if (char === "\r") {
                this._sendLine(entry);
                continue;
            }
            if (char === "\x7f" || char === "\b") {
                this._eraseChar(entry);
                continue;
            }
            if (char < " ") continue;
            if (Buffer.byteLength(entry.input + char, "utf8") > MAX_INPUT_BYTES) continue;
            entry.input += char;
            this._fire(entry, char);
        }
    }

    _eraseChar(entry) {
        const chars = [...entry.input];
        const last = chars.pop();
        if (last === undefined) return;
        entry.input = chars.join("");
        this._fire(entry, isWide(last) ? "\b\b  \b\b" : "\b \b");
    }

    // Problems with a line are shown where it was typed and never reach the log.
    _inputProblem(entry, text) {
        this._fire(entry, `\x1b[33m${text}\x1b[0m\r\n`);
    }

    // OpenOCD drops what does not fit the down buffer, so a line that cannot fit is refused rather than truncated.
    _sendLine(entry) {
        const line = entry.input;
        entry.input = "";
        this._fire(entry, "\r\n");
        if (!entry.down) {
            this._inputProblem(entry, this._t("rtt.inputUnavailable", { channel: entry.channel }));
            return;
        }
        const ending = LINE_ENDINGS[this._settings().inputLineEnding] ?? LINE_ENDINGS.lf;
        if (!line && !ending) return;
        const bytes = Buffer.byteLength(line + ending, "utf8");
        const max = entry.down - 1; // A ring buffer holds one byte less than its size.
        if (bytes > max) {
            this._inputProblem(entry, this._t("rtt.inputTooLong", { bytes, max }));
            return;
        }
        try {
            this._controller().write(entry.channel, line + ending);
        } catch (error) {
            this._inputProblem(entry, `${this._t("rtt.writeFailed")}: ${this._errorText(error)}`);
            return;
        }
        this._appendLog(entry, `${line}\r\n`);
    }

    // Keystrokes, including control characters, go out as typed. The firmware echoes what it wants shown.
    _sendRaw(entry, data) {
        if (!entry.down) {
            this._inputProblem(entry, this._t("rtt.inputUnavailable", { channel: entry.channel }));
            return;
        }
        const bytes = Buffer.from(String(data ?? ""), "utf8");
        const max = Math.min(entry.down - 1, MAX_WRITE_BYTES);
        if (bytes.length > max) {
            this._inputProblem(entry, this._t("rtt.inputTooLong", { bytes: bytes.length, max }));
            return;
        }
        try {
            this._controller().write(entry.channel, bytes);
        } catch (error) {
            this._inputProblem(entry, `${this._t("rtt.writeFailed")}: ${this._errorText(error)}`);
        }
    }

    _notePaused() {
        const active = this._active();
        if (this._paused || !active.length) return;
        this._paused = true;
        for (const entry of active) {
            entry.input = "";
            this._fire(entry, `\r\n${this._t("rtt.termPending")}\r\n`);
        }
    }

    // A session boundary shown in the terminal and recorded in its log.
    _mark(entry, key, params = undefined) {
        const line = `\r\n${this._t(key, params)}\r\n`;
        entry.ansi.reset();
        this._fire(entry, line);
        if (!entry.log?.raw) entry.log?.append(line);
    }

    // RTT ended for this channel: everything held back goes out, and the terminal stays readable with the reason as
    // its last line. Without an open terminal nothing is left to keep.
    _stopEntry(entry, note) {
        entry.active = false;
        const tail = entry.formatter.flush();
        this._appendLog(entry, tail);
        entry.log?.close();
        entry.log = null;
        entry.logFailed = null;
        entry.ansi.reset();
        entry.input = "";
        if (!entry.open) {
            this._disposeEntry(entry);
            return;
        }
        this._fire(entry, `${tail}\r\n${note}\r\n`);
    }

    _disposeEntry(entry) {
        this._channels.delete(entry.channel);
        entry.active = false;
        entry.log?.close();
        entry.log = null;
        entry.pty = null; // Ignore the close callback the terminal answers with.
        try {
            entry.close?.fire();
        } catch {
            /* A closing terminal must not break the teardown. */
        }
        entry.write?.dispose?.();
        entry.close?.dispose?.();
        entry.terminal = null;
    }

    // Keeps partial escape sequences across chunks so ANSI never leaks into plain-text logs.
    _appendLog(entry, text) {
        if (!entry.log || entry.log.raw) return;
        if (this._settings().stripAnsi === false) {
            entry.ansi.reset();
            entry.log.append(text);
        } else entry.log.append(entry.ansi.push(text));
    }

    _fire(entry, text) {
        if (!entry.open) return;
        if (!entry.ready) {
            entry.pendingText = (entry.pendingText + text).slice(-READ_CHUNK_BYTES);
            return;
        }
        try {
            entry.write?.fire(text);
        } catch {
            /* The terminal's renderer must not break the channel. */
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

function rttStatusMessage(status, view) {
    return { type: "rttStatus", ...(status || {}), view };
}

module.exports = { MAX_INPUT_BYTES, POLL_INTERVAL_MS, RTT_ERROR_KEYS, RttTerminalService, rttStatusMessage };
