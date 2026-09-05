"use strict";
// 任务2：Agent Bridge 客户端诊断上下文与降级证据。
// 覆盖：请求挂起(传输超时)、拒绝连接、状态变更晚完成、只读与状态变更超时的不同恢复动作、
// 服务端具体诊断优先于客户端模板、旧错误对象缺少新增详情仍可处理、诊断不泄露 token。
// 普通测试不依赖 OpenOCD、真实探针或网络：用本机 net/http 黑hole 与已关闭端口模拟传输层。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { call, diagnosticForError, isReadOnlyMethod } = require("../skills/_emberprobe/agent-client");

// 接受连接但永不响应的服务器，用于触发客户端传输超时（请求挂起 / 状态变更晚完成）。
function startBlackholeServer() {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            // 故意不写任何响应，让客户端 socket 空闲超时。
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, sockets }));
    });
}

// 绑定后立即关闭，得到一个几乎肯定无人监听的端口，用于触发 ECONNREFUSED。
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

const realReadFileSync = fs.readFileSync;
// descriptor() 会校验 host/port/token，因此用 monkeypatch 把指针文件内容指向测试端口，
// 避免依赖真实扩展 Bridge。仅拦截 agent-bridge.json 的读取，其余委托真实实现。
function patchDescriptor(port, token) {
    fs.readFileSync = function (target, ...rest) {
        if (String(target).endsWith("agent-bridge.json")) {
            return JSON.stringify({ host: "127.0.0.1", port, token });
        }
        return realReadFileSync.call(fs, target, ...rest);
    };
}
function unpatchDescriptor() {
    fs.readFileSync = realReadFileSync;
}

(async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-agent-diagnostics-"));
    const TOKEN = "super-secret-bridge-token";

    try {
        // ---- 方法分类：只读可在相同前置条件下重试一次；其余按状态变更处理 ----
        assert.strictEqual(isReadOnlyMethod("config.get"), true);
        assert.strictEqual(isReadOnlyMethod("variables.read"), true);
        assert.strictEqual(isReadOnlyMethod("debug.status"), true);
        assert.strictEqual(isReadOnlyMethod("config.set"), false);
        assert.strictEqual(isReadOnlyMethod("debug.start"), false);
        assert.strictEqual(isReadOnlyMethod("peripherals.write"), false);
        assert.strictEqual(isReadOnlyMethod("some.future.method"), false, "未知方法必须按状态变更安全处理");

        // ---- 请求挂起：传输超时携带方法名、实际预算与耗时 ----
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
        assert.ok(timeoutError, "挂起请求必须超时 reject");
        assert.strictEqual(timeoutError.code, "BRIDGE_TIMEOUT");
        assert.strictEqual(timeoutError.details.method, "config.set");
        assert.strictEqual(timeoutError.details.timeoutMs, 1000, "必须报告实际(钳制后)超时预算");
        assert.ok(Number.isFinite(timeoutError.details.elapsedMs) && timeoutError.details.elapsedMs >= 0);
        for (const socket of blackhole.sockets) socket.destroy();
        blackhole.server.close();

        // 状态变更超时：结果未知、不得声称已取消、不得自动重发、提示查询实际状态
        const stateChangeDiag = diagnosticForError(timeoutError, { operation: "config.set" });
        assert.strictEqual(stateChangeDiag.error.details.resultUnknown, true);
        assert.strictEqual(stateChangeDiag.error.retryable, false, "状态变更超时不可自动重试");
        const stateText = JSON.stringify(stateChangeDiag.error.suggestedActions);
        assert.ok(stateText.includes("config.get"), "必须提示用查询方法核对实际状态");
        assert.ok(!stateText.includes("采样"), "不得暗示通用超时等于采样占用");
        assert.ok(!stateChangeDiag.error.likelyCause.includes("采样"));
        assert.ok(
            !JSON.stringify(stateChangeDiag).includes("已取消") &&
                !JSON.stringify(stateChangeDiag).includes("cancelled"),
            "超时不得声称请求已取消"
        );
        assert.ok(!JSON.stringify(stateChangeDiag).includes(TOKEN), "诊断不得泄露 Bridge token");

        // 只读超时：允许在相同前置条件下重试一次，结果未知为 false
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

        // ---- 拒绝连接：与超时区分描述，保留原始传输错误码，不泄露 token ----
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
        assert.ok(connError, "拒绝连接必须 reject");
        const connDiag = diagnosticForError(connError, { operation: "config.get" });
        assert.strictEqual(connDiag.error.code, "BRIDGE_UNAVAILABLE");
        assert.strictEqual(connDiag.error.details.transportError, "ECONNREFUSED");
        assert.strictEqual(connDiag.error.details.method, "config.get");
        assert.notStrictEqual(connDiag.error.code, "BRIDGE_TIMEOUT", "连接失败与请求超时必须是不同错误");
        assert.ok(!JSON.stringify(connDiag).includes(TOKEN), "连接失败诊断不得泄露 token");

        // ---- 服务端具体诊断优先于客户端默认模板 ----
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

        // ---- 旧错误对象缺少新增详情仍可处理（向后兼容）----
        const bareDiag = diagnosticForError(Object.assign(new Error("timed out"), { code: "BRIDGE_TIMEOUT" }));
        assert.strictEqual(bareDiag.error.code, "BRIDGE_TIMEOUT");
        assert.strictEqual(bareDiag.error.details.resultUnknown, true, "无方法上下文时按状态未知安全处理");
        assert.strictEqual(bareDiag.error.retryable, false);
        assert.ok(!JSON.stringify(bareDiag).includes("采样"));
        assert.ok(Array.isArray(bareDiag.error.suggestedActions) && bareDiag.error.suggestedActions.length > 0);

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
