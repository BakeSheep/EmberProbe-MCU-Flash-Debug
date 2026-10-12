"use strict";

// Layout depth counts only by-value composite edges; wrappers have their own iterative cap.
const MAX_COMPOSITE_DEPTH = 32;
const MAX_COMPOSITE_NODES = 16384;
const MAX_COMPOSITE_BYTES = 2 * 1024 * 1024;
const MAX_TYPE_ALIASES = 256;
// Metadata may follow array/pointer chains beyond the visible composite window.
const MAX_TYPE_INFO_DEPTH = 256;

module.exports = {
    MAX_COMPOSITE_DEPTH,
    MAX_COMPOSITE_NODES,
    MAX_COMPOSITE_BYTES,
    MAX_TYPE_ALIASES,
    MAX_TYPE_INFO_DEPTH
};
