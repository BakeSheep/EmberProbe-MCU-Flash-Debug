"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeChartControls = factory();
})(globalThis, function () {
    function create(env) {
        const { document: doc, t, change, get } = env;
        const $ = (id) => doc.getElementById(id);
        const toolbar = doc.createElement("div");
        toolbar.className = "chart-tools";
        toolbar.className = "side-curve-tools";
        doc.querySelector(".side-head").after(toolbar);
        function button(id, key, action, parent = toolbar) {
            const b = doc.createElement("button");
            b.id = id;
            b.type = "button";
            b.className = "ghost";
            b.dataset.i18n = key;
            b.textContent = t(key);
            b.onclick = action;
            parent.appendChild(b);
            return b;
        }
        button("showAll", "lw.showAll", () => change("showAll"));
        button("restoreCurves", "lw.restoreCurves", () => change("restore"));
        button("hideAll", "lw.hideAll", () => change("hideAll"));
        button("autoY", "lw.autoY", () => change("autoY"), $("freeze").parentNode);
        const status = doc.createElement("span");
        status.id = "chartViewStatus";
        doc.querySelector(".chart-head").append(status);
        const tooltip = doc.createElement("div");
        tooltip.className = "curve-tooltip hidden";
        tooltip.id = "curveTooltip";
        tooltip.setAttribute("role", "region");
        $("chartStage").append(tooltip);
        const menu = doc.createElement("div");
        menu.className = "series-menu hidden";
        menu.setAttribute("role", "dialog");
        menu.setAttribute("aria-label", t("lw.seriesOptions"));
        doc.body.append(menu);
        function close() {
            menu.classList.add("hidden");
        }
        doc.addEventListener("keydown", (e) => {
            if (e.key === "Escape") close();
        });
        doc.addEventListener("pointerdown", (e) => {
            if (!menu.contains(e.target) && !e.target.closest(".series-options")) menu.classList.add("hidden");
        });
        function openMenu(name, anchor, point) {
            menu.textContent = "";
            const title = doc.createElement("strong");
            title.textContent = name;
            menu.append(title);
            button(
                "seriesOnly",
                "lw.onlyThis",
                () => {
                    change("focus", name);
                    menu.classList.add("hidden");
                },
                menu
            );
            const state = get(),
                style = state.style(name);
            const item = state.watch?.find((entry) => entry.name === name);
            if (item && !item.isComposite) {
                const label = doc.createElement("label");
                label.textContent = t("common.type");
                const type = doc.createElement("select");
                type.className = "series-type";
                type.setAttribute("aria-label", t("common.type"));
                state.types.forEach((value) => {
                    const option = doc.createElement("option");
                    option.value = option.textContent = value;
                    type.append(option);
                });
                type.value = item.type;
                type.onchange = () => change("type", { name, type: type.value });
                label.append(type);
                menu.append(label);
            }
            const color = doc.createElement("input");
            color.type = "color";
            color.value = style.color;
            color.setAttribute("aria-label", t("lw.curveColor"));
            const line = doc.createElement("select");
            line.setAttribute("aria-label", t("lw.curveLine"));
            ["solid", "dashed", "dotted"].forEach((value) => {
                const o = doc.createElement("option");
                o.value = value;
                o.textContent = t("lw.line." + value);
                line.append(o);
            });
            line.value = style.line;
            color.oninput = line.onchange = () =>
                change("style", { name, style: { color: color.value, line: line.value } });
            menu.append(color, line);
            if (item?.isComposite) {
                color.hidden = line.hidden = true;
                $("seriesOnly").hidden = true;
            }
            button(
                "seriesRemove",
                "lw.removeWatch",
                () => {
                    change("remove", name);
                    menu.classList.add("hidden");
                },
                menu
            );
            button(
                "seriesClose",
                "lw.closeInspection",
                () => {
                    menu.classList.add("hidden");
                    anchor.focus();
                },
                menu
            );
            menu.classList.remove("hidden");
            const rect = anchor.getBoundingClientRect();
            menu.style.left =
                Math.max(4, Math.min(doc.documentElement.clientWidth - 245, point?.clientX ?? rect.left)) + "px";
            menu.style.top =
                Math.max(
                    4,
                    Math.min(doc.documentElement.clientHeight - menu.offsetHeight - 4, point?.clientY ?? rect.bottom)
                ) + "px";
            menu.querySelector("button:not([hidden])").focus();
        }
        function decorate(element, name, swatch) {
            element.dataset.seriesName = name;
            element.addEventListener("pointerenter", () => change("hover", name));
            element.addEventListener("pointerleave", () => change("hover", null));
            element.tabIndex = 0;
            element.setAttribute("aria-haspopup", "dialog");
            element.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu(name, element, event);
            });
            element.addEventListener("keydown", (event) => {
                if (event.target !== element) return;
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(name, element);
                }
            });
            if (get().analysis.snapshot && !Object.prototype.hasOwnProperty.call(get().analysis.snapshot, name)) {
                const note = doc.createElement("small");
                note.className = "snapshot-note";
                note.textContent = t("lw.afterResume");
                note.title = t("lw.frozenNew");
                element.append(note);
            }
            if (swatch) {
                const state = get(),
                    off = !!state.hidden[name];
                swatch.setAttribute("aria-pressed", String(!off));
                swatch.setAttribute("aria-label", name + ": " + t(off ? "lw.showCurve" : "lw.hideCurve"));
                swatch.textContent = "";
                swatch.style.background = off ? "#808080" : state.style(name).color;
                swatch.style.borderStyle = state.style(name).line === "solid" ? "solid" : "dashed";
            }
        }
        function value(point) {
            return point ? (point.valueText ?? env.fmtNum(point.v)) : t("lw.noReading");
        }
        let tooltipKey = "";
        function refresh() {
            const s = get(),
                c = s.chart,
                a = s.analysis;
            $("restoreCurves").hidden = !a.previousHidden;
            $("autoY").setAttribute("aria-pressed", String(!!c.autoY));
            status.textContent = t(
                s.frozen
                    ? s.running
                        ? "lw.viewFrozenRunning"
                        : "lw.viewFrozen"
                    : c.follow
                      ? "lw.viewFollowing"
                      : "lw.viewHistory"
            );
            $("freeze").textContent = t(s.frozen ? "lw.resume" : "lw.freeze");
            const hits = c.hits || [];
            const key = JSON.stringify([hits, hits.map((h) => s.style(h.name)), s.lang]);
            tooltip.classList.toggle("hidden", !hits.length);

            if (key !== tooltipKey) {
                tooltipKey = key;
                tooltip.textContent = "";
                hits.forEach((hit) => {
                    const row = doc.createElement("div");
                    row.className = "curve-hit";
                    row.style.borderLeftColor = s.style(hit.name).color;
                    row.textContent = value(hit.point);
                    row.setAttribute("aria-label", hit.name + ": " + value(hit.point));
                    tooltip.append(row);
                });
            }
            const p = c.pointer || { x: 70, y: 20 };
            tooltip.style.left =
                Math.max(4, Math.min($("chartStage").clientWidth - tooltip.offsetWidth - 4, p.x + 16)) + "px";
            tooltip.style.top =
                Math.max(4, Math.min($("chartStage").clientHeight - tooltip.offsetHeight - 4, p.y + 16)) + "px";
            const selected = c.hoverName || hits[0]?.name;
            doc.querySelectorAll("[data-series-name]").forEach((el) =>
                el.classList.toggle("curve-emphasis", el.dataset.seriesName === selected)
            );
        }
        return { decorate, refresh };
    }
    return { create };
});
