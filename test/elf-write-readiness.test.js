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
    console.log("ELF write readiness tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
