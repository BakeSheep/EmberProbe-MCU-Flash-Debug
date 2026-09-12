"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertAgentSettable } = require("../src/services/configurationStore");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-outside-"));
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        const snapshot = await store.update({
            elf: "firmware.elf",
            debugger: "cmsis-dap.cfg",
            mcu: "stm32f4x.cfg",
            sampleIntervalMs: 50
        });
        assert.ok(snapshot.elf.endsWith("/firmware.elf"));
        assert.strictEqual(snapshot.debugger, "cmsis-dap.cfg");
        assert.strictEqual(snapshot.sampleIntervalMs, 50);
        assert.strictEqual(fixture.changed, 1);
        const ioc = path.join(temp, "project space.ioc");
        fs.writeFileSync(ioc, "ProjectManager.FirmwarePackage=STM32Cube FW_H7 V1.13.0\n");
        const selected = await store.update({ iocPath: "project space.ioc" });
        // store 经 fs/promises realpath（native 绑定）展开 Windows 8.3 短名，期望值须用同一实现。
        assert.strictEqual(selected.iocPath, await fs.promises.realpath(ioc));
        assert.strictEqual(state.get("mcu.iocPath"), selected.iocPath);
        assert.strictEqual(fixture.changed, 2);
        settings.set("cubemxPath", "C:/ST/STM32CubeMX.exe");
        assert.strictEqual(store.snapshot().cubemxPath, "C:/ST/STM32CubeMX.exe");
        assert.throws(() => assertAgentSettable({ cubemxPath: "other.exe" }), { code: "CONFIG_KEY_FORBIDDEN" });
        await assert.rejects(store.update({ iocPath: "", cubemxPath: "other.exe" }), { code: "CONFIG_KEY_FORBIDDEN" });
        assert.strictEqual(store.snapshot().iocPath, selected.iocPath);
        for (const key of ["firmwarePackage", "firmwareVersion", "repository"])
            await assert.rejects(store.update({ [key]: "value" }), { code: "UNSUPPORTED_CONFIG" });
        await assert.rejects(store.update({ iocPath: "firmware.elf" }), { code: "INVALID_FILE_TYPE" });
        fs.writeFileSync(path.join(outside, "outside.ioc"), "fixture");
        await assert.rejects(store.update({ iocPath: path.join(outside, "outside.ioc") }), {
            code: "PATH_OUTSIDE_WORKSPACE"
        });
        assert.strictEqual((await store.update({ iocPath: "" })).iocPath, "");
        await assert.rejects(
            () => store.update({ sampleIntervalMs: 1 }),
            (error) => error.code === "INVALID_CONFIG_VALUE"
        );

        // Agent Bridge 禁改键：openocdPath 可把探针调用引向任意可执行文件，必须拒绝
        assert.throws(
            () => assertAgentSettable({ openocdPath: "/tmp/evil" }),
            (error) => error.code === "CONFIG_KEY_FORBIDDEN" && error.retryable === false
        );
        assert.throws(
            () => assertAgentSettable({ mcu: "stm32f4x.cfg", openocdPath: "openocd" }),
            (error) => error.code === "CONFIG_KEY_FORBIDDEN"
        );
        assert.doesNotThrow(() => assertAgentSettable({ mcu: "stm32f4x.cfg", tclPort: 7777 }));
        assert.doesNotThrow(() => assertAgentSettable(undefined));
        const hidden = path.join(temp, "..firmware.ELF");
        fs.writeFileSync(hidden, "fixture");
        const canonical = (file) => fs.realpathSync(file).replace(/\\/g, "/");
        assert.strictEqual(store.workspacePath("..firmware.ELF", ".elf"), canonical(hidden));
        assert.strictEqual(store.workspacePath("./firmware.elf", ".elf"), canonical(elf));
        fs.writeFileSync(path.join(outside, "outside.elf"), "fixture");
        fs.symlinkSync(outside, path.join(temp, "escape"), process.platform === "win32" ? "junction" : "dir");
        assert.throws(
            () => store.workspacePath("escape/outside.elf", ".elf"),
            (error) => error.code === "PATH_OUTSIDE_WORKSPACE"
        );
        const inside = path.join(temp, "images");
        fs.mkdirSync(inside);
        fs.writeFileSync(path.join(inside, "firmware.elf"), "fixture");
        fs.symlinkSync(inside, path.join(temp, "alias"), process.platform === "win32" ? "junction" : "dir");
        assert.strictEqual(
            store.workspacePath("alias/firmware.elf", ".elf"),
            canonical(path.join(inside, "firmware.elf"))
        );
    } finally {
        fixture.dispose();
        fs.rmSync(outside, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
