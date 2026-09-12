"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { deriveCandidate, generateCandidate } = require("../src/services/cubemxCandidate");
const { parseProperties } = require("../src/services/javaProperties");
const { CubeMxService } = require("../src/services/cubemxService");
const { args } = require("../skills/mcu-cubemx/scripts/cubemx");
(async () => {
    const original = "\uFEFF# keep\r\nPA13\\ (SWD).Mode=old\r\nmulti=one\\\r\n two\r\nuntouched : exact  \r\n";
    const result = deriveCandidate(original, { "PA13 (SWD).Mode": "new", multi: "line\nnext", added: " spaced" });
    assert(result.content.startsWith("\uFEFF# keep\r\n"));
    assert(result.content.includes("untouched : exact  \r\n"));
    assert.strictEqual(parseProperties(result.content).multi, "line\nnext");
    assert.strictEqual(deriveCandidate(original, {}).content, original);
    assert.strictEqual(deriveCandidate("a=1", { a: "1" }).changes.length, 0);
    assert.strictEqual(deriveCandidate("a=1", { b: "2" }).content, "a=1\nb=2\n");
    assert.throws(() => deriveCandidate(original, { x: 1 }));
    assert.throws(() => args(["--generate-candidate"]));
    assert.strictEqual(args(["--generate-candidate", "--output", "new.ioc"]).action, "generate-candidate");
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-")));
    try {
        const ioc = path.join(root, "demo.ioc");
        await fs.writeFile(ioc, original);
        const options = { config: () => ({ iocPath: ioc }), roots: () => [root] };
        const output = await generateCandidate(options, { outputPath: "new.ioc", changes: { multi: "new" } });
        assert.strictEqual(output.changes.length, 1);
        assert.strictEqual(await fs.readFile(ioc, "utf8"), original);
        await assert.rejects(generateCandidate(options, { outputPath: "new.ioc" }), /EEXIST/);
        await assert.rejects(generateCandidate(options, { outputPath: ioc }), /separate/);
        const saved = new Map();
        const service = new CubeMxService({
            ...options,
            storage: { get: (k) => saved.get(k), update: async (k, v) => saved.set(k, v) }
        });
        service.plan = async () => {
            throw new Error("must not call deep validation");
        };
        assert.strictEqual((await service.permission()).applicability, "unknown");
        assert.strictEqual((await service.permission()).trusted, false);
        await service.permission({ action: "reset" });
        const tool = { version: "6.17.0" };
        service.options.installation = async () => tool;
        await fs.writeFile(ioc, "Mcu.Name=STM32H750\nMxCube.Version=6.18.1\n");
        const trust = { workspace: root, ioc, chip: "STM32H750", tool, output: root };
        await service.authorization.remember({ trust });
        const permission = await service.permission();
        assert.strictEqual(permission.trusted, true);
        assert.strictEqual(permission.applicability, "verified");
        assert.deepStrictEqual(permission.target, trust);
        await fs.unlink(ioc);
        const unavailable = await service.permission();
        assert.strictEqual(unavailable.saved, true);
        assert.strictEqual(unavailable.trusted, false);
        await service.permission({ action: "reset" });
        assert.strictEqual((await service.permission()).saved, false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("Candidate preservation and independent permission queries passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
