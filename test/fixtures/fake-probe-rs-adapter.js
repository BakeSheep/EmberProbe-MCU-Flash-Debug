"use strict";

const { DebugSession, InitializedEvent, ContinuedEvent, TerminatedEvent } = require("@vscode/debugadapter");

class FixtureProbeRsAdapter extends DebugSession {
    constructor() {
        super();
        this.memory = new Map();
    }
    initializeRequest(response) {
        response.body = {
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
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
    readMemoryRequest(response, args) {
        const address = Number(args.memoryReference);
        const data = Buffer.alloc(args.count);
        if (address === 0xe000ed00) data.writeUInt32LE(0x410fc241);
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
