"use strict";

const { randomUUID } = require("crypto");
const { unwrapResponse } = require("./debugSessionBridge");

function fail(code, message) {
    return Object.assign(new Error(message), { code });
}

function integer(value, fallback, min, max, name) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < min || result > max)
        throw fail("DEBUG_INSPECTION_INVALID", `${name} must be an integer from ${min} to ${max}`);
    return result;
}

// Agent handles are separate from DAP integers: an old frame/reference must never
// accidentally identify a different object after resume, write or core selection.
class AgentDebugInspection {
    constructor(bridge) {
        this.bridge = bridge;
        this.handles = new Map();
        this.session = null;
        this.epoch = -1;
        this.inspectionEpoch = -1;
    }

    context() {
        const session = this.bridge.assertUniqueSession();
        if (session.type !== "emberprobe")
            throw fail("DEBUG_INSPECTION_UNSUPPORTED", "Paused inspection requires the native EmberProbe debugger");
        if (!this.bridge.paused) throw fail("TARGET_NOT_PAUSED", "Pause the debugger before inspection");
        if (this.bridge.transitionKind)
            throw fail("DEBUG_STATE_TRANSITION", "Wait for debug execution control to finish");
        if (this.bridge.writing) throw fail("DEBUG_CONTROL_BUSY", "Wait for the memory write to finish");
        const epoch = this.bridge.stopEpoch;
        const inspectionEpoch = this.bridge.inspectionEpoch || 0;
        if (this.session !== session || this.epoch !== epoch || this.inspectionEpoch !== inspectionEpoch) {
            this.handles.clear();
            this.session = session;
            this.epoch = epoch;
            this.inspectionEpoch = inspectionEpoch;
        }
        return { session, epoch, inspectionEpoch };
    }

    assertCurrent(context) {
        if (
            context.session !== this.bridge.activeSession ||
            context.epoch !== this.bridge.stopEpoch ||
            context.inspectionEpoch !== (this.bridge.inspectionEpoch || 0) ||
            this.bridge.writing ||
            !this.bridge.paused ||
            this.bridge.transitionKind
        )
            throw fail("DEBUG_INSPECTION_STALE", "Debugger context changed; list threads and frames again");
    }

    handle(id, kind) {
        if (!Number.isSafeInteger(id) || id < 0 || (kind === "variable" && id === 0)) return null;
        for (const [key, value] of this.handles) if (value.id === id && value.kind === kind) return key;
        if (this.handles.size >= 2048)
            throw fail("DEBUG_INSPECTION_LIMIT", "Inspection handle budget exceeded; resume and pause to refresh");
        const key = randomUUID();
        this.handles.set(key, { id, kind });
        return key;
    }

    resolve(key, kind) {
        const value = this.handles.get(key);
        if (!value || value.kind !== kind)
            throw fail("DEBUG_INSPECTION_STALE", "Unknown or expired inspection handle; list frames/scopes again");
        return value.id;
    }

    async request(context, command, params) {
        try {
            const result = unwrapResponse(await context.session.customRequest(command, params));
            this.assertCurrent(context);
            return result;
        } catch (error) {
            this.assertCurrent(context);
            throw error;
        }
    }

    async inspect(params = {}) {
        const { action } = params;
        if (!["threads", "stack", "scopes", "variables"].includes(action))
            throw fail("DEBUG_INSPECTION_INVALID", "Choose threads, stack, scopes or variables");
        const context = this.context();
        let result;
        if (action === "threads") {
            result = await this.request(context, "threads", {});
        } else if (action === "stack") {
            const threadId = integer(params.threadId, undefined, 1, Number.MAX_SAFE_INTEGER, "threadId");
            const startFrame = integer(params.start, 0, 0, 100000, "start");
            const levels = integer(params.count, 20, 1, 100, "count");
            const threads = await this.request(context, "threads", {});
            if (!(threads.threads || []).some((thread) => thread.id === threadId))
                throw fail("DEBUG_TASK_EXITED", "The requested debug thread no longer exists");
            result = await this.request(context, "stackTrace", { threadId, startFrame, levels });
            result.stackFrames = (result.stackFrames || []).map(({ id, ...frame }) => ({
                ...frame,
                frame: this.handle(id, "frame")
            }));
        } else if (action === "scopes") {
            result = await this.request(context, "scopes", { frameId: this.resolve(params.frame, "frame") });
            result.scopes = (result.scopes || []).map(({ variablesReference, ...scope }) => ({
                ...scope,
                reference: this.handle(variablesReference, "variable")
            }));
        } else {
            const variablesReference = this.resolve(params.reference, "variable");
            const start = integer(params.start, 0, 0, 100000, "start");
            const count = integer(params.count, 50, 1, 100, "count");
            if (params.filter !== undefined && !["indexed", "named"].includes(params.filter))
                throw fail("DEBUG_INSPECTION_INVALID", "filter must be indexed or named");
            result = await this.request(context, "variables", {
                variablesReference,
                start,
                count,
                filter: params.filter
            });
            result.variables = (result.variables || []).map(({ variablesReference: child, ...variable }) => ({
                ...variable,
                reference: this.handle(child, "variable")
            }));
        }
        return {
            ...result,
            sessionId: context.session.id,
            stopEpoch: context.epoch,
            inspectionEpoch: context.inspectionEpoch
        };
    }
}

module.exports = { AgentDebugInspection, integer };
