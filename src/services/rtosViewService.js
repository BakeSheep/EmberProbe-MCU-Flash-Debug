"use strict";

const { unwrapResponse } = require("./debugSessionBridge");

class RtosViewService {
    constructor(bridge) {
        this.bridge = bridge;
        this.pending = null;
    }
    status() {
        const status = this.bridge.agentStatus();
        return {
            type: "rtosDebugStatus",
            state: status.state,
            stopEpoch: status.epoch,
            inspectionEpoch: this.bridge.inspectionEpoch || 0,
            sessionId: status.session?.id || "",
            supported: this.bridge.activeSession?.type === "emberprobe",
            sessions: status.sessions || []
        };
    }
    async refresh(includeStackUsage = true) {
        const session = this.bridge.assertUniqueSession();
        const epoch = this.bridge.stopEpoch;
        const inspectionEpoch = this.bridge.inspectionEpoch || 0;
        if (session.type !== "emberprobe")
            throw Object.assign(new Error("RTOS task snapshots require the native EmberProbe debugger"), {
                code: "DEBUG_INSPECTION_UNSUPPORTED"
            });
        if (!this.bridge.paused || this.bridge.transitionKind)
            throw Object.assign(new Error("Pause the debugger to refresh RTOS tasks"), {
                code: this.bridge.transitionKind ? "DEBUG_STATE_TRANSITION" : "TARGET_NOT_PAUSED"
            });
        if (this.bridge.writing)
            throw Object.assign(new Error("Wait for the memory write before refreshing RTOS tasks"), {
                code: "DEBUG_CONTROL_BUSY"
            });
        const key = `${session.id}:${epoch}:${inspectionEpoch}:${includeStackUsage ? "stack" : "tasks"}`;
        if (this.pending?.key === key) return this.pending.promise;
        const promise = session.customRequest("emberprobe.rtosSnapshot", { includeStackUsage }).then((value) => {
            if (
                session !== this.bridge.activeSession ||
                !this.bridge.paused ||
                this.bridge.transitionKind ||
                epoch !== this.bridge.stopEpoch ||
                inspectionEpoch !== (this.bridge.inspectionEpoch || 0) ||
                this.bridge.writing
            )
                throw Object.assign(new Error("Stale RTOS snapshot; refresh after stopping"), {
                    code: "DEBUG_INSPECTION_STALE"
                });
            return {
                type: "rtosSnapshot",
                ...unwrapResponse(value),
                sessionId: session.id,
                stopEpoch: epoch,
                inspectionEpoch
            };
        });
        this.pending = { key, promise };
        try {
            return await promise;
        } finally {
            if (this.pending?.promise === promise) this.pending = null;
        }
    }
}

module.exports = { RtosViewService };
