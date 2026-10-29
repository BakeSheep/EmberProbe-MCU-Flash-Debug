"use strict";
const { randomUUID } = require("crypto");
const { nextLivePanelId } = require("./liveWatchService");

const BINDINGS_KEY = "liveWatch.panelBindings";
const WATCH_KEY = "mcu.watchList";
const VIEW_STATE_KEYS = ["liveWatch.curveVisibility", "liveWatch.runtimeExpansions"];
function panelNumber(value) {
    if (typeof value !== "number" && !(typeof value === "string" && /^[1-9]\d*$/.test(value))) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
}
function titleNumber(title) {
    return panelNumber(/^(?:Waveform|波形图)\s*#([1-9]\d*)$/.exec(title || "")?.[1]);
}
function watchKeyFor(id) {
    return id === 1 ? WATCH_KEY : `${WATCH_KEY}.${id}`;
}
function validWatchKey(key) {
    if (key === WATCH_KEY) return true;
    if (typeof key !== "string" || !key.startsWith(WATCH_KEY + ".")) return false;
    const suffix = key.slice(WATCH_KEY.length + 1);
    return panelNumber(suffix) !== null || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(suffix);
}

// Display numbers can change; a watch key always identifies the same chart's persisted settings.
// The bindings also reserve keys owned by hidden tabs whose serializers have not run yet.
class LivePanelRegistry {
    constructor(state, entries, tabs) {
        this.state = state;
        this.entries = entries;
        this.tabs = tabs;
        this.pending = Promise.resolve();
        const saved = state.get(BINDINGS_KEY);
        this.bindings = new Map(
            Object.entries(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {})
                .filter(([id, key]) => panelNumber(id) !== null && validWatchKey(key))
                .map(([id, key]) => [Number(id), key])
        );
    }
    _tabIds() {
        const ids = new Set();
        for (const tab of this.tabs()) {
            const type = tab.input?.viewType;
            if (type !== "emberprobe.liveWatch" && type !== "mainThreadWebview-emberprobe.liveWatch") continue;
            const id = titleNumber(tab.label);
            if (id !== null) ids.add(id);
        }
        return ids;
    }
    claim(restored = null) {
        const tabIds = this._tabIds();
        const usedIds = new Set([...tabIds, ...this.entries.keys()]);
        const tabId = restored ? titleNumber(restored.title) : null;
        const originalId = restored ? panelNumber(restored.state?.panelId) || tabId : null;
        const requestedId = tabId || originalId;
        const panelId = requestedId && !this.entries.has(requestedId) ? requestedId : nextLivePanelId([...usedIds]);
        const sourceKey = restored
            ? validWatchKey(restored.state?.watchKey)
                ? restored.state.watchKey
                : originalId
                  ? this.bindings.get(originalId) || watchKeyFor(originalId)
                  : null
            : null;
        const usedKeys = new Set([...this.entries.values()].map((entry) => entry.watchKey));
        for (const id of tabIds) {
            if (restored && id === requestedId) continue;
            usedKeys.add(this.bindings.get(id) || watchKeyFor(id));
        }
        let watchKey = sourceKey || watchKeyFor(panelId);
        const copyFrom = sourceKey && usedKeys.has(sourceKey) ? sourceKey : null;
        // An unidentifiable legacy tab must never silently adopt another chart's old variables.
        if (usedKeys.has(watchKey) || (restored && !sourceKey)) watchKey = `${WATCH_KEY}.${randomUUID()}`;
        this.bindings.set(panelId, watchKey);
        usedIds.add(panelId);
        return { panelId, watchKey, initialized: this._persist(usedIds, copyFrom, watchKey) };
    }
    release(panelId) {
        this.bindings.delete(panelId);
        const ids = new Set([...this._tabIds(), ...this.entries.keys()]);
        ids.delete(panelId);
        return this._persist(ids);
    }
    _persist(ids, copyFrom = null, watchKey = null) {
        // The initial tab inventory may still be arriving during extension activation. Keep known
        // bindings until an explicit release so an early serializer cannot forget a hidden chart.
        const bindings = Object.fromEntries(this.bindings);
        for (const id of ids) bindings[id] = this.entries.get(id)?.watchKey || this.bindings.get(id) || watchKeyFor(id);
        // A duplicate can itself be duplicated before initialization; wait for its copy to finish.
        this.pending = this.pending
            .catch(() => {})
            .then(async () => {
                if (copyFrom) {
                    const watches = structuredClone(this.state.get(copyFrom) || []);
                    const viewState = VIEW_STATE_KEYS.map((key) => [
                        key,
                        structuredClone(this.state.get(key)?.[copyFrom])
                    ]);
                    await this.state.update(watchKey, watches);
                    for (const [key, value] of viewState) {
                        if (value === undefined) continue;
                        await this.state.update(key, { ...this.state.get(key), [watchKey]: value });
                    }
                }
                await this.state.update(BINDINGS_KEY, bindings);
            });
        return this.pending;
    }
}
module.exports = { LivePanelRegistry };
