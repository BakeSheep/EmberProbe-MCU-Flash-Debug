"use strict";

const SIDEBAR_INTERVAL_MS = 50;
class MultiRatePlan {
    constructor({ graphItems = [], sidebarItems = [], graphIntervalMs = 33 }) {
        this.graphItems = graphItems;
        this.sidebarItems = sidebarItems;
        this.graphIntervalMs = graphIntervalMs;
        this.nextGraph = 0;
        this.nextSidebar = 0;
        this.latest = new Map();
        this.graphTicks = [];
        this.sidebarTicks = [];
        this.items = [...new Map([...sidebarItems, ...graphItems].map((item) => [item.name, item])).values()];
        this.items = this.items.map((item) => ({
            ...item,
            size: Math.max(
                item.size,
                ...[...graphItems, ...sidebarItems].filter((s) => s.name === item.name).map((s) => s.size)
            )
        }));
        this.byName = new Map(this.items.map((item) => [item.name, item]));
    }
    get intervalMs() {
        return Math.min(
            this.graphItems.length ? this.graphIntervalMs : Infinity,
            this.sidebarItems.length ? 50 : Infinity
        );
    }
    due(now, effectiveIntervalMs) {
        const graph = this.graphItems.length > 0 && now >= this.nextGraph;
        const sidebar = this.sidebarItems.length > 0 && now >= this.nextSidebar;
        if (graph) this.nextGraph = now + Math.max(this.graphIntervalMs, effectiveIntervalMs);
        if (sidebar) this.nextSidebar = now + Math.max(SIDEBAR_INTERVAL_MS, effectiveIntervalMs);
        const names = new Set(graph ? this.graphItems.map((item) => item.name) : []);
        if (sidebar)
            for (const item of this.sidebarItems) {
                const cached = this.latest.get(item.name);
                if (!cached || now - cached.clock >= SIDEBAR_INTERVAL_MS) names.add(item.name);
            }
        return {
            clock: now,
            items: [...names].map((name) => this.byName.get(name)),
            graphNames: graph ? this.graphItems.map((item) => item.name) : [],
            sidebarNames: sidebar ? this.sidebarItems.map((item) => item.name) : []
        };
    }
    deliver(samples, t, due) {
        for (const [names, ticks] of [
            [due.graphNames, this.graphTicks],
            [due.sidebarNames, this.sidebarTicks]
        ]) {
            if (!names.length) continue;
            ticks.push(due.clock);
            while (ticks.length > 2 && (ticks.length > 512 || ticks[0] < due.clock - 3000)) ticks.shift();
        }
        for (const sample of samples)
            this.latest.set(sample.name, { sample: { ...sample, t: sample.t ?? t }, clock: due.clock });
        const names = new Set([...due.graphNames, ...due.sidebarNames]);
        return [...names].map((name) => this.latest.get(name)?.sample).filter(Boolean);
    }
    delay(now) {
        return Math.max(
            0,
            Math.min(
                this.graphItems.length ? this.nextGraph : Infinity,
                this.sidebarItems.length ? this.nextSidebar : Infinity
            ) - now
        );
    }
    stats() {
        const hz = (ticks) => (ticks.length < 2 ? 0 : ((ticks.length - 1) * 1000) / (ticks.at(-1) - ticks[0]));
        return {
            graphHz: hz(this.graphTicks),
            sidebarHz: hz(this.sidebarTicks),
            graphTargetHz: 1000 / this.graphIntervalMs,
            sidebarTargetHz: 20
        };
    }
}
module.exports = { MultiRatePlan, SIDEBAR_INTERVAL_MS };
