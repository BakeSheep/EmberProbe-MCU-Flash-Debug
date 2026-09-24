"use strict";

const { execFile } = require("child_process");
const {
    resolveExecutablePath,
    findScriptsRoot,
    resolveConfigFile
} = require("../../skills/_emberprobe/openocd-launch");
const { normalizeProbeSerial } = require("../../skills/_emberprobe/probe-connection");

function run(executable, args, cwd) {
    return new Promise((resolve, reject) =>
        execFile(
            executable,
            args,
            { cwd, windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 },
            (error, stdout, stderr) =>
                error
                    ? reject(
                          new Error(
                              String(stderr || stdout || error.message)
                                  .trim()
                                  .slice(-500)
                          )
                      )
                    : resolve(undefined)
        )
    );
}

// A bound WinUSB devnode may still be re-enumerating. Open only the selected J-Link interface;
// no target configuration, reset, memory access or flash operation is performed.
async function waitForJlinkReady(executable, serial, options = {}) {
    const openocd = resolveExecutablePath(executable);
    const scriptsRoot = findScriptsRoot(openocd);
    if (!scriptsRoot) throw new Error("OpenOCD scripts directory is unavailable");
    const interfacePath = resolveConfigFile(scriptsRoot, "interface", "jlink.cfg");
    const normalizedSerial = normalizeProbeSerial(serial);
    const args = [
        "-s",
        scriptsRoot,
        "-f",
        interfacePath,
        ...(normalizedSerial ? ["-c", `adapter serial ${normalizedSerial}`] : []),
        "-c",
        "transport select swd",
        "-c",
        "gdb_port disabled",
        "-c",
        "tcl_port disabled",
        "-c",
        "telnet_port disabled",
        "-c",
        "init",
        "-c",
        "shutdown"
    ];
    const execute = options.run || run;
    const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = options.now || Date.now;
    const deadline = now() + (options.timeoutMs ?? 8000);
    let lastError;
    do {
        try {
            await execute(openocd, args, scriptsRoot);
            return;
        } catch (error) {
            lastError = error;
        }
        if (now() >= deadline) break;
        await wait(Math.min(250, Math.max(0, deadline - now())));
    } while (now() < deadline);
    throw Object.assign(new Error(`WinUSB is bound, but OpenOCD cannot open the J-Link yet: ${lastError.message}`), {
        code: "PROBE_DRIVER_NOT_READY",
        cause: lastError
    });
}

module.exports = { waitForJlinkReady };
