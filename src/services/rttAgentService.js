"use strict";

const { utf8Boundary } = require("../rttBuffer");

const MAX_UTF8_BYTES = 4;

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
