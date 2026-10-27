"use strict";
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");
const { describeProbeSelection } = require("../../skills/_emberprobe/probe-choice");

// Delay before the next sidebar scan once the previous one completed. macOS enumerates through
// system_profiler, which takes seconds, so it polls less often. After STABLE_SCANS unchanged scans the
// monitor slows down until the inventory changes again or the user acts.
const POLL_DELAYS = Object.freeze({ fast: 3000, slow: 10000, macFast: 10000, macSlow: 30000 });
const STABLE_SCANS = 5;

function inventorySignature(inventory) {
    return JSON.stringify({
        available: !!inventory?.available,
        partial: !!inventory?.partial,
        devices: inventory?.devices || []
    });
}

// Read-only inventory of every connected debug probe, independent of the configured interface script.
// Scans may overlap (a driver switch needs a fresh scan while a periodic one is still running); the most
// recently started completed scan is kept as `latest`, so an older slow scan never replaces newer data.
class ProbeInventoryService {
    constructor(options = {}) {
        this.listProbes = options.listProbes || listProbes;
        this.reconcile = options.reconcile || (async (inventory) => inventory);
        this.now = options.now || Date.now;
        this.platform = options.platform || process.platform;
        this.arch = options.arch || process.arch;
        this.started = 0;
        this.completed = 0;
        this.latest = null;
        this.stableScans = 0;
    }

    async scan() {
        const revision = ++this.started;
        const inventory = await this.reconcile(await this.listProbes({ family: "all" }));
        if (revision > this.completed) {
            const signature = inventorySignature(inventory);
            this.stableScans = this.latest?.signature === signature ? this.stableScans + 1 : 0;
            this.completed = revision;
            this.latest = { inventory, revision, scannedAt: this.now(), signature };
        }
        return { inventory, revision, current: revision === this.started };
    }

    pollDelay() {
        const mac = this.platform === "darwin";
        if (this.stableScans < STABLE_SCANS) return mac ? POLL_DELAYS.macFast : POLL_DELAYS.fast;
        return mac ? POLL_DELAYS.macSlow : POLL_DELAYS.slow;
    }

    // A user action or a newly shown sidebar expects changes soon; poll at the fast rate again.
    resetBackoff() {
        this.stableScans = 0;
    }

    /** @param {{probe?: string, debugger?: string, probeSerial?: string, successfulConnection?: any}} config */
    describe(config, inventory = this.latest?.inventory) {
        return describeProbeSelection(config, inventory || { available: false, devices: [] }, this.platform, this.arch);
    }
}

module.exports = { ProbeInventoryService, POLL_DELAYS, STABLE_SCANS };
