"use strict";

// Compatibility layers kept for upgrades from v0.8+, each with the release that removes it.
// test/compat-layers.test.js checks that every listed site still exists, so an entry is deleted together with its
// layer; test/release-consistency.test.js fails a release whose version has reached an entry's removeIn.
// Register every new compatibility path here, with its removal release, instead of leaving it to be found later.
const COMPAT_LAYERS = Object.freeze([
    {
        id: "agent-bridge-legacy-pointer",
        purpose: "Writes the workspace Bridge pointer and legacy descriptor read by skill scripts installed by v0.8",
        removeIn: "1.0.0",
        sites: [
            { file: "src/agentBridge.js", marker: "legacyPointer" },
            { file: "src/services/agentService.js", marker: "legacyPointer" },
            { file: "src/mainViewProvider.js", marker: "legacyPointer" }
        ]
    },
    {
        id: "probe-selection-v2-mirror",
        purpose: "Mirrors the probe selection into the v1/v2 record that older installed skills read",
        removeIn: "1.0.0",
        sites: [{ file: "src/services/probeSelectionStore.js", marker: "LEGACY_SUCCESS_KEY" }]
    },
    {
        id: "mcp-workspace-binding-cleanup",
        purpose: "Removes EMBERPROBE_WORKSPACE that earlier releases wrote into user-level MCP client configuration",
        removeIn: "1.0.0",
        sites: [{ file: "src/services/mcpConfigEdits.js", marker: "STALE_BINDING" }]
    },
    {
        id: "write-trust-fail-closed",
        purpose: "Treats a write trust stored by older releases as a boolean or timestamp as untrusted",
        removeIn: null,
        permanent: "Security check: a stored trust without the current shape must keep failing closed",
        sites: [{ file: "src/writeAuthorization.js", marker: "Legacy timestamps/booleans and missing fingerprints" }]
    }
]);

const versionCore = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
    if (!match) throw new Error(`Not a release version: ${version}`);
    return match.slice(1).map(Number);
};

// A prerelease of the removal version counts as reached: the layer must be gone before its release candidates.
function reachedRemoval(version, removeIn) {
    if (!removeIn) return false;
    const current = versionCore(version);
    const target = versionCore(removeIn);
    for (let index = 0; index < 3; index += 1) {
        if (current[index] !== target[index]) return current[index] > target[index];
    }
    return true;
}

module.exports = { COMPAT_LAYERS, reachedRemoval };
