"use strict";

async function run() {
    await require("./smoke.test").run();
    await require("./debug.test").run();
    await require("./packaged-debug.test").run();
}

module.exports = { run };
