"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { scenario } = require("./helpers/scenario");
const { loadProvider } = require("./helpers/load-provider");
const { FirmwareRecord, DEFAULT_STORAGE_KEY } = require("../src/services/firmwareRecord");

function storage() {
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

function elfBytes(extra = 0) {
    const bytes = Buffer.alloc(64 + extra);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
    return bytes;
}

const connection = { probe: "stlink", target: "stm32f4x", probeSerial: "1234", port: 6666 };

(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-debug-firmware-")));
    const elf = path.join(root, "app.elf");
    fs.writeFileSync(elf, elfBytes());
    const sha256 = crypto.createHash("sha256").update(elfBytes()).digest("hex");
    const stamp = () => {
        const { size, mtimeMs } = fs.statSync(elf);
        return { size, mtimeMs };
    };
    const stale = { elfPath: "old.elf", sha256: "a".repeat(64), flashedAt: "2026-01-01T00:00:00.000Z" };
    try {
        await scenario("Record the executable a debug launch programmed or confirmed", async () => {
            for (const firmware of ["programmed", "unchanged"]) {
                const store = storage();
                store.values.set(DEFAULT_STORAGE_KEY, stale);
                const record = new FirmwareRecord(store, { now: () => Date.parse("2026-10-24T00:00:00Z") });
                await record.recordDebugLaunch(elf, { image: "executable", firmware, ...stamp() }, connection);
                assert.deepStrictEqual(store.values.get(DEFAULT_STORAGE_KEY), {
                    elfPath: record.saved().elfPath,
                    sha256,
                    target: "stm32f4x",
                    probe: "stlink",
                    probeSerial: "1234",
                    flashedAt: "2026-10-24T00:00:00.000Z"
                });
                assert.strictEqual(record.check({ sha256 }).status, "match");
            }
        });

        await scenario("Forget the record when the launch image cannot be identified", async () => {
            const cases = [
                ["custom load images", elf, { image: "custom", firmware: "programmed" }],
                ["no stamp: the ELF changed during the download", elf, { image: "executable", firmware: "programmed" }],
                [
                    "rebuilt after the download",
                    elf,
                    { image: "executable", firmware: "programmed", ...stamp(), size: 1 }
                ],
                [
                    "unreadable executable",
                    path.join(root, "missing.elf"),
                    { image: "executable", firmware: "unchanged", size: 64, mtimeMs: 1 }
                ],
                ["no executable", "", { image: "executable", firmware: "programmed", ...stamp() }]
            ];
            for (const [name, executable, loaded] of cases) {
                const store = storage();
                store.values.set(DEFAULT_STORAGE_KEY, stale);
                const record = new FirmwareRecord(store);
                await record.recordDebugLaunch(executable, loaded, connection);
                assert.strictEqual(store.values.has(DEFAULT_STORAGE_KEY), false, name);
                assert.strictEqual(record.check({ sha256: stale.sha256 }).status, "unknown", name);
            }
        });

        await scenario("Leave the record alone when nothing was programmed", async () => {
            for (const loaded of [{}, { image: "executable", firmware: "none" }, { firmware: "bogus" }]) {
                const store = storage();
                store.values.set(DEFAULT_STORAGE_KEY, stale);
                await new FirmwareRecord(store).recordDebugLaunch(elf, loaded, connection);
                assert.deepStrictEqual(store.values.get(DEFAULT_STORAGE_KEY), stale);
            }
            const empty = storage();
            await new FirmwareRecord(empty).forget();
            assert.strictEqual(empty.values.size, 0);
        });

        await scenario("Forward only managed sessions' firmware events to the record", async () => {
            const Provider = loadProvider({ debug: {}, workspace: {} });
            const provider = Object.create(Provider.prototype);
            const calls = [];
            const managed = { id: "managed", configuration: { cwd: root, executable: "app.elf" } };
            Object.assign(provider, {
                _externalDebug: { message: async () => {}, matches: (session) => session.id === "external" },
                _managedDebugGroup: null,
                _managedDebugToken: "token",
                _matchesManagedDebugSession: (session) => ["managed", "external"].includes(session.id),
                _managedDebugServer: { options: connection },
                _firmwareRecord: {
                    recordDebugLaunch: async (...args) => {
                        calls.push(args);
                    }
                },
                _debugBridge: { handleMessage() {} },
                _markDebugStartupReady() {}
            });
            const body = { image: "executable", firmware: "programmed", ...stamp() };
            const event = { type: "event", event: "emberprobe.firmwareLoaded", body };
            provider.handleDebugAdapterMessage(managed, event);
            provider.handleDebugAdapterMessage({ id: "foreign", configuration: managed.configuration }, event);
            provider.handleDebugAdapterMessage({ id: "external", configuration: managed.configuration }, event);
            provider.handleDebugAdapterMessage(managed, { type: "event", event: "output", body });
            await Promise.resolve();
            assert.deepStrictEqual(calls, [[elf, body, connection]]);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("Debug firmware record tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
