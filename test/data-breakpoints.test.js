"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { DebugDataBreakpoints } = require("../src/debug/dataBreakpoints");
const { scenario } = require("./helpers/scenario");

class WatchMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.watchpoints = new Map();
        this.next = 10;
        this.width = 4;
        this.address = "0x20000000";
        this.path = "counter";
        this.type = "hw watchpoint";
        this.deleteFailures = new Set();
    }
    async command(command) {
        this.commands.push(command);
        if (this.hook) await this.hook(command);
        if (command === "-gdb-show may-call-functions") return { value: this.callSetting || "on" };
        if (command.startsWith("-gdb-set may-call-functions")) this.callSetting = command.split(" ").at(-1);
        if (command.startsWith("-var-info-path-expression")) return { path_expr: this.path };
        if (command.startsWith("-data-evaluate-expression"))
            return { value: command.includes("sizeof(") ? String(this.width) : this.address };
        if (command.startsWith("-break-watch")) {
            if (this.watchError) throw new Error(this.watchError);
            const number = String(this.next++);
            const key = command.includes(" -r ") ? "hw-rwpt" : command.includes(" -a ") ? "hw-awpt" : "wpt";
            const bkpt = { number, exp: "fixed storage", type: this.type, enabled: "y" };
            this.watchpoints.set(number, bkpt);
            return { [key]: this.explicitType ? { ...bkpt } : { number, exp: bkpt.exp } };
        }
        if (command.startsWith("-break-info")) {
            if (this.infoError) throw new Error(this.infoError);
            const number = command.split(" ")[1];
            return { BreakpointTable: { body: [{ bkpt: { ...this.watchpoints.get(number) } }] } };
        }
        if (command.startsWith("-break-delete")) {
            const number = command.split(" ")[1];
            if (this.deleteFailures.has(number)) throw new Error("delete denied");
            this.watchpoints.delete(number);
        }
        if (command.startsWith("-break-disable")) {
            if (this.disableError) throw new Error(this.disableError);
            this.watchpoints.get(command.split(" ")[1]).enabled = "n";
        }
        if (command.startsWith("-break-condition") && this.conditionError) throw new Error(this.conditionError);
        return {};
    }
}

function setup() {
    const mi = new WatchMi();
    const session = new EmberDebugSession({ mi });
    session.setRunAsServer(true);
    session.ready = true;
    session.lang = "en";
    session.thread = 1;
    session.config.prettyPrintingMode = "raw";
    session.config.effectivePrettyPrintingMode = "raw";
    const events = [];
    session.sendEvent = (event) => events.push(event);
    const manager = new DebugDataBreakpoints(session);
    session.dataBreakpoints = manager;
    const frame = { kind: "frame", thread: 1, level: 0 };
    const frameId = session.handleFor(frame);
    const scope = { kind: "scope", scopeKind: "locals", frame, frameId };
    const reference = session.handleFor(scope);
    const node = session.variableStore.root(
        { name: "var1", exp: "counter", type: "int", value: "1", numchild: "0" },
        frame
    );
    session.variableStore.remember(reference, "counter", node);
    const args = { variablesReference: reference, name: "counter" };
    return { mi, session, manager, events, frame, frameId, reference, scope, node, args };
}

const bp = (dataId, accessType = "write", condition = "") => ({ dataId, accessType, condition });
const watchCommands = (mi) => mi.commands.filter((command) => command.startsWith("-break-watch"));

(async () => {
    await scenario("stable variable identity, frame binding, metadata and actual sizeof", async () => {
        const { mi, manager, node, args } = setup();
        const first = await manager.info(args);
        assert(first.dataId);
        assert.deepStrictEqual(first.accessTypes, ["write", "read", "readWrite"]);
        assert.strictEqual(first.canPersist, false);
        assert.match(first.description, /fixed storage at 0x20000000, 4 bytes/);
        assert.strictEqual(node.memoryReference, "0x20000000");
        assert.strictEqual(mi.callSetting, "on");
        assert(
            mi.commands.indexOf("-gdb-set may-call-functions off") <
                mi.commands.indexOf('-data-evaluate-expression "(unsigned long long)&(counter)"')
        );
        assert(mi.commands.includes('-var-info-path-expression "var1"'));
        assert(mi.commands.includes('-data-evaluate-expression "sizeof(counter)"'));
        assert(mi.commands.includes('-data-evaluate-expression "(unsigned long long)&(counter)"'));
        assert(
            mi.commands.indexOf("-thread-select 1") < mi.commands.indexOf('-data-evaluate-expression "sizeof(counter)"')
        );
        assert.strictEqual((await manager.info(args)).dataId, first.dataId);
    });
    await scenario("watchpoint info refreshes cached addresses after storage moves while paused", async () => {
        const { mi, manager, node, args } = setup();
        node.metadataReady = true;
        node.memoryReference = "0x20001000";
        const first = await manager.info(args);
        assert(first.dataId);
        assert.strictEqual(node.memoryReference, "0x20000000");
        mi.address = "0x20002000";
        const moved = await manager.info(args);
        assert(moved.dataId);
        assert.notStrictEqual(moved.dataId, first.dataId);
        await manager.set({ breakpoints: [bp(moved.dataId)] });
        assert(watchCommands(mi).at(-1).includes("0x20002000"));
    });
    await scenario("page mappings resolve the same live node and never fall back by display name", async () => {
        const { session, manager, node, args, scope } = setup();
        const page = session.handleFor({ kind: "page", parent: scope, frame: scope.frame });
        session.variableStore.remember(page, "counter", node);
        const first = await manager.info({ ...args, variablesReference: page });
        assert(first.dataId);
        session.variableStore.nodes.delete(node.item.name);
        assert.strictEqual((await manager.info(args)).dataId, null);
        assert.strictEqual((await manager.info({ ...args, variablesReference: page })).dataId, null);
    });
    await scenario("unavailable, ambiguous, printer and register identities are rejected", async () => {
        for (const mutate of [
            ({ session, reference }) => session.variablesByName.get(reference).set("counter", null),
            ({ session, reference }) => session.variablesByName.get(reference).delete("counter"),
            ({ node }) => {
                node.unavailable = "optimized out";
            },
            ({ node }) => {
                node.stl = { summary: "synthetic" };
            },
            ({ node }) => {
                node.locked = true;
            },
            ({ node }) => {
                node.item.in_scope = "invalid";
            },
            ({ scope }) => {
                scope.scopeKind = "registers";
            },
            ({ node }) => {
                node.expression = "$r0";
            }
        ]) {
            const context = setup();
            mutate(context);
            assert.strictEqual((await context.manager.info(context.args)).dataId, null);
            assert.strictEqual(watchCommands(context.mi).length, 0);
        }
    });
    await scenario("size and alignment are measured, bitfield address failure stays unavailable", async () => {
        for (const [width, address] of [
            [8, "0x20000000"],
            [3, "0x20000000"],
            [4, "0x20000002"],
            [2, "0"],
            [1, "<optimized out>"]
        ]) {
            const { mi, manager, args } = setup();
            mi.width = width;
            mi.address = address;
            assert.strictEqual((await manager.info(args)).dataId, null);
        }
        const { mi, manager, args } = setup();
        mi.hook = (command) => {
            if (command.includes("&(counter)")) throw new Error("Attempt to take address of bit-field");
        };
        assert.strictEqual((await manager.info(args)).dataId, null);
    });
    await scenario("expression-only lookup is safe and explicitly global unless frameId is supplied", async () => {
        const { mi, session, manager, frameId } = setup();
        session.selectedFrame = { thread: 2, level: 7 };
        assert((await manager.info({ name: "counter" })).dataId);
        assert(mi.commands.includes('-data-evaluate-expression "sizeof(::counter)"'));
        assert(mi.commands.includes('-data-evaluate-expression "(unsigned long long)&(::counter)"'));
        assert((await manager.info({ name: "counter", frameId })).dataId);
        assert(mi.commands.includes('-data-evaluate-expression "sizeof(counter)"'));
        for (const name of [
            "danger()",
            "(*fn)()",
            "counter++",
            "counter = 1",
            "$r0",
            "a[function()]",
            "a[other]",
            "x\ny"
        ])
            assert.strictEqual((await manager.info({ name })).dataId, null, name);
    });
    await scenario("resume and task invalidation during metadata or sizing never issue an ID", async () => {
        for (const prefix of [
            "-var-info-path-expression",
            '-data-evaluate-expression "sizeof',
            '-data-evaluate-expression "(unsigned'
        ]) {
            const { mi, session, manager, args } = setup();
            mi.hook = (command) => {
                if (command.startsWith(prefix)) session.onRecord({ kind: "*", class: "running", data: {} });
            };
            assert.strictEqual((await manager.info(args)).dataId, null, prefix);
            assert.strictEqual(manager.issued.size, 0);
        }
        const { mi, session, manager, args } = setup();
        session.config.servertype = "external";
        mi.hook = (command) => {
            if (command.includes("sizeof")) session.variableStore.invalidateThread(1);
        };
        assert.strictEqual((await manager.info(args)).dataId, null);
    });
    await scenario("all access types use fixed typed storage and share the session ID counter", async () => {
        for (const [width, type] of [
            [1, "unsigned char"],
            [2, "unsigned short"],
            [4, "unsigned int"]
        ]) {
            const { mi, session, manager, args } = setup();
            mi.width = width;
            const { dataId } = await manager.info(args);
            session.nextBreakpoint = 42;
            const result = await manager.set({
                breakpoints: [bp(dataId), bp(dataId, "read"), bp(dataId, "readWrite")]
            });
            assert.deepStrictEqual(
                result.breakpoints.map((item) => item.verified),
                [true, true, true]
            );
            assert.deepStrictEqual(
                result.breakpoints.map((item) => item.id),
                [42, 43, 44]
            );
            assert.deepStrictEqual(watchCommands(mi), [
                `-break-watch "*((${type} *)0x20000000)"`,
                `-break-watch -r "*((${type} *)0x20000000)"`,
                `-break-watch -a "*((${type} *)0x20000000)"`
            ]);
            assert(mi.commands.includes("-break-info 10"));
            assert.strictEqual(manager.size, 3);
        }
    });
    await scenario("software fallback is deleted before the operation returns", async () => {
        const { mi, manager, args } = setup();
        const { dataId } = await manager.info(args);
        mi.type = "watchpoint";
        const result = await manager.set({ breakpoints: [bp(dataId)] });
        assert.strictEqual(result.breakpoints[0].verified, false);
        assert.match(result.breakpoints[0].message, /Software watchpoints are not supported/);
        assert(mi.commands.includes("-break-delete 10"));
        assert.strictEqual(mi.watchpoints.size, 0);
        assert.strictEqual(manager.size, 0);
        assert.strictEqual(manager.unsafe, false);
    });
    await scenario(
        "failed software cleanup disables and retains ownership; double failure blocks execution",
        async () => {
            for (const disableFails of [false, true]) {
                const { mi, manager, args } = setup();
                const { dataId } = await manager.info(args);
                mi.type = "watchpoint";
                mi.deleteFailures.add("10");
                if (disableFails) mi.disableError = "disable denied";
                const result = await manager.set({ breakpoints: [bp(dataId)] });
                assert.strictEqual(result.breakpoints[0].verified, false);
                assert.match(result.breakpoints[0].message, /delete denied/);
                assert(mi.commands.includes("-break-disable 10"));
                assert.strictEqual(manager.size, 1);
                assert.strictEqual(manager.unsafe, disableFails);
                manager.onRecord({ kind: "=", class: "breakpoint-deleted", data: { id: "10" } });
                assert.strictEqual(manager.unsafe, false);
            }
        }
    );
    await scenario("replacement preserves unchanged IDs, conditions, duplicates and no-op commands", async () => {
        const { mi, manager, args } = setup();
        const { dataId } = await manager.info(args);
        const request = bp(dataId, "write", "counter > 2");
        const first = await manager.set({ breakpoints: [request, request] });
        assert.deepStrictEqual(first.breakpoints[0], first.breakpoints[1]);
        assert(mi.commands.includes('-break-condition 10 "counter > 2"'));
        const count = mi.commands.length;
        assert.deepStrictEqual(await manager.set({ breakpoints: [request] }), { breakpoints: [first.breakpoints[0]] });
        assert.strictEqual(mi.commands.length, count);
        const replacement = await manager.set({ breakpoints: [bp(dataId, "read")] });
        assert(replacement.breakpoints[0].verified);
        assert(mi.commands.includes("-break-delete 10"));
        assert.notStrictEqual(replacement.breakpoints[0].id, first.breakpoints[0].id);
        mi.watchpoints.set("999", { number: "999", type: "hw watchpoint" });
        assert.deepStrictEqual(await manager.set({ breakpoints: [] }), { breakpoints: [] });
        assert.strictEqual(manager.size, 0);
        assert(mi.watchpoints.has("999"), "unowned CLI/source breakpoints are untouched");
    });
    await scenario(
        "partial command and condition failures retain valid successes and original GDB diagnostics",
        async () => {
            const { mi, manager, args } = setup();
            const { dataId } = await manager.info(args);
            mi.hook = (command) => {
                if (command.startsWith("-break-watch -r")) throw new Error("Target has no free hardware watchpoints");
            };
            const result = await manager.set({
                breakpoints: [bp(dataId), bp(dataId, "read"), bp(dataId, "readWrite")]
            });
            assert.deepStrictEqual(
                result.breakpoints.map((item) => item.verified),
                [true, false, true]
            );
            assert.match(result.breakpoints[1].message, /no free hardware watchpoints/);
            assert.match(result.breakpoints[1].message, /resources/);
            mi.conditionError = "bad expression";
            const condition = await manager.set({ breakpoints: [bp(dataId, "write", "broken")] });
            assert.strictEqual(condition.breakpoints[0].verified, false);
            assert.match(condition.breakpoints[0].message, /bad expression/);
            assert.strictEqual(manager.size, 0);
        }
    );
    await scenario("deletion failures stay owned and are retried without lying about removal", async () => {
        const { mi, manager, args, events } = setup();
        const { dataId } = await manager.info(args);
        await manager.set({ breakpoints: [bp(dataId)] });
        mi.deleteFailures.add("10");
        await assert.rejects(manager.set({ breakpoints: [] }), /delete denied/);
        assert.strictEqual(manager.size, 1);
        assert(events.some((event) => event.event === "output" && /delete denied/.test(event.body.output)));
        mi.deleteFailures.clear();
        await manager.set({ breakpoints: [] });
        assert.strictEqual(manager.size, 0);
    });
    await scenario("running changes resume only after an internal SIGINT, never a real stop", async () => {
        for (const realStop of [false, true]) {
            const { session, manager, args, mi } = setup();
            const { dataId } = await manager.info(args);
            await manager.set({ breakpoints: [bp(dataId)] });
            session.running = true;
            session.interrupt = async () => {
                session.running = false;
                session.internalStop.interrupted = !realStop;
            };
            const execution = [];
            session.execute = async (command) => {
                execution.push(command);
            };
            await manager.set({ breakpoints: [bp(dataId, "read")] });
            assert.deepStrictEqual(execution, realStop ? [] : ["-exec-continue"]);
            assert.strictEqual(session.internalStop, null);
            assert(watchCommands(mi).some((command) => command.startsWith("-break-watch -r")));
        }
    });
    await scenario("late hardware insertion failures are surfaced and never silently lose ownership", async () => {
        const { mi, session, manager, args, events } = setup();
        const { dataId } = await manager.info(args);
        await manager.set({ breakpoints: [bp(dataId)] });
        session.running = true;
        session.interrupt = async () => {
            session.running = false;
            session.internalStop.interrupted = true;
        };
        session.execute = async () => {
            throw new Error("Could not insert hardware watchpoint 11");
        };
        await assert.rejects(manager.set({ breakpoints: [bp(dataId, "read")] }), /Could not insert/);
        assert.strictEqual(manager.size, 1);
        assert.strictEqual(session.internalStop, null);
        assert.strictEqual(events.at(-1).body.breakpoint.verified, false);
        assert.match(events.at(-1).body.breakpoint.message, /Could not insert hardware watchpoint 11/);
        assert(mi.watchpoints.has("11"));
    });
    await scenario("software fallback surviving delete and disable prevents automatic continue", async () => {
        const { mi, session, manager, args } = setup();
        const { dataId } = await manager.info(args);
        await manager.set({ breakpoints: [bp(dataId)] });
        session.running = true;
        session.interrupt = async () => {
            session.running = false;
            session.internalStop.interrupted = true;
        };
        session.execute = async () => {
            assert.fail("unsafe software watchpoint must not run");
        };
        mi.type = "watchpoint";
        mi.explicitType = true;
        mi.deleteFailures.add("11");
        mi.disableError = "disable denied";
        const result = await manager.set({ breakpoints: [bp(dataId, "read")] });
        assert.strictEqual(result.breakpoints[0].verified, false);
        assert.strictEqual(manager.unsafe, true);
        manager.reconcile(new Map([["11", { number: "11", type: "watchpoint", enabled: "n" }]]));
        assert.strictEqual(manager.unsafe, false);
    });
    await scenario("unknown implementation and condition removal are reconciled conservatively", async () => {
        const first = setup();
        const issued = await first.manager.info(first.args);
        first.mi.infoError = "cannot query watchpoint type";
        const unconfirmed = await first.manager.set({ breakpoints: [bp(issued.dataId)] });
        assert.strictEqual(unconfirmed.breakpoints[0].verified, false);
        assert(first.mi.commands.includes("-break-delete 10"));
        assert.strictEqual(first.manager.size, 0);
        const { manager, args, events } = setup();
        const { dataId } = await manager.info(args);
        await manager.set({ breakpoints: [bp(dataId, "write", "counter > 2")] });
        manager.reconcile(new Map([["10", { number: "10", type: "hw watchpoint", enabled: "y" }]]));
        assert.strictEqual(
            events.at(-1).body.breakpoint.verified,
            false,
            "CLI condition removal changes the requested behavior"
        );
        manager.onRecord({
            kind: "=",
            class: "breakpoint-modified",
            data: { bkpt: { number: "10", type: "hw watchpoint", cond: "counter > 2" } }
        });
        assert.strictEqual(events.at(-1).body.breakpoint.verified, true);
    });
    await scenario(
        "new scoped IDs expire after resume; activated fixed storage survives stops and disable",
        async () => {
            const first = setup();
            const fresh = await first.manager.info(first.args);
            first.session.executionEpoch++;
            assert.strictEqual(
                (await first.manager.set({ breakpoints: [bp(fresh.dataId)] })).breakpoints[0].verified,
                false
            );
            assert.strictEqual(watchCommands(first.mi).length, 0);
            const { session, manager, args, mi } = setup();
            const { dataId } = await manager.info(args);
            const original = await manager.set({ breakpoints: [bp(dataId)] });
            session.executionEpoch++;
            session.variableStore.reset();
            const count = mi.commands.length;
            assert.deepStrictEqual(await manager.set({ breakpoints: [bp(dataId)] }), original);
            assert.strictEqual(mi.commands.length, count);
            await manager.set({ breakpoints: [] });
            assert((await manager.set({ breakpoints: [bp(dataId)] })).breakpoints[0].verified);
            assert.strictEqual(watchCommands(mi).length, 2);
            assert(watchCommands(mi).every((command) => command.includes("0x20000000")));
        }
    );
    await scenario("invalid requests are bounded, reject controls and return per-item failures", async () => {
        const { manager, args } = setup();
        const { dataId } = await manager.info(args);
        await assert.rejects(manager.set({ breakpoints: {} }), /Invalid/);
        await assert.rejects(manager.set({ breakpoints: null }), /Invalid/);
        await assert.rejects(manager.set(undefined), /Invalid/);
        await assert.rejects(manager.set({ breakpoints: Array(1025).fill(bp(dataId)) }), /Invalid/);
        for (const request of [
            null,
            bp("foreign"),
            bp(dataId, "execute"),
            { ...bp(dataId), hitCondition: "3" },
            bp(dataId, "write", "x\ny"),
            bp(dataId, "write", "x".repeat(1025))
        ]) {
            const result = await manager.set({ breakpoints: [request] });
            assert.strictEqual(result.breakpoints[0].verified, false);
        }
        assert.strictEqual((await manager.info({ ...args, variablesReference: -1 })).dataId, null);
        assert.strictEqual((await manager.info({ ...args, name: "x".repeat(1025) })).dataId, null);
        manager.clear();
        assert.strictEqual((await manager.set({ breakpoints: [bp(dataId)] })).breakpoints[0].verified, false);
    });
    await scenario("watchpoint hits map only owned IDs and localize old/new and read values", async () => {
        const { manager, session, args } = setup();
        const { dataId } = await manager.info(args);
        const result = await manager.set({ breakpoints: [bp(dataId)] });
        assert.strictEqual(manager.stop({ reason: "breakpoint-hit", bkptno: "10" }), null);
        const stop = manager.stop({
            reason: "watchpoint-trigger",
            wpt: { number: "10" },
            value: { old: "1", new: "2" }
        });
        assert.strictEqual(stop.reason, "data breakpoint");
        assert.deepStrictEqual(stop.hitBreakpointIds, [result.breakpoints[0].id]);
        assert.strictEqual(stop.text, "Old value: 1; new value: 2");
        assert.match(stop.description, /counter/);
        session.lang = "zh";
        assert.match(
            manager.stop({
                reason: "access-watchpoint-trigger",
                "hw-awpt": { number: "10" },
                value: { old: "1", new: "2" }
            }).text,
            /原值：1；新值：2/
        );
        assert.match(
            manager.stop({ reason: "read-watchpoint-trigger", "hw-rwpt": { number: "999" }, value: { value: "4" } })
                .text,
            /当前值：4/
        );
        assert.strictEqual(
            manager.stop({ reason: "watchpoint-trigger", wpt: { number: "999" } }).hitBreakpointIds,
            undefined
        );
    });
    await scenario("CLI modifications and break-list reconciliation synchronize owned watchpoints", async () => {
        const { manager, args, events } = setup();
        const { dataId } = await manager.info(args);
        await manager.set({ breakpoints: [bp(dataId)] });
        manager.onRecord({
            kind: "=",
            class: "breakpoint-modified",
            data: { bkpt: { number: "10", type: "hw watchpoint", enabled: "n" } }
        });
        assert.strictEqual(events.at(-1).body.breakpoint.verified, false);
        assert.match(events.at(-1).body.breakpoint.message, /GDB changed or disabled/);
        manager.reconcile(
            new Map([
                ["10", { number: "10", type: "hw watchpoint", enabled: "y" }],
                ["999", { number: "999" }]
            ])
        );
        assert.strictEqual(events.at(-1).body.breakpoint.verified, true);
        manager.executionFailed(new Error("Could not insert hardware watchpoint 10"));
        assert.strictEqual(events.at(-1).body.breakpoint.verified, false);
        assert.match(events.at(-1).body.breakpoint.message, /Could not insert hardware watchpoint 10/);
        manager.reconcile(new Map([["10", { number: "10", type: "hw watchpoint", enabled: "y" }]]));
        assert.strictEqual(events.at(-1).body.breakpoint.verified, false);
        manager.reconcile(new Map());
        assert.strictEqual(manager.size, 0);
        assert.strictEqual(events.at(-1).body.reason, "removed");
        await manager.set({ breakpoints: [bp(dataId)] });
        manager.onRecord({ kind: "=", class: "breakpoint-deleted", data: { id: "11" } });
        assert.strictEqual(manager.size, 0);
    });
    await scenario("identity issuance is bounded without evicting already issued addresses", async () => {
        const { mi, manager } = setup();
        let first;
        for (let index = 0; index < 1024; index++) {
            mi.address = `0x${(0x20000000 + index * 4).toString(16)}`;
            const result = await manager.info({ name: "counter" });
            assert(result.dataId);
            first ||= result.dataId;
        }
        mi.address = "0x20010000";
        assert.strictEqual((await manager.info({ name: "counter" })).dataId, null);
        assert((await manager.set({ breakpoints: [bp(first)] })).breakpoints[0].verified);
        manager.clear();
        assert.strictEqual(manager.size, 0);
        assert.strictEqual(manager.issued.size, 0);
    });
    console.log("data breakpoint tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
