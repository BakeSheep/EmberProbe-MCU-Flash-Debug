"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

// Runs a production CommonJS module (`file` relative to the repository root) with the named `require` results replaced;
// everything else resolves as usual. The source is compiled unchanged under its file URL, as Node compiles modules, so
// coverage maps back to the file.
function loadModule(file, overrides = {}) {
    const filename = path.resolve(__dirname, "../..", file);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const run = vm.compileFunction(
        fs.readFileSync(filename, "utf8"),
        ["require", "module", "exports", "__dirname", "__filename"],
        { filename: pathToFileURL(filename).href }
    );
    run(
        (name) => (Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name)),
        module,
        module.exports,
        path.dirname(filename),
        filename
    );
    return module.exports;
}

module.exports = { loadModule };
