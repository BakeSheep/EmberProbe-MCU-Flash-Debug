"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports)
        module.exports = factory(require("./chartInspection"), require("./backgroundIcon"));
    else root.EmberProbeChart = factory(root.EmberProbeChartInspection, root.EmberProbeBackgroundIcon);
})(globalThis, function (defaultInspection, BackgroundIcon) {
    function exactInteger(point) {
        if (point.valueText != null && /^-?\d+$/.test(point.valueText)) return BigInt(point.valueText);
        return Number.isSafeInteger(point.v) ? BigInt(point.v) : null;
    }

    // Subtract in integer space before converting to canvas coordinates. Raw history stays exact for CSV.
    function offsetSeries(series, norm) {
        function originFor(items) {
            for (const item of items) {
                const arr = item.arr;
                for (let j = arr.length - 1; j >= 0; j--) {
                    const p = arr[j];
                    if (Number.isSafeInteger(p.v)) continue;
                    const exact = exactInteger(p);
                    if (exact !== null && !Number.isSafeInteger(Number(exact))) return exact;
                }
            }
            return null;
        }
        const origin = norm ? null : originFor(series);
        const bases = new Map();
        if (norm)
            for (const s of series) {
                if (!bases.has(s.item.name))
                    bases.set(s.item.name, originFor(series.filter((item) => item.item.name === s.item.name)));
            }
        return {
            origin,
            series: series.map((s) => {
                const base = norm ? bases.get(s.item.name) : origin;
                if (base === null) return s;
                return {
                    ...s,
                    arr: s.arr.map((p) => {
                        if (p.v === null) return p;
                        const exact = exactInteger(p);
                        return { ...p, v: exact === null ? p.v - Number(base) : Number(exact - base) };
                    })
                };
            })
        };
    }

    function paintChart({
        canvas,
        ctx,
        chartState,
        norm,
        jitterBands,
        backgroundIcon,
        series,
        hasBounds,
        pixelRatio,
        style,
        elements,
        VP,
        padRange,
        fmtNum,
        colorFor,
        styleFor,
        inspection,
        formatChartTime,
        t
    }) {
        const $ = (id) => elements[id];
        const sourceSeries = series;
        inspection = inspection || defaultInspection;
        const prepareKey = norm;
        if (!chartState.prepared || chartState.prepared.source !== series || chartState.prepared.key !== prepareKey)
            chartState.prepared = { source: series, key: prepareKey, value: offsetSeries(series, norm) };
        const prepared = chartState.prepared.value;
        if (
            !norm &&
            chartState.axisOrigin !== undefined &&
            chartState.axisOrigin !== prepared.origin &&
            chartState.y &&
            !chartState.autoY
        ) {
            const shift = Number((chartState.axisOrigin ?? 0n) - (prepared.origin ?? 0n));
            chartState.y = { min: chartState.y.min + shift, max: chartState.y.max + shift };
        }
        chartState.axisOrigin = prepared.origin;
        series = prepared.series;
        function axisText(value) {
            if (prepared.origin === null) return fmtNum(value);
            const whole = Math.floor(value);
            const scale = 100000n;
            const units =
                (prepared.origin + BigInt(whole)) * scale + BigInt(Math.round((value - whole) * Number(scale)));
            const absolute = units < 0n ? -units : units;
            const fraction = String(absolute % scale)
                .padStart(5, "0")
                .replace(/0+$/, "");
            return (units < 0n ? "-" : "") + String(absolute / scale) + (fraction ? "." + fraction : "");
        }
        function drawAxisBadge(text, x, y, maxWidth, fill, stroke, align) {
            ctx.save();
            ctx.font = "10px " + (style.fontFamily || "sans-serif");
            var width = Math.min(maxWidth, Math.max(34, ctx.measureText(text).width + 8)),
                height = 17,
                left = align === "center" ? x - width / 2 : x,
                top = y - height / 2;
            left = Math.max(1, Math.min(canvas.clientWidth - width - 1, left));
            ctx.fillStyle = fill;
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.rect(left + 3, top, width - 6, height);
            ctx.clip();
            ctx.fillStyle = stroke;
            ctx.textAlign = align === "center" ? "center" : "left";
            ctx.textBaseline = "middle";
            ctx.fillText(text, align === "center" ? left + width / 2 : left + 4, y);
            ctx.restore();
        }
        function drawCrosshair(colors) {
            var p = chartState.pointer,
                g = chartState.geometry;
            if (!p || !g || p.x < g.padL || p.x > g.padL + g.pw || p.y < g.padT || p.y > g.padT + g.ph) return;
            var time = chartState.x.min + ((p.x - g.padL) / g.pw) * VP.span(chartState.x),
                ratio = (p.y - g.padT) / g.ph,
                yValue = chartState.y.max - ratio * VP.span(chartState.y),
                yText = axisText(yValue);
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.globalAlpha = 0.72;
            ctx.lineWidth = 1;
            ctx.strokeStyle = colors.focus;
            ctx.beginPath();
            ctx.moveTo(p.x, g.padT);
            ctx.lineTo(p.x, g.padT + g.ph);
            ctx.moveTo(g.padL, p.y);
            ctx.lineTo(g.padL + g.pw, p.y);
            ctx.stroke();
            ctx.restore();
            drawAxisBadge(
                formatChartTime(time),
                p.x,
                g.padT + g.ph + 28,
                92,
                colors.background,
                colors.focus,
                "center"
            );
            if (!norm) drawAxisBadge(yText, 2, p.y, g.padL - 8, colors.background, colors.focus, "left");
        }
        function paint() {
            var dpr = Math.max(1, pixelRatio || 1),
                w = canvas.clientWidth,
                h = canvas.clientHeight;
            if (!w || !h) return;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.font = "10px " + (style.fontFamily || "sans-serif");
            const iconPadL =
                prepared.origin === null
                    ? 64
                    : Math.max(64, ctx.measureText(String(prepared.origin) + ".00000").width + 20);
            if (backgroundIcon && w > iconPadL + 18 && h > 60)
                BackgroundIcon.paint(ctx, backgroundIcon, {
                    padL: iconPadL,
                    padT: 18,
                    pw: w - iconPadL - 18,
                    ph: h - 60
                });
            var empty = $("chartEmpty");
            if (!hasBounds || !series.length) {
                chartState.hits = [];
                empty.classList.remove("hidden");
                $("points").textContent = t("lw.points", { n: 0 });
                $("range").textContent = "-";
                return;
            }
            ctx.font = "10px " + (style.fontFamily || "sans-serif");
            var padL =
                    prepared.origin === null
                        ? 64
                        : Math.max(64, ctx.measureText(String(prepared.origin) + ".00000").width + 20),
                padR = 18,
                padT = 18,
                padB = 42,
                pw = Math.max(10, w - padL - padR),
                ph = Math.max(10, h - padT - padB),
                total = 0,
                vMin = Infinity,
                vMax = -Infinity,
                visibleKey =
                    (norm ? "n:" : "r:") +
                    String(prepared.origin) +
                    ":" +
                    series
                        .map(function (s) {
                            return s.item.name;
                        })
                        .join("|");
            chartState.geometry = { padL: padL, padR: padR, padT: padT, padB: padB, pw: pw, ph: ph, w: w, h: h };
            if (chartState.visibleKey !== visibleKey) {
                chartState.visibleKey = visibleKey;
            }
            const statsKey = chartState.smoothFollowing
                ? chartState.smoothCommit
                : JSON.stringify([norm, chartState.x]);
            const held = chartState.rangeStats;
            if (
                !held ||
                held.key !== statsKey ||
                held.norm !== norm ||
                held.origin !== prepared.origin ||
                (!chartState.smoothFollowing && held.source !== sourceSeries)
            ) {
                const ranges = new Map();
                series.forEach(function (s) {
                    var lo = Infinity,
                        hi = -Infinity,
                        count = 0;
                    s.arr.forEach(function (p) {
                        if (p.v === null || p.t < chartState.x.min || p.t > chartState.x.max) return;
                        count++;
                        lo = Math.min(lo, p.v);
                        hi = Math.max(hi, p.v);
                        vMin = Math.min(vMin, p.v);
                        vMax = Math.max(vMax, p.v);
                    });
                    total += s.visibleCount ?? count;
                    const previous = ranges.get(s.item.name) || { min: Infinity, max: -Infinity };
                    ranges.set(s.item.name, { min: Math.min(previous.min, lo), max: Math.max(previous.max, hi) });
                });
                chartState.rangeStats = {
                    key: statsKey,
                    source: sourceSeries,
                    norm,
                    origin: prepared.origin,
                    total,
                    vMin,
                    vMax,
                    ranges
                };
            } else {
                ({ total, vMin, vMax } = held);
            }
            series.forEach((s) => {
                const range = chartState.rangeStats.ranges.get(s.item.name) || { min: Infinity, max: -Infinity };
                const base = padRange(range.min, range.max);
                s.vMin = base.min;
                s.vMax = base.max;
            });
            if (!total) {
                chartState.hits = [];
                empty.classList.remove("hidden");
                $("points").textContent = t("lw.points", { n: 0 });
                $("range").textContent = "-";
                return;
            }
            empty.classList.add("hidden");
            if (chartState.autoY || !VP.validRange(chartState.y))
                chartState.y = norm ? { min: -0.08, max: 1.08 } : padRange(vMin, vMax);
            var bs = style,
                fontFam = bs.fontFamily,
                descColor = bs.getPropertyValue("--vscode-descriptionForeground") || "#999",
                background = bs.getPropertyValue("--vscode-editor-background") || "#1e1e1e",
                focus = bs.getPropertyValue("--vscode-focusBorder") || "#007fd4";
            const xSpan = VP.span(chartState.x),
                ySpan = VP.span(chartState.y),
                pxPerMs = pw / xSpan,
                pxPerValue = ph / ySpan;
            const geometryKey = JSON.stringify([
                norm,
                !!jitterBands,
                xSpan,
                ySpan,
                w,
                h,
                dpr,
                padL,
                padR,
                padT,
                padB,
                norm ? series.map((s) => [s.vMin, s.vMax]) : null
            ]);
            let geometry = chartState.curveGeometry;
            if (
                !geometry ||
                geometry.source !== sourceSeries ||
                geometry.key !== geometryKey ||
                chartState.x.min < geometry.min ||
                chartState.x.max > geometry.max
            ) {
                // Jitter columns share the reductions' absolute power-of-two time bins, so spikes do not flip
                // between the band and the line whenever the view scrolls or "All" grows.
                const binMs = inspection.columnBin(xSpan, pw),
                    xRef = Math.floor(chartState.x.min / binMs) * binMs,
                    yRef = chartState.y.max,
                    min = xRef - xSpan / 2,
                    max = chartState.x.max + xSpan / 2;
                geometry = chartState.curveGeometry = {
                    source: sourceSeries,
                    key: geometryKey,
                    min,
                    max,
                    xRef,
                    yRef,
                    value: series.map((s, index) => {
                        const from = Math.max(0, inspection.lowerBound(s.arr, min) - 1),
                            to = Math.min(s.arr.length, inspection.lowerBound(s.arr, max) + 1),
                            length = to - from,
                            xs = new Float64Array(length),
                            ys = new Float64Array(length),
                            columns = jitterBands ? new Float64Array(length) : null,
                            raw = sourceSeries[index].arr.slice(from, to);
                        for (let i = 0; i < length; i++) {
                            const p = s.arr[from + i],
                                value = norm ? (p.v - s.vMin) / (s.vMax - s.vMin || 1) : p.v;
                            xs[i] = (p.t - xRef) * pxPerMs;
                            ys[i] = (yRef - value) * pxPerValue;
                            if (columns) columns[i] = Math.floor((p.t - xRef) / binMs);
                        }
                        return {
                            name: s.item.name,
                            xs,
                            ys,
                            raw,
                            ...(jitterBands
                                ? {
                                      banded: inspection.jitterBands(xs, ys, raw, undefined, undefined, {
                                          columns,
                                          width: binMs * pxPerMs
                                      })
                                  }
                                : { drawing: inspection.envelopeIndices(xs, ys, raw) })
                        };
                    })
                };
            }
            for (const curve of geometry.value) {
                curve.dx = padL + (geometry.xRef - chartState.x.min) * pxPerMs;
                curve.dy = padT + (chartState.y.max - geometry.yRef) * pxPerValue;
            }
            const pointer = chartState.pointer;
            const inPlot =
                pointer && pointer.x >= padL && pointer.x <= padL + pw && pointer.y >= padT && pointer.y <= padT + ph;
            chartState.hits = inspection && inPlot ? inspection.hit(chartState.curveGeometry.value, pointer) : [];
            const selected = chartState.selectedName || chartState.hits[0]?.name;
            ctx.lineWidth = 1;
            ctx.font = "10px " + fontFam;
            ctx.textBaseline = "middle";
            for (var gy = 0; gy <= 5; gy++) {
                var y = padT + (ph * gy) / 5;
                ctx.strokeStyle = "rgba(128,128,128,.16)";
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(padL + pw, y);
                ctx.stroke();
                if (!norm) {
                    var val = chartState.y.max - (VP.span(chartState.y) * gy) / 5;
                    ctx.fillStyle = descColor;
                    ctx.textAlign = "right";
                    ctx.fillText(axisText(val), padL - 7, y);
                }
            }
            for (var gx = 0; gx <= 4; gx++) {
                var x = padL + (pw * gx) / 4,
                    tt = chartState.x.min + (VP.span(chartState.x) * gx) / 4;
                ctx.strokeStyle = "rgba(128,128,128,.11)";
                ctx.beginPath();
                ctx.moveTo(x, padT);
                ctx.lineTo(x, padT + ph);
                ctx.stroke();
                ctx.textAlign = "center";
                ctx.fillStyle = descColor;
                ctx.fillText(
                    new Date(tt).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" }),
                    x,
                    padT + ph + 18
                );
            }
            // Fills the noise band, strokes the trend line with the current dash, returns the last visible sample.
            function paintBanded(s, color, left, right) {
                const { xs, ys, bands } = s.banded,
                    alpha = ctx.globalAlpha;
                ctx.fillStyle = color;
                ctx.globalAlpha = alpha * 0.28;
                for (const band of bands) {
                    const n = band.xs.length;
                    if (band.xs[n - 1] < left || band.xs[0] > right) continue;
                    ctx.beginPath();
                    ctx.moveTo(band.xs[0] + s.dx, band.top[0] + s.dy);
                    for (let k = 1; k < n; k++) ctx.lineTo(band.xs[k] + s.dx, band.top[k] + s.dy);
                    for (let k = n - 1; k >= 0; k--) ctx.lineTo(band.xs[k] + s.dx, band.bottom[k] + s.dy);
                    ctx.closePath();
                    ctx.fill();
                }
                ctx.globalAlpha = alpha;
                ctx.beginPath();
                const from = Math.max(0, inspection.lowerNumber(xs, left) - 1),
                    to = Math.min(xs.length, inspection.lowerNumber(xs, right, null, true) + 1);
                let started = false;
                for (let j = from; j < to; j++) {
                    if (Number.isNaN(ys[j])) {
                        started = false;
                        continue;
                    }
                    if (started) ctx.lineTo(xs[j] + s.dx, ys[j] + s.dy);
                    else {
                        ctx.moveTo(xs[j] + s.dx, ys[j] + s.dy);
                        started = true;
                    }
                }
                ctx.stroke();
                let i = inspection.lowerBound(s.raw, chartState.x.max);
                if (i >= s.raw.length || s.raw[i].t > chartState.x.max) i--;
                while (i >= 0 && s.raw[i].v === null) i--;
                return i >= 0 && s.raw[i].t >= chartState.x.min ? i : null;
            }
            // The smooth-follow edge trails committed data, so a marker on the last visible sample would slide left
            // and snap back whenever a sparse sample crosses it. Pin it where the drawn line meets the edge instead.
            function edgeHead(xs, ys, right, indices, gap) {
                const k = inspection.lowerNumber(xs, right, indices, true);
                if (k <= 0 || k >= (indices ? indices.length : xs.length)) return null;
                const a = indices ? indices[k - 1] : k - 1,
                    b = indices ? indices[k] : k;
                if (gap(a) || gap(b)) return null;
                return { x: right, y: ys[a] + ((ys[b] - ys[a]) * (right - xs[a])) / (xs[b] - xs[a]) };
            }
            ctx.save();
            ctx.beginPath();
            ctx.rect(padL, padT, pw, ph);
            ctx.clip();
            chartState.curveGeometry.value
                .slice()
                .sort((a, b) => Number(a.name === selected) - Number(b.name === selected))
                .forEach(function (s) {
                    const index = series.findIndex((item) => item.item.name === s.name);
                    const appearance = styleFor
                        ? styleFor(s.name)
                        : { color: colorFor(series[index].idx), line: "solid" };
                    ctx.strokeStyle = appearance.color;
                    ctx.setLineDash(appearance.line === "dashed" ? [8, 4] : appearance.line === "dotted" ? [2, 4] : []);
                    ctx.globalAlpha = selected && selected !== s.name ? 0.4 : 1;
                    ctx.lineWidth = selected === s.name ? 3 : 1.7;
                    ctx.lineJoin = "round";
                    var started = false,
                        last = null;
                    const left = padL - s.dx,
                        right = padL + pw - s.dx;
                    if (s.banded) {
                        last = paintBanded(s, appearance.color, left, right);
                    } else {
                        ctx.beginPath();
                        const from = Math.max(0, inspection.lowerNumber(s.xs, left, s.drawing) - 1),
                            to = Math.min(s.drawing.length, inspection.lowerNumber(s.xs, right, s.drawing, true) + 1);
                        for (let j = from; j < to; j++) {
                            const i = s.drawing[j],
                                raw = s.raw[i];
                            if (raw.v === null) {
                                started = false;
                                continue;
                            }
                            const x = s.xs[i] + s.dx,
                                y = s.ys[i] + s.dy;
                            if (started) ctx.lineTo(x, y);
                            else {
                                ctx.moveTo(x, y);
                                started = true;
                            }
                            if (raw.t >= chartState.x.min && raw.t <= chartState.x.max) last = i;
                        }
                        ctx.stroke();
                    }
                    if (last !== null) {
                        const head = (chartState.smoothFollowing &&
                            (s.banded
                                ? edgeHead(s.banded.xs, s.banded.ys, right, null, (i) => Number.isNaN(s.banded.ys[i]))
                                : edgeHead(s.xs, s.ys, right, s.drawing, (i) => s.raw[i].v === null))) || {
                            x: s.xs[last],
                            y: s.ys[last]
                        };
                        ctx.fillStyle = appearance.color;
                        ctx.beginPath();
                        ctx.arc(head.x + s.dx, head.y + s.dy, 2.8, 0, Math.PI * 2);
                        ctx.fill();
                    }
                });
            ctx.restore();
            drawCrosshair({ background: background, focus: focus });
            $("points").textContent = t("lw.points", { n: total });
            $("range").textContent = norm
                ? t("lw.normalized")
                : axisText(chartState.y.min) + " ～ " + axisText(chartState.y.max);
        }

        paint();
    }
    return { paint: paintChart };
});
