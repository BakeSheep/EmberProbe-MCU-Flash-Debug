"use strict";

const { scenario } = require("./helpers/scenario");

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

    await scenario("Download the selected image even when preparation replaces its file", async () => {
        const fs = require("fs/promises");
        const os = require("os");
        const path = require("path");
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-image-"));
        try {
            const image = path.join(root, "selected.elf"),
                before = minimalElf("approved"),
                after = minimalElf("replaced");
            await fs.writeFile(image, before);
            let consumed;
            const flash = new FlashService({
                runOpenOcd: async (_vscode, options) => {
                    consumed = await fs.readFile(options.elf);
                }
            });
            await flash.download(
                {},
                {
                    elf: image,
                    prepare: async () => {
                        await fs.writeFile(image, after);
                        return {};
                    }
                }
            );
            assert.deepStrictEqual(consumed, before);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
