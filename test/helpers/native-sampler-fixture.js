"use strict";
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { ProbeRsDecoder, encodeRequest } = require("../../src/probeRsProtocol");

function nativeSamplerFixture({ clock, onRequest, exitOnStop = true } = {}) {
    const child = new EventEmitter();
    Object.assign(child, {
        pid: 123456,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough()
    });
    const requests = [];
    const respond = (id, result, error) => {
        const frame = encodeRequest(id, "unused", null);
        const value = Buffer.from(JSON.stringify(error ? { id, ok: false, error } : { id, ok: true, result }));
        const response = Buffer.alloc(value.length + 5);
        response.writeUInt32LE(value.length + 1);
        response[4] = frame[4];
        value.copy(response, 5);
        child.stdout.write(response);
    };
    const close = () => child.emit("close", 0);
    child.kill = () => {
        child.killed = true;
        if (exitOnStop) close();
        return exitOnStop;
    };
    child.stdin.on("finish", () => {
        if (exitOnStop) close();
    });
    const decoder = new ProbeRsDecoder(({ value }) => {
        requests.push(value);
        if (onRequest?.(value, respond, child) === false) return;
        if (value.method === "start")
            respond(value.id, {
                protocol: 1,
                speedKhz: 1000,
                elfSha256: value.params.elfSha256,
                ramRanges: [{ start: 0x20000000, end: 0x20001000 }]
            });
        else if (value.method === "read")
            respond(value.id, {
                t: clock?.now() || 1000,
                bytes: value.params.flatMap((range) => Array(range.count).fill(7))
            });
        else respond(value.id, true);
        if (value.method === "stop" && exitOnStop) close();
    });
    child.stdin.on("data", (chunk) => decoder.receive(chunk));
    return { child, requests, respond, close, spawn: () => child };
}
function nativeSampleFrame(generation, recipe, byteCount, times = [1000, 1001]) {
    const frame = Buffer.alloc(16 + times.length * (12 + byteCount));
    frame.writeUInt32LE(frame.length - 4);
    frame[4] = 2;
    frame.writeUInt32LE(generation, 5);
    frame[9] = recipe;
    frame.writeUInt16LE(times.length, 10);
    frame.writeUInt32LE(byteCount, 12);
    times.forEach((t, index) => {
        const offset = 16 + index * (12 + byteCount);
        frame.writeDoubleLE(t, offset);
        frame.writeFloatLE(0.25, offset + 8);
        frame.fill(7, offset + 12, offset + 12 + byteCount);
    });
    return frame;
}
module.exports = { nativeSamplerFixture, nativeSampleFrame };
