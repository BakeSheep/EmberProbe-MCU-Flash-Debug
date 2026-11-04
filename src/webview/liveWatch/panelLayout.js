"use strict";
// Value panel of the live watch page: a docked sidebar beside the chart (resized by its splitter, collapsible), or a
// card floating over the chart that is moved by its title bar and resized by its edges. The geometry is saved with
// the page state.
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const panelLayout = factory(
        commonJs ? require("../cardReorder") : root.EmberProbeCardReorder,
        commonJs ? require("../pageZoom") : root.EmberProbePageZoom
    );
    if (commonJs) module.exports = panelLayout;
    else root.EmberProbePanelLayout = panelLayout;
})(typeof globalThis === "object" ? globalThis : this, function (cardReorder, pageZoom) {
    const PANEL_MARGIN = 8,
        PANEL_MIN_WIDTH = 220,
        PANEL_MIN_HEIGHT = 120;
    // Saved floating-card geometry, or a default top-left card.
    function savedValuePanel(ui) {
        const p = ui && ui.valuePanel;
        if (p && ["x", "y", "w"].every((key) => Number.isFinite(p[key])) && (p.h === null || Number.isFinite(p.h)))
            return {
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
                dockRight: p.dockRight === true,
                dockBottom: p.dockBottom === true
            };
        return { x: 12, y: 40, w: 300, h: null, dockRight: false, dockBottom: false };
    }
    function clampNumber(value, min, max) {
        return Math.min(Math.max(value, min), Math.max(min, max));
    }
    function px(value) {
        return parseFloat(value) || 0;
    }
    function movedPanel(start, dx, dy) {
        return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
    }

    // page: { $, t, saved (page state), save(), arrange() to lay out the cards again, changed() to repaint the chart }
    function create(page) {
        const { $, t, saved } = page;
        let sideWidth = (saved && Number(saved.sideWidth)) || 260,
            sideHeight = saved && Number.isFinite(saved.sideHeight) ? Math.max(100, saved.sideHeight) : null,
            // The value panel is a docked sidebar by default, or a card floating over the chart.
            panelMode = saved && saved.panelMode === "floating" ? "floating" : "docked",
            valuePanel = savedValuePanel(saved),
            sideCollapsed = !!(saved && saved.sideCollapsed);
        const layout = $("layout"),
            valuePane = $("valuePane"),
            sideSplitter = $("sideSplitter"),
            sideToggle = $("sideToggle"),
            panelHandle = $("panelHandle");
        function panelFloating() {
            return panelMode === "floating";
        }
        // The card stays wide enough for its title bar and curve buttons on one line each; their localized
        // labels set the width. The sample rate truncates with an ellipsis instead of widening the card.
        // Conditionally hidden buttons (restore) are measured too, so the card does not widen when they appear.
        function panelMinWidth() {
            const rows = [panelHandle, valuePane.querySelector(".side-curve-tools")].filter(Boolean),
                hiddenChildren = rows.flatMap(function (row) {
                    return Array.from(row.children).filter(function (child) {
                        return child.hidden;
                    });
                });
            hiddenChildren.forEach(function (child) {
                child.hidden = false;
            });
            const content = rows.reduce(function (widest, row) {
                const style = getComputedStyle(row),
                    children = Array.from(row.children).filter(function (child) {
                        return child.id !== "rate" && pageZoom.rect(child).width > 0;
                    });
                let width =
                    px(style.paddingLeft) +
                    px(style.paddingRight) +
                    px(style.columnGap) * Math.max(0, children.length - 1);
                children.forEach(function (child) {
                    const childStyle = getComputedStyle(child);
                    width += pageZoom.rect(child).width + px(childStyle.marginLeft) + px(childStyle.marginRight);
                });
                return Math.max(widest, width);
            }, 0);
            hiddenChildren.forEach(function (child) {
                child.hidden = true;
            });
            const pane = getComputedStyle(valuePane);
            return Math.max(PANEL_MIN_WIDTH, Math.ceil(content + px(pane.borderLeftWidth) + px(pane.borderRightWidth)));
        }
        // The card keeps its preferred geometry; smaller views shrink and shift it without losing that preference.
        function panelGeometry(bounds) {
            const height = valuePanel.h === null ? Math.min(Math.round(bounds.height * 0.6), 460) : valuePanel.h;
            const w = clampNumber(valuePanel.w, panelMinWidth(), bounds.width - 2 * PANEL_MARGIN);
            const h = clampNumber(height, PANEL_MIN_HEIGHT, bounds.height - 2 * PANEL_MARGIN);
            const x = valuePanel.dockRight ? bounds.width - PANEL_MARGIN - w : valuePanel.x;
            const y = valuePanel.dockBottom ? bounds.height - PANEL_MARGIN - h : valuePanel.y;
            return {
                x: Math.round(clampNumber(x, PANEL_MARGIN, bounds.width - PANEL_MARGIN - w)),
                y: Math.round(clampNumber(y, PANEL_MARGIN, bounds.height - PANEL_MARGIN - h)),
                w: Math.round(w),
                h: Math.round(h)
            };
        }
        // Inline geometry only applies to the floating card; the docked sidebar is sized by the grid.
        function applyPanelGeometry() {
            if (!panelFloating()) {
                ["left", "top", "width", "height"].forEach(function (name) {
                    valuePane.style.removeProperty(name);
                });
                return;
            }
            const bounds = pageZoom.rect(layout);
            if (!bounds.width || !bounds.height) return;
            const g = panelGeometry(bounds);
            valuePane.style.left = g.x + "px";
            valuePane.style.top = g.y + "px";
            valuePane.style.width = g.w + "px";
            valuePane.style.height = g.h + "px";
        }
        // Cards moved against the right or bottom edge stay docked there when the view is resized.
        function setPanelGeometry(g, bounds) {
            const x = Math.round(clampNumber(g.x, PANEL_MARGIN, bounds.width - PANEL_MARGIN - g.w)),
                y = Math.round(clampNumber(g.y, PANEL_MARGIN, bounds.height - PANEL_MARGIN - g.h)),
                right = bounds.width - PANEL_MARGIN - x - g.w,
                bottom = bounds.height - PANEL_MARGIN - y - g.h;
            valuePanel = {
                x: x,
                y: y,
                w: Math.round(g.w),
                h: Math.round(g.h),
                dockRight: right <= 1 && x > PANEL_MARGIN + 1,
                dockBottom: bottom <= 1 && y > PANEL_MARGIN + 1
            };
            applyPanelGeometry();
            page.arrange();
        }
        // Dragging a north or west edge keeps the opposite edge where it was.
        function resizedPanel(start, edge, dx, dy, bounds) {
            const g = { x: start.x, y: start.y, w: start.w, h: start.h },
                minWidth = panelMinWidth();
            if (edge.indexOf("e") >= 0)
                g.w = clampNumber(start.w + dx, minWidth, bounds.width - PANEL_MARGIN - start.x);
            if (edge.indexOf("s") >= 0)
                g.h = clampNumber(start.h + dy, PANEL_MIN_HEIGHT, bounds.height - PANEL_MARGIN - start.y);
            if (edge.indexOf("w") >= 0) {
                g.w = clampNumber(start.w - dx, minWidth, start.x + start.w - PANEL_MARGIN);
                g.x = start.x + start.w - g.w;
            }
            if (edge.indexOf("n") >= 0) {
                g.h = clampNumber(start.h - dy, PANEL_MIN_HEIGHT, start.y + start.h - PANEL_MARGIN);
                g.y = start.y + start.h - g.h;
            }
            return g;
        }
        function apply() {
            const floating = panelFloating();
            layout.style.setProperty("--side-width", sideWidth + "px");
            if (sideHeight !== null) layout.style.setProperty("--side-height", sideHeight + "px");
            layout.classList.toggle("side-collapsed", sideCollapsed);
            layout.classList.toggle("panel-floating", floating);
            sideToggle.setAttribute("aria-expanded", String(!sideCollapsed));
            sideToggle.setAttribute("aria-controls", "vars");
            sideToggle.setAttribute("aria-label", sideCollapsed ? t("lw.expandPane") : t("lw.collapsePane"));
            sideToggle.textContent = (sideCollapsed ? "› " : "‹ ") + t("lw.valuePane");
            sideToggle.title = sideCollapsed ? t("lw.expandPane") : t("lw.collapsePane");
            const mode = $("panelMode");
            mode.title = t(floating ? "lw.panelDock" : "lw.panelFloat");
            mode.setAttribute("aria-label", mode.title);
            mode.setAttribute("aria-pressed", String(floating));
            $("panelClose").title = t("lw.panelClose");
            $("panelClose").setAttribute("aria-label", t("lw.panelClose"));
            // Only the floating card is moved by its title bar.
            panelHandle.tabIndex = floating ? 0 : -1;
            panelHandle.title = floating ? t("lw.panelMoveHint") : "";
            if (floating) panelHandle.setAttribute("aria-label", t("lw.panelMoveHint"));
            else panelHandle.removeAttribute("aria-label");
            $("panelResize").setAttribute("aria-label", t("lw.panelResizeHint"));
            applyPanelGeometry();
            updateSplitter();
            page.arrange();
            page.changed();
        }
        function updateSplitter() {
            const stacked = pageZoom.viewport(window).width <= 760;
            const bounds = pageZoom.rect(layout);
            const pane = pageZoom.rect(valuePane);
            sideSplitter.setAttribute("aria-label", t("lw.splitterHint"));
            sideSplitter.setAttribute("aria-orientation", stacked ? "horizontal" : "vertical");
            sideSplitter.setAttribute("aria-valuemin", stacked ? "100" : "220");
            sideSplitter.setAttribute(
                "aria-valuemax",
                String(Math.round(Math.max(stacked ? 100 : 220, stacked ? bounds.height - 169 : bounds.width - 300)))
            );
            sideSplitter.setAttribute("aria-valuenow", String(Math.round(stacked ? pane.height : pane.width)));
            sideSplitter.tabIndex = sideCollapsed || panelFloating() ? -1 : 0;
        }
        function resizeSide(size, stacked) {
            const bounds = pageZoom.rect(layout);
            const min = stacked ? 100 : 220;
            const max = Math.max(min, stacked ? bounds.height - 169 : bounds.width - 300);
            size = Math.round(Math.min(max, Math.max(min, size)));
            if (stacked) {
                sideHeight = size;
                layout.style.setProperty("--side-height", size + "px");
            } else {
                sideWidth = size;
                layout.style.setProperty("--side-width", size + "px");
            }
            updateSplitter();
            page.changed();
        }
        // Follows one pointer on a handle until it is released, then saves the result.
        function trackPointer(target, e, onMove, onEnd) {
            target.setPointerCapture(e.pointerId);
            const move = function (ev) {
                if (cardReorder.samePointer(ev, e)) onMove(ev);
            };
            const end = function (ev) {
                if (ev.pointerId !== e.pointerId) return;
                onEnd();
                target.removeEventListener("pointermove", move);
                target.removeEventListener("pointerup", end);
                target.removeEventListener("pointercancel", end);
                target.removeEventListener("lostpointercapture", end);
                if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
                page.save();
            };
            target.addEventListener("pointermove", move);
            target.addEventListener("pointerup", end);
            target.addEventListener("pointercancel", end);
            target.addEventListener("lostpointercapture", end);
        }
        function trackPanelPointer(target, e, update) {
            if (e.button !== 0 || !panelFloating()) return;
            e.preventDefault();
            const bounds = pageZoom.rect(layout),
                start = panelGeometry(bounds),
                startX = pageZoom.coordinate(e.clientX, document),
                startY = pageZoom.coordinate(e.clientY, document);
            valuePane.classList.add("dragging");
            target.classList.add("active");
            trackPointer(
                target,
                e,
                function (ev) {
                    setPanelGeometry(
                        update(
                            start,
                            pageZoom.coordinate(ev.clientX, document) - startX,
                            pageZoom.coordinate(ev.clientY, document) - startY,
                            bounds
                        ),
                        bounds
                    );
                },
                function () {
                    valuePane.classList.remove("dragging");
                    target.classList.remove("active");
                }
            );
        }
        function nudgePanel(e, update) {
            const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!step || !panelFloating()) return;
            e.preventDefault();
            const bounds = pageZoom.rect(layout),
                size = e.shiftKey ? 50 : 10;
            setPanelGeometry(update(panelGeometry(bounds), step[0] * size, step[1] * size, bounds), bounds);
            page.save();
        }
        sideToggle.onclick = function () {
            sideCollapsed = !sideCollapsed;
            apply();
            page.save();
        };
        $("panelMode").onclick = function () {
            panelMode = panelFloating() ? "docked" : "floating";
            apply();
            page.save();
        };
        // Closing hides the panel like the toolbar toggle, which then takes focus so it can reopen it.
        $("panelClose").onclick = function () {
            sideCollapsed = true;
            apply();
            page.save();
            sideToggle.focus();
        };
        sideSplitter.addEventListener("pointerdown", function (e) {
            if (e.button !== 0) return;
            const stacked = pageZoom.viewport(window).width <= 760;
            e.preventDefault();
            if (sideCollapsed) {
                sideCollapsed = false;
                apply();
            }
            const start = stacked ? pageZoom.coordinate(e.clientY, document) : pageZoom.coordinate(e.clientX, document),
                bounds = pageZoom.rect(valuePane),
                startSize = stacked ? bounds.height : bounds.width;
            sideSplitter.classList.add("dragging");
            trackPointer(
                sideSplitter,
                e,
                function (ev) {
                    resizeSide(
                        startSize +
                            (stacked
                                ? pageZoom.coordinate(ev.clientY, document)
                                : pageZoom.coordinate(ev.clientX, document)) -
                            start,
                        stacked
                    );
                },
                function () {
                    sideSplitter.classList.remove("dragging");
                }
            );
        });
        sideSplitter.addEventListener("keydown", function (e) {
            const stacked = pageZoom.viewport(window).width <= 760;
            const direction = stacked ? { ArrowUp: -1, ArrowDown: 1 }[e.key] : { ArrowLeft: -1, ArrowRight: 1 }[e.key];
            if (!direction) return;
            e.preventDefault();
            const bounds = pageZoom.rect(valuePane);
            resizeSide((stacked ? bounds.height : bounds.width) + direction * (e.shiftKey ? 50 : 10), stacked);
            page.save();
        });
        // The title bar buttons keep their own clicks and keys.
        panelHandle.addEventListener("pointerdown", function (e) {
            if (!e.target.closest("button")) trackPanelPointer(panelHandle, e, movedPanel);
        });
        panelHandle.addEventListener("keydown", function (e) {
            if (e.target === panelHandle) nudgePanel(e, movedPanel);
        });
        valuePane.querySelectorAll(".float-resize").forEach(function (handle) {
            const resize = function (start, dx, dy, bounds) {
                return resizedPanel(start, handle.dataset.edge, dx, dy, bounds);
            };
            handle.addEventListener("pointerdown", function (e) {
                trackPanelPointer(handle, e, resize);
            });
            handle.addEventListener("keydown", function (e) {
                nudgePanel(e, resize);
            });
        });
        new ResizeObserver(function () {
            updateSplitter();
            applyPanelGeometry();
            page.arrange();
        }).observe(layout);
        new ResizeObserver(function () {
            page.arrange();
        }).observe(valuePane);
        window.addEventListener("resize", function () {
            applyPanelGeometry();
            page.arrange();
        });
        return {
            apply,
            // Shows a collapsed panel again.
            expand() {
                sideCollapsed = false;
                apply();
            },
            get collapsed() {
                return sideCollapsed;
            },
            saved() {
                return { sideWidth, sideHeight, panelMode, valuePanel, sideCollapsed };
            }
        };
    }
    return { create };
});
