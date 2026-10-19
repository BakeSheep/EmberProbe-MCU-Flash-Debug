"use strict";

// Running-write acceptance on an already flashed board. Writes only the firmware's RAM write targets.
const fs = require("fs/promises");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

(async () => {
    for (const key of ["RUNTIME_BOARD_ELF", "RUNTIME_BOARD_GDB", "RUNTIME_BOARD_PROBE", "RUNTIME_BOARD_TARGET"])
        if (!process.env[key]) throw new Error(`${key} is required for explicit board selection`);
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES for a dedicated board running the probe-lab stress firmware");
    const root = path.resolve(__dirname, "../..");
    // A separate bundle (for example a baseline release checkout) can be exercised with the same test.
    const extensionRoot = path.resolve(process.env.RUNTIME_BOARD_EXTENSION || root);
    const temporary = path.join(root, ".vscode-test", `runtime-write-${process.pid}`);
    const allowed = path.join(root, ".vscode-test") + path.sep;
    if (!path.resolve(temporary).startsWith(allowed)) throw new Error("Unsafe board test cleanup path");
    const workspace = path.join(temporary, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(temporary, "tmp"), { recursive: true });
    try {
        await runTests({
            version: "1.136.1",
            extensionDevelopmentPath: extensionRoot,
            extensionTestsPath: path.resolve(__dirname, "runtime-write.test.js"),
            extensionTestsEnv: {
                EMBERPROBE_E2E: "1",
                RUNTIME_BOARD_RESULTS: path.join(root, "test-results"),
                RUNTIME_BOARD_TMP: path.join(temporary, "tmp")
            },
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
