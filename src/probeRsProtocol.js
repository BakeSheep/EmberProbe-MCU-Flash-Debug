"use strict";
const MAX_FRAME_BYTES = 1024 * 1024;

function protocolError(message) {
    return Object.assign(new Error(message), { code: "PROBE_RS_PROTOCOL_ERROR", retryable: false });
}

function encodeRequest(id, method, params) {
    const body = Buffer.from(JSON.stringify({ id, method, params }));
    if (body.length + 1 > MAX_FRAME_BYTES) throw protocolError("Native request exceeds the frame budget");
    const frame = Buffer.allocUnsafe(body.length + 5);
    frame.writeUInt32LE(body.length + 1, 0);
    frame[4] = 1;
    body.copy(frame, 5);
    return frame;
}

function decodeSamples(body) {
    if (body.length < 12) throw protocolError("Truncated native sample header");
    const generation = body.readUInt32LE(1);
    const recipe = body[5];
    const count = body.readUInt16LE(6);
    const byteCount = body.readUInt32LE(8);
    if (
        !generation ||
        recipe < 1 ||
        recipe > 3 ||
        count < 1 ||
        count > 64 ||
        byteCount < 1 ||
        byteCount > 4096 ||
        body.length !== 12 + count * (12 + byteCount)
    )
        throw protocolError("Invalid native sample shape");
    const samples = [];
    for (let offset = 12; offset < body.length; offset += 12 + byteCount) {
        const t = body.readDoubleLE(offset);
        const durationMs = body.readFloatLE(offset + 8);
        if (!Number.isFinite(t) || t < 0 || !Number.isFinite(durationMs) || durationMs < 0)
            throw protocolError("Invalid native sample timestamp");
        if (samples.length && t < samples.at(-1).t) throw protocolError("Native sample timestamps are unordered");
        samples.push({ t, durationMs, bytes: body.subarray(offset + 12, offset + 12 + byteCount) });
    }
    return { generation, recipe, byteCount, samples };
}

class ProbeRsDecoder {
    constructor(onMessage) {
        this.onMessage = onMessage;
        this.buffer = Buffer.alloc(0);
    }
    receive(chunk) {
        if (this.buffer.length + chunk.length > MAX_FRAME_BYTES * 2)
            throw protocolError("Native receive buffer exceeds its budget");
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (length < 2 || length > MAX_FRAME_BYTES) throw protocolError("Invalid native frame length");
            if (this.buffer.length < length + 4) return;
            const body = this.buffer.subarray(4, length + 4);
            this.buffer = this.buffer.subarray(length + 4);
            if (body[0] === 2) this.onMessage({ type: "samples", ...decodeSamples(body) });
            else if (body[0] === 1) {
                let value;
                try {
                    value = JSON.parse(body.toString("utf8", 1));
                } catch {
                    throw protocolError("Invalid native JSON response");
                }
                if (!value || typeof value !== "object" || Array.isArray(value))
                    throw protocolError("Invalid native response");
                this.onMessage({ type: "control", value });
            } else throw protocolError("Unsupported native frame type");
        }
    }
}
module.exports = { ProbeRsDecoder, encodeRequest, decodeSamples, protocolError, MAX_FRAME_BYTES };
