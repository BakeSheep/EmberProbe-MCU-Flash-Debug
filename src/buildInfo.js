"use strict";

const fs = require("fs");
const path = require("path");

function isOfficialRelease(version, releaseTag) {
    return /^\d+\.\d+\.\d+$/.test(version) && releaseTag === `v${version}`;
}

function versionLabel(version, directory = __dirname) {
    if (!version) return "";
    let officialRelease = false;
    try {
        const buildInfo = JSON.parse(fs.readFileSync(path.join(directory, "buildInfo.json"), "utf8"));
        officialRelease = buildInfo.version === version && buildInfo.officialRelease === true;
    } catch {
        // Source runs and older packages have no build marker.
    }
    return `v${version}${officialRelease ? "" : " beta"}`;
}

module.exports = { isOfficialRelease, versionLabel };
