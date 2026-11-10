"use strict";

const crypto = require("crypto");
const { utf8Boundary } = require("../rttBuffer");
const { CACHE_KEYS } = require("../cacheKeys");

const MAX_UTF8_BYTES = 4;
// The controller's per-write cap; the down buffer size usually bounds it further.
const MAX_INPUT_BYTES = 1024;
const LINE_ENDINGS = Object.freeze({ lf: "\n", crlf: "\r\n", cr: "\r", none: "" });

// Decodes a read in a channel's non-UTF-8 encoding and returns the bytes it consumed. An incomplete multi-byte tail
// stays for the next read, as the UTF-8 path does; input that is simply invalid decodes with replacement characters.
function decodeRead(data, encoding) {
    const strict = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
    for (let held = 0; held < Math.min(MAX_UTF8_BYTES, data.length + 1); held++) {
        try {
            return { text: strict.decode(data.subarray(0, data.length - held)), bytes: data.length - held };
        } catch {
            /* Try again with one more byte held back. */
        }
    }
    return { text: new TextDecoder(encoding, { ignoreBOM: true }).decode(data), bytes: data.length };
}

function validate(params, keys) {
    if (
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        Object.keys(params).some((key) => !keys.includes(key))
    )
        invalid("RTT parameters must be an object containing only supported keys");
}

function invalid(message) {
    throw Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}

// Preserve only public write outcomes. Transport diagnostics can contain local ports and session internals.
function publicError(error) {
    if (!error) return null;
    const details = {};
    const source = error.details || {};
    for (const key of ["resultUnknown", "writeAcknowledged"])
        if (typeof source[key] === "boolean") details[key] = source[key];
    for (const key of ["attempted", "expectedFlags", "actualFlags"])
        if (Number.isSafeInteger(source[key]) && source[key] >= 0 && source[key] <= 0xffffffff)
            details[key] = source[key];
    if (source.attempted === null) details.attempted = null;
    if (Array.isArray(source.completedChannels))
        details.completedChannels = source.completedChannels.filter(
            (index) => Number.isInteger(index) && index >= 0 && index <= 255
        );
    if (Array.isArray(source.completed))
        details.completed = source.completed
            .filter((channel) => Number.isInteger(channel?.index) && channel.index >= 0 && channel.index <= 255)
            .map((channel) => ({
                index: channel.index,
                ...(Number.isSafeInteger(channel.flags) && channel.flags >= 0 && channel.flags <= 0xffffffff
                    ? { flags: channel.flags }
                    : {}),
                ...(["skip", "trim", "block"].includes(channel.mode) ? { mode: channel.mode } : {})
            }));
    return { code: error.code, message: error.message, ...(Object.keys(details).length ? { details } : {}) };
}

// Agent-only projection and cursor handling. Status and reads never acquire a probe or start a session.
class RttAgentService {
    constructor(host) {
        this.host = host;
    }

    status(params = {}) {
        validate(params, []);
        const {
            state,
            source,
            reason,
            yieldedFor,
            retry,
            block,
            channels,
            missingChannels,
            buffers,
            configuredPollingIntervalMs,
            pollingIntervalMs,
            targetDroppedBytes,
            targetTelemetry,
            recovery,
            error
        } = this.host._rtt.status();
        return {
            state,
            source,
            reason,
            yieldedFor,
            retry,
            block,
            channels,
            missingChannels,
            buffers,
            configuredPollingIntervalMs,
            pollingIntervalMs,
            targetDroppedBytes,
            targetTelemetry,
            recovery,
            error: publicError(error)
        };
    }

    read(params = {}) {
        validate(params, ["channel", "generation", "cursor", "maxBytes", "encoding"]);
        for (const [key, min, max] of [
            ["channel", 0, 255],
            ["generation", 0, Number.MAX_SAFE_INTEGER],
            ["cursor", 0, Number.MAX_SAFE_INTEGER],
            ["maxBytes", 1, 65536]
        ]) {
            const value = params[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
                invalid(`${key} must be an integer from ${min} to ${max}`);
        }
        const { channel = 0, generation, cursor, maxBytes = 16384, encoding = "utf8" } = params;
        if (encoding !== "utf8" && encoding !== "base64") invalid("encoding must be utf8 or base64");
        // A UTF-8 read needs room for one whole character, or a small limit could never pass a multi-byte one.
        const limit = encoding === "utf8" ? Math.max(maxBytes, MAX_UTF8_BYTES) : maxBytes;
        const textEncoding = this.host._rtt.channelEncoding(channel);
        const multibyte = encoding === "utf8" && textEncoding !== "utf-8";
        const { data, ...reply } = this.host._rtt.read(channel, {
            generation,
            cursor,
            maxBytes: limit,
            encoding: multibyte ? "base64" : encoding
        });
        if (encoding === "base64") return { channel, ...reply, dataBase64: data.toString("base64") };
        if (multibyte) {
            const { text, bytes } = decodeRead(data, textEncoding);
            return { channel, ...reply, nextCursor: reply.cursor + bytes, text, textEncoding };
        }
        // RttBuffer handles limit truncation; also retain an incomplete sequence at the current buffer end. A held
        // tail leaves `more` as it was: more bytes must arrive first, so a caller looping on `more` would only spin.
        const end = utf8Boundary(data, data.length);
        return {
            channel,
            ...reply,
            nextCursor: reply.cursor + end,
            text: data.subarray(0, end).toString("utf8")
        };
    }

    // Sends text (plus a line ending) or exact bytes to a channel's down buffer. Without full access or a remembered
    // grant, the first call returns the plan and a confirmation ID; the repeat with that ID (after the user approved)
    // writes. The ID is bound to the bytes, the channel and the current attachment.
    async write(params = {}) {
        validate(params, ["channel", "text", "dataBase64", "lineEnding", "confirmationId", "remember"]);
        const plan = this._writePlan(params);
        const authorization = this.host._rttInputAuthorization;
        if (params.confirmationId === undefined && params.remember === undefined) {
            const request = authorization.request(plan);
            if (request.confirmationRequired) return request;
        }
        if (params.remember !== undefined && typeof params.remember !== "boolean") invalid("remember must be boolean");
        if (params.confirmationId !== undefined && typeof params.confirmationId !== "string")
            invalid("confirmationId must be a string");
        const mode = authorization.authorize(plan, params.confirmationId, params.remember === true);
        const result = this.host._rttTerminals.writeAgentInput(plan.channel, plan.bytes, { echo: plan.echo });
        if (mode === "workspace" && params.remember === true) await authorization.remember(plan);
        return {
            written: true,
            channel: plan.channel,
            bytes: result.bytes,
            authorization: { mode, ...(plan.trust ? authorization.status(plan.trust) : {}) }
        };
    }

    // permission: { action: "status" | "reset" } for the remembered RTT input grants.
    async permission(params = {}) {
        validate(params, ["action"]);
        const action = params.action ?? "status";
        if (action === "reset") return this.host._rttInputAuthorization.reset();
        if (action !== "status") invalid("action must be status or reset");
        return this.host._rttInputAuthorization.summary();
    }

    _writePlan(params) {
        const channel = params.channel ?? 0;
        if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255)
            invalid("channel must be an integer from 0 to 255");
        const hasText = params.text !== undefined;
        if (hasText === (params.dataBase64 !== undefined)) invalid("Send either text or dataBase64");
        let bytes;
        let echo;
        let ending;
        if (hasText) {
            if (typeof params.text !== "string") invalid("text must be a string");
            ending =
                params.lineEnding === undefined || params.lineEnding === "configured"
                    ? this.host._rttTerminals.configuredLineEnding()
                    : LINE_ENDINGS[params.lineEnding];
            if (ending === undefined) invalid("lineEnding must be configured, lf, crlf, cr or none");
            bytes = Buffer.from(params.text + ending, "utf8");
            // Shown in the user's terminal: never pass control characters (escape sequences) through.
            echo = params.text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) =>
                char === "\t" ? char : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
            );
        } else {
            if (params.lineEnding !== undefined) invalid("lineEnding applies to text only");
            if (typeof params.dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.dataBase64))
                invalid("dataBase64 must be base64");
            bytes = Buffer.from(params.dataBase64, "base64");
        }
        if (!bytes.length) invalid("RTT input is empty");
        if (bytes.length > MAX_INPUT_BYTES) invalid(`RTT input is limited to ${MAX_INPUT_BYTES} bytes`);
        const status = this.host._rtt.status();
        if (status.state !== "running")
            throw Object.assign(new Error(`RTT is ${status.state || "stopped"}`), {
                code: "RTT_NOT_RUNNING",
                details: { state: status.state }
            });
        const up = (status.channels?.up || []).find((entry) => entry.index === channel);
        if (!up)
            throw Object.assign(new Error(`RTT channel ${channel} is not available`), {
                code: "RTT_UNKNOWN_CHANNEL",
                details: { channel }
            });
        const downChannel = up.downChannel ?? channel;
        const generation = (status.buffers || []).find((entry) => entry.channel === channel)?.generation ?? null;
        const trust = this._trust(channel);
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        return {
            channel,
            bytes,
            echo,
            trust,
            // A reattachment (new generation or control block) or other bytes need a new confirmation.
            identity: {
                trust,
                channel,
                downChannel,
                generation,
                block: status.block?.address ?? null,
                sha256,
                length: bytes.length
            },
            // What the user approves: the exact input, and the firmware a remembered grant would cover.
            preview: {
                rttInput: {
                    channel,
                    downChannel,
                    bytes: bytes.length,
                    sha256,
                    ...(hasText ? { text: params.text, lineEnding: ending } : { dataBase64: params.dataBase64 })
                },
                ...(trust
                    ? {
                          elf: { path: trust.elfPath, sha256: trust.elfSha256 },
                          target: trust.target,
                          probe: trust.probe
                      }
                    : {})
            }
        };
    }

    // The firmware identity a remembered grant is bound to; null when the ELF digest is unknown.
    _trust(channel) {
        const state = this.host._context?.workspaceState;
        let sha256 = "";
        try {
            sha256 = String(this.host.readElfSymbols?.()?.elf?.sha256 || "");
        } catch {
            sha256 = "";
        }
        const elfPath = String(state?.get(CACHE_KEYS.elfPath) || "");
        if (!sha256 || !elfPath) return null;
        return {
            channel,
            elfPath,
            elfSha256: sha256,
            probe: String(state.get(CACHE_KEYS.debugger) || ""),
            target: String(state.get(CACHE_KEYS.mcuCore) || "")
        };
    }

    async start(params = {}) {
        validate(params, []);
        await this.host._rttTerminals.startAgentCommand();
        return this.status();
    }

    async stop(params = {}) {
        validate(params, []);
        await this.host._rttTerminals.stopCommand();
        return this.status();
    }
}

module.exports = { RttAgentService };
