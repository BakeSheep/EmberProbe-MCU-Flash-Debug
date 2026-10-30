"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    SvdPeripheralService,
    parseSvd,
    resolveTarget,
    decodeInteger,
    encodeInteger,
    integer
} = require("../src/services/svdPeripheralService");
const { PeripheralWriteAuthorization } = require("../src/peripheralWriteAuthorization");

const SVD = `<?xml version="1.0"?>
<device>
  <name>TEST32</name><vendor>Example</vendor><version>1.0</version>
  <cpu><endian>little</endian></cpu><size>32</size><access>read-write</access>
  <peripherals>
    <peripheral>
      <name>GPIOA</name><baseAddress>0x40020000</baseAddress>
      <registers>
        <register>
          <name>MODER</name><addressOffset>0</addressOffset><resetValue>0</resetValue>
          <fields>
            <field><dim>2</dim><dimIncrement>2</dimIncrement><name>MODE%s</name><bitOffset>0</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues><enumeratedValue><name>Input</name><value>0</value></enumeratedValue><enumeratedValue><name>Output</name><value>1</value></enumeratedValue></enumeratedValues>
            </field>
          </fields>
        </register>
        <register derivedFrom="MODER"><name>ALT</name><addressOffset>4</addressOffset></register>
        <register><name>STATUS</name><addressOffset>8</addressOffset><access>read-only</access><readAction>clear</readAction></register>
        <register><name>FLAGS</name><addressOffset>12</addressOffset><modifiedWriteValues>oneToClear</modifiedWriteValues></register>
        <register><name>WIDE</name><addressOffset>16</addressOffset><size>64</size></register>
        <register><name>DECIMAL</name><addressOffset>10</addressOffset></register>
        <cluster><dim>2</dim><dimIncrement>0x20</dimIncrement><name>CH%s</name><addressOffset>0x100</addressOffset>
          <register><name>CTRL</name><addressOffset>0</addressOffset><fields><field><name>EN</name><bitRange>[0:0]</bitRange></field></fields></register>
        </cluster>
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA"><name>GPIOB</name><baseAddress>0x40020400</baseAddress></peripheral>
  </peripherals>
</device>`;

class FakeDebugBridge {
    constructor() {
        this.paused = true;
        this.epoch = 3;
        this.memory = new Map();
        this.reads = [];
        this.writes = [];
    }
    assertPausedAccess() {
        if (!this.paused) throw Object.assign(new Error("paused required"), { code: "TARGET_NOT_PAUSED" });
    }
    agentStatus() {
        return { state: this.paused ? "paused" : "running", epoch: this.epoch, session: { id: "debug-1" } };
    }
    async readPausedMemory(address, count) {
        this.reads.push({ address, count });
        const source = this.memory.get(address) || Buffer.alloc(count);
        return Uint8Array.from(source.subarray(0, count));
    }
    async writePausedMemory(address, bytes) {
        const data = Buffer.from(bytes);
        this.memory.set(address, data);
        this.writes.push({ address, data });
        return { bytesWritten: data.length };
    }
}

(async () => {
    assert.throws(
        () => parseSvd(Buffer.from(SVD.replace("<dim>2</dim>", "<dim>1</dim><dimIndex>0-100000000</dimIndex>"))),
        (error) => error.code === "INVALID_SVD_DIMENSION"
    );
    const model = parseSvd(Buffer.from(SVD), "/tmp/test.svd");
    assert.strictEqual(model.svd.device, "TEST32");
    assert.strictEqual(model.svd.endian, "little");
    assert.strictEqual(model.peripherals.length, 2, "peripheral derivedFrom should retain registers");
    assert.strictEqual(resolveTarget(model, "GPIOA.MODER").register.address, 0x40020000);
    assert.strictEqual(resolveTarget(model, "gpioa.moder.mode1").field.bitOffset, 2);
    assert.strictEqual(resolveTarget(model, "GPIOA.ALT.MODE0").register.address, 0x40020004);
    assert.strictEqual(resolveTarget(model, "GPIOA.CH1.CTRL.EN").register.address, 0x40020120);
    assert.strictEqual(resolveTarget(model, "GPIOB.MODER").register.address, 0x40020400);
    assert.strictEqual(resolveTarget(model, "GPIOA.WIDE").register.size, 64);
    assert.strictEqual(
        resolveTarget(model, "GPIOA.DECIMAL").register.address,
        0x4002000a,
        "unprefixed SVD integers are decimal, not binary"
    );
    assert.strictEqual(decodeInteger([0x12, 0x34], "big"), 0x1234n);
    assert.deepStrictEqual([...encodeInteger(0x1234n, 2, "big")], [0x12, 0x34]);

    assert.throws(
        () => parseSvd(Buffer.from(SVD.replace("<endian>little</endian>", "<endian>selectable</endian>"))),
        (error) => error.code === "UNSUPPORTED_SVD_ENDIAN"
    );
    assert.throws(
        () => parseSvd(Buffer.from(SVD.replace("<size>64</size>", "<size>24</size>"))),
        (error) => error.code === "UNSUPPORTED_SVD_REGISTER_SIZE"
    );

    // SVD numbers reject over-long input before BigInt conversion: bit-by-bit `value <<= 1n` is Θ(L²), so a few-MB
    // <value>#1010...</value> without a length limit could stall the extension host for minutes.
    assert.throws(
        () => parseSvd(Buffer.from(SVD.replace("<value>1</value>", `<value>#${"1".repeat(4096)}</value>`))),
        (error) => error.code === "INVALID_SVD_VALUE",
        "an over-long binary enumeratedValue is rejected instead of shifted bit by bit"
    );
    // integer()'s decimal branch skips the MAX_SAFE_INTEGER check with bigint:true, so it needs the length guard too.
    assert.throws(
        () => integer("9".repeat(4096), "reset value", { bigint: true }),
        (error) => error.code === "INVALID_SVD_VALUE",
        "an over-long decimal SVD number is rejected"
    );
    // Values of legal width (<= 64 bits) still parse; the limit must not be too tight.
    assert.strictEqual(integer("0xFFFFFFFFFFFFFFFF", "reset value", { bigint: true }), 0xffffffffffffffffn);
    assert.strictEqual(integer("#1111", "enumerated value", { bigint: true }), 15n);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-svd-peripheral-"));
    try {
        const svdPath = path.join(root, "test.svd");
        fs.writeFileSync(svdPath, SVD);
        const debugBridge = new FakeDebugBridge();
        debugBridge.memory.set(0x40020000, Buffer.from([0x05, 0, 0, 0]));
        debugBridge.memory.set(0x40020010, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
        const authorization = new PeripheralWriteAuthorization({ createId: () => "confirm-1" });
        const service = new SvdPeripheralService({
            loadBoundSvd: async () => ({ path: svdPath }),
            debugBridge,
            authorization
        });

        const listed = await service.list({ query: "mode1" });
        assert.strictEqual(listed.peripherals[0].name, "GPIOA");
        assert.strictEqual(listed.peripherals[0].registers[0].path, "GPIOA.MODER");
        assert.strictEqual(listed.peripherals[0].registers[0].fields[1].enumerations[1].name, "Output");

        const read = await service.read({ targets: ["GPIOA.MODER.MODE0", "GPIOA.WIDE"] });
        assert.strictEqual(read.registers[0].value, "0x00000005");
        assert.strictEqual(read.registers[0].fields[0].enum, "Output");
        assert.strictEqual(read.registers[1].value, "0x0807060504030201");
        const readsBeforeInvalidBatch = debugBridge.reads.length;
        await assert.rejects(
            () =>
                service.read({
                    targets: ["GPIOA.MODER", "RCC.CFGR2", "USART1.SR", "ADC1.CR1"]
                }),
            (error) =>
                error.code === "SVD_TARGET_NOT_FOUND" &&
                error.details.target === "RCC.CFGR2" &&
                JSON.stringify(error.details.invalidTargets) === JSON.stringify(["RCC.CFGR2", "USART1.SR", "ADC1.CR1"])
        );
        assert.strictEqual(
            debugBridge.reads.length,
            readsBeforeInvalidBatch,
            "invalid batch targets must be reported before any hardware read"
        );
        await assert.rejects(
            () => service.read({ targets: ["GPIOA.STATUS"] }),
            (error) => error.code === "PERIPHERAL_READ_SIDE_EFFECT"
        );

        const requested = await service.write({ writes: [{ target: "GPIOA.MODER.MODE1", value: "Output" }] });
        assert.strictEqual(requested.confirmationRequired, true);
        assert.strictEqual(requested.confirmationId, "confirm-1");
        assert.strictEqual(requested.items[0].previous, "0x00000005");
        assert.strictEqual(requested.items[0].written, "0x00000005", "MODE1 was already Output in the fixture");
        const written = await service
            .write({
                writes: [{ target: "GPIOA.MODER.MODE1", value: "Input" }],
                confirmationId: "confirm-1"
            })
            .catch((error) => error);
        assert.strictEqual(
            written.code,
            "PERIPHERAL_WRITE_CONFIRMATION_INVALID",
            "changed request must invalidate confirmation"
        );

        const second = new PeripheralWriteAuthorization({ createId: () => "confirm-2" });
        service.authorization = second;
        const plan = await service.write({ writes: [{ target: "GPIOA.MODER.MODE0", value: "Input" }] });
        const result = await service.write({
            writes: [{ target: "GPIOA.MODER.MODE0", value: "Input" }],
            confirmationId: plan.confirmationId
        });
        assert.strictEqual(result.results[0].verified, true);
        assert.strictEqual(result.results[0].written, "0x00000004");
        assert.deepStrictEqual([...debugBridge.writes[0].data], [4, 0, 0, 0], "write must use exact register width");
        const uiResult = await service.writeFromUi({ writes: [{ target: "GPIOA.MODER.MODE0", value: "1" }] });
        assert.strictEqual(uiResult.permission.mode, "direct-ui");
        assert.strictEqual(uiResult.results[0].verified, true);
        assert.deepStrictEqual([...debugBridge.writes[1].data], [5, 0, 0, 0]);
        await assert.rejects(
            () => service.writeFromUi({ writes: [{ target: "GPIOA.STATUS", value: "0" }] }),
            (error) => error.code === "PERIPHERAL_WRITE_NOT_ALLOWED"
        );
        await assert.rejects(
            () => service.write({ writes: [{ target: "GPIOA.STATUS", value: "0" }] }),
            (error) => error.code === "PERIPHERAL_WRITE_NOT_ALLOWED"
        );
        await assert.rejects(
            () => service.write({ writes: [{ target: "GPIOA.FLAGS", value: "1" }] }),
            (error) => error.code === "PERIPHERAL_WRITE_SEMANTICS_UNSUPPORTED"
        );
        await assert.rejects(
            () => service.write({ writes: [{ target: "GPIOA.MODER.MODE0", value: "Alternate" }] }),
            (error) =>
                error.code === "INVALID_PERIPHERAL_WRITE_VALUE" &&
                error.details.target === "GPIOA.MODER.MODE0" &&
                JSON.stringify(error.details.allowedEnumerations) === JSON.stringify(["Input", "Output"])
        );
        await assert.rejects(
            () => service.write({ writes: [{ target: "GPIOA.CH0.CTRL.EN", value: "Enabled" }] }),
            (error) =>
                error.code === "INVALID_PERIPHERAL_WRITE_VALUE" &&
                error.details.target === "GPIOA.CH0.CTRL.EN" &&
                error.details.allowedEnumerations.length === 0
        );

        const originalRead = debugBridge.readPausedMemory.bind(debugBridge);
        debugBridge.readPausedMemory = async (address, count) => {
            const data = await originalRead(address, count);
            debugBridge.epoch++;
            return data;
        };
        await assert.rejects(
            service.read({ targets: ["GPIOA.MODER"] }),
            (error) => error.code === "DEBUG_STATE_CHANGED"
        );
        await assert.rejects(
            service.write({ writes: [{ target: "GPIOA.MODER.MODE0", value: "1" }] }),
            (error) => error.code === "DEBUG_STATE_CHANGED"
        );
        debugBridge.readPausedMemory = async () => Uint8Array.from([1]);
        await assert.rejects(service.read({ targets: ["GPIOA.MODER"] }), /Incomplete/);
        debugBridge.readPausedMemory = originalRead;
        const mixed = model.registersByPath.get("gpioa.moder");
        mixed.fields[1].modifiedWriteValues = "oneToClear";
        const { assertWritable } = require("../src/services/svdPeripheralService");
        assert.throws(
            () => assertWritable(mixed, mixed.fields[0]),
            (error) => error.code === "PERIPHERAL_WRITE_SEMANTICS_UNSUPPORTED"
        );
        assert.throws(
            () => assertWritable(mixed, null),
            (error) => error.code === "PERIPHERAL_WRITE_SEMANTICS_UNSUPPORTED"
        );
        mixed.fields[1].modifiedWriteValues = "";
        mixed.fields[1].access = "writeOnce";
        assert.throws(
            () => assertWritable(mixed, mixed.fields[0]),
            (error) => error.code === "PERIPHERAL_WRITE_NOT_ALLOWED"
        );
        debugBridge.paused = false;
        await assert.rejects(
            () => service.read({ targets: ["GPIOA.MODER"] }),
            (error) => error.code === "TARGET_NOT_PAUSED"
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const missing = new SvdPeripheralService({ loadBoundSvd: async () => null });
    await assert.rejects(
        () => missing.list(),
        (error) => error.code === "SVD_NOT_CONFIGURED"
    );

    await scenario("Cross-peripheral derivation preserves read-only register access", async () => {
        const { parseSvd, assertWritable } = require("../src/services/svdPeripheralService");
        const model = parseSvd(`<device><name>T</name><size>32</size><peripherals>
        <peripheral><name>A</name><baseAddress>0x40000000</baseAddress><registers>
        <register><name>R</name><addressOffset>0</addressOffset><access>read-only</access></register>
        </registers></peripheral><peripheral><name>B</name><baseAddress>0x40001000</baseAddress><registers>
        <register><name>R</name><addressOffset>0</addressOffset><access>read-write</access></register>
        <register derivedFrom="A.R"><name>C</name><addressOffset>4</addressOffset></register>
        </registers></peripheral></peripherals></device>`);
        const inherited = model.registersByPath.get("b.c");
        assert.strictEqual(inherited.access, "read-only");
        assert.throws(() => assertWritable(inherited), { code: "PERIPHERAL_WRITE_NOT_ALLOWED" });
    });

    await scenario("Reject unaligned peripheral reads", async () => {
        const { assertReadable } = require("../src/services/svdPeripheralService");
        assert.throws(() => assertReadable({ size: 32, address: 0x40000001, fields: [] }), {
            code: "PERIPHERAL_ADDRESS_UNALIGNED"
        });
    });

    await scenario("Resolve cross-scope derivation and reject invalid SVD identities", async () => {
        const { parseSvd } = require("../src/services/svdPeripheralService");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        const field = (content = "", name = "F", offset = 0) =>
            `<field><name>${name}</name><bitOffset>${offset}</bitOffset><bitWidth>8</bitWidth>${content}</field>`;
        const enumeration = (usage, name, value) =>
            `<enumeratedValues><usage>${usage}</usage><enumeratedValue><name>${name}</name><value>${value}</value></enumeratedValue></enumeratedValues>`;
        // Cross-scope register, cluster and field references, including inherited descendants.
        const model = parseSvd(
            device(
                peripheral(
                    "A",
                    `<cluster><name>C</name><addressOffset>0</addressOffset>${register(`<fields>${field("<access>read-only</access>")}</fields>`)}</cluster>`
                ) +
                    peripheral(
                        "B",
                        `<cluster derivedFrom="A.C"><name>D</name><addressOffset>16</addressOffset></cluster>
        <register derivedFrom="B.D.R"><name>X</name><addressOffset>24</addressOffset></register>
        ${register(`<fields><field derivedFrom="A.C.R.F"><name>G</name><bitOffset>8</bitOffset></field></fields>`, "Y", 28)}`
                    )
            )
        );
        assert.strictEqual(model.fieldsByPath.get("b.y.g").field.access, "read-only");
        assert.strictEqual(model.fieldsByPath.get("b.x.f").field.access, "read-only");
        assert.strictEqual(model.registersByPath.get("b.d.r").address, 0x40000010);
        for (const registers of [
            register() + '<register derivedFrom="Missing.R"><name>X</name><addressOffset>4</addressOffset></register>',
            '<register derivedFrom="Y"><name>X</name></register><register derivedFrom="X"><name>Y</name></register>',
            register() + register(),
            '<register derivedFrom="A"><name>X</name><addressOffset>0</addressOffset></register>'
        ])
            assert.throws(() => parseSvd(device(peripheral("A", registers))), { code: "INVALID_SVD_DERIVATION" });
        assert.throws(
            () => parseSvd(device(peripheral("A", register()).replace("<name>R</name>", "<name>R.X</name>"))),
            {
                code: "INVALID_SVD_DERIVATION"
            }
        );
        assert.throws(
            () =>
                parseSvd(
                    device(
                        peripheral("A", register("<fields>" + field(enumeration("invalid", "Bad", 0)) + "</fields>"))
                    )
                ),
            { code: "INVALID_SVD_VALUE" }
        );
    });

    await scenario("Validate entire write batches, approval identity and read/write constraints", async () => {
        const { parseSvd } = require("../src/services/svdPeripheralService");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        const constraint = (content) => `<writeConstraint>${content}</writeConstraint>`;
        const field = (content = "", name = "F", offset = 0) =>
            `<field><name>${name}</name><bitOffset>${offset}</bitOffset><bitWidth>8</bitWidth>${content}</field>`;
        const enumeration = (usage, name, value) =>
            `<enumeratedValues><usage>${usage}</usage><enumeratedValue><name>${name}</name><value>${value}</value></enumeratedValue></enumeratedValues>`;
        const createdServices = [];
        function fixture(xml, options = {}) {
            let epoch = 1,
                reads = 0,
                loads = 0;
            const writes = [];
            const memory = new Map();
            const bridge = {
                activeSession: { id: "test" },
                assertPausedAccess() {},
                agentStatus: () => ({ epoch, session: { id: "test" } }),
                readPausedMemory: async (address, bytes) => {
                    reads++;
                    return memory.get(address) || Buffer.alloc(bytes);
                },
                writePausedMemory: async (address, bytes) => {
                    writes.push(address);
                    memory.set(address, bytes);
                }
            };
            const service = new SvdPeripheralService({
                loadBoundSvd: async () => {
                    loads++;
                    return { path: "test.svd", buffer: Buffer.from(xml) };
                },
                debugBridge: bridge,
                authorization: new PeripheralWriteAuthorization(),
                ...options
            });
            createdServices.push(service);
            return { service, bridge, writes, memory, counts: () => ({ loads, reads }), resume: () => epoch++ };
        }
        try {
            const range = constraint("<range><minimum>0</minimum><maximum>3</maximum></range>");
            let f = fixture(device(peripheral("P", register(range) + register(range, "S", 4))));
            await assert.rejects(f.service.writeFromUi({ writes: [{ target: "P.R", value: "255" }] }), {
                code: "PERIPHERAL_WRITE_CONSTRAINT_VIOLATION"
            });
            await assert.rejects(
                f.service.writeFromUi({
                    writes: [
                        { target: "P.R", value: "2" },
                        { target: "P.S", value: "4" }
                    ]
                }),
                { code: "PERIPHERAL_WRITE_CONSTRAINT_VIOLATION" }
            );
            assert.strictEqual(f.writes.length, 0, "validate the entire batch before its first write");
            const request = { writes: [{ target: "P.R", value: "3" }] };
            const permission = await f.service.write(request);
            assert(
                (await f.service.write({ ...request, confirmationId: permission.confirmationId })).results[0].verified
            );
            assert.strictEqual(f.writes.length, 1);
            const chatRequest = await f.service.write(request);
            await assert.rejects(f.service.write({ ...request, confirmationId: "unknown" }), {
                code: "PERIPHERAL_WRITE_CONFIRMATION_INVALID"
            });
            assert.strictEqual(f.writes.length, 1);
            f.memory.set(0x40000000, Buffer.from([2, 0, 0, 0]));
            await assert.rejects(f.service.write({ ...request, confirmationId: chatRequest.confirmationId }), {
                code: "PERIPHERAL_WRITE_CONFIRMATION_INVALID"
            });
            assert.strictEqual(f.writes.length, 1, "register changes between chat calls invalidate the old plan");
            const fresh = await f.service.write(request);
            await f.service.write({ ...request, confirmationId: fresh.confirmationId });
            assert.strictEqual(f.writes.length, 2);
            const listed = await f.service.list();
            assert.strictEqual(listed.peripherals[0].registers[0].writeConstraint.maximum, "3");
            assert.doesNotThrow(() => JSON.stringify(listed));

            f = fixture(device(peripheral("P", register(constraint("<writeAsRead>true</writeAsRead>")))));
            await assert.rejects(f.service.writeFromUi({ writes: [{ target: "P.R", value: "1" }] }), {
                code: "PERIPHERAL_WRITE_CONSTRAINT_VIOLATION"
            });
            await f.service.writeFromUi({ writes: [{ target: "P.R", value: "0" }] });

            const enums = enumeration("read", "State", 1) + enumeration("write", "State", 2);
            f = fixture(
                device(
                    peripheral(
                        "P",
                        register(
                            constraint("<useEnumeratedValues>true</useEnumeratedValues>") +
                                `<fields>${field(enums)}</fields>`
                        )
                    )
                )
            );
            await f.service.writeFromUi({ writes: [{ target: "P.R.F", value: "State" }] });
            assert.strictEqual(f.memory.get(0x40000000)[0], 2, "write selects the write enumeration");
            assert.strictEqual((await f.service.read({ targets: ["P.R"] })).registers[0].fields[0].enum, undefined);
            f.memory.set(0x40000000, Buffer.from([1, 0, 0, 0]));
            assert.strictEqual((await f.service.read({ targets: ["P.R"] })).registers[0].fields[0].enum, "State");
            await assert.rejects(f.service.writeFromUi({ writes: [{ target: "P.R", value: "1" }] }), {
                code: "PERIPHERAL_WRITE_CONSTRAINT_VIOLATION"
            });
            f = fixture(
                device(
                    peripheral(
                        "P",
                        register(
                            range +
                                `<fields>${field(constraint("<range><minimum>5</minimum><maximum>7</maximum></range>"))}${field("", "G", 8)}</fields>`
                        )
                    )
                )
            );
            await f.service.writeFromUi({ writes: [{ target: "P.R", value: "0x307" }] });
            await assert.rejects(f.service.writeFromUi({ writes: [{ target: "P.R", value: "0x407" }] }), {
                code: "PERIPHERAL_WRITE_CONSTRAINT_VIOLATION"
            });
            JSON.stringify(await f.service.list());
            for (const content of [
                "<range><minimum>4</minimum><maximum>1</maximum></range>",
                "<writeAsRead>bad</writeAsRead>",
                "<unknown>true</unknown>",
                "<writeAsRead>true</writeAsRead><useEnumeratedValues>true</useEnumeratedValues>"
            ])
                assert.throws(() => parseSvd(device(peripheral("P", register(constraint(content))))), {
                    code: "INVALID_SVD_WRITE_CONSTRAINT"
                });
            parseSvd(device(peripheral("P", register(constraint("<writeAsRead>false</writeAsRead>")))));
        } finally {
            for (const service of createdServices) service.dispose();
        }
    });

    await scenario("Share enum storage without exceeding logical node budgets", async () => {
        const { parseSvd } = require("../src/services/svdPeripheralService");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        const field = (content = "", name = "F", offset = 0) =>
            `<field><name>${name}</name><bitOffset>${offset}</bitOffset><bitWidth>8</bitWidth>${content}</field>`;
        // A small input cannot multiply enum objects beyond the logical node budget.
        const enums256 = Array.from(
            { length: 256 },
            (_, i) => `<enumeratedValue><name>E${i}</name><value>${i}</value></enumeratedValue>`
        ).join("");
        const amplified = (count) =>
            device(
                peripheral(
                    "P",
                    register(
                        `<dim>${count}</dim><dimIncrement>4</dimIncrement><fields>${field(`<enumeratedValues>${enums256}</enumeratedValues>`)}</fields>`,
                        "R%s"
                    )
                )
            );
        const shared = parseSvd(amplified(2)).peripherals[0].registers;
        assert.strictEqual(shared[0].fields[0].enumerations, shared[1].fields[0].enumerations);
        assert.throws(() => parseSvd(amplified(4096)), { code: "SVD_BUDGET_EXCEEDED" });
    });

    await scenario("Parse peripheral service models through the SVD worker", async () => {
        const { SvdPeripheralService } = require("../src/services/svdPeripheralService");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        function fixture(xml, options = {}) {
            let epoch = 1,
                reads = 0,
                loads = 0;
            const writes = [];
            const memory = new Map();
            const bridge = {
                activeSession: { id: "test" },
                assertPausedAccess() {},
                agentStatus: () => ({ epoch, session: { id: "test" } }),
                readPausedMemory: async (address, bytes) => {
                    reads++;
                    return memory.get(address) || Buffer.alloc(bytes);
                },
                writePausedMemory: async (address, bytes) => {
                    writes.push(address);
                    memory.set(address, bytes);
                }
            };
            const service = new SvdPeripheralService({
                loadBoundSvd: async () => {
                    loads++;
                    return { path: "test.svd", buffer: Buffer.from(xml) };
                },
                debugBridge: bridge,
                authorization: new PeripheralWriteAuthorization(),
                ...options
            });
            return { service, bridge, writes, memory, counts: () => ({ loads, reads }), resume: () => epoch++ };
        }
        const workerPath = path.resolve(__dirname, "../src/svdWorker.js");
        const xml = Buffer.from(device(peripheral("P", register())));
        const f = fixture(xml, { workerPath });
        try {
            assert.strictEqual((await f.service.model()).registersByPath.size, 1);
        } finally {
            f.service.dispose();
        }
    });

    console.log("SVD peripheral tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
