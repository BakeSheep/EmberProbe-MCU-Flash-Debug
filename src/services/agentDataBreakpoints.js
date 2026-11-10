"use strict";

// Agent access to hardware data breakpoints (watchpoints). They are the sidebar's data breakpoint group, so a
// watchpoint the Agent sets shows in the sidebar and the user can change or remove it there, and the other way round.
// Requests share the sidebar's queue and take the same paused/stale-state guards; the adapter re-checks its own
// variable snapshot generation before arming anything.

const ACCESS_TYPES = ["write", "read", "readWrite"];
const ACTIONS = ["add", "remove", "enable", "disable"];
const KEYS = ["type", "action", "variable", "access", "condition", "id"];
const MAX_TEXT = 1024;

function failure(message, code, details) {
    return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

const invalid = (message) => failure(message, "INVALID_PARAMS");

function text(value, name) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || /[\x00-\x1f\x7f]/.test(value))
        throw invalid(`${name} must be a non-empty single-line string of at most ${MAX_TEXT} characters`);
    return value.trim();
}

function publicEntry(entry) {
    return {
        id: entry.id,
        variable: entry.name,
        access: entry.accessType,
        condition: entry.condition || "",
        enabled: entry.enabled !== false,
        verified: entry.verified === true,
        ...(entry.description ? { storage: entry.description } : {}),
        ...(entry.message ? { message: entry.message } : {})
    };
}

class AgentDataBreakpoints {
    constructor({ host, bridge, group }) {
        this.host = host;
        this.bridge = bridge;
        this.group = group;
    }

    // Native EmberProbe sessions only: the group lives in the built-in debug adapter.
    _session() {
        const session = this.bridge.assertUniqueSession();
        if (session.type !== "emberprobe")
            throw failure(
                "Data breakpoints need the built-in EmberProbe debugger",
                "DATA_BREAKPOINT_SESSION_UNSUPPORTED"
            );
        return session;
    }

    async list() {
        const session = this.bridge.activeSession;
        if (session?.type !== "emberprobe" || this.bridge.conflict)
            return { available: false, paused: false, entries: [] };
        // Listing source/function breakpoints must not fail because the adapter could not answer for watchpoints.
        try {
            const snapshot = await this.group.exclusive(() =>
                session.customRequest("emberprobe.sidebarDataBreakpoints", { action: "list" })
            );
            return { available: true, paused: this.bridge.paused, entries: (snapshot?.entries || []).map(publicEntry) };
        } catch (error) {
            return {
                available: false,
                paused: this.bridge.paused,
                entries: [],
                error: String(error?.message || error)
            };
        }
    }

    _parse(params) {
        if (!params || typeof params !== "object" || Array.isArray(params))
            throw invalid("Data breakpoint parameters must be an object");
        const unknown = Object.keys(params).filter((key) => !KEYS.includes(key));
        if (unknown.length) throw invalid(`Unsupported data breakpoint parameters: ${unknown.join(", ")}`);
        const action = String(params.action || "").trim();
        if (!ACTIONS.includes(action))
            throw failure(`Unsupported breakpoint action: ${action}`, "INVALID_BREAKPOINT_ACTION");
        const access = params.access === undefined ? undefined : String(params.access);
        if (access !== undefined && !ACCESS_TYPES.includes(access))
            throw invalid(`access must be one of ${ACCESS_TYPES.join(", ")}`);
        const variable = params.variable === undefined ? undefined : text(params.variable, "variable");
        const id = params.id === undefined ? undefined : text(String(params.id), "id");
        if (params.condition !== undefined && action !== "add")
            throw invalid("condition is only accepted when adding a data breakpoint");
        const condition =
            params.condition === undefined || params.condition === "" ? "" : text(params.condition, "condition");
        if (action === "add" && !variable) throw invalid("Adding a data breakpoint needs variable");
        if (action !== "add" && !id && !variable) throw invalid("Select the data breakpoint by id or variable");
        return { action, access, variable, id, condition };
    }

    _find(entries, request) {
        const matches = entries.filter((entry) =>
            request.id
                ? entry.id === request.id
                : entry.name === request.variable && (!request.access || entry.accessType === request.access)
        );
        if (!matches.length)
            throw failure("The requested data breakpoint does not exist", "BREAKPOINT_NOT_FOUND", {
                ...(request.id ? { id: request.id } : { variable: request.variable })
            });
        if (matches.length > 1)
            throw failure("More than one data breakpoint watches this variable; select it by id", "INVALID_PARAMS", {
                ids: matches.map((entry) => entry.id)
            });
        return matches[0];
    }

    async update(params) {
        const request = this._parse(params);
        // Checked before queueing so a bad name never waits behind other requests.
        const name = request.variable && request.action === "add" ? this._validName(request.variable) : undefined;
        const result = await this.group.exclusive(async () => {
            const session = this._session();
            this.bridge.assertPausedAccess();
            const epoch = this.bridge.stopEpoch;
            const inspection = this.bridge.inspectionEpoch;
            const elfGeneration = this.host._elfService?.generation;
            const guard = () => {
                if (
                    session !== this.bridge.activeSession ||
                    epoch !== this.bridge.stopEpoch ||
                    inspection !== this.bridge.inspectionEpoch ||
                    elfGeneration !== this.host._elfService?.generation ||
                    this.bridge.transitionKind ||
                    this.bridge.replBusy
                )
                    throw failure(
                        "The debugger state changed during the data breakpoint update",
                        "DEBUG_STATE_CHANGED"
                    );
            };
            const call = async (args) => {
                guard();
                try {
                    return await session.customRequest("emberprobe.sidebarDataBreakpoints", args);
                } catch (error) {
                    guard();
                    throw failure(error?.message || String(error), "DATA_BREAKPOINT_FAILED");
                } finally {
                    guard();
                }
            };
            if (request.action === "add") {
                const resolved = await call({ action: "info", name });
                const info = resolved?.info;
                if (!info?.dataId)
                    throw failure(
                        info?.description || "The variable has no fixed storage",
                        "DATA_BREAKPOINT_UNAVAILABLE",
                        {
                            variable: name
                        }
                    );
                return call({
                    action: "add",
                    generation: resolved.generation,
                    name,
                    dataId: info.dataId,
                    accessType: request.access || "write",
                    condition: request.condition,
                    description: info.description
                });
            }
            const listed = await call({ action: "list" });
            const entry = this._find(listed?.entries || [], request);
            return call({
                action: request.action === "remove" ? "remove" : "enable",
                generation: listed.generation,
                id: entry.id,
                ...(request.action === "remove" ? {} : { enabled: request.action === "enable" })
            });
        });
        const entries = (result?.entries || []).map(publicEntry);
        // An add whose watchpoint could not be armed comes back as an unverified row with GDB's message.
        return { action: request.action, available: true, paused: this.bridge.paused, entries };
    }

    _validName(variable) {
        try {
            return this.group.validateName(variable);
        } catch (error) {
            throw failure(error?.message || String(error), "DATA_BREAKPOINT_UNSUPPORTED", { variable });
        }
    }
}

module.exports = { AgentDataBreakpoints, ACCESS_TYPES };
