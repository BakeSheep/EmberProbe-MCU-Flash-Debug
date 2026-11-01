"use strict";

// Workspace state keys of the selected configuration and the saved watch lists.
const CACHE_KEYS = {
    elfPath: "mcu.elfPath",
    debugger: "mcu.debugger",
    mcuCore: "mcu.mcuCore",
    svdPath: "mcu.svdPath",
    iocPath: "mcu.iocPath",
    watchList: "mcu.watchList",
    sidebarWatchList: "mcu.sidebarWatchList",
    sidebarWriteList: "mcu.sidebarWriteList"
};

module.exports = { CACHE_KEYS };
