"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { loadProvider } = require("./helpers/load-provider");
const { minimalElf, buildElf32 } = require("./helpers/elf-fixture");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { DebugLifecycle } = require("../src/services/debugLifecycle");
const { OpenOcdStatusService } = require("../src/services/openocdStatusService");
const { ChartHistoryService } = require("../src/services/chartHistoryService");
const { HumanApprovalService } = require("../src/services/humanApprovalService");
const { SkillStatusService } = require("../src/services/skillStatusService");
const { AgentService } = require("../src/services/agentService");
const { FlashService } = require("../src/services/flashService");
const { MiClient } = require("../src/debug/mi");
const { runCubeMx } = require("../src/services/cubemxRunner");
const { CubeMxService } = require("../src/services/cubemxService");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { parseElfSymbols } = require("../src/elfSymbols");
const { assertReadable } = require("../src/services/svdPeripheralService");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function providerFixture() {
    const sessions = [],
        statuses = [];
    class Session {
        constructor(_vscode, _options, events) {
            this.events = events;
            sessions.push(this);
        }
        setWatch() {}
        setSamplingEnabled(value) {
            this.enabled = value;
        }
        async start() {
            this.started = true;
        }
        async stop() {
            return true;
        }
    }
    const P = loadProvider(
        { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
        { "./liveWatch": { LiveWatchSession: Session } }
    );
    const p = Object.create(P.prototype);
    Object.assign(p, {
        _probeCoordinator: new ProbeCoordinator(),
        _samplingCoordinator: new SamplingCoordinator(),
        _debugLifecycle: new DebugLifecycle(),
        _probeConnectionService: { prepare: async () => ({}) },
        _debugBridge: { setIntent() {}, agentStatus: () => ({ state: "inactive" }) },
        _context: { workspaceState: { get: () => "configured" } },
        _liveConsumers: new Set(),
        _activeReadPlan: () => [{ name: "tick", address: 0x20000000, size: 4 }],
        _setLiveInterval() {},
        _commandContext: () => ({}),
        _t: (key) => key,
        _resolveTclPort: async () => 1234,
        _resolveOpenOcdPath: async () => "fake",
        _postConsumerStatuses: (status) => statuses.push(status),
        _postLive() {},
        _postAgentSampling() {},
        _handleRawSamples: () => {
            throw Error("Late sample accepted");
        }
    });
    return { p, sessions, statuses };
}
(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-confirmed-"));
    try {
        const { p, sessions, statuses } = providerFixture();
        const elf = deferred();
        p._elfService = { workerPath: "fake", ready: () => elf.promise };
        const starting = p.startLiveWatch();
        await tick();
        const stopping = p.stopLiveWatch();
        elf.resolve();
        await Promise.all([starting, stopping]);
        assert.strictEqual(p._samplingIntent, false);
        assert.strictEqual(sessions.length, 0);
        p._elfService = null;
        await p.startLiveWatch();
        const exit = deferred();
        const live = sessions[0];
        let accepted = 0;
        p._handleRawSamples = () => {
            accepted++;
        };
        await p.startLiveWatch();
        live.events.onSample([], 1);
        assert.strictEqual(accepted, 1, "refreshing an active watch plan must keep receiving its samples");
        live.stop = () => exit.promise;
        live.events.onDisconnect(Object.assign(Error("USB removed"), { i18nKey: "live.probeDisconnected" }));
        assert.strictEqual(live.enabled, false);
        assert.strictEqual(statuses.at(-1).key, "live.disconnecting");
        live.events.onSample([], 1);
        assert.strictEqual(accepted, 1, "disconnect must discard late samples from the same session");
        assert.strictEqual(p._probeCoordinator.firstActive(), "liveWatch");
        exit.resolve(false);
        await assert.rejects(p._liveStopPromise, { code: "PROBE_EXIT_UNCONFIRMED" });
        assert.strictEqual(statuses.at(-1).key, "cpu.exitUnconfirmed");
        assert.strictEqual(p._liveSession, live);
        live.stop = async () => true;
        await p.stopLiveWatch();
        assert.strictEqual(p._probeCoordinator.anyActive(), false);
        for (const phase of ["prepare", "port"]) {
            const fixture = providerFixture(),
                gate = deferred();
            if (phase === "prepare") fixture.p._probeConnectionService.prepare = () => gate.promise;
            else fixture.p._resolveTclPort = () => gate.promise;
            const read = fixture.p._withAgentProbe(async () => {
                throw Error("Cancelled handler ran");
            });
            const rejected = assert.rejects(read, { code: "AGENT_READ_CANCELLED" });
            await tick();
            const cancelled = fixture.p.stopAgentReadIfRunning();
            gate.resolve(phase === "prepare" ? {} : 1234);
            await Promise.all([rejected, cancelled]);
            assert.strictEqual(fixture.sessions.length, 0);
            assert.strictEqual(fixture.p._probeCoordinator.anyActive(), false);
        }
        const probe = deferred();
        const checker = {
            probeOpenOcd: () => probe.promise,
            getCachedResult: () => null,
            isCompatibleResult: () => false,
            setCache() {},
            resolveOpenOcdStatus: async (_target, _context, result, report) => {
                report({ state: "ready" });
                return result.path;
            }
        };
        const status = new OpenOcdStatusService({
            checker,
            context: {},
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            onStatus() {}
        });
        const resolving = status.resolve("openocd"),
            refreshing = status.refresh();
        probe.resolve({ path: "valid-openocd" });
        assert.deepStrictEqual(await Promise.all([resolving, refreshing]), ["valid-openocd", "valid-openocd"]);
        const history = new ChartHistoryService();
        history.fail(Error("Forced failure"));
        await history.termination;
        assert.strictEqual(history.worker.threadId, -1);
        await history.restart();
        assert.ok(history.worker.threadId > 0);
        await history.dispose();
        const unit = Buffer.alloc(6);
        unit.writeUInt32LE(2);
        assert.throws(
            () =>
                parseDwarfInternal(
                    buildElf32({
                        sections: [
                            { name: ".debug_info", data: Buffer.concat(Array(20000).fill(unit)) },
                            { name: ".debug_abbrev", data: Buffer.from([0]) }
                        ]
                    })
                ),
            { code: "DWARF_BUDGET_EXCEEDED" }
        );
        assert.throws(
            () =>
                parseElfSymbols(
                    buildElf32({
                        sections: [
                            { name: ".strtab", type: 3, data: Buffer.from("\0a\0") },
                            { name: ".symtab", type: 2, entsize: 16, link: 1, data: Buffer.alloc(200001 * 16) }
                        ]
                    })
                ),
            { code: "ELF_SYMBOL_BUDGET_EXCEEDED" }
        );
        assert.throws(() => assertReadable({ size: 32, address: 0x40000001, fields: [] }), {
            code: "PERIPHERAL_ADDRESS_UNALIGNED"
        });
        const image = path.join(root, "selected.elf"),
            before = minimalElf("approved"),
            after = minimalElf("replaced");
        await fs.writeFile(image, before);
        let consumed;
        const flash = new FlashService({
            runOpenOcd: async (_vscode, options) => {
                consumed = await fs.readFile(options.elf);
            }
        });
        await flash.download(
            {},
            {
                elf: image,
                prepare: async () => {
                    await fs.writeFile(image, after);
                    return {};
                }
            }
        );
        assert.deepStrictEqual(consumed, before);
        let choice,
            dialogs = 0;
        const state = {};
        const human = new HumanApprovalService(
            {
                window: {
                    showWarningMessage: async () => {
                        dialogs++;
                        return choice;
                    }
                }
            },
            (key) => key,
            {
                get: (key) => state[key],
                update: async (key, value) => {
                    state[key] = value;
                }
            }
        );
        await assert.rejects(human.approve("write", { elf: { sha256: "one" } }), { code: "HUMAN_APPROVAL_DENIED" });
        choice = "approval.workspace";
        await human.approve("write", { elf: { sha256: "one" } }, true);
        const count = dialogs;
        await human.approve("write", { elf: { sha256: "one" }, items: ["other value"] }, true);
        assert.strictEqual(dialogs, count);
        await human.approve("write", { elf: { sha256: "two" } }, true);
        assert.strictEqual(dialogs, count + 1);
        await human.reset("write");
        await human.approve("write", { elf: { sha256: "one" } }, true);
        assert.strictEqual(dialogs, count + 2, "reset must revoke the independent UI permission too");
        const dialog = deferred();
        human.vscode.window.showWarningMessage = () => dialog.promise;
        const approving = human.approve("write", { elf: { sha256: "pending" } }, true);
        await human.reset("write");
        dialog.resolve("approval.workspace");
        await assert.rejects(approving, { code: "HUMAN_APPROVAL_REVOKED" });
        const variable = providerFixture().p;
        let identity = "before",
            attemptedWrites = 0;
        variable._prepareRequestedLayouts = async () => {};
        variable._agentWritePlan = () => ({
            elfResult: { elf: { path: "firmware.elf", sha256: identity } },
            items: [{ name: "x", address: 0x20000000, size: 4, type: "u32", value: 1, bytes: [1, 0, 0, 0] }]
        });
        variable._prepareWriteConnection = async () => ({
            kind: "dap",
            sessionId: "debug",
            workspace: "workspace",
            stopEpoch: 1
        });
        variable._writeAuthorization = { authorize: () => ({ authorized: true }) };
        variable._executeWritePlan = async () => {
            attemptedWrites++;
        };
        variable._humanApproval = {
            approve: async () => {
                throw Object.assign(Error("denied"), { code: "HUMAN_APPROVAL_DENIED" });
            }
        };
        await assert.rejects(variable._writeAgentVariables({ values: [] }), { code: "HUMAN_APPROVAL_DENIED" });
        variable._humanApproval.approve = async () => {
            identity = "after";
            return { remember: false };
        };
        await assert.rejects(variable._writeAgentVariables({ values: [] }), { code: "WRITE_CONFIRMATION_INVALID" });
        assert.strictEqual(attemptedWrites, 0);
        let skillHash = "one",
            skillDialogs = 0;
        const skills = new SkillStatusService({
            installer: {
                inspectSkills: async () => ({ state: "modified", scopes: { workspace: { fingerprint: skillHash } } })
            },
            onStatus() {},
            t: (key) => key,
            vscode: {
                window: {
                    showWarningMessage: async () => {
                        skillDialogs++;
                        return "approval.skillsAllow";
                    }
                }
            }
        });
        await skills.checkForCall();
        await skills.checkForCall();
        assert.strictEqual(skillDialogs, 1);
        skillHash = "two";
        await skills.checkForCall();
        assert.strictEqual(skillDialogs, 2);
        skills.vscode.window.showWarningMessage = async () => {
            skillHash = "changed-in-dialog";
            return "approval.skillsAllow";
        };
        skillHash = "three";
        await assert.rejects(skills.checkForCall(), { code: "SKILLS_CHANGED_DURING_APPROVAL" });
        const untrusted = new AgentService({
            isTrusted: () => false,
            handlers: {
                write: () => {
                    attemptedWrites++;
                }
            }
        });
        await assert.rejects(untrusted.call("write"), { code: "WORKSPACE_UNTRUSTED" });
        await assert.rejects(untrusted.start(), { code: "WORKSPACE_UNTRUSTED" });
        assert.strictEqual(attemptedWrites, 0);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.exitCode = null;
        child.pid = 100;
        const kills = [];
        child.kill = (signal) => {
            kills.push(signal || "SIGTERM");
        };
        const mi = new MiClient({ spawn: () => child, killGraceMs: 5 });
        mi.start("fake");
        mi.fail(Error("Failed"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepStrictEqual(kills, ["SIGTERM", "SIGKILL"]);
        child.emit("exit");
        const cubeChild = new EventEmitter();
        cubeChild.stdout = new EventEmitter();
        cubeChild.stderr = new EventEmitter();
        cubeChild.pid = 101;
        const cubeKills = [];
        cubeChild.kill = (signal) => cubeKills.push(signal || "SIGTERM");
        const cube = new CubeMxService({ storage: { get() {} }, storageDir: root });
        cube.jobs.set(root, { controller: new AbortController() });
        await assert.rejects(
            runCubeMx({ executable: "fake", platform: "linux" }, root, "project.ioc", {
                spawn: () => cubeChild,
                timeoutMs: 5,
                killGraceMs: 5,
                exitTimeoutMs: 30,
                onExitUnconfirmed: (exited, retry) => cube._retainProcess(root, exited, retry)
            }),
            { code: "CUBEMX_EXIT_UNCONFIRMED" }
        );
        await cube._finishJob(root, "operation");
        assert.ok(cube.jobs.has(root), "retain project ownership while process is alive");
        cube.cancel();
        assert.ok(cubeKills.includes("SIGKILL"));
        cubeChild.emit("close", 1);
        await tick();
        assert.strictEqual(cube.jobs.has(root), false);
        console.log("Confirmed lifecycle, termination, approval, image identity and input budget regressions passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
