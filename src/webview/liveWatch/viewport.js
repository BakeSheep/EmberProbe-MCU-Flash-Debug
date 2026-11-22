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

    const RANGE_BLOCK_POINTS = 64;
    const FIT_HOLD_MS = 1000;

    function summarizeRanges(points) {
        const blocks = [];
        for (let first = 0; first < points.length; first += RANGE_BLOCK_POINTS) {
            let min = Infinity,
                max = -Infinity,
                count = 0;
            const end = Math.min(points.length, first + RANGE_BLOCK_POINTS);
            for (let i = first; i < end; i++) {
                const value = points[i].v;
                if (!Number.isFinite(value)) continue;
                min = Math.min(min, value);
                max = Math.max(max, value);
                count++;
            }
            blocks.push({ min, max, count });
        }
        return blocks;
    }

    function rangeIndex(points, time, upper) {
        let lo = 0,
            hi = points.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const t = points[mid].t;
            if (t < time || (upper && t === time)) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Read whole blocks from the summary. Only the two edges need the original points and clipped segments.
    function visibleRange(points, range, blocks) {
        const first = rangeIndex(points, range.min, false),
            after = rangeIndex(points, range.max, true);
        let min = Infinity,
            max = -Infinity,
            count = 0;
        const include = (value) => {
            if (!Number.isFinite(value)) return;
            min = Math.min(min, value);
            max = Math.max(max, value);
        };
        for (let i = first; i < after;) {
            if (blocks && i % RANGE_BLOCK_POINTS === 0 && i + RANGE_BLOCK_POINTS <= after) {
                const block = blocks[i / RANGE_BLOCK_POINTS];
                min = Math.min(min, block.min);
                max = Math.max(max, block.max);
                count += block.count;
                i += RANGE_BLOCK_POINTS;
            } else {
                const v = points[i++].v;
                if (Number.isFinite(v)) {
                    include(v);
                    count++;
                }
            }
        }
        if (range.min < range.max) {
            for (const [index, time] of [
                [first, range.min],
                [after, range.max]
            ]) {
                const a = points[index - 1],
                    b = points[index];
                if (!a || !b || !Number.isFinite(a.v) || !Number.isFinite(b.v) || !(a.t < time && time < b.t)) continue;
                const ratio = (time - a.t) / (b.t - a.t);
                include(a.v * (1 - ratio) + b.v * ratio);
            }
        }
        return { min, max, count };
    }

    function padRange(lo, hi) {
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: -1, max: 1 };
        if (hi <= lo) {
            const bump = Math.abs(lo) * 0.05 || 1;
            return { min: lo - bump, max: hi + bump };
        }
        const padding = (hi - lo) * 0.08;
        return { min: lo - padding, max: hi + padding };
    }

    function fitY(range, mode, padded) {
        if (mode !== "center") return padded;
        if (!validRange(range)) return zoomCentered(padded, 2.5);
        const center = range.min / 2 + range.max / 2;
        const half = span(range) / 0.8;
        const result = { min: center - half, max: center + half };
        return validRange(result) ? result : padded;
    }

    function stabilizeY(state, target, now, current = state.y, centered = state.fitMode === "center") {
        if (!validRange(current) || state.fitRequested || !state.fitMode) {
            state.fitHold = null;
            return target;
        }
        if (centered) {
            const midpoint = target.min / 2 + target.max / 2;
            const halfSpan = span(current) / 2;
            current = { min: midpoint - halfSpan, max: midpoint + halfSpan };
        }
        if (!validRange(current) || target.min < current.min || target.max > current.max) {
            state.fitHold = null;
            return centered
                ? target
                : { min: Math.min(target.min, current.min), max: Math.max(target.max, current.max) };
        }
        const spare = span(current) - span(target);
        const shift = Math.abs(target.min - current.min + (target.max - current.max)) / 2;
        if (spare < span(current) * 0.15 && shift < span(current) * 0.1) {
            state.fitHold = null;
            return current;
        }
        if (state.fitHold == null) state.fitHold = now;
        if (now - state.fitHold < FIT_HOLD_MS) return current;
        state.fitHold = null;
        return target;
    }

    function followY(state, target, visible, now) {
        const motion = state.yFitMotion;
        // Move the fitted range with the data before testing contraction. Accumulating space on the trailing
        // side of a drifting curve would repeatedly widen the scale before dropping back to the fitted span.
        const fit = stabilizeY(state, target, now, motion?.target, true);
        if (!validRange(state.y) || state.fitRequested) {
            state.yFitMotion = null;
            return fit;
        }
        // History arrives in batches. Ease the displayed bounds between commits while keeping new extrema visible.
        const elapsed = Math.max(0, now - (motion?.at ?? now));
        const weight = -Math.expm1(-elapsed / 120);
        const nextMin = state.y.min + (fit.min - state.y.min) * weight;
        const nextMax = state.y.max + (fit.max - state.y.max) * weight;
        const y = {
            min: Math.min(visible.min, elapsed > 0 && nextMin === state.y.min ? fit.min : nextMin),
            max: Math.max(visible.max, elapsed > 0 && nextMax === state.y.max ? fit.max : nextMax)
        };
        const pending = Math.max(Math.abs(fit.min - y.min), Math.abs(fit.max - y.max)) > span(fit) * 0.001;
        state.yFitMotion = { target: fit, at: now, pending };
        return pending ? y : fit;
    }

    function twoDigits(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function timeTick(time, width) {
        const date = new Date(time);
        const mmss = twoDigits(date.getMinutes()) + ":" + twoDigits(date.getSeconds());
        const base = width >= 3600000 ? twoDigits(date.getHours()) + ":" + mmss : mmss;
        if (width >= 4000) return base;
        const ms = date.getMilliseconds();
        const msText = ms < 10 ? "00" + ms : ms < 100 ? "0" + ms : String(ms);
        if (width >= 4) return base + "." + msText;
        const us = Math.floor((time - Math.floor(time)) * 1000);
        const usText = us < 10 ? "00" + us : us < 100 ? "0" + us : String(us);
        return base + "." + msText + usText;
    }

    function commitFollowClock(clock, bounds, xMax, spanValue, key, now) {
        if (!clock || clock.key !== key || Math.abs(clock.span - spanValue) > 0.001 || bounds.max < clock.dataMax) {
            return {
                key,
                span: spanValue,
                time: Math.max(bounds.min, Math.min(xMax, bounds.max)),
                interval: 45,
                peakInterval: 60,
                committedAt: now,
                frameAt: now,
                dataMax: bounds.max
            };
        }
        const gap = Math.max(0, now - clock.committedAt);
        clock.interval += 0.2 * (gap - clock.interval);
        clock.peakInterval = gap > clock.peakInterval ? gap : clock.peakInterval + 0.05 * (gap - clock.peakInterval);
        clock.committedAt = now;
        clock.dataMax = bounds.max;
        return clock;
    }

    function advanceFollowClock(clock, now) {
        const elapsed = Math.max(0, now - clock.frameAt);
        const cushion = Math.min(350, Math.max(clock.interval * 1.25, clock.peakInterval ?? clock.interval) + 24);
        const target = clock.dataMax - cushion + Math.max(0, now - clock.committedAt);
        const rate = Math.max(0.75, Math.min(1.25, 1 + (target - (clock.time + elapsed)) / 200));
        clock.time = Math.max(clock.time, Math.min(clock.dataMax, clock.time + elapsed * rate));
        clock.frameAt = now;
        return { min: clock.time - clock.span, max: clock.time };
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
        summarizeRanges,
        visibleRange,
        FIT_HOLD_MS,
        padRange,
        fitY,
        stabilizeY,
        followY,
        timeTick,
        commitFollowClock,
        advanceFollowClock
    };
});
