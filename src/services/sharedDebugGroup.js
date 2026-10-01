"use strict";

const crypto = require("crypto");
const { DebugLifecycle } = require("./debugLifecycle");

function groupError(message, code = "DEBUG_GROUP_CONFLICT") {
    return Object.assign(new Error(message), { code });
}
function groupIdentity(config) {
    return JSON.stringify([
        config.executable,
        config.probe,
        config.target,
        config.transport || "auto",
        config.probeSerial || "",
        config.adapterSpeedKhz || 0,
        config.rtos || "",
        config.numberOfProcessors
    ]);
}

// One physical controller/lease, independent pending and attached DAP members.
// A join never starts another process and cannot reset/download the shared device.
class SharedDebugGroup {
    constructor({ id, workspace, controller, lease, connection, onFailure, lifecycleOptions = {} }) {
        this.id = id;
        this.workspace = workspace;
        this.controller = controller;
        this.lease = lease;
        this.identity = groupIdentity(controller.options);
        this.targets = [...(connection.targetNames || [])];
        this.gdbTargets = [...(connection.gdbTargets || [])];
        const count = controller.options.numberOfProcessors;
        if (
            this.targets.length !== count ||
            this.gdbTargets.length !== count ||
            new Set(this.targets).size !== count ||
            new Set(this.gdbTargets).size !== count ||
            this.targets.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) ||
            this.gdbTargets.some(
                (endpoint) =>
                    typeof endpoint !== "string" ||
                    !/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint) ||
                    Number(endpoint.split(":")[1]) > 65535
            )
        )
            throw groupError("OpenOCD did not confirm every shared target and GDB endpoint");
        this.onFailure = onFailure;
        this.lifecycleOptions = lifecycleOptions;
        this.members = new Map();
        this.stopping = null;
        this.stopped = false;
    }
    validateJoin(workspace, config, request) {
        if (this.stopped || this.stopping || !this.controller.ready)
            throw groupError("The shared debug server is not ready", "DEBUG_GROUP_NOT_READY");
        if (workspace !== this.workspace || config.serverGroup !== this.id || groupIdentity(config) !== this.identity)
            throw groupError("The shared group requires the same workspace and physical server configuration");
        if (this.members.size && request !== "attach")
            throw groupError("Join an existing serverGroup with attach; launch could reset or download another core");
        if ([...this.members.values()].some((member) => member.lifecycle.pending))
            throw groupError("Wait for the pending core to initialize before joining", "DEBUG_GROUP_BUSY");
        const core = config.targetProcessor;
        if (!Number.isInteger(core) || !this.gdbTargets[core]) throw groupError("Invalid shared target index");
        if (config.targetName !== undefined && config.targetName !== this.targets[core])
            throw groupError("targetName does not match the confirmed OpenOCD core");
        if ([...this.members.values()].some((member) => member.core === core))
            throw groupError("This core already has a pending or active GDB session", "DEBUG_GROUP_CORE_BUSY");
    }
    reserve(workspace, config, request) {
        this.validateJoin(workspace, config, request);
        const token = crypto.randomUUID();
        const member = {
            token,
            core: config.targetProcessor,
            session: null,
            lifecycle: new DebugLifecycle(this.lifecycleOptions),
            connection: this.gdbTargets[config.targetProcessor],
            target: this.targets[config.targetProcessor],
            gate: null
        };
        this.members.set(token, member);
        member.gate = member.lifecycle.arm(60000, () => this.onFailure?.(token, "Shared core startup timed out"));
        return member;
    }
    match(session) {
        const config = session?.configuration;
        const member = this.members.get(config?.__emberprobeManagedToken);
        if (
            !member ||
            config.serverGroup !== this.id ||
            config.targetProcessor !== member.core ||
            config.gdbTarget !== member.connection
        )
            return null;
        const workspace = session.workspaceFolder?.uri?.toString?.();
        if (workspace && workspace !== this.workspace) return null;
        if (member.session && session.id && member.session.id !== session.id) return null;
        return member;
    }
    bind(session) {
        const member = this.match(session);
        if (!member) return null;
        member.session = session;
        member.lifecycle.session = session;
        return member;
    }
    message(session, message) {
        const member = this.match(session);
        if (!member) return null;
        if (session.id) this.bind(session);
        if (message.type === "event" && message.event === "initialized")
            member.lifecycle.markInitialized(session, true);
        if (message.type === "response" && ["launch", "attach"].includes(message.command)) {
            member.lifecycle.markLaunchResponse(session, true, message.success !== false, { message: message.message });
            if (message.success === false)
                void this.onFailure?.(member.token, message.message || "Core startup failed");
        }
        return member;
    }
    async release(token) {
        const member = this.members.get(token);
        if (!member) return;
        this.members.delete(token);
        member.lifecycle.clear({ kind: "terminated" });
        if (!this.members.size) await this.stop();
    }
    stop() {
        if (this.members.size)
            return Promise.reject(groupError("Shared core sessions still own this server", "DEBUG_GROUP_BUSY"));
        if (this.stopping) return this.stopping;
        this.stopping = Promise.resolve()
            .then(() => this.controller.stop())
            .then((closed) => {
                if (closed === false)
                    throw groupError("Shared server exit was not confirmed", "DEBUG_SERVER_STOP_FAILED");
                this.stopped = true;
                this.lease.release();
            })
            .catch((error) => {
                this.stopping = null;
                throw error;
            });
        return this.stopping;
    }
}

module.exports = { SharedDebugGroup, groupIdentity };
