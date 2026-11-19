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

const WRITE_GUARD = Object.freeze({ cancelled: 1, targetChanged: 2 });

/** @param {Int32Array | null | undefined} guard */
function assertSidebarWriteCurrent(guard) {
    const state = guard ? Atomics.load(guard, 0) : 0;
    if (!state) return;
    const cancelled = state === WRITE_GUARD.cancelled;
    throw Object.assign(new Error(cancelled ? "Sidebar write cancelled" : "Sidebar write target changed"), {
        code: cancelled ? "SIDEBAR_WRITE_CANCELLED" : "WRITE_TARGET_CHANGED",
        retryable: false,
        details: { written: false, writtenItems: 0 }
    });
}

module.exports = {
    isNonHaltingWordWrite,
    runtimeWriteDisabledError,
    withWriteAccessStatus,
    WRITE_GUARD,
    assertSidebarWriteCurrent
};
