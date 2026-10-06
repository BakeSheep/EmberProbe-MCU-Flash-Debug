"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChartInspection = factory();
})(globalThis, function () {
    function lowerBound(arr, value, key = "t") {
        let lo = 0,
            hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid][key] < value) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function visibleSegments(arr, range, width) {
        const start = arr.retainedStart || 0;
        function bound(time, inclusive) {
            let lo = start,
                hi = arr.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (arr[mid].t < time || (inclusive && arr[mid].t === time)) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }
        const from = Math.max(start, bound(range.min, false) - 1),
            to = Math.min(arr.length, bound(range.max, true) + 1),
            scale = width / Math.max(1, range.max - range.min),
            finite = Number.isFinite,
            floor = Math.floor;
        const result = [];
        let points = [],
            count = 0,
            column = null,
            first = 0,
            last = 0,
            min = 0,
            max = 0;
        function compare(a, b) {
            const x = arr[a],
                y = arr[b];
            // Equal approximate Numbers can conceal one-unit changes in u64/i64 samples.
            if (
                x.v === y.v &&
                !Number.isSafeInteger(x.v) &&
                /^-?\d+$/.test(x.valueText) &&
                /^-?\d+$/.test(y.valueText)
            ) {
                const exactX = BigInt(x.valueText),
                    exactY = BigInt(y.valueText);
                return exactX < exactY ? -1 : exactX > exactY ? 1 : 0;
            }
            return x.v - y.v;
        }
        function flushColumn() {
            if (column === null) return;
            let previous = -1;
            for (const index of [first, min, max, last].sort((a, b) => a - b)) {
                if (index !== previous) points.push(arr[index]);
                previous = index;
            }
            column = null;
        }
        function flushSegment() {
            flushColumn();
            if (points.length) result.push({ arr: points, visibleCount: count });
            points = [];
            count = 0;
        }
        // Reduce raw references before allocating canvas geometry. Each pixel keeps first/last
        // and both extrema; failed samples split segments, and CSV retains every original point.
        for (let i = from; i < to; i++) {
            const p = arr[i];
            if (!p || !finite(p.v) || !finite(p.t)) {
                flushSegment();
                continue;
            }
            if (p.t >= range.min && p.t <= range.max) count++;
            const next = floor((p.t - range.min) * scale);
            if (column !== next) {
                flushColumn();
                column = next;
                first = min = max = i;
            } else {
                if (compare(i, min) < 0) min = i;
                if (compare(i, max) > 0) max = i;
            }
            last = i;
        }
        flushSegment();
        return result;
    }
    function nearest(arr, time) {
        if (!arr.length || time < arr[0].t || time > arr[arr.length - 1].t) return null;
        const i = lowerBound(arr, time);
        return i && time - arr[i - 1].t <= arr[i].t - time ? arr[i - 1] : arr[i];
    }
    function read(series, name, time) {
        for (const s of series)
            if (s.item.name === name) {
                const point = nearest(s.arr, time);
                if (point) return point;
            }
        return null;
    }
    function delta(a, b) {
        if (!a || !b) return null;
        const exact = (p) =>
            p.valueText != null && /^-?\d+$/.test(p.valueText)
                ? BigInt(p.valueText)
                : Number.isSafeInteger(p.v)
                  ? BigInt(p.v)
                  : null;
        const x = exact(a),
            y = exact(b);
        return x !== null && y !== null ? String(y - x) : String(b.v - a.v);
    }
    function distance(p, a, b) {
        const dx = b.x - a.x,
            dy = b.y - a.y,
            length = dx * dx + dy * dy;
        const k = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
        return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
    }
    // Retain first/last and both extrema in each pixel column; spikes remain visible.
    function envelope(points) {
        const result = [];
        for (let i = 0; i < points.length;) {
            let end = i + 1,
                min = i,
                max = i;
            while (end < points.length && Math.floor(points[end].x) === Math.floor(points[i].x)) {
                if (points[end].y < points[min].y) min = end;
                if (points[end].y > points[max].y) max = end;
                end++;
            }
            for (const index of [...new Set([i, min, max, end - 1])].sort((a, b) => a - b)) result.push(points[index]);
            i = end;
        }
        return result;
    }
    // Geometry and plot pointer are CSS pixels; include adjacent endpoints for clipped segments.
    function hit(geometry, pointer, radius = 8) {
        if (!pointer) return [];
        const found = new Map();
        for (const s of geometry) {
            const arr = s.points;
            const start = Math.max(0, lowerBound(arr, pointer.x - radius, "x") - 1);
            const end = Math.min(arr.length - 1, lowerBound(arr, pointer.x + radius, "x"));
            let best = Infinity,
                point = null;
            for (let i = start; i <= end; i++) {
                const a = arr[i],
                    b = arr[Math.min(i + 1, arr.length - 1)];
                const d = distance(pointer, a, b);
                if (d < best) {
                    best = d;
                    point = Math.abs(pointer.x - a.x) <= Math.abs(pointer.x - b.x) ? a.raw : b.raw;
                }
            }
            const previous = found.get(s.name);
            if (best <= radius && (!previous || best < previous.distance))
                found.set(s.name, { name: s.name, point, distance: best });
        }
        return [...found.values()].sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
    }
    function adjacent(series, time, direction) {
        let result = direction > 0 ? Infinity : -Infinity;
        for (const s of series) {
            let i = lowerBound(s.arr, time);
            if (direction > 0) {
                while (i < s.arr.length && s.arr[i].t <= time) i++;
                if (i < s.arr.length) result = Math.min(result, s.arr[i].t);
            } else {
                i--;
                if (i >= 0) result = Math.max(result, s.arr[i].t);
            }
        }
        return Number.isFinite(result) ? result : time;
    }
    return { lowerBound, nearest, read, delta, distance, hit, adjacent, envelope, visibleSegments };
});
