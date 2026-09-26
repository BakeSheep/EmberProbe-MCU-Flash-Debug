"use strict";

function addPeripheralViewerSvd(config, svdPath) {
    if (!svdPath) return config;
    return { ...config, svdPath };
}

module.exports = { addPeripheralViewerSvd };
