"use strict";

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { WriteAuthorization } = require("../src/writeAuthorization");
const { FlashAuthorization } = require("../src/flashAuthorization");

(async () => {
    const state = new Map();
    const Provider = loadProvider({
        window: { showWarningMessage: () => assert.fail("Agent writes must not open an operation approval dialog") }
    });
    const provider = Object.create(Provider.prototype);
    let writes = 0;
    const connection = {
        kind: "openocd",
        probe: "jlink.cfg",
        target: "stm32h7x.cfg",
        transport: "swd",
        probeSerial: "1234"
    };
    Object.assign(provider, {
        _prepareRequestedLayouts: async () => {},
        _prepareWriteConnection: async () => connection,
        _debugBridge: { agentStatus: () => ({ state: "none" }) },
        _writeAuthorization: new WriteAuthorization({
            get: (key) => state.get(key),
            update: async (key, value) => state.set(key, value)
        }),
        _agentWritePlan: (values) => ({
            elfResult: { elf: { path: "firmware.elf", sha256: "firmware" } },
            items: values.map(({ name, value }) => ({ name, value, address: 0x20000000, type: "u32", bytes: [value] }))
        }),
        _withAgentProbe: (handler) => handler({ session: {}, source: "test" }),
        _executeWritePlan: async () => {
            writes++;
            return { results: [{ verified: true }] };
        }
    });
    const values = [{ name: "word", value: 32 }];
    const plan = await provider._writeAgentVariables({ values });
    assert(plan.confirmationRequired);
    assert.strictEqual(writes, 0);
    await assert.rejects(provider._writeAgentVariables({ values, confirmationId: "unknown" }), {
        code: "WRITE_CONFIRMATION_INVALID"
    });
    await assert.rejects(
        provider._writeAgentVariables({ values: [{ name: "word", value: 33 }], confirmationId: plan.confirmationId }),
        { code: "WRITE_CONFIRMATION_INVALID" }
    );
    assert.strictEqual(writes, 0);
    const once = await provider._writeAgentVariables({ values });
    const result = await provider._writeAgentVariables({ values, confirmationId: once.confirmationId });
    assert(result.results[0].verified);
    assert.strictEqual(result.permission.mode, "once");
    assert.strictEqual(result.permission.trusted, false);
    await assert.rejects(provider._writeAgentVariables({ values, confirmationId: once.confirmationId }), {
        code: "WRITE_CONFIRMATION_INVALID"
    });
    const remembered = await provider._writeAgentVariables({ values });
    await provider._writeAgentVariables({ values, confirmationId: remembered.confirmationId, remember: true });
    const trusted = await provider._writeAgentVariables({ values: [{ name: "word", value: 34 }] });
    assert.strictEqual(trusted.permission.trusted, true);
    assert.strictEqual(writes, 3);
    await provider._writeAuthorization.reset();
    assert((await provider._writeAgentVariables({ values })).confirmationRequired);
    assert.strictEqual(writes, 3);

    const flash = new FlashAuthorization();
    const image = { elf: { path: "firmware.elf", sha256: "firmware" }, ...connection };
    const verify = flash.authorize({ ...image, operation: "flash.verify" });
    assert.match(verify.question, /halts/);
    assert.throws(() => flash.authorize(image, verify.confirmationId), { code: "FLASH_CONFIRMATION_INVALID" });
    const program = flash.authorize(image);
    assert.throws(() => flash.authorize({ ...image, operation: "flash.verify" }, program.confirmationId), {
        code: "FLASH_CONFIRMATION_INVALID"
    });
    assert.throws(() => flash.authorize({ ...image, operation: "invalid" }), { code: "FLASH_CONFIRMATION_INVALID" });
    const fresh = flash.authorize({ ...image, operation: "flash.verify" });
    assert(flash.authorize({ ...image, operation: "flash.verify" }, fresh.confirmationId).authorized);
    assert.throws(() => flash.authorize({ ...image, operation: "flash.verify" }, fresh.confirmationId), {
        code: "FLASH_CONFIRMATION_INVALID"
    });
    console.log("Agent conversation confirmation, explicit remembered permission and operation binding passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
