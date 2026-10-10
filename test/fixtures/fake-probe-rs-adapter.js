"use strict";

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
            supportsConfigurationDoneRequest: true
        };
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }
    attachRequest(response) {
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(1, true));
    }
    threadsRequest(response) {
        response.body = { threads: [{ id: 1, name: "Main" }] };
        this.sendResponse(response);
    }
    pauseRequest(response) {
        this.paused = true;
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent("pause", 1));
    }
    continueRequest(response) {
        this.paused = false;
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(1, true));
    }
    restartRequest(response) {
        this.continueRequest(response);
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
        this.sendResponse(response);
    }
    writeMemoryRequest(response, args) {
        const address = Number(args.memoryReference);
        const data = Buffer.from(args.data, "base64");
        for (let i = 0; i < data.length; i++) this.memory.set(address + i, data[i]);
        response.body = { bytesWritten: data.length };
        this.sendResponse(response);
    }
    disconnectRequest(response) {
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
        setTimeout(() => process.exit(0), 20);
    }
}

DebugSession.run(FixtureProbeRsAdapter);
