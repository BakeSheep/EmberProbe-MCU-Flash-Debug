"use strict";
const { parentPort } = require("worker_threads");
const { run } = require("../../src/samplingWorker");
const { ManagedOpenOcdSession } = require("../../src/liveWatch");
const { FakeOpenOcdServer } = require("./fake-openocd-server");
run(parentPort, { intervalMs: 20 }, (options, handlers) => {
    const session = new ManagedOpenOcdSession(null, options, handlers);
    const server = new FakeOpenOcdServer();
    session.start = async () => {
        await server.start();
        server.seed(0x20000000, [1, 2, 3, 4]);
        session.socket = await server.connect();
        session._setupSocket();
        session.setSamplingEnabled(true);
    };
    const stop = session.stop.bind(session);
    session.stop = async () => {
        await stop();
        await server.stop();
    };
    return session;
});
