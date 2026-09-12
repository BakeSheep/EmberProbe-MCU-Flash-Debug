"use strict";
const assert = require("assert");
const { WriteAuthorization, fingerprintWritePlan } = require("../src/writeAuthorization");
const { FlashAuthorization } = require("../src/flashAuthorization");

function makePlan(overrides = {}) {
    return {
        elfResult: { elf: { path: "firmware.elf", sha256: overrides.sha256 || "abc123" } },
        items: [
            {
                name: "kp",
                address: 0x20000000,
                type: "f32",
                bytes: overrides.bytes || [0, 0, 0, 63],
                value: overrides.value ?? 0.5
            }
        ]
    };
}

(async () => {
    const values = new Map();
    const storage = {
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => values.set(key, value)
    };
    let now = 1000;
    let nextId = 0;
    const auth = new WriteAuthorization(storage, {
        now: () => now,
        createId: () => `confirm-${++nextId}`,
        ttlMs: 5000
    });
    const plan = makePlan();

    const requested = auth.authorize(plan);
    assert.strictEqual(requested.authorized, false);
    assert.strictEqual(requested.response.confirmationRequired, true);
    assert.strictEqual(requested.response.confirmationId, "confirm-1");
    assert.strictEqual(requested.response.items[0].name, "kp");
    assert.strictEqual(requested.response.items[0].address, "0x20000000");

    const once = auth.authorize(plan, { confirmationId: "confirm-1" });
    assert.deepStrictEqual(once, { authorized: true, mode: "once", remember: false });
    assert.throws(
        () => auth.authorize(plan, { confirmationId: "confirm-1" }),
        (error) => error.code === "WRITE_CONFIRMATION_INVALID"
    );

    const changedElf = auth.authorize(plan).response.confirmationId;
    assert.throws(
        () => auth.authorize(makePlan({ sha256: "different" }), { confirmationId: changedElf }),
        (error) => error.code === "ELF_CHANGED_DURING_WRITE_CONFIRMATION"
    );
    const changedValue = auth.authorize(plan).response.confirmationId;
    assert.throws(
        () => auth.authorize(makePlan({ bytes: [0, 0, 128, 63], value: 1 }), { confirmationId: changedValue }),
        (error) => error.code === "WRITE_CONFIRMATION_INVALID"
    );

    const expired = auth.authorize(plan).response.confirmationId;
    now += 5001;
    assert.throws(
        () => auth.authorize(plan, { confirmationId: expired }),
        (error) => error.code === "WRITE_CONFIRMATION_INVALID"
    );

    const rememberedId = auth.authorize(plan).response.confirmationId;
    const remembered = auth.authorize(plan, { confirmationId: rememberedId, remember: true });
    assert.deepStrictEqual(remembered, { authorized: true, mode: "workspace", remember: true });
    await auth.trustWorkspace(plan);
    const trustedStatus = auth.status(plan);
    assert.strictEqual(trustedStatus.trusted, true);
    assert.strictEqual(trustedStatus.scope, "workspace");
    assert.ok(trustedStatus.trustedExpiresAt, "trusted status must expose the expiry timestamp");
    assert.deepStrictEqual(auth.authorize(makePlan({ bytes: [1, 2, 3, 4] })), {
        authorized: true,
        mode: "workspace",
        remember: false
    });

    assert.strictEqual(auth.authorize(makePlan({ sha256: "changed" })).authorized, false);
    assert.strictEqual(auth.status(makePlan({ sha256: "changed" })).trusted, false);
    assert.strictEqual(auth.status().trusted, false, "status without current ELF must not claim trust");
    assert.strictEqual(auth.isTrusted({ elfResult: { elf: {} } }), false);
    await assert.rejects(() => auth.trustWorkspace({}), { code: "WRITE_CONFIRMATION_INVALID" });
    const savedTrust = values.get("agent.writeTrusted");
    assert.strictEqual(savedTrust.elfSha256, plan.elfResult.elf.sha256);
    await storage.update("agent.writeTrusted", now);
    assert.strictEqual(auth.authorize(plan).authorized, false, "legacy timestamp must require confirmation");
    await storage.update("agent.writeTrusted", { ...savedTrust, trustedAt: now + 1 });
    assert.strictEqual(auth.isTrusted(plan), false, "future timestamps must not extend trust");
    await storage.update("agent.writeTrusted", savedTrust);

    // workspace 信任 24 小时后过期，需重新走两阶段确认
    now += 24 * 60 * 60 * 1000 + 1;
    assert.strictEqual(auth.isTrusted(plan), false);
    assert.strictEqual(auth.authorize(plan).authorized, false);

    // 旧版本存储的布尔 true 一律视为未信任，升级后强制重新确认
    await auth.trustWorkspace(plan);
    now -= 24 * 60 * 60 * 1000;
    await storage.update("agent.writeTrusted", true);
    assert.strictEqual(auth.isTrusted(plan), false);
    assert.strictEqual(auth.authorize(plan).authorized, false);

    await auth.reset();
    assert.deepStrictEqual(auth.status(plan), { trusted: false, scope: "workspace" });
    assert.strictEqual(auth.authorize(plan).authorized, false);

    assert.strictEqual(fingerprintWritePlan(plan), fingerprintWritePlan(makePlan()));
    assert.notStrictEqual(fingerprintWritePlan(plan), fingerprintWritePlan(makePlan({ bytes: [1, 2, 3, 4] })));

    const flash = new FlashAuthorization({ createId: () => "flash-confirm", now: () => now });
    const flashPlan = {
        elf: { path: "firmware.elf", sha256: "abc123" },
        target: "stm32f4x.cfg",
        probe: "cmsis-dap.cfg",
        openocd: "/tools/openocd"
    };
    const flashRequest = flash.authorize(flashPlan);
    assert.strictEqual(flashRequest.confirmationRequired, true);
    assert.strictEqual(flashRequest.confirmationId, "flash-confirm");
    assert.strictEqual(flash.authorize(flashPlan, "flash-confirm").authorized, true);
    const changedFlash = flash.authorize(flashPlan).confirmationId;
    assert.throws(
        () => flash.authorize({ ...flashPlan, target: "nrf52.cfg" }, changedFlash),
        (error) => error.code === "FLASH_CONFIRMATION_INVALID"
    );
    console.log("Write authorization tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
