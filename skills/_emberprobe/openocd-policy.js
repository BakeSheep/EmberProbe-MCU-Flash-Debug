"use strict";
const MIN_OPENOCD_VERSION = "0.12.0";
// 从输出文本中提取 OpenOCD 版本号，兼容多种格式：
//   Open On-Chip Debugger 0.12.0
//   Open On-Chip Debugger 0.11.0-rc2 (2021-09-30-15:23)
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

// EmberProbe 的实时读写依赖 OpenOCD 0.12 的 read_memory/write_memory Tcl 接口。
// 0.12.0-rc 仍视为低于正式版；xPack 的 0.12.0-7 是发行包修订号，可正常使用。
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
