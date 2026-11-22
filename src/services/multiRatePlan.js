"use strict";

const SIDEBAR_INTERVAL_MS = 50;
const SIDEBAR_MAX_WAIT_MS = 200;
const SIDEBAR_BUDGET_SHARE = 0.1;
const SIDEBAR_GUARD_MS = 0.5;
const SIDEBAR_COST_WINDOW = 8;

const hasReading = (sample) => sample?.bytes != null || sample?.runtimeTree != null;

function recordRateTick(ticks, time) {
    if (!Number.isFinite(time) || time <= (ticks.at(-1) ?? -Infinity)) return;
    ticks.push(time);
    if (ticks.length > 512) ticks.shift();
}

function measuredHz(ticks, now, period) {
    const cutoff = now - Math.max(3000, period * 3);
    while (ticks.length && ticks[0] < cutoff) ticks.shift();
    return ticks.length < 2 ? 0 : ((ticks.length - 1) * 1000) / (ticks.at(-1) - ticks[0]);
}

function advanceDeadline(next, period, now) {
    return !next || now - next > period ? now + period : next + period;
}

function percentile75(samples) {
    if (!samples.length) return null;
    const sorted = samples.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * 0.75)];
}

class MultiRatePlan {
    constructor({
        graphItems = [],
        sidebarItems = [],
        graphIntervalMs = 1000 / 30,
        unlimited = false,
        prioritizeGraph = false
    }) {
        this.graphItems = graphItems;
        this.sidebarItems = sidebarItems;
        this.graphIntervalMs = graphIntervalMs;
        this.unlimited = unlimited === true;
        this.prioritizeGraph = prioritizeGraph;
        this.resetGraphDeadline();
        this.nextSidebar = 0;
        this.nextSidebarShared = 0;
        this.sidebarDurations = [];
        this.mergedDurations = [];
        this.graphDurations = [];
        this.lastPeriod = graphIntervalMs;
        this._lastAllowMerge = true;
        this.sidebarPublished = new Map();
        this.latest = new Map();
        this.graphTicks = [];
        this.sidebarTicks = [];
        this.byName = new Map();
        for (const item of [...sidebarItems, ...graphItems]) {
            this.byName.set(item.name, { ...item, size: Math.max(item.size, this.byName.get(item.name)?.size ?? 0) });
        }
        this.items = [...this.byName.values()];
        const graphNames = new Set(graphItems.map((item) => item.name));
        this.graphReadItems = [...graphNames].map((name) => this.byName.get(name));
        this.graphNameSet = graphNames;
        this.graphNames = [...graphNames];
        this.sidebarNames = [...new Set(sidebarItems.map((item) => item.name))];
        this.sidebarSharedNames = this.sidebarNames.filter((name) => graphNames.has(name));
        this.sidebarExclusiveNames = this.sidebarNames.filter((name) => !graphNames.has(name));
        this.sidebarHasExclusive = this.sidebarExclusiveNames.length > 0;
        this.sidebarExclusiveHasRuntime = this.sidebarExclusiveNames.some(
            (name) => !!this.byName.get(name)?.runtimeLayout
        );
    }
    get unlimitedActive() {
        return this.unlimited && this.graphItems.length > 0;
    }
    get intervalMs() {
        return this.unlimitedActive ? 0 : this.requestedIntervalMs;
    }
    get graphPriority() {
        return this.prioritizeGraph && !this.unlimited && this.graphNames.length > 0;
    }
    get requestedIntervalMs() {
        if (this.graphPriority) return this.graphIntervalMs;
        return Math.min(
            this.graphNames.length ? this.graphIntervalMs : Infinity,
            this.sidebarNames.length ? SIDEBAR_INTERVAL_MS : Infinity
        );
    }
    resetGraphDeadline(next = 0) {
        this.nextGraph = next;
        this.graphOrigin = next;
        this.graphSlot = 0;
        this.lastGraphEnd = null;
    }
    preserveGraph(previous) {
        this.nextGraph = previous.nextGraph;
        this.graphOrigin = previous.graphOrigin;
        this.graphSlot = previous.graphSlot;
        this.lastGraphEnd = previous.lastGraphEnd;
        this.nextSidebarShared = previous.nextSidebarShared;
        this.graphTicks = previous.graphTicks;
        this.graphDurations = previous.graphDurations.slice();
        this.graphReadItems = previous.graphReadItems;
        for (const item of this.graphReadItems) {
            this.byName.set(item.name, item);
            const cached = previous.latest.get(item.name);
            if (cached?.fromGraph) this.latest.set(item.name, cached);
        }
        this.items = [...this.byName.values()];
    }
    retime(previous, interval) {
        const graphShift = Math.max(this.graphIntervalMs, interval) - Math.max(this.graphIntervalMs, previous);
        if (graphShift && this.nextGraph) this.resetGraphDeadline(this.nextGraph + graphShift);
        if (this.graphPriority || !this.nextSidebar) return;
        this.nextSidebar += Math.max(SIDEBAR_INTERVAL_MS, interval) - Math.max(SIDEBAR_INTERVAL_MS, previous);
    }
    graphSlotAt(now, period) {
        // Compare the constructed deadline as well as the quotient, which can round at high uptime.
        const slot = Math.round((now - this.graphOrigin) / period);
        return this.graphOrigin + slot * period > now ? slot - 1 : slot;
    }
    advanceGraph(now, period) {
        if (!this.nextGraph) this.graphOrigin = now;
        const slot = Math.max(this.graphSlot, this.graphSlotAt(now, period));
        const missed = slot - this.graphSlot;
        this.graphSlot = slot + 1;
        this.nextGraph = this.graphOrigin + this.graphSlot * period;
        return missed;
    }
    sidebarReads(now, early = 0) {
        return this.sidebarNames.filter((name) => {
            const cached = this.latest.get(name);
            return (
                !cached?.fromGraph || !hasReading(cached.sample) || now - cached.clock >= SIDEBAR_INTERVAL_MS - early
            );
        });
    }
    sidebarEstimatedCost() {
        return percentile75(this.sidebarDurations);
    }
    mergedEstimatedCost() {
        return percentile75(this.mergedDurations);
    }
    graphEstimatedCost() {
        return percentile75(this.graphDurations);
    }
    canMergeSidebar(period, allowMerge = true) {
        if (!allowMerge || !this.sidebarHasExclusive || this.sidebarExclusiveHasRuntime) return false;
        const sidebarCost = this.sidebarEstimatedCost();
        if (sidebarCost === null || sidebarCost + SIDEBAR_GUARD_MS > period) return false;
        const cost = this.mergedEstimatedCost();
        return cost === null || cost + SIDEBAR_GUARD_MS <= period;
    }
    sidebarForceAt(cost = this.sidebarEstimatedCost()) {
        const maxPeriod =
            cost === null
                ? SIDEBAR_INTERVAL_MS
                : Math.min(SIDEBAR_MAX_WAIT_MS, Math.max(SIDEBAR_INTERVAL_MS, cost / SIDEBAR_BUDGET_SHARE));
        return this.nextSidebar + Math.max(0, maxPeriod - SIDEBAR_INTERVAL_MS);
    }
    admitSidebar(now, period, early = 0) {
        this.nextSidebar = advanceDeadline(this.nextSidebar, period, now);
        if (this.sidebarSharedNames.length && (!this.nextSidebarShared || this.nextSidebarShared - now <= early))
            this.nextSidebarShared = advanceDeadline(this.nextSidebarShared, SIDEBAR_INTERVAL_MS, now);
    }
    graphFirstDue(now, period, allowMerge = true) {
        this.lastPeriod = period;
        this._lastAllowMerge = allowMerge;
        if (this.sidebarNames.length && !this.nextSidebar) this.nextSidebar = now;
        const mergeable = this.canMergeSidebar(period, allowMerge);
        const early = Math.max(0, this.nextSidebar - now);
        const mergeReady =
            mergeable &&
            this.sidebarNames.length > 0 &&
            (early === 0 || early <= Math.min(period, SIDEBAR_INTERVAL_MS) / 2);
        const sidebarReady = this.sidebarNames.length > 0 && now >= this.nextSidebar;
        const cost = this.sidebarEstimatedCost();
        const forceAt = this.sidebarForceAt(cost);
        const forceSidebar = sidebarReady && now >= forceAt;
        // A waveform ending on its next deadline leaves no gap, even if the wakeup itself is on time.
        const noGap = this.lastGraphEnd !== null && (now > this.nextGraph || this.lastGraphEnd >= this.nextGraph);
        const yieldToSidebar = forceSidebar && this.sidebarHasExclusive && noGap && !mergeReady;
        if (now >= this.nextGraph && !yieldToSidebar) {
            const missedGraphSlots = this.advanceGraph(now, period);
            let sidebarNames = [];
            let items = this.graphReadItems;
            let mergedSidebar = false;
            if (mergeReady) {
                const extraNames = this.sidebarReads(now, early).filter((name) => !this.graphNameSet.has(name));
                this.admitSidebar(now, SIDEBAR_INTERVAL_MS, early);
                sidebarNames = this.sidebarNames;
                if (extraNames.length) {
                    items = [...this.graphReadItems, ...extraNames.map((name) => this.byName.get(name))];
                    mergedSidebar = true;
                }
            } else if (sidebarReady && !this.sidebarHasExclusive) {
                this.admitSidebar(now, SIDEBAR_INTERVAL_MS);
                sidebarNames = this.sidebarNames;
            } else if (this.sidebarHasExclusive && this.sidebarSharedNames.length) {
                if (!this.nextSidebarShared) this.nextSidebarShared = now;
                if (now >= this.nextSidebarShared) {
                    this.nextSidebarShared = advanceDeadline(this.nextSidebarShared, SIDEBAR_INTERVAL_MS, now);
                    sidebarNames = this.sidebarSharedNames;
                }
            }
            return {
                clock: now,
                items,
                graphNames: this.graphNames,
                sidebarNames,
                missedGraphSlots,
                mergedSidebar
            };
        }
        let sidebarNames = [];
        let items = [];
        if (sidebarReady) {
            const deferToMerge =
                mergeable && (period < SIDEBAR_INTERVAL_MS || this.nextGraph - now <= SIDEBAR_INTERVAL_MS / 2);
            const names = deferToMerge ? [] : this.sidebarReads(now);
            if (
                !deferToMerge &&
                (!names.length || forceSidebar || cost === null || now + cost + SIDEBAR_GUARD_MS <= this.nextGraph)
            ) {
                this.admitSidebar(now, SIDEBAR_INTERVAL_MS);
                sidebarNames = this.sidebarNames;
                items = names.map((name) => this.byName.get(name));
                this.lastGraphEnd = null;
            }
        }
        return { clock: now, items, graphNames: [], sidebarNames, missedGraphSlots: 0, mergedSidebar: false };
    }
    recordGraphRead(end, durationMs) {
        this.lastGraphEnd = end;
        if (Number.isFinite(durationMs)) {
            this.graphDurations.push(durationMs);
            if (this.graphDurations.length > SIDEBAR_COST_WINDOW) this.graphDurations.shift();
        }
    }
    _realignAfterOverrun(end, effectiveIntervalMs) {
        if (end <= this.nextGraph) return 0;
        // Skip only the waveform slots that leave insufficient budget for the next waveform read; keep phase.
        const period = Math.max(this.graphIntervalMs, effectiveIntervalMs);
        const slot = this.graphSlotAt(end, period);
        const slotStart = this.graphOrigin + slot * period;
        const graphCost = this.graphEstimatedCost();
        const keepSlot =
            slotStart === end || (graphCost !== null && end + graphCost + SIDEBAR_GUARD_MS <= slotStart + period);
        const nextSlot = keepSlot ? slot : slot + 1;
        const missed = nextSlot - this.graphSlot;
        this.graphSlot = nextSlot;
        this.nextGraph = this.graphOrigin + this.graphSlot * period;
        return missed;
    }
    recordSidebarRead(durationMs, end, effectiveIntervalMs) {
        this.sidebarDurations.push(durationMs);
        if (this.sidebarDurations.length > SIDEBAR_COST_WINDOW) this.sidebarDurations.shift();
        return this._realignAfterOverrun(end, effectiveIntervalMs);
    }
    recordMergedRead(durationMs, end, effectiveIntervalMs) {
        this.mergedDurations.push(durationMs);
        if (this.mergedDurations.length > SIDEBAR_COST_WINDOW) this.mergedDurations.shift();
        this.lastGraphEnd = end;
        return this._realignAfterOverrun(end, effectiveIntervalMs);
    }
    due(now, effectiveIntervalMs, options = null) {
        const graphPeriod = Math.max(this.graphIntervalMs, effectiveIntervalMs);
        if (this.graphPriority) return this.graphFirstDue(now, graphPeriod, options?.allowMerge !== false);
        const sidebarPeriod = Math.max(SIDEBAR_INTERVAL_MS, effectiveIntervalMs);
        const graph = this.graphNames.length > 0 && (this.unlimitedActive || now >= this.nextGraph);
        // A sidebar deadline this close to a graph tick rides along instead of costing its own read cycle.
        const early = Math.max(0, this.nextSidebar - now);
        const sidebar =
            this.sidebarNames.length > 0 &&
            (early === 0 || (!this.unlimitedActive && graph && early <= Math.min(graphPeriod, sidebarPeriod) / 2));
        if (graph && !this.unlimitedActive) this.nextGraph = advanceDeadline(this.nextGraph, graphPeriod, now);
        if (sidebar) this.admitSidebar(now, sidebarPeriod);
        const graphNames = graph ? this.graphNames : [];
        const names = new Set(sidebar ? [...graphNames, ...this.sidebarReads(now, early)] : graphNames);
        return {
            clock: now,
            items: [...names].map((name) => this.byName.get(name)),
            graphNames,
            sidebarNames: sidebar ? this.sidebarNames : [],
            missedGraphSlots: 0
        };
    }
    deliver(samples, t, due, clock = due.clock) {
        let graphRead = false;
        for (const sample of samples) {
            const fromGraph = due.graphNames.length > 0 && this.graphNameSet.has(sample.name);
            this.latest.set(sample.name, { sample: { ...sample, t: sample.t ?? t }, clock, fromGraph });
            graphRead ||= fromGraph && hasReading(sample);
        }
        if (graphRead) recordRateTick(this.graphTicks, clock);
        let sidebarTime = -Infinity;
        for (const name of due.sidebarNames) {
            const cached = this.latest.get(name);
            if (!hasReading(cached?.sample) || this.sidebarPublished.get(name) === cached.sample.t) continue;
            this.sidebarPublished.set(name, cached.sample.t);
            if (!this.sidebarHasExclusive || !this.graphNameSet.has(name))
                sidebarTime = Math.max(sidebarTime, cached.clock);
        }
        recordRateTick(this.sidebarTicks, sidebarTime);
        const names = new Set([...due.graphNames, ...due.sidebarNames]);
        return [...names].map((name) => this.latest.get(name)?.sample).filter(Boolean);
    }
    delay(now) {
        if (this.unlimitedActive) return 0;
        let sidebarWake = Infinity;
        const mergeExpected =
            this.graphPriority &&
            this.canMergeSidebar(this.lastPeriod, this._lastAllowMerge) &&
            (this.lastPeriod < SIDEBAR_INTERVAL_MS ||
                (this.nextGraph && this.nextSidebar && this.nextGraph - this.nextSidebar <= SIDEBAR_INTERVAL_MS / 2));
        if (this.sidebarNames.length && !mergeExpected) {
            if (this.graphPriority && this.nextSidebar && now >= this.nextSidebar) {
                if (!this.sidebarHasExclusive && !this.sidebarReads(now).length) sidebarWake = now;
                else {
                    const cost = this.sidebarEstimatedCost();
                    const forceAt = this.sidebarForceAt(cost);
                    sidebarWake =
                        cost === null || now >= forceAt || now + cost + SIDEBAR_GUARD_MS <= this.nextGraph
                            ? now
                            : Math.min(this.nextGraph, forceAt);
                }
            } else sidebarWake = this.nextSidebar;
        }
        return Math.max(0, Math.min(this.graphNames.length ? this.nextGraph : Infinity, sidebarWake) - now);
    }
    stats(now = -Infinity, effectiveIntervalMs = 0) {
        const sidebarPeriod = this.graphPriority
            ? SIDEBAR_INTERVAL_MS
            : Math.max(SIDEBAR_INTERVAL_MS, effectiveIntervalMs);
        return {
            graphHz: measuredHz(this.graphTicks, now, Math.max(this.graphIntervalMs, effectiveIntervalMs)),
            sidebarHz: measuredHz(this.sidebarTicks, now, sidebarPeriod),
            graphTargetHz: this.unlimitedActive ? null : 1000 / this.graphIntervalMs,
            unlimited: this.unlimitedActive,
            sidebarTargetHz: 20
        };
    }
}
module.exports = { MultiRatePlan, SIDEBAR_INTERVAL_MS };
