"use strict";
const { parentPort } = require("worker_threads");
const { run } = require("../../src/samplingWorker");
const { ManagedOpenOcdSession } = require("../../src/liveWatch");
const { FakeOpenOcdServer } = require("./fake-openocd-server");
run(parentPort, { intervalMs: 20 }, (options, handlers) => {
    const session = new ManagedOpenOcdSession(options, handlers);
    const server = new FakeOpenOcdServer();
    session.start = async () => {
        await server.start();
        server.seed(0x20000000, [1, 2, 3, 4]);
        session.tcl.attach(await server.connect());
        session.setSamplingEnabled(true);
    };
    const stop = session.stop.bind(session);
    session.stop = async () => {
        const closed = await stop();
        await server.stop();
        return closed;
    };
    return session;
});
