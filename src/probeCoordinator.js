"use strict";

const PROBE_OPERATIONS = Object.freeze([
    "download",
    "liveWatch",
    "liveStart",
    "chipInfo",
    "agentRead",
    "debugStart"
]);

class ProbeCoordinator {
    constructor() {
        this._state = new Map(PROBE_OPERATIONS.map(name => [name, false]));
    }

    _validate(name) {
        if (!this._state.has(name)) {
            throw Object.assign(new Error(`Unknown probe operation: ${name}`), {
                code: "INVALID_PROBE_OPERATION",
                operation: name
            });
        }
    }

    setActive(name, active) {
        this._validate(name);
        this._state.set(name, active === true);
        return this._state.get(name);
    }

    isActive(name) {
        this._validate(name);
        return this._state.get(name);
    }

    firstActive(names = PROBE_OPERATIONS) {
        for (const name of names) {
            this._validate(name);
            if (this._state.get(name)) return name;
        }
        return null;
    }

    anyActive(names = PROBE_OPERATIONS) {
        return this.firstActive(names) !== null;
    }

    snapshot() {
        return Object.fromEntries(PROBE_OPERATIONS.map(name => [name, this._state.get(name)]));
    }

    reset() {
        for (const name of PROBE_OPERATIONS) this._state.set(name, false);
    }
}

module.exports = { ProbeCoordinator, PROBE_OPERATIONS };
