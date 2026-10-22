"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChartTransport = factory();
})(globalThis, function () {
    function encodeViewport(result) {
        const series = [],
            transfer = [],
            source = result.series || [];
        for (let from = 0; from < source.length;) {
            let to = from,
                length = 0;
            const { name, item } = source[from];
            while (to < source.length && source[to].name === name) length += source[to++].arr.length;
            const t = new Float64Array(length),
                v = new Float64Array(length),
                ends = new Uint32Array(to - from),
                visibleCounts = new Float64Array(to - from),
                texts = [];
            let offset = 0;
            for (let segment = from; segment < to; segment++) {
                for (const point of source[segment].arr) {
                    t[offset] = point.t;
                    v[offset] = point.v;
                    if (typeof point.valueText === "string") texts.push([offset, point.valueText]);
                    offset++;
                }
                ends[segment - from] = offset;
                visibleCounts[segment - from] = source[segment].visibleCount ?? NaN;
            }
            series.push({ name, item, t, v, ends, visibleCounts, texts });
            transfer.push(t.buffer, v.buffer, ends.buffer, visibleCounts.buffer);
            from = to;
        }
        return { message: { ...result, series }, transfer };
    }

    // Check the kind across realms too (for example, an embedded browser receiving host arrays).
    function isTypedArray(value, kind) {
        return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === `[object ${kind}]`;
    }

    function validPacked(entry) {
        const { t, v, ends, visibleCounts, texts } = entry;
        if (
            !isTypedArray(t, "Float64Array") ||
            !isTypedArray(v, "Float64Array") ||
            !isTypedArray(ends, "Uint32Array") ||
            !isTypedArray(visibleCounts, "Float64Array") ||
            t.length !== v.length ||
            ends.length !== visibleCounts.length ||
            !Array.isArray(texts)
        )
            return false;
        let previous = 0;
        for (const end of ends) {
            if (end < previous || end > t.length) return false;
            previous = end;
        }
        if (previous !== t.length) return false;
        for (const text of texts) {
            if (
                !Array.isArray(text) ||
                text.length !== 2 ||
                !Number.isInteger(text[0]) ||
                text[0] < 0 ||
                text[0] >= t.length ||
                typeof text[1] !== "string"
            )
                return false;
        }
        return true;
    }

    function decodeViewport(series) {
        if (!Array.isArray(series)) return [];
        const decoded = [];
        for (const entry of series) {
            if (!entry || typeof entry !== "object") continue;
            if ("arr" in entry) {
                decoded.push(entry);
                continue;
            }
            if (!validPacked(entry)) continue;
            const { name, item, t, v, ends, visibleCounts, texts } = entry;
            const points = Array.from(t, (time, index) => ({ t: time, v: v[index], valueText: null }));
            for (const [index, text] of texts) points[index].valueText = text;
            let from = 0;
            for (let segment = 0; segment < ends.length; segment++) {
                const visibleCount = visibleCounts[segment];
                decoded.push({
                    name,
                    item,
                    arr: points.slice(from, ends[segment]),
                    ...(Number.isNaN(visibleCount) ? {} : { visibleCount })
                });
                from = ends[segment];
            }
        }
        return decoded;
    }
    return { encodeViewport, decodeViewport };
});
