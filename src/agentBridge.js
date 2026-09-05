"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const MAX_BODY = 64 * 1024;
const ERROR_FIELDS = [
    "category",
    "stage",
    "likelyCause",
    "retryable",
    "suggestedActions",
    "details",
    "i18nKey",
    "i18nParams"
];

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
    // storageDir 为扩展 globalStorage 目录；提供时描述文件（含 token）写入用户目录而非工作区，
    // 工作区只保留不含 token 的指针文件，避免令牌随 git 提交/云同步泄露。未提供时保持旧行为。
    constructor(workspace, handler, storageDir) {
        this.workspace = path.resolve(workspace);
        this.handler = handler;
        this.server = null;
        this.token = crypto.randomBytes(24).toString("hex");
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
        const descriptor = this.descriptor();
        await fs.mkdir(path.dirname(this.descriptorPath), { recursive: true });
        await fs.writeFile(this.descriptorPath, stringifyJson(descriptor, 2), { mode: 0o600 });
        if (this.pointerPath !== this.descriptorPath) {
            await fs.mkdir(path.dirname(this.pointerPath), { recursive: true });
            await fs.writeFile(
                this.pointerPath,
                stringifyJson({ protocol: 1, descriptorPath: this.descriptorPath }, 2)
            );
        }
        // 升级迁移：移除旧版项目根指针，并仅在旧目录已经为空时删除目录。
        await fs.unlink(this.legacyPointerPath).catch(() => {});
        await fs.rmdir(path.dirname(this.legacyPointerPath)).catch(() => {});
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
            response.end(stringifyJson({ ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } }));
            return;
        }
        if (request.headers.authorization !== `Bearer ${this.token}`) {
            response.statusCode = 401;
            response.end(
                stringifyJson({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid Agent Bridge token" } })
            );
            return;
        }
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) request.destroy();
            else chunks.push(chunk);
        });
        request.on("end", async () => {
            try {
                if (size > MAX_BODY)
                    throw Object.assign(new Error("Request is too large"), { code: "REQUEST_TOO_LARGE" });
                const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                if (!/^[a-z][a-zA-Z0-9.]*$/.test(payload.method || "")) {
                    throw Object.assign(new Error("Invalid method"), { code: "INVALID_METHOD" });
                }
                const result = await this.handler(payload.method, payload.params || {});
                response.end(stringifyJson({ ok: true, result }));
            } catch (error) {
                response.statusCode = Number(error.statusCode) || 400;
                response.end(
                    stringifyJson({
                        ok: false,
                        error: serializeError(error)
                    })
                );
            }
        });
    }

    async stop() {
        const server = this.server;
        this.server = null;
        if (server)
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            });
        try {
            const current = JSON.parse(await fs.readFile(this.descriptorPath, "utf8"));
            if (current.token === this.token) {
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
            }
        } catch {
            /* descriptor may already be gone */
        }
    }
}

module.exports = { AgentBridge, MAX_BODY, serializeError, jsonReplacer, stringifyJson };
