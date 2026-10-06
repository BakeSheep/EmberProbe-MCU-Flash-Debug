"use strict";

// Real ARM GDB against an in-memory target; never opens hardware.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { EmberDebugSession } = require("../../src/debug/session");
const { RspMemory } = require("./rsp-memory");

(async () => {
    const output = path.resolve(__dirname, "../../test-results");
    fs.mkdirSync(output, { recursive: true });
    const root = fs.mkdtempSync(path.join(output, "external-native-"));
    const executable = path.join(root, "app.elf");
    execFileSync(
        process.env.IMAGE_CXX || "arm-none-eabi-g++",
        [
            "-g",
            "-O0",
            "-mcpu=cortex-m4",
            "-mthumb",
            "-nostdlib",
            "-Wl,-Ttext=0x08000000,-Tdata=0x20000000,-e,imageCheckpoint",
            path.resolve(__dirname, "../fixtures/images-primary.cpp"),
            "-o",
            executable
        ],
        { windowsHide: true }
    );
    const target = new RspMemory();
    const reply = target.reply.bind(target);
    target.reply = (packet) => (packet.startsWith("qRcmd,") ? "E01" : reply(packet));
    const gdbTarget = await target.start();
    try {
        // Reconnect to the same externally owned server after each Stop.
        for (const mode of ["remote", "extended-remote"]) {
            const session = new EmberDebugSession();
            session.setRunAsServer(true);
            const events = [];
            session.sendEvent = (event) => events.push(event);
            try {
                const writtenBefore = target.writes.length;
                await session.handle("attach", {
                    request: "attach",
                    servertype: "external",
                    executable,
                    gdbPath: process.env.IMAGE_GDB || "arm-none-eabi-gdb",
                    gdbTarget,
                    __emberprobeExternalMode: mode,
                    prettyPrintingMode: "raw"
                });
                await session.handle("configurationDone", {});
                assert(events.some((event) => event.event === "stopped" && event.body.threadId === 1));
                assert.strictEqual(target.writes.length, writtenBefore, "attach never downloads firmware");
                assert.strictEqual((await session.handle("threads", {})).threads.length, 1);
                await session.handle("writeMemory", { memoryReference: "0x20000000", data: "AQIDBA==" });
                const bytes = await session.handle("readMemory", { memoryReference: "0x20000000", count: 4 });
                assert.strictEqual(bytes.data, "AQIDBA==");
                await assert.rejects(session.handle("restart", {}), /unsupported/);
                await session.handle("disconnect", {});
                assert(events.some((event) => event.event === "emberprobe.externalGdbProcess" && event.body.exited));
                assert(target.server.listening, "Stop must leave the external server alive");
                assert(
                    !target.packets.some((packet) => /^(?:qRcmd,|k$|vKill|D(?:;|$))/.test(packet)),
                    "no monitor, target kill or detach packet"
                );
            } finally {
                await session.close();
            }
        }
        console.log("Real ARM GDB external remote/extended-remote attach, memory, disconnect and reconnect passed");
    } finally {
        await target.stop();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
