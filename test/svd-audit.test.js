"use strict";
const assert = require("assert");
const path = require("path");
const { EventEmitter } = require("events");
const { parseSvd, SvdPeripheralService } = require("../src/services/svdPeripheralService");
const { SvdModelService } = require("../src/services/svdModelService");
const { PeripheralWriteAuthorization } = require("../src/peripheralWriteAuthorization");
const { PeripheralViewService } = require("../src/services/peripheralViewService");
const { run } = require("../src/svdWorker");

const device = (content) => `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
const peripheral = (name, registers) =>
    `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
const register = (content = "", name = "R", offset = 0) =>
    `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
const constraint = (content) => `<writeConstraint>${content}</writeConstraint>`;
const field = (content = "", name = "F", offset = 0) =>
    `<field><name>${name}</name><bitOffset>${offset}</bitOffset><bitWidth>8</bitWidth>${content}</field>`;
const enumeration = (usage, name, value) =>
    `<enumeratedValues><usage>${usage}</usage><enumeratedValue><name>${name}</name><value>${value}</value></enumeratedValue></enumeratedValues>`;

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

(async () => {
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
    assert.throws(() => parseSvd(device(peripheral("A", register()).replace("<name>R</name>", "<name>R.X</name>"))), {
        code: "INVALID_SVD_DERIVATION"
    });
    assert.throws(
        () =>
            parseSvd(
                device(peripheral("A", register("<fields>" + field(enumeration("invalid", "Bad", 0)) + "</fields>")))
            ),
        { code: "INVALID_SVD_VALUE" }
    );

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
    assert((await f.service.write({ ...request, confirmationId: permission.confirmationId })).results[0].verified);
    assert.strictEqual(f.writes.length, 1);
    const humanRequest = await f.service.write(request);
    f.service.approve = async () => {
        throw Object.assign(new Error("User denied"), { code: "HUMAN_APPROVAL_DENIED" });
    };
    await assert.rejects(f.service.write({ ...request, confirmationId: humanRequest.confirmationId }), {
        code: "HUMAN_APPROVAL_DENIED"
    });
    assert.strictEqual(f.writes.length, 1);
    f.service.approve = async () => {
        f.memory.set(0x40000000, Buffer.from([2, 0, 0, 0]));
    };
    await assert.rejects(f.service.write({ ...request, confirmationId: humanRequest.confirmationId }), {
        code: "PERIPHERAL_WRITE_CONFIRMATION_INVALID"
    });
    assert.strictEqual(f.writes.length, 1, "register changes while approving must invalidate the old plan");
    f.service.approve = async () => {};
    const fresh = await f.service.write(request);
    await f.service.write({ ...request, confirmationId: fresh.confirmationId });
    assert.strictEqual(f.writes.length, 2);
    f.service.approve = null;
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
                    constraint("<useEnumeratedValues>true</useEnumeratedValues>") + `<fields>${field(enums)}</fields>`
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

    // View batching preserves per-target failures but does not reload the model.
    f = fixture(
        device(
            peripheral(
                "P",
                register(`<fields>${field()}</fields>`) + register("<readAction>clear</readAction>", "S", 4)
            )
        )
    );
    const view = new PeripheralViewService({ peripherals: f.service, debugBridge: f.bridge });
    const result = await view.read(["P.R", "P.R.F", "P.S", "missing"]);
    assert.deepStrictEqual(f.counts(), { loads: 1, reads: 1 });
    assert.strictEqual(result.registers[0], result.registers[1]);
    assert.strictEqual(result.registers[2].code, "PERIPHERAL_READ_SIDE_EFFECT");
    assert.strictEqual(result.registers[3].code, "SVD_TARGET_NOT_FOUND");
    f.bridge.readPausedMemory = async () => {
        f.resume();
        return Buffer.alloc(4);
    };
    await assert.rejects(view.read(["P.R"]), { code: "DEBUG_STATE_CHANGED" });
    f.service.dispose();

    const workerPath = path.resolve(__dirname, "../src/svdWorker.js");
    const parser = new SvdModelService({ workerPath });
    const xml = Buffer.from(device(peripheral("P", register())));
    const pending = parser.parse(xml, "test.svd", "hash");
    assert.strictEqual(parser.parse(xml, "test.svd", "hash"), pending);
    assert.strictEqual((await pending).registersByPath.size, 1);
    await assert.rejects(parser.parse(Buffer.from("bad"), "test.svd", "bad"), { code: "INVALID_SVD_XML" });
    assert.strictEqual((await parser.parse(xml, "test.svd", "hash")).registersByPath.size, 1);
    parser.dispose();
    await assert.rejects(parser.parse(xml, "test.svd", "hash"), /disposed/);
    const events = [];
    run({ postMessage: (event) => events.push(event) }, { buffer: xml, sourcePath: "test" });
    run({ postMessage: (event) => events.push(event) }, { buffer: Buffer.from("bad") });
    assert(events[0].model && events[1].error);
    class FakeWorker extends EventEmitter {
        constructor() {
            super();
            FakeWorker.last = this;
        }
        terminate() {
            this.terminated = true;
            return Promise.resolve();
        }
    }
    let fake = new SvdModelService({ workerPath, Worker: FakeWorker, timeoutMs: 10 });
    await assert.rejects(fake.parse(xml, "x", "h"), { code: "SVD_PARSE_TIMEOUT" });
    const inflight = fake.parse(xml, "x", "h");
    fake.dispose();
    await assert.rejects(inflight, /disposed/);
    fake = new SvdModelService({ workerPath, Worker: FakeWorker });
    const crashed = fake.parse(xml, "x", "h");
    FakeWorker.last.emit("error", new Error("crashed"));
    await assert.rejects(crashed, /crashed/);
    const exited = fake.parse(xml, "x", "h");
    FakeWorker.last.emit("exit", 0);
    await assert.rejects(exited, /without a result/);
    const requests = Array.from({ length: 4 }, (_, i) => fake.parse(xml, "x", String(i)));
    const settled = Promise.allSettled(requests);
    await assert.rejects(fake.parse(xml, "x", "fifth"), { code: "SVD_PARSER_BUSY" });
    fake.dispose();
    await settled;
    const broken = new SvdModelService({
        workerPath,
        Worker: class {
            constructor() {
                throw new Error("cannot start");
            }
        }
    });
    await assert.rejects(broken.parse(xml, "x", "h"), /cannot start/);
    broken.dispose();
    f = fixture(xml, { workerPath });
    assert.strictEqual((await f.service.model()).registersByPath.size, 1);
    f.service.dispose();
    console.log("SVD safety, bounded worker and batching tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
