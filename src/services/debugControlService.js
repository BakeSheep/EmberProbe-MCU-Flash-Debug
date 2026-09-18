"use strict";

const fs = require("fs");
const path = require("path");

function sourcePath(breakpoint) {
    return breakpoint?.location?.uri?.fsPath || "";
}

function sourceLine(breakpoint) {
    const line = breakpoint?.location?.range?.start?.line ?? breakpoint?.location?.range?.line;
    return Number.isInteger(line) ? line + 1 : null;
}

function sourceColumn(breakpoint) {
    const column = breakpoint?.location?.range?.start?.character ?? breakpoint?.location?.range?.character;
    return Number.isInteger(column) ? column + 1 : null;
}

function breakpointKind(breakpoint) {
    if (sourcePath(breakpoint)) return "source";
    if (typeof breakpoint?.functionName === "string") return "function";
    return "unknown";
}

function describeBreakpoint(breakpoint) {
    const type = breakpointKind(breakpoint);
    const common = {
        type,
        enabled: breakpoint.enabled !== false,
        condition: breakpoint.condition || "",
        hitCondition: breakpoint.hitCondition || "",
        logMessage: breakpoint.logMessage || ""
    };
    if (type === "source")
        return {
            ...common,
            file: sourcePath(breakpoint),
            line: sourceLine(breakpoint),
            column: sourceColumn(breakpoint)
        };
    if (type === "function") return { ...common, function: breakpoint.functionName };
    return common;
}

function error(message, code, details) {
    return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

class DebugControlService {
    constructor(options = {}) {
        this.vscode = options.vscode;
        this.debugBridge = options.debugBridge;
        this.workspaceProvider = options.workspaceProvider;
        this.startDebug = options.startDebug;
        this.controlInFlight = null;
    }

    status() {
        return this.debugBridge.agentStatus();
    }

    async start() {
        const current = this.status();
        if (current.state === "running" || current.state === "paused") return { alreadyActive: true, status: current };
        if (current.state === "conflict")
            throw error("Multiple debugger sessions match this workspace", "DEBUG_SESSION_CONFLICT");
        const started = await this.startDebug();
        if (!started) throw error("debugger did not start", "DEBUG_START_FAILED");
        const status = await this.debugBridge.waitForState(
            (next) => next.state === "running" || next.state === "paused" || next.state === "conflict",
            15000
        );
        if (status.state === "conflict")
            throw error("Multiple debugger sessions match this workspace", "DEBUG_SESSION_CONFLICT");
        return { alreadyActive: false, status };
    }

    async control(params = {}) {
        const action = String(params.action || "").trim();
        if (this.controlInFlight)
            throw error("Another debug control action is still in progress", "DEBUG_CONTROL_BUSY", {
                action,
                activeAction: this.controlInFlight
            });
        if (params.threadId !== undefined && (!Number.isInteger(params.threadId) || params.threadId < 1))
            throw error("threadId must be a positive integer", "INVALID_DEBUG_THREAD");
        this.controlInFlight = action;
        try {
            return await this._control(action, params.threadId);
        } finally {
            if (this.controlInFlight === action) this.controlInFlight = null;
        }
    }

    async _control(action, threadId) {
        if (action !== "stop") return this.debugBridge.control(action, threadId);
        const session = this.debugBridge.assertUniqueSession();
        const before = this.status();
        const stopped = await this.vscode.debug.stopDebugging(session);
        if (stopped === false) throw error("VS Code refused to stop the debugger session", "DEBUG_STOP_FAILED");
        const status = await this.debugBridge.waitForState((next) => next.state === "none", 10000);
        return { action, before, status };
    }

    _workspaceRoot() {
        const workspace = this.workspaceProvider();
        if (!workspace) throw error("No workspace is open", "NO_WORKSPACE");
        return path.resolve(workspace);
    }

    _sourceLocator(params) {
        const workspace = this._workspaceRoot();
        const requested = String(params.file || "").trim();
        if (!requested) throw error("A source breakpoint requires --file", "INVALID_BREAKPOINT");
        const file = path.resolve(workspace, requested);
        const relative = path.relative(workspace, file);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            throw error(
                "Source breakpoint paths must stay inside the current workspace",
                "BREAKPOINT_PATH_OUTSIDE_WORKSPACE"
            );
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
            throw error(`Source breakpoint file does not exist: ${file}`, "BREAKPOINT_SOURCE_NOT_FOUND");
        const line = Number(params.line);
        const column = params.column === undefined ? 1 : Number(params.column);
        if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1)
            throw error("Breakpoint line and column are 1-based positive integers", "INVALID_BREAKPOINT");
        return { type: "source", file, line, column };
    }

    _locator(params) {
        const type = String(params.type || "").trim();
        if (type === "source") return this._sourceLocator(params);
        if (type === "function") {
            const name = String(params.function || "").trim();
            if (!name) throw error("A function breakpoint requires --function", "INVALID_BREAKPOINT");
            return { type, function: name };
        }
        throw error(`Unsupported breakpoint type: ${type}`, "INVALID_BREAKPOINT");
    }

    _matches(breakpoint, locator) {
        const item = describeBreakpoint(breakpoint);
        if (item.type !== locator.type) return false;
        if (locator.type === "function") return item.function === locator.function;
        return path.resolve(item.file) === locator.file && item.line === locator.line && item.column === locator.column;
    }

    _create(locator, params, enabled = params.enabled !== false) {
        const condition = params.condition || undefined;
        const hitCondition = params.hitCondition || undefined;
        const logMessage = params.logMessage || undefined;
        if (locator.type === "function")
            return new this.vscode.FunctionBreakpoint(locator.function, enabled, condition, hitCondition, logMessage);
        const location = new this.vscode.Location(
            this.vscode.Uri.file(locator.file),
            new this.vscode.Position(locator.line - 1, locator.column - 1)
        );
        return new this.vscode.SourceBreakpoint(location, enabled, condition, hitCondition, logMessage);
    }

    async listBreakpoints() {
        const session = this.debugBridge.activeSession;
        const breakpoints = [];
        for (const breakpoint of this.vscode.debug.breakpoints || []) {
            const item = describeBreakpoint(breakpoint);
            if (item.type === "unknown") continue;
            if (session?.getDebugProtocolBreakpoint) {
                try {
                    const dap = await session.getDebugProtocolBreakpoint(breakpoint);
                    item.verified = dap?.verified ?? null;
                    if (dap?.message) item.message = dap.message;
                    if (Number.isInteger(dap?.line)) item.actualLine = dap.line;
                } catch {
                    item.verified = null;
                }
            }
            breakpoints.push(item);
        }
        return { status: this.status(), breakpoints };
    }

    async updateBreakpoints(params = {}) {
        const action = String(params.action || "").trim();
        if (!new Set(["add", "remove", "enable", "disable"]).has(action))
            throw error(`Unsupported breakpoint action: ${action}`, "INVALID_BREAKPOINT_ACTION");
        const locator = this._locator(params);
        const matches = (this.vscode.debug.breakpoints || []).filter((breakpoint) =>
            this._matches(breakpoint, locator)
        );
        if (action === "add") {
            if (!matches.length) this.vscode.debug.addBreakpoints([this._create(locator, params)]);
        } else if (action === "remove") {
            if (matches.length) this.vscode.debug.removeBreakpoints(matches);
        } else {
            const enabled = action === "enable";
            if (matches.length) {
                this.vscode.debug.removeBreakpoints(matches);
                this.vscode.debug.addBreakpoints(
                    matches.map((breakpoint) => this._create(locator, breakpoint, enabled))
                );
            } else {
                throw error("The requested breakpoint does not exist", "BREAKPOINT_NOT_FOUND", locator);
            }
        }
        return { action, locator, ...(await this.listBreakpoints()) };
    }
}

module.exports = { DebugControlService, describeBreakpoint, breakpointKind };
