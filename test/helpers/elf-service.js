"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const elfSymbols = require("../../src/elfSymbols");
const { ElfService } = require("../../src/services/elfService");

// An ElfService that loads `file` through the real ELF Worker, as the extension does.
// `options` overrides individual constructor options (e.g. onChange, dwarf, cacheKey).
function createWorkerElfService(file, options = {}) {
    return new ElfService({
        context: { workspaceState: { get: () => file } },
        cacheKey: "elf",
        fs,
        crypto,
        elfSymbols,
        cleanPath: (value) => value,
        t: (key) => key,
        workerPath: path.resolve(__dirname, "../../src/elfWorker.js"),
        ...options
    });
}

module.exports = { createWorkerElfService };
