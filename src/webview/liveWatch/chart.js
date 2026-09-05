"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChart = factory();
})(globalThis, function () {
    function paintChart({
        canvas,
        ctx,
        chartState,
        norm,
        series,
        hasBounds,
        pixelRatio,
        style,
        elements,
        VP,
        padRange,
        fmtNum,
        colorFor,
        formatChartTime,
        t
    }) {
        const $ = (id) => elements[id];
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
                yText = fmtNum(yValue);
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
            var empty = $("chartEmpty");
            if (!hasBounds || !series.length) {
                empty.classList.remove("hidden");
                $("points").textContent = t("lw.points", { n: 0 });
                $("range").textContent = "-";
                return;
            }
            var padL = 64,
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
                    series
                        .map(function (s) {
                            return s.item.name;
                        })
                        .join("|");
            chartState.geometry = { padL: padL, padR: padR, padT: padT, padB: padB, pw: pw, ph: ph, w: w, h: h };
            if (chartState.visibleKey !== visibleKey) {
                chartState.visibleKey = visibleKey;
                chartState.autoY = true;
            }
            series.forEach(function (s) {
                var lo = Infinity,
                    hi = -Infinity;
                s.arr.forEach(function (p) {
                    if (p.t < chartState.x.min || p.t > chartState.x.max) return;
                    total++;
                    lo = Math.min(lo, p.v);
                    hi = Math.max(hi, p.v);
                    vMin = Math.min(vMin, p.v);
                    vMax = Math.max(vMax, p.v);
                });
                var base = padRange(lo, hi);
                s.vMin = base.min;
                s.vMax = base.max;
            });
            if (!total) {
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
            function X(tt) {
                return padL + ((tt - chartState.x.min) / VP.span(chartState.x)) * pw;
            }
            function normalizedValue(v, s) {
                return (v - s.vMin) / (s.vMax - s.vMin || 1);
            }
            function Yg(v) {
                return padT + (1 - (v - chartState.y.min) / VP.span(chartState.y)) * ph;
            }
            function Yp(v, s) {
                return Yg(norm ? normalizedValue(v, s) : v);
            }
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
                    ctx.fillText(fmtNum(val), padL - 7, y);
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
            ctx.save();
            ctx.beginPath();
            ctx.rect(padL, padT, pw, ph);
            ctx.clip();
            series.forEach(function (s) {
                ctx.strokeStyle = colorFor(s.idx);
                ctx.lineWidth = 1.7;
                ctx.lineJoin = "round";
                ctx.beginPath();
                var started = false,
                    last = null;
                s.arr.forEach(function (p) {
                    var x = X(p.t),
                        y = Yp(p.v, s);
                    if (started) ctx.lineTo(x, y);
                    else {
                        ctx.moveTo(x, y);
                        started = true;
                    }
                    if (p.t >= chartState.x.min && p.t <= chartState.x.max) last = p;
                });
                ctx.stroke();
                if (last) {
                    ctx.fillStyle = colorFor(s.idx);
                    ctx.beginPath();
                    ctx.arc(X(last.t), Yp(last.v, s), 2.8, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
            ctx.restore();
            drawCrosshair({ background: background, focus: focus });
            $("points").textContent = t("lw.points", { n: total });
            $("range").textContent = norm
                ? t("lw.normalized")
                : fmtNum(chartState.y.min) + " ～ " + fmtNum(chartState.y.max);
        }

        paint();
    }
    return { paint: paintChart };
});
