"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");

(async () => {
    await scenario("Deduplicate worker parsing and recover from invalid XML or disposal", async () => {
        const path = require("path");
        const { SvdModelService } = require("../src/services/svdModelService");
        const { run } = require("../src/svdWorker");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        const workerPath = path.resolve(__dirname, "../src/svdWorker.js");
        const parser = new SvdModelService({ workerPath });
        const xml = Buffer.from(device(peripheral("P", register())));
        let pending;
        try {
            pending = parser.parse(xml, "test.svd", "hash");
            // Disposal can reject this request if the identity assertion fails before the await.
            pending.catch(() => {});
            assert.strictEqual(parser.parse(xml, "test.svd", "hash"), pending);
            assert.strictEqual((await pending).registersByPath.size, 1);
            await assert.rejects(parser.parse(Buffer.from("bad"), "test.svd", "bad"), { code: "INVALID_SVD_XML" });
            assert.strictEqual((await parser.parse(xml, "test.svd", "hash")).registersByPath.size, 1);
        } finally {
            parser.dispose();
            await pending?.catch(() => {});
        }
        await assert.rejects(parser.parse(xml, "test.svd", "hash"), /disposed/);
        const events = [];
        run({ postMessage: (event) => events.push(event) }, { buffer: xml, sourcePath: "test" });
        run({ postMessage: (event) => events.push(event) }, { buffer: Buffer.from("bad") });
        assert(events[0].model && events[1].error);
    });

    await scenario("Bound worker timeouts, crashes, exits, concurrency and startup failures", async () => {
        const path = require("path");
        const { EventEmitter } = require("events");
        const { SvdModelService } = require("../src/services/svdModelService");
        const device = (content) =>
            `<device><name>T</name><size>32</size><peripherals>${content}</peripherals></device>`;
        const peripheral = (name, registers) =>
            `<peripheral><name>${name}</name><baseAddress>0x40000000</baseAddress><registers>${registers}</registers></peripheral>`;
        const register = (content = "", name = "R", offset = 0) =>
            `<register><name>${name}</name><addressOffset>${offset}</addressOffset><access>read-write</access>${content}</register>`;
        const workerPath = path.resolve(__dirname, "../src/svdWorker.js");
        const xml = Buffer.from(device(peripheral("P", register())));
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
        try {
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
        } finally {
            fake.dispose();
        }
    });

    console.log("svd-model tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
