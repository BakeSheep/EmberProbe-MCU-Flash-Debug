"use strict";
const assert = require("assert");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { PeripheralAccessService, peripheralConfigurationKey } = require("../src/services/peripheralAccessService");
const { SvdPeripheralService } = require("../src/services/svdPeripheralService");
const { PeripheralWriteAuthorization } = require("../src/peripheralWriteAuthorization");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

const { FakeClock } = require("./helpers/fake-clock");

const base = 0x40020000;
const SVD =
    "<device><name>T</name><size>32</size><access>read-write</access><peripherals>" +
    "<peripheral><name>P</name><baseAddress>0x40020000</baseAddress><registers>" +
    "<register><name>R</name><addressOffset>0</addressOffset><fields>" +
    "<field><name>EN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields></register>" +
    "<register><name>B</name><addressOffset>4</addressOffset><size>8</size></register>" +
    "<register><name>H</name><addressOffset>6</addressOffset><size>16</size></register>" +
    "<register><name>W</name><addressOffset>8</addressOffset><size>64</size></register>" +
    "<register><name>CLEAR</name><addressOffset>16</addressOffset><readAction>clear</readAction></register>" +
    "</registers></peripheral></peripherals></device>";

async function fixture(state) {
    const fake = new FakeOpenOcdServer();
    await fake.start();
    const session = new ManagedOpenOcdSession({ mode: state === "running" ? "debug" : "standalone" }, {});
    session._scheduleNext = () => {};
    session.tcl.attach(await fake.connect());
    session.tcl.noEchoResponses = true;
    const bridge = {
        state,
        epoch: 1,
        memory: Buffer.alloc(32),
        pausedWrites: 0,
        activeSession: state === "none" ? null : { id: "selected" },
        agentStatus() {
            return {
                state: this.state,
                epoch: this.epoch,
                session: this.activeSession,
                capabilities: { read: true, write: true }
            };
        },
        assertPausedAccess() {
            assert.strictEqual(this.state, "paused");
        },
        async readPausedMemory(address, count) {
            return this.memory.subarray(address - base, address - base + count);
        },
        async writePausedMemory(address, bytes) {
            this.pausedWrites++;
            Buffer.from(bytes).copy(this.memory, address - base);
            return { bytesWritten: bytes.length };
        }
    };
    let config = "initial";
    let supported = true;
    let probes = 0;
    let identity = "probe-A";
    let bound = { path: "test.svd", buffer: Buffer.from(SVD) };
    const access = new PeripheralAccessService({
        debugBridge: bridge,
        configurationKey: () => config,
        supportsRunning: () => supported,
        assertCurrent: () => {},
        connectionIdentity: () => ({ probe: identity, target: "target.cfg" }),
        withProbe: async (handler) => {
            probes++;
            return handler({ session, source: "reused" });
        }
    });
    const service = new SvdPeripheralService({
        debugBridge: bridge,
        accessProvider: access,
        loadBoundSvd: async () => bound,
        authorization: new PeripheralWriteAuthorization()
    });
    return {
        fake,
        session,
        bridge,
        access,
        service,
        probes: () => probes,
        changeConfig: () => {
            config += "changed";
        },
        changeIdentity: () => {
            identity = "probe-B";
        },
        changeSvd: () => {
            bound = { path: "new.svd", buffer: Buffer.from(SVD.replace("<name>T", "<name>T2")) };
        },
        unsupported: () => {
            supported = false;
        },
        close: async () => {
            await session.stop(50);
            await fake.stop();
        }
    };
}

(async () => {
    {
        const f = await fixture("running");
        try {
            const config = { debugger: "jlink.cfg", mcu: "stm32f4x.cfg", probeSerial: "A", svd: "test.svd" };
            f.access.configurationKey = () => peripheralConfigurationKey(config, "workspace", null);
            const original = f.session.peripheralTransaction.bind(f.session);
            f.session.peripheralTransaction = async (...args) => {
                const result = await original(...args);
                config.cubemxPath = "discovered/CubeMX";
                config.elf = "rebuilt.elf";
                config.sampleFrequencyHz = 100;
                return result;
            };
            await f.service.read({ targets: ["P.R"] });
            const generation = f.access.status().generation;
            config.probeSerial = "B";
            assert.notStrictEqual(f.access.status().generation, generation);
            assert.notDeepStrictEqual(
                peripheralConfigurationKey(config, "workspace", { source: "user", probeSerial: "A" }),
                peripheralConfigurationKey(config, "workspace", { source: "user", probeSerial: "B" })
            );
        } finally {
            await f.close();
        }
    }
    for (const state of ["none", "running", "paused"]) {
        const f = await fixture(state);
        try {
            const { service, fake, bridge } = f;
            const read = await service.read({ targets: ["P.R", "P.B", "P.H"] });
            assert.strictEqual(read.registers.length, 3);
            assert.strictEqual(read.access.mode, state === "none" ? "standalone" : "debug-" + state);
            const request = await service.write({ writes: [{ target: "P.R.EN", value: "1" }] });
            assert(request.confirmationRequired);
            assert(request.connection);
            const result = await service.write({
                writes: [{ target: "P.R.EN", value: "1" }],
                confirmationId: request.confirmationId
            });
            assert.strictEqual(result.results[0].verified, true);
            assert.strictEqual(result.results[0].verification, "matched");
            assert.strictEqual(result.results[0].readBack, "0x00000001");
            await service.writeFromUi({
                writes: [
                    { target: "P.B", value: "18" },
                    { target: "P.H", value: "4660" }
                ]
            });
            assert.strictEqual(bridge.peripheralBusy, false);
            if (state === "paused") {
                assert.strictEqual(bridge.pausedWrites, 3);
                assert.strictEqual(f.probes(), 0);
                assert.strictEqual((await service.read({ targets: ["P.W"] })).registers[0].size, 64);
            } else {
                assert(fake.commands.some((cmd) => /write_memory 0x40020004 8/.test(cmd)));
                assert(fake.commands.some((cmd) => /write_memory 0x40020006 16/.test(cmd)));
                assert.deepStrictEqual(fake.bytes(base + 4, 4), [18, 0, 0x34, 0x12]);
                await assert.rejects(service.read({ targets: ["P.W"] }), { code: "PERIPHERAL_ACCESS_UNSUPPORTED" });
                await assert.rejects(service.writeFromUi({ writes: [{ target: "P.W", value: "0" }] }), {
                    code: "PERIPHERAL_ACCESS_UNSUPPORTED"
                });
            }
            const count = fake.commands.length;
            await assert.rejects(service.read({ targets: ["P.CLEAR"] }), { code: "PERIPHERAL_READ_SIDE_EFFECT" });
            await assert.rejects(service.read({ targets: ["missing"] }), { code: "SVD_TARGET_NOT_FOUND" });
            await assert.rejects(service.writeFromUi({ writes: [{ target: "P.B", value: "256" }] }), {
                code: "INVALID_PERIPHERAL_WRITE_VALUE"
            });
            assert.strictEqual(fake.commands.length, count, "invalid requests never reach the probe");
            assert(!fake.commands.some((cmd) => /(?:^|\s)(halt|reset|resume)(?:\s|$)/.test(cmd)));
        } finally {
            await f.close();
        }
    }
    const f = await fixture("running");
    try {
        const { service, fake, session, access, bridge } = f;
        fake.dropNarrowWrites = true;
        const changed = await service.writeFromUi({ writes: [{ target: "P.B", value: "5" }] });
        assert.strictEqual(changed.results[0].verified, false);
        assert.strictEqual(changed.results[0].verification, "different");
        assert.strictEqual(fake.commands.filter((cmd) => /^(?:ocd_)?write_memory /.test(cmd)).length, 1);
        const original = fake._execute.bind(fake);
        let invalidate = false;
        fake._execute = (command) => {
            const result = original(command);
            if (invalidate && /^(?:ocd_)?write_memory /.test(command)) fake.transientFailures = 1;
            return result;
        };
        invalidate = true;
        const unavailable = await service.writeFromUi({ writes: [{ target: "P.R", value: "2" }] });
        assert.strictEqual(unavailable.results[0].verification, "unavailable");
        invalidate = false;
        const request = await service.write({ writes: [{ target: "P.R", value: "3" }] });
        f.changeIdentity();
        await assert.rejects(
            service.write({
                writes: [{ target: "P.R", value: "3" }],
                confirmationId: request.confirmationId
            }),
            { code: "PERIPHERAL_WRITE_CONFIRMATION_INVALID" }
        );
        bridge.replBusy = true;
        await assert.rejects(service.read({ targets: ["P.R"] }), { code: "DEBUG_CONTROL_BUSY" });
        bridge.replBusy = false;
        f.unsupported();
        await assert.rejects(service.read({ targets: ["P.R"] }), { code: "PERIPHERAL_ACCESS_UNSUPPORTED" });
        bridge.state = "conflict";
        assert.strictEqual(access.status().canRead, false);
        bridge.state = "running";
        const before = fake.commands.length;
        const pending = session.peripheralTransaction({ reads: [{ address: base, size: 4 }] });
        session.invalidateTarget();
        await assert.rejects(pending, { code: "LIVE_READ_CANCELLED" });
        assert.strictEqual(fake.commands.length, before);
        for (const item of [
            { address: base + 1, size: 4 },
            { address: base, size: 8 },
            { address: -1, size: 1 },
            { address: 0xffffffff, size: 4 }
        ])
            await assert.rejects(session.peripheralTransaction({ reads: [item] }), {
                code: "PERIPHERAL_ACCESS_UNSUPPORTED"
            });
        await assert.rejects(
            session.peripheralTransaction({
                writes: [{ address: base, size: 1, expected: [0], bytes: [256] }]
            }),
            { code: "PERIPHERAL_ACCESS_UNSUPPORTED" }
        );
        await assert.rejects(session.peripheralTransaction({ reads: Array(65).fill({ address: base, size: 1 }) }), {
            code: "PERIPHERAL_ACCESS_UNSUPPORTED"
        });
    } finally {
        await f.close();
    }
    {
        const f = await fixture("running");
        try {
            const { service, fake, session, access, bridge } = f;
            const read = await service.readForView(["P.R", "P.CLEAR", "missing"]);
            assert.strictEqual(read.registers[1].code, "PERIPHERAL_READ_SIDE_EFFECT");
            assert.strictEqual(read.registers[2].code, "SVD_TARGET_NOT_FOUND");
            await assert.rejects(
                service.read({ targets: ["missing", "also-missing"] }),
                (error) => error.details.invalidTargets.length === 2
            );
            await assert.rejects(service.read({ targets: ["P.R"], accessGeneration: -1 }), {
                code: "DEBUG_STATE_CHANGED"
            });
            bridge.polling = true;
            const clock = new FakeClock();
            access.clock = clock;
            clock.schedule(() => {
                bridge.polling = false;
            }, 10);
            const reading = service.read({ targets: ["P.R"] });
            await clock.advance(10);
            await reading;
            const original = fake._execute.bind(fake);
            let count = 0;
            fake._execute = (command) => {
                if (/^(?:ocd_)?read_memory /.test(command) && ++count === 2) fake.seed(base, [7, 0, 0, 0]);
                return original(command);
            };
            await assert.rejects(
                service.writeFromUi({ writes: [{ target: "P.R.EN", value: "1" }] }),
                (error) => error.code === "PERIPHERAL_VALUE_CHANGED" && error.details.resultUnknown === false
            );
            assert(!fake.commands.some((cmd) => /^(?:ocd_)?write_memory /.test(cmd)));
            fake._execute = original;
            const command = session.tcl.sendChecked.bind(session.tcl);
            session.tcl.sendChecked = async (text) => {
                if (/^(?:ocd_)?write_memory /.test(text))
                    throw new Error("connection lost before write acknowledgement");
                return command(text);
            };
            await assert.rejects(
                service.writeFromUi({ writes: [{ target: "P.R", value: "0" }] }),
                (error) => error.details.resultUnknown === true && error.retryable === false
            );
            session.tcl.sendChecked = async (text) => (/^(?:ocd_)?read_memory /.test(text) ? "" : command(text));
            await assert.rejects(service.read({ targets: ["P.R"] }), /Incomplete/);
            session.tcl.sendChecked = command;
            const originalIdentity = access.connectionIdentity;
            access.connectionIdentity = () => {
                throw Object.assign(new Error("No attachment"), { code: "PROBE_IDENTITY_UNVERIFIED" });
            };
            await assert.rejects(service.write({ writes: [{ target: "P.R", value: "0" }] }), {
                code: "PROBE_IDENTITY_UNVERIFIED"
            });
            access.connectionIdentity = originalIdentity;
            access.pending = 64;
            await assert.rejects(service.read({ targets: ["P.R"] }), { code: "PERIPHERAL_ACCESS_BUSY" });
            access.pending = 0;
            const generation = access.status().generation;
            f.changeConfig();
            await assert.rejects(
                access.withAccess(() => ({}), false, generation),
                { code: "DEBUG_STATE_CHANGED" }
            );
        } finally {
            await f.close();
        }
    }
    {
        const f = await fixture("paused");
        try {
            f.access.quiescePaused = async () => {
                throw new Error("connection still busy");
            };
            await assert.rejects(f.service.read({ targets: ["P.R"] }), /still busy/);
            assert.strictEqual(f.bridge.peripheralBusy, false);
            f.bridge.peripheralBusy = true;
            await assert.rejects(f.service.read({ targets: ["P.R"] }), { code: "DEBUG_CONTROL_BUSY" });
            f.bridge.peripheralBusy = false;
        } finally {
            await f.close();
        }
    }
    {
        const f = await fixture("none");
        try {
            const transaction = await f.session.peripheralTransaction({
                endian: "big",
                writes: [{ address: base, size: 2, expected: [0, 0], bytes: [0x12, 0x34] }]
            });
            assert.deepStrictEqual(transaction.writes[0].readBack, [0x12, 0x34]);
            const original = f.session.tcl.sendChecked.bind(f.session.tcl);
            f.session.tcl.sendChecked = async (text) => {
                const result = await original(text);
                if (/^(?:ocd_)?write_memory /.test(text)) f.session.invalidateTarget();
                return result;
            };
            await assert.rejects(
                f.session.peripheralTransaction({
                    writes: [{ address: base, size: 2, expected: [0x34, 0x12], bytes: [0, 0] }]
                }),
                (error) =>
                    error.details.writeAcknowledged === true &&
                    error.details.resultUnknown === false &&
                    error.details.completed.length === 1
            );
        } finally {
            await f.close();
        }
    }
    {
        const f = await fixture("none");
        try {
            const original = f.access.withProbe;
            f.access.withProbe = async (handler) => {
                await original(handler);
                throw Object.assign(new Error("exit unconfirmed"), { code: "PROBE_EXIT_UNCONFIRMED" });
            };
            await assert.rejects(
                f.service.writeFromUi({ writes: [{ target: "P.R", value: "1" }] }),
                (error) =>
                    error.code === "PROBE_EXIT_UNCONFIRMED" &&
                    error.details.completed[0].verified &&
                    error.details.resultUnknown === false
            );
        } finally {
            await f.close();
        }
    }
    for (const available of [true, false]) {
        const f = await fixture("running");
        try {
            const execute = f.fake._execute.bind(f.fake);
            f.fake._execute = (command) => {
                if (command === "info commands *read_memory")
                    return { ok: true, response: available ? "read_memory" : "" };
                if (command === "info commands *write_memory") return { ok: true, response: "write_memory" };
                if (/^ocd_(?:read|write)_memory /.test(command)) return { ok: false, response: "invalid command name" };
                return execute(command);
            };
            if (!available) {
                await assert.rejects(f.service.read({ targets: ["P.R"] }), { code: "PERIPHERAL_ACCESS_UNSUPPORTED" });
                continue;
            }
            const result = await f.service.writeFromUi({ writes: [{ target: "P.R.EN", value: "1" }] });
            assert.strictEqual(result.results[0].verified, true);
            assert(f.fake.commands.some((command) => command.startsWith("write_memory ")));
            assert(!f.fake.commands.some((command) => command.startsWith("ocd_write_memory ")));
        } finally {
            await f.close();
        }
    }
    for (const change of ["config", "state", "svd"]) {
        const f = await fixture("running");
        try {
            const original = f.session.peripheralTransaction.bind(f.session);
            f.session.peripheralTransaction = async (...args) => {
                const result = await original(...args);
                if (change === "config") f.changeConfig();
                if (change === "state") f.bridge.epoch++;
                if (change === "svd") f.changeSvd();
                return result;
            };
            await assert.rejects(f.service.read({ targets: ["P.R"] }), { code: "DEBUG_STATE_CHANGED" });
            assert.strictEqual(f.bridge.peripheralBusy, false);
        } finally {
            await f.close();
        }
    }
    // A write that finished before the state or SVD changed is returned as done, with the change beside it.
    for (const change of ["state", "svd"]) {
        const f = await fixture("running");
        try {
            const original = f.session.peripheralTransaction.bind(f.session);
            f.session.peripheralTransaction = async (request, ...rest) => {
                const result = await original(request, ...rest);
                if (request.writes?.length) {
                    if (change === "state") f.bridge.epoch++;
                    else f.changeSvd();
                }
                return result;
            };
            const result = await f.service.writeFromUi({ writes: [{ target: "P.R.EN", value: "1" }] });
            assert.strictEqual(result.results[0].verified, true);
            assert.strictEqual(result.stateChangedAfterWrite.code, "DEBUG_STATE_CHANGED");
            assert.strictEqual(f.bridge.peripheralBusy, false);
            // A read is still refused once its values may be stale.
            f.session.peripheralTransaction = async (...args) => {
                const value = await original(...args);
                f.bridge.epoch++;
                return value;
            };
            await assert.rejects(f.service.read({ targets: ["P.R"] }), { code: "DEBUG_STATE_CHANGED" });
        } finally {
            await f.close();
        }
    }
    {
        const f = await fixture("none");
        try {
            const clock = new FakeClock();
            const systemClock = f.session.clock;
            f.session.clock = clock;
            const send = f.session.tcl.sendChecked.bind(f.session.tcl);
            f.session.tcl.sendChecked = async (command) => {
                clock.time += 3000;
                return send(command);
            };
            await assert.rejects(
                f.session.peripheralTransaction({ reads: [{ address: base, size: 4 }] }),
                (error) =>
                    error.code === "LIVE_READ_BUDGET_EXCEEDED" &&
                    /5000 ms budget/.test(error.message) &&
                    error.details.maxTransactionMs === 5000
            );
            f.session.clock = systemClock;
        } finally {
            await f.close();
        }
    }
    console.log("Peripheral standalone/running/paused access, widths, approval, readback and generations passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
