"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { parseSvd } = require("./services/svdPeripheralService");
const { validateSvdBuffer } = require("./services/svdLibraryService");

function run(port, data) {
    try {
        const buffer = Buffer.from(data.buffer);
        port.postMessage({
            model:
                data.mode === "validate" ? validateSvdBuffer(buffer, data.identity) : parseSvd(buffer, data.sourcePath)
        });
    } catch (error) {
        port.postMessage({ error: { code: error.code || "SVD_PARSE_FAILED", message: error.message } });
    }
}
if (!isMainThread) run(parentPort, workerData);
module.exports = { run };
