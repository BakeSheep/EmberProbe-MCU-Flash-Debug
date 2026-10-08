"use strict";
const assert = require("assert");
const { FlashService } = require("../src/services/flashService");
const fs = require("fs");
const { minimalElf } = require("./helpers/elf-fixture");
const { normalizeFileIdentity } = require("../skills/_emberprobe/file-identity");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        let flashOptions;
        fs.writeFileSync(elf, minimalElf());
        const flash = new FlashService({
            runOpenOcd: async (_vscode, options, progress) => {
                flashOptions = options;
                progress({ stage: "done" });
                return { ok: true };
            }
        });
        const progress = [];
        assert.deepStrictEqual(await flash.download({}, { elf }, (event) => progress.push(event)), { ok: true });
        assert.notStrictEqual(flashOptions.elf, elf);
        assert.strictEqual(
            flashOptions.originalElf,
            normalizeFileIdentity(await fs.promises.realpath(elf)),
            "original image identity resolves Windows short-name aliases"
        );
        assert.strictEqual(
            fs.existsSync(flashOptions.elf),
            false,
            "private image is removed after confirmed completion"
        );
        assert.deepStrictEqual(progress, [{ stage: "done" }]);
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
