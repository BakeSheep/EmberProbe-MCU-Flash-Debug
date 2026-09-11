"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { encodeValue, expandCompositeLeaves, parseMemberPath } = require("../src/elfSymbols");
const { createFormReader } = require("../src/dwarf/forms");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { FlashAuthorization } = require("../src/flashAuthorization");
const { loadProvider } = require("./helpers/load-provider");

(async () => {
    assert.throws(
        () => encodeValue("1e39", "f32"),
        (error) => error.code === "INVALID_WRITE_VALUE"
    );
    const symbol = { name: "sensor", address: 0x20000000, size: 4 };
    const layout = { kind: "struct", byteSize: 4, members: [{ name: "x", offset: 0, byteSize: 4, watchType: "u32" }] };
    assert.deepStrictEqual(expandCompositeLeaves(symbol, layout, parseMemberPath("sensor.x.invalid")), []);
    const array = {
        kind: "array",
        byteSize: 4,
        totalElements: 4,
        elementType: { byteSize: 1, watchType: "u8", kind: "scalar" }
    };
    assert.deepStrictEqual(expandCompositeLeaves(symbol, array, parseMemberPath("sensor[0].x")), []);
    assert.throws(() => expandCompositeLeaves(symbol, { ...array, totalElements: 100000000 }, null), /budget/);
    assert.throws(() => expandCompositeLeaves({ ...symbol, address: 0xffffffff }, layout, null), /budget/);
    assert.throws(
        () => expandCompositeLeaves(symbol, { ...layout, members: [{ ...layout.members[0], offset: 4 }] }, null),
        /budget/
    );
    const reader = createFormReader({ buf: Buffer.from([10, 3, 0]), str: null, lineStr: null });
    assert.throws(() => reader({ p: 0 }, 0x09, {}), /Truncated/);
    assert.throws(
        () => createFormReader({ buf: Buffer.from("name"), str: null, lineStr: null })({ p: 0 }, 0x08, {}),
        /Unterminated/
    );
    const indirect = createFormReader({ buf: Buffer.alloc(100, 0x16), str: null, lineStr: null });
    assert.throws(() => indirect({ p: 0 }, 0x16, {}), /nesting/);

    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    provider._elfService = { invalidate() {} };
    provider.readElfSymbols = () => ({
        elf: { path: "missing" },
        symbols: [
            {
                ...symbol,
                isComposite: true,
                compositeLayout: { ...layout, members: [{ ...layout.members[0], bitSize: 4, bitOffset: 0 }] }
            }
        ]
    });
    assert.throws(() => provider._agentWritePlan([{ name: "sensor.x", value: 1 }]), /Bitfield writes/);
    provider._configurationStore = { snapshot: () => ({}) };
    provider._svdManager = {
        peekBound: async () => null,
        currentPath: () => {
            throw new Error("must not resolve");
        }
    };
    assert.deepStrictEqual(await provider._configurationSnapshot(), { svd: "" });

    const bridge = new DebugSessionBridge();
    const session = { id: "one", customRequest: async () => ({ data: "AQ==" }) };
    bridge.sessions.set(session.id, session);
    bridge.paused = true;
    bridge.capabilities.read = true;
    await assert.rejects(bridge.readPausedMemory(0x20000000, 4), /incomplete/);
    session.customRequest = async () => {
        bridge.stopEpoch++;
        return { data: "AQIDBA==" };
    };
    await assert.rejects(bridge.readPausedMemory(0x20000000, 4), (error) => error.code === "DEBUG_STATE_CHANGED");
    bridge.dispose();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-audit-"));
    try {
        const elf = path.join(root, "firmware.elf");
        await fs.writeFile(elf, "firmware");
        const params = {
            elf,
            elfSha256: crypto.createHash("sha256").update("firmware").digest("hex"),
            target: "t.cfg",
            probe: "p.cfg",
            openocd: "openocd"
        };
        const coordinator = new ProbeCoordinator();
        const authorization = new FlashAuthorization();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let entered;
        const started = new Promise((resolve) => {
            entered = resolve;
        });
        const service = new AgentFlashService({
            coordinator,
            authorization,
            isDebugActive: () => false,
            resolveLaunch: () => ({ executable: "openocd" }),
            check: async () => ({ compatible: true }),
            run: async (options) => {
                assert(options.buildCommands().join(" ").includes("verify_image"));
                entered();
                await gate;
                return { exitCode: 0, openocdTail: ["EP_VERIFY OK"] };
            }
        });
        const active = coordinator.acquire("liveWatch");
        await assert.rejects(service.execute(params, true), (error) => error.code === "PROBE_BUSY");
        active.release();
        await assert.rejects(service.execute({ ...params, elfSha256: "changed" }, true), /ELF changed/);
        await assert.rejects(service.execute(params), /confirmation/);
        const running = service.execute(params, true);
        await started;
        assert.throws(
            () => coordinator.acquire("chipInfo"),
            (error) => error.code === "PROBE_BUSY"
        );
        release();
        assert.strictEqual((await running).verified, true);
        assert.strictEqual(coordinator.anyActive(), false);
        params.confirmationId = authorization.authorize({
            elf: { path: await fs.realpath(elf), sha256: params.elfSha256 },
            target: params.target,
            probe: params.probe,
            openocd: params.openocd
        }).confirmationId;
        service.run = async (options) => {
            assert(options.buildCommands().join(" ").includes("program"));
            return { exitCode: 0, openocdTail: [] };
        };
        assert.strictEqual((await service.execute(params)).verified, true);
        await assert.rejects(service.execute(params), /invalid/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("Audit hardening regression tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
