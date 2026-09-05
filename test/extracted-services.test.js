"use strict";
const assert = require("assert");
const { WatchListStore } = require("../src/services/watchListStore");
const { createChipParser } = require("../src/chip/parser");
const { parseDwarf, readULEB } = require("../src/dwarf");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    try {
        let symbols = [{ name: "tick", address: 1 }],
            changed = 0;
        const errors = [];
        const store = new WatchListStore({
            state: fixture.context.workspaceState,
            symbols: () => symbols,
            normalize: (items) => items.map((item) => ({ ...item, address: symbols[0].address })),
            onChanged: () => changed++,
            onError: (error) => errors.push(error)
        });
        await store.save("watch", [{ name: "tick", address: 0 }]);
        assert.strictEqual(store.read("watch")[0].address, 1);
        assert.strictEqual(store.read("watch"), store.read("watch"));
        symbols = [{ name: "tick", address: 2 }];
        store.invalidate("watch");
        assert.strictEqual(store.read("watch")[0].address, 2);
        const rebound = await store.rebind(["watch", "watch", "empty"], symbols);
        assert.strictEqual(rebound.size, 2);
        assert.strictEqual(fixture.state.get("watch")[0].address, 2);
        await store.rebind(["watch"], symbols);
        assert.ok(changed >= 3);
        store.invalidate();
        symbols = null;
        assert.deepStrictEqual(store.read("watch"), []);
        assert.strictEqual(errors.length, 1);
    } finally {
        fixture.dispose();
    }
    const parser = createChipParser("stm32f1x.cfg");
    for (const line of [
        "",
        "EP_KV name stm32f1x.cpu",
        "EP_KV state halted",
        "EP_KV endian little",
        "EP_KV transport swd",
        "EP_KV unknown ignored",
        "pc (/32): 0x08000100",
        "sp (/32): 0x20002000",
        "lr (/32): 0x08000004",
        "0xe000ed00: 410fc241",
        "0xe0042000: 10016413",
        "0x1fff7a22: 00000200",
        "0x1fff7a10: 11223344 55667788 99aabbcc",
        "CMSIS-DAP: FW Version = 2.0",
        "SWD DPIDR 0x2ba01477",
        "Info : clock speed 4000 kHz",
        "Info : Target voltage: 3.300000",
        "Info : flash 'stm32f2x' found at 0x08000000",
        "Info : halted due to breakpoint, current mode: Thread"
    ])
        parser.handleLine(line);
    const info = parser.finish(0);
    assert.strictEqual(info.core, "Cortex-M4");
    assert.strictEqual(info.deviceId, "0x413");
    assert.strictEqual(info.transport, "SWD");
    assert.strictEqual(info.targetState, "halted");
    assert.strictEqual(info.flashSize, "512 KiB");
    assert.ok(info.uid);
    for (const [line, name] of [
        ["STLINK V2J37S7", "ST-Link"],
        ["J-Link", "J-Link"],
        ["DAPLink", "DAPLink"],
        ["CMSIS-DAPv2", "CMSIS-DAP"]
    ]) {
        const p = createChipParser("nordic/nrf52.cfg");
        p.handleLine(line);
        p.handleLine("Info : [cpu] Cortex-M4 r0p1 processor detected");
        p.handleLine("JTAG tap: cpu");
        assert.strictEqual(p.finish(0).probeName, name);
    }
    const missing = createChipParser("unknown.cfg");
    assert.throws(
        () => missing.finish(0),
        (error) => error.i18nKey === "chip.noInfo"
    );
    assert.throws(
        () => missing.finish(1),
        (error) => error.i18nKey === "chip.exitCode"
    );
    missing.handleLine("Error: target unavailable");
    assert.throws(() => missing.finish(1), /target unavailable/);
    const tail = createChipParser("unknown.cfg");
    for (let i = 0; i < 405; i++) tail.handleLine("unrecognized " + i);
    assert.strictEqual(tail.rawLines().length, 400);
    assert.throws(() => tail.finish(1), /404/);
    const invalid = parseDwarf(Buffer.from("not elf"));
    assert.strictEqual(invalid.types.size, 0);
    assert.ok(invalid.diagnostics.some((d) => d.code === "DWARF_INVALID_ELF"));
    console.log("Watch list and parser behavior tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
