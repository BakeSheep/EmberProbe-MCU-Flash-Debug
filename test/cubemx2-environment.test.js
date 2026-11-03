"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { installation, discover, applicationBundle } = require("../src/services/cubemx2Environment");

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cubemx2-environment-")));
    const launcher = async (directory, name) => {
        const file = path.join(root, directory, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "fixture", { mode: 0o755 });
        return file;
    };
    const options = { platform: "win32", env: {}, roots: [], exec: async () => ({ stdout: "" }) };
    const writeJson = async (file, data) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(data));
    };
    try {
        const executable = await launcher("CubeMX2 空格", "stm32cubemx2-1.1.2.exe");
        await scenario("Validate CubeMX2 independently from the Java-based CubeMX installation", async () => {
            const tool = await installation(executable, { platform: "win32" });
            assert.strictEqual(tool.executable, executable);
            assert.strictEqual(tool.version, "1.1.2");
            assert.strictEqual(tool.platform, "win32");
            assert.strictEqual(tool.java, undefined);
            for (const value of [undefined, "relative.exe", executable + "\n", executable + '"', executable + "\0"])
                await assert.rejects(installation(value, options), { code: "CUBEMX2_PATH_INVALID" });
            const wrong = await launcher("CubeMX", "STM32CubeMX.exe");
            await assert.rejects(installation(wrong, options), { code: "CUBEMX2_PATH_INVALID" });
            const directory = path.join(root, "stm32cubemx2.exe");
            await fs.mkdir(directory);
            await assert.rejects(installation(directory, options), { code: "CUBEMX2_PATH_INVALID" });
            await assert.rejects(installation(path.join(root, "missing.exe"), options), { code: "ENOENT" });
            await assert.rejects(installation(executable, { platform: "darwin" }), {
                code: "CUBEMX2_PLATFORM_UNSUPPORTED"
            });
            const unversioned = await launcher("unversioned", "STM32CubeMX2.exe");
            assert.strictEqual((await installation(unversioned, options)).version, "");
            assert.strictEqual(await discover({ platform: "darwin" }), null);
        });

        await scenario("Discover versioned launchers through hints, standard roots and PATH", async () => {
            assert.strictEqual(await discover(options), null);
            assert.strictEqual(
                (await discover({ ...options, hints: [null, "relative", executable] })).executable,
                executable
            );
            assert.strictEqual(
                (await discover({ ...options, hints: [path.dirname(executable)] })).executable,
                executable
            );
            assert.strictEqual(
                (await discover({ ...options, env: { PATH: path.dirname(executable) } })).executable,
                executable
            );
            const old = await launcher("standard/STM32CubeMX2", "stm32cubemx2-1.2.0.exe");
            const latest = await launcher("standard/STM32CubeMX2 1.10.0", "stm32cubemx2-1.10.0.exe");
            await launcher("standard/STM32CubeMX2", "uninstall.exe");
            assert.strictEqual(
                (await discover({ ...options, roots: [path.join(root, "standard")] })).executable,
                latest
            );
            assert.strictEqual((await discover({ ...options, hints: [old, old] })).executable, old);
            const local = await launcher("local/Programs/STM32CubeMX2", "STM32CubeMX2.exe");
            assert.strictEqual(
                (await discover({ ...options, roots: undefined, env: { LOCALAPPDATA: path.join(root, "local") } }))
                    .executable,
                local
            );
        });

        await scenario("Read custom-drive shortcuts and uninstall locations without starting CubeMX2", async () => {
            const commands = [];
            const exec = async (command, args, settings) => {
                commands.push(command);
                assert.strictEqual(settings.windowsHide, true);
                assert.strictEqual(settings.timeout, 3000);
                if (command === "cube") {
                    assert.deepStrictEqual(args, ["--resolve", "--json", "mx"]);
                    return { stdout: "" };
                }
                if (command === "powershell.exe") {
                    assert.deepStrictEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
                    return { stdout: `${executable}\r\nrelative\n` };
                }
                assert.strictEqual(command, "reg.exe");
                assert.strictEqual(args[0], "query");
                return { stdout: "" };
            };
            assert.strictEqual((await discover({ ...options, exec })).executable, executable);
            assert.deepStrictEqual(commands, ["cube", "powershell.exe", "reg.exe", "reg.exe", "reg.exe"]);
            const registry = async (command) => ({
                stdout:
                    command === "reg.exe"
                        ? `HKEY_LOCAL_MACHINE\\Software\\Uninstall\\STM32CubeMX2\n    InstallLocation    REG_SZ    ${path.dirname(executable)}\n`
                        : ""
            });
            assert.strictEqual((await discover({ ...options, exec: registry })).executable, executable);
            assert.strictEqual(
                (
                    await discover({
                        ...options,
                        hints: [executable],
                        exec: async () => {
                            throw new Error("not available");
                        }
                    })
                ).executable,
                executable
            );
        });

        const registered = path.join(root, "official/resources/stm32cubemx-application/1.1.2");
        const officialLauncher = await launcher("official", "stm32cubemx2-1.1.2.exe");
        const manifest = { name: "stm32cubemx-application", version: "1.1.2" };
        await writeJson(path.join(registered, "CubeBundle.json"), manifest);
        const bundleRoot = path.join(root, "cube-bundles");
        const registryFile = path.join(bundleRoot, ".config/external_bundles.json");
        const registry = { externally_managed_bundles: [{ path: registered }] };
        await writeJson(registryFile, registry);

        await scenario("Prefer official external bundle registration over CLI and directory fallback", async () => {
            const official = await discover({
                ...options,
                env: { CUBE_BUNDLE_PATH: bundleRoot },
                roots: [path.join(root, "standard")],
                exec: async () => {
                    throw new Error("A registered installation needs no process");
                }
            });
            assert.strictEqual(official.executable, officialLauncher);
            assert.strictEqual(official.source, "cube-bundle");
            const localRoot = path.join(root, "local-data");
            await writeJson(path.join(localRoot, "stm32cube/bundles/.config/external_bundles.json"), registry);
            assert.strictEqual(
                (await discover({ ...options, env: { LOCALAPPDATA: localRoot } })).executable,
                officialLauncher
            );
            await writeJson(registryFile, {
                externally_managed_bundles: [null, {}, { path: "relative" }, ...registry.externally_managed_bundles]
            });
            assert.strictEqual(
                (await discover({ ...options, env: { CUBE_BUNDLE_PATH: bundleRoot } })).executable,
                officialLauncher
            );
            await writeJson(registryFile, registry);
        });

        await scenario("Resolve mx with Cube CLI without starting it, and validate the returned bundle", async () => {
            const cubeCli = path.join(root, "official-extension/cube.exe");
            const resolved = {
                command: ["cube", "node", path.join(registered, "dist/bin.js")],
                bundle: manifest
            };
            const exec = async (command, args, settings) => {
                assert.strictEqual(command, cubeCli);
                assert.deepStrictEqual(args, ["--resolve", "--json", "mx"]);
                assert.strictEqual(settings.windowsHide, true);
                assert.strictEqual(settings.env.CUBE_BUNDLE_PATH, undefined);
                return { stdout: JSON.stringify(resolved) };
            };
            assert.strictEqual((await discover({ ...options, cubeCli, exec })).executable, officialLauncher);
            // Since CubeMX2 1.2 the command is the bundled Node followed by bin.js.
            const bundled = { ...resolved, command: [path.join(root, "node.exe"), resolved.command[2]] };
            assert.strictEqual(
                (await discover({ ...options, cubeCli, exec: async () => ({ stdout: JSON.stringify(bundled) }) }))
                    .executable,
                officialLauncher
            );
            for (const value of [
                JSON.stringify({ ...resolved, command: [resolved.command[2]] }),
                JSON.stringify({ ...resolved, command: ["cube", "run", resolved.command[2]] }),
                "not json",
                JSON.stringify({ ...resolved, bundle: { ...manifest, version: "2.0.0" } }),
                JSON.stringify({ ...resolved, bundle: { name: "other", version: "1.1.2" } }),
                JSON.stringify({ ...resolved, command: ["cube", "node", "relative/dist/bin.js"] }),
                JSON.stringify({ ...resolved, command: ["cube", "node", path.join(registered, "other.js")] })
            ]) {
                const fallback = await discover({
                    ...options,
                    hints: [executable],
                    exec: async (command) => ({ stdout: command === "cube" ? value : "" })
                });
                assert.strictEqual(fallback.executable, executable);
            }
        });

        await scenario(
            "Ignore stale, malformed and oversized official records and retain fallback discovery",
            async () => {
                const discoverFallback = () =>
                    discover({ ...options, env: { CUBE_BUNDLE_PATH: bundleRoot }, hints: [executable] });
                await writeJson(path.join(registered, "CubeBundle.json"), { ...manifest, name: "other" });
                assert.strictEqual((await discoverFallback()).executable, executable);
                await writeJson(path.join(registered, "CubeBundle.json"), { ...manifest, version: "../escape" });
                assert.strictEqual((await discoverFallback()).executable, executable);
                await writeJson(path.join(registered, "CubeBundle.json"), manifest);
                await fs.rename(officialLauncher, officialLauncher + ".saved");
                assert.strictEqual((await discoverFallback()).executable, executable);
                await fs.rename(officialLauncher + ".saved", officialLauncher);
                await fs.writeFile(registryFile, "malformed");
                assert.strictEqual((await discoverFallback()).executable, executable);
                await fs.writeFile(registryFile, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
                assert.strictEqual((await discoverFallback()).executable, executable);
                await writeJson(registryFile, registry);
            }
        );

        await scenario(
            "Open a registered bundle through its own executable when the root launcher is older",
            async () => {
                const newer = path.join(root, "upgraded/resources/stm32cubemx-application/1.2.0");
                await launcher("upgraded", "stm32cubemx2-1.1.2.exe");
                const own = await launcher("upgraded/resources/stm32cubemx-application/1.2.0/dist", "stm32cubemx2.exe");
                await writeJson(path.join(newer, "CubeBundle.json"), { ...manifest, version: "1.2.0" });
                const upgradedRoot = path.join(root, "upgraded-bundles");
                await writeJson(path.join(upgradedRoot, ".config/external_bundles.json"), {
                    externally_managed_bundles: [{ path: newer }]
                });
                const found = await discover({ ...options, env: { CUBE_BUNDLE_PATH: upgradedRoot } });
                assert.strictEqual(found.executable, own);
                assert.strictEqual(found.version, "1.2.0");
            }
        );

        await scenario("Resolve the application bundle that matches a project's CubeMX2 version", async () => {
            const install = path.join(root, "bundles-install");
            const tool = { executable: await launcher("bundles-install", "stm32cubemx2-1.1.2.exe") };
            const addBundle = async (
                version,
                exec = "${CUBE_BUNDLE_ROOT}/node/node.exe ${CUBE_BUNDLE_ROOT}/dist/bin.js"
            ) => {
                const directory = path.join(install, "resources/stm32cubemx-application", version);
                for (const file of ["dist/stm32cubemx2.exe", "dist/bin.js", "node/node.exe"])
                    await launcher(path.relative(root, path.join(directory, path.dirname(file))), path.basename(file));
                await writeJson(path.join(directory, "CubeBundle.json"), {
                    name: "stm32cubemx-application",
                    version,
                    variables: { CUBE_DCM: "${CUBE_BUNDLE_ROOT}/dcm.json", lower: "x", OTHER: 1 },
                    export: ["CUBE_DCM", "lower", "OTHER", "MISSING"],
                    commands: [{ name: "mx", exec }]
                });
                return directory;
            };
            await assert.rejects(applicationBundle(tool, "1.2.0", { platform: "win32" }), {
                code: "CUBEMX2_BUNDLE_MISSING"
            });
            const older = await addBundle("1.1.2");
            const newer = await addBundle("1.10.0");
            await addBundle("1.3.0", "${CUBE_BUNDLE_ROOT}/../../escape/node.exe ${CUBE_BUNDLE_ROOT}/dist/bin.js");
            await addBundle("1.4.0", "node ${CUBE_BUNDLE_ROOT}/dist/bin.js extra");
            const selected = await applicationBundle(tool, "1.1.2", { platform: "win32" });
            assert.deepStrictEqual(selected, {
                directory: older,
                version: "1.1.2",
                backend: path.join(older, "dist", "stm32cubemx2.exe"),
                node: path.join(older, "node", "node.exe"),
                cli: path.join(older, "dist", "bin.js"),
                env: { CUBE_DCM: older + "/dcm.json" }
            });
            assert.strictEqual((await applicationBundle(tool, "", { platform: "win32" })).directory, newer);
            await assert.rejects(applicationBundle(tool, "1.3.0", { platform: "win32" }), (error) => {
                assert.strictEqual(error.code, "CUBEMX2_VERSION_MISMATCH");
                assert.deepStrictEqual(error.details.installed, ["1.10.0", "1.1.2"]);
                return true;
            });
            // A launcher inside a bundle's dist directory uses that bundle.
            const inside = await applicationBundle(
                { executable: path.join(older, "dist", "stm32cubemx2.exe") },
                "1.1.2",
                { platform: "win32" }
            );
            assert.strictEqual(inside.directory, older);
            await fs.rm(path.join(older, "node", "node.exe"));
            await assert.rejects(applicationBundle(tool, "1.1.2", { platform: "win32" }), { code: "ENOENT" });
        });

        await scenario("Accept executable Linux launchers and avoid Windows discovery commands", async () => {
            const file = await launcher("linux/STM32CubeMX2", "stm32cubemx2-1.1.2");
            const linux = {
                platform: "linux",
                env: { HOME: path.join(root, "linux") },
                exec: async () => {
                    throw new Error("Do not query Windows shortcuts or registry on Linux");
                }
            };
            assert.strictEqual((await installation(file, linux)).version, "1.1.2");
            await assert.rejects(installation(executable, linux), { code: "CUBEMX2_PATH_INVALID" });
            assert.strictEqual((await discover(linux)).executable, file);
            const official = await launcher("official", "stm32cubemx2-1.1.2");
            const xdg = path.join(root, "xdg");
            await writeJson(path.join(xdg, "stm32cube/bundles/.config/external_bundles.json"), registry);
            assert.strictEqual((await discover({ ...linux, env: { XDG_DATA_HOME: xdg } })).executable, official);
            if (process.platform !== "win32") {
                await fs.chmod(file, 0o644);
                await assert.rejects(installation(file, linux), { code: "EACCES" });
            }
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("CubeMX2 launcher validation and installation discovery tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
