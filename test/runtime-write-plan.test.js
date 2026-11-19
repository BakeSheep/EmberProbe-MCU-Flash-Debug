"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { waitFor } = require("./helpers/wait");
const { FakeClock } = require("./helpers/fake-clock");
const {
    runtimeWriteRequests,
    resolveRuntimeWriteTargets,
    validateRuntimeWritePlan
} = require("../src/services/runtimeWritePlan");
const { writePlan } = require("../src/services/agentPlans");
const {
    preconditionSpans,
    validateWritePreconditions,
    verifyWritePreconditions
} = require("../src/writePreconditions");
const { decodeValue } = require("../src/elfSymbols");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { WriteExecution } = require("../src/services/writeExecution");
const { WRITE_GUARD } = require("../src/writeAccess");
const { normalizeWatchList } = require("../src/validation");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { WriteAuthorization, fingerprintWritePlan, writeConnectionIdentity } = require("../src/writeAuthorization");
const { connectionIdentity } = require("../skills/_emberprobe/probe-connection");

function fixture(rootType = 1) {
    const base = 0x20000000;
    const memory = Buffer.alloc(4200);
    const types = [
        { kind: "scalar", byteSize: 4, watchType: "f32", typeName: "float" },
        { kind: "pointer", byteSize: 4, target: 2, pointerTarget: "data" },
        {
            kind: "class",
            byteSize: 12,
            fields: [
                { name: "gain", offset: 0, type: 0 },
                { name: "next", offset: 4, type: 1 },
                { name: "enabled", offset: 8, type: 3 }
            ]
        },
        { kind: "scalar", byteSize: 1, watchType: "u8", typeName: "bool", isBoolean: true },
        { kind: "alias", target: 2, isConst: true },
        { kind: "pointer", byteSize: 4, target: 4, pointerTarget: "data" },
        { kind: "alias", target: 1, isConst: true },
        { kind: "array", count: 4, byteSize: 16, target: 0 },
        { kind: "pointer", byteSize: 4, target: 7, pointerTarget: "data" },
        { kind: "pointer", byteSize: 4, target: 0, pointerTarget: "data" },
        {
            kind: "class",
            byteSize: 12,
            typeName: "std::vector<float>",
            stl: "vector",
            args: [0],
            fields: [
                { name: "_M_start", offset: 0, type: 9 },
                { name: "_M_finish", offset: 4, type: 9 },
                { name: "_M_end_of_storage", offset: 8, type: 9 }
            ]
        }
    ];
    const graph = { root: rootType, types };
    const symbol = {
        name: "motor",
        address: base,
        size: types[rootType].byteSize || 4,
        runtimeLayout: graph,
        compositeLayout: { kind: "class", byteSize: 4, members: [], runtimeLayout: graph },
        isComposite: true
    };
    const result = {
        elf: { path: "test.elf", sha256: "test-dynamic" },
        symbols: [symbol],
        memory: {
            sections: [{ addr: base, size: 512, flags: 3 }],
            runtimeRegions: [{ start: base + 512, end: base + 4096 }]
        }
    };
    const read = async (address, size) => Buffer.from(memory.subarray(address - base, address - base + size));
    const word = (address, value) => memory.writeUInt32LE(value, address - base);
    word(base, base + 1024);
    word(base + 1028, base + 1100);
    const clock = new FakeClock();
    const plan = async (name, value = 75, customRead = read, guard) => {
        const requests = runtimeWriteRequests([{ name, value }], result);
        const { targets, checks } = await resolveRuntimeWriteTargets(requests, result, customRead, guard, clock);
        return validateRuntimeWritePlan({
            ...writePlan([{ name, value }], () => result, targets),
            runtimeChecks: checks
        });
    };
    return { base, memory, result, types, symbol, read, word, clock, plan };
}

(async () => {
    await scenario("Resolve current pointer chains and bounded array elements in linker heap RAM", async () => {
        const f = fixture();
        const plan = await f.plan("motor->next->gain");
        assert.strictEqual(plan.items[0].address, f.base + 1100);
        assert.strictEqual(plan.items[0].value, 75);
        assert.strictEqual(plan.runtimeChecks.length, 2);
        const serial = JSON.parse(JSON.stringify(plan.runtimeChecks));
        await verifyWritePreconditions(serial, f.read);
        f.word(f.base + 1028, f.base + 1200);
        await assert.rejects(verifyWritePreconditions(serial, f.read), { code: "WRITE_TARGET_CHANGED" });
        assert.strictEqual((await f.plan("motor->next->gain")).items[0].address, f.base + 1200);
        const array = fixture(8);
        assert.strictEqual((await array.plan("motor.value[3]")).items[0].address, array.base + 1036);
        await assert.rejects(array.plan("motor.value[4]"));
        await assert.rejects(array.plan("motor.value[*]"));
    });

    await scenario(
        "Keep const, internal fields, bitfields, pointer storage and unknown encodings read-only",
        async () => {
            await assert.rejects(fixture(5).plan("motor->gain"), { code: "WRITE_NOT_ALLOWED" });
            assert.strictEqual(
                (await fixture(6).plan("motor->gain")).items[0].value,
                75,
                "const pointer may address mutable storage"
            );
            for (const property of [{ memberRole: "internal" }, { bitSize: 1 }]) {
                const f = fixture();
                Object.assign(f.types[2].fields[0], property);
                await assert.rejects(f.plan("motor->gain"), { code: "WRITE_NOT_ALLOWED" });
            }
            const f = fixture();
            const direct = fixture(4);
            direct.symbol.size = 12;
            await assert.rejects(direct.plan("motor.gain"), { code: "WRITE_NOT_ALLOWED" });
            await assert.rejects(f.plan("motor->next"), { code: "WRITE_NOT_ALLOWED" });
            await assert.rejects(f.plan("motor->enabled", 3), { code: "INVALID_WRITE_VALUE" });
            assert.deepStrictEqual((await f.plan("motor->enabled", true)).items[0].bytes, [1]);
            f.types[0].enumEncodingInferred = true;
            await assert.rejects(f.plan("motor->gain"), { code: "WRITE_TYPE_UNKNOWN" });
            delete f.types[0].enumEncodingInferred;
            f.types[0].watchType = "";
            await assert.rejects(f.plan("motor->gain"), { code: "WRITE_TYPE_UNKNOWN" });
            f.types[0].watchType = "f32";
            f.types[2].kind = "union";
            await assert.rejects(f.plan("motor->gain"), { code: "WRITE_NOT_ALLOWED" });
        }
    );

    await scenario("Reject null, unmapped, read-only, moving and stale targets without writing", async () => {
        const f = fixture();
        f.word(f.base, 0);
        await assert.rejects(f.plan("motor->gain"), { code: "LIVE_NULL_POINTER" });
        f.word(f.base, 0x40000000);
        await assert.rejects(f.plan("motor->gain"));
        f.result.memory.sections.push({ addr: 0x08000000, size: 256, flags: 2 });
        f.word(f.base, 0x08000000);
        await assert.rejects(f.plan("motor->gain"), { code: "WRITE_NOT_ALLOWED" });
        f.word(f.base, f.base + 1024);
        let calls = 0;
        await assert.rejects(
            f.plan("motor->gain", 3, async (address, size) => {
                const bytes = await f.read(address, size);
                if (++calls === 1) f.word(f.base, f.base + 1200);
                return bytes;
            }),
            (error) => error.code === "WRITE_TARGET_CHANGED" && error.details.written === false
        );
        f.word(f.base, f.base + 1024);
        await assert.rejects(
            f.plan("motor->gain", 3, f.read, () => {
                throw Object.assign(new Error("stale"), { code: "ELF_CHANGED" });
            }),
            { code: "ELF_CHANGED" }
        );
        await assert.rejects(
            f.plan("motor->gain", 3, async (address, size) => {
                f.clock.time += 1001;
                return f.read(address, size);
            }),
            { code: "LIVE_READ_BUDGET_EXCEEDED" }
        );
    });

    await scenario("Resolve vector elements against live bounds and reject control-field paths", async () => {
        const f = fixture(10);
        f.word(f.base + 4, f.base + 1036);
        f.word(f.base + 8, f.base + 1040);
        const plan = await f.plan("motor[2]");
        assert.strictEqual(plan.items[0].address, f.base + 1032);
        assert.strictEqual(plan.runtimeChecks.length, 3);
        await assert.rejects(f.plan("motor[3]"), { code: "WRITE_NOT_ALLOWED" });
        await assert.rejects(f.plan("motor._M_start"), { code: "WRITE_NOT_ALLOWED" });
        f.word(f.base + 4, f.base + 1024);
        await assert.rejects(verifyWritePreconditions(plan.runtimeChecks, f.read), { code: "WRITE_TARGET_CHANGED" });
    });

    await scenario("Bind address descriptors to authorization and enforce bounded non-overlapping checks", async () => {
        const f = fixture();
        const plan = await f.plan("motor->gain");
        const config = {
            debugger: "jlink.cfg",
            mcu: "stm32f4x.cfg",
            transport: "swd",
            probeSerial: "1234",
            adapterSpeedKhz: 100
        };
        plan.connection = connectionIdentity(config);
        const auth = new WriteAuthorization({ get: () => null });
        const pending = auth.authorize(plan).response;
        const changed = { ...plan, runtimeChecks: [{ address: f.base, bytes: [1, 2, 3, 4] }] };
        assert.notStrictEqual(fingerprintWritePlan(plan), fingerprintWritePlan(changed));
        assert.throws(() => auth.authorize(changed, { confirmationId: pending.confirmationId }), {
            code: "WRITE_CONFIRMATION_INVALID"
        });
        assert.throws(() => validateWritePreconditions([{ address: f.base + 1024, bytes: [0] }], plan.items), {
            code: "WRITE_NOT_ALLOWED"
        });
        assert.throws(() => validateWritePreconditions([{ address: -1, bytes: [0] }], []), {
            code: "INVALID_WRITE_PLAN"
        });
        assert.throws(() => validateWritePreconditions([{ address: f.base, bytes: [256] }], []), {
            code: "INVALID_WRITE_PLAN"
        });
        assert.throws(() => validateWritePreconditions(plan.runtimeChecks, Array(32).fill(plan.items[0])), {
            code: "LIVE_WRITE_BUDGET_EXCEEDED"
        });
    });

    await scenario("Check descriptors inside the Tcl write transaction and report post-write relocation", async () => {
        const f = fixture();
        const plan = await f.plan("motor->gain");
        const session = new ManagedOpenOcdSession({ clock: f.clock }, {});
        session.tcl.socket = { destroyed: false };
        session._readMemoryBytes = f.read;
        session._readItems = async (items) => ({
            samples: await Promise.all(
                items.map(async (item) => ({ name: item.name, bytes: await f.read(item.address, item.size) }))
            )
        });
        let writes = 0;
        session.writer.writeBytes = async (address, bytes) => {
            writes++;
            f.memory.set(bytes, address - f.base);
        };
        await session.writeAndVerify(plan.items, 5000, plan.runtimeChecks);
        assert.strictEqual(decodeValue(await f.read(f.base + 1024, 4), "f32"), 75);
        f.word(f.base, f.base + 1200);
        await assert.rejects(session.writeAndVerify(plan.items, 5000, plan.runtimeChecks), {
            code: "WRITE_TARGET_CHANGED"
        });
        assert.strictEqual(writes, 1);
        f.word(f.base, f.base + 1024);
        session.writer.writeBytes = async () => {
            writes++;
            f.word(f.base, f.base + 1200);
        };
        await assert.rejects(
            session.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) =>
                error.code === "WRITE_TARGET_CHANGED" && error.details.writtenItems === 1 && error.retryable === false
        );
        assert.strictEqual(await session.waitForIdle(), true);
        f.word(f.base, f.base + 1024);
        session.writer.writeBytes = async () => {
            throw Object.assign(new Error("write timed out"), { code: "OPENOCD_RPC_TIMEOUT" });
        };
        await assert.rejects(
            session.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) =>
                error.code === "OPENOCD_RPC_TIMEOUT" &&
                error.details.resultUnknown === true &&
                error.details.written === null &&
                error.retryable === false
        );
        session._readMemoryBytes = async (address, size) => {
            f.clock.time += 5001;
            return f.read(address, size);
        };
        await assert.rejects(
            session.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) => error.code === "LIVE_WRITE_BUDGET_EXCEEDED" && error.details.written === false
        );
    });

    await scenario("Integrate on-demand planning with the existing Agent authorization and write path", async () => {
        const f = fixture();
        const config = {
            debugger: "jlink.cfg",
            mcu: "stm32f4x.cfg",
            transport: "swd",
            probeSerial: "1234",
            adapterSpeedKhz: 100
        };
        const connection = connectionIdentity(config);
        let writes = 0;
        const session = {
            options: { ...connection, settingsIdentity: connection },
            readOnce: async (items) =>
                Promise.all(
                    items.map(async (item) => ({ name: item.name, bytes: await f.read(item.address, item.size) }))
                ),
            writeAndVerify: async (items, timeout, checks) => {
                await verifyWritePreconditions(checks, f.read);
                writes++;
                const before = await session.readOnce(items.map((item) => ({ ...item, size: item.bytes.length })));
                for (const item of items) f.memory.set(item.bytes, item.address - f.base);
                return {
                    before,
                    after: await session.readOnce(items.map((item) => ({ ...item, size: item.bytes.length }))),
                    halted: false
                };
            }
        };
        const host = {
            readElfSymbols: () => f.result,
            _elfView: { prepareLayouts: async () => {} },
            _debugBridge: { agentStatus: () => ({ state: "none" }) },
            debugLaunch: { managedServer: null },
            _sampling: { running: false },
            _probeConnectionService: { assertCurrent: () => {} },
            _agentOps: { withProbe: async (handler) => handler({ session, source: "temporary-probe" }) },
            _writeAuthorization: new WriteAuthorization({ get: () => null })
        };
        const execution = new WriteExecution(host, { vscode: {} });
        const values = [{ name: "motor->gain", value: 75 }];
        const pending = await execution.writeAgentVariables({ values });
        assert.strictEqual(pending.confirmationRequired, true);
        assert.strictEqual(writes, 0);
        assert.strictEqual(pending.items[0].address, "0x20000400");
        const result = await execution.writeAgentVariables({ values, confirmationId: pending.confirmationId });
        assert.strictEqual(writes, 1);
        assert.strictEqual(result.results[0].verified, true);
        const next = await execution.writeAgentVariables({ values });
        f.word(f.base, f.base + 1200);
        await assert.rejects(execution.writeAgentVariables({ values, confirmationId: next.confirmationId }), {
            code: "WRITE_CONFIRMATION_INVALID"
        });
        assert.strictEqual(writes, 1);
        f.word(f.base, f.base + 1024);
        host.debugLaunch.managedGroup = {};
        host._debugBridge.assertUniqueSession = () => ({ id: "core-a", configuration: { executable: "other.elf" } });
        host._context = { workspaceState: { get: () => "selected.elf" } };
        await assert.rejects(execution.writeAgentVariables({ values }), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        assert.strictEqual(writes, 1);
    });

    await scenario("Check dynamic target identity within paused DAP transactions", async () => {
        const f = fixture();
        const plan = await f.plan("motor->gain");
        let writes = 0;
        const session = {
            id: "paused",
            customRequest: async (command, args) => {
                const address = Number(args.memoryReference);
                if (command === "writeMemory") {
                    writes++;
                    f.memory.set(Buffer.from(args.data, "base64"), address - f.base);
                    return { bytesWritten: Buffer.from(args.data, "base64").length };
                }
                return { data: (await f.read(address, args.count)).toString("base64") };
            }
        };
        const published = [];
        const watch = {
            ...f.symbol,
            name: "motor->gain",
            runtimeSegments: [{ kind: "dereference" }, { kind: "member", name: "gain" }],
            runtimeRanges: [{ start: f.base, end: f.base + 4200 }]
        };
        const bridge = new DebugSessionBridge({
            now: f.clock.now,
            schedule: f.clock.schedule,
            cancel: f.clock.cancel,
            onSamples: (samples) => published.push(...samples),
            getReadPlan: () => [watch]
        });
        bridge.sessions.set(session.id, session);
        bridge.paused = true;
        bridge.intentEnabled = true;
        bridge.snapshotReady = true;
        bridge.capabilities = { read: true, write: true };
        const sessionRead = async (items) =>
            Promise.all(
                items.map(async (item) =>
                    item.runtimeLayout
                        ? { name: item.name, runtimeTree: await new RuntimeObjectReader(item, f.read).sample() }
                        : { name: item.name, bytes: await f.read(item.address, item.size) }
                )
            );
        bridge.read = sessionRead;
        await bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks);
        assert.strictEqual(writes, 1);
        assert.deepStrictEqual(published, [], "raw write read-back is not a runtime sample");
        assert.equal(bridge.canWrite, true, "the follow-up sample does not block further paused writes");
        await f.clock.advance(0);
        await waitFor(() => published.length > 0, "resolved paused sample after dynamic write");
        assert.equal(published.length, 1);
        assert.equal(published[0].runtimeTree.address, plan.items[0].address);
        assert.equal(published[0].runtimeTree.value, 75);
        const guard = new Int32Array(new SharedArrayBuffer(4));
        bridge.read = async (items) => {
            Atomics.store(guard, 0, WRITE_GUARD.cancelled);
            return sessionRead(items);
        };
        await assert.rejects(
            bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks, bridge.stopEpoch, guard),
            (error) => error.code === "SIDEBAR_WRITE_CANCELLED" && error.details.written === false
        );
        bridge.read = sessionRead;
        f.word(f.base, f.base + 1200);
        await assert.rejects(bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks), {
            code: "WRITE_TARGET_CHANGED"
        });
        assert.strictEqual(writes, 1);
        f.word(f.base, f.base + 1024);
        const original = session.customRequest;
        session.customRequest = async (command, args) => {
            if (command === "writeMemory") throw Object.assign(new Error("write timeout"), { code: "DAP_TIMEOUT" });
            return original(command, args);
        };
        await assert.rejects(
            bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) =>
                error.code === "DAP_TIMEOUT" && error.details.resultUnknown === true && error.details.written === null
        );
        assert.strictEqual(bridge.writing, false);
        session.customRequest = async (command, args) => {
            f.clock.time += 5001;
            return original(command, args);
        };
        await assert.rejects(
            bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) => error.code === "LIVE_WRITE_BUDGET_EXCEEDED" && error.details.written === false
        );
        bridge.dispose();
    });
    await scenario("Coalesce contiguous write preconditions and reject conflicting overlaps", async () => {
        const f = fixture();
        const contiguous = Array.from({ length: 10 }, (_, index) => ({
            address: f.base + index * 4,
            bytes: [index, 0, 0, 0]
        }));
        validateWritePreconditions(contiguous, [{ address: f.base + 256, bytes: [1, 2, 3, 4] }]);
        assert.strictEqual(preconditionSpans(contiguous).length, 1);
        for (let index = 0; index < 10; index++) f.word(f.base + index * 4, index);
        let reads = 0;
        await verifyWritePreconditions(contiguous, async (address, size) => {
            reads++;
            return f.read(address, size);
        });
        assert.strictEqual(reads, 1);
        const withGap = [
            { address: f.base, bytes: [0, 0, 0, 0] },
            { address: f.base + 8, bytes: [2, 0, 0, 0] }
        ];
        reads = 0;
        await verifyWritePreconditions(withGap, async (address, size) => {
            reads++;
            return f.read(address, size);
        });
        assert.strictEqual(reads, 2, "gaps between descriptors must not be bridged");
        assert.throws(
            () =>
                validateWritePreconditions(
                    [
                        { address: f.base, bytes: [1, 2, 3, 4] },
                        { address: f.base + 2, bytes: [9, 4, 5, 6] }
                    ],
                    []
                ),
            { code: "INVALID_WRITE_PLAN" }
        );
    });

    await scenario("Preserve C++ reference .value members and polymorphic const qualifications", async () => {
        const f = fixture();
        const holderType =
            f.types.push({
                kind: "class",
                byteSize: 8,
                fields: [
                    { name: "dummy", offset: 0, type: 0 },
                    { name: "value", offset: 4, type: 0 }
                ]
            }) - 1;
        const holderRefType =
            f.types.push({ kind: "reference", byteSize: 4, target: holderType, pointerTarget: "data" }) - 1;
        const outerType =
            f.types.push({
                kind: "class",
                byteSize: 24,
                fields: [
                    { name: "base", offset: 0, type: 2 },
                    { name: "value", offset: 12, type: 2 }
                ]
            }) - 1;
        const outerRefType =
            f.types.push({ kind: "reference", byteSize: 4, target: outerType, pointerTarget: "data" }) - 1;
        const optType =
            f.types.push({
                kind: "class",
                byteSize: 8,
                typeName: "std::optional<float>",
                stl: "optional",
                args: [0],
                fields: [
                    { name: "_M_engaged", offset: 0, type: 3 },
                    { name: "_M_value", offset: 4, type: 0 }
                ]
            }) - 1;
        const optRefType = f.types.push({ kind: "reference", byteSize: 4, target: optType, pointerTarget: "data" }) - 1;
        const ptrRefType = f.types.push({ kind: "reference", byteSize: 4, target: 1, pointerTarget: "data" }) - 1;
        const setGraph = (root) => {
            const graph = { ...f.symbol.runtimeLayout, root };
            f.symbol.runtimeLayout = graph;
            f.symbol.compositeLayout.runtimeLayout = graph;
            f.symbol.size = 4;
        };

        f.word(f.base, f.base + 1200);
        setGraph(holderRefType);
        assert.strictEqual((await f.plan("motor.value")).items[0].address, f.base + 1204);

        setGraph(outerRefType);
        assert.strictEqual((await f.plan("motor.value.gain")).items[0].address, f.base + 1212);

        setGraph(optRefType);
        f.memory[f.base + 1200 - f.base] = 1;
        assert.strictEqual((await f.plan("motor.value")).items[0].address, f.base + 1204);

        f.word(f.base + 1200, f.base + 1300);
        setGraph(ptrRefType);
        assert.strictEqual((await f.plan("motor->gain")).items[0].address, f.base + 1300);

        const baseClass =
            f.types.push({
                kind: "class",
                byteSize: 8,
                typeName: "Base",
                fields: [
                    { name: "_vptr.Base", memberRole: "artificial", offset: 0, type: 9 },
                    { name: "base", offset: 4, type: 0 }
                ]
            }) - 1;
        const constBase = f.types.push({ kind: "alias", target: baseClass, isConst: true }) - 1;
        const derivedClass =
            f.types.push({
                kind: "class",
                byteSize: 16,
                typeName: "Derived",
                fields: [
                    { name: "@base0", offset: 0, type: baseClass, isBase: true },
                    { name: "value", offset: 8, type: 0 },
                    { name: "base", offset: 12, type: 3 }
                ]
            }) - 1;
        const basePtr = f.types.push({ kind: "pointer", byteSize: 4, target: baseClass, pointerTarget: "data" }) - 1;
        const tupleImpl =
            f.types.push({
                kind: "class",
                byteSize: 4,
                typeName: "std::_Head_base<0, Base *, false>",
                fields: [{ name: "_M_head_impl", offset: 0, type: basePtr }]
            }) - 1;
        const mutableUnique =
            f.types.push({
                kind: "class",
                byteSize: 4,
                typeName: "std::unique_ptr<Base>",
                stl: "unique_ptr",
                args: [baseClass],
                fields: [{ name: "_M_t", offset: 0, type: tupleImpl }]
            }) - 1;
        const constUnique =
            f.types.push({
                kind: "class",
                byteSize: 4,
                typeName: "std::unique_ptr<const Base>",
                stl: "unique_ptr",
                args: [constBase],
                fields: [{ name: "_M_t", offset: 0, type: tupleImpl }]
            }) - 1;
        const constBaseRef =
            f.types.push({ kind: "reference", byteSize: 4, target: constBase, pointerTarget: "data" }) - 1;
        const vtableAddr = f.base + 4096;
        f.result.memory.sections.push({ addr: vtableAddr, size: 32, flags: 2 });
        f.word(vtableAddr, 0);
        f.word(f.base, f.base + 1400);
        f.word(f.base + 1400, vtableAddr + 8);
        f.symbol.runtimeLayout = {
            ...f.symbol.runtimeLayout,
            dynamicTypes: [{ address: vtableAddr, size: 16, type: derivedClass }]
        };
        f.symbol.compositeLayout.runtimeLayout = f.symbol.runtimeLayout;

        setGraph(basePtr);
        const [restored] = normalizeWatchList([{ name: "motor.value.base" }], [f.symbol], { allowDynamicLeaf: true });
        assert.strictEqual(restored.runtimeLeaf, true);
        const read = (item) =>
            new RuntimeObjectReader(
                {
                    ...item,
                    runtimeRanges: [{ start: f.base, end: f.base + 4128 }]
                },
                f.read
            ).sample();
        const scalar = await read(restored);
        const tree = await read({
            ...restored,
            runtimeSegments: restored.runtimeSegments.slice(0, 1),
            runtimeLeaf: false
        });
        const derivedMember = tree.members.find((member) => member.name === "base");
        assert.strictEqual(scalar.type, "u8");
        assert.strictEqual(scalar.writeRestriction, "");
        assert.strictEqual(derivedMember.address, scalar.address);
        assert.strictEqual((await f.plan(restored.name, 1)).items[0].address, scalar.address);

        setGraph(mutableUnique);
        assert.strictEqual((await f.plan("motor.value.value")).items[0].address, f.base + 1408);

        setGraph(constUnique);
        await assert.rejects(f.plan("motor.value.value"), { code: "WRITE_NOT_ALLOWED" });
        await assert.rejects(f.plan("motor.value.base"), { code: "WRITE_NOT_ALLOWED" });

        setGraph(constBaseRef);
        await assert.rejects(f.plan("motor.value"), { code: "WRITE_NOT_ALLOWED" });
    });

    await scenario(
        "Reuse single temporary probe session, enforce multicore guard, and skip probes for descriptor-less STL",
        async () => {
            const f = fixture();
            const elemType = f.types[0];
            const elemsArrayType = f.types.push({ kind: "array", count: 3, byteSize: 12, target: 0 }) - 1;
            const stdArrayType =
                f.types.push({
                    kind: "class",
                    byteSize: 12,
                    typeName: "std::array<float, 3>",
                    stl: "array",
                    args: [0],
                    fields: [{ name: "_M_elems", offset: 0, type: elemsArrayType }]
                }) - 1;
            assert.strictEqual(elemType.kind, "scalar");
            const fixedGraph = { root: stdArrayType, types: f.types, dynamicTypes: [] };
            const fixedSymbol = {
                name: "fixed",
                address: f.base + 128,
                size: 12,
                runtimeLayout: fixedGraph,
                compositeLayout: { kind: "class", byteSize: 12, members: [], runtimeLayout: fixedGraph },
                isComposite: true
            };
            f.result.symbols.push(fixedSymbol);

            const config = {
                debugger: "jlink.cfg",
                mcu: "stm32f4x.cfg",
                transport: "swd",
                probeSerial: "1234",
                adapterSpeedKhz: 100
            };
            const connection = connectionIdentity(config);
            let probeCalls = 0;
            let writes = 0;
            let lastWrite;
            const session = {
                options: { ...connection, settingsIdentity: connection },
                readOnce: async (items) =>
                    Promise.all(
                        items.map(async (item) => ({ name: item.name, bytes: await f.read(item.address, item.size) }))
                    ),
                writeAndVerify: async (items, _timeout, checks) => {
                    await verifyWritePreconditions(checks, f.read);
                    lastWrite = { items, checks };
                    writes++;
                    const before = await session.readOnce(items.map((item) => ({ ...item, size: item.bytes.length })));
                    for (const item of items) f.memory.set(item.bytes, item.address - f.base);
                    return {
                        before,
                        after: await session.readOnce(items.map((item) => ({ ...item, size: item.bytes.length }))),
                        halted: false
                    };
                }
            };
            const auth = new WriteAuthorization({ get: () => null }, { fullAccess: () => true });
            const host = {
                readElfSymbols: () => f.result,
                _elfView: { prepareLayouts: async () => {} },
                _debugBridge: { agentStatus: () => ({ state: "none" }) },
                debugLaunch: { managedServer: null },
                _sampling: { running: false },
                _probeConnectionService: { assertCurrent: () => {}, prepare: async () => connection },
                _resolveOpenOcdPath: async () => "openocd",
                _configurationStore: { snapshot: () => config },
                _writeAuthorization: auth,
                _agentOps: {
                    withProbe: async (handler) => {
                        probeCalls++;
                        return handler({ session, source: "temporary-probe" });
                    }
                }
            };
            const execution = new WriteExecution(host, { vscode: {} });
            await assert.rejects(execution.writeAgentVariables({ values: [{ name: "motor->gain", value: "" }] }), {
                code: "INVALID_WRITE_VALUE"
            });
            assert.strictEqual(probeCalls, 0);

            const unconfirmedAuth = new WriteAuthorization({ get: () => null });
            host._writeAuthorization = unconfirmedAuth;
            const fixedPlan = await execution.writeAgentVariables({ values: [{ name: "fixed[1]", value: 42 }] });
            assert.strictEqual(fixedPlan.confirmationRequired, true);
            assert.strictEqual(probeCalls, 0, "std::array writes must not require a probe just to inspect layout");

            host._writeAuthorization = auth;
            const singlePass = await execution.writeAgentVariables({ values: [{ name: "motor->gain", value: 88 }] });
            assert.strictEqual(singlePass.results[0].verified, true);
            assert.strictEqual(probeCalls, 1, "planning and trusted execution share one temporary probe session");
            assert.strictEqual(writes, 1);
            const fixedWrite = await execution.writeAgentVariables({ values: [{ name: "fixed[1]", value: 42 }] });
            assert.strictEqual(fixedWrite.results[0].verified, true);
            assert.deepStrictEqual(lastWrite.checks, []);
            assert.strictEqual(lastWrite.items[0].runtimeWrite, true);

            host.debugLaunch.managedServer = { capabilities: { runtimeRead: false } };
            host._debugBridge = { agentStatus: () => ({ state: "running" }) };
            await assert.rejects(execution.writeAgentVariables({ values: [{ name: "motor->gain", value: 99 }] }), {
                code: "DEBUG_RUNTIME_READ_UNSUPPORTED"
            });
        }
    );

    await scenario("Reject implicit anonymous union write paths while preserving ordinary members", async () => {
        const f = fixture();
        const union =
            f.types.push({
                kind: "union",
                byteSize: 4,
                fields: [{ name: "ambiguous", offset: 0, type: 0 }]
            }) - 1;
        const wrapper =
            f.types.push({
                kind: "class",
                byteSize: 4,
                fields: [{ name: "?", offset: 0, type: union }]
            }) - 1;
        f.types[2].fields.push({ name: "?", offset: 0, type: wrapper });
        await assert.rejects(f.plan("motor->ambiguous"), { code: "WRITE_NOT_ALLOWED" });
        await assert.rejects(f.plan("motor.value.?.?.ambiguous"), { code: "WRITE_NOT_ALLOWED" });
        assert.strictEqual((await f.plan("motor->gain")).items[0].address, f.base + 1024);
    });

    await scenario("Bind paused DAP writes to the stop that existed before draining a read", async () => {
        const f = fixture();
        const plan = await f.plan("motor->gain");
        let writes = 0;
        const session = {
            id: "stop-generation",
            customRequest: async () => {
                writes++;
                throw new Error("No DAP request should execute");
            }
        };
        const bridge = new DebugSessionBridge({ now: f.clock.now, schedule: f.clock.schedule, cancel: f.clock.cancel });
        bridge.sessions.set(session.id, session);
        bridge.paused = bridge.snapshotReady = bridge.polling = true;
        bridge.capabilities = { read: true, write: true };
        const expectedStopEpoch = bridge.stopEpoch;
        const queued = bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks, expectedStopEpoch);
        const rejected = assert.rejects(
            queued,
            (error) => error.code === "WRITE_TARGET_CHANGED" && error.details.written === false && !error.retryable
        );
        bridge.handleMessage(session, { type: "event", event: "continued" });
        bridge.handleMessage(session, { type: "event", event: "stopped" });
        bridge.polling = false;
        bridge.snapshotReady = true;
        await f.clock.advance(5);
        await rejected;
        await assert.rejects(bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks, expectedStopEpoch), {
            code: "WRITE_TARGET_CHANGED"
        });
        assert.strictEqual(writes, 0);
        assert.strictEqual(bridge.writing, false);
        bridge.dispose();
    });

    await scenario("Keep dynamic Tcl narrow writes within the selected leaf", async () => {
        const f = fixture();
        const plan = await f.plan("motor->enabled", true);
        const address = plan.items[0].address;
        f.memory[address + 1 - f.base] = 20;
        const session = new ManagedOpenOcdSession({ clock: f.clock }, {});
        session.tcl.socket = { destroyed: false };
        session._readItems = async () => ({ samples: [] });
        session._readMemoryBytes = async (at, size) => {
            const bytes = await f.read(at, size);
            if (at === address) f.memory[address + 1 - f.base] = 21;
            return Array.from(bytes);
        };
        const commands = [];
        session.tcl.sendChecked = async (command) => {
            commands.push(command);
            return command.includes("curstate") ? "halted" : "";
        };
        await assert.rejects(
            session.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) => error.code === "WRITE_VERIFY_FAILED" && error.details.resultUnknown === true
        );
        assert.deepStrictEqual(
            commands.filter((command) => command.includes("write_memory")),
            ["ocd_write_memory 0x" + address.toString(16) + " 8 {0x1}"]
        );
        commands.length = 0;
        await assert.rejects(
            session.writeAndVerify(plan.items),
            (error) => error.code === "WRITE_VERIFY_FAILED" && error.details.resultUnknown === true && !error.retryable
        );
        assert.deepStrictEqual(
            commands.filter((command) => command.includes("write_memory")),
            ["ocd_write_memory 0x" + address.toString(16) + " 8 {0x1}"],
            "a dynamic write without descriptor checks still uses only the leaf width"
        );
        assert.strictEqual(f.memory[address + 1 - f.base], 21);
        assert.strictEqual(await session.waitForIdle(), true);
    });

    await scenario("Reject dynamic narrow-write widening and invalidate queued standalone target epochs", async () => {
        const f = fixture();
        const plan = await f.plan("motor->enabled", true);
        let writes = 0;
        let dropNarrow = true;
        let mutateOnReadback = true;
        const session = {
            id: "paused-narrow",
            customRequest: async (command, args) => {
                const address = Number(args.memoryReference);
                if (command === "writeMemory") {
                    writes++;
                    const data = Buffer.from(args.data, "base64");
                    if (!dropNarrow || data.length === 4) f.memory.set(data, address - f.base);
                    return { bytesWritten: data.length };
                }
                if (mutateOnReadback && writes === 1 && address === f.base + 1032) {
                    mutateOnReadback = false;
                    f.word(f.base, f.base + 1200);
                }
                return { data: (await f.read(address, args.count)).toString("base64") };
            }
        };
        const bridge = new DebugSessionBridge({ now: f.clock.now, schedule: f.clock.schedule, cancel: f.clock.cancel });
        bridge.sessions.set(session.id, session);
        bridge.paused = true;
        bridge.snapshotReady = true;
        bridge.capabilities = { read: true, write: true };
        bridge.read = async (items) =>
            Promise.all(items.map(async (item) => ({ name: item.name, bytes: await f.read(item.address, item.size) })));
        await assert.rejects(
            bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) =>
                error.code === "WRITE_TARGET_CHANGED" &&
                error.details.written === null &&
                error.details.writtenItems === 0 &&
                error.details.resultUnknown === true
        );
        assert.strictEqual(writes, 1, "RMW fallback must not execute when descriptors changed before it");

        f.word(f.base, f.base + 1024);
        const originalRequest = session.customRequest;
        const adjacent = f.base + 1033;
        f.memory[adjacent - f.base] = 20;
        session.customRequest = async (command, args) => {
            const response = await originalRequest(command, args);
            if (command === "readMemory" && Number(args.memoryReference) === f.base + 1032)
                f.memory[adjacent - f.base] = 21;
            return response;
        };
        await assert.rejects(
            bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks),
            (error) =>
                error.code === "WRITE_VERIFY_FAILED" &&
                error.details.resultUnknown === true &&
                error.details.written === null &&
                error.details.writtenItems === 0
        );
        assert.strictEqual(writes, 2, "Dynamic narrow writes must never issue a wider write");
        assert.strictEqual(f.memory[adjacent - f.base], 21);
        await assert.rejects(
            bridge.writeAndVerify(plan.items),
            (error) => error.code === "WRITE_VERIFY_FAILED" && error.details.resultUnknown === true && !error.retryable
        );
        assert.strictEqual(writes, 3, "a dynamic write without descriptor checks still issues one DAP write");
        dropNarrow = false;
        await bridge.writeAndVerify(plan.items, 5000, plan.runtimeChecks);
        assert.strictEqual(f.memory[1032], 1);
        assert.strictEqual(f.memory[adjacent - f.base], 21);
        bridge.dispose();

        const gainPlan = await f.plan("motor->gain");
        const ocdSession = new ManagedOpenOcdSession({ clock: f.clock }, {});
        ocdSession.tcl.socket = { destroyed: false };
        ocdSession._readMemoryBytes = f.read;
        ocdSession._readItems = async (items) => ({
            samples: await Promise.all(
                items.map(async (item) => ({ name: item.name, bytes: await f.read(item.address, item.size) }))
            )
        });
        let ocdWrites = 0;
        ocdSession.writer.writeBytes = async () => {
            ocdWrites++;
        };
        await ocdSession._acquireExclusive(f.clock.now() + 1000);
        const queuedEpoch = ocdSession.targetEpoch;
        const queuedWrite = ocdSession.writeAndVerify(gainPlan.items, 5000, gainPlan.runtimeChecks, queuedEpoch);
        ocdSession.invalidateTarget();
        ocdSession._releaseExclusive();
        await assert.rejects(
            queuedWrite,
            (error) => error.code === "WRITE_TARGET_CHANGED" && error.details.written === false
        );
        assert.strictEqual(ocdWrites, 0);
    });

    await scenario(
        "Re-resolve sidebar targets and verify aligned dynamic writes without halting managed debug",
        async () => {
            const f = fixture();
            const session = new ManagedOpenOcdSession({ mode: "debug", clock: f.clock }, {});
            session.tcl.socket = { destroyed: false };
            const commands = [];
            session.tcl.sendChecked = async (command) => {
                commands.push(command);
                assert.match(command, /^ocd_write_memory 0x20000400 32 /);
                f.word(f.base + 1024, Number(command.match(/\{(0x[\da-f]+)\}/i)[1]));
                return "";
            };
            session._readMemoryBytes = f.read;
            session._readItems = async (items) => ({
                samples: await Promise.all(
                    items.map(async (item) => ({
                        name: item.name,
                        bytes: await f.read(item.address, item.size)
                    }))
                )
            });
            session.readOnce = async (items) => (await session._readItems(items)).samples;
            const bridge = {
                activeSession: { id: "debug-a" },
                stopEpoch: 1,
                agentStatus: () => ({ state: "running" })
            };
            const host = {
                _t: (key) => key,
                _elfView: { prepareLayouts: async () => {} },
                _elfService: { generation: 1 },
                readElfSymbols: () => f.result,
                _debugBridge: bridge,
                debugLaunch: { managedServer: session },
                _watchLists: { read: () => [{ name: "motor" }] },
                _sampling: {
                    status: () => ({ canWrite: true, haltWrite: false, mode: "debug-running-sampling" }),
                    runtimeRamPlan: (items) => items
                }
            };
            const execution = new WriteExecution(host, { vscode: {} });
            execution.sessionConnection = () => writeConnectionIdentity({ probe: "cmsis-dap", target: "stm32f4x" });
            execution._confirmUiFirmware = async () => {};
            const name = "motor->gain";
            const binding = { address: f.base + 1024, type: "f32", size: 4, isBoolean: false, typeName: "float" };
            const options = { fromWatch: true, binding, writeContext: execution.sidebarWriteContext().id };
            const rejected = (opts) =>
                assert.rejects(
                    execution.queueUiWrite(name, 12.5, opts),
                    (error) => error.code === "WRITE_TARGET_CHANGED" && error.details.written === false
                );
            await assert.rejects(execution.queueUiWrite(name, 12.5), { code: "WRITE_NOT_ALLOWED" });
            f.word(f.base, f.base + 1200);
            await rejected(options);
            f.word(f.base, f.base + 1024);
            await rejected({ ...options, binding: { ...binding, typeName: "DifferentFloat" } });
            bridge.stopEpoch++;
            await rejected(options);
            assert.deepStrictEqual(commands, []);

            const current = { ...options, writeContext: execution.sidebarWriteContext().id };
            const requestOwner = {};
            const write = session.writeAndVerify.bind(session);
            session.writeAndVerify = (...args) => {
                execution.cancelUiWrite(name, 2, requestOwner);
                return write(...args);
            };
            assert.strictEqual(
                await execution.queueUiWrite(name, 12.5, { ...current, owner: requestOwner, seq: 2 }),
                null
            );
            assert.deepStrictEqual(commands, []);
            session.writeAndVerify = write;
            const completed = await execution.queueUiWrite(name, 12.5, { ...current, owner: requestOwner, seq: 3 });
            assert.strictEqual(completed.results[0].readBack, 12.5);
            assert.strictEqual(completed.results[0].verified, true);
            assert.strictEqual(commands.length, 1);
        }
    );

    await scenario("Recheck watch membership and sampling after asynchronous sidebar planning", async () => {
        const f = fixture();
        const plan = await f.plan("motor->gain");
        let enabled = true;
        let watched = [{ name: "motor" }];
        let writes = 0;
        const host = {
            _t: (key) => key,
            _sampling: {
                running: true,
                session: {},
                status: () => ({ canWrite: enabled, haltWrite: true, running: enabled })
            },
            _debugBridge: { canWrite: false },
            debugLaunch: {},
            _watchLists: { read: () => watched }
        };
        const execution = new WriteExecution(host, { vscode: {} });
        execution._confirmUiFirmware = async () => {};
        const context = execution.sidebarWriteContext();
        const options = { fromWatch: true, binding: { ...plan.items[0], isBoolean: false }, writeContext: context.id };
        execution.sessionConnection = () => ({});
        execution.execute = async () => {
            writes++;
            return {};
        };
        execution.preparePlan = async () => {
            enabled = false;
            return plan;
        };
        await assert.rejects(execution.writeUiVariable("motor->gain", 1, options), {
            i18nKey: "sb.writeNeedSampling"
        });
        enabled = true;
        execution.preparePlan = async () => {
            watched = [];
            return plan;
        };
        await assert.rejects(execution.writeUiVariable("motor->gain", 1, options), {
            i18nKey: "sb.writeWatchRequired"
        });
        assert.strictEqual(writes, 0);
        watched = [{ name: "motor" }];
        execution.preparePlan = async () => plan;
        await execution.writeUiVariable("motor->gain", 1, options);
        assert.strictEqual(writes, 1);
    });

    await scenario(
        "Cancel queued slider values after a failed write and deliver the latest request's error",
        async () => {
            const execution = new WriteExecution({}, { vscode: {} });
            const values = [];
            let entered;
            let rejectWrite;
            const started = new Promise((resolve) => {
                entered = resolve;
            });
            const transaction = new Promise((_resolve, reject) => {
                rejectWrite = reject;
            });
            execution.writeUiVariable = async (_name, value) => {
                values.push(value);
                entered();
                return transaction;
            };
            const first = execution.queueUiWrite("motor->gain", 1);
            await started;
            const skipped = execution.queueUiWrite("motor->gain", 2);
            const latest = execution.queueUiWrite("motor->gain", 3);
            const failedFirst = assert.rejects(first, { code: "WRITE_TARGET_CHANGED" });
            const failedLatest = assert.rejects(latest, { code: "WRITE_TARGET_CHANGED" });
            rejectWrite(
                Object.assign(new Error("Dynamic pointer changed during the first write"), {
                    code: "WRITE_TARGET_CHANGED",
                    details: { written: null, resultUnknown: true },
                    retryable: false
                })
            );
            await Promise.all([failedFirst, failedLatest]);
            assert.strictEqual(await skipped, null);
            assert.deepStrictEqual(values, [1]);
            execution.writeUiVariable = async (_name, value) => {
                values.push(value);
                return value;
            };
            assert.strictEqual(await execution.queueUiWrite("motor->gain", 4), 4);
            assert.deepStrictEqual(values, [1, 4]);
        }
    );

    console.log("Dynamic write planning, authorization, Tcl and paused DAP preconditions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
