"use strict";

const PROBE_OPERATIONS = Object.freeze([
    "download",
    "liveWatch",
    "liveStart",
    "chipInfo",
    "agentRead",
    "debugStart",
    "debugServer"
]);

class ProbeCoordinator {
    constructor() {
        this._state = new Map(PROBE_OPERATIONS.map((name) => [name, null]));
    }

    _validate(name) {
        if (!this._state.has(name)) {
            throw Object.assign(new Error(`Unknown probe operation: ${name}`), {
                code: "INVALID_PROBE_OPERATION",
                operation: name
            });
        }
    }

    _busy(requestedOperation) {
        const activeOperation = this.firstActive();
        return Object.assign(
            new Error(`The debug probe is busy with ${activeOperation}; cannot start ${requestedOperation}`),
            {
                code: "PROBE_BUSY",
                requestedOperation,
                activeOperation,
                retryable: true
            }
        );
    }

    acquire(name) {
        this._validate(name);
        if (this.anyActive()) throw this._busy(name);
        const lease = new ProbeLease(this, name);
        this._state.set(name, lease);
        return lease;
    }

    _transition(lease, nextOperation) {
        this._validate(nextOperation);
        if (lease.released || this._state.get(lease.operation) !== lease) {
            throw Object.assign(new Error(`Probe lease for ${lease.operation} is no longer active`), {
                code: "STALE_PROBE_LEASE",
                operation: lease.operation
            });
        }
        this._state.set(lease.operation, null);
        lease.released = true;
        const next = new ProbeLease(this, nextOperation);
        this._state.set(nextOperation, next);
        return next;
    }

    _release(lease) {
        if (lease.released) return false;
        if (this._state.get(lease.operation) !== lease) {
            lease.released = true;
            return false;
        }
        this._state.set(lease.operation, null);
        lease.released = true;
        return true;
    }

    isActive(name) {
        this._validate(name);
        return this._state.get(name) !== null;
    }

    firstActive(names = PROBE_OPERATIONS) {
        for (const name of names) {
            this._validate(name);
            if (this._state.get(name) !== null) return name;
        }
        return null;
    }

    anyActive(names = PROBE_OPERATIONS) {
        return this.firstActive(names) !== null;
    }

    snapshot() {
        return Object.fromEntries(PROBE_OPERATIONS.map((name) => [name, this._state.get(name) !== null]));
    }

    reset() {
        for (const name of PROBE_OPERATIONS) {
            const lease = this._state.get(name);
            if (lease) lease.released = true;
            this._state.set(name, null);
        }
    }
}

class ProbeLease {
    constructor(coordinator, operation) {
        this._coordinator = coordinator;
        this.operation = operation;
        this.released = false;
    }

    transition(nextOperation) {
        return this._coordinator._transition(this, nextOperation);
    }

    release() {
        return this._coordinator._release(this);
    }
}

module.exports = { ProbeCoordinator, ProbeLease, PROBE_OPERATIONS };
