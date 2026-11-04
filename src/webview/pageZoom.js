"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbePageZoom = factory();
})(globalThis, function () {
    function scale(doc) {
        return Number(doc.documentElement.style.zoom) || 1;
    }
    // DOM rectangles and pointer positions are viewport pixels; styles and canvas geometry use layout pixels.
    function coordinate(value, doc) {
        return value / scale(doc);
    }
    function rect(element) {
        const bounds = element.getBoundingClientRect();
        return Object.fromEntries(
            ["left", "right", "top", "bottom", "width", "height"].map((key) => [
                key,
                coordinate(bounds[key], element.ownerDocument)
            ])
        );
    }
    function viewport(view) {
        return {
            width: coordinate(view.innerWidth, view.document),
            height: coordinate(view.innerHeight, view.document)
        };
    }
    function point(event, element) {
        const bounds = rect(element);
        return {
            x: coordinate(event.clientX, element.ownerDocument) - bounds.left,
            y: coordinate(event.clientY, element.ownerDocument) - bounds.top
        };
    }
    function constrainPopup(popup, margin = 8) {
        popup.style.removeProperty("transform");
        const bounds = rect(popup);
        const shift = Math.max(
            margin - bounds.left,
            Math.min(0, viewport(popup.ownerDocument.defaultView).width - margin - bounds.right)
        );
        if (shift) popup.style.transform = "translateX(" + shift + "px)";
    }
    function resizeHandle(handle, box, savedHeight, save) {
        const doc = box.ownerDocument;
        if (Number.isFinite(savedHeight) && savedHeight >= 80) box.style.height = savedHeight + "px";
        handle.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            const startY = coordinate(event.clientY, doc),
                startHeight = rect(box).height;
            handle.classList.add("dragging");
            handle.setPointerCapture(event.pointerId);
            const move = (next) => {
                const max = Math.max(120, viewport(doc.defaultView).height * 0.7);
                box.style.height =
                    Math.min(max, Math.max(80, startHeight + coordinate(next.clientY, doc) - startY)) + "px";
            };
            const end = (next) => {
                handle.classList.remove("dragging");
                handle.releasePointerCapture(next.pointerId);
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
                save(Math.round(rect(box).height));
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        });
    }
    function create({ target, api, state, saved, save, changed = () => {} }) {
        const doc = target.document;
        const factor = typeof saved === "number" && Number.isFinite(saved) ? Math.max(0.5, Math.min(2, saved)) : 1;
        const zoom = (state.pageZoom = { factor, enabled: false, delta: 0 });
        const isMac = /Mac/i.test(target.navigator.platform);
        function apply() {
            doc.documentElement.style.zoom = String(zoom.factor);
            const size = viewport(target);
            doc.documentElement.style.height = size.height + "px";
            doc.documentElement.style.setProperty("--emberprobe-vh", size.height / 100 + "px");
            doc.documentElement.style.setProperty("--emberprobe-vw", size.width / 100 + "px");
            changed();
        }
        const receive = (event) => {
            if (event.data?.type !== "webviewSettings") return;
            zoom.enabled = event.data.mouseWheelZoom === true;
            zoom.delta = 0;
        };
        const wheel = (event) => {
            if (
                !zoom.enabled ||
                !(event.ctrlKey || (isMac && event.metaKey)) ||
                event.altKey ||
                event.shiftKey ||
                !Number.isFinite(event.deltaY) ||
                event.deltaY === 0
            ) {
                zoom.delta = 0;
                return;
            }
            // Capture before waveform/slider handlers so a zoom gesture cannot change data or axis ranges.
            event.preventDefault();
            event.stopImmediatePropagation();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
            const delta = event.deltaY * unit;
            if (Math.sign(delta) !== Math.sign(zoom.delta)) zoom.delta = 0;
            zoom.delta += delta;
            if (Math.abs(zoom.delta) < 50) return;
            const next = Math.max(0.5, Math.min(2, Math.round((zoom.factor - Math.sign(zoom.delta) * 0.1) * 10) / 10));
            zoom.delta = 0;
            if (next === zoom.factor) return;
            zoom.factor = next;
            apply();
            save(next);
        };
        apply();
        target.addEventListener("message", receive);
        target.addEventListener("resize", apply);
        target.addEventListener("wheel", wheel, { capture: true, passive: false });
        const refresh = () => api?.postMessage({ type: "getWebviewSettings" });
        target.addEventListener("focus", refresh);
        refresh();
        return () => {
            target.removeEventListener("message", receive);
            target.removeEventListener("resize", apply);
            target.removeEventListener("wheel", wheel, true);
            target.removeEventListener("focus", refresh);
        };
    }
    return { create, scale, coordinate, rect, viewport, point, constrainPopup, resizeHandle };
});
