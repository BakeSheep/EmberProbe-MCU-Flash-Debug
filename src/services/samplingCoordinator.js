"use strict";

class SamplingCoordinator {
    constructor() {
        this.backpressured = false;
    }
    allowed(intent) {
        return !!intent && !this.backpressured;
    }
    setBackpressure(paused) {
        this.backpressured = !!paused;
    }
    setDebugIntent(bridge, intent) {
        bridge.setIntent(this.allowed(intent));
    }
    setRuntimeEnabled(server, requested, bridge) {
        return server.setSamplingEnabled(
            this.allowed(requested) && !bridge?.paused && !bridge?.transitionKind && !bridge?.conflict
        );
    }
    status({ intent, bridge, standaloneRunning, managedServer, agentStatus }) {
        if (agentStatus) return agentStatus;
        let result;
        if (bridge.hasAnySession || bridge.hasSession) {
            result = bridge.status();
            if (managedServer && bridge.hasSession && !bridge.paused && !bridge.conflict) {
                const canRead = this.allowed(intent) && !!managedServer.samplingEnabled && !bridge.transitionKind;
                result = {
                    ...result,
                    source: "openocd",
                    canRead,
                    canWrite: false,
                    snapshotReady: canRead,
                    mode: canRead ? "debug-running-sampling" : "debug-running-waiting",
                    key: canRead ? "live.debugRuntimeSampling" : "live.debugWaiting"
                };
            }
        } else {
            const canRead = this.allowed(intent) && !!standaloneRunning;
            result = {
                canRead,
                canWrite: canRead,
                snapshotReady: canRead,
                source: standaloneRunning ? "openocd" : "none",
                mode: canRead ? "standalone-sampling" : intent ? "standalone-pending" : "stopped",
                key: canRead ? "sb.sampling" : "sb.stopped"
            };
        }
        if (this.backpressured) result = { ...result, canRead: false, canWrite: false, snapshotReady: false };
        return { ...result, running: !!intent, intentEnabled: !!intent };
    }
}
module.exports = { SamplingCoordinator };
