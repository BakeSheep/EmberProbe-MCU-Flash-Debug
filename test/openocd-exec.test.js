"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { runOpenOcdOnce } = require("../src/services/openocdExec");

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
    };
    return child;
}

function resolver(executable = "openocd") {
    return () => ({
        executable,
        scriptsRoot: "/trusted/openocd/scripts",
        cwd: "/trusted/openocd/scripts",
        probePath: "/trusted/openocd/scripts/interface/cmsis-dap.cfg",
        targetPath: "/trusted/openocd/scripts/target/stm32f4x.cfg"
    });
}

(async () => {
    // stdout/stderr 独立拆行；交错的分块和结尾残行不能互相污染。
    const lines = [];
    let capturedArgs = null;
    const child = fakeChild();
    const success = runOpenOcdOnce({
        executable: "openocd",
        probe: "cmsis-dap.cfg",
        target: "stm32f4x.cfg",
        cwd: "/tmp",
        timeoutMs: 1000,
        buildCommands: () => ["init", "shutdown"],
        resolveLaunch: resolver(),
        onLine: (line) => lines.push(line),
        spawnImpl: (_file, args) => {
            capturedArgs = args;
            process.nextTick(() => {
                child.stdout.write("\x1b[31mfirst\x1b[0m\r\npart");
                child.stderr.write("diagnostic\nerror tail");
                child.stdout.write("ial\n");
                child.stdout.write("stdout tail");
                child.emit("close", 0);
            });
            return child;
        }
    });
    const completed = await success;
    assert.deepStrictEqual(lines, ["first", "diagnostic", "partial", "stdout tail", "error tail"]);
    assert.deepStrictEqual(completed.openocdTail, lines);
    assert.strictEqual(completed.exitCode, 0);
    assert.deepStrictEqual(capturedArgs, [
        "-s",
        "/trusted/openocd/scripts",
        "-f",
        "/trusted/openocd/scripts/interface/cmsis-dap.cfg",
        "-f",
        "/trusted/openocd/scripts/target/stm32f4x.cfg",
        "-c",
        "bindto 127.0.0.1",
        "-c",
        "tcl_port disabled",
        "-c",
        "gdb_port disabled",
        "-c",
        "telnet_port disabled",
        "-c",
        "init",
        "-c",
        "shutdown"
    ]);

    // 同步 spawn 失败与异步 error 事件的 ENOENT 语义必须一致。
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    await assert.rejects(
        runOpenOcdOnce({
            executable: "/missing/openocd",
            probe: "p.cfg",
            target: "t.cfg",
            buildCommands: () => [],
            resolveLaunch: resolver("/missing/openocd"),
            spawnImpl: () => {
                throw enoent;
            }
        }),
        (error) => error.i18nKey === "run.notFound" && error.i18nParams.path === "/missing/openocd"
    );
    const errorChild = fakeChild();
    await assert.rejects(
        runOpenOcdOnce({
            executable: "/missing/openocd",
            probe: "p.cfg",
            target: "t.cfg",
            buildCommands: () => [],
            resolveLaunch: resolver("/missing/openocd"),
            spawnImpl: () => {
                process.nextTick(() => errorChild.emit("error", enoent));
                return errorChild;
            }
        }),
        (error) => error.i18nKey === "run.notFound"
    );

    // 超时只 settle 一次并尝试终止子进程。
    const timeoutChild = fakeChild();
    await assert.rejects(
        runOpenOcdOnce({
            executable: "openocd",
            probe: "p.cfg",
            target: "t.cfg",
            timeoutMs: 10,
            buildCommands: () => ["init"],
            resolveLaunch: resolver(),
            spawnImpl: () => timeoutChild
        }),
        (error) => error.code === "OPENOCD_TIMEOUT"
    );
    assert.strictEqual(timeoutChild.killed, true);

    console.log("OpenOCD one-shot executor tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
