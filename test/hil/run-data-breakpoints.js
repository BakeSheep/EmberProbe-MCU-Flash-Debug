"use strict";

// Opt-in hardware acceptance through the actual development extension. Never flashes or resets.
const fs = require("fs/promises");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

(async () => {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES for board testing");
    if (!process.env.DATA_BP_HIL_PROFILE) throw new Error("DATA_BP_HIL_PROFILE must select an explicit board profile");
    const profile = JSON.parse(await fs.readFile(process.env.DATA_BP_HIL_PROFILE, "utf8"));
    for (const key of ["elf", "gdb", "openocd", "probe", "target", "probeSerial", "aggregate"])
        if (!profile[key]) throw new Error(`Missing board profile ${key}`);
    if (!Array.isArray(profile.checks) || !profile.checks.length)
        throw new Error("The profile must select variable checks");
    for (const check of profile.checks) {
        if (typeof check.expression !== "string" || !check.expression.trim())
            throw new Error("Every check needs an expression");
        if (
            !Array.isArray(check.accessTypes) ||
            !check.accessTypes.length ||
            check.accessTypes.some((type) => !["write", "read", "readWrite"].includes(type))
        )
            throw new Error("Every check needs supported accessTypes");
        if (check.rounds !== undefined && (!Number.isInteger(check.rounds) || check.rounds < 1 || check.rounds > 20))
            throw new Error("Check rounds must be between 1 and 20");
    }
    const root = path.resolve(__dirname, "../..");
    const reportFile = path.join(root, "test-results", "data-breakpoints-board.json");
    try {
        const previous = JSON.parse(await fs.readFile(reportFile, "utf8"));
        const stamp = previous.startedAt.replace(/[:.]/g, "-");
        await fs.copyFile(reportFile, path.join(root, "test-results", `data-breakpoints-board-${stamp}.json`));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(root, ".vscode-test", `data-breakpoints-board-${process.pid}`);
    const workspace = path.join(temporary, "workspace");
    const tmp = path.join(temporary, "tmp");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(tmp, { recursive: true });
    profile.elfRelative = path.basename(profile.elf);
    await fs.copyFile(profile.elf, path.join(workspace, profile.elfRelative));
    try {
        await runTests({
            ...(process.env.DATA_BP_VSCODE
                ? { vscodeExecutablePath: process.env.DATA_BP_VSCODE }
                : { version: "1.136.1" }),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, "data-breakpoints.test.js"),
            extensionTestsEnv: {
                EMBERPROBE_E2E: "1",
                EMBERPROBE_DATA_BP_PROFILE: JSON.stringify(profile),
                TEMP: tmp,
                TMP: tmp,
                TMPDIR: tmp
            },
            launchArgs: [
                workspace,
                `--user-data-dir=${temporary}/user-data`,
                `--extensions-dir=${temporary}/extensions`,
                ...(profile.cdpPort ? [`--remote-debugging-port=${profile.cdpPort}`] : []),
                "--disable-extensions",
                "--disable-workspace-trust",
                "--disable-gpu",
                "--skip-welcome",
                "--skip-release-notes"
            ]
        });
    } catch (error) {
        const logs = path.join(root, "test-results", "data-breakpoints-board-logs");
        await fs.cp(path.join(temporary, "user-data", "logs"), logs, { recursive: true }).catch(() => {});
        throw error;
    } finally {
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
