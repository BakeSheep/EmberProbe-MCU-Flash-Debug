"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeAnalysisState = factory();
})(globalThis, function () {
    function create() {
        return { snapshot: null, previousHidden: null, focused: null };
    }
    function freeze(state, data, limit) {
        if (state.snapshot) return;
        state.snapshot = Object.create(null);
        for (const [name, points] of Object.entries(data))
            state.snapshot[name] = points.slice(-limit).map((p) => ({ ...p }));
    }
    function resume(state) {
        state.snapshot = null;
    }
    function focus(state, hidden, names, name) {
        if (!state.previousHidden) state.previousHidden = { ...hidden };
        state.focused = name;
        return Object.fromEntries(names.map((n) => [n, n !== name]));
    }
    function restore(state, names) {
        const result = Object.fromEntries(names.map((n) => [n, !!state.previousHidden?.[n]]));
        state.previousHidden = null;
        state.focused = null;
        return result;
    }
    function remove(state, names) {
        for (const name of names) {
            if (state.snapshot) delete state.snapshot[name];
        }
    }
    return { create, freeze, resume, focus, restore, remove };
});
