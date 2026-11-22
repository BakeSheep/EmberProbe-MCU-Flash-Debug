"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChartHistoryViewport = factory();
})(globalThis, function () {
    const FOLLOW_REQUEST_INTERVAL_MS = 40;
    const REQUEST_INTERVAL_MS = 80;
    const OVERVIEW_INTERVAL_MS = 1000;
    const OVERVIEW_RETRY_MS = 5000;

    function create({
        state,
        configFor,
        following,
        validBounds,
        clearPending,
        historyRevision,
        now,
        post,
        isComposite,
        lowerBound
    }) {
        const history = state.remoteHistory;

        function request(range, width, config = configFor()) {
            history.refreshAt = Infinity;
            if (clearPending()) return;
            if (!config.names.length) {
                history.view = history.overview = null;
                history.pending = history.target = null;
                history.overviewDueAt = null;
                return;
            }
            const status = state.frozen ? history.status : history.liveStatus;
            if (!range || !status || !history.status) return;
            const at = now(),
                bounds = status.bounds,
                span = Math.max(1, range.max - range.min),
                columns = Math.min(8192, Math.max(1, Math.round(width))),
                follow = following(),
                overscan = follow ? Math.min(span, 5000) : span,
                fetchRange = { min: range.min - (follow ? 0 : overscan), max: range.max + overscan },
                visibleRange = { ...range };
            if (validBounds(bounds)) {
                visibleRange.min = Math.max(bounds.min, range.min);
                visibleRange.max = Math.min(bounds.max, range.max);
                if (!follow) {
                    fetchRange.min = Math.max(bounds.min, fetchRange.min);
                    fetchRange.max = Math.min(bounds.max, fetchRange.max);
                }
            }
            // Near an edge, the full overscan may already fit the column budget.
            const excess = fetchRange.max - fetchRange.min - (span * 8192) / columns;
            if (excess > 0) {
                let trimLeft = Math.min(Math.max(0, range.min - fetchRange.min), excess / 2);
                const trimRight = Math.min(Math.max(0, fetchRange.max - range.max), excess - trimLeft);
                trimLeft += excess - trimLeft - trimRight;
                fetchRange.min += trimLeft;
                fetchRange.max -= trimRight;
            }
            const target = {
                configKey: config.configKey,
                range: fetchRange,
                width: Math.min(8192, Math.max(1, Math.round((columns * (fetchRange.max - fetchRange.min)) / span))),
                names: config.names,
                revision: status.revision,
                snapshotId: history.snapshotId,
                overviewRange: validBounds(bounds) ? { ...bounds } : null,
                overviewWidth: Math.min(4096, Math.max(64, Math.round(width)))
            };
            target.key = JSON.stringify([target.configKey, target.revision, target.range, target.width]);
            if (history.target && history.target.configKey !== target.configKey) history.overviewDueAt = null;
            history.target = target;
            const view = history.view,
                msPerColumn = view ? Math.max(1, view.range.max - view.range.min) / view.width : Infinity,
                desiredResolution = span / columns,
                interval = follow ? Math.max(FOLLOW_REQUEST_INTERVAL_MS, span / Math.max(1, width)) : 1000,
                epsilon = Math.max(0.001, span * 1e-9),
                staleDetail = !state.frozen && view && status.revision !== view.revision,
                detailAt = staleDetail ? view.receivedAt + interval : Infinity,
                needsDetail =
                    !view ||
                    view.configKey !== target.configKey ||
                    visibleRange.min < view.range.min - epsilon ||
                    visibleRange.max > view.range.max + epsilon ||
                    msPerColumn > desiredResolution * 1.5 ||
                    msPerColumn < desiredResolution / 3 ||
                    detailAt <= at;
            const { inFlight, failed } = history;
            history.pending =
                needsDetail &&
                !(inFlight?.purpose === "detail" && inFlight.key === target.key) &&
                !(failed?.purpose === "detail" && failed.key === target.key)
                    ? { ...target, purpose: "detail" }
                    : null;
            if (!needsDetail) history.refreshAt = detailAt;

            const overview = history.overview,
                overviewInFlight = inFlight?.purpose === "overview" && inFlight.configKey === target.configKey,
                missingOverview = !overview || overview.configKey !== target.configKey,
                staleOverview = !state.frozen && overview && overview.revision !== status.revision;
            if (target.overviewRange && !overviewInFlight && (missingOverview || staleOverview)) {
                const retryAt =
                    failed?.purpose === "overview" && failed.configKey === target.configKey
                        ? failed.at + OVERVIEW_RETRY_MS
                        : -Infinity;
                const overviewAt = Math.max(
                    retryAt,
                    missingOverview ? at : history.lastOverviewRequest + OVERVIEW_INTERVAL_MS
                );
                if (overviewAt <= at) history.overviewDueAt ??= overviewAt;
                else {
                    history.overviewDueAt = null;
                    history.refreshAt = Math.min(history.refreshAt, overviewAt);
                }
            } else history.overviewDueAt = null;
            dispatch();
        }

        function dispatch() {
            if (clearPending() || history.inFlight || !history.target) return;
            const overviewDue = history.overviewDueAt !== null;
            if (!history.pending && !overviewDue) return;
            const at = now();
            const follow = following();
            const cooldown = follow ? FOLLOW_REQUEST_INTERVAL_MS : REQUEST_INTERVAL_MS;
            const useOverview = overviewDue && (!history.pending || at - history.overviewDueAt > OVERVIEW_INTERVAL_MS);
            const lastAt =
                !follow || useOverview || history.lastRequest === -Infinity
                    ? history.lastRequest
                    : (history.lastDetailRequest ?? -Infinity);
            if (at - lastAt < cooldown) return;
            let next;
            if (useOverview) {
                next = {
                    ...history.target,
                    purpose: "overview",
                    range: history.target.overviewRange,
                    width: history.target.overviewWidth
                };
                history.lastOverviewRequest = at;
                history.overviewDueAt = null;
            } else {
                next = history.pending;
                history.pending = null;
            }
            next.requestId = ++history.nextId;
            history.inFlight = next;
            history.lastRequest = at;
            if (next.purpose === "detail") history.lastDetailRequest = at;
            post({
                type: "chartViewport",
                names: next.names,
                range: next.range,
                width: next.width,
                snapshotId: next.snapshotId,
                requestId: next.requestId,
                historyRevision: historyRevision()
            });
        }

        function covers(range, configKey = configFor().configKey) {
            const view = history.view;
            return !!(
                following() &&
                view &&
                view.configKey === configKey &&
                range &&
                range.min >= view.range.min &&
                range.max <= view.range.max
            );
        }

        // Keep the neighbour inside each cut so coarse and detailed lines meet without bridging gaps.
        // The coarse underlay is drawn only outside the detail curve. A segment that continues across a cut joins the
        // detail curve's own end point, so no coarse point lands inside the detail range (where it would shift on every
        // commit and make the curve's visible end jump); a segment ending before the cut keeps its gap.
        function overviewOutside(arr, range, first, last) {
            if (!arr.length) return [];
            const parts = [],
                leftCut = first ? first.t : range.min,
                rightCut = last ? last.t : range.max;
            if (arr[0].t < leftCut) {
                const left = lowerBound(arr, leftCut),
                    before = arr.slice(0, left);
                if (left < arr.length && first) before.push(first);
                parts.push(before);
            }
            if (arr[arr.length - 1].t > rightCut) {
                let right = lowerBound(arr, rightCut);
                while (right < arr.length && arr[right].t === rightCut) right++;
                const after = arr.slice(right);
                if (right > 0 && last) after.unshift(last);
                parts.push(after);
            }
            return parts;
        }

        function compose(range, width, config = configFor()) {
            request(range, width, config);
            // Views from an earlier configuration (visibility, freeze/resume) stay drawn until their replacement
            // arrives, but only for curves whose type/address identity is unchanged.
            const { configKey } = config,
                view = history.view,
                overview = history.overview,
                cached = history.composed,
                useOverview = !covers(range, configKey) && !!overview;
            if (
                cached &&
                cached.view === view &&
                cached.configKey === configKey &&
                cached.hasOverview === useOverview &&
                (!useOverview || cached.overview === overview)
            )
                return cached.series;
            const composed = [];
            const identity = (item) => JSON.stringify([item.type, item.address, item.bitOffset, item.bitSize]);
            const add = (part, arr, detail, current) => {
                const idx = state.watch.findIndex((item) => item.name === part.name);
                if (idx < 0 || state.hidden[part.name] || isComposite(state.watch[idx]) || !arr.length) return;
                if (!current && (!part.item || identity(part.item) !== identity(state.watch[idx]))) return;
                composed.push({
                    item: part.item || state.watch[idx],
                    idx,
                    arr,
                    ...(detail ? { visibleCount: part.visibleCount } : {})
                });
            };
            if (view) view.series.forEach((part) => add(part, part.arr, true, view.configKey === configKey));
            const ends = new Map();
            if (view && useOverview)
                view.series.forEach((part) => {
                    if (!part.arr.length) return;
                    const end = ends.get(part.name);
                    if (!end) ends.set(part.name, { first: part.arr[0], last: part.arr[part.arr.length - 1] });
                    else end.last = part.arr[part.arr.length - 1];
                });
            if (useOverview)
                overview.series.forEach((part) => {
                    const end = ends.get(part.name),
                        segments = view
                            ? overviewOutside(part.arr, view.range, end && end.first, end && end.last)
                            : [part.arr];
                    segments.forEach((arr) => add(part, arr, false, overview.configKey === configKey));
                });
            history.composed = { view, overview, hasOverview: useOverview, configKey, series: composed };
            return composed;
        }

        return { request, dispatch, covers, compose };
    }

    return { create };
});
