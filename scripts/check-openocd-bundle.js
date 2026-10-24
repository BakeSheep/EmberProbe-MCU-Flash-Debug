"use strict";

const { verifyBundle } = require("./openocd-bundle");

async function main() {
    await verifyBundle();
    if (["win32", "linux"].includes(process.platform) && process.arch === "x64") {
        await require("./check-openocd-noecho").main({ scatter: true });
    }
    console.log("Bundled OpenOCD identities, dependencies, sources and native smoke tests passed");
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

module.exports = { main };
