"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeAnalysisState = factory();
})(globalThis, function () {
    function create() {
        return { previousHidden: null, focused: null };
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
    return { create, focus, restore };
});
