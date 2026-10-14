"use strict";

function isNonHaltingWordWrite(item) {
    return item?.address % 4 === 0 && item?.bytes?.length === 4;
}

function runtimeWriteDisabledError() {
    return Object.assign(
        new Error(
            "Only aligned 32-bit writes are allowed while the debug session is running; pause it for other writes"
        ),
        { code: "RUNTIME_WRITE_DISABLED" }
    );
}

function withWriteAccessStatus(status) {
    const canWrite = status.canWrite === true;
    return { ...status, canWrite, haltWrite: canWrite && status.mode !== "debug-running-sampling" };
}

module.exports = { isNonHaltingWordWrite, runtimeWriteDisabledError, withWriteAccessStatus };
