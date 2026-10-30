"use strict";
// Agent Bridge client diagnostic context and degradation evidence. Covers a hanging request (transport timeout), a
// refused connection, a late state change, different recovery for read-only and state-changing timeouts, server
// diagnostics taking precedence over client templates, older error objects without the newer details, and diagnostics
// never leaking the token. Normal tests need no OpenOCD, probe or network: a local net/http black hole and a closed
// port simulate the transport.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");
const {
    call,
    diagnosticForError,
    isReadOnlyMethod,
    DIAGNOSTICS,
    RENDERINGS,
    renderSuggestions
} = require("../skills/_emberprobe/agent-client");

// A server that accepts connections but never responds, to trigger client transport timeouts (hanging request / late
// state change).
function startBlackholeServer() {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            // Deliberately writes no response so the client socket times out idle.
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, sockets }));
    });
}

// Closed right after binding, giving a port almost certainly nobody listens on, to trigger ECONNREFUSED.
function reserveClosedPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Locate only through this test's empty registry, with an old-format workspace pointer (host/port/token inline) aimed
// at the test port, so no real extension Bridge is needed.
process.env.EMBERPROBE_BRIDGE_REGISTRY = path.join(os.tmpdir(), "emberprobe-agent-diagnostics-no-registry");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-agent-diagnostics-"));
const pointerFile = path.join(workspace, ".agents", "skills", "_emberprobe", "agent-bridge.json");
function patchDescriptor(port, token) {
    fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
    fs.writeFileSync(pointerFile, JSON.stringify({ host: "127.0.0.1", port, token }));
}
function unpatchDescriptor() {
    fs.rmSync(pointerFile, { force: true });
}

(async () => {
    const TOKEN = "super-secret-bridge-token";

    try {
        // Method classes: read-only may be retried once under the same preconditions; everything else is state-changing
        assert.strictEqual(isReadOnlyMethod("config.get"), true);
        assert.strictEqual(isReadOnlyMethod("variables.read"), false, "a hardware read may configure its USB driver");
        assert.strictEqual(isReadOnlyMethod("debug.status"), true);
        assert.strictEqual(isReadOnlyMethod("config.set"), false);
        assert.strictEqual(isReadOnlyMethod("debug.start"), false);
        assert.strictEqual(isReadOnlyMethod("peripherals.write"), false);
        assert.strictEqual(
            isReadOnlyMethod("some.future.method"),
            false,
            "unknown methods are treated as state-changing"
        );

        // Hanging request: the transport timeout carries the method name, effective budget and elapsed time
        const blackhole = await startBlackholeServer();
        let timeoutError;
        patchDescriptor(blackhole.port, TOKEN);
        try {
            await call(workspace, "config.set", { values: { mcu: "stm32f4x.cfg" } }, 1000);
        } catch (error) {
            timeoutError = error;
        } finally {
            unpatchDescriptor();
        }
        assert.ok(timeoutError, "a hanging request must time out and reject");
        assert.strictEqual(timeoutError.code, "BRIDGE_TIMEOUT");
        assert.strictEqual(timeoutError.details.method, "config.set");
        assert.strictEqual(timeoutError.details.timeoutMs, 1000, "reports the actual (clamped) timeout budget");
        assert.ok(Number.isFinite(timeoutError.details.elapsedMs) && timeoutError.details.elapsedMs >= 0);
        for (const socket of blackhole.sockets) socket.destroy();
        blackhole.server.close();

        // A driver-capable hardware call checks the read-only inventory after a transport timeout.
        const methods = [];
        const statusServer = http.createServer((request, response) => {
            const chunks = [];
            request.on("data", (part) => chunks.push(part));
            request.on("end", () => {
                const { method } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                methods.push(method);
                if (method === "probe.list") {
                    response.writeHead(200, { "Content-Type": "application/json" });
                    response.end(JSON.stringify({ ok: true, result: { available: true, devices: [] } }));
                }
            });
        });
        await new Promise((resolve) => statusServer.listen(0, "127.0.0.1", resolve));
        patchDescriptor(statusServer.address().port, TOKEN);
        let driverTimeout;
        try {
            await call(workspace, "chip.read", {}, 1000);
        } catch (error) {
            driverTimeout = error;
        } finally {
            unpatchDescriptor();
            statusServer.close();
        }
        assert.strictEqual(driverTimeout?.code, "BRIDGE_TIMEOUT");
        assert.deepStrictEqual(methods, ["chip.read", "probe.list"], "do not replay the hardware request");
        assert.deepStrictEqual(driverTimeout.details.driverInventory, { available: true, devices: [] });

        // State-changing timeout: unknown result, never claimed cancelled, never resent automatically, with a hint to
        // query the actual state
        const stateChangeDiag = diagnosticForError(timeoutError, { operation: "config.set" });
        assert.strictEqual(stateChangeDiag.error.details.resultUnknown, true);
        assert.strictEqual(
            stateChangeDiag.error.retryable,
            false,
            "state-changing timeouts are not retried automatically"
        );
        const stateText = JSON.stringify(stateChangeDiag.error.suggestedActions);
        assert.ok(stateText.includes("config.get"), "suggests checking the actual state with a query method");
        assert.ok(!stateText.includes("采样"), "a generic timeout is not presented as a busy probe");
        assert.ok(!stateChangeDiag.error.likelyCause.includes("采样"));
        assert.ok(
            !JSON.stringify(stateChangeDiag).includes("已取消") &&
                !JSON.stringify(stateChangeDiag).includes("cancelled"),
            "a timeout never claims the request was cancelled"
        );
        assert.ok(!JSON.stringify(stateChangeDiag).includes(TOKEN), "diagnostics never leak the Bridge token");

        // Read-only timeout: one retry under the same preconditions is allowed, and resultUnknown is false
        const readOnlyDiag = diagnosticForError(
            Object.assign(new Error("Agent Bridge request timed out"), {
                code: "BRIDGE_TIMEOUT",
                details: { method: "config.get", timeoutMs: 20000, elapsedMs: 20001 }
            }),
            { operation: "config.get" }
        );
        assert.strictEqual(readOnlyDiag.error.retryable, true);
        assert.strictEqual(readOnlyDiag.error.details.resultUnknown, false);
        assert.ok(!JSON.stringify(readOnlyDiag).includes("采样"));

        // Refused connection: described differently from a timeout, keeping the original transport error code without
        // leaking the token
        const closedPort = await reserveClosedPort();
        let connError;
        patchDescriptor(closedPort, TOKEN);
        try {
            await call(workspace, "config.get", {});
        } catch (error) {
            connError = error;
        } finally {
            unpatchDescriptor();
        }
        assert.ok(connError, "a refused connection rejects");
        const connDiag = diagnosticForError(connError, { operation: "config.get" });
        assert.strictEqual(connDiag.error.code, "BRIDGE_UNAVAILABLE");
        assert.strictEqual(connDiag.error.details.transportError, "ECONNREFUSED");
        assert.strictEqual(connDiag.error.details.method, "config.get");
        assert.notStrictEqual(
            connDiag.error.code,
            "BRIDGE_TIMEOUT",
            "connection failures and request timeouts are different errors"
        );
        assert.ok(!JSON.stringify(connDiag).includes(TOKEN), "connection failure diagnostics never leak the token");

        // Specific server diagnostics take precedence over the client's default template
        const serverDiag = diagnosticForError(
            Object.assign(new Error("probe busy"), {
                code: "PROBE_BUSY",
                likelyCause: "扩展返回的具体原因",
                suggestedActions: ["扩展返回的具体动作"],
                details: { activeOperation: "debug", debugState: "running" }
            }),
            { operation: "debug.start" }
        );
        assert.strictEqual(serverDiag.error.likelyCause, "扩展返回的具体原因");
        assert.deepStrictEqual(serverDiag.error.suggestedActions, ["扩展返回的具体动作"]);
        assert.strictEqual(serverDiag.error.details.activeOperation, "debug");

        // Older error objects without the newer details are still handled
        const bareDiag = diagnosticForError(Object.assign(new Error("timed out"), { code: "BRIDGE_TIMEOUT" }));
        assert.strictEqual(bareDiag.error.code, "BRIDGE_TIMEOUT");
        assert.strictEqual(
            bareDiag.error.details.resultUnknown,
            true,
            "without a method context the state counts as unknown"
        );
        assert.strictEqual(bareDiag.error.retryable, false);
        assert.ok(!JSON.stringify(bareDiag).includes("采样"));
        assert.ok(Array.isArray(bareDiag.error.suggestedActions) && bareDiag.error.suggestedActions.length > 0);
        assert.ok(bareDiag.error.suggestedActions.some((text) => text.includes("对应查询方法")));

        // Suggested actions are channel-independent: skill rendering keeps the CLI syntax, MCP rendering uses tool
        // names, and actions are machine-readable
        const inactive = Object.assign(new Error("no session"), { code: "DEBUG_SESSION_NOT_ACTIVE" });
        const skillView = diagnosticForError(inactive, { operation: "debug.control" });
        assert.deepStrictEqual(skillView.error.suggestedActions, ["使用 mcu-debug-control --start 启动调试后重试。"]);
        assert.deepStrictEqual(skillView.error.actions, [{ method: "debug.start" }]);
        const mcpView = diagnosticForError(inactive, {
            operation: "debug.control",
            render: { channel: "mcp", method: (method) => method.replace(/\./g, "_") }
        });
        assert.deepStrictEqual(mcpView.error.suggestedActions, ["使用 debug_start 启动调试后重试。"]);
        assert.deepStrictEqual(mcpView.error.actions, skillView.error.actions);
        const timeoutView = diagnosticForError(timeoutError, {
            operation: "config.set",
            render: { channel: "mcp", method: (method) => method.replace(/\./g, "_") }
        });
        assert.ok(timeoutView.error.suggestedActions.some((text) => text.includes("先用 config_get 核对")));
        assert.deepStrictEqual(timeoutView.error.actions, [{ method: "config.get" }]);
        // The diagnostics table no longer contains CLI syntax; every placeholder has both renderings
        for (const [code, preset] of Object.entries(DIAGNOSTICS)) {
            for (const text of preset[2]) {
                assert.ok(!/mcu-[a-z-]+ --|(^|\s)--[a-z]/.test(text.replace("udevadm control --reload", "")), code);
                for (const [, key] of text.matchAll(/\{\{([a-zA-Z]+)\}\}/g)) assert.ok(RENDERINGS[key], key);
            }
            const rendered = diagnosticForError({ code }, { render: { channel: "mcp" } });
            assert.ok(!JSON.stringify(rendered).includes("{{"), `${code} leaves an unrendered token`);
        }
        assert.deepStrictEqual(renderSuggestions(["{{unknown}} {{method:}}"], { channel: "mcp" }).suggestedActions, [
            "{{unknown}} 对应的状态查询工具"
        ]);

        console.log("Agent diagnostics tests passed");
    } finally {
        unpatchDescriptor();
        fs.rmSync(workspace, { recursive: true, force: true });
    }
})().catch((error) => {
    unpatchDescriptor();
    console.error(error);
    process.exitCode = 1;
});
