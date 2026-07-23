"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const MAX_BODY = 64 * 1024;
const ERROR_FIELDS = ['category', 'stage', 'likelyCause', 'retryable', 'suggestedActions', 'details', 'i18nKey', 'i18nParams'];

function serializeError(error) {
    const result = {
        code: error?.code || "BRIDGE_ERROR",
        message: error?.message || String(error)
    };
    for (const field of ERROR_FIELDS) {
        if (error?.[field] !== undefined) result[field] = error[field];
    }
    return result;
}

class AgentBridge {
    constructor(workspace, handler) {
        this.workspace = path.resolve(workspace);
        this.handler = handler;
        this.server = null;
        this.token = crypto.randomBytes(24).toString("hex");
        this.descriptorPath = path.join(this.workspace, ".emberprobe", "agent-bridge.json");
    }

    async start() {
        if (this.server) return this.descriptor();
        this.server = http.createServer((request, response) => this._receive(request, response));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", resolve);
        });
        const descriptor = this.descriptor();
        await fs.mkdir(path.dirname(this.descriptorPath), { recursive: true });
        await fs.writeFile(this.descriptorPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
        return descriptor;
    }

    descriptor() {
        const address = this.server?.address();
        return {
            protocol: 1,
            host: "127.0.0.1",
            port: address && typeof address === "object" ? address.port : 0,
            token: this.token,
            pid: process.pid,
            workspace: this.workspace,
            startedAt: new Date().toISOString()
        };
    }

    async _receive(request, response) {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (request.method !== "POST" || request.url !== "/v1/call") {
            response.statusCode = 404;
            response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } }));
            return;
        }
        if (request.headers.authorization !== `Bearer ${this.token}`) {
            response.statusCode = 401;
            response.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid Agent Bridge token" } }));
            return;
        }
        let size = 0;
        const chunks = [];
        request.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_BODY) request.destroy();
            else chunks.push(chunk);
        });
        request.on("end", async () => {
            try {
                if (size > MAX_BODY) throw Object.assign(new Error("Request is too large"), { code: "REQUEST_TOO_LARGE" });
                const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                if (!/^[a-z][a-zA-Z0-9.]*$/.test(payload.method || "")) {
                    throw Object.assign(new Error("Invalid method"), { code: "INVALID_METHOD" });
                }
                const result = await this.handler(payload.method, payload.params || {});
                response.end(JSON.stringify({ ok: true, result }));
            } catch (error) {
                response.statusCode = Number(error.statusCode) || 400;
                response.end(JSON.stringify({
                    ok: false,
                    error: serializeError(error)
                }));
            }
        });
    }

    async stop() {
        const server = this.server;
        this.server = null;
        if (server) await new Promise(resolve => server.close(resolve));
        try {
            const current = JSON.parse(await fs.readFile(this.descriptorPath, "utf8"));
            if (current.token === this.token) await fs.unlink(this.descriptorPath);
        } catch { /* descriptor may already be gone */ }
    }
}

module.exports = { AgentBridge, MAX_BODY, serializeError };
