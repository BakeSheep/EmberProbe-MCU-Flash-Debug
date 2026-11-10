"use strict";

const { Event } = require("@vscode/debugadapter");
const { DebugDataBreakpoints } = require("./dataBreakpoints");

// The standard DAP whole-set replacement must never remove sidebar-owned watchpoints.
class DebugDataBreakpointGroups {
    constructor(session) {
        this.session = session;
        this.native = new DebugDataBreakpoints(session);
        this.sidebar = new DebugDataBreakpoints(session);
        this.entries = new Map();
        this.nextId = 1;
    }
    get size() {
        return this.native.size + this.sidebar.size;
    }
    get unsafe() {
        return this.native.unsafe || this.sidebar.unsafe;
    }
    get issuedCount() {
        return this.native.issued.size + this.sidebar.issued.size;
    }
    info(args) {
        return this.native.info(args);
    }
    set(args) {
        return this.native.set(args);
    }
    snapshot() {
        return {
            generation: JSON.stringify([this.session.executionEpoch, this.session.variableStore.generation]),
            entries: [...this.entries.values()].map((entry) => {
                const point = [...this.sidebar.owned.values()].find((item) => item.identity === entry.identity);
                return {
                    ...entry,
                    verified: entry.enabled && !!point?.dap.verified,
                    message: point?.dap.message || entry.message || ""
                };
            })
        };
    }
    publish() {
        this.session.sendEvent(new Event("emberprobe.sidebarDataBreakpointsChanged", this.snapshot()));
    }
    async request(args) {
        this.session.checkRequest();
        if (args?.action === "list") return this.snapshot();
        // Watch-list cleanup is by name, so it needs no generation and may run while the
        // target runs: the whole-set update interrupts and resumes it, like native removal.
        if (args?.action === "removeNames") return this.removeNames(args.names);
        this.session.paused();
        if (args?.action === "info") {
            const info = await this.sidebar.info({ name: args.name });
            return { ...this.snapshot(), info };
        }
        if (args?.generation !== this.snapshot().generation) throw this.sidebar.invalid();
        const previous = this.copyEntries();
        if (args.action === "add") {
            const spec = this.sidebar.specification(args);
            if (typeof args.name !== "string" || this.sidebar.issued.get(spec.dataId).name !== args.name)
                throw this.sidebar.invalid();
            const duplicate = [...this.entries.values()].find(
                (entry) => entry.dataId === spec.dataId && entry.accessType === spec.access
            );
            if (duplicate) return this.snapshot();
            if (this.entries.size >= 1024) throw this.sidebar.invalid();
            const id = String(this.nextId++);
            this.entries.set(id, {
                id,
                name: args.name,
                dataId: spec.dataId,
                accessType: spec.access,
                condition: spec.condition,
                enabled: true,
                identity: spec.identity,
                description: this.sidebar.message("debug.dataBreakpointStorage", {
                    name: args.name,
                    address: this.sidebar.issued.get(spec.dataId).address,
                    bytes: this.sidebar.issued.get(spec.dataId).width
                })
            });
        } else {
            const entry = this.entries.get(args?.id);
            if (!entry) throw this.sidebar.invalid();
            if (args.action === "remove") this.entries.delete(entry.id);
            else if (args.action === "enable" && typeof args.enabled === "boolean") entry.enabled = args.enabled;
            else if (args.action === "condition") {
                const spec = this.sidebar.specification({ ...entry, condition: args.condition });
                entry.condition = spec.condition;
                entry.identity = spec.identity;
            } else throw this.sidebar.invalid();
        }
        return this.commit(previous);
    }
    async removeNames(names) {
        if (!Array.isArray(names) || names.length > 1024 || !names.every((name) => typeof name === "string"))
            throw this.sidebar.invalid();
        const covered = (entry) =>
            names.some(
                (name) => entry.name === name || entry.name.startsWith(name + ".") || entry.name.startsWith(name + "[")
            );
        const previous = this.copyEntries();
        for (const [id, entry] of this.entries) if (covered(entry)) this.entries.delete(id);
        if (this.entries.size === previous.size) return this.snapshot();
        return this.commit(previous);
    }
    copyEntries() {
        return new Map([...this.entries].map(([id, entry]) => [id, { ...entry }]));
    }
    async commit(previous) {
        let failure = null;
        try {
            const active = [...this.entries.values()].filter((entry) => entry.enabled);
            const result = await this.sidebar.set({ breakpoints: active });
            active.forEach((entry, index) => {
                entry.message = result.breakpoints[index]?.message || "";
            });
        } catch (error) {
            failure = error;
        }
        const retained = this.settle(previous, !!failure);
        this.publish();
        if (failure) throw failure;
        // Failed removals stay visible and keep the row from being removed.
        if (retained) throw new Error(retained.dap.message || this.sidebar.invalid().message);
        return this.snapshot();
    }
    // Rows must describe every watchpoint GDB still owns. A failed removal keeps its row, and a
    // rejected update never leaves a newly created hardware watchpoint without one.
    settle(previous, failed) {
        const owned = [...this.sidebar.owned.values()];
        if (failed)
            for (const [id, entry] of this.entries)
                if (!previous.has(id) && !owned.some((point) => point.identity === entry.identity))
                    this.entries.delete(id);
        let retained = null;
        for (const point of owned) {
            if ([...this.entries.values()].some((entry) => entry.enabled && entry.identity === point.identity))
                continue;
            retained ||= point;
            const entry = [...previous.values()].find((item) => item.identity === point.identity);
            if (!entry) continue;
            const current = this.entries.get(entry.id);
            // A condition edit reuses the id; keep both rows when the old watchpoint survived.
            const id =
                current && current.enabled && current.identity !== entry.identity ? String(this.nextId++) : entry.id;
            this.entries.set(id, { ...entry, id, enabled: true });
        }
        return retained;
    }
    onRecord(record) {
        this.native.onRecord(record);
        this.sidebar.onRecord(record);
        if (record.kind === "=" && ["breakpoint-modified", "breakpoint-deleted"].includes(record.class)) this.publish();
    }
    reconcile(listed) {
        this.native.reconcile(listed);
        this.sidebar.reconcile(listed);
        this.publish();
    }
    executionFailed(error) {
        this.native.executionFailed(error);
        this.sidebar.executionFailed(error);
        this.publish();
    }
    stop(data) {
        const number = String(
            (data?.wpt || data?.["hw-rwpt"] || data?.["hw-awpt"])?.number ?? data?.bkptno ?? data?.wpnum
        );
        return (this.sidebar.owned.has(number) ? this.sidebar : this.native).stop(data);
    }
    clear() {
        this.native.clear();
        this.sidebar.clear();
        this.entries.clear();
    }
}

module.exports = { DebugDataBreakpointGroups };
