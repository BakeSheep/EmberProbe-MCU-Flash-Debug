"use strict";
const assert = require("assert");
const { FaultService } = require("../src/services/faultService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    try {
        const fault = new FaultService(
            {
                readFaultInfo: async () => ({
                    values: { cfsr: 1 },
                    targetState: "halted",
                    registers: {},
                    pc: "0x08000104",
                    lr: "0x08000200",
                    sp: "0x20001000",
                    xpsr: "0x01000000"
                }),
                decodeFaultRegisters: () => ({ faultDetected: true, faults: ["IACCVIOL"], exception: "HardFault" })
            },
            {
                nearestFunction: (_functions, address) => (address === 0x08000104 ? { name: "main", offset: 4 } : null)
            }
        );
        const faultResult = await fault.read({}, () => [{ name: "main" }]);
        assert.strictEqual(faultResult.pcSymbol, "main+0x4");
        assert.strictEqual(faultResult.faultDetected, true);
        assert.strictEqual(faultResult.stall, undefined, "no samples, no stall verdict");

        // A hang inside an interrupt: IPSR names the vector, the vector table entry names the handler, and PC samples
        // that stay within a few instructions mark a tight loop
        const faultInfo = require("../src/faultInfo");
        const functions = [
            // Sorted by address, as nearestFunction expects
            { name: "UART7_IRQHandler", address: 0x08000c40, size: 0x20 },
            { name: "Default_Handler", address: 0x08000d00, size: 0x4 },
            { name: "main", address: 0x08001000, size: 0x200 },
            { name: "HAL_DMA_Abort", address: 0x08004a00, size: 0x80 }
        ];
        const nearestFunction = require("../src/elfSymbols").nearestFunction;
        const stuck = (raw) =>
            new FaultService(
                { ...faultInfo, readFaultInfo: async () => ({ values: { cfsr: 0, hfsr: 0, icsr: 0x57 }, ...raw }) },
                { nearestFunction }
            ).read({}, () => functions);
        const irq = await stuck({
            targetState: "running",
            registers: {},
            pc: "0x08004A1C",
            lr: "0x08000C51",
            xpsr: "0x61000057",
            basepri: "0x50",
            primask: "0x00",
            handler: "0x08000C41",
            pcSamples: ["0x08004A18", "0x08004A1C", "0x08004A20"]
        });
        assert.strictEqual(irq.faultDetected, false);
        assert.strictEqual(irq.execution.mode, "handler");
        assert.strictEqual(irq.execution.exception.name, "UART7_IRQn");
        assert.strictEqual(irq.execution.exception.handler, "UART7_IRQHandler");
        assert.strictEqual(irq.execution.exception.irq, 71);
        assert.deepStrictEqual(irq.execution.masks, { basepri: 0x50, primask: 0 });
        assert.strictEqual(irq.stall.verdict, "tightLoop");
        assert.strictEqual(irq.stall.samples[0].symbol, "HAL_DMA_Abort+0x1C");
        assert.strictEqual(irq.stall.samples.length, 4);

        const unhandled = await stuck({ pc: "0x08000D00", xpsr: "0x01000025", handler: "0x08000D01", pcSamples: [] });
        assert.strictEqual(unhandled.execution.exception.name, "IRQ21");
        assert.strictEqual(unhandled.execution.exception.handler, "Default_Handler");
        assert.strictEqual(unhandled.stall, undefined, "a target that was already halted has no samples");

        const moving = await stuck({ pc: "0x08001010", xpsr: "0x01000000", pcSamples: ["0x08004A10", "0x08001100"] });
        assert.strictEqual(moving.execution.mode, "thread");
        assert.strictEqual(moving.stall.verdict, "progressing");
        const sameFunction = await stuck({ pc: "0x08001010", xpsr: "0x01000000", pcSamples: ["0x080011F0"] });
        assert.strictEqual(sameFunction.stall.verdict, "sameFunction");
        const unsymbolized = await stuck({ pc: "0x08100000", xpsr: "0x01000000", pcSamples: ["0x08100400"] });
        assert.strictEqual(unsymbolized.stall.verdict, "unknown");
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
