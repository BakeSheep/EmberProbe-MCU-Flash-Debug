"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { runTests } = require("@vscode/test-electron");

async function main() {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES") throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES");
    if (!process.env.EMBERPROBE_HIL_ELF) throw new Error("Set EMBERPROBE_HIL_ELF");
    const root = path.resolve(__dirname, "../../..");
    const userData = path.join(root, ".vscode-test", "hil-user-" + process.pid);
    const extensions = path.join(root, ".vscode-test", "hil-extensions-" + process.pid);
    const chartCapture =
        process.env.EMBERPROBE_HIL_CHART_CAPTURE ||
        path.join(root, ".vscode-test", "hil-chart-" + process.pid + ".json");
    try {
        await runTests({
            version: "1.136.1",
            ...(process.env.EMBERPROBE_E2E_VSCODE_PATH
                ? { vscodeExecutablePath: process.env.EMBERPROBE_E2E_VSCODE_PATH }
                : {}),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, "suite"),
            launchArgs: [
                path.join(root, "test/hil/fixtures/embassy-h723"),
                "--user-data-dir=" + userData,
                "--extensions-dir=" + extensions,
                "--disable-extensions",
                "--disable-gpu",
                "--skip-welcome",
                "--skip-release-notes"
            ],
            extensionTestsEnv: {
                EMBERPROBE_E2E: "1",
                EMBERPROBE_HIL_ELF: process.env.EMBERPROBE_HIL_ELF,
                EMBERPROBE_HIL_CHIP: process.env.EMBERPROBE_HIL_CHIP || "STM32H723VGTx",
                EMBERPROBE_HIL_PROBE: process.env.EMBERPROBE_HIL_PROBE || "",
                EMBERPROBE_HIL_CHART_CAPTURE: chartCapture
            }
        });
        execFileSync(process.execPath, [path.join(root, "test/hil/chart-render-capture.js"), chartCapture], {
            cwd: root,
            stdio: "inherit"
        });
    } finally {
        await Promise.all(
            [userData, extensions].map((directory) => fs.rm(directory, { recursive: true, force: true }))
        );
        if (!process.env.EMBERPROBE_HIL_CHART_CAPTURE) await fs.rm(chartCapture, { force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
