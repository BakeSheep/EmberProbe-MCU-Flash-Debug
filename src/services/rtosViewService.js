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
            sessionId: status.session?.id || "",
            supported: this.bridge.activeSession?.type === "emberprobe",
            sessions: status.sessions || []
        };
    }
    async refresh() {
        const session = this.bridge.assertUniqueSession();
        const epoch = this.bridge.stopEpoch;
        if (session.type !== "emberprobe")
            throw new Error("RTOS task snapshots require the native EmberProbe debugger");
        if (!this.bridge.paused || this.bridge.transitionKind)
            throw new Error("Pause the debugger to refresh RTOS tasks");
        const key = `${session.id}:${epoch}`;
        if (this.pending?.key === key) return this.pending.promise;
        const promise = session.customRequest("emberprobe.rtosSnapshot", {}).then((value) => {
            if (
                session !== this.bridge.activeSession ||
                !this.bridge.paused ||
                this.bridge.transitionKind ||
                epoch !== this.bridge.stopEpoch
            )
                throw new Error("Stale RTOS snapshot; refresh after stopping");
            return { type: "rtosSnapshot", ...unwrapResponse(value), sessionId: session.id, stopEpoch: epoch };
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
