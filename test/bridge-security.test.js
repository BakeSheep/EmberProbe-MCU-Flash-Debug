"use strict";
const assert = require("assert");
const http = require("http");
const { once } = require("events");
const { AgentBridge, MAX_BODY } = require("../src/agentBridge");

(async () => {
    let calls = 0;
    const bridge = new AgentBridge(process.cwd(), async () => ++calls);
    const server = http.createServer((request, response) => bridge._receive(request, response));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const validBody = JSON.stringify({ method: "test" });
    function send({ host = `127.0.0.1:${port}`, token = bridge.token, body = validBody, chunked = false } = {}) {
        return new Promise((resolve, reject) => {
            const request = http.request(
                {
                    host: "127.0.0.1",
                    port,
                    path: "/v1/call",
                    method: "POST",
                    setHost: false,
                    headers: {
                        Host: host,
                        Authorization: `Bearer ${token}`,
                        ...(chunked
                            ? { "Transfer-Encoding": "chunked" }
                            : { "Content-Length": Buffer.byteLength(body) })
                    }
                },
                (response) => {
                    let result = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk) => {
                        result += chunk;
                    });
                    response.on("error", reject);
                    response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(result) }));
                }
            );
            request.on("error", reject);
            request.setTimeout(2000, () => request.destroy(new Error("Bridge request timed out")));
            if (chunked) {
                request.write(body.slice(0, MAX_BODY));
                request.end(body.slice(MAX_BODY));
            } else request.end(body);
        });
    }
    try {
        assert.strictEqual((await send()).status, 200);
        assert.strictEqual((await send({ host: `LOCALHOST:${port}` })).status, 200);
        for (const host of ["", "evil.example", "localhost", `localhost:${port + 1}`, `127.0.0.1.evil:${port}`]) {
            const result = await send({ host });
            assert.strictEqual(result.status, 403, `Host must be rejected: ${host}`);
            assert.strictEqual(result.body.error.code, "FORBIDDEN_HOST");
        }
        for (const token of ["", "wrong", "x".repeat(bridge.token.length)])
            assert.strictEqual((await send({ token })).status, 401);
        const padded = validBody + " ".repeat(MAX_BODY - validBody.length);
        assert.strictEqual((await send({ body: padded })).status, 200, "exactly MAX_BODY is valid");
        for (const chunked of [false, true]) {
            const result = await send({ body: padded + " ", chunked });
            assert.strictEqual(result.status, 413, "oversized requests must receive a complete response");
            assert.strictEqual(result.body.error.code, "REQUEST_TOO_LARGE");
        }
        assert.strictEqual(calls, 3, "rejected requests must never reach the handler");
        const aborted = new Promise((resolve) => server.once("request", (request) => request.once("close", resolve)));
        const partial = http.request({
            host: "127.0.0.1",
            port,
            path: "/v1/call",
            method: "POST",
            headers: { Authorization: `Bearer ${bridge.token}`, "Content-Length": 100 }
        });
        partial.on("error", () => {});
        const received = new Promise((resolve) => server.once("request", (request) => request.once("data", resolve)));
        partial.write("{");
        await received;
        partial.destroy();
        await aborted;
        assert.strictEqual(calls, 3, "aborted uploads must not execute a method");
        assert.strictEqual((await send()).status, 200, "server must survive an aborted upload");
        console.log("Bridge security tests passed");
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
