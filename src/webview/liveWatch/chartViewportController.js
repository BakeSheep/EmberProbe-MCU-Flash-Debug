"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChartViewportController = factory();
})(globalThis, function () {
    function create(env) {
        const {
            canvas,
            stage,
            chartState: c,
            state,
            VP,
            clock,
            point,
            region,
            settle,
            custom,
            follow,
            minimumXSpan
        } = env;
        const copy = (range) => range && { ...range };
        const dirty = () => {
            c.fastDirty = state.dirty = true;
        };
        function reset() {
            c.viewHistory = [];
            c.lastWheel = -Infinity;
            c.fitHold = null;
            c.fitRequested = false;
            c.suppressClickUntil = 0;
        }
        reset();
        function snapshot() {
            return {
                x: copy(c.x),
                y: copy(c.y),
                autoY: c.autoY,
                fitMode: c.fitMode,
                follow: c.follow,
                startPinned: c.startPinned,
                axisOrigin: c.axisOrigin,
                window: env.getWindow()
            };
        }
        function remember(view = snapshot()) {
            if (!VP.validRange(view.x) || !VP.validRange(view.y)) return;
            c.viewHistory.push(view);
            if (c.viewHistory.length > 20) c.viewHistory.shift();
            c.lastWheel = -Infinity;
        }
        function undo() {
            if (c.drag || c.endpointDrag || c.timelineDrag) return;
            const view = c.viewHistory.pop();
            if (!view) return;
            settle();
            c.x = VP.clamp(view.x, c.bounds, minimumXSpan());
            c.y = copy(view.y);
            c.autoY = view.autoY;
            c.fitMode = view.fitMode;
            c.axisOrigin = view.axisOrigin;
            c.follow = view.follow;
            c.startPinned = view.startPinned;
            if (c.follow && c.bounds)
                c.x = c.startPinned ? copy(c.bounds) : VP.followEnd(c.x, null, c.bounds, minimumXSpan());
            c.fitHold = null;
            c.fitRequested = false;
            c.lastWheel = -Infinity;
            env.setWindow(view.window);
            env.saveUi();
            dirty();
        }
        function fit(mode, automatic) {
            if (!["center", "fill"].includes(mode) || !c.rangeStats || !Number.isFinite(c.rangeStats.vMin)) return;
            remember();
            c.fitMode = mode;
            c.autoY = automatic;
            c.fitRequested = true;
            c.fitHold = null;
            dirty();
        }
        function cursor(area) {
            canvas.style.cursor =
                area === "plot" ? "crosshair" : area === "x" ? "ew-resize" : area === "y" ? "ns-resize" : "default";
        }
        canvas.addEventListener("pointermove", (event) => {
            const p = point(event),
                drag = c.drag;
            if (drag) {
                if (event.pointerId !== drag.pointerId) return;
                const dx = p.x - drag.start.x,
                    dy = p.y - drag.start.y;
                const moveX = Math.abs(dx) > 3,
                    moveY = drag.mode === "pan" && Math.abs(dy) > 3;
                if (!drag.moved && !moveX && !moveY) return;
                if (!drag.moved) remember(drag.view);
                drag.moved = true;
                if (moveX || drag.moveX) {
                    drag.moveX = true;
                    c.x = VP.panClamped(drag.x, (-dx / c.geometry.pw) * VP.span(drag.x), c.bounds, minimumXSpan());
                    custom();
                    follow(false);
                }
                if (moveY || drag.moveY) {
                    drag.moveY = true;
                    c.y = VP.pan(drag.y, (dy / c.geometry.ph) * VP.span(drag.y));
                    c.autoY = false;
                    c.fitRequested = false;
                    c.fitHold = null;
                }
                c.pointer = p;
                dirty();
                return;
            }
            const area = region(p.x, p.y);
            cursor(area);
            c.pointer = area === "plot" ? p : null;
            dirty();
        });
        canvas.addEventListener("pointerleave", () => {
            if (c.drag) return;
            c.pointer = null;
            cursor("none");
            dirty();
        });
        canvas.addEventListener("pointerdown", (event) => {
            const p = point(event);
            if (c.drag || ![0, 1].includes(event.button) || region(p.x, p.y) !== "plot" || !c.x || !c.y) return;
            event.preventDefault();
            canvas.focus({ preventScroll: true });
            settle();
            c.drag = {
                mode: event.button === 1 ? "x" : "pan",
                moved: false,
                pointerId: event.pointerId,
                start: p,
                x: copy(c.x),
                y: copy(c.y),
                view: snapshot()
            };
            c.pointer = p;
            stage.classList.add("dragging");
            canvas.setPointerCapture(event.pointerId);
        });
        function endDrag(event) {
            if (!c.drag || c.drag.pointerId !== event.pointerId) return;
            c.suppressClickUntil = c.drag.moved ? clock.now() + 50 : 0;
            c.drag = null;
            stage.classList.remove("dragging");
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
            cursor(c.pointer ? "plot" : "none");
            dirty();
        }
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, endDrag);
        canvas.addEventListener("auxclick", (event) => {
            if (event.button === 1) event.preventDefault();
        });
        canvas.addEventListener(
            "wheel",
            (event) => {
                const p = point(event),
                    area = region(p.x, p.y);
                if (area === "none" || !c.x || !c.y || c.drag || !Number.isFinite(event.deltaY) || !event.deltaY)
                    return;
                event.preventDefault();
                settle();
                const now = clock.now();
                if (now - c.lastWheel > 250 || c.wheelArea !== area) remember();
                c.lastWheel = now;
                c.wheelArea = area;
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
                const factor = Math.exp(Math.max(-4, Math.min(4, event.deltaY * unit * 0.0015)));
                if (area === "plot" || area === "x") {
                    const anchor = c.x.min + ((p.x - c.geometry.padL) / c.geometry.pw) * VP.span(c.x);
                    c.x = VP.zoomClamped(c.x, factor, anchor, c.bounds, minimumXSpan());
                    custom();
                    follow(true);
                }
                if (area === "plot" || area === "y") {
                    const ratio = Math.max(0, Math.min(1, (p.y - c.geometry.padT) / c.geometry.ph));
                    const minY = Math.max(Number.EPSILON, Math.abs(c.y.min / 2 + c.y.max / 2) * 1e-12);
                    c.y = VP.zoom(c.y, factor, c.y.max - ratio * VP.span(c.y), minY);
                    c.autoY = false;
                    c.fitRequested = false;
                    c.fitHold = null;
                }
                c.pointer = area === "plot" ? p : null;
                dirty();
            },
            { passive: false }
        );
        canvas.tabIndex = 0;
        canvas.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
                event.preventDefault();
                event.stopPropagation();
                undo();
            }
        });
        return {
            snapshot,
            remember,
            undo,
            fit,
            reset,
            allowClick: () => clock.now() >= c.suppressClickUntil
        };
    }
    return { create };
});
