"use strict";
// The OpenOCD server behind a managed session: its command line, spawn, line-by-line log delivery, the log tail that
// diagnostics are built from, its exit, and stopping it (kill when the shutdown request could not be sent, then kill
// again and SIGKILL while it outlives each wait). What a log line means for the session stays with the session.
const { spawn } = require("child_process");
const { createLineDecoder } = require("../skills/_emberprobe/tool-output");
const { normalizeAdapterSpeed } = require("../skills/_emberprobe/probe-connection");
const {
    buildOpenOcdConfigArgs,
    buildOpenOcdRtosArgs,
    buildOpenOcdTargetArgs,
    resolveOpenOcdLaunch
} = require("./openocdScripts");
const { withTargetCheck } = require("./chip/targetIdentity");
const { SYSTEM_CLOCK } = require("./samplingClock");

// Fatal log signatures of a probe unplugged while sampling (USB read/write failure, device lost), used to stop
// sampling automatically
function isFatalProbeLog(line) {
    return /WriteFile|ReadFile|LIBUSB_ERROR_(?:NO_DEVICE|IO|PIPE)|error (?:writing|reading) data|target communication error/i.test(
        String(line || "")
    );
}

// Resolves true on the first "exit" or "close": once the process has exited its USB handle is
// released, while "close" also waits for stdio, which Windows can hold open past the stop budget.
function waitForChildExit(child, timeoutMs, clock = SYSTEM_CLOCK) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
            if (settled) return;
            settled = true;
            clock.cancel(timer);
            child.removeListener("exit", onExit);
            child.removeListener("close", onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = clock.schedule(() => finish(false), timeoutMs);
        child.once("exit", onExit);
        child.once("close", onExit);
        if (child.exitCode !== null || child.signalCode != null) finish(true);
    });
}

// The executable, working directory and arguments of a managed server: Tcl on loopback `port`, GDB on `gdbPort` in
// debug mode only, and init without halt or reset.
function managedServerLaunch(options, mode, port, gdbPort) {
    const launch = resolveOpenOcdLaunch(options.executable, options.probe, options.target, options.transport);
    const args = [
        ...buildOpenOcdConfigArgs(launch, options.transport, {
            ...options,
            adapterSpeedKhz:
                mode === "standalone"
                    ? normalizeAdapterSpeed(options.samplingAdapterSpeedKhz) || options.adapterSpeedKhz
                    : options.adapterSpeedKhz
        }),
        "-c",
        "bindto 127.0.0.1",
        "-c",
        `tcl_port ${port}`,
        "-c",
        mode === "debug" ? `gdb_port ${gdbPort}` : "gdb_port disabled",
        "-c",
        "telnet_port disabled",
        ...(mode === "debug" ? buildOpenOcdTargetArgs(options, options.gdbPorts) : []),
        // RTOS awareness is configured only in debug mode: standalone sampling is non-intrusive polling, and
        // letting OpenOCD walk kernel data structures would change it.
        ...(mode === "debug" ? buildOpenOcdRtosArgs(options.rtos, !!options.serverGroup) : []),
        ...(mode === "debug"
            ? ["-c", "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }"]
            : []),
        // Initialize only, without halt or reset, to stay non-intrusive; automatic mode checks the target chip
        // afterwards
        ...withTargetCheck(["init"], options.targetCheck, options.target).flatMap((command) => ["-c", command]),
        ...(mode === "standalone" && options.backendKind === "tcp"
            ? ["-c", "if {[llength [info commands poll_interval]]} { poll_interval 500 }"]
            : [])
    ];
    return { executable: launch.executable, cwd: launch.cwd, args };
}

function notFoundError(error, executable) {
    const spawnError = /** @type {NodeJS.ErrnoException} */ (error);
    return spawnError.code === "ENOENT"
        ? Object.assign(new Error(`OpenOCD not found：${executable}`), {
              i18nKey: "run.notFound",
              i18nParams: { path: executable }
          })
        : new Error(spawnError.message);
}

function kill(child, signal) {
    try {
        child.kill(signal);
    } catch (e) {
        /* ignore */
    }
}

class OpenOcdProcess {
    constructor(clock = SYSTEM_CLOCK) {
        this.clock = clock;
        this.child = null;
        // Recent log lines for diagnostics.
        this.logTail = [];
        this._rawTail = "";
        this._readyPattern = null;
        this.listening = false;
    }

    // Spawns OpenOCD; throws when it cannot. `onLine` receives each non-empty trimmed log line, `onError` a process
    // error after spawn, and `onClose(code)` the exit once its output is drained. `executable` is the configured path,
    // for the not-found message.
    start(launch, { port, executable, onLine, onError, onClose }) {
        this._readyPattern = new RegExp(`Listening on port\\s+${port}\\s+for tcl connections`, "i");
        try {
            this.child = spawn(launch.executable, launch.args, { cwd: launch.cwd, windowsHide: true, shell: false });
        } catch (error) {
            throw notFoundError(error, executable);
        }
        const child = this.child;
        child.on("error", (error) => onError(notFoundError(error, executable)));
        const deliver = (line) => {
            const clean = line.trim();
            if (clean) onLine(clean);
        };
        const decoders = { stdout: createLineDecoder(deliver), stderr: createLineDecoder(deliver) };
        child.stdout.on("data", (chunk) => decoders.stdout.write(chunk));
        child.stderr.on("data", (chunk) => decoders.stderr.write(chunk));
        child.on("close", (code) => {
            for (const stream of ["stdout", "stderr"]) decoders[stream].end();
            if (this.child === child) this.child = null;
            onClose(code);
        });
    }

    // Keeps `line` for diagnostics and notices when Tcl starts listening.
    record(line) {
        this._rawTail = (this._rawTail + line + "\n").slice(-2000);
        if (!this.listening && this._readyPattern?.test(this._rawTail)) this.listening = true;
        this.logTail.push(line.slice(0, 500));
        if (this.logTail.length > 4096) this.logTail.shift();
    }

    // "exit" already proves the process released the probe; "close" can lag while stdio drains.
    waitForExit(timeoutMs = 1200) {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode != null) return Promise.resolve(true);
        return waitForChildExit(child, Math.max(100, Number(timeoutMs) || 1200), this.clock);
    }

    kill() {
        if (this.child && !this.child.killed) kill(this.child);
    }

    // Ends `child` after a shutdown request that was `sent` or not; `exited` is the wait that started with the request.
    // Resolves whether it exited.
    async terminate(child, sent, exited) {
        const running = () => !!child && child.exitCode == null && child.signalCode == null;
        if (!sent && running()) kill(child);
        let closed = await exited;
        if (!closed && running()) {
            kill(child);
            closed = await waitForChildExit(child, 400, this.clock);
        }
        if (!closed && running()) {
            const forcedExit = this.waitForExit(400);
            kill(child, "SIGKILL");
            closed = await forcedExit;
        }
        if (this.child === child && (closed || child?.exitCode !== null)) this.child = null;
        return closed;
    }
}

module.exports = { OpenOcdProcess, managedServerLaunch, isFatalProbeLog, waitForChildExit };
