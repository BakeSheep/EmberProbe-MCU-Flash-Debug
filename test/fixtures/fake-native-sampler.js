"use strict";
const { ProbeRsDecoder } = require("../../src/probeRsProtocol");
const { nativeSampleFrame } = require("../helpers/native-sampler-fixture");
let previous = null;
let time = 1000;
function reply(id, result) {
    const data = Buffer.from(JSON.stringify({ id, ok: true, result }));
    const frame = Buffer.alloc(data.length + 5);
    frame.writeUInt32LE(data.length + 1);
    frame[4] = 1;
    data.copy(frame, 5);
    process.stdout.write(frame);
}
const decoder = new ProbeRsDecoder(({ value: request }) => {
    if (request.method === "start")
        reply(request.id, {
            protocol: 1,
            elfSha256: request.params.elfSha256,
            ramRanges: [{ start: 0x20000000, end: 0x20001000 }]
        });
    else if (request.method === "plan") {
        if (previous) process.stdout.write(previous);
        reply(request.id, true);
        const plan = request.params;
        const recipe = plan.graph && plan.sidebar ? 3 : plan.graph ? 1 : 2;
        const count = plan.recipes[recipe].reduce((total, range) => total + range.count, 0);
        if (plan.enabled && count) {
            time += 10;
            previous = nativeSampleFrame(plan.generation, recipe, count, [time, time + 1]);
            process.stdout.write(previous);
        }
    } else if (request.method === "read")
        reply(request.id, { bytes: request.params.flatMap((range) => Array(range.count).fill(7)), t: time });
    else if (request.method === "stop") {
        reply(request.id, true);
        process.stdin.pause();
        process.exitCode = 0;
        process.stdin.destroy();
    } else reply(request.id, true);
});
process.stdin.on("data", (chunk) => decoder.receive(chunk));
