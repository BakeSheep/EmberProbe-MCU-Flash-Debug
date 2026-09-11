"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    SvdPeripheralService,
    parseSvd,
    resolveTarget,
    decodeInteger,
    encodeInteger
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
    console.log("SVD peripheral tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
