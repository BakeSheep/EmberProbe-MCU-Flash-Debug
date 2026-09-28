"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { parseSvd } = require("./services/svdPeripheralService");

function run(port, data) {
    try {
        port.postMessage({ model: parseSvd(Buffer.from(data.buffer), data.sourcePath) });
    } catch (error) {
        port.postMessage({ error: { code: error.code || "SVD_PARSE_FAILED", message: error.message } });
    }
}
if (!isMainThread) run(parentPort, workerData);
module.exports = { run };
