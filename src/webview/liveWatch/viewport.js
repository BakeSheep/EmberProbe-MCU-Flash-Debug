(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.EmberChartViewport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function validRange(range) {
        return !!range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min;
    }

    function makeRange(min, max, fallbackCenter) {
        min = Number(min);
        max = Number(max);
        if (Number.isFinite(min) && Number.isFinite(max) && max > min) return { min, max };
        const center = Number.isFinite(fallbackCenter) ? Number(fallbackCenter) : Number.isFinite(min) ? min : 0;
        const bump = Math.max(1, Math.abs(center) * 0.05);
        return { min: center - bump, max: center + bump };
    }

    function span(range) {
        return validRange(range) ? range.max - range.min : 0;
    }

    function normalizeFactor(factor) {
        factor = Number(factor);
        if (!Number.isFinite(factor) || factor <= 0) return 1;
        return Math.min(1e6, Math.max(1e-6, factor));
    }

    function zoom(range, factor, anchor, minimumSpan) {
        if (!validRange(range)) return makeRange(0, 1);
        factor = normalizeFactor(factor);
        anchor = Number.isFinite(anchor) ? Number(anchor) : (range.min + range.max) / 2;
        const oldSpan = span(range);
        const minSpan = Math.max(Number(minimumSpan) || 0, Number.EPSILON);
        let newSpan = Math.max(minSpan, oldSpan * factor);
        if (!Number.isFinite(newSpan)) newSpan = oldSpan;
        const ratio = (anchor - range.min) / oldSpan;
        const min = anchor - newSpan * ratio;
        return makeRange(min, min + newSpan, anchor);
    }

    function zoomCentered(range, factor, minimumSpan) {
        const center = validRange(range) ? (range.min + range.max) / 2 : 0;
        return zoom(range, factor, center, minimumSpan);
    }

    function pan(range, delta) {
        if (!validRange(range)) return makeRange(0, 1);
        delta = Number(delta);
        if (!Number.isFinite(delta)) delta = 0;
        return makeRange(range.min + delta, range.max + delta);
    }

    function clamp(range, bounds, minimumSpan) {
        if (!validRange(bounds)) return validRange(range) ? { min: range.min, max: range.max } : makeRange(0, 1);
        if (!validRange(range)) return { min: bounds.min, max: bounds.max };
        const boundSpan = span(bounds);
        const requestedMin = Math.max(0, Number(minimumSpan) || 0);
        const wantedSpan = Math.min(boundSpan, Math.max(requestedMin, span(range)));
        if (wantedSpan >= boundSpan) return { min: bounds.min, max: bounds.max };
        let min = range.min;
        let max = min + wantedSpan;
        if (min < bounds.min) {
            min = bounds.min;
            max = min + wantedSpan;
        }
        if (max > bounds.max) {
            max = bounds.max;
            min = max - wantedSpan;
        }
        return { min, max };
    }

    function zoomClamped(range, factor, anchor, bounds, minimumSpan) {
        return clamp(zoom(range, factor, anchor, minimumSpan), bounds, minimumSpan);
    }

    function panClamped(range, delta, bounds, minimumSpan) {
        return clamp(pan(range, delta), bounds, minimumSpan);
    }

    function updateEndpoint(range, edge, value, bounds, minimumSpan) {
        if (!validRange(bounds)) return validRange(range) ? range : makeRange(0, 1);
        range = clamp(range, bounds, minimumSpan);
        value = Math.min(bounds.max, Math.max(bounds.min, Number(value)));
        const minSpan = Math.min(span(bounds), Math.max(0, Number(minimumSpan) || 0));
        if (edge === "min") return { min: Math.min(value, range.max - minSpan), max: range.max };
        return { min: range.min, max: Math.max(value, range.min + minSpan) };
    }

    function toPercent(range, bounds) {
        if (!validRange(range) || !validRange(bounds)) return { left: 0, width: 100 };
        const total = span(bounds);
        const clamped = clamp(range, bounds, 0);
        return {
            left: ((clamped.min - bounds.min) / total) * 100,
            width: (span(clamped) / total) * 100
        };
    }

    function isAtEnd(range, bounds, tolerance) {
        if (!validRange(range) || !validRange(bounds)) return true;
        tolerance = Math.max(0, Number(tolerance) || 0);
        return bounds.max - range.max <= tolerance;
    }

    function followEnd(range, oldBounds, newBounds, minimumSpan) {
        if (!validRange(newBounds)) return validRange(range) ? range : makeRange(0, 1);
        const wantedSpan = validRange(range) ? span(range) : validRange(oldBounds) ? span(oldBounds) : span(newBounds);
        return clamp({ min: newBounds.max - wantedSpan, max: newBounds.max }, newBounds, minimumSpan);
    }

    // Include clipped, continuous line segments without inventing samples or bridging explicit gaps.
    function visibleRange(points, range) {
        let min = Infinity,
            max = -Infinity,
            count = 0;
        const include = (value) => {
            if (!Number.isFinite(value)) return;
            min = Math.min(min, value);
            max = Math.max(max, value);
        };
        for (let i = 0; i < points.length; i++) {
            const p = points[i],
                previous = points[i - 1];
            if (Number.isFinite(p.v) && p.t >= range.min && p.t <= range.max) {
                include(p.v);
                count++;
            }
            if (!previous || !Number.isFinite(previous.v) || !Number.isFinite(p.v) || p.t <= previous.t) continue;
            const from = Math.max(previous.t, range.min),
                to = Math.min(p.t, range.max);
            if (from >= to) continue;
            for (const time of [from, to]) {
                if (time === previous.t || time === p.t) continue;
                const ratio = (time - previous.t) / (p.t - previous.t);
                include(previous.v * (1 - ratio) + p.v * ratio);
            }
        }
        return { min, max, count };
    }

    function fitY(range, mode, padded) {
        if (mode !== "center") return padded;
        if (!validRange(range)) return zoomCentered(padded, 2.5);
        const center = range.min / 2 + range.max / 2;
        const half = span(range) / 0.8;
        const result = { min: center - half, max: center + half };
        return validRange(result) ? result : padded;
    }

    // Expand immediately to keep spikes visible; contract only after a second of substantial spare space.
    function stabilizeY(state, target, now) {
        if (!validRange(state.y) || state.fitRequested || !state.fitMode) {
            state.fitHold = null;
            return target;
        }
        const current = state.y;
        if (target.min < current.min || target.max > current.max) {
            state.fitHold = null;
            return { min: Math.min(target.min, current.min), max: Math.max(target.max, current.max) };
        }
        const spare = span(current) - span(target);
        const shift = Math.abs(target.min - current.min + (target.max - current.max)) / 2;
        if (spare < span(current) * 0.15 && shift < span(current) * 0.1) {
            state.fitHold = null;
            return current;
        }
        if (state.fitHold == null) state.fitHold = now;
        if (now - state.fitHold < 1000) return current;
        state.fitHold = null;
        return target;
    }

    function timeTick(time, width) {
        const date = new Date(time);
        const base =
            width >= 3600000
                ? date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : date.toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" });
        if (width >= 4000) return base;
        const fraction = width < 4 ? String(Math.floor((time - Math.floor(time)) * 1000)).padStart(3, "0") : "";
        return base + "." + String(date.getMilliseconds()).padStart(3, "0") + fraction;
    }

    return {
        validRange,
        makeRange,
        span,
        zoom,
        zoomCentered,
        pan,
        clamp,
        zoomClamped,
        panClamped,
        updateEndpoint,
        toPercent,
        isAtEnd,
        followEnd,
        visibleRange,
        fitY,
        stabilizeY,
        timeTick
    };
});
