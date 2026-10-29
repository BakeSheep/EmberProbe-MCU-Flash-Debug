"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findStDebugTools } = require("../src/services/debugToolPreflight");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-st-tools-")));
try {
    const tools = (bin, platform, names = ["gdb", "objdump", "nm"]) => {
        fs.mkdirSync(bin, { recursive: true });
        for (const name of names) {
            const file = path.join(bin, `arm-none-eabi-${name}${platform === "win32" ? ".exe" : ""}`);
            fs.writeFileSync(file, "fixture");
            fs.chmodSync(file, 0o755);
        }
        return bin;
    };
    const find = (discovery, options = {}) => findStDebugTools(options, discovery);
    for (const platform of ["win32", "linux", "darwin"]) {
        const home = path.join(root, platform);
        const bundles = path.join(
            home,
            platform === "win32"
                ? "AppData/Local"
                : platform === "linux"
                  ? ".local/share"
                  : "Library/Application Support",
            "stm32cube/bundles"
        );
        const discovery = { platform, home, env: {}, roots: [] };
        assert.strictEqual(find(discovery), null);
        const bin = tools(path.join(bundles, "gnu-tools-for-stm32/14.3.1+st.2/bin"), platform);
        assert.strictEqual(find(discovery).armToolchainPath, bin, `${platform} standard bundle location`);
        const newer = tools(path.join(bundles, "gnu-tools-for-stm32/14.3.1+st.10/bin"), platform);
        tools(path.join(bundles, "gnu-tools-for-stm32/99.0.0/bin"), platform, ["gdb", "objdump"]);
        assert.strictEqual(find(discovery).armToolchainPath, newer, "newest complete bundle wins numerically");
        const gdb = path.join(newer, `arm-none-eabi-gdb${platform === "win32" ? ".exe" : ""}`);
        fs.unlinkSync(gdb);
        const split = tools(path.join(bundles, "gnu-gdb-for-stm32/16.3.0+st.1/bin"), platform, ["gdb"]);
        assert.strictEqual(find(discovery).armToolchainPath, newer, "separate GDB bundle supplies missing GDB");
        assert.strictEqual(find(discovery).gdbPath, path.join(split, path.basename(gdb)));
        const selectedBin = tools(path.join(home, "selected-binutils"), platform, ["objdump", "nm"]);
        assert.strictEqual(
            find(discovery, { toolchainPath: selectedBin }).armToolchainPath,
            selectedBin,
            "ST GDB completes explicitly selected binutils before replacing them"
        );
        assert.strictEqual(
            find(discovery, { configuredObjdump: path.join(selectedBin, path.basename(gdb).replace("gdb", "objdump")) })
                .armToolchainPath,
            selectedBin,
            "ST GDB completes an explicit objdump/nm pair"
        );
        assert.strictEqual(find(discovery, { prefix: "other" }), null, "custom prefix must not select ARM tools");
        assert.strictEqual(
            find(discovery, { gdbPath: path.join(bin, path.basename(gdb)) }).gdbPath,
            path.join(bin, path.basename(gdb)),
            "explicit GDB is preserved when completing a tool set"
        );
        assert.strictEqual(
            find(discovery, { gdbPath: path.join(home, "missing") }).armToolchainPath,
            newer,
            "stale settings do not prevent recovery"
        );
        if (platform === "linux" && process.platform !== "win32") {
            fs.chmodSync(path.join(split, "arm-none-eabi-gdb"), 0o644);
            assert.strictEqual(find(discovery).armToolchainPath, bin, "non-executable GDB is skipped");
        }
    }
    for (const [platform, envKey] of [
        ["win32", "LOCALAPPDATA"],
        ["linux", "XDG_DATA_HOME"]
    ]) {
        const data = path.join(root, `${platform}-custom-data`);
        const bin = tools(path.join(data, "stm32cube/bundles/gnu-tools-for-stm32/14.3.1/bin"), platform);
        assert.strictEqual(find({ platform, home: "", env: { [envKey]: data }, roots: [] }).armToolchainPath, bin);
    }
    for (const [platform, install, relative] of [
        ["win32", "STM32CubeCLT_1.18.0", "GNU-tools-for-STM32/bin"],
        ["linux", "stm32cubeclt_1.18.0", "GNU-tools-for-STM32/bin"],
        ["darwin", "STM32CubeCLT_1.18.0", "GNU-tools-for-STM32/bin"],
        [
            "win32",
            "STM32CubeIDE_1.18.0",
            "STM32CubeIDE/plugins/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.13.3.win32_1.0/tools/bin"
        ],
        [
            "linux",
            "stm32cubeide_1.18.0",
            "plugins/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.13.3.linux64_1.0/tools/bin"
        ],
        [
            "darwin",
            "STM32CubeIDE.app",
            "Contents/Eclipse/plugins/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.13.3.macosx_1.0/tools/bin"
        ]
    ]) {
        const parent = path.join(root, `legacy-${platform}-${install}`);
        const bin = tools(path.join(parent, install, relative), platform);
        const discovery = { platform, home: "", env: {}, roots: [parent] };
        assert.strictEqual(find(discovery).armToolchainPath, bin, `${platform} ${install}`);
        assert.strictEqual(
            find({ ...discovery, roots: [path.join(parent, install)] }).armToolchainPath,
            bin,
            "root may itself be an installation"
        );
    }
    const ignored = path.join(root, "ignored");
    tools(path.join(ignored, "unrelated/bin"), "linux");
    tools(path.join(ignored, "deep/ST/STM32CubeCLT_1.18.0/GNU-tools-for-STM32/bin"), "linux");
    const file = path.join(root, "not-a-directory");
    fs.writeFileSync(file, "fixture");
    assert.strictEqual(find({ platform: "linux", home: "", env: {}, roots: [ignored, file, "relative"] }), null);
    assert.strictEqual(find({ platform: "unsupported", env: {}, home: "", roots: [] }), null);
    console.log("ST toolchain discovery tests passed");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
