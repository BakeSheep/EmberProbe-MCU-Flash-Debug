"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
// Load the complete CommonJS module with only the VS Code host dependency replaced.
// No source extraction or regex assertions: tests execute production methods.
function loadProvider(vscode = {}, overrides = {}) {
    const filename = path.resolve(__dirname, "../../src/mainViewProvider.js");
    const localRequire = createRequire(filename);
    const exports = {};
    const run = vm.runInThisContext(
        "(function(require,module,exports,__dirname,__filename){" + fs.readFileSync(filename, "utf8") + "\n})",
        { filename }
    );
    run(
        (name) => (name === "vscode" ? vscode : Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name)),
        { exports },
        exports,
        path.dirname(filename),
        filename
    );
    return exports.MainViewProvider;
}
module.exports = { loadProvider };
