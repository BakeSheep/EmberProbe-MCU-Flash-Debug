"use strict";

// RTT orchestration on the extension host: picks the OpenOCD session to attach to (the managed debug server first,
// then the live-watch session, otherwise a lightweight session under this controller's own "rtt" lease), resolves the
// control block, drives the session-layer rttControl transactions with a backoff retry while the firmware initializes,
// reads each up channel from its RTT TCP port into a bounded buffer, and follows probe-session switches: operations
// that take over the probe ask the controller to yield, and it waits in pending-host until a session appears, the
// probe falls idle (restoring a session it owned) or nothing is left to follow. Channel data never flows through the
// Tcl connection or the sampling worker.
//
// Every state change runs through one queue, so a start, stop, yield or session change that arrives while another is
// in flight acts on its final state. Queued tasks call the internal methods directly and must never await _enqueue.

const net = require("net");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { normalizeRttSettings, resolveControlBlock, scanSlices } = require("../rttControlBlock");
const { RttBuffer } = require("../rttBuffer");
const { MAX_SERVER_COMMANDS } = require("../rttControl");
const { findFreePort } = require("../liveWatch");
const { CACHE_KEYS } = require("../cacheKeys");

// The firmware may need several rounds after reset before the control block and its channels appear.
const START_FIRST_DELAY_MS = 200;
const START_BACKOFF_FACTOR = 1.5;
const START_MAX_DELAY_MS = 2000;
const START_MAX_ATTEMPTS = 12;
// An automatic start, or any start on a debug server, may meet a target halted before the firmware initialized RTT:
// a debug launch stops at its entry point after the startup code cleared the control block. An exact block is cheap
// to ask for, so it waits about five minutes for the user to resume; a scan keeps the short ladder.
const HALTED_START_MAX_ATTEMPTS = 150;
// OpenOCD binds the RTT TCP ports when `rtt server start` runs; connections retry until then.
const CONNECT_FIRST_DELAY_MS = 25;
const CONNECT_BACKOFF_FACTOR = 2;
const CONNECT_MAX_DELAY_MS = 400;
const CONNECT_MAX_ATTEMPTS = 20;
// Sessions are replaced with short gaps (an operation stops the old one before it reserves the probe; live watch
// restores 350 ms after a debug server stops). A pending controller decides only after the probe stayed quiet this long.
const PENDING_SETTLE_MS = 1000;
// The ELF service reports these while it reloads; the symbol outranks every scan, so RTT waits for it.
const TRANSIENT_ELF_ERRORS = ["ELF_LOADING", "ELF_CHANGED"];
// A shared host can be busy for one transaction; the retry ladder outlasts that.
const TRANSIENT_HOST_ERRORS = ["LIVE_READ_CANCELLED", "PROBE_CONNECTION_BUSY_TIMEOUT"];
// One terminal line per write; the target's down buffer is small and OpenOCD drops what does not fit.
const MAX_WRITE_BYTES = 1024;
const METRICS_INTERVAL_MS = 1000;
const MODE_CONNECT_TIMEOUT_MS = 10000;
// A shared host can hold its lock past a mode write's budget. Nothing reached the target then, so the write repeats
// until the mode deadline above.
const MODE_BUSY_RETRY_MS = 100;
// OpenOCD unregisters its RTT poll after one failed read, such as a poll that meets a target reset, and leaves the data
// ports open, so the stream stops with nothing to see on the host. Target data whose read offset and host byte count
// both stay put over this many consecutive telemetry samples, and at least this long, means nobody is reading it.
const STALL_SAMPLES = 3;
const STALL_MIN_MS = 3000;
const STALL_POLLING_FACTOR = 4; // A slow polling interval needs a longer quiet period before it counts.

const rttError = (code, message, details) =>
    Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
const probeBusy = (message) => Object.assign(new Error(message), { code: "PROBE_BUSY", retryable: true });

class RttController {
    // host: the provider. options: { vscode, ManagedOpenOcdSession, clock, net, findFreePort, rttSettings, autoStart,
    // ramRegions, onStatus, onBeforeStop, onData, onAutoStart } — the functions are injectable so tests can drive them.
    constructor(host, options = {}) {
        this.host = host;
        this._vscode = options.vscode;
        this._ManagedOpenOcdSession = options.ManagedOpenOcdSession;
        this.clock = { ...SYSTEM_CLOCK, ...options.clock };
        if (options.clock?.now && !options.clock.monotonicMs) this.clock.monotonicMs = options.clock.now;
        this.net = options.net || net;
        this._findFreePort = options.findFreePort || findFreePort;
        this._rttSettings = options.rttSettings;
        this._ramRegions = options.ramRegions;
        this.onStatus = options.onStatus || (() => {});
        this.onBeforeStop = options.onBeforeStop || (() => {});
        this.onData = options.onData || (() => {});
        this._autoStart = options.autoStart;
        this.onAutoStart = options.onAutoStart || (() => this.start({ origin: "auto" }).catch(() => {}));
        this.state = "stopped"; // stopped | starting | running | pending-host
        this.source = null; // debug-server | live-watch | own-session
        this.reason = null;
        this.channels = null;
        this.missingChannels = []; // Selected up channels the firmware did not configure.
        this.error = null;
        this._hostSession = null;
        this._ownSession = null;
        this._lease = null;
        this._buffers = new Map(); // up channel index -> RttBuffer
        this._bufferGeneration = 0;
        this._sockets = new Map(); // up channel index -> net.Socket
        this._pendingSockets = new Set();
        this._connectTimers = new Map();
        this._recoveredChannels = new Set(); // Channels re-attached for a lost data port that have not connected since.
        this._stallWatch = new Map(); // up channel index -> { readOffset, received, since, samples } while data waits
        this._stallRecovered = false; // Restarted for a stalled stream and no byte has arrived since.
        this.recovery = null; // The last automatic re-attachment of this run: { reason, channel, at }.
        this._servers = []; // [{ port, channel }]
        this._block = null;
        this._attachRun = 0;
        this._retryTimer = null;
        this._retry = null; // { attempts, delayMs, reason } while starting
        this._startAttempts = 0;
        this._settleTimer = null;
        // Yielding keeps the user's intent: a controller that owned its session restores it once no borrowed session
        // remains, however many operations it yielded to in between.
        this._ownSessionIntent = false;
        this._yieldOperation = null;
        this._queue = Promise.resolve();
        this._queued = 0;
        this._interrupts = 0; // Bumped ahead of the queue so a long control-block scan stops between slices.
        this._runSettings = null;
        this._origin = null;
        this._autoHost = null; // The host automatic start already acted on, or the user stopped RTT on.
        this._modeIdentity = null;
        this._metricsTimer = null;
        this._modeConnectTimer = null;
        this._metricsBusy = false;
        this._rates = new Map();
        this.targetTelemetry = { available: false, reason: "RTT_NOT_RUNNING", sampledAt: null, channels: [] };
    }

    status() {
        const targetEpoch = this._hostSession?.targetEpoch;
        if (
            this.targetTelemetry.available &&
            targetEpoch !== undefined &&
            this.targetTelemetry.targetEpoch !== targetEpoch
        )
            this.targetTelemetry = { available: false, reason: "LIVE_READ_CANCELLED", sampledAt: null, channels: [] };
        return {
            state: this.state,
            source: this.source,
            reason: this.reason,
            yieldedFor: this._yieldOperation,
            retry: this._retry,
            block: this._block
                ? { source: this._block.source, address: this._block.address, size: this._block.size }
                : null,
            channels: this.channels,
            missingChannels: this.missingChannels,
            configuredPollingIntervalMs: this._runSettings?.configuredPollingIntervalMs ?? null,
            pollingIntervalMs: this._runSettings?.pollingIntervalMs ?? null,
            targetDroppedBytes: null,
            targetTelemetry: this.targetTelemetry,
            recovery: this.recovery,
            servers: this._servers.map((server) => ({ ...server })),
            buffers: [...this._buffers.entries()].map(([channel, buffer]) => {
                const socket = this._sockets.get(channel);
                return {
                    channel,
                    connected: !!socket && !socket.destroyed,
                    ...buffer.stats(),
                    receivedBytes: buffer.end,
                    rateBytesPerSecond: this._rates.get(channel)?.rate ?? null
                };
            }),
            error: this.error
        };
    }

    // Cursor read of one up channel for terminal and Agent consumers; see RttBuffer.read for the request shape.
    read(channel, request = {}) {
        if (this.state !== "running")
            throw rttError("RTT_NOT_RUNNING", `RTT is ${this.state || "stopped"}`, { state: this.state });
        const buffer = this._buffers.get(channel);
        if (!buffer) throw rttError("RTT_UNKNOWN_CHANNEL", `RTT channel ${channel} is not available`, { channel });
        return buffer.read(request);
    }

    // Writes to a down channel through the same channel's RTT TCP port: OpenOCD's rtt server copies client input
    // into the down buffer of the channel it serves. Returns the bytes accepted.
    write(channel, data) {
        if (this.state !== "running")
            throw rttError("RTT_NOT_RUNNING", `RTT is ${this.state || "stopped"}`, { state: this.state });
        const down = this.channels?.up?.find((entry) => entry.index === channel)?.downChannel ?? channel;
        const socket = this._sockets.get(down);
        if (!socket || socket.destroyed)
            throw rttError("RTT_CHANNEL_DISCONNECTED", `RTT channel ${down} has no data connection`, { channel });
        if (!this.channels?.down?.some((entry) => entry.index === down && entry.size > 0))
            throw rttError("RTT_INPUT_UNAVAILABLE", `RTT channel ${down} has no down buffer`, { channel });
        if (socket.writableNeedDrain)
            throw rttError("RTT_INPUT_BUSY", `RTT channel ${channel} is still sending input`, { channel });
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
        if (bytes.length > MAX_WRITE_BYTES)
            throw rttError("RTT_WRITE_TOO_LARGE", `RTT input is limited to ${MAX_WRITE_BYTES} bytes per line`, {
                channel,
                bytes: bytes.length,
                maxBytes: MAX_WRITE_BYTES
            });
        if (!bytes.length) return 0;
        socket.write(bytes);
        return bytes.length;
    }

    // Manual start. Resolves once the attachment is launched; the retry ladder finishes in the background and
    // The text encoding of an up channel, without touching status or telemetry.
    channelEncoding(channel) {
        return this.channels?.up?.find((entry) => entry.index === channel)?.encoding ?? "utf-8";
    }

    // reports through onStatus. Terminal setup failures reject. A pending controller stops waiting: the user asked now.
    // origin: "user" may write configured channel modes; "agent" and "auto" never acquire that intent, and "auto" only
    // borrows a session that already holds the probe.
    start({ origin = "user" } = {}) {
        return this._enqueue(async () => {
            if (this.state === "running" || this.state === "starting") return this.status();
            if (origin === "auto" && (this.state !== "stopped" || !this._selectHost()?.session)) return this.status();
            const settings = normalizeRttSettings(this._settings());
            if (origin !== "user" && settings.channels?.some((channel) => channel.mode !== undefined))
                throw rttError(
                    "RTT_MODE_REQUIRES_UI_START",
                    "Start RTT from VS Code to apply configured channel modes"
                );
            const selection = this._selectHost();
            if (selection?.blocked === "multicore")
                throw rttError("RTT_MULTICORE_UNSUPPORTED", "RTT control is unavailable for multicore debug sessions");
            if (selection?.blocked) throw probeBusy("The debug server is starting; start RTT once it is ready");
            // A start that cannot get a session leaves a pending controller as it was: its intent to restore the
            // owned session and its settle timer survive, so the wait still ends in a resume.
            const waiting = {
                _runSettings: this._runSettings,
                _origin: this._origin,
                _modeIdentity: this._modeIdentity,
                _ownSessionIntent: this._ownSessionIntent,
                _yieldOperation: this._yieldOperation
            };
            this._runSettings = settings;
            this._origin = origin;
            this._modeIdentity = null;
            this._cancelTimers();
            this._ownSessionIntent = false;
            this._yieldOperation = null;
            this._recoveredChannels.clear();
            this._stallRecovered = false;
            this.recovery = null;
            this.error = null;
            if (!selection) {
                try {
                    await this._startOwnSession();
                } catch (error) {
                    Object.assign(this, waiting);
                    if (this.state === "pending-host") this._armSettle();
                    throw error;
                }
            } else {
                this._hostSession = selection.session;
                this.source = selection.source;
            }
            const failure = await this._attach();
            if (failure) throw failure;
            return this.status();
        });
    }

    stop() {
        this._interrupts++;
        this._autoHost = this._hostSession ?? this._autoHost; // Stopped here means stay stopped for this session.
        return this._enqueue(() => this._stopInternal("user-stopped"));
    }

    // True when yielding would actually release something: the owned session and lease, an active attachment, or a
    // queued change that may produce one.
    holdsProbe() {
        return !!this._ownSession || this.state === "running" || this.state === "starting" || this._queued > 0;
    }

    // A probe operation that will take the connection over (debug start, live watch, flash) asks RTT to release
    // everything first. The user's intent is kept: the controller re-attaches when the next session appears.
    // Returns null when nothing is held, so callers stay synchronous in the common case.
    yieldForRestart(operation) {
        if (!this.holdsProbe()) return null;
        return this._yield(operation, false);
    }

    // An operation that shares a borrowed host but needs the probe to itself (chip info, an Agent read) only displaces
    // a session RTT owns; it never detaches RTT from a live-watch or debug session.
    yieldOwnSession(operation) {
        if (!this._ownSession && !(this._queued > 0 && !this._hostSession)) return null;
        return this._yield(operation, true);
    }

    _yield(operation, ownOnly) {
        this._interrupts++;
        return this._enqueue(async () => {
            if (this.state === "stopped" || (ownOnly && !this._ownSession)) return;
            this._ownSessionIntent ||= !!this._ownSession;
            this._yieldOperation = operation || null;
            await this._detachToPending("yielded");
        });
    }

    // Session topology changed (debug server started or stopped, live watch started or stopped, flash finished).
    onSessionsChanged() {
        if (this.state === "stopped" && !this._queued) {
            this._maybeAutoStart();
            return;
        }
        void this._enqueue(() => this._reconcile());
    }

    // One attempt per host session, and none after the user stopped RTT on it. Starting a session never hands it a
    // second try: a failure is reported once and a manual start is the way back.
    _maybeAutoStart() {
        if (!this._autoStartEnabled()) return;
        const selection = this._selectHost();
        if (!selection) this._autoHost = null;
        if (!selection?.session || selection.session === this._autoHost) return;
        this._autoHost = selection.session;
        this.onAutoStart();
    }

    _autoStartEnabled() {
        if (this._autoStart) return this._autoStart() === true;
        return this._vscode?.workspace?.getConfiguration("emberprobe").get("rtt.autoStart", false) === true;
    }

    // A probe lease changed: this is what ends a pending wait for an operation that hosts no session.
    onProbeChanged() {
        if (this.state === "pending-host") this.onSessionsChanged();
    }

    _enqueue(task) {
        this._queued++;
        const result = this._queue.then(task).finally(() => {
            this._queued--;
        });
        this._queue = result.catch(() => {});
        return result;
    }

    async _reconcile() {
        if (this.state === "stopped") {
            this._maybeAutoStart();
            return;
        }
        const selection = this._selectHost();
        if (selection?.session) {
            if (this.state === "pending-host") {
                this._cancelSettle();
                this._hostSession = selection.session;
                this.source = selection.source;
                await this._attach();
            } else if (selection.session !== this._hostSession) {
                await this._detachToPending("host-switched");
                this._cancelSettle();
                this._hostSession = selection.session;
                this.source = selection.source;
                await this._attach();
            }
            return;
        }
        if (this.state === "pending-host") this._armSettle();
        else if (!this._ownSession) await this._detachToPending("host-ended");
    }

    // The probe stayed quiet: restore the owned session, or stop when nothing is left to follow. A busy probe keeps the
    // wait going; its lease release reconciles again.
    async _settle() {
        if (this.state !== "pending-host" || this._selectHost() || this._probeBusy()) return;
        if (this._ownSessionIntent) await this._resumeOwnSession();
        else await this._stopInternal("host-ended");
    }

    _probeBusy() {
        return !!this.host._probeCoordinator?.anyActive() || !!this.host.debugLaunch?.liveSession?.();
    }

    // Managed debug server first, then the live-watch session; blocked while a server is starting or multicore.
    _selectHost() {
        const managed = this.host.debugLaunch?.managedServer;
        if (managed && !managed.stopped) {
            if (managed.capabilities?.runtimeRead === false) return { blocked: "multicore" };
            if (!managed.ready) return { blocked: "debug-starting" };
            return { session: managed, source: "debug-server" };
        }
        if (this.host._sampling?.running && this.host._sampling.session)
            return { session: this.host._sampling.session, source: "live-watch" };
        return null;
    }

    async _resumeOwnSession() {
        try {
            await this._startOwnSession();
        } catch (error) {
            this.error = { code: error.code, message: error.message };
            // Another operation took the probe between events; the intent survives and its release tries again.
            if (error?.retryable) this._postStatus();
            else await this._stopInternal("resume-failed");
            return;
        }
        this._ownSessionIntent = false;
        await this._attach();
    }

    _settings() {
        if (this._rttSettings) return this._rttSettings() || {};
        const configuration = this._vscode.workspace.getConfiguration("emberprobe");
        return {
            controlBlockAddress: configuration.get("rtt.controlBlockAddress"),
            searchRange: configuration.get("rtt.searchRange"),
            channels: configuration.get("rtt.channels", [0]),
            pollingIntervalMs: configuration.get("rtt.pollingIntervalMs", 10),
            encoding: configuration.get("rtt.encoding", "utf-8")
        };
    }

    // A configured address needs no ELF. Without a usable ELF the ranges still apply, except while it is reloading:
    // its symbol may be the exact answer, so that failure retries.
    _readElf(settings) {
        const address = settings.controlBlockAddress;
        if (address !== undefined && address !== null && address !== "") return {};
        try {
            return this.host.readElfSymbols?.() || {};
        } catch (error) {
            if (!TRANSIENT_ELF_ERRORS.includes(error?.code)) return {};
            throw Object.assign(error, { retryable: true });
        }
    }

    // Location priority from the audit: configured address, ELF symbol, configured range, writable ELF sections,
    // linker RAM regions. The region analysis reads linker and map files, so it only runs when everything above it
    // failed.
    async _resolveBlock(settings) {
        const elf = this._readElf(settings);
        const inputs = { settings, symbols: elf.symbols, sections: elf.memory?.sections };
        try {
            return resolveControlBlock(inputs);
        } catch (error) {
            if (error.code !== "RTT_CONTROL_BLOCK_UNKNOWN") throw error;
            return resolveControlBlock({ ...inputs, regions: await this._fetchRegions() });
        }
    }

    async _fetchRegions() {
        if (this._ramRegions) return this._ramRegions();
        try {
            const result = await this.host._getMemoryAnalysisController().service.analyze({});
            return result?.regions || null;
        } catch {
            return null;
        }
    }

    // Runs one attachment. Returns the terminal failure, if any, instead of throwing: callers that fire and forget
    // (session changes) must not produce unhandled rejections.
    _attach() {
        const run = ++this._attachRun;
        this.state = "starting";
        this.reason = null;
        this._yieldOperation = null;
        this.error = null;
        this._startAttempts = 0;
        this._retry = null;
        this._postStatus();
        return this._attemptStart(run, true);
    }

    // `rtt start` searches once, so a miss repeats it; once found, an empty listing only polls the listing.
    async _attemptStart(run, fullStart) {
        try {
            const result = fullStart
                ? await this._startRtt(this._interrupts)
                : await this._session().rttControl({ operation: "channels" });
            if (!result) return null;
            this.channels = result.channels;
            if (!result.channels?.up?.length)
                return await this._scheduleStartRetry(run, false, "waiting for the firmware to configure its channels");
            const up = this._selectChannels(result.channels);
            if (!up.length)
                return await this._scheduleStartRetry(
                    run,
                    false,
                    "None of the selected RTT up channels are configured",
                    "RTT_UNKNOWN_CHANNEL"
                );
            const unapplied = this._modeOverrides().filter((entry) => this.missingChannels.includes(entry.index));
            if (unapplied.length)
                return await this._scheduleStartRetry(
                    run,
                    false,
                    `waiting for RTT channels ${unapplied.map((entry) => entry.index).join(", ")} before applying modes`,
                    "RTT_UNKNOWN_CHANNEL"
                );
            await this._startChannels(run, up);
            return null;
        } catch (error) {
            if (error?.retryable || TRANSIENT_HOST_ERRORS.includes(error?.code))
                return this._scheduleStartRetry(run, true, error.message);
            await this._fail(error);
            return error;
        }
    }

    // Searches the resolved block slice by slice. Returns the start result, or null when a stop or yield interrupted
    // the search; its queued task follows at once.
    async _startRtt(interrupts) {
        const settings = this._runSettings;
        this._block = await this._resolveBlock(settings);
        if (this._modeOverrides().length) {
            if (!this._block.exact)
                throw rttError(
                    "RTT_EXACT_ADDRESS_REQUIRED",
                    "Channel modes require an exact RTT address or ELF symbol"
                );
            this._assertModeIdentity();
        }
        let failure = null;
        for (const block of scanSlices(this._block)) {
            if (this._interrupts !== interrupts) return null;
            const request = { operation: "start", block, pollingIntervalMs: settings.pollingIntervalMs };
            try {
                return await this._session().rttControl(request);
            } catch (error) {
                if (error?.code === "OPENOCD_RPC_TIMEOUT" && !block.exact)
                    throw rttError("RTT_SCAN_TIMEOUT", `RTT control block search stalled: ${error.message}`, {
                        address: `0x${block.address.toString(16)}`,
                        size: block.size
                    });
                if (!error?.retryable) throw error;
                failure = error;
            }
        }
        throw failure;
    }

    // Backoff ladder over _attemptStart. timeoutCode names what the exhausted ladder failed on.
    async _scheduleStartRetry(run, fullStart, reason, timeoutCode = "RTT_START_TIMEOUT") {
        this._startAttempts++;
        const mayBeHalted =
            this._origin === "auto" || (this.source === "debug-server" && timeoutCode === "RTT_START_TIMEOUT");
        const maxAttempts = mayBeHalted && this._block?.exact ? HALTED_START_MAX_ATTEMPTS : START_MAX_ATTEMPTS;
        if (this._startAttempts > maxAttempts) {
            const error = rttError(timeoutCode, `RTT gave up after ${maxAttempts} attempts: ${reason}`);
            await this._fail(error);
            return error;
        }
        const delayMs = Math.min(
            START_FIRST_DELAY_MS * START_BACKOFF_FACTOR ** (this._startAttempts - 1),
            START_MAX_DELAY_MS
        );
        this._retry = { attempts: this._startAttempts, delayMs, reason };
        this._postStatus();
        this._retryTimer = this.clock.schedule(() => {
            this._retryTimer = null;
            void this._enqueue(async () => {
                if (run === this._attachRun && this.state === "starting") await this._attemptStart(run, fullStart);
            });
        }, delayMs);
        return null;
    }

    // The firmware may configure more channels a moment later, so an empty result is retried by the caller and a
    // partial one proceeds with the missing channels reported in the status.
    _selectChannels(channels) {
        const selected = this._runSettings?.channels;
        if (selected === undefined) {
            this.missingChannels = [];
            return channels.up.slice(0, MAX_SERVER_COMMANDS);
        }
        const indices = selected.map((entry) => entry.index);
        const available = new Set(channels.up.map((channel) => channel.index));
        this.missingChannels = indices.filter((channel) => !available.has(channel));
        return channels.up.filter((channel) => indices.includes(channel.index));
    }

    async _startChannels(run, up) {
        this.channels = {
            ...this.channels,
            up: up.map((channel) => {
                const selected = this._runSettings.channels?.find((entry) => entry.index === channel.index);
                const desiredMode = selected?.mode;
                return {
                    ...channel,
                    ...(desiredMode === undefined ? {} : { desiredMode }),
                    modeState: desiredMode === undefined ? "firmware" : "pending",
                    format: selected?.format ?? "text",
                    encoding: selected?.encoding ?? this._runSettings.encoding ?? "utf-8",
                    downChannel: selected?.down ?? channel.index
                };
            })
        };
        const servers = [];
        for (const entry of this._serverPlan()) {
            const port = await this._findFreePort();
            if (!port) throw rttError("RTT_PORT_UNAVAILABLE", "No free local port for an RTT server");
            servers.push({ port, ...entry });
        }
        try {
            await this._session().rttControl({ operation: "serverStart", servers });
        } catch (error) {
            // A failed batch leaves the servers before it running on a host that outlives this attachment.
            const started = servers.slice(0, error?.details?.executed ?? 0);
            if (started.length)
                await this._session()
                    .rttControl({ operation: "serverStop", ports: started.map((server) => server.port) })
                    .catch(() => {});
            throw error;
        }
        this._servers = servers;
        const generation = ++this._bufferGeneration;
        this._buffers = new Map(up.map((channel) => [channel.index, new RttBuffer({ generation })]));
        this._rates = new Map(
            up.map((channel) => [channel.index, { bytes: 0, time: this.clock.monotonicMs(), rate: null }])
        );
        this._stallWatch.clear();
        this.targetTelemetry = {
            available: false,
            reason: this._block.exact ? "RTT_TELEMETRY_PENDING" : "RTT_EXACT_ADDRESS_REQUIRED",
            sampledAt: null,
            channels: []
        };
        this.state = "running";
        this.error = null;
        this._retry = null;
        this._postStatus();
        if (this._modeOverrides().length) {
            this._modeConnectTimer = this.clock.schedule(() => {
                this._modeConnectTimer = null;
                void this._enqueue(async () => {
                    if (
                        run !== this._attachRun ||
                        !this.channels?.up.some((channel) => channel.modeState === "pending")
                    )
                        return;
                    await this._fail(
                        rttError(
                            "RTT_CHANNEL_DISCONNECTED",
                            "RTT receiver connections did not become ready before the mode deadline"
                        )
                    );
                });
            }, MODE_CONNECT_TIMEOUT_MS);
        }
        for (const server of servers) this._connectChannel(run, server);
        this._scheduleMetrics(run);
    }

    // `rtt server start` couples a port to one channel number in both directions, so input for a differently numbered
    // down channel needs a server of its own. Its up data, if that channel has any, is read and dropped.
    _serverPlan() {
        const { up, down = [] } = this.channels;
        const inputs = new Set(up.map((channel) => channel.downChannel));
        for (const channel of up) inputs.delete(channel.index);
        const plan = [
            ...up.map((channel) => ({ channel: channel.index })),
            ...[...inputs]
                .filter((index) => down.some((channel) => channel.index === index && channel.size > 0))
                .map((channel) => ({ channel, inputOnly: true }))
        ];
        if (plan.length > MAX_SERVER_COMMANDS)
            throw rttError("RTT_INVALID_CHANNELS", `RTT uses at most ${MAX_SERVER_COMMANDS} channel servers`);
        return plan;
    }

    _modeOverrides() {
        return this._runSettings?.channels?.filter((channel) => channel.mode !== undefined) || [];
    }

    // Reuse writeExecution's physical-session identity validation; automatic following cannot transfer write intent
    // to a different probe, target, or selected ELF. Settings are frozen, but these selections remain live.
    _assertModeIdentity() {
        if (this._origin !== "user")
            throw rttError("RTT_MODE_REQUIRES_UI_START", "Start RTT from VS Code to apply configured channel modes");
        const session = this._session();
        if (!this.host._writes?.sessionConnection)
            throw rttError("RTT_MODE_TARGET_CHANGED", "The active RTT write connection cannot be verified");
        const connection = this.host._writes.sessionConnection(session);
        const state = this.host._context.workspaceState;
        const elf = this._readElf({});
        const identity = JSON.stringify({
            connection,
            probe: state.get(CACHE_KEYS.debugger),
            target: state.get(CACHE_KEYS.mcuCore),
            elfPath: state.get(CACHE_KEYS.elfPath),
            elfSha256: elf?.elf?.sha256 ?? null,
            address: this._block.address
        });
        if (this._modeIdentity && this._modeIdentity !== identity)
            throw rttError(
                "RTT_MODE_TARGET_CHANGED",
                "RTT target identity changed; manually restart RTT to apply modes"
            );
        this._modeIdentity = identity;
    }

    _receiversReady() {
        return this._servers.every((server) => {
            const socket = this._sockets.get(server.channel);
            return socket && !socket.destroyed;
        });
    }

    async _applyModes(run, interrupts) {
        if (run !== this._attachRun || interrupts !== this._interrupts || this.state !== "running") return;
        const pending = this.channels.up.filter((channel) => channel.modeState === "pending");
        if (!pending.length || !this._receiversReady()) return;
        const completed = [];
        try {
            for (const channel of pending) {
                if (run !== this._attachRun || interrupts !== this._interrupts || !this._receiversReady()) return;
                this._assertModeIdentity();
                const result = await this._session().rttControl({
                    operation: "setMode",
                    block: this._block,
                    channel: channel.index,
                    mode: channel.desiredMode
                });
                if (run !== this._attachRun) return;
                this._assertModeIdentity();
                Object.assign(channel, result.channel, { modeState: "applied" });
                completed.push(channel.index);
            }
            if (this._modeConnectTimer !== null) {
                this.clock.cancel(this._modeConnectTimer);
                this._modeConnectTimer = null;
            }
            this._postStatus();
        } catch (error) {
            if (error?.code === "PROBE_CONNECTION_BUSY_TIMEOUT" && this._modeConnectTimer !== null) {
                this._retryTimer = this.clock.schedule(() => {
                    this._retryTimer = null;
                    void this._enqueue(() => this._applyModes(run, interrupts));
                }, MODE_BUSY_RETRY_MS);
                return;
            }
            // Never feed a write failure back into startup's retry ladder, including an acknowledged but unverified write.
            error.retryable = false;
            error.details = { ...error.details, completedChannels: completed };
            await this._fail(error);
        }
    }

    _scheduleMetrics(run) {
        if (this._metricsTimer !== null || this.state !== "running" || run !== this._attachRun) return;
        this._metricsTimer = this.clock.schedule(() => {
            this._metricsTimer = null;
            if (run !== this._attachRun || this.state !== "running") return;
            this._updateRates();
            this._postStatus();
            if (!this._metricsBusy && !this._queued) {
                this._metricsBusy = true;
                void this._sampleTarget(run).finally(() => {
                    this._metricsBusy = false;
                });
            }
            this._scheduleMetrics(run);
        }, METRICS_INTERVAL_MS);
    }

    _updateRates() {
        const now = this.clock.monotonicMs();
        for (const [channel, buffer] of this._buffers) {
            const previous = this._rates.get(channel);
            const elapsed = previous ? now - previous.time : 0;
            this._rates.set(channel, {
                bytes: buffer.end,
                time: now,
                rate: elapsed > 0 ? ((buffer.end - previous.bytes) * 1000) / elapsed : null
            });
        }
    }

    async _sampleTarget(run) {
        const session = this._hostSession;
        if (!this._block?.exact) return;
        // A pending sample may outlive a timer cycle; stop showing a previous sample as current while it waits.
        this.targetTelemetry = { available: false, reason: "RTT_TELEMETRY_PENDING", sampledAt: null, channels: [] };
        try {
            const { snapshot } = await session.rttControl({
                operation: "snapshot",
                block: this._block,
                channels: this.channels.up.map((channel) => channel.index)
            });
            if (run !== this._attachRun || session !== this._hostSession || this.state !== "running") return;
            if (!snapshot?.channels) throw rttError("RTT_TARGET_INVALID", "RTT target snapshot is unavailable");
            if (session.targetEpoch !== undefined && snapshot.targetEpoch !== session.targetEpoch)
                throw rttError("LIVE_READ_CANCELLED", "RTT target changed before the snapshot was delivered");
            this.targetTelemetry = { available: true, reason: null, sampledAt: this.clock.now(), ...snapshot };
            for (const observed of snapshot.channels) {
                const channel = this.channels.up.find((entry) => entry.index === observed.index);
                if (!channel) continue;
                Object.assign(channel, { flags: observed.flags, mode: observed.mode, size: observed.size });
                if (channel.modeState !== "pending")
                    channel.modeState =
                        channel.desiredMode === undefined
                            ? "firmware"
                            : channel.desiredMode === observed.mode
                              ? "applied"
                              : "mismatch";
            }
            this._watchStall(run, snapshot.channels);
        } catch (error) {
            if (run !== this._attachRun || session !== this._hostSession || this.state !== "running") return;
            this.targetTelemetry = {
                available: false,
                reason: error.code || "RTT_TARGET_INVALID",
                sampledAt: null,
                channels: []
            };
        }
        this._postStatus();
    }

    // Counts the samples in which a channel's target buffer holds data that neither OpenOCD (read offset) nor the host
    // (bytes received) moved. A sample with no waiting data, or any progress, starts the count again. Only an exact
    // control block is sampled, so a scanned block has no watchdog.
    _watchStall(run, observed) {
        const now = this.clock.monotonicMs();
        const quietMs = Math.max(STALL_MIN_MS, STALL_POLLING_FACTOR * (this._runSettings?.pollingIntervalMs ?? 0));
        for (const { index, readOffset, usedBytes } of observed) {
            const buffer = this._buffers.get(index);
            if (!buffer || !Number.isSafeInteger(readOffset) || !(usedBytes > 0)) {
                this._stallWatch.delete(index);
                continue;
            }
            const previous = this._stallWatch.get(index);
            if (!previous || previous.readOffset !== readOffset || previous.received !== buffer.end) {
                this._stallWatch.set(index, { readOffset, received: buffer.end, since: now, samples: 0 });
                continue;
            }
            previous.samples++;
            if (previous.samples >= STALL_SAMPLES && now - previous.since >= quietMs) {
                this._stallWatch.clear();
                void this._enqueue(() => this._recoverStall(run, index));
                return;
            }
        }
    }

    // A stalled stream gets one fresh `rtt stop` and `rtt start` on the same session. A stream that stalls again before
    // any byte arrived ends the run instead of restarting in a loop.
    async _recoverStall(run, channel) {
        if (run !== this._attachRun || this.state !== "running") return;
        if (this._stallRecovered) {
            await this._fail(
                rttError("RTT_STREAM_STALLED", `RTT channel ${channel} holds data on the target that is not read`, {
                    channel
                })
            );
            return;
        }
        this._stallRecovered = true;
        this.recovery = { reason: "stalled", channel, at: this.clock.now() };
        try {
            this.onBeforeStop(); // Drain terminal/log cursors before the attachment's buffers disappear.
        } catch {
            /* A terminal consumer must not prevent the restart. */
        }
        this._attachRun++;
        this._cancelTimers();
        await this._detachRtt();
        await this._attach();
    }

    // Connects one up channel's data port. OpenOCD may need a moment to bind it, so failures retry with backoff;
    // once connected, data flows into the channel buffer without further host polling.
    _connectChannel(run, server) {
        let attempts = 0;
        const attempt = () => {
            if (run !== this._attachRun) return;
            const buffer = this._buffers.get(server.channel);
            if (!buffer && !server.inputOnly) return;
            const socket = this.net.connect({ host: "127.0.0.1", port: server.port });
            this._pendingSockets.add(socket);
            socket.setNoDelay?.(true);
            socket.on("connect", () => {
                this._pendingSockets.delete(socket);
                if (run !== this._attachRun) {
                    socket.destroy();
                    return;
                }
                attempts = 0;
                this._recoveredChannels.delete(server.channel);
                this._sockets.set(server.channel, socket);
                this._postStatus();
                if (this._modeOverrides().length) {
                    const interrupts = this._interrupts;
                    void this._enqueue(() => this._applyModes(run, interrupts));
                }
            });
            socket.on("data", (chunk) => {
                if (!buffer) return;
                buffer.append(chunk);
                this._stallRecovered = false;
                try {
                    this.onData(server.channel);
                } catch {
                    /* A data consumer must not break the socket. */
                }
            });
            socket.on("error", () => {});
            socket.on("close", () => {
                this._pendingSockets.delete(socket);
                if (this._sockets.get(server.channel) === socket) this._sockets.delete(server.channel);
                if (run !== this._attachRun || this.state !== "running") return;
                attempts++;
                if (attempts > CONNECT_MAX_ATTEMPTS) {
                    void this._enqueue(() => this._recoverChannel(run, server.channel));
                    return;
                }
                const delayMs = Math.min(
                    CONNECT_FIRST_DELAY_MS * CONNECT_BACKOFF_FACTOR ** (attempts - 1),
                    CONNECT_MAX_DELAY_MS
                );
                this._connectTimers.set(
                    server.channel,
                    this.clock.schedule(() => {
                        this._connectTimers.delete(server.channel);
                        attempt();
                    }, delayMs)
                );
            });
        };
        attempt();
    }

    // A data port that stays closed means OpenOCD no longer serves the channel. One fresh attachment restarts RTT and
    // its servers; a channel that still cannot connect after that ends the run instead of leaving it running dead.
    async _recoverChannel(run, channel) {
        if (run !== this._attachRun || this.state !== "running") return;
        if (this._recoveredChannels.has(channel)) {
            await this._fail(rttError("RTT_CHANNEL_DISCONNECTED", `RTT channel ${channel} lost its data connection`));
            return;
        }
        this._recoveredChannels.add(channel);
        this.recovery = { reason: "channel-lost", channel, at: this.clock.now() };
        this._ownSessionIntent ||= !!this._ownSession;
        await this._detachToPending("channel-lost");
        await this._reconcile();
    }

    // Starts the lightweight standalone session RTT owns when no other session holds the probe.
    async _startOwnSession() {
        if (
            this.host._downloadRunning ||
            this.host._chipInfoRunning ||
            this.host.debugLaunch?.starting ||
            this.host.debugLaunch?.liveSession?.()
        )
            throw probeBusy("The debug probe is busy with another operation");
        const lease = this.host._probeCoordinator.acquire("rtt");
        this._lease = lease;
        let session = null;
        try {
            const debuggerCfg =
                this.host._context.workspaceState.get(CACHE_KEYS.debugger) ||
                (await this.host._probeConnectionService.resolveProbe());
            const mcuCore = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore);
            if (!debuggerCfg || !mcuCore)
                throw rttError("CONFIG_INCOMPLETE", "Select the probe and target before starting RTT");
            const configuration = this._vscode.workspace.getConfiguration("emberprobe");
            const executable = await this.host._resolveOpenOcdPath(configuration.get("openocdPath", "openocd"));
            if (!executable) throw rttError("OPENOCD_NOT_READY", "OpenOCD is not available");
            const { cwd } = this.host._commandContext();
            const connection = await this.host._probeConnectionService.prepare({
                executable,
                probe: debuggerCfg,
                target: mcuCore,
                sampling: true
            });
            const port = await this.host._resolveTclPort(configuration);
            session = new this._ManagedOpenOcdSession(
                {
                    executable,
                    isolated: true,
                    transport: configuration.get("transport", "auto"),
                    probe: debuggerCfg,
                    target: mcuCore,
                    ...connection,
                    cwd,
                    port,
                    intervalMs: 10000
                },
                {
                    onConnectionConfirmed: () => {
                        if (!lease.released && this._ownSession === session)
                            void this.host._probeConnectionService.recordSuccess(session.options);
                    },
                    onDisconnect: () => {
                        void this._enqueue(async () => {
                            if (this._ownSession === session) await this._stopInternal("host-lost");
                        });
                    }
                }
            );
            await session.start();
            if (lease.released) {
                await session.stop().catch(() => {});
                throw rttError("RTT_CANCELLED", "The RTT session was cancelled");
            }
            this._ownSession = session;
            this._hostSession = session;
            this.source = "own-session";
        } catch (error) {
            if (session && this._ownSession !== session) await session.stop().catch(() => {});
            this._lease = null;
            lease.release();
            throw error;
        }
    }

    async _fail(error) {
        this.error = { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
        await this._stopInternal("start-failed");
    }

    async _detachToPending(reason) {
        await this._stopInternal(reason, "pending-host");
        this._armSettle();
    }

    async _stopInternal(reason, nextState = "stopped") {
        if (this.state === "stopped") return;
        try {
            this.onBeforeStop(); // Drain terminal/log cursors before the attachment's buffers disappear.
        } catch {
            /* A terminal consumer must not prevent releasing the probe. */
        }
        this._attachRun++; // Retries and socket handlers from the previous attachment go quiet.
        this._cancelTimers();
        this.state = nextState;
        this.reason = reason;
        if (reason === "user-stopped") this.error = null;
        if (nextState === "stopped") {
            this._ownSessionIntent = false;
            this._yieldOperation = null;
            this._recoveredChannels.clear();
            this._stallRecovered = false;
            this._runSettings = null;
            this._origin = null;
            this._modeIdentity = null;
        }
        await this._detach().catch(() => {});
        this._postStatus();
    }

    // Teardown order: stop reading data, stop the RTT servers and RTT itself while the Tcl session is alive, then
    // stop a session we own and release its lease.
    async _detach() {
        await this._detachRtt();
        const own = this._ownSession;
        if (own) {
            this._ownSession = null;
            // An unconfirmed OpenOCD exit is left to the session's own reporting; RTT still releases the lease.
            await own.stop().catch(() => {});
        }
        if (this._lease) {
            this._lease.release();
            this._lease = null;
        }
        this._hostSession = null;
        this.source = null;
    }

    // The attachment without its host: a restart keeps the session and its lease.
    async _detachRtt() {
        for (const socket of this._sockets.values()) socket.destroy();
        for (const socket of this._pendingSockets) socket.destroy();
        this._pendingSockets.clear();
        this._sockets.clear();
        const session = this._hostSession;
        if (session?.rttControl) {
            if (this._servers.length)
                await session
                    .rttControl({
                        operation: "serverStop",
                        ports: this._servers.map((server) => server.port)
                    })
                    .catch(() => {});
            await session.rttControl({ operation: "stop" }).catch(() => {});
        }
        this._buffers.clear();
        this._rates.clear();
        this._stallWatch.clear();
        this.targetTelemetry = { available: false, reason: "RTT_NOT_RUNNING", sampledAt: null, channels: [] };
        this._servers = [];
        this.channels = null;
        this.missingChannels = [];
        this._block = null;
        this._retry = null;
        this._startAttempts = 0;
    }

    _armSettle() {
        this._cancelSettle();
        this._settleTimer = this.clock.schedule(() => {
            this._settleTimer = null;
            void this._enqueue(() => this._settle());
        }, PENDING_SETTLE_MS);
    }

    _cancelSettle() {
        if (this._settleTimer === null) return;
        this.clock.cancel(this._settleTimer);
        this._settleTimer = null;
    }

    _cancelTimers() {
        this._cancelSettle();
        if (this._modeConnectTimer !== null) {
            this.clock.cancel(this._modeConnectTimer);
            this._modeConnectTimer = null;
        }
        if (this._metricsTimer !== null) {
            this.clock.cancel(this._metricsTimer);
            this._metricsTimer = null;
        }
        if (this._retryTimer !== null) {
            this.clock.cancel(this._retryTimer);
            this._retryTimer = null;
        }
        for (const timer of this._connectTimers.values()) this.clock.cancel(timer);
        this._connectTimers.clear();
    }

    _session() {
        if (!this._hostSession)
            throw rttError("RTT_NOT_RUNNING", "The RTT host session is gone", { state: this.state });
        return this._hostSession;
    }

    _postStatus() {
        try {
            this.onStatus(this.status());
        } catch {
            /* A status consumer must not break the controller. */
        }
    }
}

module.exports = { RttController };
