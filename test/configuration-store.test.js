"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertAgentSettable } = require("../src/services/configurationStore");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-outside-"));
    const { temp, elf, state, settings, store } = fixture;
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
        assert.strictEqual(snapshot.sampleFrequencyHz, 20);
        assert.strictEqual(settings.get("sampleFrequencyHz"), 20);
        assert.strictEqual(fixture.changed, 1);
        const ioc = path.join(temp, "project space.ioc");
        fs.writeFileSync(ioc, "ProjectManager.FirmwarePackage=STM32Cube FW_H7 V1.13.0\n");
        const selected = await store.update({ iocPath: "project space.ioc" });
        // The store expands Windows 8.3 short names through fs/promises realpath (native binding), so the expectation
        // must use the same implementation.
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
        assert.strictEqual((await store.update({ sampleFrequencyHz: 30.5 })).sampleFrequencyHz, 30.5);
        await assert.rejects(store.update({ sampleFrequencyHz: 30.55 }), { code: "INVALID_CONFIG_VALUE" });

        // Keys the Agent Bridge may not change: openocdPath could point probe calls at any executable and must be
        // refused
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
        assert.strictEqual(store.snapshot().transport, "auto");
        assert.strictEqual((await store.update({ transport: "swd" })).transport, "swd");
        await assert.rejects(store.update({ transport: "swd; shutdown" }), { code: "OPENOCD_TRANSPORT_INVALID" });
        assert.strictEqual(store.snapshot().transport, "swd");
        assert.strictEqual(store.snapshot().rtos, "");
        assert.strictEqual((await store.update({ rtos: "FreeRTOS" })).rtos, "FreeRTOS");
        await assert.rejects(store.update({ rtos: "FreeRTOs" }), { code: "OPENOCD_RTOS_INVALID" });
        assert.strictEqual(store.snapshot().rtos, "FreeRTOS", "A rejected update leaves the setting alone");
        assert.strictEqual((await store.update({ rtos: "" })).rtos, "", "An empty value turns RTOS awareness off");
        assert.strictEqual((await store.update({ probeSerial: "000Aa123" })).probeSerial, "000Aa123");
        await assert.rejects(store.update({ probeSerial: "000Aa123", debugger: "jlink.cfg" }), {
            code: "PROBE_SERIAL_INVALID"
        });
        assert.strictEqual(store.snapshot().debugger, "cmsis-dap.cfg", "A rejected serial leaves all settings intact");
        assert.strictEqual((await store.update({ probeSerial: "000123", debugger: "jlink.cfg" })).probeSerial, "123");
        await assert.rejects(store.update({ probeSerial: "ABC" }), { code: "PROBE_SERIAL_INVALID" });
        assert.strictEqual(
            (await store.update({ debugger: "stlink.cfg", probeSerial: "000aBc" })).probeSerial,
            "000aBc"
        );
    } finally {
        fixture.dispose();
        fs.rmSync(outside, { recursive: true, force: true });
    }

    await scenario("Snapshot unbound SVD without resolving its path", async () => {
        const { loadProvider } = require("./helpers/load-provider");
        const Provider = loadProvider();
        const provider = Object.create(Provider.prototype);
        provider._configurationStore = { snapshot: () => ({}) };
        provider._svdManager = {
            peekBound: async () => null,
            currentPath: () => {
                throw new Error("must not resolve");
            }
        };
        assert.deepStrictEqual(await provider._configurationSnapshot(), { svd: "" });
    });

    await scenario("Roll back failed configuration updates and serialize settings writes", async () => {
        const fixture = createFixture();
        const original = fixture.context.workspaceState.update;
        try {
            const { store, state, settings, context } = fixture;
            await assert.rejects(
                store.update({ debugger: "stlink.cfg", sampleIntervalMs: 0 }),
                (error) => error.code === "INVALID_CONFIG_VALUE"
            );
            assert.strictEqual(state.size, 0);
            context.workspaceState.update = async (key, value) => {
                if (key === "mcu" && value === "bad.cfg") throw Error("disk error");
                return original(key, value);
            };
            await assert.rejects(
                store.update({ debugger: "stlink.cfg", mcu: "bad.cfg" }),
                (error) => error.code === "CONFIG_UPDATE_FAILED" && error.details.rollbackErrors.length === 0
            );
            assert.strictEqual(state.get("debugger"), undefined);
            context.workspaceState.update = async (key, value) => {
                if (key === "mcu" || value === undefined) throw Error("disk error");
                return original(key, value);
            };
            await assert.rejects(
                store.update({ debugger: "stlink.cfg", mcu: "bad.cfg" }),
                (error) => error.details.rollbackErrors.length === 2 && error.details.actual.debugger === "stlink.cfg"
            );
            context.workspaceState.update = original;
            await Promise.all([store.update({ sampleIntervalMs: 25 }), store.update({ sampleIntervalMs: 50 })]);
            assert.strictEqual(settings.get("sampleIntervalMs"), 50);
            await assert.rejects(store.update(null), (error) => error.code === "INVALID_CONFIG_VALUE");
        } finally {
            fixture.context.workspaceState.update = original;
            fixture.dispose();
        }
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
