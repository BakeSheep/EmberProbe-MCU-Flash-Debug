"use strict";
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { inspectElf } = require("../../skills/_emberprobe/elf-file");
const { assertWriteIdentity } = require("../../skills/_emberprobe/probe-connection");

class FlashService {
    constructor(runner) {
        this.runner = runner;
    }

    async download(vscode, options, onProgress) {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-ui-flash-"));
        try {
            const snapshot = path.join(directory, "firmware.elf");
            const elf = await inspectElf(options.elf, { snapshot });
            const { prepare, onDownloaded, ...request } = options;
            const connection = prepare ? await prepare() : {};
            assertWriteIdentity({ ...request, ...connection });
            const result = await this.runner.runOpenOcd(
                vscode,
                {
                    ...request,
                    ...connection,
                    elf: snapshot,
                    elfSha256: elf.sha256,
                    originalElf: elf.path
                },
                onProgress
            );
            // The download already succeeded; a failing record must not report it as failed.
            await Promise.resolve(onDownloaded?.({ elf: elf.path, sha256: elf.sha256 })).catch(() => {});
            return result;
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
}

module.exports = { FlashService };
