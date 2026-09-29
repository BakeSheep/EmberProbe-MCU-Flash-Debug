"use strict";
const { createRequire } = require("module");
const path = require("path");
const loadPackagedDependency = createRequire(path.join(__dirname, "sampling-timer", "entry.cjs"));
const loadDevelopmentDependency = createRequire(__filename);

function loadKoffi() {
    try {
        return loadPackagedDependency("koffi");
    } catch {
        return loadDevelopmentDependency("koffi");
    }
}

// Windows normally wakes Node timers on a roughly 15.6 ms grid. Request a
// finer process-local timer only while a sampling session is running.
function createWindowsTimerResolution(platform = process.platform, loadDependency = loadKoffi) {
    let beginPeriod = null;
    let endPeriod = null;
    let users = 0;
    let unavailable = false;

    function acquire() {
        if (platform !== "win32" || unavailable) return false;
        if (users > 0) {
            users++;
            return true;
        }
        try {
            if (!beginPeriod) {
                const winmm = loadDependency().load("winmm.dll");
                beginPeriod = winmm.func("__stdcall", "timeBeginPeriod", "uint", ["uint"]);
                endPeriod = winmm.func("__stdcall", "timeEndPeriod", "uint", ["uint"]);
            }
            if (beginPeriod(1) !== 0) {
                unavailable = true;
                return false;
            }
            users = 1;
            return true;
        } catch {
            unavailable = true;
            return false;
        }
    }

    function release() {
        if (users === 0) return;
        users--;
        if (users === 0) {
            try {
                endPeriod(1);
            } catch {
                // Stopping sampling must remain possible even if the native call fails.
            }
        }
    }

    return { acquire, release };
}

module.exports = { createWindowsTimerResolution, windowsTimerResolution: createWindowsTimerResolution() };
