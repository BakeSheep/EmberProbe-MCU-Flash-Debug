(function (root) {
    "use strict";

    function create(maxBytes = 16 * 1024 * 1024) {
        const scopes = new Map();
        let used = 0;
        let limitReached = false;
        function rows(scope) {
            return scopes.get(scope)?.rows ?? [];
        }
        function append(scope, t, samples) {
            if (!samples.length) return 0;
            if (limitReached) return false;
            const row = { t, samples };
            const size = JSON.stringify(row).length * 2;
            if (used + size > maxBytes) {
                limitReached = true;
                return false;
            }
            let history = scopes.get(scope);
            if (!history) {
                history = { rows: [], bytes: 0, variables: new Set() };
                scopes.set(scope, history);
            }
            history.rows.push(row);
            history.bytes += size;
            for (const sample of samples) history.variables.add(sample.name);
            used += size;
            return size;
        }
        function clear(scope) {
            const bytes = scopes.get(scope)?.bytes || 0;
            used -= bytes;
            scopes.delete(scope);
            if (bytes) limitReached = false;
        }
        function status(scope) {
            const history = rows(scope);
            return {
                rows: history.length,
                bytes: scopes.get(scope)?.bytes || 0,
                variables: Array.from(scopes.get(scope)?.variables ?? []),
                firstTimestampMs: history[0]?.t ?? null,
                lastTimestampMs: history.at(-1)?.t ?? null,
                limitReached
            };
        }
        function budget(bytesPerSecond) {
            return {
                used,
                maxBytes,
                remainingSeconds: limitReached ? 0 : bytesPerSecond > 0 ? (maxBytes - used) / bytesPerSecond : null
            };
        }
        return { rows, append, clear, status, budget, limited: () => limitReached };
    }

    root.EmberProbeMockArchive = { create };
})(typeof window === "undefined" ? globalThis : window);
