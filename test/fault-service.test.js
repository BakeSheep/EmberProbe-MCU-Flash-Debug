"use strict";
const assert = require("assert");
const { FaultService } = require("../src/services/faultService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
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
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
