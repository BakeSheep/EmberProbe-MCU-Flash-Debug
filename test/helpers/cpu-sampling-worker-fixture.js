"use strict";
const { parentPort, workerData } = require("worker_threads");
const { run } = require("../../src/samplingWorker");
const { ManagedOpenOcdSession } = require("../../src/liveWatch");
const { CpuOpenOcdServer } = require("./cpu-openocd-server");
run(parentPort, workerData, (options, handlers) => {
    const session = new ManagedOpenOcdSession(null, options, handlers);
    const server = new CpuOpenOcdServer({ h7: options.mode === "standalone" });
    session.start = async () => {
        await server.start();
        session.socket = await server.connect();
        session._setupSocket();
        session.setSamplingEnabled(false);
    };
    const stop = session.stop.bind(session);
    session.stop = async () => {
        await stop();
        await server.stop();
    };
    return session;
});
