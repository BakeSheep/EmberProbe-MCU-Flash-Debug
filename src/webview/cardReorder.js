"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeCardReorder = factory();
})(globalThis, function () {
    const DRAG_THRESHOLD_PX = 3;
    const EDGE_SCROLL_PX = 24;
    const EDGE_SCROLL_STEP = 8;
    const FOCUS_RESTORE_MS = 2000;

    // Moves `name` and its attached entries (members, pointees) as one block before or after `targetName`.
    // Returns the original array when nothing moves so callers can skip saving.
    function moveBlock(list, name, targetName, after, isAttached) {
        if (!Array.isArray(list) || name === targetName) return list;
        const inBlock = (entry) => entry.name === name || (!!isAttached && isAttached(entry, name));
        if (!list.some((entry) => entry.name === name)) return list;
        const block = list.filter(inBlock);
        const rest = list.filter((entry) => !inBlock(entry));
        const target = rest.findIndex((entry) => entry.name === targetName);
        if (target < 0) return list;
        // Dropping after a card also steps over the attached entries that directly follow it.
        let at = target + (after ? 1 : 0);
        while (after && at < rest.length && isAttached && isAttached(rest[at], targetName)) at++;
        const next = rest.slice(0, at).concat(block, rest.slice(at));
        return next.every((entry, index) => entry === list[index]) ? list : next;
    }

    function createHandle(doc, label) {
        const handle = doc.createElement("button");
        handle.type = "button";
        handle.className = "reorder-handle";
        handle.title = label;
        handle.setAttribute("aria-label", label);
        return handle;
    }

    function decorate(card, name, label) {
        card.dataset.reorderKey = name;
        card.classList.add("reorderable");
        card.prepend(createHandle(card.ownerDocument, label));
    }

    function scrollParent(element) {
        const view = element.ownerDocument.defaultView;
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            const overflow = view.getComputedStyle(node).overflowY;
            if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
        }
        return element.ownerDocument.scrollingElement || element.ownerDocument.documentElement;
    }

    // Pointer and keyboard reordering for the cards inside a container that outlives re-renders.
    // Cards are found by `data-reorder-key`; the caller rearranges its list and re-renders in onMove.
    function attach(container, options) {
        const doc = container.ownerDocument;
        const view = doc.defaultView;
        const order = options.order || (() => cards().map((card) => card.dataset.reorderKey));
        let drag = null;
        let focusKey = null;
        let focusAt = 0;
        let scrollFrame = null;

        function cards() {
            return Array.from(container.querySelectorAll("[data-reorder-key]"));
        }
        function cardFor(name) {
            return cards().find((card) => card.dataset.reorderKey === name) || null;
        }
        function clearMarks() {
            container
                .querySelectorAll(".reorder-dragging, .reorder-drop-before, .reorder-drop-after")
                .forEach((card) =>
                    card.classList.remove("reorder-dragging", "reorder-drop-before", "reorder-drop-after")
                );
            container.classList.remove("reorder-active");
        }
        function applyMarks() {
            clearMarks();
            if (!drag || !drag.active) return;
            container.classList.add("reorder-active");
            cardFor(drag.name)?.classList.add("reorder-dragging");
            if (drag.target)
                cardFor(drag.target.name)?.classList.add(
                    drag.target.after ? "reorder-drop-after" : "reorder-drop-before"
                );
        }
        function hitTarget(x, y) {
            let best = null;
            for (const card of cards()) {
                const rect = card.getBoundingClientRect();
                if (!rect.width && !rect.height) continue;
                const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
                const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
                const distance = dx * 1000 + dy;
                if (!best || distance < best.distance) best = { card, rect, distance };
            }
            if (!best) return null;
            const name = best.card.dataset.reorderKey;
            if (name === drag.name) return null;
            return { name, after: y > best.rect.top + best.rect.height / 2 };
        }
        function stopScroll() {
            if (scrollFrame !== null && view.cancelAnimationFrame) view.cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
        }
        function edgeScroll() {
            scrollFrame = null;
            if (!drag || !drag.active || !view.requestAnimationFrame) return;
            const scroller = scrollParent(container);
            const rect =
                scroller === doc.scrollingElement || scroller === doc.documentElement
                    ? { top: 0, bottom: view.innerHeight }
                    : scroller.getBoundingClientRect();
            const step =
                drag.y < rect.top + EDGE_SCROLL_PX
                    ? -EDGE_SCROLL_STEP
                    : drag.y > rect.bottom - EDGE_SCROLL_PX
                      ? EDGE_SCROLL_STEP
                      : 0;
            if (!step) return;
            const before = scroller.scrollTop;
            scroller.scrollTop += step;
            if (scroller.scrollTop === before) return;
            drag.target = hitTarget(drag.x, drag.y);
            applyMarks();
            scrollFrame = view.requestAnimationFrame(edgeScroll);
        }
        function finish(commit) {
            const done = drag;
            drag = null;
            stopScroll();
            doc.removeEventListener("keydown", onEscape, true);
            clearMarks();
            if (done && container.hasPointerCapture?.(done.pointerId)) container.releasePointerCapture(done.pointerId);
            if (commit && done && done.active && done.target)
                options.onMove(done.name, done.target.name, done.target.after);
        }
        function onEscape(event) {
            if (event.key !== "Escape" || !drag) return;
            event.preventDefault();
            event.stopPropagation();
            finish(false);
        }

        container.addEventListener("pointerdown", (event) => {
            const handle = event.target.closest?.(".reorder-handle");
            if (!handle || !container.contains(handle) || event.button !== 0 || drag) return;
            const card = handle.closest("[data-reorder-key]");
            if (!card) return;
            event.preventDefault();
            drag = {
                name: card.dataset.reorderKey,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                x: event.clientX,
                y: event.clientY,
                active: false,
                target: null
            };
            // Capture on the persistent container so sampling re-renders never drop the drag.
            if (container.setPointerCapture && event.pointerId !== undefined) {
                try {
                    container.setPointerCapture(event.pointerId);
                } catch {
                    // Synthetic pointers have no capture target; window listeners still track them.
                }
            }
            doc.addEventListener("keydown", onEscape, true);
        });
        view.addEventListener("pointermove", (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag.x = event.clientX;
            drag.y = event.clientY;
            if (
                !drag.active &&
                Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX
            )
                return;
            drag.active = true;
            event.preventDefault();
            drag.target = hitTarget(event.clientX, event.clientY);
            applyMarks();
            if (scrollFrame === null) edgeScroll();
        });
        view.addEventListener("pointerup", (event) => {
            if (drag && event.pointerId === drag.pointerId) finish(true);
        });
        view.addEventListener("pointercancel", (event) => {
            if (drag && event.pointerId === drag.pointerId) finish(false);
        });
        container.addEventListener("lostpointercapture", (event) => {
            if (drag && event.pointerId === drag.pointerId) finish(false);
        });
        container.addEventListener("keydown", (event) => {
            const handle = event.target.closest?.(".reorder-handle");
            if (!handle || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            const name = handle.closest("[data-reorder-key]")?.dataset.reorderKey;
            const keys = order();
            const index = keys.indexOf(name);
            const down = event.key === "ArrowDown";
            const target = keys[index + (down ? 1 : -1)];
            event.preventDefault();
            event.stopPropagation();
            if (index < 0 || target === undefined) return;
            focusKey = name;
            focusAt = Date.now();
            options.onMove(name, target, down);
            refresh();
        });

        // Called after every re-render: keeps drag marks and returns keyboard focus to the moved card.
        function refresh() {
            applyMarks();
            if (!focusKey) return;
            if (Date.now() - focusAt > FOCUS_RESTORE_MS) {
                focusKey = null;
                return;
            }
            const active = doc.activeElement;
            const handle = cardFor(focusKey)?.querySelector(".reorder-handle");
            // The host may echo the saved list and re-render again; focus stays with the moved card until it leaves.
            if (active && active !== doc.body && active.isConnected) {
                if (active !== handle) focusKey = null;
                return;
            }
            handle?.focus();
        }

        return { refresh, cancel: () => finish(false) };
    }

    return { moveBlock, decorate, attach };
});
