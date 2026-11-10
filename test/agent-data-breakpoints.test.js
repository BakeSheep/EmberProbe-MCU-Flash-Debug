"use strict";

const assert = require("assert");
const { AgentDataBreakpoints } = require("../src/services/agentDataBreakpoints");
const { SidebarDataBreakpoints } = require("../src/services/sidebarDataBreakpoints");
const { scenario } = require("./helpers/scenario");

// An adapter stand-in for the sidebar watchpoint group: info resolves storage, add/remove/enable change rows and
// answer with the snapshot, and every mutating request must carry the current generation.
function fixture() {
    const calls = [];
    const session = {
        id: "one",
        type: "emberprobe",
        generation: "[1,1]",
        entries: [],
        nextId: 1,
        fail: null,
        async customRequest(command, args) {
            assert.strictEqual(command, "emberprobe.sidebarDataBreakpoints");
            calls.push(args);
            if (session.hook) await session.hook(args);
            if (session.fail) throw new Error(session.fail);
            const snapshot = () => ({
                generation: session.generation,
                entries: session.entries.map((e) => ({ ...e }))
            });
            if (args.action === "list") return snapshot();
            if (args.action === "info")
                return args.name === "unaligned"
                    ? { ...snapshot(), info: { dataId: null, description: "size or alignment unsupported" } }
                    : {
                          ...snapshot(),
                          info: { dataId: `storage:${args.name}`, description: `${args.name} @ 0x20000000` }
                      };
            assert.strictEqual(args.generation, session.generation, "mutations carry the current generation");
            if (args.action === "add")
                session.entries.push({
                    id: String(session.nextId++),
                    name: args.name,
                    dataId: args.dataId,
                    accessType: args.accessType,
                    condition: args.condition,
                    enabled: true,
                    verified: true,
                    identity: "x",
                    description: args.description
                });
            else if (args.action === "remove") session.entries = session.entries.filter((e) => e.id !== args.id);
            else if (args.action === "enable") {
                const entry = session.entries.find((e) => e.id === args.id);
                entry.enabled = args.enabled;
                entry.verified = args.enabled;
            }
            return snapshot();
        }
    };
    const bridge = {
        activeSession: session,
        paused: true,
        stopEpoch: 1,
        inspectionEpoch: 1,
        transitionKind: "",
        replBusy: false,
        conflict: false,
        assertUniqueSession() {
            if (!this.activeSession) throw Object.assign(new Error("none"), { code: "DEBUG_SESSION_NOT_ACTIVE" });
            return this.activeSession;
        },
        assertPausedAccess() {
            this.assertUniqueSession();
            if (!this.paused) throw Object.assign(new Error("running"), { code: "TARGET_NOT_PAUSED" });
        }
    };
    const host = {
        _t: (key) => key,
        _elfService: { generation: 1 },
        readElfSymbols: () => ({
            symbols: [
                { name: "counter", watchType: "u32", size: 4, address: 0x20000000 },
                { name: "unaligned", watchType: "u32", size: 4, address: 0x20000001 },
                { name: "large", isComposite: true, size: 24 }
            ]
        })
    };
    const group = new SidebarDataBreakpoints({ host, bridge, vscode: {} });
    return { calls, session, bridge, host, service: new AgentDataBreakpoints({ host, bridge, group }) };
}

(async () => {
    await scenario("an added data breakpoint resolves storage first and is listed in the shared group", async () => {
        const { calls, service } = fixture();
        const added = await service.update({
            type: "data",
            action: "add",
            variable: "counter",
            access: "readWrite",
            condition: "counter > 3"
        });
        assert.deepStrictEqual(
            calls.map((call) => call.action),
            ["info", "add"]
        );
        assert.strictEqual(calls[1].dataId, "storage:counter");
        assert.deepStrictEqual(added.entries, [
            {
                id: "1",
                variable: "counter",
                access: "readWrite",
                condition: "counter > 3",
                enabled: true,
                verified: true,
                storage: "counter @ 0x20000000"
            }
        ]);
        const listed = await service.list();
        assert.strictEqual(listed.available, true);
        assert.deepStrictEqual(listed.entries, added.entries);
        // The default access is write.
        await service.update({ type: "data", action: "add", variable: "counter" });
        assert.strictEqual(calls.at(-1).accessType, "write");
    });

    await scenario("existing data breakpoints are selected by id or by variable and access", async () => {
        const { service } = fixture();
        await service.update({ type: "data", action: "add", variable: "counter", access: "write" });
        await service.update({ type: "data", action: "add", variable: "counter", access: "read" });
        await assert.rejects(service.update({ type: "data", action: "disable", variable: "counter" }), (error) => {
            assert.strictEqual(error.code, "INVALID_PARAMS");
            assert.deepStrictEqual(error.details.ids, ["1", "2"]);
            return true;
        });
        const disabled = await service.update({ type: "data", action: "disable", variable: "counter", access: "read" });
        assert.strictEqual(disabled.entries.find((entry) => entry.id === "2").enabled, false);
        const enabled = await service.update({ type: "data", action: "enable", id: "2" });
        assert.strictEqual(enabled.entries.find((entry) => entry.id === "2").enabled, true);
        const removed = await service.update({ type: "data", action: "remove", id: "1" });
        assert.deepStrictEqual(
            removed.entries.map((entry) => entry.id),
            ["2"]
        );
        await assert.rejects(service.update({ type: "data", action: "remove", id: "9" }), {
            code: "BREAKPOINT_NOT_FOUND"
        });
    });

    await scenario("data breakpoint parameters and variables are validated before reaching the adapter", async () => {
        const { calls, service } = fixture();
        for (const params of [
            null,
            [],
            { type: "data", action: "toggle", variable: "counter" },
            { type: "data", action: "add" },
            { type: "data", action: "add", variable: "counter", access: "execute" },
            { type: "data", action: "add", variable: "counter", hitCondition: "2" },
            { type: "data", action: "add", variable: "counter\n" },
            { type: "data", action: "remove" },
            { type: "data", action: "remove", id: "1", condition: "x" }
        ])
            await assert.rejects(service.update(params), (error) =>
                ["INVALID_PARAMS", "INVALID_BREAKPOINT_ACTION"].includes(error.code)
            );
        await assert.rejects(service.update({ type: "data", action: "add", variable: "large" }), {
            code: "DATA_BREAKPOINT_UNSUPPORTED"
        });
        await assert.rejects(service.update({ type: "data", action: "add", variable: "missing" }), {
            code: "DATA_BREAKPOINT_UNSUPPORTED"
        });
        assert.deepStrictEqual(calls, []);
        await assert.rejects(service.update({ type: "data", action: "add", variable: "unaligned" }), (error) => {
            assert.strictEqual(error.code, "DATA_BREAKPOINT_UNAVAILABLE");
            assert.match(error.message, /alignment/);
            return true;
        });
    });

    await scenario("changes need a paused built-in session and stop when the debugger state moves", async () => {
        const { bridge, session, service } = fixture();
        bridge.paused = false;
        await assert.rejects(service.update({ type: "data", action: "add", variable: "counter" }), {
            code: "TARGET_NOT_PAUSED"
        });
        bridge.paused = true;
        session.type = "cortex-debug";
        await assert.rejects(service.update({ type: "data", action: "add", variable: "counter" }), {
            code: "DATA_BREAKPOINT_SESSION_UNSUPPORTED"
        });
        assert.deepStrictEqual(await service.list(), { available: false, paused: false, entries: [] });
        session.type = "emberprobe";
        // A resume between resolving storage and arming it must not arm a stale watchpoint.
        session.hook = (args) => {
            if (args.action === "info") bridge.stopEpoch++;
        };
        await assert.rejects(service.update({ type: "data", action: "add", variable: "counter" }), {
            code: "DEBUG_STATE_CHANGED"
        });
        assert.deepStrictEqual(session.entries, []);
        session.hook = null;
        session.fail = "no free hardware watchpoint";
        await assert.rejects(service.update({ type: "data", action: "add", variable: "counter" }), (error) => {
            assert.strictEqual(error.code, "DATA_BREAKPOINT_FAILED");
            assert.match(error.message, /hardware watchpoint/);
            return true;
        });
        // A failed listing does not break the breakpoint list it is part of.
        const listed = await service.list();
        assert.strictEqual(listed.available, false);
        assert.match(listed.error, /hardware watchpoint/);
        bridge.activeSession = null;
        assert.deepStrictEqual(await service.list(), { available: false, paused: false, entries: [] });
        await assert.rejects(service.update({ type: "data", action: "remove", id: "1" }), {
            code: "DEBUG_SESSION_NOT_ACTIVE"
        });
    });

    console.log("Agent data breakpoint tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
