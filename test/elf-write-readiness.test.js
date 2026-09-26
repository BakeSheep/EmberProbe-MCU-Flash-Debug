"use strict";

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");

(async () => {
    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    let planned = false;
    provider._elfService = {
        ready: async () => {
            throw Object.assign(new Error("DWARF type information is unavailable"), { code: "DWARF_PARSE_FAILED" });
        }
    };
    provider._agentWritePlan = () => {
        planned = true;
    };
    await assert.rejects(provider._writeAgentVariables({ values: [{ name: "value", value: 1 }] }), {
        code: "DWARF_PARSE_FAILED"
    });
    assert.strictEqual(planned, false, "writes must stop before planning when DWARF is unavailable");
    delete provider._agentWritePlan;
    provider.readElfSymbols = () => ({
        elf: { path: "missing" },
        symbols: [
            { name: "flag", address: 0x20000000, size: 1, watchType: "u8", hasDwarfWriteType: true, isBoolean: true },
            {
                name: "group",
                address: 0x20000001,
                size: 1,
                isComposite: true,
                compositeLayout: {
                    kind: "struct",
                    byteSize: 1,
                    members: [{ name: "enabled", offset: 0, byteSize: 1, watchType: "u8", isBoolean: true }]
                }
            }
        ]
    });
    for (const name of ["flag", "group.enabled"])
        assert.throws(() => provider._agentWritePlan([{ name, value: 2 }], { refreshSymbols: false }), {
            code: "INVALID_WRITE_VALUE"
        });
    assert.throws(() => provider._agentWritePlan([{ name: "flag", value: 1 }], { refreshSymbols: false }), {
        code: "WRITE_NOT_ALLOWED"
    });
    console.log("ELF write readiness tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
