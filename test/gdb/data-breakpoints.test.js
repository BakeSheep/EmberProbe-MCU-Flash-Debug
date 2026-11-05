"use strict";

// Real ARM GDB against simulated RSP watchpoint stops. No board, probe or instruction execution.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { MiClient, quote } = require("../../src/debug/mi");
const { EmberDebugSession } = require("../../src/debug/session");
const { RspMemory } = require("./rsp-memory");
const { waitFor } = require("../helpers/wait");

class WatchTarget extends RspMemory {
    constructor() {
        super();
        this.watchpoints = new Map();
    }
    reply(packet) {
        const watch = /^([Zz])([234]),([\da-f]+),([\da-f]+)$/.exec(packet);
        if (watch) {
            const key = watch.slice(2).join(",");
            if (watch[1] === "Z") this.watchpoints.set(key, { type: watch[2], address: parseInt(watch[3], 16) });
            else this.watchpoints.delete(key);
            return "OK";
        }
        if (packet === "s") {
            this.registers.writeUInt32LE(this.registers.readUInt32LE(15 * 4) + 2, 15 * 4);
            return "T05thread:1;";
        }
        if (/^(?:c|vCont;c)(?:$|[:;])/.test(packet)) {
            const point = this.watchpoints.values().next().value;
            if (!point) return "T05thread:1;";
            if (point.type !== "3") this.memory.set(point.address, (this.memory.get(point.address) || 0) + 1);
            const reason = { 2: "watch", 3: "rwatch", 4: "awatch" }[point.type];
            return `T05${reason}:${point.address.toString(16)};thread:1;`;
        }
        return super.reply(packet);
    }
}

(async () => {
    const output = path.resolve(__dirname, "../../test-results");
    fs.mkdirSync(output, { recursive: true });
    const root = fs.mkdtempSync(path.join(output, "data-breakpoints-gdb-"));
    const elf = path.join(root, "watch.elf");
    const target = new WatchTarget();
    const mi = new MiClient();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    const events = [];
    adapter.sendEvent = (event) => events.push(event);
    try {
        execFileSync(
            process.env.IMAGE_CC || "arm-none-eabi-gcc",
            [
                "-g",
                "-O0",
                "-mcpu=cortex-m4",
                "-mthumb",
                "-nostdlib",
                "-Wl,-Ttext=0x08000000,-Tdata=0x20000000,-e,watchCheckpoint",
                path.resolve(__dirname, "../fixtures/data-breakpoints.c"),
                "-o",
                elf
            ],
            { windowsHide: true }
        );
        const address = await target.start();
        adapter.config = { executable: elf, cwd: root };
        adapter.lang = "en";
        mi.start(process.env.IMAGE_GDB || "arm-none-eabi-gdb", root);
        await mi.command("-gdb-set auto-load off");
        await mi.command("-gdb-set may-call-functions off");
        await mi.command(`-file-exec-and-symbols ${quote(elf)}`);
        await mi.command(`-target-select extended-remote ${address}`);
        await mi.command("-target-download");
        adapter.ready = true;
        adapter.threads.add(1);
        for (const [name, accessType, packetType] of [
            ["watchedCounter", "write", "2"],
            ["watchedByte", "read", "3"],
            ["watchedHalfword", "readWrite", "4"]
        ]) {
            const info = await adapter.handle("dataBreakpointInfo", { name });
            assert(info.dataId, info.description);
            assert.strictEqual(info.canPersist, false);
            const set = await adapter.handle("setDataBreakpoints", {
                breakpoints: [{ dataId: info.dataId, accessType }]
            });
            assert(set.breakpoints[0].verified, set.breakpoints[0].message);
            const eventStart = events.length;
            await adapter.handle("continue", { threadId: 1 });
            await waitFor(() => events.slice(eventStart).some((event) => event.event === "stopped"));
            const stop = events.slice(eventStart).find((event) => event.event === "stopped");
            assert.strictEqual(stop.body.reason, "data breakpoint");
            assert.deepStrictEqual(stop.body.hitBreakpointIds, [set.breakpoints[0].id]);
            assert(target.packets.some((packet) => packet.startsWith(`Z${packetType},`)));
            if (accessType === "write") {
                assert.match(stop.body.text, /3/);
                assert.match(stop.body.text, /4/);
            }
            await adapter.handle("setDataBreakpoints", { breakpoints: [] });
        }
        assert.strictEqual(adapter.dataBreakpoints.size, 0);
        console.log("✓ ARM GDB hardware watchpoints: native MI creation, RSP write/read/access stops and DAP hit IDs");
    } catch (error) {
        fs.writeFileSync(
            path.join(root, "diagnostics.json"),
            JSON.stringify({ events, packets: target.packets }, null, 2)
        );
        throw error;
    } finally {
        adapter.end();
        await mi.stop();
        await target.stop();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
