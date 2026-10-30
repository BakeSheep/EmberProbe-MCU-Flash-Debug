"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { serializeError: serializeDiagnostic } = require("./services/errorEnvelope");
const { BRIDGE_PROTOCOL, MIN_CLIENT_PROTOCOL } = require("../skills/_emberprobe/bridge-locator");

const MAX_BODY = 64 * 1024;
const CHANNELS = new Set(["skill", "mcp"]);

function jsonReplacer(_key, value) {
    if (typeof value === "number" && !Number.isFinite(value)) {
        if (Number.isNaN(value)) return "NaN";
        return value > 0 ? "Infinity" : "-Infinity";
    }
    return value;
}

function stringifyJson(value, space) {
    return JSON.stringify(value, jsonReplacer, space);
}

function serializeError(error) {
    return { code: error?.code || "BRIDGE_ERROR", ...serializeDiagnostic(error) };
}

function decodeHeader(value, limit) {
    if (typeof value !== "string" || !value || value.length > limit * 3) return undefined;
    try {
        const decoded = decodeURIComponent(value);
        return decoded.length <= limit && !/[\0\r\n]/.test(decoded) ? decoded : undefined;
    } catch {
        return undefined;
    }
}

// Caller identity only locates and audits callers and is not authentication: any process of the same user can forge
// these headers.
function requestMeta(headers) {
    const channel = String(headers["x-emberprobe-channel"] || "").toLowerCase();
    if (!CHANNELS.has(channel)) return undefined;
    const meta = { channel };
    const skillRoot = decodeHeader(headers["x-emberprobe-skill-root"], 4096);
    const client = decodeHeader(headers["x-emberprobe-client"], 200);
    if (skillRoot) meta.skillRoot = skillRoot;
    if (client) meta.client = client;
    return meta;
}

class AgentBridge {
    // storageDir is the extension's globalStorage directory. When given, the descriptor (with token) is written there
    // instead of the workspace, which keeps only a token-free pointer so the token cannot leak through git or cloud
    // sync. Without it the descriptor stays in the workspace. options.legacyPointer=false writes neither the legacy
    // descriptor nor the workspace pointer (new clients use the instance registry).
    constructor(workspace, handler, storageDir, options = {}) {
        this.workspace = path.resolve(workspace);
        this.handler = handler;
        this.server = null;
        this.token = crypto.randomBytes(24).toString("hex");
        this.legacyPointer = options.legacyPointer !== false;
        this.legacyWritten = false;
        this.startedAt = "";
        this.pointerPath = path.join(this.workspace, ".agents", "skills", "_emberprobe", "agent-bridge.json");
        this.legacyPointerPath = path.join(this.workspace, ".emberprobe", "agent-bridge.json");
        if (storageDir) {
            const workspaceKey = crypto.createHash("sha256").update(this.workspace).digest("hex").slice(0, 16);
            this.descriptorPath = path.join(storageDir, `agent-bridge-${workspaceKey}.json`);
        } else {
            this.descriptorPath = this.pointerPath;
        }
    }

    async start() {
        try {
            return await this.startServer();
        } catch (error) {
            try {
                await this.stop();
            } catch (cleanupError) {
                error.cleanupError = cleanupError;
            }
            throw error;
        }
    }

    async startServer() {
        if (this.server) return this.descriptor();
        this.server = http.createServer((request, response) => this._receive(request, response));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => resolve(undefined));
        });
        this.startedAt = new Date().toISOString();
        const descriptor = this.descriptor();
        if (this.legacyPointer) await this._writeLegacyFiles(descriptor);
        // Migration: remove the pointer older versions left in the project root, deleting the directory only if it is
        // already empty.
        await fs.unlink(this.legacyPointerPath).catch(() => {});
        await fs.rmdir(path.dirname(this.legacyPointerPath)).catch(() => {});
        return descriptor;
    }

    async _writeLegacyFiles(descriptor) {
        this.legacyWritten = true;
        await fs.mkdir(path.dirname(this.descriptorPath), { recursive: true });
        await fs.writeFile(this.descriptorPath, stringifyJson(descriptor, 2), { mode: 0o600 });
        if (this.pointerPath !== this.descriptorPath) {
            await fs.mkdir(path.dirname(this.pointerPath), { recursive: true });
            await fs.writeFile(
                this.pointerPath,
                stringifyJson({ protocol: 1, descriptorPath: this.descriptorPath }, 2)
            );
        }
    }

    // Older scripts only know the workspace pointer; it is written only while workspace skills are installed and
    // withdrawn on uninstall, while the Bridge keeps running.
    async setLegacyPointer(enabled) {
        this.legacyPointer = !!enabled;
        if (!this.server) return;
        if (this.legacyPointer) await this._writeLegacyFiles(this.descriptor());
        else await this._removeLegacyFiles();
    }

    descriptor() {
        const address = this.server?.address();
        return {
            protocol: BRIDGE_PROTOCOL,
            minClientProtocol: MIN_CLIENT_PROTOCOL,
            host: "127.0.0.1",
            port: address && typeof address === "object" ? address.port : 0,
            token: this.token,
            pid: process.pid,
            workspace: this.workspace,
            startedAt: this.startedAt || new Date().toISOString()
        };
    }

    _receive(request, response) {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        let receiving = true;
        let size = 0;
        const chunks = [];
        const fail = (status, code, message) => {
            receiving = false;
            chunks.length = 0;
            if (response.writableEnded || response.destroyed) return;
            response.statusCode = status;
            // Let Node flush the response before closing the socket. Destroying the
            // request here can discard the 413 response and reset the client.
            response.setHeader("Connection", "close");
            response.end(stringifyJson({ ok: false, error: { code, message } }));
            request.resume();
        };
        request.on("error", () => fail(400, "BAD_REQUEST", "Request stream failed"));
        request.on("aborted", () => fail(400, "BAD_REQUEST", "Request was aborted"));
        const port = request.socket.localPort;
        const host = String(request.headers.host || "").toLowerCase();
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
            fail(403, "FORBIDDEN_HOST", "Forbidden host");
            return;
        }
        if (request.method !== "POST" || request.url !== "/v1/call") {
            fail(404, "NOT_FOUND", "Unknown endpoint");
            return;
        }
        const expected = Buffer.from(`Bearer ${this.token}`, "utf8");
        const supplied = Buffer.from(String(request.headers.authorization || ""), "utf8");
        if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
            fail(401, "UNAUTHORIZED", "Invalid Agent Bridge token");
            return;
        }
        if (Number(request.headers["content-length"]) > MAX_BODY) {
            fail(413, "REQUEST_TOO_LARGE", "Request is too large");
            return;
        }
        const meta = requestMeta(request.headers);
        request.on("data", (chunk) => {
            if (!receiving) return;
            size += chunk.length;
            if (size > MAX_BODY) fail(413, "REQUEST_TOO_LARGE", "Request is too large");
            else chunks.push(chunk);
        });
        request.on("end", async () => {
            if (!receiving || request.aborted) return;
            receiving = false;
            try {
                const body = Buffer.concat(chunks).toString("utf8");
                chunks.length = 0;
                const payload = JSON.parse(body || "{}");
                if (!/^[a-z][a-zA-Z0-9.]*$/.test(payload.method || "")) {
                    throw Object.assign(new Error("Invalid method"), { code: "INVALID_METHOD" });
                }
                const result = await this.handler(payload.method, payload.params || {}, meta);
                if (!response.writableEnded && !response.destroyed) response.end(stringifyJson({ ok: true, result }));
            } catch (error) {
                if (response.writableEnded || response.destroyed) return;
                response.statusCode = Number(error.statusCode) || 400;
                response.end(stringifyJson({ ok: false, error: serializeError(error) }));
            }
        });
    }

    async _removeLegacyFiles() {
        if (!this.legacyWritten) return;
        this.legacyWritten = false;
        try {
            const current = JSON.parse(await fs.readFile(this.descriptorPath, "utf8"));
            if (current.token !== this.token) return;
            await fs.unlink(this.descriptorPath).catch(() => {});
            // The pointer holds a path but no token; delete the descriptor too while it still points at this instance,
            // so no dangling reference remains
            if (this.pointerPath !== this.descriptorPath) {
                try {
                    const pointer = JSON.parse(await fs.readFile(this.pointerPath, "utf8"));
                    if (pointer.descriptorPath === this.descriptorPath) {
                        await fs.unlink(this.pointerPath);
                        // Only delete the extension directory once it is empty; if the user put other files in it,
                        // rmdir fails and they are kept.
                        await fs.rmdir(path.dirname(this.pointerPath)).catch(() => {});
                    }
                } catch {
                    /* pointer may already be gone */
                }
            } else {
                await fs.rmdir(path.dirname(this.pointerPath)).catch(() => {});
            }
        } catch {
            /* descriptor may already be gone */
        }
    }

    async stop() {
        const server = this.server;
        this.server = null;
        if (server)
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            });
        await this._removeLegacyFiles();
    }
}

module.exports = { AgentBridge, MAX_BODY, serializeError, jsonReplacer, stringifyJson, requestMeta };
