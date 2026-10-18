"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { minimalElf } = require("./helpers/elf-fixture");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { FlashService } = require("../src/services/flashService");
const { FirmwareRecord } = require("../src/services/firmwareRecord");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { FlashAuthorization, DEFAULT_TRUST_TTL_MS } = require("../src/flashAuthorization");
const { WriteAuthorization } = require("../src/writeAuthorization");

function memoryStorage() {
    const values = new Map();
    return {
        values,
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }
    };
}

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

(async () => {
    // Authorization: workspace trust is bound to the ELF path and connection, not the digest.
    let now = 1_000_000;
    const storage = memoryStorage();
    const auth = new FlashAuthorization({ storage, now: () => now });
    const plan = {
        operation: "flash.execute",
        elf: { path: "/ws/build/app.elf", sha256: sha("v1") },
        target: "target/stm32h7x.cfg",
        probe: "interface/cmsis-dap.cfg",
        openocd: "/usr/bin/openocd",
        probeSerial: "ABC123",
        transport: "swd"
    };
    const request = auth.authorize(plan);
    assert.strictEqual(request.authorized, false);
    assert.deepStrictEqual(request.choices, ["once", "workspace", "deny"]);
    assert.throws(() => auth.authorize(plan, "", { remember: true }), { code: "FLASH_CONFIRMATION_INVALID" });
    const granted = auth.authorize(plan, request.confirmationId, { remember: true });
    assert.strictEqual(granted.mode, "workspace");
    assert.strictEqual(auth.isTrusted(plan), false, "trust is stored only after a successful program");
    await auth.remember(plan);
    const rebuilt = { ...plan, elf: { ...plan.elf, sha256: sha("v2") } };
    const trusted = auth.authorize(rebuilt);
    assert.strictEqual(trusted.authorized, true);
    assert.strictEqual(trusted.mode, "workspace");
    assert.strictEqual(trusted.elf.sha256, sha("v2"), "the actual digest is still reported");
    assert.strictEqual(auth.pending.size, 0, "a trusted plan issues no confirmation");
    for (const changed of [
        { elf: { path: "/ws/build/other.elf", sha256: sha("v1") } },
        { target: "target/stm32f4x.cfg" },
        { probe: "interface/stlink.cfg" },
        { probeSerial: "XYZ789" },
        { openocd: "/opt/openocd" },
        { transport: "jtag" },
        { adapterSpeedKhz: 1000 },
        { operation: "flash.verify" }
    ])
        assert.strictEqual(auth.isTrusted({ ...plan, ...changed }), false, JSON.stringify(changed));
    assert.strictEqual(auth.authorize({ ...plan, operation: "flash.verify" }).choices.join(), "once,deny");
    assert.strictEqual(auth.status().saved, true);
    now += DEFAULT_TRUST_TTL_MS;
    assert.strictEqual(auth.isTrusted(plan), false, "trust expires after 24 hours");
    assert.strictEqual(auth.status().expired, true);
    now -= 1;
    assert.strictEqual(auth.isTrusted(plan), true);
    await auth.reset();
    assert.strictEqual(auth.isTrusted(plan), false);
    assert.strictEqual(auth.status().saved, false);

    // Anonymous probes and storage-less instances keep one-time confirmation only.
    const anonymous = {
        ...plan,
        probeSerial: "",
        selectionIdentity: { kind: "usb", anonymous: true, attachmentId: "usb-1" }
    };
    const anonymousRequest = auth.authorize(anonymous);
    assert.deepStrictEqual(anonymousRequest.choices, ["once", "deny"]);
    assert.throws(() => auth.authorize(anonymous, anonymousRequest.confirmationId, { remember: true }), {
        code: "FLASH_CONFIRMATION_INVALID"
    });
    await assert.rejects(auth.remember(anonymous), { code: "FLASH_CONFIRMATION_INVALID" });
    assert.deepStrictEqual(new FlashAuthorization().authorize(plan).choices, ["once", "deny"]);

    // Service: ID-less execution requires remembered trust and records the programmed image.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-flash-permission-"));
    try {
        const file = path.join(root, "firmware.elf");
        const data = minimalElf();
        const digest = sha(data);
        await fs.writeFile(file, data);
        const serviceStorage = memoryStorage();
        const authorization = new FlashAuthorization({ storage: serviceStorage });
        const record = new FirmwareRecord(serviceStorage);
        let runs = 0;
        const service = new AgentFlashService({
            getConfig: () => ({ openocdPath: process.execPath }),
            coordinator: new ProbeCoordinator(),
            authorization,
            isDebugActive: () => false,
            resolveLaunch: (value) => ({ executable: value }),
            check: async () => ({ compatible: true, version: "test" }),
            prepare: async (request) => ({ ...request, probeSerial: "ABC123" }),
            recordFlashed: (entry) => record.record(entry),
            run: async () => {
                runs++;
                return { exitCode: 0, openocdTail: [], commands: [] };
            }
        });
        const params = {
            elf: file,
            elfSha256: digest,
            probe: "p.cfg",
            target: "t.cfg",
            openocd: process.execPath
        };
        await assert.rejects(service.execute(params), { code: "FLASH_CONFIRMATION_REQUIRED" });
        assert.strictEqual(authorization.pending.size, 0, "execution never issues a confirmation");
        await assert.rejects(service.execute({ ...params, remember: true }), /Flash confirmation is required/);
        assert.strictEqual(record.check({ sha256: digest }).status, "unknown");

        const first = await service.authorize(params);
        assert.deepStrictEqual(first.choices, ["once", "workspace", "deny"]);
        const once = await service.execute({ ...params, confirmationId: first.confirmationId });
        assert.strictEqual(once.verified, true);
        assert.strictEqual(once.permission.mode, "once");
        assert.strictEqual(once.permission.trusted, false);
        assert.strictEqual(record.check({ sha256: digest }).status, "match");

        const second = await service.authorize(params);
        const remembered = await service.execute({ ...params, confirmationId: second.confirmationId, remember: true });
        assert.strictEqual(remembered.permission.mode, "workspace");
        assert.strictEqual(remembered.permission.trusted, true);
        const preflight = await service.authorize(params);
        assert.strictEqual(preflight.authorized, true);
        assert.strictEqual(preflight.mode, "workspace");
        const silent = await service.execute(params);
        assert.strictEqual(silent.verified, true);
        assert.strictEqual(silent.elfSha256, digest);
        assert.strictEqual(runs, 3);

        // Verification never uses or creates workspace trust.
        await assert.rejects(service.execute(params, true), /verification confirmation is required/);
        await assert.rejects(service.execute({ ...params, remember: true }, true), /verification confirmation/);
        const verifyPlan = await service.authorize({ ...params, operation: "flash.verify" });
        assert.deepStrictEqual(verifyPlan.choices, ["once", "deny"]);

        assert.strictEqual((await service.permission({ action: "status" })).saved, true);
        assert.strictEqual((await service.permission({ action: "reset" })).saved, false);
        await assert.rejects(service.execute(params), { code: "FLASH_CONFIRMATION_REQUIRED" });
        await assert.rejects(service.permission({ action: "grant" }), { code: "INVALID_PERMISSION_ACTION" });

        // A rebuilt ELF at the same path is reported as different from the programmed image.
        await fs.writeFile(file, Buffer.concat([data, Buffer.from([0])]));
        const consistency = record.check({ sha256: sha(await fs.readFile(file)) });
        assert.strictEqual(consistency.status, "mismatch");
        assert.strictEqual(consistency.flashedSha256, digest);
        assert.strictEqual(record.warning({ sha256: consistency.elfSha256 }).code, "ELF_TARGET_MISMATCH");
        assert.strictEqual(record.warning({ sha256: digest }), null);
        assert.strictEqual(new FirmwareRecord(null).check({ sha256: digest }).status, "unknown");

        // Sidebar downloads report the programmed image; a failing record does not fail them.
        const downloads = [];
        const flash = new FlashService({ runOpenOcd: async () => ({ ok: true }) });
        const downloadOptions = { elf: file, probe: "p.cfg", target: "t.cfg", probeSerial: "ABC123" };
        assert.deepStrictEqual(
            await flash.download(null, { ...downloadOptions, onDownloaded: (image) => downloads.push(image) }),
            { ok: true }
        );
        assert.strictEqual(downloads[0].sha256, sha(await fs.readFile(file)));
        assert.deepStrictEqual(
            await flash.download(null, {
                ...downloadOptions,
                onDownloaded: async () => {
                    throw new Error("storage failed");
                }
            }),
            { ok: true }
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

    // A remembered variable-write permission can be suppressed for a mismatched firmware.
    const writeStorage = memoryStorage();
    const writes = new WriteAuthorization(writeStorage);
    const writePlan = {
        elfResult: { elf: { path: "/ws/app.elf", sha256: sha("v1") } },
        connection: { probe: "p.cfg", target: "t.cfg", probeSerial: "ABC123" },
        items: [{ name: "x", address: 0x20000000, type: "u32", bytes: [1, 0, 0, 0] }]
    };
    await writes.trustWorkspace(writePlan);
    assert.strictEqual(writes.authorize(writePlan).authorized, true);
    const suppressed = writes.authorize(writePlan, { allowTrusted: false });
    assert.strictEqual(suppressed.authorized, false);
    assert.strictEqual(suppressed.response.confirmationRequired, true);

    console.log("Flash workspace permission and firmware consistency tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
