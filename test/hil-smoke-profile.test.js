"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadConfig, parseArgs, profileNames, resolveProfile, sameValue, toWslPath } = require("./hil/smoke-profile");

const invalid = (pattern) => (error) => error.code === "HIL_SMOKE_CONFIG_INVALID" && pattern.test(error.message);

const config = {
    defaults: {
        openocd: { win32: "C:\\tools\\openocd\\bin\\openocd.exe", linux: "/opt/openocd/bin/openocd" },
        toolchain: { win32: "C:\\arm\\bin", linux: "/opt/arm/bin" },
        transport: "swd",
        adapterSpeedKhz: 4000
    },
    profiles: [
        {
            name: "h750-jlink",
            probe: "jlink.cfg",
            target: "stm32h7x.cfg",
            probeSerial: "123456",
            elf: "C:\\fw\\h750.elf",
            usb: { hardwareId: "1366:0101" },
            variables: { read: ["g_appDebug.produced"], write: { name: "g_appDebug.command_gain", value: 1.25 } }
        },
        {
            name: "f407-cmsis-dap",
            probe: "cmsis-dap.cfg",
            target: "stm32f4x.cfg",
            adapterSpeedKhz: 1000,
            elf: { win32: "D:\\fw\\f407.elf", linux: "/home/me/f407.elf" },
            debug: false,
            usb: { busid: "2-4" },
            variables: { read: ["g_counter"] }
        }
    ]
};

const windows = resolveProfile(config, "h750-jlink", "win32");
assert.strictEqual(windows.openocd, "C:\\tools\\openocd\\bin\\openocd.exe");
assert.strictEqual(windows.elf, "C:\\fw\\h750.elf");
assert.strictEqual(windows.transport, "swd");
assert.strictEqual(windows.adapterSpeedKhz, 4000);
assert.deepStrictEqual(windows.variables.write, { name: "g_appDebug.command_gain", value: "1.25" });
assert.strictEqual(windows.debug, true);

// A plain Windows ELF path is reachable from WSL; tool paths come from the linux entry.
const linux = resolveProfile(config, "h750-jlink", "linux");
assert.strictEqual(linux.elf, "/mnt/c/fw/h750.elf");
assert.strictEqual(linux.openocd, "/opt/openocd/bin/openocd");
assert.deepStrictEqual(linux.usb, { hardwareId: "1366:0101" });

const other = resolveProfile(config, "f407-cmsis-dap", "linux");
assert.strictEqual(other.elf, "/home/me/f407.elf");
assert.strictEqual(other.adapterSpeedKhz, 1000);
assert.strictEqual(other.debug, false);
assert.strictEqual(other.variables.write, null);
assert.deepStrictEqual(other.usb, { busid: "2-4" });

const withProfile = (patch) => ({ ...config, profiles: [{ ...config.profiles[0], ...patch }] });
assert.throws(() => resolveProfile(config, "missing", "win32"), invalid(/Unknown/));
assert.throws(() => resolveProfile(config, "h750-jlink", "darwin"), invalid(/platform/));
assert.throws(() => resolveProfile(withProfile({ probe: "../evil.cfg" }), "h750-jlink", "win32"), invalid(/probe/));
assert.throws(() => resolveProfile(withProfile({ transport: "usb" }), "h750-jlink", "win32"), invalid(/transport/));
assert.throws(() => resolveProfile(withProfile({ adapterSpeedKhz: -1 }), "h750-jlink", "win32"), invalid(/speed/i));
assert.throws(() => resolveProfile(withProfile({ elf: "fw.elf" }), "h750-jlink", "win32"), invalid(/absolute/));
assert.throws(() => resolveProfile(withProfile({ variables: { read: [] } }), "h750-jlink", "win32"), invalid(/read/));
assert.throws(
    () => resolveProfile(withProfile({ usb: { hardwareId: "jlink" } }), "h750-jlink", "linux"),
    invalid(/hardwareId/)
);
assert.throws(() => resolveProfile(withProfile({ name: "H750 JLink" }), "H750 JLink", "win32"), invalid(/names/));
assert.throws(
    () =>
        resolveProfile(
            { ...config, defaults: { ...config.defaults, toolchain: { win32: "C:\\arm" } } },
            "h750-jlink",
            "linux"
        ),
    invalid(/toolchain/)
);

assert.deepStrictEqual(profileNames(config), ["h750-jlink", "f407-cmsis-dap"]);
assert.deepStrictEqual(profileNames(config, ["f407-cmsis-dap", "f407-cmsis-dap"]), ["f407-cmsis-dap"]);
assert.throws(() => profileNames(config, ["nope"]), invalid(/Unknown/));
assert.throws(() => profileNames({ profiles: [] }), invalid(/no profiles/));

assert.strictEqual(toWslPath("C:\\Users\\me\\repo"), "/mnt/c/Users/me/repo");
assert.strictEqual(toWslPath("d:/fw/a.elf"), "/mnt/d/fw/a.elf");
assert.strictEqual(toWslPath("/already/linux"), "/already/linux");

assert.deepStrictEqual(parseArgs(["--profile", "a,b", "--profile=c", "--pause", "--config", "x.json"]), {
    profiles: ["a", "b", "c"],
    pause: true,
    config: "x.json"
});
assert.throws(() => parseArgs(["--profile"]), invalid(/needs a value/));
assert.throws(() => parseArgs(["--flash-anyway", "1"]), invalid(/Unknown option/));
assert.throws(() => parseArgs(["stray"]), invalid(/Unexpected/));
assert.strictEqual(parseArgs(["--repeat", "5"]).repeat, 5);
for (const value of ["0", "51", "1.5", "x"])
    assert.throws(() => parseArgs(["--repeat", value]), invalid(/--repeat/), value);

// Optional checks are absent by default and validated when present; the SVD follows the ELF path rules.
assert.deepStrictEqual(windows.checks, {});
assert.strictEqual(windows.svd, "");
const checked = withProfile({
    svd: "C:\\fw\\chip.svd",
    checks: {
        sampling: { variable: "g_counter", increasing: true },
        breakpoint: "App_Tick",
        rtosTasks: ["control"],
        peripherals: {
            read: ["TIM7.PSC"],
            write: { target: "TIM7.PSC", value: 1 },
            reject: [{ target: "TIM7.EGR", value: "1", code: "PERIPHERAL_WRITE_NOT_ALLOWED" }]
        },
        negative: { readOnly: "uxTopUsedPriority" }
    }
});
const linuxChecked = resolveProfile(checked, "h750-jlink", "linux");
assert.strictEqual(linuxChecked.svd, "/mnt/c/fw/chip.svd");
assert.deepStrictEqual(linuxChecked.checks.sampling, {
    variable: "g_counter",
    increasing: true,
    count: 20,
    intervalMs: 50
});
assert.strictEqual(linuxChecked.checks.breakpoint, "App_Tick");
assert.deepStrictEqual(linuxChecked.checks.peripherals.write, { target: "TIM7.PSC", value: "1" });
assert.deepStrictEqual(linuxChecked.checks.negative, { readOnly: "uxTopUsedPriority", outOfBounds: null });
const badCheck = (checks, pattern, extra = {}) =>
    assert.throws(
        () => resolveProfile(withProfile({ svd: "C:\\fw\\chip.svd", ...extra, checks }), "h750-jlink", "win32"),
        invalid(pattern)
    );
badCheck({ sampling: { variable: "x", count: 1 } }, /sampling.count/);
badCheck({ sampling: { variable: "x", intervalMs: 1 } }, /sampling.intervalMs/);
badCheck({ breakpoint: "main; rm" }, /function name/);
badCheck({ rtosTasks: [] }, /rtosTasks/);
badCheck({ peripherals: { read: [] } }, /peripherals.read/);
badCheck({ peripherals: { read: ["A.B"], reject: [{ target: "A.B", value: "1" }] } }, /reject code/);
badCheck({ peripherals: { read: ["A.B"] } }, /needs an svd/, { svd: undefined });

assert.ok(sameValue(1.2500000476837158, "1.25"));
assert.ok(sameValue(0, "0"));
assert.ok(!sameValue(1.3, "1.25"));
assert.ok(sameValue("ON", "ON"));

// The shipped example must stay loadable and valid for both platforms.
const example = loadConfig(path.join(__dirname, "hil", "smoke.example.json"));
for (const name of profileNames(example))
    for (const platform of ["win32", "linux"]) assert.ok(resolveProfile(example, name, platform).usb.hardwareId);
assert.throws(() => loadConfig(path.join(__dirname, "hil", "missing.json")), invalid(/Cannot read/));
const broken = path.join(require("os").tmpdir(), `emberprobe-smoke-${process.pid}.json`);
fs.writeFileSync(broken, "{");
try {
    assert.throws(() => loadConfig(broken), invalid(/valid JSON/));
} finally {
    fs.rmSync(broken, { force: true });
}

console.log("HIL smoke profile tests passed");
