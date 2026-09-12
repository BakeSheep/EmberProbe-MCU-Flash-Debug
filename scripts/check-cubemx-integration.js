"use strict";
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { CubeMxService } = require("../src/services/cubemxService");
const { snapshot, materialize, hash } = require("../src/services/cubemxProject");
const { deriveCandidate } = require("../src/services/cubemxCandidate");

// Explicit real-tool check; never discovers or modifies a user's source project implicitly.
async function main() {
    const [iocArgument, toolArgument] = process.argv.slice(2);
    if (process.platform !== "win32" || !iocArgument || !toolArgument)
        throw new Error("Usage (Windows): node scripts/check-cubemx-integration.js <project.ioc> <STM32CubeMX.exe>");
    const ioc = await fs.realpath(iocArgument);
    const files = await snapshot(path.dirname(ioc));
    const name = path.basename(ioc);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-real-cubemx-"));
    const results = [];
    // Retain all copies and diagnostics for review, including after a failed run.
    console.log(JSON.stringify({ artifacts: temp }));
    for (const underRoot of ["true", "false"]) {
        const root = path.join(temp, "layout-" + underRoot);
        const copy = new Map(files);
        const candidate = deriveCandidate(files.get(name).bytes.toString("utf8"), {
            "ProjectManager.UnderRoot": underRoot
        });
        copy.set(name, { bytes: Buffer.from(candidate.content), hash: hash(candidate.content) });
        await materialize(root, copy);
        const service = new CubeMxService({
            storage: { get: () => undefined, update: async () => {} },
            storageDir: path.join(temp, "records"),
            config: () => ({ iocPath: path.join(root, name), cubemxPath: path.resolve(toolArgument) }),
            roots: () => [root]
        });
        results.push({ underRoot, ...(await service.check({ mode: "deep", wait: true })) });
    }
    console.log(JSON.stringify({ artifacts: temp, results }, null, 2));
    if (results.some((result) => result.status !== "consistent")) process.exitCode = 1;
}

if (require.main === module)
    main().catch((error) => {
        console.error(JSON.stringify({ error: error.message, code: error.code, details: error.details }));
        process.exitCode = 1;
    });
