"use strict";
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const sourceFiles = [
    "src/extension.js",
    "src/modernView.js",
    "src/i18n.js",
    "src/autoDetect.js",
    "src/agentBridge.js",
    "src/skillInstaller.js",
    "src/openocdRunner.js",
    "src/openocdScripts.js",
    "src/openocdChecker.js",
    "src/openocdInstaller.js",
    "src/elfSymbols.js",
    "src/dwarf.js",
    "src/chipInfo.js",
    "src/faultInfo.js",
    "src/liveWatch.js",
    "src/liveWatchView.js",
    "src/validation.js",
    "src/writeAuthorization.js",
    "src/probeCoordinator.js",
    "src/webviewAssets.js",
    "src/services/configurationStore.js",
    "src/services/flashService.js",
    "src/services/faultService.js",
    "src/services/agentService.js",
    "scripts/release.js",
    "scripts/run-tests.js",
    "test/hil/run-hil.js",
    "skills/_emberprobe/agent-client.js",
    "skills/mcu-config/scripts/config.js",
    "skills/mcu-chip-info/scripts/read-chip.js",
    "skills/mcu-live-watch/scripts/read-live.js",
    "skills/mcu-var-write/scripts/write-var.js",
    "skills/mcu-fault-analyzer/scripts/analyze-fault.js",
    "skills/mcu-elf-analyze/scripts/analyze-elf.js"
];

const allTests = [
    "test/release-consistency.test.js",
    "test/release-script.test.js",
    "test/probe-coordinator.test.js",
    "test/services.test.js",
    "test/webview-assets.test.js",
    "test/hil-runner.test.js",
    "test/auto-detect.test.js",
    "test/agent-skills.test.js",
    "test/skill-installer.test.js",
    "test/openocd-parser.test.js",
    "test/openocd-scripts.test.js",
    "test/elf-symbols.test.js",
    "test/validation.test.js",
    "test/composite-decode.test.js",
    "test/dwarf-composite.test.js",
    "test/webview.test.js",
    "test/live-watch-integration.test.js",
    "test/openocd-checker.test.js",
    "test/openocd-installer.test.js",
    "test/chip-info.test.js",
    "test/elf-analyze.test.js",
    "test/var-write.test.js",
    "test/fault-info.test.js",
    "test/write-authorization.test.js",
    "test/powershell-skills.test.js"
];

const qualityTests = [
    "test/release-script.test.js",
    "test/probe-coordinator.test.js",
    "test/services.test.js",
    "test/webview-assets.test.js",
    "test/hil-runner.test.js"
];

function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

const qualityOnly = process.argv.includes("--quality");
if (!qualityOnly) {
    for (const file of sourceFiles) run(["--check", file]);
}
for (const file of qualityOnly ? qualityTests : allTests) run([file]);
