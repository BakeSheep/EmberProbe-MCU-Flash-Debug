"use strict";
const path = require("path");
const { spawn } = require("child_process");
const { EmberDebugSession } = require("../../src/debug/session");
const { MiClient } = require("../../src/debug/mi");
class FixtureSession extends EmberDebugSession {
    constructor() {
        super({
            mi: new MiClient({
                spawn: (_executable, _args, options) =>
                    spawn(process.execPath, [path.join(__dirname, "fake-gdb.js")], options)
            })
        });
    }
}
EmberDebugSession.run(FixtureSession);
