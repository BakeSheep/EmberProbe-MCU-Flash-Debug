"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Node executes this fixture through the ordinary CLI "download" argument.
// This fixture only validates a local snapshot; it never opens a probe.
const args = process.argv.slice(2);
assert.ok(args.includes("--verify"));
assert.ok(args.includes("--reset"));
assert.equal(args[args.indexOf("--binary-format") + 1], "elf");
const snapshot = args.at(-1);
assert.equal(path.basename(snapshot), "firmware.elf");
const bytes = fs.readFileSync(snapshot);
assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
for (const stage of ["Erasing flash", "Programming flash", "Verifying flash", "Resetting target"])
    process.stderr.write(stage + "\n");
console.log(
    "EP_FLASH_SNAPSHOT=" + JSON.stringify({ snapshot, sha256: createHash("sha256").update(bytes).digest("hex") })
);
