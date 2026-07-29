"use strict";
const assert = require("assert");
const { WriteAuthorization, fingerprintWritePlan } = require("../src/writeAuthorization");

function makePlan(overrides = {}) {
    return {
        elfResult: { elf: { path: "firmware.elf", sha256: overrides.sha256 || "abc123" } },
        items: [{
            name: "kp",
            address: 0x20000000,
            type: "f32",
            bytes: overrides.bytes || [0, 0, 0, 63],
            value: overrides.value ?? 0.5
        }]
    };
}

(async () => {
    const values = new Map();
    const storage = {
        get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        update: async (key, value) => values.set(key, value)
    };
    let now = 1000;
    let nextId = 0;
    const auth = new WriteAuthorization(storage, { now: () => now, createId: () => `confirm-${++nextId}`, ttlMs: 5000 });
    const plan = makePlan();

    const requested = auth.authorize(plan);
    assert.strictEqual(requested.authorized, false);
    assert.strictEqual(requested.response.confirmationRequired, true);
    assert.strictEqual(requested.response.confirmationId, "confirm-1");
    assert.strictEqual(requested.response.items[0].name, "kp");
    assert.strictEqual(requested.response.items[0].address, "0x20000000");

    const once = auth.authorize(plan, { confirmationId: "confirm-1" });
    assert.deepStrictEqual(once, { authorized: true, mode: "once", remember: false });
    assert.throws(() => auth.authorize(plan, { confirmationId: "confirm-1" }), error => error.code === "WRITE_CONFIRMATION_INVALID");

    const changedElf = auth.authorize(plan).response.confirmationId;
    assert.throws(
        () => auth.authorize(makePlan({ sha256: "different" }), { confirmationId: changedElf }),
        error => error.code === "ELF_CHANGED_DURING_WRITE_CONFIRMATION"
    );
    const changedValue = auth.authorize(plan).response.confirmationId;
    assert.throws(
        () => auth.authorize(makePlan({ bytes: [0, 0, 128, 63], value: 1 }), { confirmationId: changedValue }),
        error => error.code === "WRITE_CONFIRMATION_INVALID"
    );

    const expired = auth.authorize(plan).response.confirmationId;
    now += 5001;
    assert.throws(() => auth.authorize(plan, { confirmationId: expired }), error => error.code === "WRITE_CONFIRMATION_INVALID");

    const rememberedId = auth.authorize(plan).response.confirmationId;
    const remembered = auth.authorize(plan, { confirmationId: rememberedId, remember: true });
    assert.deepStrictEqual(remembered, { authorized: true, mode: "workspace", remember: true });
    await auth.trustWorkspace();
    assert.deepStrictEqual(auth.status(), { trusted: true, scope: "workspace" });
    assert.deepStrictEqual(auth.authorize(makePlan({ bytes: [1, 2, 3, 4] })), { authorized: true, mode: "workspace", remember: false });
    await auth.reset();
    assert.deepStrictEqual(auth.status(), { trusted: false, scope: "workspace" });
    assert.strictEqual(auth.authorize(plan).authorized, false);

    assert.strictEqual(fingerprintWritePlan(plan), fingerprintWritePlan(makePlan()));
    assert.notStrictEqual(fingerprintWritePlan(plan), fingerprintWritePlan(makePlan({ bytes: [1, 2, 3, 4] })));
    console.log("Write authorization tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
