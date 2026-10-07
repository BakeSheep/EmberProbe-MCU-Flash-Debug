"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { MiClient } = require("../src/debug/mi");
const { EmberDebugSession } = require("../src/debug/session");

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Exercise the real MI parser and pending-command map, controlling record delivery independently.
function setup(reply = () => "^done") {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => {};
    const commands = [];
    const feed = (line) => child.stdout.emit("data", Buffer.from(line + "\n"));
    child.stdin.write = (line, callback) => {
        const [, token, command] = /^(\d+)([^\n]+)/.exec(line);
        commands.push(command);
        const result = command === "-gdb-exit" ? "^exit" : reply(command, token, feed);
        if (result) queueMicrotask(() => feed(token + result));
        callback?.();
    };
    const mi = new MiClient({ spawn: () => child });
    mi.start("fake-gdb", __dirname);
    const session = new EmberDebugSession({ mi });
    session.setRunAsServer(true);
    session.ready = true;
    session.threads.add(1);
    const responses = [];
    const events = [];
    session.sendResponse = (response) => responses.push(response);
    session.sendErrorResponse = (response, error) => responses.push({ ...response, success: false, error });
    session.sendEvent = (event) => events.push(event);
    session.shutdown = () => {};
    return { session, mi, commands, responses, events, feed };
}

const request = (session, seq, command, args = {}) => session.dispatchRequest({ seq, command, arguments: args });
const stopped = '*stopped,reason="breakpoint-hit",thread-id="1"';
const running = '*running,thread-id="all"';

(async () => {
    for (const operation of ["continue", "next", "stepIn", "stepOut", "configurationDone", "restart"]) {
        const fixture = setup((command) => {
            if (command.startsWith("-break-insert")) return '^done,bkpt={number="1"}';
            return command.startsWith("-exec-") ? "^running" : "^done";
        });
        const { session, commands, responses, feed } = fixture;
        session.config.runToEntryPoint = "main";
        const frame = session.handleFor({ kind: "frame", thread: 1, level: 0 });
        try {
            request(session, 1, operation, { threadId: 1 });
            await session.queue;
            assert.strictEqual(session.running, true, `${operation} cannot wait for *running`);
            assert(!session.handles.has(frame), "execution invalidates stopped references immediately");
            request(session, 2, "stackTrace", { threadId: 1 });
            await session.queue;
            assert(!commands.some((command) => command.startsWith("-stack-list-frames")));
            assert.strictEqual(responses.find((response) => response.request_seq === 2).error.showUser, false);
            feed(running);
            feed(stopped);
            assert.strictEqual(session.running, false);
        } finally {
            await session.close();
        }
    }

    for (const stateEvent of [null, running, stopped]) {
        const { session, responses } = setup((command, token, feed) => {
            if (command === "-exec-continue") {
                if (stateEvent) feed(stateEvent);
                return '^error,msg="Execution refused"';
            }
            return "^done";
        });
        try {
            request(session, 1, "continue", { threadId: 1 });
            await session.queue;
            assert.strictEqual(session.running, stateEvent === running, "failure cannot overwrite a newer GDB state");
            assert.strictEqual(responses[0].error.format, "Execution refused");
            assert.strictEqual(responses[0].error.showUser, true, "real execution errors still surface");
        } finally {
            await session.close();
        }
    }

    {
        const { session } = setup((command, token, feed) => {
            if (command === "-exec-continue") {
                feed(running);
                feed(stopped);
                return "^running";
            }
            return "^done";
        });
        try {
            await session.handle("continue", { threadId: 1 });
            assert.strictEqual(session.running, false, "a fast stop before the MI result must remain stopped");
        } finally {
            await session.close();
        }
    }

    {
        let continueToken;
        const { session, feed, commands, responses } = setup((command, token, send) => {
            if (command === "-exec-continue") {
                continueToken = token;
                return null;
            }
            if (command === "-exec-interrupt --all") send(stopped);
            return "^done";
        });
        try {
            request(session, 1, "continue", { threadId: 1 });
            await tick();
            request(session, 2, "pause");
            assert(commands.includes("-exec-interrupt --all"), "pause must interrupt a pending continue");
            feed(continueToken + "^running");
            await session.queue;
            assert.strictEqual(session.running, false);
            assert(responses.every((response) => response.success));
        } finally {
            await session.close();
        }
    }

    {
        const { session, commands } = setup((command) => {
            if (command === "-stack-list-frames 0 19") {
                const frames = Array.from(
                    { length: 20 },
                    (_, level) => `frame={level="${level}",addr="0x08000100",func="f${level}"}`
                );
                return `^done,stack=[${frames.join(",")}]`;
            }
            if (command.startsWith("-stack-list-frames"))
                return '^error,msg="-stack-list-frames: Not enough frames in stack."';
            if (command.startsWith("-stack-info-depth")) return '^done,depth="20"';
            return "^done";
        });
        try {
            const page = await session.handle("stackTrace", { threadId: 1, levels: 20 });
            assert.strictEqual(page.stackFrames.length, 20);
            assert(!Object.hasOwn(page, "totalFrames"));
            assert.deepStrictEqual(await session.handle("stackTrace", { threadId: 1, startFrame: 20, levels: 20 }), {
                stackFrames: [],
                totalFrames: 20
            });
            assert(commands.includes("-stack-info-depth 21"));
        } finally {
            await session.close();
        }
    }

    for (const depth of ["1", "1000", "invalid", "", "-1", "2000"]) {
        const { session, commands } = setup((command) => {
            if (command.startsWith("-stack-list-frames"))
                return '^error,msg="-stack-list-frames: Not enough frames in stack."';
            if (command.startsWith("-stack-info-depth")) return `^done,depth="${depth}"`;
            return "^done";
        });
        try {
            const page = session.handle("stackTrace", { threadId: 1, startFrame: 2000 });
            if (depth === "1") assert.deepStrictEqual(await page, { stackFrames: [], totalFrames: 1 });
            else await assert.rejects(page, /Not enough frames/);
            assert(commands.includes("-stack-info-depth 1000"), "depth confirmation stays bounded");
        } finally {
            await session.close();
        }
    }

    for (const message of ["-stack-list-frames: Not enough frames in stack.", "Cannot read stack memory"]) {
        const { session, responses, commands } = setup((command) =>
            command.startsWith("-stack-list-frames") ? `^error,msg="${message}"` : "^done"
        );
        try {
            request(session, 1, "stackTrace", { threadId: 1 });
            await session.queue;
            assert.strictEqual(responses[0].error.showUser, true, "initial-stack and genuine failures remain visible");
            assert(!commands.some((command) => command.startsWith("-stack-info-depth")));
        } finally {
            await session.close();
        }
    }

    for (const stateEvents of [[running, stopped], [stopped]]) {
        const { session, responses } = setup((command, token, feed) => {
            if (command.startsWith("-stack-list-frames"))
                return '^error,msg="-stack-list-frames: Not enough frames in stack."';
            if (command.startsWith("-stack-info-depth")) {
                for (const event of stateEvents) feed(event);
                return '^done,depth="1"';
            }
            return "^done";
        });
        try {
            request(session, 1, "stackTrace", { threadId: 1, startFrame: 1 });
            await session.queue;
            assert.strictEqual(responses[0].success, false, "never return a page from a newer stop");
            assert.strictEqual(responses[0].error.showUser, false);
        } finally {
            await session.close();
        }
    }

    for (const terminate of ["disconnect", "terminate"]) {
        for (const pending of ["continue", "stackTrace"]) {
            const { session, responses, commands } = setup((command) => {
                if (command === "-exec-continue" || command.startsWith("-stack-list-frames")) return null;
                return "^done";
            });
            request(session, 1, pending, { threadId: 1 });
            await tick();
            request(session, 2, "threads");
            request(session, 3, terminate);
            request(session, 4, "readMemory", { memoryReference: "0x20000000", count: 4 });
            await session.queue;
            assert.strictEqual(responses.find((response) => response.request_seq === 3).success, true);
            for (const seq of [1, 2, 4]) {
                const response = responses.find((item) => item.request_seq === seq);
                assert.strictEqual(response.success, false);
                assert.strictEqual(response.error.showUser, false, "expected shutdown cancellation is quiet");
            }
            assert(!commands.includes("-thread-info"), "queued requests cannot access GDB during shutdown");
            assert(!commands.some((command) => command.startsWith("-data-read-memory")));
            assert.strictEqual(commands.filter((command) => command === "-gdb-exit").length, 1);
            assert.strictEqual(session.pendingRequests.size, 0, "settled requests release cancellation bookkeeping");
        }
    }

    {
        const { session, commands } = setup();
        session.config.servertype = "external";
        request(session, 1, "disconnect");
        await session.queue;
        assert.deepStrictEqual(commands, ["-target-disconnect", "-gdb-exit"], "external cleanup remains available");
    }

    {
        const { session, responses, commands } = setup();
        request(session, 1, "initialize");
        request(session, 2, "disconnect");
        await session.queue;
        const initialized = responses.find((response) => response.request_seq === 1);
        assert.strictEqual(initialized.success, true, "shutdown preserves pipelined capability negotiation");
        assert.strictEqual(initialized.body.supportsFunctionBreakpoints, true);
        assert.deepStrictEqual(commands, ["-gdb-exit"]);
    }

    console.log("Debug execution epochs, bounded stack paging and shutdown cancellation passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
