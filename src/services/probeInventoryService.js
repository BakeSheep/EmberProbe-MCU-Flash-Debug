"use strict";
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");
const { describeProbeSelection } = require("../../skills/_emberprobe/probe-choice");

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
    }

    async scan() {
        const revision = ++this.started;
        const inventory = await this.reconcile(await this.listProbes({ family: "all" }));
        if (revision > this.completed) {
            this.completed = revision;
            this.latest = { inventory, revision, scannedAt: this.now() };
        }
        return { inventory, revision, current: revision === this.started };
    }

    /** @param {{probe?: string, debugger?: string, probeSerial?: string, successfulConnection?: any}} config */
    describe(config, inventory = this.latest?.inventory) {
        return describeProbeSelection(config, inventory || { available: false, devices: [] }, this.platform, this.arch);
    }
}

module.exports = { ProbeInventoryService };
