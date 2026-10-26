"use strict";
const { probeFamily } = require("../../skills/_emberprobe/probe-connection");

// The workspace's physical probe: the device a user picked or the last one used successfully. It is kept in
// workspace state (per machine), never in settings, so a USB serial is not committed with .vscode/settings.json.
const SELECTED_PROBE_KEY = "mcu.selectedProbe";
// Older releases and installed skills read only this v1/v2 record; it is kept as a mirror of the selection.
const LEGACY_SUCCESS_KEY = "mcu.successfulProbeConnection";

function normalizeSelection(value) {
    if (!value || typeof value !== "object" || ![1, 2, 3].includes(value.version)) return null;
    if (typeof value.probe !== "string" || !value.probe) return null;
    return {
        version: 3,
        probe: value.probe,
        probeSerial: typeof value.probeSerial === "string" ? value.probeSerial : "",
        // Stored profiles are fingerprints, not profile objects; derive the family from the script name.
        family:
            (value.version === 3 && typeof value.family === "string" && value.family) ||
            probeFamily({ probe: value.probe }),
        deviceId: value.version === 3 && typeof value.deviceId === "string" ? value.deviceId : "",
        ...(typeof value.profile === "string" && value.profile ? { profile: value.profile } : {}),
        source: value.version === 3 && value.source === "user" ? "user" : "success"
    };
}

function legacySelection(selection) {
    return {
        version: 2,
        probe: selection.probe,
        probeSerial: selection.probeSerial,
        ...(selection.profile ? { profile: selection.profile } : {})
    };
}

function sameLegacy(a, b) {
    return (
        a?.version === b.version &&
        a.probe === b.probe &&
        (a.probeSerial || "") === b.probeSerial &&
        (a.profile || "") === (b.profile || "")
    );
}

class ProbeSelectionStore {
    constructor(workspaceState) {
        this.state = workspaceState;
    }

    get() {
        const selection = normalizeSelection(this.state.get(SELECTED_PROBE_KEY));
        const legacy = this.state.get(LEGACY_SUCCESS_KEY);
        // A legacy record that no longer mirrors the selection was written later by an older release.
        if (selection && (legacy === undefined || sameLegacy(legacy, legacySelection(selection)))) return selection;
        return normalizeSelection(legacy);
    }

    /** Legacy v2 view for Bridge snapshots consumed by previously installed skills. */
    legacy() {
        const selection = this.get();
        return selection ? legacySelection(selection) : null;
    }

    async set(value) {
        const selection = normalizeSelection({ ...value, version: 3 });
        if (!selection)
            throw Object.assign(new Error("A probe selection needs its interface configuration"), {
                code: "PROBE_SELECTION_INVALID"
            });
        await this.state.update(SELECTED_PROBE_KEY, selection);
        await this.state.update(LEGACY_SUCCESS_KEY, legacySelection(selection));
        return selection;
    }

    async clear() {
        await this.state.update(SELECTED_PROBE_KEY, undefined);
        await this.state.update(LEGACY_SUCCESS_KEY, undefined);
    }
}

module.exports = { ProbeSelectionStore, normalizeSelection, SELECTED_PROBE_KEY, LEGACY_SUCCESS_KEY };
