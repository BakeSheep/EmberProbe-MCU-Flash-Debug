"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isSafeCfgPath, findScriptsRoot, discoverTargetConfigs } = require("../src/openocdScripts");

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
    fs.mkdirSync(path.join(target, "geehy"), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, process.platform === "win32" ? "openocd.exe" : "openocd");
    fs.writeFileSync(executable, "");
    fs.writeFileSync(path.join(target, "stm32f4x.cfg"), "");
    fs.writeFileSync(path.join(target, "geehy", "apm32f4x.cfg"), "");
    fs.writeFileSync(path.join(target, "README"), "");
    // macOS exposes /var as a symlink to /private/var. Compare canonical paths so
    // the test checks the discovered directory rather than the OS spelling.
    assert.strictEqual(
        fs.realpathSync(findScriptsRoot(executable)),
        fs.realpathSync(path.join(temp, "openocd", "scripts"))
    );
    assert.deepStrictEqual(discoverTargetConfigs(executable), ["geehy/apm32f4x.cfg", "stm32f4x.cfg"]);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("OpenOCD scripts discovery tests passed");
