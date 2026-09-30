"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { deflateRawSync } = require("zlib");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/debug/stl.js"));
// Both extension.js and debugAdapter.js contain the display module. Even without
// compression their combined added code must fit the 0.5 MB release budget.
assert(source.length * 2 < 500000, "Built-in STL code exceeds the package growth budget");
const manifest = require("../package.json");
assert(!manifest.files.some((entry) => /^(?:test|test-results|node_modules)(?:\/|$)/.test(entry)));
function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        assert(!/arm-none-eabi|python|gdb|cpp-debug|xpack-arm/i.test(entry.name), "Do not bundle a debugger runtime");
        if (entry.isDirectory()) inspect(path.join(directory, entry.name));
    }
}
inspect(path.join(root, "resources"));
console.log(
    `STL package budget: ${source.length * 2} uncompressed bytes, ${deflateRawSync(source).length * 2} compressed code bytes; no extra runtime`
);
