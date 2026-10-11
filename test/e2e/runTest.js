"use strict";
const path = require("path");
const fs = require("fs/promises");
const { runTests } = require("@vscode/test-electron");

(async () => {
    const root = path.resolve(__dirname, "../..");
    const userData = path.join(root, ".vscode-test", "e2e-user-data-" + process.pid);
    const extensions = path.join(root, ".vscode-test", "e2e-extensions-" + process.pid);
    try {
        await runTests({
            version: "1.136.1",
            extensionDevelopmentPath: root,
            extensionTestsPath: path.resolve(__dirname, "suite"),
            launchArgs: [
                path.resolve(__dirname, "fixtures"),
                "--user-data-dir=" + userData,
                "--extensions-dir=" + extensions,
                "--disable-extensions",
                "--disable-gpu",
                "--skip-welcome",
                "--skip-release-notes"
            ],
            extensionTestsEnv: {
                EMBERPROBE_E2E: "1"
            }
        });
    } catch (error) {
        console.error("Extension Host tests failed:", error);
        process.exitCode = 1;
        try {
            await fs.cp(path.join(userData, "logs"), path.join(root, "test-results", "e2e", "logs"), {
                recursive: true
            });
        } catch (logError) {
            if (logError.code !== "ENOENT") console.error("Cannot preserve VS Code logs:", logError);
        }
    } finally {
        for (const directory of [userData, extensions])
            await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
