"use strict";

const { scenario } = require("./helpers/scenario");

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

    await scenario("Validate IP and pin sequences, categorized diffs and candidate deletions", async () => {
        const {
            deriveCandidate,
            categorizeChanges,
            validateStructuralIoc
        } = require("../src/services/cubemxCandidate");
        {
            const structuralCases = [
                {
                    name: "contiguous IP sequence",
                    values: { "Mcu.IPNb": "2", "Mcu.IP0": "RCC", "Mcu.IP1": "USART1" },
                    valid: true
                },
                { name: "gap in IP sequence", values: { "Mcu.IPNb": "2", "Mcu.IP0": "RCC" }, valid: false },
                {
                    name: "duplicate IP",
                    values: { "Mcu.IPNb": "2", "Mcu.IP0": "RCC", "Mcu.IP1": "RCC" },
                    valid: false
                },
                {
                    name: "orphaned IP",
                    values: { "Mcu.IPNb": "1", "Mcu.IP0": "RCC", "Mcu.IP1": "USART1" },
                    valid: false
                },
                {
                    name: "contiguous pin sequence",
                    values: { "Mcu.PinsNb": "2", "Mcu.Pin0": "PA9", "Mcu.Pin1": "PA10" },
                    valid: true
                },
                { name: "gap in pin sequence", values: { "Mcu.PinsNb": "2", "Mcu.Pin0": "PA9" }, valid: false },
                {
                    name: "duplicate pin",
                    values: { "Mcu.PinsNb": "2", "Mcu.Pin0": "PA9", "Mcu.Pin1": "PA9" },
                    valid: false
                },
                {
                    name: "orphaned pin",
                    values: { "Mcu.PinsNb": "1", "Mcu.Pin0": "PA9", "Mcu.Pin1": "PA10" },
                    valid: false
                }
            ];
            for (const { name, values, valid } of structuralCases) {
                if (valid) assert.doesNotThrow(() => validateStructuralIoc(values), name);
                else
                    assert.throws(
                        () => validateStructuralIoc(values),
                        (err) => err.code === "CUBEMX_IOC_INVALID",
                        name
                    );
            }

            // Categorized diff summary
            const diffList = [
                { key: "Mcu.IP0", previous: null, requested: "RCC" },
                { key: "PA9.Signal", previous: null, requested: "USART1_TX" },
                { key: "RCC.Clock", previous: null, requested: "168MHz" },
                { key: "ProjectManager.TargetToolchain", previous: null, requested: "CMake" },
                { key: "Custom.Setting", previous: null, requested: "1" }
            ];
            const categorized = categorizeChanges(diffList);
            for (const category of ["ips", "pins", "clock", "metadata", "other"]) {
                assert.strictEqual(categorized[category].length, 1, `categorized diff: ${category}`);
            }

            // deriveCandidate with deletions
            const orig = "a=1\nb=2\nc=3\n";
            const candidateResult = deriveCandidate(orig, { d: "4" }, ["b"]);
            assert.strictEqual(candidateResult.content, "a=1\nc=3\nd=4\n");
            assert(candidateResult.changes.some((c) => c.key === "b" && c.action === "deleted"));

            // Reject updating and deleting the same key
            assert.throws(
                () => deriveCandidate(orig, { a: "new" }, ["a"]),
                (err) => err.code === "INVALID_ARGUMENT"
            );
        }
    });

    console.log("Candidate preservation and independent permission queries passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
