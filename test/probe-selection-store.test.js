"use strict";
const assert = require("assert");
const {
    ProbeSelectionStore,
    normalizeSelection,
    SELECTED_PROBE_KEY,
    LEGACY_SUCCESS_KEY
} = require("../src/services/probeSelectionStore");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const { loadProvider } = require("./helpers/load-provider");

function workspaceState(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get: (key) => values.get(key),
        update: async (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }
    };
}

async function main() {
    // Legacy v1/v2 success records are read as v3 selections; unrelated or malformed values are ignored.
    assert.deepStrictEqual(
        normalizeSelection({
            version: 1,
            probe: "jlink.cfg",
            probeSerial: "1234",
            deviceId: "stale-v1-id",
            target: "stm32f1x.cfg",
            transport: "jtag"
        }),
        { version: 3, probe: "jlink.cfg", probeSerial: "1234", family: "jlink", deviceId: "", source: "success" }
    );
    assert.deepStrictEqual(normalizeSelection({ version: 2, probe: "custom.cfg", profile: "fp" }), {
        version: 3,
        probe: "custom.cfg",
        probeSerial: "",
        family: "",
        deviceId: "",
        profile: "fp",
        source: "success"
    });
    for (const invalid of [null, "jlink.cfg", { version: 4, probe: "jlink.cfg" }, { version: 3, probe: "" }])
        assert.strictEqual(normalizeSelection(invalid), null);
    assert.strictEqual(
        normalizeSelection({ version: 3, probe: "jlink.cfg", source: "agent" }).source,
        "success",
        "only an explicit user pick is marked as user-selected"
    );

    const state = workspaceState({ [LEGACY_SUCCESS_KEY]: { version: 2, probe: "stlink.cfg", probeSerial: "ST01" } });
    const store = new ProbeSelectionStore(state);
    assert.strictEqual(store.get().probeSerial, "ST01", "an existing workspace keeps its remembered probe");
    assert.deepStrictEqual(store.legacy(), { version: 2, probe: "stlink.cfg", probeSerial: "ST01" });

    const written = await store.set({
        probe: "jlink.cfg",
        probeSerial: "5678",
        family: "jlink",
        deviceId: "USB\\VID_1366&PID_0101\\000000005678",
        source: "user"
    });
    assert.deepStrictEqual(state.values.get(SELECTED_PROBE_KEY), written);
    assert.deepStrictEqual(
        state.values.get(LEGACY_SUCCESS_KEY),
        { version: 2, probe: "jlink.cfg", probeSerial: "5678" },
        "older releases and installed skills keep reading a mirror of the selection"
    );
    assert.strictEqual(store.get().source, "user");
    assert.strictEqual(store.get().deviceId, "USB\\VID_1366&PID_0101\\000000005678");
    // The resolver treats the v3 selection exactly like the remembered success record it replaces.
    const inventory = {
        available: true,
        devices: [
            { id: "a", family: "jlink", serial: "1234" },
            { id: "b", family: "jlink", serial: "5678" }
        ]
    };
    const resolved = resolveProbeConnection({ probe: "jlink.cfg", successfulConnection: store.get() }, inventory);
    assert.deepStrictEqual([resolved.deviceId, resolved.selection.probe], ["b", "remembered"]);

    // An older release that recorded another probe afterwards wins over the stale v3 selection.
    await state.update(LEGACY_SUCCESS_KEY, { version: 2, probe: "jlink.cfg", probeSerial: "1234" });
    assert.deepStrictEqual(
        [store.get().probeSerial, store.get().source, store.get().deviceId],
        ["1234", "success", ""]
    );
    await store.set({ probe: "jlink.cfg", probeSerial: "1234", source: "success" });
    assert.strictEqual(store.get().family, "jlink", "a missing family is derived from the interface script");
    await assert.rejects(store.set({ probeSerial: "1234" }), { code: "PROBE_SELECTION_INVALID" });

    await store.clear();
    assert.strictEqual(store.get(), null);
    assert.strictEqual(store.legacy(), null);
    assert(!state.values.has(SELECTED_PROBE_KEY) && !state.values.has(LEGACY_SUCCESS_KEY));

    // Bridge configuration snapshots expose the v3 selection and the legacy mirror for installed skills.
    const Provider = loadProvider({});
    const provider = Object.create(Provider.prototype);
    const providerState = workspaceState();
    provider._context = { workspaceState: providerState };
    provider._configurationStore = { snapshot: () => ({ debugger: "jlink.cfg", probeSerial: "" }) };
    provider._svdManager = { peekBound: async () => null };
    let snapshot = await provider._configurationSnapshot();
    assert(!("selectedProbe" in snapshot) && !("successfulConnection" in snapshot));
    await provider._probeSelectionStore().set({ probe: "jlink.cfg", probeSerial: "5678", deviceId: "b" });
    snapshot = await provider._configurationSnapshot();
    assert.strictEqual(snapshot.selectedProbe.deviceId, "b");
    assert.deepStrictEqual(snapshot.successfulConnection, { version: 2, probe: "jlink.cfg", probeSerial: "5678" });
    const replaced = workspaceState();
    provider._context = { workspaceState: replaced };
    assert.strictEqual(provider._probeSelectionStore().get(), null, "a new workspace state gets its own store");

    console.log("Probe selection store, legacy mirror and Bridge snapshot tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
