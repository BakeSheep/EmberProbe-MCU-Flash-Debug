"use strict";

const fs = require("fs");

// The extension formatter only needs these byte-array operations from Node's Buffer.
function browserSource() {
    const source = fs
        .readFileSync(require.resolve("../src/rttLineFormatter"), "utf8")
        .replace(
            'const { SYSTEM_CLOCK } = require("./samplingClock");',
            "const SYSTEM_CLOCK = { now: () => Date.now() };"
        )
        .replace("module.exports =", "root.EmberProbeMockRttFormatter =");
    return `(function (root) {
        const Buffer = {
            from(text, encoding) {
                return encoding === "latin1"
                    ? Uint8Array.from(text, (char) => char.charCodeAt(0))
                    : new TextEncoder().encode(text);
            },
            of: (...bytes) => Uint8Array.of(...bytes),
            alloc: (size) => new Uint8Array(size),
            isBuffer: (value) => value instanceof Uint8Array,
            concat(chunks) {
                const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
                let start = 0;
                for (const chunk of chunks) {
                    result.set(chunk, start);
                    start += chunk.length;
                }
                return result;
            }
        };
        ${source}
    })(window);`;
}

module.exports = { browserSource };
