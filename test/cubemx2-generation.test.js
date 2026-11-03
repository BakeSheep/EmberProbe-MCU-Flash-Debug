"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { CubeMxService } = require("../src/services/cubemxService");
const { failure } = require("../src/services/cubemxEnvironment");
const project2 = require("../src/services/cubemx2Project");

const fixture = path.join(__dirname, "fixtures/cubemx2/c593.ioc2");
const USART = '"USART1": { "driverId": "STMicroelectronics::Device:STM32CubeMX2 Config:USART" },\n    ';

// A CubeMX2 backend that understands just enough commands to configure and generate the fixture project.
function fakeCubeMx2(waRoot) {
    const state = { started: 0, live: 0, commands: [], areas: [], closeResult: true, rcc: "rcc v1\n", stamp: 0 };
    const pending = new Map();
    const option = (argv, name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    state.startBackend = async (_bundle, options) => {
        assert.match(options.userDataDir, /backend-user-data$/);
        state.started++;
        state.live++;
        return {
            port: 50000 + state.started,
            async run(argv, { project }) {
                const command = argv.filter((arg) => !arg.startsWith("--")).join(" ");
                state.commands.push(command);
                const text = await fs.readFile(project, "utf8");
                switch (command) {
                    case "project get-sw-project-list": {
                        const area = path.join(
                            waRoot,
                            "working_area",
                            project2.parseIoc2(text).description.workingAreaId
                        );
                        await fs.mkdir(path.join(area, "project"), { recursive: true });
                        state.areas.push(area);
                        return [{ name: "project", path: path.join(area, "project") }];
                    }
                    case "peripherals enable":
                    case "peripherals disable":
                        pending.set(project, [argv[1], option(argv, "peripheral")]);
                        return { message: "ok" };
                    case "project save": {
                        const [action] = pending.get(project) || [];
                        if (action === "enable")
                            await fs.writeFile(project, text.replace('"RCC": {', USART + '"RCC": {'));
                        if (action === "disable") await fs.writeFile(project, text.replace(USART, ""));
                        return undefined;
                    }
                    case "clock get-clock-status":
                        return { status: "valid" };
                    case "peripherals list":
                        return ["MPU", "ICACHE", "RCC", "NVIC"];
                    case "peripherals view":
                        if (option(argv, "peripheral") === "NOPE")
                            throw failure("CUBEMX2_COMMAND_FAILED", "Configurable element with name 'NOPE' not found.");
                        return { name: option(argv, "peripheral") };
                    case "ide-project build-target list":
                        return [".release_GCC+STM32C593RET6", ".debug_GCC+STM32C593RET6"];
                    case "ide-project generate": {
                        assert.strictEqual(option(argv, "source"), "include-packs-from-local");
                        assert.strictEqual(option(argv, "build-target"), ".debug_GCC+STM32C593RET6");
                        const out = option(argv, "destination");
                        const files = {
                            "main.c": ["user_code", "int main(void) { while (1) {} }\n"],
                            "user_modifiable/startup.s": ["RTE", "reset:\n"],
                            "CMakeLists.txt": ["project_file", "project(c593)\n"],
                            "generated/hal/mx_rcc.c": ["generated", state.rcc]
                        };
                        if (text.includes('"USART1"')) files["generated/hal/mx_usart1.c"] = ["generated", "usart\n"];
                        for (const [file, [, content]] of Object.entries(files)) {
                            await fs.mkdir(path.dirname(path.join(out, file)), { recursive: true });
                            await fs.writeFile(path.join(out, file), content);
                        }
                        await fs.mkdir(path.join(out, ".settings"), { recursive: true });
                        await fs.writeFile(
                            path.join(out, ".settings", "exported-files.json"),
                            JSON.stringify({
                                version: "1.0.0",
                                timestamp: `t${++state.stamp}`,
                                files: Object.entries(files).map(([file, [fileGroup]]) => ({ file, fileGroup }))
                            })
                        );
                        return { message: "generated" };
                    }
                    default:
                        throw new Error("Unexpected CubeMX2 command " + command);
                }
            },
            async close() {
                state.live--;
                return state.closeResult;
            }
        };
    };
    return state;
}

const exists = (file) =>
    fs.stat(file).then(
        () => true,
        () => false
    );

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx2-generation-"));
    try {
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace);
        const iocPath = path.join(workspace, "c593.ioc2");
        const original = await fs.readFile(fixture, "utf8");
        await fs.writeFile(iocPath, original);
        const fake = fakeCubeMx2(root);
        const values = new Map();
        const service = new CubeMxService({
            platform: "win32",
            storage: { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) },
            storageDir: path.join(root, "storage"),
            stagingDir: path.join(root, "staging"),
            config: () => ({ iocPath, cubemx2Path: "D:/STM32CubeMX2/stm32cubemx2.exe" }),
            roots: () => [workspace],
            cubemx2: {
                installation: async () => ({ executable: "D:/STM32CubeMX2/stm32cubemx2.exe", version: "1.1.2" }),
                applicationBundle: async (_tool, version) => {
                    assert.strictEqual(version, "1.2.0");
                    return { version: "1.2.0", backend: "backend", node: "node", cli: "bin.js", env: {} };
                },
                startBackend: fake.startBackend
            }
        });
        const workspaceFile = (file) => fs.readFile(path.join(workspace, file), "utf8");
        const generate = async (params) => {
            const prepared = await service.prepare({ summary: true, ...params });
            return service.execute({
                ...(prepared.candidateHash ? { candidateHash: prepared.candidateHash } : {}),
                confirmationId: prepared.confirmationId
            });
        };

        await scenario("Inspect a .ioc2 project without starting CubeMX2", async () => {
            const result = await service.inspect({});
            assert.strictEqual(result.generator, "cubemx2");
            assert.strictEqual(result.summary.chip, "STM32C593RET6");
            assert.deepStrictEqual(result.tool, {
                executable: "D:/STM32CubeMX2/stm32cubemx2.exe",
                version: "1.2.0",
                launcherVersion: "1.1.2"
            });
            const values = await service.inspect({ prefix: "project/.settings/peripherals" });
            assert.deepStrictEqual(Object.keys(values.values), ["project/.settings/peripherals.store.json"]);
            assert.strictEqual(fake.started, 0);
        });

        await scenario("Query a staged copy, keep per-command errors and clean up the backend", async () => {
            const result = await service.query({
                operations: [
                    { command: "peripherals list", args: { enabled: true } },
                    { command: "peripherals view", args: { peripheral: "NOPE" } },
                    { command: "clock get-clock-status" }
                ]
            });
            assert.deepStrictEqual(
                result.results.map((item) => [item.command, item.ok]),
                [
                    ["peripherals list", true],
                    ["peripherals view", false],
                    ["clock get-clock-status", true]
                ]
            );
            assert.strictEqual(result.results[1].error.code, "CUBEMX2_COMMAND_FAILED");
            assert.strictEqual(fake.live, 0);
            for (const area of fake.areas) assert.strictEqual(await exists(area), false);
            // The staged copy works in its own area, never the project's.
            assert.ok(
                !fake.areas.some((area) => area.endsWith(project2.parseIoc2(original).description.workingAreaId))
            );
            await assert.rejects(
                service.query({ operations: [{ command: "peripherals enable", args: { peripheral: "USART1" } }] }),
                {
                    code: "CUBEMX2_OPERATION_INVALID"
                }
            );
            assert.strictEqual(fake.started, 1);
            assert.strictEqual(await workspaceFile("c593.ioc2"), original);
        });

        let firstResult;
        await scenario("Prepare a candidate with operations and generate it into the workspace", async () => {
            await assert.rejects(service.prepare({ content: original }), { code: "INVALID_ARGUMENT" });
            await assert.rejects(service.prepare({ candidatePath: iocPath }), { code: "INVALID_ARGUMENT" });
            await assert.rejects(
                service.prepare({ operations: [{ command: "peripherals list" }], candidateHash: "0".repeat(64) }),
                { code: "INVALID_ARGUMENT" }
            );
            const prepared = await service.prepare({
                summary: true,
                operations: [{ command: "peripherals enable", args: { peripheral: "USART1", mode: "Async" } }]
            });
            assert.match(prepared.candidateHash, /^[0-9a-f]{64}$/);
            assert.deepStrictEqual(prepared.operationResults, [
                { command: "peripherals enable", data: { message: "ok" } }
            ]);
            assert.deepStrictEqual(prepared.clockStatus, { status: "valid" });
            assert.strictEqual(prepared.changesSummary.byCategory.peripherals, 1);
            assert.strictEqual(prepared.changes[0].path, "configuration.USART1");
            assert.match(prepared.question, /\.ioc2/);
            assert.strictEqual(await workspaceFile("c593.ioc2"), original);
            // The confirmation covers the prepared candidate only.
            await assert.rejects(service.execute({ confirmationId: prepared.confirmationId }), (error) => {
                assert.match(error.code, /^CUBEMX_/);
                return true;
            });
            assert.strictEqual(await workspaceFile("c593.ioc2"), original);
            await assert.rejects(
                service.execute({ candidateHash: "f".repeat(64), confirmationId: prepared.confirmationId }),
                {
                    code: "CUBEMX_PROJECT_CHANGED"
                }
            );

            // A mismatched attempt spends the confirmation; the same operations give the same candidate.
            await assert.rejects(
                service.execute({ candidateHash: prepared.candidateHash, confirmationId: prepared.confirmationId }),
                { code: "CUBEMX_CONFIRMATION_INVALID" }
            );
            const again = await service.prepare({
                operations: [{ command: "peripherals enable", args: { peripheral: "USART1", mode: "Async" } }]
            });
            assert.strictEqual(again.candidateHash, prepared.candidateHash);
            firstResult = await service.execute({
                candidateHash: again.candidateHash,
                confirmationId: again.confirmationId
            });
            assert.strictEqual(firstResult.generated, true);
            assert.deepStrictEqual(firstResult.warnings, []);
            const saved = await workspaceFile("c593.ioc2");
            assert.ok(saved.includes('"USART1"'));
            // The staged working area id never reaches the user's project.
            assert.strictEqual(
                project2.parseIoc2(saved).description.workingAreaId,
                project2.parseIoc2(original).description.workingAreaId
            );
            assert.strictEqual(await workspaceFile("generated/hal/mx_usart1.c"), "usart\n");
            assert.strictEqual(await workspaceFile("main.c"), "int main(void) { while (1) {} }\n");
            assert.strictEqual(fake.live, 0);
            for (const area of fake.areas) assert.strictEqual(await exists(area), false);
            const manifest = await service.store.getManifest(workspace);
            assert.strictEqual(manifest.generator, "cubemx2");
            assert.deepStrictEqual(manifest.generation, { format: "CMake", buildTarget: ".debug_GCC+STM32C593RET6" });
            assert.ok(manifest.files["generated/hal/mx_usart1.c".split("/").join(path.sep)]);
            assert.ok(!manifest.files["main.c"]);
        });

        await scenario("Quick check follows the manifest and reports hand edits and .ioc2 changes", async () => {
            assert.strictEqual((await service.check({ mode: "quick" })).status, "consistent");
            const rcc = path.join(workspace, "generated", "hal", "mx_rcc.c");
            await fs.writeFile(rcc, "rcc edited\n");
            const drift = await service.check({ mode: "quick" });
            assert.strictEqual(drift.status, "drift_detected");
            assert.deepStrictEqual(drift.drift, [
                { file: path.join("generated", "hal", "mx_rcc.c"), action: "modified" }
            ]);
            await fs.writeFile(rcc, "rcc v1\n");
            const saved = await workspaceFile("c593.ioc2");
            await fs.writeFile(iocPath, saved.replace(USART, ""));
            const config = await service.check({ mode: "quick" });
            assert.strictEqual(config.iocChanged, true);
            assert.deepStrictEqual(config.configChanges, [
                { file: "project/.settings/peripherals.store.json", section: "peripherals" }
            ]);
            await fs.writeFile(iocPath, saved);
        });

        await scenario("Regenerating keeps edited user-owned files and reports them", async () => {
            await fs.writeFile(path.join(workspace, "main.c"), "int main(void) { while (1) { mine(); } }\n");
            const result = await generate({});
            assert.deepStrictEqual(result.warnings, ["User-owned files kept unchanged: main.c"]);
            assert.match(await workspaceFile("main.c"), /mine\(\)/);
            const deep = await service.check({ mode: "deep", wait: true });
            assert.strictEqual(deep.status, "consistent");
            assert.deepStrictEqual(deep.userCodeChanges, [{ file: "main.c", action: "user_modified" }]);
            assert.strictEqual(fake.live, 0);
        });

        await scenario("Refuse generation when CubeMX2-owned files cannot be reproduced", async () => {
            const rcc = path.join(workspace, "generated", "hal", "mx_rcc.c");
            await fs.writeFile(rcc, "rcc hand edit\n");
            const before = await workspaceFile("c593.ioc2");
            await assert.rejects(generate({}), (error) => {
                assert.strictEqual(error.code, "CUBEMX_BASELINE_DRIFT");
                assert.deepStrictEqual(error.details.changes, [
                    { file: path.join("generated", "hal", "mx_rcc.c"), action: "modified" }
                ]);
                return true;
            });
            assert.strictEqual(await fs.readFile(rcc, "utf8"), "rcc hand edit\n");
            assert.strictEqual(await workspaceFile("c593.ioc2"), before);
            assert.strictEqual(fake.live, 0);
            await fs.writeFile(rcc, "rcc v1\n");
        });

        await scenario("Remove files the new configuration no longer generates", async () => {
            const result = await generate({
                operations: [{ command: "peripherals disable", args: { peripheral: "USART1" } }]
            });
            assert.strictEqual(result.generated, true);
            assert.strictEqual(await exists(path.join(workspace, "generated", "hal", "mx_usart1.c")), false);
            assert.ok(!(await workspaceFile("c593.ioc2")).includes('"USART1"'));
            assert.match(await workspaceFile("main.c"), /mine\(\)/);
            assert.ok(await exists(path.join(workspace, "user_modifiable", "startup.s")));
        });

        await scenario("Keep working areas and warn when the backend exit is not confirmed", async () => {
            fake.closeResult = false;
            const areas = fake.areas.length;
            const result = await generate({});
            assert.ok(result.warnings.some((warning) => warning.startsWith("CUBEMX2_EXIT_UNCONFIRMED")));
            assert.ok(fake.areas.length > areas);
            for (const area of fake.areas.slice(areas)) assert.strictEqual(await exists(area), true);
            fake.closeResult = true;
        });

        await scenario("Legacy .ioc projects keep their own flow", async () => {
            const legacyDir = path.join(root, "legacy");
            await fs.mkdir(legacyDir);
            const ioc = path.join(legacyDir, "demo.ioc");
            await fs.writeFile(ioc, "Mcu.Name=STM32F407VGTx\nMxCube.Version=6.18.1\nProjectManager.ProjectName=demo\n");
            const legacy = new CubeMxService({
                platform: "win32",
                storage: { get: () => undefined, update: async () => {} },
                storageDir: path.join(root, "legacy-storage"),
                config: () => ({ iocPath: ioc }),
                roots: () => [legacyDir],
                installation: async () => ({ version: "6.18.1" })
            });
            await assert.rejects(legacy.prepare({ operations: [{ command: "peripherals list" }] }), {
                code: "INVALID_ARGUMENT"
            });
            await assert.rejects(legacy.query({ operations: [{ command: "peripherals list" }] }), {
                code: "CUBEMX2_PROJECT_REQUIRED"
            });
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("CubeMX2 generation through CubeMxService passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
