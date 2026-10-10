"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { withProbeRsChipSession } = require("../src/services/probeRsChipSession");
const { controlProbeRsTarget, readProbeRsChipInfo, DHCSR_ADDR } = require("../src/services/probeRsChipInfo");

function fixture(options = {}) {
    const coordinator = new ProbeCoordinator();
    const lease = coordinator.acquire("chipInfo");
    const requests = [];
    const cliReads = [];
    let halted = options.halted === true;
    const child = Object.assign(new EventEmitter(), {
        pid: 123,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
            if (!options.keepAlive) this.emit("close", 0);
            return true;
        }
    });
    const send = (message) => {
        const body = JSON.stringify(message);
        child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    child.stdin.on("data", (data) => {
        const request = JSON.parse(data.toString().split("\r\n\r\n")[1]);
        requests.push(request);
        if (request.command === options.ignore) return;
        if (request.command === "attach") halted = true;
        if (request.command === "restart") halted = true;
        if (request.command === "continue" && !options.stuck) halted = false;
        let body = {};
        if (request.command === "readMemory") {
            const data = Buffer.alloc(request.arguments.count);
            const address = Number(request.arguments.memoryReference);
            const value = address === DHCSR_ADDR ? (halted ? 0x20000 : 0) : address === 0xe000ed00 ? 0x410fc241 : 0;
            if (data.length >= 4) data.writeUInt32LE(value);
            if (address === 0xe00fffd0) {
                [0x0b, 0, 0, 0, 0xc4, 0x34, 0x0a, 0, 0x0d, 0x10, 0x05, 0xb1].forEach((word, index) =>
                    data.writeUInt32LE(word, index * 4)
                );
            }
            body = { data: data.toString("base64") };
        }
        if (request.command === "evaluate") body = { result: "PC: 0x08000100 SP: 0x20001000 LR: 0xfffffff9" };
        if (request.command === "threads") body = { threads: [{ id: 7, name: "Core" }] };
        send({
            type: "response",
            seq: request.seq,
            request_seq: request.seq,
            command: request.command,
            success: request.command !== options.reject,
            body
        });
    });
    child.stdin.on("finish", () => {
        if (!options.keepAlive) child.emit("close", 0);
    });
    const settings = { executable: "probe-rs", chip: "STM32F407ZG", protocol: "JTAG", probe: "1366:0101:123" };
    const sessionOptions = {
        lease,
        exitTimeoutMs: 5,
        timeoutMs: options.timeoutMs ?? 1000,
        spawnProcess(executable, args, config) {
            assert.equal(executable, settings.executable);
            assert.deepEqual(args, ["dap-server"]);
            assert.equal(config.windowsHide, true);
            assert.equal(coordinator.isActive("chipInfo"), true);
            if (options.throwSpawn) throw new Error("spawn failed");
            return child;
        },
        run: async (_executable, args) => {
            cliReads.push(args);
            assert.equal(args[0], "read");
            const address = Number(args.at(-2));
            const count = Number(args.at(-1));
            if (address === 0xe000ed00) return { stdout: "e000ed00: 410fc241" };
            if (address === DHCSR_ADDR) return { stdout: `e000edf0: ${halted ? "00020000" : "00000000"}` };
            return { stdout: `${address.toString(16)}: ${Array(count).fill("0000").join(" ")}` };
        }
    };
    return {
        coordinator,
        lease,
        requests,
        cliReads,
        child,
        settings,
        sessionOptions,
        get halted() {
            return halted;
        }
    };
}

async function main() {
    await assert.rejects(
        withProbeRsChipSession({}, {}, () => {}),
        { code: "STALE_PROBE_LEASE" }
    );
    for (const action of ["pause", "continue", "reset"]) {
        const state = fixture({ halted: action === "continue" });
        const result = await controlProbeRsTarget(state.settings, action, state.sessionOptions);
        assert.equal(result.state, action === "pause" ? "halted" : "running");
        assert.equal(state.halted, action === "pause");
        assert.equal(state.coordinator.isActive("chipInfo"), true, "the borrowed lease remains owned through refresh");
        assert.ok(
            !state.requests.some(({ command }) => ["launch", "configurationDone", "writeMemory"].includes(command))
        );
        const attach = state.requests.find(({ command }) => command === "attach").arguments;
        assert.equal(attach.flashingConfig.flashingEnabled, false);
        assert.equal(attach.wireProtocol, "Jtag");
        assert.equal(attach.coreConfigs[0].catchReset, false);
        assert.equal(attach.coreConfigs[0].catchHardfault, false);
        const disconnect = state.requests.find(({ command }) => command === "disconnect").arguments;
        assert.deepEqual(disconnect, { suspendDebuggee: false, terminateDebuggee: false });
        assert.equal(
            state.requests.some(({ command }) => command === "restart"),
            action === "reset"
        );
        state.lease.release();
    }
    const halted = fixture({ halted: true });
    const info = await readProbeRsChipInfo(halted.settings, halted.sessionOptions);
    assert.equal(info.pc, "0x08000100");
    assert.equal(info.sp, "0x20001000");
    assert.equal(halted.halted, true);
    assert.ok(
        !halted.requests.some(({ command }) => ["continue", "pause", "restart", "configurationDone"].includes(command))
    );
    halted.lease.release();
    for (const [action, paused] of [
        ["pause", true],
        ["continue", false]
    ]) {
        const state = fixture({ halted: paused });
        await assert.rejects(controlProbeRsTarget(state.settings, action, state.sessionOptions), {
            code: "CHIP_CONTROL_FAILED"
        });
        assert.equal(state.requests.length, 0, "reject stale state before a DAP attach can halt the core");
        state.lease.release();
    }
    for (const options of [{ reject: "attach" }, { throwSpawn: true }, { ignore: "evaluate", timeoutMs: 15 }]) {
        const state = fixture(options);
        await assert.rejects(
            withProbeRsChipSession(state.settings, state.sessionOptions, (session) =>
                session.customRequest("evaluate", { expression: "info reg", context: "repl" })
            )
        );
        state.lease.release();
        assert.equal(state.coordinator.anyActive(), false);
    }
    const stuck = fixture({ halted: true, stuck: true });
    await assert.rejects(controlProbeRsTarget(stuck.settings, "continue", stuck.sessionOptions), {
        code: "CHIP_CONTROL_FAILED"
    });
    stuck.lease.release();
    const refreshed = fixture();
    const pausedInfo = await controlProbeRsTarget(refreshed.settings, "pause", {
        ...refreshed.sessionOptions,
        refresh: true
    });
    assert.equal(pausedInfo.state, "halted");
    assert.equal(pausedInfo.info.pc, "0x08000100");
    assert.equal(pausedInfo.info.designer, "Apex Microelectronics (Geehy)");
    assert.equal(refreshed.cliReads.length, 1, "control refresh must not open new CLI connections");
    assert.equal(refreshed.requests.filter(({ command }) => command === "attach").length, 1);
    assert.equal(refreshed.coordinator.isActive("chipInfo"), true);
    refreshed.lease.release();
    const retained = fixture({ keepAlive: true });
    await assert.rejects(
        withProbeRsChipSession(retained.settings, retained.sessionOptions, () => ({})),
        { code: "PROBE_EXIT_UNCONFIRMED" }
    );
    assert.equal(retained.coordinator.isActive("chipInfo"), true);
    retained.child.emit("close", 0);
    assert.equal(retained.coordinator.anyActive(), false, "only confirmed late process exit releases the lease");
    await assert.rejects(controlProbeRsTarget({}, "write"), { code: "CHIP_ACTION_INVALID" });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
