"use strict";

const { randomUUID } = require("crypto");
const { Event, OutputEvent } = require("@vscode/debugadapter");
const { t } = require("../i18n");
const { quote } = require("./mi");
const { safePath, gdbVariablePath } = require("./stl");

const LIMIT = 1024;
const ACCESS = ["write", "read", "readWrite"];
const TYPES = { 1: "unsigned char", 2: "unsigned short", 4: "unsigned int" };
const ACCESS_LABELS = { write: "sb.dataWrite", read: "sb.dataRead", readWrite: "sb.dataAccess" };
const WATCH_REASONS = new Set([
    "watchpoint-trigger",
    "read-watchpoint-trigger",
    "access-watchpoint-trigger",
    "watchpoint-scope"
]);
const text = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= LIMIT && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const hardwareType = (type) => /^(?:hw|hardware|read|acc|access) watchpoint$/i.test(type || "");

function address(value) {
    const match = /^\s*(0x[\da-f]+|\d+)(?=\s|$)/i.exec(String(value));
    if (!match) return null;
    const number = BigInt(match[1]);
    return number > 0n && number <= 0xffffffffffffffffn ? number : null;
}

function variablePath(expression) {
    if (!text(expression)) throw new Error("Invalid variable path");
    safePath(expression);
    // GDB's path validator also accepts casts. Explicit calls (including (*fn)()) and
    // convenience registers are never eligible for data-breakpoint address evaluation.
    if (/\$|\)\s*\(/.test(expression)) throw new Error("Invalid variable path");
    return expression;
}

class DebugDataBreakpoints {
    constructor(session) {
        this.session = session;
        this.issued = new Map();
        this.identities = new Map();
        this.owned = new Map();
        this.prefix = randomUUID();
        this.sequence = 0;
        this.blocked = false;
    }
    get size() {
        return this.owned.size;
    }
    // The execution helper must reject continue/step while an unconfirmed watchpoint
    // could still be enabled after both cleanup and disabling failed.
    get unsafe() {
        return this.blocked || [...this.owned.values()].some((item) => !item.hardware && item.enabled !== "n");
    }
    message(key, params) {
        return t(this.session.lang, key, params);
    }
    invalid() {
        return new Error(this.message("debug.dataBreakpointInvalid"));
    }
    check(snapshot, node) {
        this.session.variableStore.check(snapshot);
        if (node && this.session.variableStore.nodes.get(node.item.name) !== node) throw this.invalid();
    }
    async resolve(args) {
        const session = this.session;
        const store = session.variableStore;
        if (!text(args?.name)) throw this.invalid();
        if (
            args.variablesReference !== undefined &&
            (!Number.isSafeInteger(args.variablesReference) || args.variablesReference < 0)
        )
            throw this.invalid();
        if (args.variablesReference) {
            const handle = session.reference(args.variablesReference);
            const parent = handle.kind === "page" ? handle.parent : handle;
            if (!parent || !["variable", "scope", "entry"].includes(parent.kind) || parent.scopeKind === "registers")
                throw this.invalid();
            const node = session.variablesByName.get(args.variablesReference)?.get(args.name);
            if (!node?.item?.name || node.kind !== "variable" || store.nodes.get(node.item.name) !== node)
                throw this.invalid();
            for (let current = node; current; current = current.parent) {
                if (current.unavailable || current.locked || current.stl || current.item?.dynamic === "1")
                    throw this.invalid();
            }
            if (node.item.in_scope === "false" || node.item.in_scope === "invalid") throw this.invalid();
            const snapshot = store.snapshot(node.frame);
            const context = store.stl.context(node.frame);
            if (!node.expression) {
                const result = await session.mi.command(`-var-info-path-expression ${quote(node.item.name)}`);
                this.check(snapshot, node);
                node.expression = gdbVariablePath(result.path_expr);
            }
            variablePath(node.expression);
            await store.stl.bindFrame(node, context);
            this.check(snapshot, node);
            return { node, snapshot, expression: node.expression };
        }
        // Expression-only requests support Watch scalars. Keep this grammar narrower than
        // GDB-generated paths: named storage, numeric indices, and member selection only.
        let expression = variablePath(args.name);
        const identifier = "(?:[A-Za-z_][\\w]*|'[^'\\r\\n]+')";
        const named = `(?:::)?${identifier}(?:::${identifier})*`;
        if (!new RegExp(`^${named}(?:(?:\\.|->)${identifier}|\\[\\d+\\])*$`).test(expression)) throw this.invalid();
        if (args.frameId === undefined && !expression.startsWith("::") && !/^'[^']+'::/.test(expression))
            expression = `::${expression}`;
        let frame = args.frameId === undefined ? undefined : session.selectedFrame;
        if (args.frameId !== undefined) frame = session.reference(args.frameId, "frame");
        frame ||= { thread: session.thread, level: 0 };
        if (!Number.isSafeInteger(frame.thread) || frame.thread < 1) throw this.invalid();
        const snapshot = store.snapshot(frame);
        const context = store.stl.context(frame);
        if (args.frameId !== undefined) await session.selectFrame(args.frameId);
        this.check(snapshot);
        await store.stl.bindFrame({ frame }, context);
        this.check(snapshot);
        return { snapshot, expression };
    }
    async addressOf(node, expression, snapshot) {
        // Even syntactically safe C++ paths can invoke overloaded &/[]/-> operators.
        // Refuse inferior calls while resolving storage, including metadata's address query.
        const setting = await this.session.mi.command("-gdb-show may-call-functions");
        this.check(snapshot, node);
        if (!["on", "off"].includes(setting.value)) throw this.invalid();
        if (setting.value === "on") await this.session.mi.command("-gdb-set may-call-functions off");
        try {
            this.check(snapshot, node);
            // Resolve again even when the variable tree has cached metadata: pointer writes
            // or container edits while paused may have moved a child's storage since rendering.
            const result = await this.session.mi.command(
                `-data-evaluate-expression ${quote(`(unsigned long long)&(${expression})`)}`
            );
            this.check(snapshot, node);
            const location = address(result.value);
            if (node && location !== null) node.memoryReference = `0x${location.toString(16)}`;
            return location;
        } finally {
            if (setting.value === "on") await this.session.mi.command("-gdb-set may-call-functions on");
        }
    }
    async info(args) {
        try {
            this.session.paused();
            const { node, snapshot, expression } = await this.resolve(args);
            const result = await this.session.mi.command(`-data-evaluate-expression ${quote(`sizeof(${expression})`)}`);
            this.check(snapshot, node);
            const width = Number(result.value);
            if (!Object.hasOwn(TYPES, width)) throw new Error(this.message("debug.dataBreakpointSize"));
            const location = await this.addressOf(node, expression, snapshot);
            if (location === null || location % BigInt(width))
                throw new Error(this.message("debug.dataBreakpointSize"));
            this.check(snapshot, node);
            const memory = `0x${location.toString(16)}`;
            const identity = `${memory}:${width}`;
            let dataId = this.identities.get(identity);
            if (!dataId) {
                if (this.issued.size >= LIMIT || this.session.dataBreakpoints?.issuedCount >= LIMIT)
                    throw new Error(this.message("debug.dataBreakpointLimit"));
                dataId = `${this.prefix}:${++this.sequence}`;
                // A dataId intentionally keeps this fixed storage across stops, frame changes,
                // and checkbox disable/re-enable. It never re-evaluates a local or pointer.
                this.issued.set(dataId, { address: memory, width, name: args.name, activated: false });
                this.identities.set(identity, dataId);
            }
            const storage = this.issued.get(dataId);
            // Scoped IDs are usable only in their issuing suspended state until activation.
            // Once armed, retain fixed-address identity for whole-set resend and re-enabling.
            storage.snapshot = args.variablesReference || args.frameId !== undefined ? snapshot : null;
            return {
                dataId,
                description: this.message("debug.dataBreakpointStorage", {
                    name: args.name,
                    address: memory,
                    bytes: width
                }),
                // VS Code and the sidebar menu offer only types that can coexist with what is armed.
                accessTypes: ACCESS.filter((access) => !this.conflict(storage, access)),
                canPersist: false,
                // Not DAP fields: the sidebar menu shows the resolved storage compactly.
                address: memory,
                bytes: width
            };
        } catch (error) {
            return {
                dataId: null,
                description: this.message("debug.dataBreakpointUnavailable", { error: error.message }),
                canPersist: false
            };
        }
    }
    specification(bp) {
        if (!bp || !text(bp.dataId) || !this.issued.has(bp.dataId)) throw this.invalid();
        const storage = this.issued.get(bp.dataId);
        if (!storage.activated && storage.snapshot) this.check(storage.snapshot);
        const access = bp.accessType ?? "write";
        if (!ACCESS.includes(access)) throw this.invalid();
        if (bp.hitCondition !== undefined && bp.hitCondition !== "")
            throw new Error(this.message("debug.dataBreakpointHitCondition"));
        if (bp.condition !== undefined && bp.condition !== "" && !text(bp.condition)) throw this.invalid();
        const condition = bp.condition || "";
        return {
            identity: JSON.stringify([bp.dataId, access, condition]),
            dataId: bp.dataId,
            access,
            condition,
            error: null
        };
    }
    event(item, reason = "changed") {
        this.session.sendEvent(new Event("breakpoint", { reason, breakpoint: { ...item.dap } }));
    }
    async remove(item) {
        await this.session.mi.command(`-break-delete ${item.number}`);
        this.owned.delete(item.number);
    }
    async cleanup(item) {
        try {
            await this.remove(item);
        } catch (error) {
            try {
                await this.session.mi.command(`-break-disable ${item.number}`);
                item.enabled = "n";
            } catch (disableError) {
                throw new Error(`${error.message}; ${disableError.message}`);
            }
            throw error;
        }
    }
    async confirmHardware(result, item) {
        let bkpt = result.wpt || result["hw-rwpt"] || result["hw-awpt"] || result.bkpt;
        if (bkpt?.type !== undefined) return hardwareType(bkpt.type);
        if (result["hw-rwpt"] || result["hw-awpt"]) return true;
        const info = await this.session.mi.command(`-break-info ${item.number}`);
        const body = info.BreakpointTable?.body;
        bkpt = Array.isArray(body)
            ? body.map((entry) => entry.bkpt || entry).find((entry) => String(entry.number) === item.number)
            : info.bkpt;
        return hardwareType(bkpt?.type);
    }
    // GDB accepts any number of watchpoints but inserts them only on resume. OpenOCD refuses a
    // second watchpoint at an address unless its length and access match, so continue would be
    // aborted. Reject the combination here, across both groups, while it is still explainable.
    conflict(storage, access) {
        const groups = this.session.dataBreakpoints;
        const managers = groups?.native && groups?.sidebar ? [groups.native, groups.sidebar] : [this];
        for (const manager of managers)
            for (const item of manager.owned.values())
                if (
                    item.enabled !== "n" &&
                    item.address === storage.address &&
                    (item.width !== storage.width || item.access !== access)
                )
                    return item;
        return null;
    }
    async create(spec) {
        const storage = this.issued.get(spec.dataId);
        const existing = this.conflict(storage, spec.access);
        if (existing)
            throw new Error(
                this.message("debug.dataBreakpointConflict", {
                    address: storage.address,
                    access: this.message(ACCESS_LABELS[existing.access])
                })
            );
        const flag = { write: "", read: "-r ", readWrite: "-a " }[spec.access];
        const expression = `*((${TYPES[storage.width]} *)${storage.address})`;
        const result = await this.session.mi.command(`-break-watch ${flag}${quote(expression)}`);
        const bkpt = result.wpt || result["hw-rwpt"] || result["hw-awpt"] || result.bkpt;
        if (!/^\d+$/.test(String(bkpt?.number))) {
            this.blocked = true;
            throw new Error(this.message("debug.dataBreakpointHardware"));
        }
        const item = {
            ...spec,
            number: String(bkpt.number),
            address: storage.address,
            width: storage.width,
            hardware: false,
            enabled: bkpt.enabled || "y",
            dap: { id: this.session.nextBreakpoint++, verified: false }
        };
        this.owned.set(item.number, item);
        try {
            item.hardware = await this.confirmHardware(result, item);
            if (!item.hardware) throw new Error(this.message("debug.dataBreakpointHardware"));
            if (spec.condition)
                await this.session.mi.command(`-break-condition ${item.number} ${quote(spec.condition)}`);
            storage.activated = true;
            item.dap.verified = true;
            return item;
        } catch (error) {
            item.dap.message = error.message;
            try {
                await this.cleanup(item);
            } catch (cleanupError) {
                item.dap.message += `; ${cleanupError.message}`;
                this.event(item);
            }
            throw new Error(item.dap.message);
        }
    }
    async set(args) {
        this.session.checkRequest();
        if (!this.session.ready) throw this.invalid();
        const requested = args?.breakpoints;
        if (!Array.isArray(requested) || requested.length > LIMIT) throw this.invalid();
        const specs = requested.map((bp) => {
            try {
                return this.specification(bp);
            } catch (error) {
                return { identity: null, error };
            }
        });
        const wanted = new Set(specs.filter((spec) => !spec.error).map((spec) => spec.identity));
        const reusable = new Map(
            [...this.owned.values()]
                .filter((item) => item.hardware && item.enabled !== "n" && !item.changed && item.dap.verified)
                .map((item) => [item.identity, item])
        );
        const obsolete = [...this.owned.values()].filter(
            (item) => !wanted.has(item.identity) || reusable.get(item.identity) !== item
        );
        const missing = specs.some((spec) => !spec.error && !reusable.has(spec.identity));
        if (!obsolete.length && !missing)
            return {
                breakpoints: specs.map((spec) =>
                    spec.error
                        ? { verified: false, message: spec.error.message }
                        : { ...reusable.get(spec.identity).dap }
                )
            };
        const resume = this.session.running;
        this.session.internalStop = resume ? { interrupted: false } : null;
        const failures = [];
        try {
            if (resume) await this.session.interrupt();
            this.session.paused();
            for (const item of obsolete) {
                try {
                    await this.remove(item);
                } catch (error) {
                    const message = this.message("debug.dataBreakpointRemove", { error: error.message });
                    failures.push(message);
                    item.dap = { ...item.dap, message };
                    this.event(item);
                    this.session.sendEvent(new OutputEvent(`${message}\n`, "stderr"));
                }
            }
            const breakpoints = [];
            for (const spec of specs) {
                if (spec.error) {
                    breakpoints.push({ verified: false, message: spec.error.message });
                    continue;
                }
                try {
                    let item = reusable.get(spec.identity);
                    if (!item || !this.owned.has(item.number)) {
                        item = await this.create(spec);
                        reusable.set(spec.identity, item);
                    }
                    breakpoints.push({ ...item.dap });
                } catch (error) {
                    breakpoints.push({
                        verified: false,
                        message: this.message("debug.dataBreakpointResources", { error: error.message })
                    });
                }
            }
            if (failures.length && !breakpoints.length) throw new Error(failures.join("; "));
            return { breakpoints };
        } finally {
            const interrupted = this.session.internalStop?.interrupted;
            this.session.internalStop = null;
            if (resume && interrupted && !this.session.ended) {
                // An unconfirmed software watchpoint must not run; show the client the stop instead.
                if (this.unsafe) this.session.reportHiddenStop();
                else await this.continueAfterUpdate();
            }
        }
    }
    async continueAfterUpdate() {
        try {
            await this.session.resumeAfterInternalStop();
        } catch (error) {
            this.executionFailed(error);
            throw error;
        }
    }
    update(item, bkpt) {
        const before = JSON.stringify(item.dap);
        if (bkpt.enabled !== undefined) item.enabled = bkpt.enabled;
        if (bkpt.type !== undefined) item.hardware = hardwareType(bkpt.type);
        if (bkpt.cond !== undefined || bkpt.type !== undefined) item.changed = (bkpt.cond || "") !== item.condition;
        item.dap.verified = item.hardware && item.enabled !== "n" && !item.changed && !item.executionError;
        if (item.executionError)
            item.dap.message = this.message("debug.dataBreakpointResources", { error: item.executionError });
        else if (!item.dap.verified) item.dap.message = this.message("debug.dataBreakpointChanged");
        else delete item.dap.message;
        if (JSON.stringify(item.dap) !== before) this.event(item);
    }
    deleted(item) {
        this.owned.delete(item.number);
        item.dap = { ...item.dap, verified: false };
        this.event(item, "removed");
    }
    onRecord(record) {
        if (record.kind !== "=") return;
        const number = String(record.data?.bkpt?.number ?? record.data?.id);
        const item = this.owned.get(number);
        if (!item) return;
        if (record.class === "breakpoint-deleted") this.deleted(item);
        else if (record.class === "breakpoint-modified") this.update(item, record.data.bkpt);
    }
    reconcile(listed) {
        if (
            this.blocked &&
            ![...listed.values()].some(
                (bkpt) => /watchpoint/i.test(bkpt.type || "") && !hardwareType(bkpt.type) && bkpt.enabled !== "n"
            )
        )
            this.blocked = false;
        for (const item of this.owned.values()) {
            const bkpt = listed.get(item.number);
            if (bkpt) this.update(item, bkpt);
            else this.deleted(item);
        }
    }
    executionFailed(error) {
        if (!/watchpoint|hardware (?:breakpoint|resource)|could not insert|cannot insert/i.test(error.message)) return;
        for (const item of this.owned.values()) {
            item.executionError = error.message;
            item.dap = {
                ...item.dap,
                verified: false,
                message: this.message("debug.dataBreakpointResources", { error: error.message })
            };
            this.event(item);
        }
    }
    stop(data) {
        if (!WATCH_REASONS.has(data?.reason)) return null;
        const watchpoint = data.wpt || data["hw-rwpt"] || data["hw-awpt"];
        const number = String(watchpoint?.number ?? data.bkptno ?? data.wpnum);
        const item = this.owned.get(number);
        const storage = item && this.issued.get(item.dataId);
        const name = storage?.name || watchpoint?.exp || number;
        const description = this.message("debug.dataBreakpointStopped", { name });
        let details = description;
        if (data.value?.old !== undefined && data.value?.new !== undefined)
            details = this.message("debug.dataBreakpointValues", { old: data.value.old, new: data.value.new });
        else if (data.value?.value !== undefined || data.value?.new !== undefined)
            details = this.message("debug.dataBreakpointValue", { value: data.value.value ?? data.value.new });
        return {
            reason: "data breakpoint",
            description,
            text: details,
            ...(item ? { hitBreakpointIds: [item.dap.id] } : {})
        };
    }
    clear() {
        this.owned.clear();
        this.issued.clear();
        this.identities.clear();
        this.blocked = false;
    }
}

module.exports = { DebugDataBreakpoints };
