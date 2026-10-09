"use strict";
const fs = require("fs");
const path = require("path");
const summary = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../coverage/coverage-summary.json"), "utf8"));
const modules = [
    "debugLifecycle.js",
    "probeRsDebugAdapter.js",
    "samplingCoordinator.js",
    "cpuLoadService.js",
    "watchListStore.js",
    "agentRoutes.js",
    "agentFlashService.js",
    "humanApprovalService.js",
    "svdDerivation.js",
    "svdWriteConstraints.js",
    "svdModelService.js",
    "svdPeripheralService.js",
    "elfService.js",
    "peripheralViewService.js"
];
const thresholds = { lines: 80, statements: 80, functions: 75, branches: 65 };
for (const name of modules) {
    const entry = Object.entries(summary).find(([file]) => file.replace(/\\/g, "/").endsWith("/src/services/" + name));
    if (!entry) throw new Error("Missing coordinator coverage: " + name);
    for (const [metric, minimum] of Object.entries(thresholds)) {
        if (entry[1][metric].pct < minimum)
            throw new Error(`${name}: ${metric} ${entry[1][metric].pct}% < ${minimum}%`);
    }
}
for (const suffix of ["/skills/_emberprobe/elf-file.js", "/src/svdWorker.js"]) {
    const entry = Object.entries(summary).find(([file]) => file.replace(/\\/g, "/").endsWith(suffix));
    if (!entry) throw new Error("Missing safety coverage: " + suffix);
    for (const [metric, minimum] of Object.entries(thresholds))
        if (entry[1][metric].pct < minimum) throw new Error(suffix + ": insufficient " + metric + " coverage");
}
console.log("Coordinator and safety coverage gates passed");
