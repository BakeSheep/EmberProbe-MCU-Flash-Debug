"use strict";

class FlashService {
    constructor(runner) {
        this.runner = runner;
    }

    async download(vscode, options, onProgress) {
        return this.runner.runOpenOcd(vscode, options, onProgress);
    }
}

module.exports = { FlashService };
