"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    isSafeCfgPath,
    findScriptsRoot,
    discoverTargetConfigs,
    discoverInterfaceConfigs,
    resolveOpenOcdLaunch
} = require("../src/openocdScripts");

assert.strictEqual(isSafeCfgPath("stm32f4x.cfg"), true);
assert.strictEqual(isSafeCfgPath("geehy/apm32f4x.cfg"), true);
assert.strictEqual(isSafeCfgPath("vendor/family/chip.cfg"), true);
assert.strictEqual(isSafeCfgPath("../outside.cfg"), false);
assert.strictEqual(isSafeCfgPath("geehy/../outside.cfg"), false);
assert.strictEqual(isSafeCfgPath("geehy\\apm32f4x.cfg"), false);
assert.strictEqual(isSafeCfgPath("/absolute.cfg"), false);
assert.strictEqual(isSafeCfgPath("C:/absolute.cfg"), false);
assert.strictEqual(isSafeCfgPath("geehy//apm32f4x.cfg"), false);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-openocd-"));
try {
    // xPack layout: bin/openocd.exe and openocd/scripts/ are siblings.
    const bin = path.join(temp, "bin");
    const target = path.join(temp, "openocd", "scripts", "target");
    const interfaceDir = path.join(temp, "openocd", "scripts", "interface");
    fs.mkdirSync(path.join(target, "geehy"), { recursive: true });
    fs.mkdirSync(path.join(interfaceDir, "wch"), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, process.platform === "win32" ? "openocd.exe" : "openocd");
    fs.writeFileSync(executable, "", { mode: 0o755 });
    fs.writeFileSync(path.join(target, "stm32f4x.cfg"), "");
    fs.writeFileSync(path.join(target, "geehy", "apm32f4x.cfg"), "");
    fs.writeFileSync(path.join(interfaceDir, "cmsis-dap.cfg"), "");
    fs.writeFileSync(path.join(interfaceDir, "ch347.cfg"), "");
    fs.writeFileSync(path.join(interfaceDir, "wch", "vendor-probe.cfg"), "");
    fs.writeFileSync(path.join(target, "README"), "");
    fs.writeFileSync(path.join(interfaceDir, "README"), "");
    // macOS exposes /var as a symlink to /private/var. Compare canonical paths so
    // the test checks the discovered directory rather than the OS spelling.
    assert.strictEqual(
        fs.realpathSync(findScriptsRoot(executable)),
        fs.realpathSync(path.join(temp, "openocd", "scripts"))
    );
    assert.deepStrictEqual(discoverTargetConfigs(executable), ["geehy/apm32f4x.cfg", "stm32f4x.cfg"]);
    assert.deepStrictEqual(discoverInterfaceConfigs(executable), [
        "ch347.cfg",
        "cmsis-dap.cfg",
        "wch/vendor-probe.cfg"
    ]);
    const launch = resolveOpenOcdLaunch(executable, "cmsis-dap.cfg", "geehy/apm32f4x.cfg");
    assert.strictEqual(launch.scriptsRoot, fs.realpathSync(path.join(temp, "openocd", "scripts")));
    assert.strictEqual(launch.cwd, launch.scriptsRoot, "OpenOCD must run from its trusted scripts directory");
    assert.strictEqual(launch.probePath, fs.realpathSync(path.join(interfaceDir, "cmsis-dap.cfg")));
    assert.strictEqual(launch.targetPath, fs.realpathSync(path.join(target, "geehy", "apm32f4x.cfg")));
    assert.throws(
        () => resolveOpenOcdLaunch(executable, "missing.cfg", "stm32f4x.cfg"),
        (error) => error.code === "OPENOCD_CONFIG_NOT_FOUND"
    );
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("OpenOCD scripts discovery tests passed");
