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
    function lowerNumber(arr, value, indices, inclusive = false) {
        let lo = 0,
            hi = indices ? indices.length : arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const current = arr[indices ? indices[mid] : mid];
            if (current < value || (inclusive && current === value)) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function pointAt(series, index) {
        return {
            x: series.xs[index] + series.dx,
            y: series.ys[index] + series.dy,
            raw: series.raw[index]
        };
    }
    // Every chart reduction bins samples into the power-of-two time columns nearest span / width, anchored to absolute
    // time: a scrolling or growing ("All") viewport keeps its reduced samples, finer layers nest inside the chart's
    // own columns, and t / bin stays exact for epoch timestamps. Bins change only when the span crosses a power of two.
    function columnBin(span, width) {
        return Math.pow(2, Math.round(Math.log2(span / width)));
    }
    // Column coordinates are relative to the build origin, so translation never changes membership.
    function envelopeIndices(xs, ys, raw) {
        const indices = [];
        for (let i = 0; i < xs.length;) {
            if (raw[i].v === null) {
                indices.push(i++);
                continue;
            }
            let end = i + 1,
                min = i,
                max = i;
            while (end < xs.length && raw[end].v !== null && Math.floor(xs[end]) === Math.floor(xs[i])) {
                if (ys[end] < ys[min]) min = end;
                if (ys[end] > ys[max]) max = end;
                end++;
            }
            // Emit the four candidates in sample order without a Set or per-column sort.
            const a = Math.min(min, max),
                b = Math.max(min, max);
            indices.push(i);
            if (a !== i) indices.push(a);
            if (b !== a && b !== i) indices.push(b);
            if (end - 1 !== b && end - 1 !== i) indices.push(end - 1);
            i = end;
        }
        return Uint32Array.from(indices);
    }
    // Runs of pixel columns whose samples reverse direction become a min/max band; the curve crosses each
    // banded column once on a smoothed midpoint, so dashes follow the trend instead of the noise. Isolated
    // spikes and monotonic steep edges keep their exact envelope. Gaps are NaN rows in the line. `grid` may supply
    // each sample's column index and the column width in pixels instead of one column per Math.floor(xs).
    function jitterBands(xs, ys, raw, minRun = 3, trendRadius = 3, grid = null) {
        const columnOf = grid ? (i) => grid.columns[i] : (i) => Math.floor(xs[i]),
            width = grid ? grid.width : 1;
        const columns = [];
        for (let i = 0; i < xs.length;) {
            if (raw[i].v === null) {
                columns.push({ gap: i++ });
                continue;
            }
            const x = columnOf(i);
            let end = i + 1,
                min = i,
                max = i;
            while (end < xs.length && raw[end].v !== null && columnOf(end) === x) {
                if (ys[end] < ys[min]) min = end;
                if (ys[end] > ys[max]) max = end;
                end++;
            }
            columns.push({ x, from: i, last: end - 1, min, max, noisy: false });
            i = end;
        }
        // Fast jitter often reverses between columns, so each column also sees its neighbours' edge samples.
        function reverses(from, to) {
            let direction = 0;
            for (let k = from + 1; k <= to; k++) {
                const step = Math.sign(ys[k] - ys[k - 1]);
                if (!step) continue;
                if (direction && step !== direction) return true;
                direction = step;
            }
            return false;
        }
        for (const c of columns) {
            if (c.gap !== undefined || ys[c.max] - ys[c.min] < 2) continue;
            const from = c.from > 0 && raw[c.from - 1].v !== null ? c.from - 1 : c.from,
                to = c.last + 1 < xs.length && raw[c.last + 1].v !== null ? c.last + 1 : c.last;
            c.noisy = reverses(from, to);
        }
        // A calm column or two inside noise would otherwise cut the band and redraw its full swing as a spike.
        for (let i = 1; i < columns.length;) {
            if (columns[i].noisy || !columns[i - 1].noisy) {
                i++;
                continue;
            }
            let end = i;
            while (end < columns.length && !columns[end].noisy && columns[end].gap === undefined) end++;
            const contiguous =
                end < columns.length && columns[end].noisy && columns[end].x - columns[i - 1].x === end - i + 1;
            if (contiguous && end - i <= 2) for (let k = i; k < end; k++) columns[k].noisy = true;
            i = Math.max(end, i + 1);
        }
        const bands = [];
        for (let i = 0; i < columns.length;) {
            if (!columns[i].noisy) {
                i++;
                continue;
            }
            let end = i + 1;
            while (end < columns.length && columns[end].noisy && columns[end].x === columns[end - 1].x + 1) end++;
            if (end - i < minRun) for (let k = i; k < end; k++) columns[k].noisy = false;
            else {
                const run = columns.slice(i, end),
                    mids = run.map((c) => (ys[c.min] + ys[c.max]) / 2);
                // Only reduced extrema reach the chart, so a short moving average stands in for the column mean.
                run.forEach((c, k) => {
                    const a = Math.max(0, k - trendRadius),
                        b = Math.min(run.length - 1, k + trendRadius);
                    let sum = 0;
                    for (let j = a; j <= b; j++) sum += mids[j];
                    c.trend = sum / (b - a + 1);
                });
                bands.push({
                    xs: Float64Array.from(run, (c) => (c.x + 0.5) * width),
                    top: Float64Array.from(run, (c) => ys[c.min]),
                    bottom: Float64Array.from(run, (c) => ys[c.max])
                });
            }
            i = end;
        }
        const lineX = [],
            lineY = [];
        for (const c of columns) {
            if (c.gap !== undefined) {
                lineX.push(xs[c.gap]);
                lineY.push(NaN);
            } else if (c.noisy) {
                lineX.push((c.x + 0.5) * width);
                lineY.push(c.trend);
            } else {
                let previous = -1;
                for (const index of [c.from, Math.min(c.min, c.max), Math.max(c.min, c.max), c.last])
                    if (index !== previous) {
                        lineX.push(xs[index]);
                        lineY.push(ys[index]);
                        previous = index;
                    }
            }
        }
        return { xs: Float64Array.from(lineX), ys: Float64Array.from(lineY), bands };
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
            bin = columnBin(Math.max(1, range.max - range.min), width),
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
            const next = floor(p.t / bin);
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
            const arr = s.xs || s.points;
            const bound = (x) => (s.xs ? lowerNumber(s.xs, x - s.dx) : lowerBound(arr, x, "x"));
            const start = Math.max(0, bound(pointer.x - radius) - 1);
            const end = Math.min(arr.length - 1, bound(pointer.x + radius));
            let best = Infinity,
                point = null;
            for (let i = start; i <= end; i++) {
                const a = s.xs ? pointAt(s, i) : arr[i],
                    next = Math.min(i + 1, arr.length - 1);
                let b = s.xs ? pointAt(s, next) : arr[next];
                if (a.raw?.v === null) continue;
                if (b.raw?.v === null) b = a;
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
    return {
        lowerBound,
        lowerNumber,
        pointAt,
        columnBin,
        envelopeIndices,
        jitterBands,
        nearest,
        read,
        delta,
        distance,
        hit,
        adjacent,
        envelope,
        visibleSegments
    };
});
