"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { runTests } = require("@vscode/test-electron");

async function main() {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES" || process.env.EMBERPROBE_HIL_MOTORS_ISOLATED !== "YES")
        throw new Error(
            "Set EMBERPROBE_HIL_CONFIRM=YES and EMBERPROBE_HIL_MOTORS_ISOLATED=YES after disconnecting motor power"
        );
    for (const key of [
        "EMBERPROBE_HIL_PROJECT",
        "EMBERPROBE_HIL_ELF",
        "EMBERPROBE_HIL_CHIP",
        "EMBERPROBE_HIL_PROBE_RS"
    ])
        if (!process.env[key]) throw new Error(`Set ${key}`);
    const root = path.resolve(__dirname, "../../..");
    const userData = path.join(root, ".vscode-test", "f407-user-" + process.pid);
    const extensions = path.join(root, ".vscode-test", "f407-extensions-" + process.pid);
    try {
        await runTests({
            version: "1.136.1",
            ...(process.env.EMBERPROBE_E2E_VSCODE_PATH
                ? { vscodeExecutablePath: process.env.EMBERPROBE_E2E_VSCODE_PATH }
                : {}),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, "suite"),
            launchArgs: [
                process.env.EMBERPROBE_HIL_PROJECT,
                "--user-data-dir=" + userData,
                "--extensions-dir=" + extensions,
                "--disable-extensions",
                "--disable-workspace-trust",
                "--disable-gpu",
                "--skip-welcome",
                "--skip-release-notes"
            ],
            extensionTestsEnv: {
                EMBERPROBE_E2E: "1",
                EMBERPROBE_HIL_ELF: process.env.EMBERPROBE_HIL_ELF,
                EMBERPROBE_HIL_CHIP: process.env.EMBERPROBE_HIL_CHIP,
                EMBERPROBE_HIL_PROBE_RS: process.env.EMBERPROBE_HIL_PROBE_RS,
                EMBERPROBE_HIL_PROBE: process.env.EMBERPROBE_HIL_PROBE || "",
                EMBERPROBE_HIL_BACKUP: process.env.EMBERPROBE_HIL_BACKUP || "",
                EMBERPROBE_HIL_REPORT: path.join(root, "test-results", "probe-rs-f407.json")
            }
        });
    } catch (error) {
        try {
            await fs.cp(path.join(userData, "logs"), path.join(root, "test-results", "f407-host-logs"), {
                recursive: true
            });
        } catch (logError) {
            if (logError.code !== "ENOENT") console.error(logError);
        }
        throw error;
    } finally {
        await Promise.all(
            [userData, extensions].map((directory) => fs.rm(directory, { recursive: true, force: true }))
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
