"use strict";
const { withWriteAccessStatus } = require("../writeAccess");

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
    // Worker-backed sessions keep sampling under archive backpressure and only hold delivery, so a busy
    // archive delays samples instead of dropping them. The DAP bridge reads on the host and still pauses.
    setDeliveryHold(session) {
        session?.setDeliveryHold?.(this.backpressured);
    }
    setRuntimeEnabled(server, requested, bridge) {
        this.setDeliveryHold(server);
        return server.setSamplingEnabled(
            server.capabilities?.runtimeRead !== false &&
                !!requested &&
                !bridge?.paused &&
                !bridge?.transitionKind &&
                !bridge?.replBusy &&
                !bridge?.conflict
        );
    }
    status({ intent, bridge, standaloneRunning, managedServer, agentStatus }) {
        if (agentStatus)
            return withWriteAccessStatus(
                this.backpressured
                    ? { ...agentStatus, canRead: false, canWrite: false, snapshotReady: false }
                    : agentStatus
            );
        let result;
        if (bridge.hasAnySession || bridge.hasSession) {
            result = bridge.status();
            if (
                managedServer &&
                managedServer.capabilities?.runtimeRead !== false &&
                bridge.hasSession &&
                !bridge.paused &&
                !bridge.conflict
            ) {
                const canRead =
                    this.allowed(intent) &&
                    !!managedServer.samplingEnabled &&
                    !bridge.transitionKind &&
                    !bridge.replBusy;
                result = {
                    ...result,
                    source: "openocd",
                    canRead,
                    canWrite:
                        canRead &&
                        typeof managedServer.writeAndVerify === "function" &&
                        managedServer.ready !== false &&
                        !managedServer.stopped &&
                        !managedServer.pollingFailed,
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
        return withWriteAccessStatus({ ...result, running: !!intent, intentEnabled: !!intent });
    }
}
module.exports = { SamplingCoordinator };
