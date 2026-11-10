"use strict";

const { randomUUID } = require("crypto");
const { unwrapResponse } = require("./debugSessionBridge");
const { safePath } = require("../debug/stl");

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
        if (this.bridge.replBusy) throw fail("DEBUG_CONTROL_BUSY", "Wait for the GDB console command to finish");
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
            this.bridge.replBusy ||
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
        // A DAP integer is never a handle; "list again" would only return the same handle shape.
        if (typeof key !== "string" || !key)
            throw fail(
                "DEBUG_INSPECTION_INVALID",
                `${kind === "frame" ? "frame" : "reference"} must be a handle string from a previous listing`
            );
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
        return this.identified(result, context);
    }

    identified(result, context) {
        return {
            ...result,
            sessionId: context.session.id,
            stopEpoch: context.epoch,
            inspectionEpoch: context.inspectionEpoch
        };
    }

    // Evaluates a variable path in the adapter's hover context, which accepts no assignment, increment or
    // call: it reads target memory like the Variables view and never changes state. The path is checked
    // here too, so a rejected expression gets its own code instead of the adapter's display error.
    async evaluate(params = {}) {
        const expression = params?.expression;
        if (typeof expression !== "string" || !expression.trim() || expression.length > MAX_EXPRESSION)
            throw fail(
                "DEBUG_INSPECTION_INVALID",
                `expression must be a nonempty string of at most ${MAX_EXPRESSION} characters`
            );
        try {
            safePath(expression.trim());
        } catch {
            throw fail(
                "DEBUG_EXPRESSION_REJECTED",
                "Only side-effect-free variable paths can be evaluated: no assignment, ++/-- or function call"
            );
        }
        const context = this.context();
        const frameId = params.frame === undefined ? undefined : this.resolve(params.frame, "frame");
        const { variablesReference, ...result } = await this.request(context, "evaluate", {
            expression: expression.trim(),
            context: "hover",
            ...(frameId === undefined ? {} : { frameId })
        });
        return this.identified({ ...result, reference: this.handle(variablesReference, "variable") }, context);
    }

    // Raw reads stay in the Code and SRAM regions of the Cortex-M map. Peripheral, external-device and system
    // addresses may have read side effects (clearing a status flag, popping a FIFO); peripherals.read checks
    // those per register against the SVD instead.
    async readMemory(params = {}) {
        const address = memoryAddress(params?.address);
        const length = integer(params?.length, 64, 1, MAX_MEMORY_READ, "length");
        if (address + length > READABLE_MEMORY_END)
            throw Object.assign(
                fail("MEMORY_REGION_NOT_ALLOWED", "Raw memory reads are limited to 0x00000000-0x3FFFFFFF"),
                { details: { address: hex(address), length, limit: hex(READABLE_MEMORY_END - 1) } }
            );
        const context = this.context();
        const result = await this.request(context, "readMemory", { memoryReference: hex(address), count: length });
        const bytes = Buffer.from(result.data || "", "base64").subarray(0, length);
        return this.identified(
            {
                address: hex(address),
                length,
                hex: bytes.toString("hex"),
                unreadableBytes: Number.isInteger(result.unreadableBytes)
                    ? result.unreadableBytes
                    : length - bytes.length
            },
            context
        );
    }
}

const MAX_EXPRESSION = 1024;
const MAX_MEMORY_READ = 4096;
// End (exclusive) of the Cortex-M Code (0x00000000-0x1FFFFFFF) and SRAM (0x20000000-0x3FFFFFFF) regions.
const READABLE_MEMORY_END = 0x40000000;

function hex(value) {
    return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

function memoryAddress(value) {
    const parsed =
        typeof value === "string" && /^0x[\da-f]{1,8}$/i.test(value.trim())
            ? parseInt(value.trim(), 16)
            : Number.isSafeInteger(value)
              ? value
              : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff)
        throw fail("DEBUG_INSPECTION_INVALID", "address must be a 0x-prefixed hex string or a non-negative integer");
    return parsed;
}

module.exports = { AgentDebugInspection, integer, MAX_MEMORY_READ };
