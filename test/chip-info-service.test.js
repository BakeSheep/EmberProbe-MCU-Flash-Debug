"use strict";
const assert = require("assert");
const { ChipInfoService } = require("../src/services/chipInfoService");
const { createFixture } = require("./helpers/service-fixture");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        const active = new Set();
        const chipPosts = [];
        let chipDiagnostics = null;
        let targetState = "running";
        const actions = [];
        const chipService = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: (key) => (key === "debugger" ? "p.cfg" : "t.cfg") } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: {
                readChipInfo: async () => ({ core: "Cortex-M4", targetState }),
                controlTarget: async (_options, action) => {
                    actions.push(action);
                    targetState = action === "pause" ? "halted" : "running";
                    return { state: targetState };
                }
            },
            coordinator: {
                isActive: (name) => active.has(name),
                acquire: (name) => {
                    active.add(name);
                    return { release: () => active.delete(name) };
                }
            },
            t: (key) => key,
            resolveExecutable: async (value) => value,
            commandContext: () => ({ cwd: temp }),
            onPost: (message) => chipPosts.push(message),
            onDiagnostics: (diagnostic) => {
                chipDiagnostics = diagnostic;
            },
            isDebugActive: () => false
        });
        const chipResult = await chipService.read();
        assert.strictEqual(chipResult.core, "Cortex-M4");
        assert.ok(Number.isFinite(Date.parse(chipResult.readAt)));
        assert.strictEqual(chipService.running, false);
        assert.ok(chipPosts.some((message) => message.type === "chipInfo"));
        assert.strictEqual(chipDiagnostics.target, "t.cfg");
        assert.ok(chipDiagnostics.timings.totalMs >= 0);
        // Preflight failures must acknowledge the optimistic sidebar spinner without touching hardware.
        for (const stage of ["missing-target", "probe", "lease", "executable", "connection"]) {
            const posts = [];
            const coordinator = new ProbeCoordinator();
            let discovery = 0;
            let reads = 0;
            const failure = Object.assign(new Error(`${stage} failed`), { code: "PREFLIGHT_FAILED" });
            const service = new ChipInfoService({
                ...chipService,
                context: {
                    workspaceState: { get: (key) => (key === "target" && stage !== "missing-target" ? "t.cfg" : "") }
                },
                coordinator,
                resolveProbe: async () => {
                    discovery++;
                    if (stage === "probe") throw failure;
                    return "p.cfg";
                },
                resolveExecutable: async () => {
                    if (stage === "executable") throw failure;
                    return "openocd";
                },
                prepareConnection: async () => {
                    if (stage === "connection") throw failure;
                    return {};
                },
                chipInfo: {
                    readChipInfo: async () => {
                        reads++;
                        return { core: "Cortex-M4" };
                    }
                },
                onPost: (message) => posts.push(message)
            });
            if (stage === "lease")
                coordinator.acquire = () => {
                    throw failure;
                };
            for (const forAgent of [false, true]) {
                posts.length = 0;
                if (forAgent)
                    await assert.rejects(service.read(true), {
                        code: stage === "missing-target" ? "CONFIG_INCOMPLETE" : "PREFLIGHT_FAILED"
                    });
                else assert.strictEqual(await service.read(), null);
                assert.strictEqual(posts.at(-1).type, "chipInfoStatus");
                assert.strictEqual(posts.at(-1).state, "error", stage);
                assert.strictEqual(coordinator.anyActive(), false, `${stage} releases probe ownership`);
                assert.strictEqual(reads, 0, `${stage} cannot start a hardware read`);
            }
            if (stage === "missing-target") assert.strictEqual(discovery, 0, "validate target before probe discovery");
            // No ELF is configured; correcting the prerequisites must still permit a chip read.
            service.context.workspaceState.get = (key) => (key === "target" ? "t.cfg" : "");
            service.resolveProbe = async () => "p.cfg";
            service.resolveExecutable = async () => "openocd";
            service.prepareConnection = async () => ({});
            service.coordinator = new ProbeCoordinator();
            assert.strictEqual((await service.read()).core, "Cortex-M4");
            assert.strictEqual(service.running, false);
        }
        assert.ok(chipDiagnostics.timings.configMs >= 0);
        assert.ok(chipDiagnostics.timings.preflightMs >= 0);
        assert.ok(chipDiagnostics.timings.openOcdMs >= 0);
        assert.strictEqual((await chipService.control("pause")).targetState, "halted");
        assert.strictEqual((await chipService.control("continue")).targetState, "running");
        assert.strictEqual((await chipService.control("reset")).targetState, "running");
        assert.deepStrictEqual(actions, ["pause", "continue", "reset"]);
        assert.strictEqual(chipService.running, false);
        await assert.rejects(
            () => chipService.control("bogus"),
            (error) => error.code === "CHIP_ACTION_INVALID"
        );
        active.add("download");
        assert.strictEqual(await chipService.read(), null);
        assert.strictEqual(await chipService.control("pause"), null);
        assert.deepStrictEqual(actions, ["pause", "continue", "reset"]);
        assert.ok(chipPosts.some((message) => message.key === "chip.busyDownload"));
        active.delete("download");

        let attachmentId = "arrival-A";
        chipService.prepareConnection = async () => ({
            selectionIdentity: { kind: "usb", anonymous: true, attachmentId }
        });
        await chipService.read();
        attachmentId = "arrival-B";
        for (const action of ["pause", "continue", "reset"]) {
            assert.strictEqual(await chipService.control(action), null);
            assert.strictEqual(chipPosts.at(-1).diagnostic.code, "CHIP_INFO_STALE");
        }
        assert.strictEqual(
            actions.length,
            3,
            "Replacing an anonymous probe cannot control the previously displayed chip"
        );
        await chipService.read();
        assert.strictEqual((await chipService.control("pause")).targetState, "halted");
        attachmentId = "";
        await chipService.read();
        assert.strictEqual(await chipService.control("reset"), null);
        assert.strictEqual(chipPosts.at(-1).diagnostic.code, "PROBE_IDENTITY_UNVERIFIED");
        assert.strictEqual(actions.length, 4);

        for (const selection of ["configured", "remembered"]) {
            let configuredSerial = "";
            let remembered = { version: 1, probe: "cmsis-dap.cfg", probeSerial: "probe-A" };
            const inventory = {
                available: true,
                devices: ["probe-A", "probe-B"].map((serial) => ({ family: "cmsis-dap", serial, id: serial })),
                notes: []
            };
            const connections = new ProbeConnectionService({
                getConfig: () => ({
                    debugger: "cmsis-dap.cfg",
                    mcu: "stm32f4x.cfg",
                    probeSerial: configuredSerial,
                    transport: "swd",
                    openocdPath: "openocd"
                }),
                getSuccessfulConnection: () => remembered,
                prepareConnection: async (request) => resolveProbeConnection(request, inventory)
            });
            const coordinator = new ProbeCoordinator();
            const posts = [];
            const reads = [];
            const controls = [];
            const service = new ChipInfoService({
                vscode,
                context,
                cacheKeys,
                chipInfo: {
                    readChipInfo: async (_vscode, request) => {
                        reads.push(request);
                        return { core: "Cortex-M4", uid: request.probeSerial, targetState: "running" };
                    },
                    controlTarget: async (request, action) => {
                        controls.push({ request, action });
                        return { state: "halted" };
                    }
                },
                coordinator,
                t: (key) => key,
                resolveExecutable: async (value) => value,
                prepareConnection: (request, interactive) => connections.prepare(request, interactive),
                commandContext: () => ({ cwd: temp }),
                onPost: (message) => posts.push(message),
                onDiagnostics() {},
                isDebugActive: () => false
            });
            state.set(cacheKeys.debugger, "cmsis-dap.cfg");
            state.set(cacheKeys.mcuCore, "stm32f4x.cfg");
            assert.strictEqual((await service.read()).uid, "probe-A");
            assert.strictEqual(service.infoConnection.probeSerial, "probe-A");
            assert.strictEqual((await service.control("pause")).uid, "probe-A");
            assert.strictEqual(controls[0].request.probeSerial, "probe-A", "control uses the compared resolved serial");
            const displayed = service.info;
            const readCount = reads.length;
            if (selection === "configured") configuredSerial = "probe-B";
            else remembered = { ...remembered, probeSerial: "probe-B" };
            for (const action of ["pause", "continue", "reset"]) {
                assert.strictEqual(await service.control(action), null);
                assert.strictEqual(posts.at(-1).key, "chip.readAgain");
                assert.strictEqual(posts.at(-1).diagnostic.code, "CHIP_INFO_STALE");
                assert.strictEqual(service.info, displayed, "stale rejection preserves the displayed identity");
                assert.strictEqual(reads.length, readCount, "stale controls cannot read or operate on probe B");
                assert.strictEqual(controls.length, 1);
                assert.strictEqual(coordinator.isActive("chipInfo"), false);
                coordinator.acquire("agentRead").release();
            }
            assert.strictEqual((await service.read()).uid, "probe-B");
            assert.strictEqual(service.infoConnection.probeSerial, "probe-B");
            assert.strictEqual((await service.control("pause")).uid, "probe-B");
            assert.strictEqual(controls.at(-1).request.probeSerial, "probe-B");
        }

        const unavailableChip = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: () => "configured.cfg" } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: { readChipInfo: async () => ({}) },
            coordinator: {
                isActive: () => false,
                acquire: () => ({ release: () => {} })
            },
            t: (key) => key,
            resolveExecutable: async () => null,
            commandContext: () => ({ cwd: temp }),
            onPost: () => {},
            onDiagnostics: () => {},
            isDebugActive: () => false
        });
        await assert.rejects(
            () => unavailableChip.read(true),
            (error) => error.code === "OPENOCD_NOT_READY"
        );
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
