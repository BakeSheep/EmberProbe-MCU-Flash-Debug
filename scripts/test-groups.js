"use strict";

const fs = require("fs");
const path = require("path");

// Explicit membership makes adding a test an intentional classification decision.
// External GDB, Extension Host and HIL suites keep their dedicated entry points.
const TEST_GROUPS = Object.freeze({
    // Pure in-process unit tests (no child processes, sockets or Worker threads), each well under a second.
    fast: Object.freeze([
        "agent-chat-confirmation.test.js",
        "agent-routes.test.js",
        "agent-sampling-control.test.js",
        "agent-service.test.js",
        "agent-watch-identity.test.js",
        "attach-debug-command.test.js",
        "auto-detect.test.js",
        "build-info.test.js",
        "chart-viewport.test.js",
        "chip-control.test.js",
        "chip-info-service.test.js",
        "chip-info.test.js",
        "ci-test-topology.test.js",
        "composite-decode.test.js",
        "configuration-store.test.js",
        "contracts.test.js",
        "cortex-toolchain.test.js",
        "cpp-class-layout.test.js",
        "cpp-class-variables.test.js",
        "cpp-debug-variables.test.js",
        "cpp-display-name.test.js",
        "cpp-pretty-printing.test.js",
        "cpp-stl-display.test.js",
        "cpp-symbol-identity.test.js",
        "cpu-load-metadata.test.js",
        "cpu-load-model.test.js",
        "cpu-load-sampler.test.js",
        "cubemx-candidate.test.js",
        "cubemx-ioc-size-guard.test.js",
        "cubemx-workspace-isolation.test.js",
        "debug-console.test.js",
        "debug-control.test.js",
        "debug-images.test.js",
        "debug-performance.test.js",
        "debug-scopes.test.js",
        "debug-session-bridge.test.js",
        "debug-session-routing.test.js",
        "dwarf-budget.test.js",
        "dwarf-composite.test.js",
        "dwarf-formats.test.js",
        "dwarf-layout-expansion.test.js",
        "dwarf-type-matrix.test.js",
        "dwarf-zstd-budget.test.js",
        "elf-analyze.test.js",
        "elf-service.test.js",
        "elf-symbols.test.js",
        "elf-write-readiness.test.js",
        "enum-variables.test.js",
        "external-debug-host.test.js",
        "extracted-services.test.js",
        "fault-service.test.js",
        "flash-refresh.test.js",
        "flash-safety.test.js",
        "flash-service.test.js",
        "flash-speed.test.js",
        "flash-workspace-permission.test.js",
        "hil-runner.test.js",
        "hil-smoke-profile.test.js",
        "java-properties.test.js",
        "jlink-driver-choice.test.js",
        "jlink-probe-ready.test.js",
        "layered-sampling.test.js",
        "layout-expansion-host.test.js",
        "layout-expansion-paths.test.js",
        "live-read-batch-cache.test.js",
        "live-watch-disconnect.test.js",
        "live-watch-integration.test.js",
        "live-watch-response.test.js",
        "live-watch-service.test.js",
        "member-roles.test.js",
        "openocd-compatibility.test.js",
        "openocd-parser.test.js",
        "openocd-scripts.test.js",
        "openocd-status-service.test.js",
        "openocd-target-bundle.test.js",
        "pointer-symbolizer.test.js",
        "pretty-printing-modes.test.js",
        "probe-automatic.test.js",
        "probe-connection-service.test.js",
        "probe-coordinator.test.js",
        "probe-driver-service.test.js",
        "probe-selection.test.js",
        "probe-success-entrypoints.test.js",
        "provider-state.test.js",
        "release-script.test.js",
        "release-workflow.test.js",
        "rtos-snapshot.test.js",
        "runtime-native-layouts.test.js",
        "runtime-objects.test.js",
        "runtime-pointer-fallback.test.js",
        "sampling-clock.test.js",
        "sampling-frequency.test.js",
        "sampling-rate-motion.test.js",
        "sampling-throughput.test.js",
        "shared-debug-group.test.js",
        "skill-status-service.test.js",
        "stl-containers.test.js",
        "svd-peripheral.test.js",
        "symbol-images.test.js",
        "validate-release.test.js",
        "validation.test.js",
        "var-write.test.js",
        "verify-sampling-timer-vsix.test.js",
        "webview-render-order.test.js",
        "windows-probe-inventory.test.js",
        "write-authorization.test.js",
        "write-connection.test.js"
    ]),
    integration: Object.freeze([
        "cpu-load-integration.test.js",
        "cpu-load-safety.test.js",
        "cpu-load-view.test.js",
        "adaptive-sampling.test.js",
        "agent-debug-inspection.test.js",
        "agent-diagnostics.test.js",
        "agent-lifecycle.test.js",
        "agent-skills.test.js",
        "agent-static-variables.test.js",
        "agent-cu-static-variables.test.js",
        "bridge-security.test.js",
        "chart-controls.test.js",
        "chart-experience.test.js",
        "chart-host.test.js",
        "chart-history-worker.test.js",
        "chart-history-summary.test.js",
        "chart-history-capacity.test.js",
        "chart-history-recording.test.js",
        "chart-remote-history.test.js",
        "composite-history.test.js",
        "chart-presentation.test.js",
        "chart-render-budget.test.js",
        "chart-retention.test.js",
        "chart-restore.test.js",
        "cortex-debug-integration.test.js",
        "cortex-debug-preflight.test.js",
        "cpp-variable-names.test.js",
        "cpp-webview.test.js",
        "csv-export.test.js",
        "sampling-export-flow.test.js",
        "cubemx-firmware.test.js",
        "cubemx-generation-safety.test.js",
        "cubemx-integration.test.js",
        "cubemx-linux.test.js",
        "cubemx.test.js",
        "daplink-flash.test.js",
        "debug-lifecycle-races.test.js",
        "debug-stop-release.test.js",
        "docs-cleanup.test.js",
        "debug-server-controller.test.js",
        "external-debug.test.js",
        "dwarf-deep-layout.test.js",
        "dwarf-skip-locals.test.js",
        "dwarf-global-budget.test.js",
        "elf-variable-filtering.test.js",
        "elf-webview-lazy.test.js",
        "elf-diagnostic-language.test.js",
        "live-watch-layout.test.js",
        "layout-expansion-ui.test.js",
        "elf-worker.test.js",
        "ember-debug.test.js",
        "fault-info.test.js",
        "flash-process.test.js",
        "flash-skills.test.js",
        "jlink-diagnostics.test.js",
        "memory-analysis.test.js",
        "memory-sidebar.test.js",
        "mockup.test.js",
        "new-skills.test.js",
        "openocd-checker.test.js",
        "openocd-entrypoints.test.js",
        "openocd-exec.test.js",
        "openocd-installer.test.js",
        "peripheral-view.test.js",
        "peripheral-viewer-integration.test.js",
        "probe-connection.test.js",
        "rtos-view.test.js",
        "runtime-nested-selection.test.js",
        "runtime-refresh.test.js",
        "runtime-selection.test.js",
        "sampling-archive.test.js",
        "sampling-isolation.test.js",
        "sidebar-sections.test.js",
        "sidebar-status-restore.test.js",
        "skill-installer.test.js",
        "svd-manager.test.js",
        "svd-model.test.js",
        "svd-services.test.js",
        "test-runner.test.js",
        "unlimited-sampling.test.js",
        "unlimited-sampling-host.test.js",
        "value-display.test.js",
        "variable-origin.test.js",
        "variable-disambiguation.test.js",
        "verify-driver-helper.test.js",
        "webview-assets.test.js",
        "sampling-rate-picker.test.js",
        "webview-runtime.test.js",
        "ui-messages.test.js",
        "webview.test.js",
        "write-stepping.test.js",
        "pointer-deref.test.js",
        "pointer-display.test.js",
        "pointer-targets.test.js",
        "write-list-view.test.js",
        "write-risk-view.test.js",
        "write-card-display.test.js"
    ]),
    release: Object.freeze(["release-consistency.test.js"])
});

function discoverTopLevelTests(root) {
    return fs
        .readdirSync(path.join(root, "test"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
        .map((entry) => path.join(root, "test", entry.name))
        .sort();
}

function groupFor(file, groups = TEST_GROUPS) {
    const name = path.basename(file);
    const matching = Object.keys(groups).filter((group) => groups[group].includes(name));
    if (matching.length > 1) throw new Error("Test appears in multiple groups: " + name);
    if (!matching.length) throw new Error("Test has no group: " + name);
    return matching[0];
}

function validateGroups(files, groups = TEST_GROUPS) {
    const known = new Set(files.map((file) => path.basename(file)));
    if (known.size !== files.length) throw new Error("Duplicate test file in manifest");
    const assigned = new Set();
    for (const [group, names] of Object.entries(groups)) {
        if (!["fast", "integration", "release"].includes(group)) throw new Error("Unknown test group: " + group);
        for (const name of names) {
            if (!known.has(name)) throw new Error("Test group references missing file: " + name);
            if (assigned.has(name)) throw new Error("Test appears in multiple groups: " + name);
            assigned.add(name);
        }
    }
    for (const name of known) {
        if (!assigned.has(name)) throw new Error("Test has no group: " + name);
    }
    return true;
}

function testsForGroup(root, group) {
    if (!["fast", "integration", "core", "release"].includes(group)) throw new Error("Unknown test group: " + group);
    const files = discoverTopLevelTests(root);
    validateGroups(files);
    return files.filter((file) => {
        const fileGroup = groupFor(file);
        return group === "core" ? fileGroup === "fast" || fileGroup === "integration" : fileGroup === group;
    });
}

module.exports = { TEST_GROUPS, discoverTopLevelTests, groupFor, testsForGroup, validateGroups };
