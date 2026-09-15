"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { CubeMxService } = require("../src/services/cubemxService");

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ioc-size-guard-")));
    try {
        const ioc = path.join(root, "huge.ioc");
        // §17.3: permission() reads the workspace .ioc directly, bypassing parseIoc's 1 MiB cap.
        // An oversized file must be rejected on size alone, never fed to the property parser.
        const filler = Array.from({ length: 60000 }, (_, index) => `Pad${index}=value${index}`).join("\n");
        await fs.writeFile(ioc, filler);
        assert.ok((await fs.stat(ioc)).size > 1024 * 1024, "fixture must exceed the 1 MiB limit");
        const saved = new Map();
        const service = new CubeMxService({
            config: () => ({ iocPath: ioc }),
            roots: () => [root],
            storage: { get: (key) => saved.get(key), update: async (key, value) => saved.set(key, value) }
        });
        const permission = await service.permission();
        assert.strictEqual(permission.trusted, false);
        assert.match(permission.warning, /1 MiB/, "oversized .ioc must be rejected by the size guard");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("CubeMX permission .ioc size guard tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
