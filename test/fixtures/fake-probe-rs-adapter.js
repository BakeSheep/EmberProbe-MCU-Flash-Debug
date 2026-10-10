"use strict";

const fs = require("node:fs");
const {
    DebugSession,
    InitializedEvent,
    ContinuedEvent,
    StoppedEvent,
    TerminatedEvent
} = require("@vscode/debugadapter");

class FixtureProbeRsAdapter extends DebugSession {
    constructor() {
        super();
        this.memory = new Map();
        this.paused = false;
        this.configured = false;
        this.readDelayMs = 0;
        this.breakpoints = new Map();
        this.instructionBreakpoints = [];
        this.breakpointTimer = null;
        this.frameId = 100;
        this.counter = 3;
        this.location = null;
        this.sourceLocations = new Map();
        const put = (address, words) => {
            const bytes = Buffer.alloc(words.length * 4);
            words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
            for (let i = 0; i < bytes.length; i++) this.memory.set(address + i, bytes[i]);
        };
        put(0xe0042000, [0x10010413]);
        put(0x1fff7a22, [1024]);
        put(0x1fff7a10, [0x001d0041, 0x31345104, 0x38373332]);
        put(0xe00fffe0, [0x13, 0x04, 0x0a, 0]);
        put(0xe00fffd0, [0, 0, 0, 0]);
        put(0xe00ffff0, [0x0d, 0x10, 0x05, 0xb1]);
    }
    initializeRequest(response) {
        response.body = {
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsRestartRequest: true,
            supportsConfigurationDoneRequest: true,
            supportsInstructionBreakpoints: true,
            supportsSteppingGranularity: true
        };
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }
    attachRequest(response, args) {
        this.readDelayMs = Math.max(0, Math.min(1000, Number(args?.__fixtureReadDelayMs) || 0));
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(1, true));
    }
    configurationDoneRequest(response) {
        this.configured = true;
        this.sendResponse(response);
        this._scheduleBreakpoint();
    }
    setBreakPointsRequest(response, args) {
        const source = args.source;
        let lines = 0;
        try {
            lines = fs.readFileSync(source.path, "utf8").trimEnd().split("\n").length;
        } catch {
            // Invalid source requests return unverified locations.
        }
        const breakpoints = (args.breakpoints || []).map((breakpoint) => ({
            id: breakpoint.line,
            verified:
                Number.isInteger(breakpoint.line) &&
                breakpoint.line > 0 &&
                breakpoint.line <= lines &&
                !source.path.endsWith(".cpp"),
            message: source.path.endsWith(".cpp") ? "No valid breakpoint information found" : undefined,
            source,
            line: breakpoint.line,
            instructionReference: "0x08000100"
        }));
        for (const breakpoint of breakpoints)
            if (breakpoint.line > 0 && breakpoint.line <= lines)
                this.sourceLocations.set(Number(breakpoint.instructionReference), breakpoint);
        this.breakpoints.set(
            source.path,
            breakpoints.filter((breakpoint) => breakpoint.verified)
        );
        clearTimeout(this.breakpointTimer);
        this.breakpointTimer = null;
        response.body = { breakpoints };
        this.sendResponse(response);
        this._scheduleBreakpoint();
    }
    setInstructionBreakpointsRequest(response, args) {
        const breakpoints = args.breakpoints.map((breakpoint) => ({
            ...breakpoint,
            verified: /^0x[0-9a-f]+$/i.test(breakpoint.instructionReference)
        }));
        this.instructionBreakpoints = breakpoints.filter((breakpoint) => breakpoint.verified);
        response.body = { breakpoints };
        this.sendResponse(response);
        this._scheduleBreakpoint();
    }
    _scheduleBreakpoint() {
        const breakpoint = [...this.breakpoints.values()].flat()[0] || this.instructionBreakpoints[0];
        if (!this.configured || this.paused || this.breakpointTimer || !breakpoint) return;
        this.breakpointTimer = setTimeout(() => this._stop("breakpoint", breakpoint), 30);
    }
    _stop(reason, location = this.location) {
        clearTimeout(this.breakpointTimer);
        this.breakpointTimer = null;
        this.paused = true;
        this.location = location?.source
            ? location
            : { ...this.sourceLocations.get(Number(location?.instructionReference)), ...location };
        this.frameId++;
        this.sendEvent(new StoppedEvent(reason, 1));
    }
    threadsRequest(response) {
        response.body = { threads: [{ id: 1, name: "Main" }] };
        this.sendResponse(response);
    }
    pauseRequest(response) {
        this.sendResponse(response);
        this._stop("pause");
    }
    continueRequest(response) {
        this.paused = false;
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(1, true));
        this._scheduleBreakpoint();
    }
    restartRequest(response) {
        this.continueRequest(response);
    }
    stackTraceRequest(response) {
        if (!this.paused) return this.sendErrorResponse(response, 1, "Target is not paused");
        response.body = {
            stackFrames: [
                {
                    id: this.frameId,
                    name: "main",
                    source: this.location?.source,
                    line: this.location?.line || 1,
                    column: 1,
                    instructionPointerReference: this.location?.instructionReference || "0x08000100"
                }
            ],
            totalFrames: 1
        };
        this.sendResponse(response);
    }
    scopesRequest(response, args) {
        if (!this.paused || args.frameId !== this.frameId)
            return this.sendErrorResponse(response, 1, "Stale stack frame");
        response.body = { scopes: [{ name: "Locals", variablesReference: this.frameId * 10, expensive: false }] };
        this.sendResponse(response);
    }
    variablesRequest(response, args) {
        if (!this.paused || args.variablesReference !== this.frameId * 10)
            return this.sendErrorResponse(response, 1, "Stale variable reference");
        response.body = {
            variables: [{ name: "counter", value: String(this.counter), type: "u32", variablesReference: 0 }]
        };
        this.sendResponse(response);
    }
    nextRequest(response) {
        if (!this.paused) return this.sendErrorResponse(response, 1, "Target is not paused");
        this.paused = false;
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(1, true));
        this.breakpointTimer = setTimeout(() => {
            this.counter++;
            this._stop("step", { ...this.location, line: (this.location?.line || 1) + 1 });
        }, 30);
    }
    stepInRequest(response) {
        this.nextRequest(response);
    }
    stepOutRequest(response) {
        this.nextRequest(response);
    }
    evaluateRequest(response, args) {
        if (args.expression === "info reg" && this.paused) {
            response.body = {
                result: "PC/R15: 0x08000100 SP/R13: 0x20001000 LR/R14: 0xfffffff9",
                variablesReference: 0
            };
            this.sendResponse(response);
        } else this.sendErrorResponse(response, 1, "Target is not paused");
    }
    readMemoryRequest(response, args) {
        const address = Number(args.memoryReference);
        const data = Buffer.alloc(args.count);
        if (address === 0xe000ed00) data.writeUInt32LE(0x410fc241);
        else if (address === 0xe000edf0) data.writeUInt32LE(this.paused ? 0x20000 : 0);
        else for (let i = 0; i < data.length; i++) data[i] = this.memory.get(address + i) || 0;
        response.body = { address: args.memoryReference, data: data.toString("base64") };
        if (this.readDelayMs) setTimeout(() => this.sendResponse(response), this.readDelayMs);
        else this.sendResponse(response);
    }
    writeMemoryRequest(response, args) {
        const address = Number(args.memoryReference);
        const data = Buffer.from(args.data, "base64");
        for (let i = 0; i < data.length; i++) this.memory.set(address + i, data[i]);
        response.body = { bytesWritten: data.length };
        this.sendResponse(response);
    }
    disconnectRequest(response) {
        clearTimeout(this.breakpointTimer);
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
        setTimeout(() => process.exit(0), 20);
    }
}

DebugSession.run(FixtureProbeRsAdapter);
