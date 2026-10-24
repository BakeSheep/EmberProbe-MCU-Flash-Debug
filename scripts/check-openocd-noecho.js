"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { randomBytes } = require("crypto");
const tar = require("tar");
const { ManagedOpenOcdSession, findFreePort } = require("../src/liveWatch");
const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../resources/openocd-targets-manifest.json"), "utf8")
);

// Interface-only compatibility check: dummy adapter + noinit never opens a hardware probe.
async function main({ scatter = false } = {}) {
    const archive = manifest.archives.find((entry) => entry.platform === `${process.platform}-${process.arch}`);
    if (!archive) throw new Error(`No bundled OpenOCD for ${process.platform}-${process.arch}`);
    const root = path.resolve(__dirname, "..");
    const results = path.join(root, "test-results");
    fs.mkdirSync(results, { recursive: true });
    const directory = fs.mkdtempSync(path.join(results, "openocd-noecho-"));
    await tar.x({ file: path.join(root, "resources", archive.file), cwd: directory });
    const port = await findFreePort();
    assert.ok(port, "free Tcl port");
    const child = spawn(
        path.join(directory, archive.binary),
        [
            "-s",
            path.join(directory, archive.scriptsRoot),
            ...[
                "adapter driver dummy",
                "transport select jtag",
                "bindto 127.0.0.1",
                `tcl port ${port}`,
                "gdb port disabled",
                "telnet port disabled",
                "noinit"
            ].flatMap((command) => ["-c", command])
        ],
        { windowsHide: true, shell: false }
    );
    let stdout = "",
        stderr = "",
        failure;
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.on("error", (error) => {
        failure = error;
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    const waitFor = async (predicate) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
            if (failure) throw failure;
            if (child.exitCode !== null) throw new Error(`OpenOCD exited (${child.exitCode}): ${stdout}${stderr}`);
            if (Date.now() >= deadline) throw new Error(`OpenOCD check timed out: ${stderr}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    const session = new ManagedOpenOcdSession(null, {}, {});
    try {
        await waitFor(() => (stdout + stderr).includes(`Listening on port ${port} for tcl connections`));
        session.socket = await new Promise((resolve, reject) => {
            const socket = net.connect({ host: "127.0.0.1", port });
            socket.once("error", reject);
            socket.once("connect", () => {
                socket.removeListener("error", reject);
                resolve(socket);
            });
        });
        session._setupSocket();
        const nonce = randomBytes(12).toString("hex");
        const marker = `EP_NOECHO_${nonce}`;
        const sync = `EP_SYNC_${nonce}`;
        assert.strictEqual(await session._sendCommand(`return -code exit ${marker}`), marker);
        assert.strictEqual(await session._sendCommand(`set _ep_sync ${sync}`), sync);
        await waitFor(() => stderr.includes(sync));
        assert.ok(!stderr.includes(marker), "JIM_EXIT reply must not echo on stderr");
        assert.ok(!stdout.includes(marker), "JIM_EXIT reply must not echo on stdout");
        assert.strictEqual(await session._sendCommand("expr {6 * 7}"), "42", "connection remains usable");
        session.noEchoResponses = true;
        assert.strictEqual(await session._executeCheckedCommand("expr {6 * 7}"), "42");
        if (scatter) {
            // Dummy JTAG only; creating an unexamined Cortex-M never opens a hardware probe.
            await session._sendCommand("jtag newtap ep cpu -irlen 4 -expected-id 0x4ba00477");
            await session._sendCommand("dap create ep.dap -chain-position ep.cpu");
            await session._sendCommand("target create ep.cpu cortex_m -dap ep.dap -defer-examine");
            // The dummy adapter cannot examine a physical DAP. Initialization still
            // registers execution commands; its expected transport error is caught.
            await session._sendCommand("catch {init} _ep_init");
            const unsupported = await session._sendCommand(
                "catch {emberprobe_read_scatter version} _ep_scatter; set _ep_scatter"
            );
            assert.ok(unsupported.includes("EMBERPROBE_SCATTER_UNSUPPORTED"), unsupported);
            const targetUnsupported = await session._sendCommand(
                "catch {ep.cpu emberprobe_read_scatter version} _ep_scatter; set _ep_scatter"
            );
            assert.ok(targetUnsupported.includes("EMBERPROBE_SCATTER_UNSUPPORTED"), targetUnsupported);
            assert.strictEqual(await session._sendCommand("expr {6 * 7}"), "42");
        }
        await assert.rejects(session._executeCheckedCommand("error {expected Tcl rejection}"), {
            code: "OPENOCD_TCL_ERROR"
        });
        console.log(
            `Bundled ${archive.platform} OpenOCD: no-echo reply, log silence, normal echo and connection reuse passed`
        );
    } finally {
        session.socket?.destroy();
        child.kill();
        await closed;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { main };
