"use strict";

const fs = require("fs");
const path = require("path");

// Explicit membership makes adding a test an intentional classification decision.
// External GDB, Extension Host and HIL suites keep their dedicated entry points.
const TEST_GROUPS = Object.freeze({
    fast: Object.freeze([
        "composite-decode.test.js",
        "cpp-class-layout.test.js",
        "cpu-load-model.test.js",
        "dwarf-type-matrix.test.js",
        "elf-analyze.test.js",
        "elf-symbols.test.js",
        "enum-variables.test.js",
        "validation.test.js"
    ]),
    integration: Object.freeze([
        "cpu-load-sampler.test.js",
        "cpu-load-integration.test.js",
        "cpu-load-safety.test.js",
        "cpu-load-metadata.test.js",
        "cpu-load-view.test.js",
        "adaptive-sampling.test.js",
        "agent-debug-inspection.test.js",
        "agent-diagnostics.test.js",
        "agent-lifecycle.test.js",
        "agent-routes.test.js",
        "agent-sampling-control.test.js",
        "agent-service.test.js",
        "agent-skills.test.js",
        "audit-hardening.test.js",
        "audit-regressions.test.js",
        "confirmed-issues.test.js",
        "bridge-security.test.js",
        "build-info.test.js",
        "chart-controls.test.js",
        "chart-experience.test.js",
        "chart-host.test.js",
        "chart-history-worker.test.js",
        "chart-remote-history.test.js",
        "composite-history.test.js",
        "layered-sampling.test.js",
        "chart-presentation.test.js",
        "chart-render-budget.test.js",
        "chart-retention.test.js",
        "chart-viewport.test.js",
        "chip-control.test.js",
        "chip-info-service.test.js",
        "chip-info.test.js",
        "ci-test-topology.test.js",
        "configuration-store.test.js",
        "contracts.test.js",
        "cortex-debug-integration.test.js",
        "cortex-debug-preflight.test.js",
        "cortex-toolchain.test.js",
        "cpp-class-variables.test.js",
        "cpp-debug-variables.test.js",
        "cpp-display-name.test.js",
        "cpp-pretty-printing.test.js",
        "cpp-review-regressions.test.js",
        "cpp-stl-display.test.js",
        "cpp-symbol-identity.test.js",
        "cpp-variable-names.test.js",
        "cpp-webview.test.js",
        "csv-export.test.js",
        "cubemx-candidate.test.js",
        "cubemx-firmware.test.js",
        "cubemx-generation-safety.test.js",
        "cubemx-integration.test.js",
        "cubemx-ioc-size-guard.test.js",
        "cubemx-linux.test.js",
        "cubemx-p0p1.test.js",
        "cubemx.test.js",
        "debug-context-regressions.test.js",
        "daplink-flash.test.js",
        "windows-probe-inventory.test.js",
        "probe-platform-audit.test.js",
        "debug-lifecycle-races.test.js",
        "debug-control.test.js",
        "debug-h7-regressions.test.js",
        "debug-images.test.js",
        "debug-performance.test.js",
        "docs-cleanup.test.js",
        "debug-scopes.test.js",
        "debug-server-controller.test.js",
        "external-debug.test.js",
        "external-debug-host.test.js",
        "debug-session-bridge.test.js",
        "debug-session-routing.test.js",
        "dwarf-budget.test.js",
        "dwarf-composite.test.js",
        "dwarf-fixes.test.js",
        "dwarf-formats.test.js",
        "dwarf-global-budget.test.js",
        "dwarf-zstd-budget.test.js",
        "elf-service.test.js",
        "elf-variable-filtering.test.js",
        "elf-webview-lazy.test.js",
        "elf-worker.test.js",
        "elf-write-readiness.test.js",
        "ember-debug.test.js",
        "extracted-services.test.js",
        "fault-info.test.js",
        "fault-service.test.js",
        "flash-process.test.js",
        "flash-refresh.test.js",
        "flash-safety.test.js",
        "flash-service.test.js",
        "flash-skills.test.js",
        "hil-runner.test.js",
        "jlink-diagnostics.test.js",
        "jlink-driver-choice.test.js",
        "jlink-probe-ready.test.js",
        "java-properties.test.js",
        "lifecycle-regressions.test.js",
        "live-watch-audit.test.js",
        "live-watch-disconnect.test.js",
        "live-watch-integration.test.js",
        "live-watch-response.test.js",
        "live-watch-service.test.js",
        "memory-analysis.test.js",
        "memory-sidebar.test.js",
        "mockup.test.js",
        "new-skills.test.js",
        "openocd-checker.test.js",
        "openocd-compatibility.test.js",
        "openocd-entrypoints.test.js",
        "openocd-exec.test.js",
        "openocd-installer.test.js",
        "openocd-parser.test.js",
        "openocd-scripts.test.js",
        "openocd-status-service.test.js",
        "peripheral-view.test.js",
        "peripheral-viewer-integration.test.js",
        "pretty-printing-modes.test.js",
        "probe-automatic.test.js",
        "probe-connection-service.test.js",
        "probe-connection.test.js",
        "probe-coordinator.test.js",
        "probe-driver-service.test.js",
        "probe-success-entrypoints.test.js",
        "provider-state.test.js",
        "release-script.test.js",
        "release-workflow.test.js",
        "rtos-snapshot.test.js",
        "rtos-view.test.js",
        "runtime-fixes.test.js",
        "runtime-native-layouts.test.js",
        "runtime-nested-selection.test.js",
        "runtime-objects.test.js",
        "runtime-refresh.test.js",
        "runtime-selection.test.js",
        "sampling-archive.test.js",
        "sampling-clock.test.js",
        "sampling-frequency.test.js",
        "sampling-isolation.test.js",
        "shared-debug-group.test.js",
        "sidebar-sections.test.js",
        "sidebar-status-restore.test.js",
        "skill-installer.test.js",
        "skill-status-service.test.js",
        "stl-containers.test.js",
        "svd-audit.test.js",
        "svd-manager.test.js",
        "svd-peripheral.test.js",
        "svd-services.test.js",
        "symbol-images.test.js",
        "test-runner.test.js",
        "validate-release.test.js",
        "value-display.test.js",
        "var-write.test.js",
        "verify-driver-helper.test.js",
        "verify-sampling-timer-vsix.test.js",
        "webview-assets.test.js",
        "webview-render-order.test.js",
        "webview-runtime.test.js",
        "ui-messages.test.js",
        "webview.test.js",
        "write-authorization.test.js",
        "write-connection.test.js",
        "write-stepping.test.js",
        "write-list-view.test.js"
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
