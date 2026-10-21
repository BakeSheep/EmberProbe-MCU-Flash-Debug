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

// 调用方标识只用于定位与审计，不构成鉴权：同一用户下的进程可以伪造这些请求头。
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
    // storageDir 为扩展 globalStorage 目录；提供时描述文件（含 token）写入用户目录而非工作区，
    // 工作区只保留不含 token 的指针文件，避免令牌随 git 提交/云同步泄露。未提供时保持旧行为。
    // options.legacyPointer=false 时不写旧版描述文件与工作区指针（新客户端走实例注册表）。
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
        // 升级迁移：移除旧版项目根指针，并仅在旧目录已经为空时删除目录。
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

    // 旧版脚本只认工作区指针；工作区装了 skills 时才写，卸载后撤回，Bridge 本身继续运行。
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
            // 指针文件只含路径不含令牌；仍指向本实例的描述文件时一并删除，避免留下悬空引用
            if (this.pointerPath !== this.descriptorPath) {
                try {
                    const pointer = JSON.parse(await fs.readFile(this.pointerPath, "utf8"));
                    if (pointer.descriptorPath === this.descriptorPath) {
                        await fs.unlink(this.pointerPath);
                        // 只删除已经为空的插件目录；若用户在其中放了其他文件，rmdir 会失败并安全保留。
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
