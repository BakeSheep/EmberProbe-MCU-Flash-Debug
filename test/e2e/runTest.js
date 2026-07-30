"use strict";
const path = require("path");
const { runTests } = require("@vscode/test-electron");

(async () => {
    const root = path.resolve(__dirname, "../..");
    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath: path.resolve(__dirname, "suite"),
            launchArgs: [
                path.resolve(__dirname, "fixtures"),
                "--disable-extensions",
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
    }
})();
