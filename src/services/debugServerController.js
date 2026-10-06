"use strict";

const net = require("net");
const scripts = require("../openocdScripts");
const { normalizeDebugServerOptions } = require("./debugConfiguration");

// Hold every reservation until the complete set exists; closing each socket as
// it is allocated can recycle the same ephemeral port into another core.
async function allocateDebugPorts(count, excluded = []) {
    if (!Number.isInteger(count) || count < 1 || count > 33)
        throw new Error("Debug port allocation requires 1..33 ports");
    const servers = [];
    const ports = [];
    try {
        for (let attempt = 0; ports.length < count && attempt < count + 32; attempt++) {
            const server = net.createServer();
            server.unref();
            servers.push(server);
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(undefined));
            });
            const address = server.address();
            const port = address && typeof address === "object" ? address.port : 0;
            if (port && !excluded.includes(port)) ports.push(port);
        }
        if (ports.length !== count) throw new Error("Unable to allocate distinct debug ports");
        return ports;
    } finally {
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
    }
}

class OpenOcdDebugController {
    constructor(vscode, options, handlers = {}, dependencies = {}) {
        this.options = { ...options, ...normalizeDebugServerOptions(options), mode: "debug" };
        if (Array.isArray(this.options.gdbPorts)) this.options.gdbPorts = Object.freeze([...this.options.gdbPorts]);
        this.handlers = handlers;
        this.vscode = vscode;
        this.resolveLaunch = dependencies.resolveLaunch || scripts.resolveOpenOcdLaunch;
        this.createRuntime =
            dependencies.createRuntime ||
            ((host, settings, callbacks) =>
                new (require("../liveWatch").ManagedOpenOcdSession)(host, settings, callbacks));
        this.runtime = null;
        this.state = "new";
        this.connection = null;
        this.capabilities = Object.freeze({
            runtimeRead: (this.options.numberOfProcessors || 1) === 1,
            multicore: true,
            rtos: true,
            ownsProcess: true
        });
        this.starting = null;
        this.stopping = null;
    }
    preflight() {
        if (this.state !== "new") throw new Error("Debug controller has already been started or stopped");
        scripts.normalizeRtos(this.options.rtos);
        if (this.options.numberOfProcessors) scripts.buildOpenOcdTargetArgs(this.options, this.options.gdbPorts);
        const ports = [this.options.port, ...(this.options.gdbPorts || [this.options.gdbPort])];
        if (
            ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
            new Set(ports).size !== ports.length
        )
            throw Object.assign(new Error("OpenOCD Tcl and GDB ports must be distinct valid ports"), {
                code: "OPENOCD_TARGET_PORT_INVALID"
            });
        if (this.options.gdbPorts && this.options.gdbPort !== this.options.gdbPorts[this.options.targetProcessor])
            throw Object.assign(new Error("Selected GDB port does not match targetProcessor"), {
                code: "OPENOCD_TARGET_PORT_INVALID"
            });
        return this.resolveLaunch(
            this.options.executable,
            this.options.probe,
            this.options.target,
            this.options.transport
        );
    }
    start() {
        if (this.starting) return this.starting;
        this.preflight();
        this.state = "starting";
        this.starting = (async () => {
            try {
                this.runtime = this.createRuntime(this.vscode, this.options, this.handlers);
                const result = await this.runtime.start();
                if (this.state !== "starting") throw new Error("Debug controller stopped during startup");
                this.connection = Object.freeze({ ...result });
                this.state = "ready";
                return this.connection;
            } catch (error) {
                if (this.state === "starting") this.state = "failed";
                // runtime.start() can spawn OpenOCD and then fail to bind, so the process may
                // already exist. Leaving it running holds the USB probe and blocks every later
                // session; stop() rethrows only unconfirmed exits, which a retry may still clear.
                await this.stop().catch(() => {});
                throw error;
            }
        })();
        return this.starting;
    }
    get ready() {
        return this.state === "ready" && !this.runtime.stopped;
    }
    get stopped() {
        return this.state === "stopped" || !!this.runtime?.stopped;
    }
    get samplingEnabled() {
        return this.capabilities.runtimeRead && !!this.runtime?.samplingEnabled;
    }
    setSamplingEnabled(enabled) {
        return this.runtime?.setSamplingEnabled(!!enabled && this.capabilities.runtimeRead) || false;
    }
    setWatch(items) {
        if (items.length && !this.capabilities.runtimeRead)
            throw Object.assign(new Error("Multicore runtime sampling requires explicit target routing"), {
                code: "DEBUG_RUNTIME_READ_UNSUPPORTED"
            });
        this.runtime?.setWatch(items);
    }
    setIntervalMs(value) {
        this.runtime?.setIntervalMs(value);
    }
    setSamplingPlan(plan) {
        if ((plan.graphItems.length || plan.sidebarItems.length) && !this.capabilities.runtimeRead)
            throw Object.assign(new Error("Multicore runtime sampling requires explicit target routing"), {
                code: "DEBUG_RUNTIME_READ_UNSUPPORTED"
            });
        this.runtime?.setSamplingPlan(plan);
    }
    setPauseReason(reason) {
        this.runtime?.setPauseReason(reason);
    }
    stats() {
        return this.runtime?.stats();
    }
    waitForIdle(...args) {
        return this.runtime ? this.runtime.waitForIdle(...args) : Promise.resolve(true);
    }
    waitForExit(...args) {
        return this.runtime ? this.runtime.waitForExit(...args) : Promise.resolve(true);
    }
    readOnce(...args) {
        if (!this.capabilities.runtimeRead)
            return Promise.reject(
                Object.assign(new Error("Multicore runtime reads require explicit target routing"), {
                    code: "DEBUG_RUNTIME_READ_UNSUPPORTED"
                })
            );
        if (!this.ready) return Promise.reject(new Error("Debug controller is not ready"));
        return this.runtime.readOnce(...args);
    }
    stop(...args) {
        if (this.stopping) return this.stopping;
        this.state = "stopping";
        this.stopping = Promise.resolve()
            .then(() => this.runtime?.stop(...args))
            .then((closed) => {
                if (closed === false)
                    throw Object.assign(new Error("OpenOCD process exit could not be confirmed"), {
                        code: "DEBUG_SERVER_STOP_FAILED"
                    });
                this.state = "stopped";
                this.connection = null;
            })
            .catch((error) => {
                this.state = "stop-failed";
                this.stopping = null;
                throw error;
            });
        return this.stopping;
    }
}

module.exports = { OpenOcdDebugController, allocateDebugPorts };
