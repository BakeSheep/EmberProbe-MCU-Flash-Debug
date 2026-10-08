"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { EmberDebugSession } = require("../src/debug/session");
const { MiClient } = require("../src/debug/mi");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { validateDebugConfiguration } = require("../src/services/debugConfiguration");
const {
    normalizeExternalTarget,
    resolveExternalSettings,
    ExternalDebugService,
    HOLD_KEY
} = require("../src/services/externalDebugService");

function fixture(marker = null, alive = false) {
    const values = new Map(marker ? [[HOLD_KEY, marker]] : []);
    const config = { "experimental.externalGdb.enabled": true, "experimental.externalGdb.target": "localhost:3333" };
    const settings = { get: (key, fallback) => config[key] ?? fallback };
    const state = { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) };
    const coordinator = new ProbeCoordinator();
    const service = new ExternalDebugService({
        state,
        coordinator,
        settings: () => settings,
        isProcessAlive: () => alive
    });
    return { values, config, settings, state, coordinator, service };
}

class FakeMi extends EventEmitter {
    constructor(state = "stopped") {
        super();
        this.state = state;
        this.commands = [];
        this.process = { pid: 123 };
        this.closed = false;
        this.exitConfirmed = true;
    }
    start() {}
    async stop() {
        this.closed = true;
    }
    async waitForExit() {
        return this.exitConfirmed;
    }
    async command(command) {
        this.commands.push(command);
        if (this.failOn && command.includes(this.failOn)) throw new Error("fixture failure");
        if (command === "-thread-info") return { threads: [{ id: "7", state: this.state }], "current-thread-id": "7" };
        if (command === "-exec-interrupt --all") {
            this.state = "stopped";
            this.emit("record", { kind: "*", class: "stopped", data: { "thread-id": "7" } });
        }
        if (command.startsWith("-exec-continue")) this.emit("record", { kind: "*", class: "running", data: {} });
        if (command.startsWith("-stack-list-frames")) return { stack: [{ frame: { level: "0", func: "main" } }] };
        if (command.startsWith("-var-create")) return { name: "v1", value: "1", type: "int", numchild: "0" };
        return {};
    }
}

function adapter(state) {
    const mi = new FakeMi(state);
    const session = new EmberDebugSession({ mi });
    const events = [];
    session.sendEvent = (event) => events.push(event);
    const config = {
        request: "attach",
        servertype: "external",
        executable: __filename,
        gdbPath: "fake",
        gdbTarget: "[::1]:3333",
        __emberprobeExternalMode: "remote"
    };
    return { mi, session, events, config };
}

(async () => {
    for (const target of ["localhost:3333", "127.0.0.1:1", "debug.example:65535", "[::1]:3333"])
        assert.strictEqual(normalizeExternalTarget(target), target);
    for (const target of [
        null,
        1,
        "",
        "host:0",
        "host:65536",
        "host:1\n",
        "host:1 x",
        "|shell",
        "tcp:host:3333",
        "COM1",
        "[host]:3",
        "host:1;quit",
        "host:1\x7f"
    ])
        assert.throws(() => normalizeExternalTarget(target));
    const f = fixture();
    assert.deepStrictEqual(resolveExternalSettings(f.settings), {
        gdbTarget: "localhost:3333",
        mode: "extended-remote"
    });
    assert(Object.isFrozen(resolveExternalSettings(f.settings)));
    f.config["experimental.externalGdb.connectionMode"] = "bad";
    assert.throws(() => resolveExternalSettings(f.settings));
    f.config["experimental.externalGdb.enabled"] = false;
    assert.throws(() => resolveExternalSettings(f.settings), { code: "EXTERNAL_GDB_DISABLED" });
    assert.strictEqual(f.service.held, false);
    f.service.assertPhysicalAvailable();
    f.config["experimental.externalGdb.enabled"] = true;
    f.config["experimental.externalGdb.connectionMode"] = "remote";
    const folder = { uri: { fsPath: __dirname } };
    for (const key of [
        "gdbTarget",
        "serverpath",
        "serverGroup",
        "numberOfProcessors",
        "targetProcessor",
        "targetName",
        "__emberprobeExternalMode"
    ])
        assert.throws(() =>
            validateDebugConfiguration({ request: "attach", servertype: "external", [key]: "bad" }, folder)
        );
    assert.throws(() => validateDebugConfiguration({ request: "launch", servertype: "external" }, folder));
    assert.strictEqual(
        validateDebugConfiguration({ request: "attach", servertype: "external" }, folder).servertype,
        "external"
    );

    const reservation = await f.service.reserve(__dirname, resolveExternalSettings(f.settings));
    const hostSession = { id: "external", configuration: { __emberprobeManagedToken: reservation.token } };
    assert(f.service.bind(hostSession));
    assert(f.service.bind(hostSession));
    await f.service.request(hostSession, { command: "initialize" });
    assert.strictEqual(f.service.marker.cleanupConfirmed, false, "cleanup uncertainty is durable before GDB starts");
    await f.service.request(hostSession, { command: "attach" });
    assert.strictEqual(f.service.marker.cleanupConfirmed, false);
    assert(!f.service.bind({ id: "other", configuration: {} }));
    assert.throws(() => f.service.assertPhysicalAvailable(), { code: "EXTERNAL_GDB_PROBE_HELD" });
    for (const operation of ["download", "liveStart", "chipInfo", "agentRead", "debugStart"])
        assert.throws(() => f.coordinator.acquire(operation), { code: "PROBE_BUSY" });
    await assert.rejects(f.service.reserve(__dirname, {}), { code: "EXTERNAL_GDB_BUSY" });
    await f.service.message(hostSession, { type: "event", event: "emberprobe.externalGdbProcess", body: { pid: 123 } });
    f.config["experimental.externalGdb.enabled"] = false;
    assert.strictEqual(
        await f.service.releaseIfDisabled(),
        false,
        "active connection holds the lease even when disabled"
    );
    await f.service.message(hostSession, {
        type: "event",
        event: "emberprobe.externalGdbProcess",
        body: { exited: true }
    });
    await f.service.finish(hostSession);
    assert(!f.service.held);
    assert(!f.coordinator.anyActive());
    await f.service.finish();
    const normal = f.coordinator.acquire("debugStart");
    normal.release();

    const pending = fixture({ folder: __dirname, token: "old", cleanupConfirmed: false, pid: 123 }, true);
    pending.config["experimental.externalGdb.enabled"] = false;
    assert.strictEqual(await pending.service.releaseIfDisabled(), false);
    await assert.rejects(pending.service.reserve(__dirname, {}), { code: "EXTERNAL_GDB_CLEANUP_PENDING" });
    await assert.rejects(pending.service.reserve("elsewhere", {}), { code: "EXTERNAL_GDB_BUSY" });
    pending.service.isProcessAlive = () => false;
    assert.strictEqual(
        await pending.service.releaseIfDisabled(),
        true,
        "reload can confirm a recorded GDB pid has exited"
    );
    const uncertain = fixture({ folder: __dirname, token: "old", cleanupConfirmed: false, pid: null });
    uncertain.config["experimental.externalGdb.enabled"] = false;
    assert.strictEqual(await uncertain.service.releaseIfDisabled(), false);
    const retained = fixture({ folder: __dirname, token: "old", cleanupConfirmed: true, pid: null });
    assert.strictEqual(await retained.service.releaseIfDisabled(), false);
    retained.config["experimental.externalGdb.enabled"] = false;
    assert.strictEqual(await retained.service.releaseIfDisabled(), true);
    const storageFailure = fixture();
    storageFailure.state.update = async () => {
        throw new Error("storage failure");
    };
    await assert.rejects(storageFailure.service.reserve(__dirname, {}), /storage failure/);
    assert.strictEqual(storageFailure.service.active, false);
    assert.strictEqual(storageFailure.coordinator.anyActive(), false);
    const cancelled = fixture();
    await cancelled.service.reserve(__dirname, {});
    await cancelled.service.finish();
    assert(cancelled.service.marker.cleanupConfirmed, "cancellation before attach confirms no local GDB");
    cancelled.config["experimental.externalGdb.enabled"] = false;
    cancelled.state.update = async () => {
        throw new Error("release storage failure");
    };
    await assert.rejects(cancelled.service.releaseIfDisabled(), /release storage failure/);
    assert(cancelled.service.held);
    assert(cancelled.coordinator.anyActive());
    const releaseRace = fixture({ folder: __dirname, token: "old", cleanupConfirmed: true, pid: null });
    releaseRace.config["experimental.externalGdb.enabled"] = false;
    let completeClear;
    releaseRace.state.update = () =>
        new Promise((resolve) => {
            completeClear = resolve;
        });
    const releasing = releaseRace.service.releaseIfDisabled();
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => releaseRace.service.assertPhysicalAvailable(), { code: "EXTERNAL_GDB_PROBE_HELD" });
    assert.throws(() => releaseRace.coordinator.acquire("download"), { code: "PROBE_BUSY" });
    completeClear();
    assert.strictEqual(await releasing, true);
    assert(!releaseRace.service.held);

    for (const state of ["stopped", "running"]) {
        const a = adapter(state);
        await a.session.handle("attach", a.config);
        assert(a.mi.commands.includes("-target-select remote [::1]:3333"));
        assert.strictEqual(a.mi.commands.includes("-exec-interrupt --all"), state === "running");
        assert(!a.mi.commands.some((command) => /monitor|download|break-insert/.test(command)));
        assert(a.events.some((event) => event.body?.capabilities?.supportsRestartRequest === false));
        await a.session.handle("configurationDone", {});
        assert.strictEqual(a.events.find((event) => event.event === "stopped").body.threadId, 7);
        const frame = (await a.session.handle("stackTrace", { threadId: 7 })).stackFrames[0];
        await a.session.handle("evaluate", { expression: "counter", frameId: frame.id });
        assert(a.mi.commands.some((command) => command.includes("--thread 7 --frame 0")));
        await assert.rejects(a.session.handle("restart", {}), /unsupported/);
        await a.session.handle("continue", { threadId: 7 });
        assert(a.mi.commands.includes("-exec-continue --thread 7"));
        await assert.rejects(a.session.handle("scopes", { frameId: frame.id }), /paused|Stale/);
        await a.session.handle("disconnect", {});
        await a.session.closeExternal();
        assert.strictEqual(a.mi.commands.filter((command) => command === "-target-disconnect").length, 1);
        assert(a.events.some((event) => event.event === "emberprobe.externalGdbProcess" && event.body.exited));
    }
    for (const failure of ["unknown", "hook", "connect", "exit"]) {
        const a = adapter(failure === "unknown" ? "unknown" : "stopped");
        if (failure === "hook") {
            a.config.preAttachCommands = ["bad-hook"];
            a.mi.failOn = "bad-hook";
        }
        if (failure === "connect") a.mi.failOn = "target-select";
        if (failure === "exit") a.mi.exitConfirmed = false;
        if (failure !== "exit") await assert.rejects(a.session.handle("attach", a.config));
        else await a.session.handle("attach", a.config);
        if (failure === "exit") await assert.rejects(a.session.close(), /exit could not be confirmed/);
        else await a.session.close();
        assert.strictEqual(
            a.events.some((event) => event.body?.exited),
            failure !== "exit"
        );
        if (failure === "exit") {
            a.mi.exitConfirmed = true;
            await a.session.closeExternal();
            assert(
                a.events.some((event) => event.body?.exited),
                "unconfirmed exit must allow a later cleanup retry"
            );
        }
    }
    const child = new EventEmitter();
    Object.assign(child, {
        pid: 123,
        exitCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill() {}
    });
    const mi = new MiClient({ spawn: () => child });
    assert.strictEqual(await mi.waitForExit(), true);
    mi.start("fake", __dirname);
    assert.strictEqual(await mi.waitForExit(1), false);
    const exit = mi.waitForExit();
    child.emit("exit", 0);
    assert.strictEqual(await exit, true);
    assert.strictEqual(await mi.waitForExit(), true);
    console.log("External GDB configuration, ownership, MI lifecycle and thread isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
