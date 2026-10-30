"use strict";
const MIN_OPENOCD_VERSION = "0.12.0";
// Extracts the OpenOCD version from its output, for example:
// Open On-Chip Debugger 0.12.0
// Open On-Chip Debugger 0.11.0-rc2 (2021-09-30-15:23)
function parseVersion(text) {
    if (!text) return "";
    const m = String(text).match(/open on-chip debugger\s+v?(\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?)/i);
    if (m) return m[1];
    const m2 = String(text).match(/openocd[^\d]*v?(\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?)/i);
    return m2 ? m2[1] : "";
}

function numericVersion(version) {
    const match = String(version || "")
        .trim()
        .match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function compareVersions(left, right) {
    const a = numericVersion(left);
    const b = numericVersion(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
}

// EmberProbe live reads and writes need the read_memory/write_memory Tcl commands from OpenOCD 0.12. 0.12.0-rc still
// counts as older than the release; xPack's 0.12.0-7 is a packaging revision and works.
function checkCompatibility(version, minimum = MIN_OPENOCD_VERSION) {
    const value = String(version || "").trim();
    const comparison = compareVersions(value, minimum);
    if (comparison === null) return { compatible: false, reason: "unknown", version: value, minimumVersion: minimum };
    const prerelease = comparison === 0 && /-(?:rc|alpha|beta|pre(?:view)?)[.\d-]*/i.test(value);
    return {
        compatible: comparison > 0 || (comparison === 0 && !prerelease),
        reason: comparison < 0 || prerelease ? "too_old" : "",
        version: value,
        minimumVersion: minimum
    };
}

module.exports = { MIN_OPENOCD_VERSION, parseVersion, compareVersions, checkCompatibility };
