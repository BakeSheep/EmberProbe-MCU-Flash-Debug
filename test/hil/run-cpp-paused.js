"use strict";

// Read-only attach acceptance. Unlike run-hil.js this never downloads firmware.
const fs = require("fs/promises");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

(async () => {
    for (const key of ["CPP_BOARD_ELF", "CPP_BOARD_GDB", "CPP_BOARD_PROBE", "CPP_BOARD_TARGET"])
        if (!process.env[key]) throw new Error(`${key} is required for explicit board selection`);
    const root = path.resolve(__dirname, "../..");
    const temporary = path.join(root, ".vscode-test", `cpp-board-${process.pid}`);
    const allowed = path.join(root, ".vscode-test") + path.sep;
    if (!path.resolve(temporary).startsWith(allowed)) throw new Error("Unsafe board test cleanup path");
    const workspace = path.join(temporary, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    try {
        await runTests({
            version: "1.136.1",
            extensionDevelopmentPath: root,
            extensionTestsPath: path.resolve(__dirname, "cpp-paused.test.js"),
            extensionTestsEnv: { EMBERPROBE_E2E: "1" },
            launchArgs: [
                workspace,
                `--user-data-dir=${temporary}/user-data`,
                `--extensions-dir=${temporary}/extensions`,
                "--disable-extensions",
                "--disable-gpu",
                "--skip-welcome",
                "--skip-release-notes"
            ]
        });
    } finally {
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
