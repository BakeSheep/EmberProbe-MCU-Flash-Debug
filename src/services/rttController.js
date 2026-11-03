"use strict";

// RTT orchestration on the extension host: picks the OpenOCD session to attach to (the managed debug server first,
// then the live-watch session, otherwise a lightweight session under this controller's own "rtt" lease), resolves the
// control block, drives the session-layer rttControl transactions with a backoff retry while the firmware initializes,
// reads each up channel from its RTT TCP port into a bounded buffer, and follows probe-session switches: operations
// that take over the probe ask the controller to yield and re-attach once their session is ready, while a session that
// ends without a successor stops RTT. Channel data never flows through the Tcl connection or the sampling worker.

const net = require("net");
const { SYSTEM_CLOCK } = require("../samplingClock");
const { resolveControlBlock } = require("../rttControlBlock");
const { RttBuffer } = require("../rttBuffer");
const { findFreePort } = require("../liveWatch");
const { CACHE_KEYS } = require("../cacheKeys");

// The firmware may need several polling rounds after reset before the control block and its channels appear.
const START_FIRST_DELAY_MS = 200;
const START_BACKOFF_FACTOR = 1.5;
const START_MAX_DELAY_MS = 2000;
const START_MAX_ATTEMPTS = 12;
// OpenOCD binds the RTT TCP ports when `rtt server start` runs; connections retry until then.
const CONNECT_FIRST_DELAY_MS = 25;
const CONNECT_BACKOFF_FACTOR = 2;
const CONNECT_MAX_DELAY_MS = 400;
const CONNECT_MAX_ATTEMPTS = 20;

const rttError = (code, message, details) =>
    Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

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
        this.state = "stopped"; // stopped | starting | running | pending-host
        this.source = null; // debug-server | live-watch | own-session
        this.reason = null;
        this.channels = null;
        this.error = null;
        this._hostSession = null;
        this._ownSession = null;
        this._lease = null;
        this._buffers = new Map(); // up channel index -> RttBuffer
        this._sockets = new Map(); // up channel index -> net.Socket
        this._connectTimers = new Map();
        this._servers = []; // [{ port, channel }]
        this._block = null;
        this._attachRun = 0;
        this._retryTimer = null;
        this._retry = null; // { attempts, delayMs, reason } while starting
        this._startAttempts = 0;
        // Yielding for another probe operation keeps the user's intent: a controller that owned its session
        // restores it once no borrowed session remains.
        this._ownSessionIntent = false;
        this._yieldOperation = null;
        this._tearingDown = false;
        this._stopPromise = null;
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

    // Manual start. Resolves once the attachment is launched; the retry ladder finishes in the background and
    // reports through onStatus. Terminal setup failures reject and leave the controller stopped.
    async start() {
        // A pending controller first takes whatever session appeared since it yielded.
        if (this.state === "pending-host") this.onSessionsChanged();
        if (this.state !== "stopped") return this.status();
        this._ownSessionIntent = false;
        this._yieldOperation = null;
        this.error = null;
        const selection = this._selectHost();
        if (selection?.blocked === "multicore")
            throw rttError("RTT_MULTICORE_UNSUPPORTED", "RTT control is unavailable for multicore debug sessions");
        if (selection?.blocked)
            throw rttError("PROBE_BUSY", "The debug server is starting; start RTT once it is ready", {
                retryable: true
            });
        if (!selection) await this._startOwnSession();
        else {
            this._hostSession = selection.session;
            this.source = selection.source;
        }
        const failure = await this._attach();
        if (failure) throw failure;
    }

    async stop() {
        this._ownSessionIntent = false;
        this._yieldOperation = null;
        await this._stopInternal("user-stopped");
    }

    // True when yielding would actually release something: the owned session and lease, or an active attachment.
    holdsProbe() {
        return !!this._ownSession || this.state === "running" || this.state === "starting";
    }

    // A probe operation that will take the connection over (debug start, live watch, flash) asks RTT to release
    // everything first. The user's intent is kept: the controller re-attaches when the next session appears.
    // Returns null when nothing is held, so callers stay synchronous in the common case.
    yieldForRestart(operation) {
        if (!this.holdsProbe()) return null;
        return this._yield(operation);
    }

    async _yield(operation) {
        this._ownSessionIntent = !!this._ownSession;
        this._yieldOperation = operation || null;
        await this._stopInternal("yielded");
        this.state = "pending-host";
        this._postStatus();
    }

    // Session topology changed (debug server started or stopped, live watch started or stopped, flash finished).
    // pending-host re-attaches to whatever session is available; an attachment whose host disappeared without a
    // successor stops, unless the controller owned its session before yielding and restores it.
    onSessionsChanged() {
        if (this.state === "stopped") return;
        const selection = this._selectHost();
        if (selection?.session) {
            if (this.state === "pending-host") {
                this._hostSession = selection.session;
                this.source = selection.source;
                void this._attach();
            } else if (selection.session !== this._hostSession) void this._followHost(selection);
            return;
        }
        if (this.state === "pending-host") {
            if (this._ownSessionIntent) void this._resumeOwnSession();
            return;
        }
        if (this._ownSession) return;
        if (this._ownSessionIntent) {
            void this._restoreOwnSession();
            return;
        }
        void this._stopInternal("host-ended");
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

    async _followHost(selection) {
        await this._stopInternal("host-switched");
        this.state = "pending-host";
        this._hostSession = selection.session;
        this.source = selection.source;
        await this._attach();
    }

    // Restores ownership after the borrowed host of a yielded controller disappeared.
    async _restoreOwnSession() {
        await this._stopInternal("host-ended");
        this.state = "pending-host";
        await this._resumeOwnSession();
    }

    async _resumeOwnSession() {
        try {
            await this._startOwnSession();
            this._ownSessionIntent = false;
            await this._attach();
        } catch (error) {
            this.error = { code: error.code, message: error.message };
            // Another operation took the probe between events; the intent survives and the next session change
            // tries again.
            if (error?.retryable) {
                this.state = "pending-host";
                this._postStatus();
                return;
            }
            this._ownSessionIntent = false;
            await this._stopInternal("resume-failed");
        }
    }

    _settings() {
        if (this._rttSettings) return this._rttSettings() || {};
        const configuration = this._vscode.workspace.getConfiguration("emberprobe");
        return {
            controlBlockAddress: configuration.get("rtt.controlBlockAddress"),
            searchRange: configuration.get("rtt.searchRange"),
            pollingIntervalMs: configuration.get("rtt.pollingIntervalMs")
        };
    }

    // Location priority from the audit: configured address, ELF symbol, configured range, writable ELF sections,
    // linker RAM regions. The region analysis reads linker and map files, so it only runs when everything above it
    // failed.
    async _resolveBlock() {
        const settings = this._settings();
        const elf = this.host.readElfSymbols?.() || {};
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
    async _attach() {
        const run = ++this._attachRun;
        this.state = "starting";
        this._startAttempts = 0;
        this._retry = null;
        this._postStatus();
        try {
            const block = await this._resolveBlock();
            if (run !== this._attachRun) return null;
            this._block = block;
            const settings = this._settings();
            const request = { operation: "start", block };
            if (settings.pollingIntervalMs !== undefined) request.pollingIntervalMs = settings.pollingIntervalMs;
            const result = await this._session().rttControl(request);
            if (run !== this._attachRun) return null;
            this.channels = result.channels;
            if (!result.channels?.up?.length) {
                this._scheduleStartRetry(run, { fullStart: false, reason: "waiting for the control block" });
                return null;
            }
            await this._startChannels(run);
            return null;
        } catch (error) {
            if (run !== this._attachRun) return null;
            if (error?.retryable) {
                this._scheduleStartRetry(run, { fullStart: true, reason: error.message });
                return null;
            }
            await this._fail(error);
            return error;
        }
    }

    // Backoff ladder: a failed `rtt start` repeats the whole sequence, an empty channellist only polls the list.
    _scheduleStartRetry(run, { fullStart, reason }) {
        if (run !== this._attachRun) return;
        this._startAttempts++;
        if (this._startAttempts > START_MAX_ATTEMPTS) {
            void this._fail(
                rttError(
                    "RTT_START_TIMEOUT",
                    `RTT did not find the control block after ${START_MAX_ATTEMPTS} attempts: ${reason}`
                )
            );
            return;
        }
        const delayMs = Math.min(
            START_FIRST_DELAY_MS * START_BACKOFF_FACTOR ** (this._startAttempts - 1),
            START_MAX_DELAY_MS
        );
        this._retry = { attempts: this._startAttempts, delayMs, reason };
        this._postStatus();
        this._retryTimer = this.clock.schedule(async () => {
            this._retryTimer = null;
            if (run !== this._attachRun || this.state !== "starting") return;
            try {
                const result = await this._session().rttControl(
                    fullStart ? { operation: "start", block: this._block } : { operation: "channels" }
                );
                if (run !== this._attachRun) return;
                this.channels = result.channels;
                if (!result.channels?.up?.length) {
                    this._scheduleStartRetry(run, { fullStart, reason });
                    return;
                }
                await this._startChannels(run);
            } catch (error) {
                if (run !== this._attachRun) return;
                if (error?.retryable) this._scheduleStartRetry(run, { fullStart: true, reason: error.message });
                else void this._fail(error);
            }
        }, delayMs);
    }

    async _startChannels(run) {
        const up = this.channels.up;
        const servers = [];
        for (const channel of up) {
            const port = await this._findFreePort();
            if (!port) throw rttError("RTT_PORT_UNAVAILABLE", "No free local port for an RTT server");
            servers.push({ port, channel: channel.index });
        }
        if (servers.length) await this._session().rttControl({ operation: "serverStart", servers });
        if (run !== this._attachRun) return;
        this._servers = servers;
        this._buffers = new Map(up.map((channel) => [channel.index, new RttBuffer()]));
        this.state = "running";
        this._retry = null;
        this._postStatus();
        for (const server of servers) this._connectChannel(run, server);
    }

    // Connects one up channel's data port. OpenOCD may need a moment to bind it, so failures retry with backoff;
    // once connected, data flows into the channel buffer without further host polling.
    _connectChannel(run, server) {
        let attempts = 0;
        const attempt = () => {
            if (run !== this._attachRun || this.state === "stopped") return;
            const buffer = this._buffers.get(server.channel);
            if (!buffer) return;
            const socket = this.net.connect({ host: "127.0.0.1", port: server.port });
            socket.setNoDelay?.(true);
            socket.on("connect", () => {
                if (run !== this._attachRun) {
                    socket.destroy();
                    return;
                }
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
            throw rttError("PROBE_BUSY", "The debug probe is busy with another operation", { retryable: true });
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
                        if (this._ownSession === session && !this._tearingDown) void this._handleHostLost();
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

    async _handleHostLost() {
        await this._stopInternal("host-lost");
    }

    async _fail(error) {
        this.error = { code: error.code, message: error.message };
        await this._stopInternal("start-failed");
    }

    async _stopInternal(reason) {
        if (this._stopPromise) return this._stopPromise;
        if (this.state === "stopped") return;
        this._attachRun++; // Retries and socket handlers from the previous attachment go quiet.
        this._cancelTimers();
        this.state = "stopped";
        this.reason = reason;
        this._tearingDown = true;
        this._stopPromise = this._detach()
            .catch(() => {})
            .finally(() => {
                this._stopPromise = null;
                this._tearingDown = false;
                this._postStatus();
            });
        return this._stopPromise;
    }

    // Teardown order: stop reading data, stop the RTT servers and RTT itself while the Tcl session is alive, then
    // stop a session we own and release its lease.
    async _detach() {
        for (const socket of this._sockets.values()) socket.destroy();
        this._sockets.clear();
        this._cancelTimers();
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
        this._hostSession = null;
        this.source = null;
        this._block = null;
        this._retry = null;
        this._startAttempts = 0;
    }

    _cancelTimers() {
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
