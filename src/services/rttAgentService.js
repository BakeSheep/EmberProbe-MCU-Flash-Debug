"use strict";

const { utf8Boundary } = require("../rttBuffer");

const MAX_UTF8_BYTES = 4;

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

// Agent-only projection and cursor handling. Status and reads never acquire a probe or start a session.
class RttAgentService {
    constructor(host) {
        this.host = host;
    }

    status(params = {}) {
        validate(params, []);
        const { state, source, reason, yieldedFor, retry, block, channels, missingChannels, buffers, error } =
            this.host._rtt.status();
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
            error: error ? { code: error.code, message: error.message } : null
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
        const { data, ...reply } = this.host._rtt.read(channel, { generation, cursor, maxBytes: limit, encoding });
        if (encoding === "base64") return { channel, ...reply, dataBase64: data.toString("base64") };
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
