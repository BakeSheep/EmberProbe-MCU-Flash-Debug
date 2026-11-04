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
const { resolveControlBlock, scanSlices } = require("../rttControlBlock");
const { RttBuffer } = require("../rttBuffer");
const { MAX_SERVER_COMMANDS } = require("../rttControl");
const { findFreePort } = require("../liveWatch");
const { CACHE_KEYS } = require("../cacheKeys");

// The firmware may need several rounds after reset before the control block and its channels appear.
const START_FIRST_DELAY_MS = 200;
const START_BACKOFF_FACTOR = 1.5;
const START_MAX_DELAY_MS = 2000;
const START_MAX_ATTEMPTS = 12;
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

const rttError = (code, message, details) =>
    Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
const probeBusy = (message) => Object.assign(new Error(message), { code: "PROBE_BUSY", retryable: true });

class RttController {
    // host: the provider. options: { vscode, ManagedOpenOcdSession, clock, net, findFreePort, rttSettings,
    // ramRegions, onStatus } — the functions are injectable so tests can drive them.
    constructor(host, options = {}) {
        this.host = host;
        this._vscode = options.vscode;
        this._ManagedOpenOcdSession = options.ManagedOpenOcdSession;
        this.clock = { ...SYSTEM_CLOCK, ...options.clock };
        this.net = options.net || net;
        this._findFreePort = options.findFreePort || findFreePort;
        this._rttSettings = options.rttSettings;
        this._ramRegions = options.ramRegions;
        this.onStatus = options.onStatus || (() => {});
        this.onBeforeStop = options.onBeforeStop || (() => {});
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
        this._connectTimers = new Map();
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
    }

    status() {
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
            servers: this._servers.map((server) => ({ ...server })),
            buffers: [...this._buffers.entries()].map(([channel, buffer]) => {
                const socket = this._sockets.get(channel);
                return { channel, connected: !!socket && !socket.destroyed, ...buffer.stats() };
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
        const socket = this._sockets.get(channel);
        if (!socket || socket.destroyed)
            throw rttError("RTT_CHANNEL_DISCONNECTED", `RTT channel ${channel} has no data connection`, { channel });
        if (!this.channels?.down?.some((entry) => entry.index === channel && entry.size > 0))
            throw rttError("RTT_INPUT_UNAVAILABLE", `RTT channel ${channel} has no down buffer`, { channel });
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
    // reports through onStatus. Terminal setup failures reject. A pending controller stops waiting: the user asked now.
    start() {
        return this._enqueue(async () => {
            if (this.state === "running" || this.state === "starting") return this.status();
            this._cancelTimers();
            this._ownSessionIntent = false;
            this._yieldOperation = null;
            this.error = null;
            const selection = this._selectHost();
            if (selection?.blocked === "multicore")
                throw rttError("RTT_MULTICORE_UNSUPPORTED", "RTT control is unavailable for multicore debug sessions");
            if (selection?.blocked) throw probeBusy("The debug server is starting; start RTT once it is ready");
            if (!selection) await this._startOwnSession();
            else {
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
        if (this.state === "stopped" && !this._queued) return;
        void this._enqueue(() => this._reconcile());
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
        if (this.state === "stopped") return;
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
            pollingIntervalMs: configuration.get("rtt.pollingIntervalMs")
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
        const settings = this._settings();
        this._block = await this._resolveBlock(settings);
        let failure = null;
        for (const block of scanSlices(this._block)) {
            if (this._interrupts !== interrupts) return null;
            const request = { operation: "start", block };
            // 0 is the setting's "OpenOCD default"; anything else is checked with the rest of the request.
            if (settings.pollingIntervalMs) request.pollingIntervalMs = settings.pollingIntervalMs;
            try {
                return await this._session().rttControl(request);
            } catch (error) {
                if (!error?.retryable) throw error;
                failure = error;
            }
        }
        throw failure;
    }

    // Backoff ladder over _attemptStart. timeoutCode names what the exhausted ladder failed on.
    async _scheduleStartRetry(run, fullStart, reason, timeoutCode = "RTT_START_TIMEOUT") {
        this._startAttempts++;
        if (this._startAttempts > START_MAX_ATTEMPTS) {
            const error = rttError(timeoutCode, `RTT gave up after ${START_MAX_ATTEMPTS} attempts: ${reason}`);
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
        const selected = this._settings().channels;
        if (selected === undefined) {
            this.missingChannels = [];
            return channels.up.slice(0, MAX_SERVER_COMMANDS);
        }
        if (
            !Array.isArray(selected) ||
            !selected.length ||
            selected.length > MAX_SERVER_COMMANDS ||
            selected.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
        )
            throw rttError(
                "RTT_INVALID_CHANNELS",
                `RTT channels must list 1..${MAX_SERVER_COMMANDS} integers from 0 to 255`
            );
        const available = new Set(channels.up.map((channel) => channel.index));
        this.missingChannels = selected.filter((channel) => !available.has(channel));
        return channels.up.filter((channel) => selected.includes(channel.index));
    }

    async _startChannels(run, up) {
        this.channels = { ...this.channels, up };
        const servers = [];
        for (const channel of up) {
            const port = await this._findFreePort();
            if (!port) throw rttError("RTT_PORT_UNAVAILABLE", "No free local port for an RTT server");
            servers.push({ port, channel: channel.index });
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
        this.state = "running";
        this.error = null;
        this._retry = null;
        this._postStatus();
        for (const server of servers) this._connectChannel(run, server);
    }

    // Connects one up channel's data port. OpenOCD may need a moment to bind it, so failures retry with backoff;
    // once connected, data flows into the channel buffer without further host polling.
    _connectChannel(run, server) {
        let attempts = 0;
        const attempt = () => {
            if (run !== this._attachRun) return;
            const buffer = this._buffers.get(server.channel);
            if (!buffer) return;
            const socket = this.net.connect({ host: "127.0.0.1", port: server.port });
            socket.setNoDelay?.(true);
            socket.on("connect", () => {
                if (run !== this._attachRun) {
                    socket.destroy();
                    return;
                }
                attempts = 0;
                this._sockets.set(server.channel, socket);
                this._postStatus();
            });
            socket.on("data", (chunk) => buffer.append(chunk));
            socket.on("error", () => {});
            socket.on("close", () => {
                if (this._sockets.get(server.channel) === socket) this._sockets.delete(server.channel);
                if (run !== this._attachRun || this.state !== "running") return;
                attempts++;
                if (attempts > CONNECT_MAX_ATTEMPTS) {
                    this.error = {
                        code: "RTT_CHANNEL_DISCONNECTED",
                        message: `RTT channel ${server.channel} lost its data connection`
                    };
                    this._postStatus();
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
        this.error = { code: error.code, message: error.message };
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
        }
        await this._detach().catch(() => {});
        this._postStatus();
    }

    // Teardown order: stop reading data, stop the RTT servers and RTT itself while the Tcl session is alive, then
    // stop a session we own and release its lease.
    async _detach() {
        for (const socket of this._sockets.values()) socket.destroy();
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
        this._buffers.clear();
        this._servers = [];
        this.channels = null;
        this.missingChannels = [];
        this._hostSession = null;
        this.source = null;
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
