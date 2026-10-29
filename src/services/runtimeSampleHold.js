"use strict";

const { findRuntimePaths, replaceRuntimeNodes, runtimeNodeAt } = require("./runtimeExpansion");

// A running target rewrites pointers and container headers between reads, so one cycle may find a
// runtime object (or one of its members) changing underneath. Views keep the last consistent tree
// for a moment instead of switching between it and an error on every such cycle:
// - a member the reader withheld as changing shows its last value, marked `stale`;
// - a whole object that failed transiently shows its last tree, marked `stale`, for up to
//   HOLD_FAILURES failed samples within HOLD_MS of the last good one;
// - any other failure, or a longer one, reaches the views unchanged.
// Held trees are never newer data: `stale` lets views dim them and charts skip them.
const HOLD_MS = 1000;
const HOLD_FAILURES = 3;
const TRANSIENT_CODES = new Set(["LIVE_OBJECT_CHANGED", "LIVE_MEMORY_UNAVAILABLE"]);

function transient(diagnostic) {
    return (
        TRANSIENT_CODES.has(diagnostic?.code) ||
        (diagnostic?.code === "LIVE_READ_BUDGET_EXCEEDED" && diagnostic.reason === "deadline")
    );
}

const changing = (node) => node.unavailableCode === "LIVE_OBJECT_CHANGED";

class RuntimeSampleHold {
    constructor(options = {}) {
        this.now = options.now || Date.now;
        this.holdMs = options.holdMs ?? HOLD_MS;
        this.holdFailures = options.holdFailures ?? HOLD_FAILURES;
        // name -> { tree, at, failures, failedAt, since: Map(path -> first held time) }
        this.items = new Map();
    }

    reset(name) {
        if (name === undefined) this.items.clear();
        else this.items.delete(name);
    }

    // Samples as views should see them; non-runtime samples pass through untouched.
    apply(samples, t) {
        if (!Array.isArray(samples) || !samples.length) return samples;
        let changed = false;
        const result = samples.map((sample) => {
            const next = this._sample(sample, sample?.t ?? t);
            if (next !== sample) changed = true;
            return next;
        });
        return changed ? result : samples;
    }

    _sample(sample, t) {
        if (!sample || typeof sample.name !== "string") return sample;
        if (sample.runtimeTree) return this._good(sample, t);
        const state = this.items.get(sample.name);
        if (!state) return sample;
        if (!sample.diagnostic) {
            // A plain value or a cleared read replaces the runtime object.
            this.items.delete(sample.name);
            return sample;
        }
        // A re-delivered failure (same sample time) counts once.
        if (state.failedAt !== t) {
            state.failures++;
            state.failedAt = t;
        }
        if (
            !transient(sample.diagnostic) ||
            state.failures > this.holdFailures ||
            this.now() - state.at > this.holdMs
        ) {
            this.items.delete(sample.name);
            return sample;
        }
        const { diagnostic: _diagnostic, bytes: _bytes, ...rest } = sample;
        return { ...rest, runtimeTree: { ...state.tree, stale: true }, stale: true };
    }

    _good(sample, t) {
        const now = this.now();
        const previous = this.items.get(sample.name);
        let tree = sample.runtimeTree;
        const since = new Map();
        const held = previous ? findRuntimePaths(tree, changing) : [];
        if (held.length) {
            const usable = new Set();
            for (const path of held) {
                const first = previous.since.get(path) ?? now;
                const last = runtimeNodeAt(previous.tree, path);
                if (!last || changing(last) || now - first > this.holdMs) continue;
                usable.add(path);
                since.set(path, first);
            }
            if (usable.size)
                tree = replaceRuntimeNodes(tree, usable, (_node, path) => ({
                    ...runtimeNodeAt(previous.tree, path),
                    stale: true
                }));
        }
        this.items.set(sample.name, { tree, at: now, failures: 0, failedAt: undefined, since });
        return tree === sample.runtimeTree ? sample : { ...sample, runtimeTree: tree, t: sample.t ?? t };
    }
}

module.exports = { RuntimeSampleHold, HOLD_MS, HOLD_FAILURES };
