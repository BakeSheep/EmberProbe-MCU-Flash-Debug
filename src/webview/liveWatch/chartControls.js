"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports)
        module.exports = factory(
            require("../pageZoom"),
            require("./seriesGain"),
            require("./analysisState"),
            require("../valueTree")
        );
    else
        root.EmberProbeChartControls = factory(
            root.EmberProbePageZoom,
            root.EmberProbeSeriesGain,
            root.EmberProbeAnalysisState,
            root.EmberProbeValueTree
        );
})(globalThis, function (pageZoom, Gain, Analysis, values) {
    function createActions(env) {
        const {
            state,
            chartState,
            analysis,
            gain,
            post,
            renderVars,
            saveUi,
            updateValues,
            saveWatch,
            removeVar,
            types
        } = env;
        return function (action, value) {
            if (action === "importSidebar") {
                post({ type: "importSidebarWatch", items: state.watch });
                return;
            }
            const names = state.watch.map((item) => item.name);
            if (action === "showAll" || action === "hideAll") {
                state.hidden = Object.fromEntries(names.map((name) => [name, action === "hideAll"]));
                analysis.previousHidden = null;
                analysis.focused = null;
                renderVars();
                saveUi();
            }
            if (action === "restore" || action === "focus") {
                state.hidden =
                    action === "restore"
                        ? Analysis.restore(analysis, names)
                        : Analysis.focus(analysis, state.hidden, names, value);
                renderVars();
                saveUi();
            }
            if (action === "hover") {
                chartState.hoverName = value;
                chartState.pointer = null;
                chartState.hits = [];
            }
            if (action === "style") {
                state.seriesStyles[value.name] = value.style;
                post({ type: "setSeriesStyle", ...value });
                renderVars();
            }
            if (action === "type") {
                const item = state.watch.find((entry) => entry.name === value.name);
                if (item && !values.isComposite(item) && types.includes(value.type)) {
                    item.type = value.type;
                    state.latest[item.name] = null;
                    state.latestText[item.name] = null;
                    state.latestEnum[item.name] = null;
                    updateValues();
                    saveWatch();
                }
            }
            if (action === "radix") {
                const item = state.watch.find((entry) => entry.name === value.name);
                if (!item || values.isComposite(item) || ![2, 10, 16].includes(value.radix)) return;
                if (value.radix === 10) delete state.numberBases[value.name];
                else state.numberBases[value.name] = value.radix;
                updateValues();
                saveUi();
            }
            if (action === "gain") {
                if (!gain.set(value.name, value.gain)) return;
                chartState.prepared = chartState.curveGeometry = chartState.rangeStats = null;
                chartState.hits = [];
                updateValues();
            }
            if (action === "remove") removeVar(value);
            if (action === "fitY") env.viewportController?.fit(value.mode, value.automatic);
            if (action === "undoView") env.viewportController?.undo();
            chartState.fastDirty = true;
            state.dirty = true;
        };
    }
    function yModeKey(chart) {
        return !chart.autoY ? "lw.yManual" : chart.fitMode === "center" ? "lw.yAutoCenter" : "lw.yAutoFill";
    }
    function createFitControl(env) {
        const { document: doc, t, change, get, button } = env;
        const win = doc.defaultView;
        const clock = env.clock || {
            now: () => win.performance.now(),
            schedule: (fn, delay) => win.setTimeout(fn, delay),
            cancel: (timer) => win.clearTimeout(timer)
        };
        const chart = get().chart;
        const group = doc.createElement("div");
        group.className = "chart-fit-control";
        doc.getElementById("chartTimeline").after(group);
        const main = button("chartFit", "lw.fitYMenu", null, group);
        main.onclick = (event) => {
            // Pointer gestures finish on pointerup; keyboard and assistive clicks have no click count.
            if (event.detail === 0 && !chart.fitPress) change("fitY", { mode: "center", automatic: false });
        };
        const toggle = doc.createElement("button");
        toggle.id = "chartFitToggle";
        toggle.type = "button";
        toggle.className = "ghost";
        toggle.textContent = "▴";
        toggle.setAttribute("aria-label", t("lw.fitYOptions"));
        toggle.title = t("lw.fitYOptions");
        toggle.dataset.i18nAria = toggle.dataset.i18nTitle = "lw.fitYOptions";
        toggle.setAttribute("aria-haspopup", "dialog");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-controls", "chartFitMenu");
        group.append(toggle);
        const menu = doc.createElement("div");
        menu.className = "chart-fit-menu hidden";
        menu.id = "chartFitMenu";
        menu.setAttribute("role", "dialog");
        menu.setAttribute("aria-label", t("lw.fitYOptions"));
        doc.body.append(menu);
        function openMenu(open, restoreFocus = false) {
            menu.classList.toggle("hidden", !open);
            toggle.setAttribute("aria-expanded", String(open));
            if (open) {
                const rect = pageZoom.rect(toggle),
                    viewport = pageZoom.viewport(win);
                menu.style.left =
                    Math.max(4, Math.min(rect.right - menu.offsetWidth, viewport.width - menu.offsetWidth - 4)) + "px";
                const above = rect.top - menu.offsetHeight - 4;
                menu.style.top =
                    Math.max(
                        4,
                        above >= 4 ? above : Math.min(rect.bottom + 4, viewport.height - menu.offsetHeight - 4)
                    ) + "px";
                menu.querySelector("button").focus();
            } else if (restoreFocus) toggle.focus();
        }
        for (const [key, mode, automatic] of [
            ["lw.fitCenterOnce", "center", false],
            ["lw.fitFillOnce", "fill", false],
            ["lw.fitCenterAuto", "center", true],
            ["lw.fitFillAuto", "fill", true]
        ]) {
            const option = button(
                "chartFit" + mode + automatic,
                key,
                () => {
                    change("fitY", { mode, automatic });
                    openMenu(false, true);
                },
                menu
            );
            option.dataset.fitMode = mode;
            option.dataset.automatic = String(automatic);
        }
        function cancel(event) {
            const press = chart.fitPress;
            if (!press || (event?.pointerId != null && event.pointerId !== press.pointerId)) return;
            chart.fitPress = null;
            clock.cancel(press.timer);
            main.classList.remove("holding", "held");
            if (main.hasPointerCapture?.(press.pointerId)) main.releasePointerCapture(press.pointerId);
        }
        main.addEventListener("pointerdown", (event) => {
            if (main.disabled || chart.fitPress || event.isPrimary === false || ![0, 2].includes(event.button)) return;
            event.preventDefault();
            main.focus({ preventScroll: true });
            openMenu(false);
            const press = (chart.fitPress = {
                pointerId: event.pointerId,
                button: event.button,
                started: clock.now(),
                x: event.clientX,
                y: event.clientY,
                fired: false
            });
            main.classList.add("holding");
            main.setPointerCapture?.(event.pointerId);
            press.timer = clock.schedule(() => {
                if (chart.fitPress !== press || main.disabled) return;
                press.fired = true;
                main.classList.add("held");
                change("fitY", { mode: "fill", automatic: press.button === 2 });
            }, 500);
        });
        main.addEventListener("pointerup", (event) => {
            const press = chart.fitPress;
            if (!press || press.pointerId !== event.pointerId) return;
            cancel(event);
            if (!main.disabled && !press.fired && event.button === press.button)
                change("fitY", {
                    mode: clock.now() - press.started >= 500 ? "fill" : "center",
                    automatic: press.button === 2
                });
        });
        main.addEventListener("pointermove", (event) => {
            const press = chart.fitPress;
            if (press && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > 6) cancel(event);
        });
        for (const type of ["pointercancel", "lostpointercapture"]) main.addEventListener(type, cancel);
        for (const type of ["contextmenu", "auxclick"]) main.addEventListener(type, (event) => event.preventDefault());
        win.addEventListener("blur", cancel);
        doc.addEventListener("visibilitychange", () => {
            if (doc.hidden) cancel();
        });
        main.addEventListener("keydown", (event) => {
            if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            cancel();
            openMenu(true);
        });
        toggle.onclick = () => {
            cancel();
            openMenu(menu.classList.contains("hidden"));
        };
        doc.addEventListener("pointerdown", (event) => {
            if (!menu.contains(event.target) && !group.contains(event.target)) openMenu(false);
        });
        doc.addEventListener("keydown", (event) => {
            if (menu.classList.contains("hidden")) return;
            if (event.key === "Escape") {
                event.preventDefault();
                openMenu(false, true);
            } else if (menu.contains(event.target) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const buttons = [...menu.querySelectorAll("button")],
                    index = buttons.indexOf(doc.activeElement);
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
                buttons[next].focus();
            }
        });
        doc.addEventListener("focusin", (event) => {
            if (!menu.contains(event.target) && !group.contains(event.target)) openMenu(false);
        });
        return {
            refresh() {
                main.disabled = toggle.disabled = !Number.isFinite(chart.rangeStats?.vMin);
                main.title = t(yModeKey(chart)) + "\n" + t("lw.fitYGestures");
                group.classList.toggle("automatic", !!chart.autoY);
                if (main.disabled) {
                    cancel();
                    openMenu(false);
                }
            }
        };
    }
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
        button("importSidebar", "lw.importSidebar", () => change("importSidebar"));
        const fitControl = createFitControl({ ...env, button });
        button("chartUndo", "lw.undoView", () => change("undoView"), $("freeze").parentNode);
        $("chart")?.setAttribute("aria-label", t("lw.chartNavigation"));
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
        let menuAnchor;
        function close() {
            menu.classList.add("hidden");
        }
        doc.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && !menu.classList.contains("hidden")) {
                close();
                menuAnchor?.focus();
            }
        });
        doc.addEventListener("pointerdown", (e) => {
            if (!menu.contains(e.target) && !e.target.closest(".series-options")) menu.classList.add("hidden");
        });
        function openMenu(name, anchor, point) {
            menuAnchor = anchor;
            menu.textContent = "";
            const title = doc.createElement("strong");
            title.textContent = env.displayName ? env.displayName(name) : name;
            menu.append(title);
            function field(key, ...inputs) {
                const row = doc.createElement("div");
                row.className = "series-menu-row";
                const label = doc.createElement("span");
                label.textContent = t(key);
                row.append(label, ...inputs);
                menu.append(row);
                return row;
            }
            const state = get(),
                style = state.style(name);
            const item = state.watch?.find((entry) => entry.name === name);
            if (item && !item.isComposite) {
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
                field("common.type", type);
                const bases = doc.createElement("div");
                bases.className = "series-radix";
                bases.setAttribute("role", "group");
                bases.setAttribute("aria-label", t("lw.numberBase"));
                [10, 16, 2].forEach((radix, index) => {
                    const b = doc.createElement("button");
                    b.type = "button";
                    b.textContent = ["DEC", "HEX", "BIN"][index];
                    b.dataset.radix = String(radix);
                    b.setAttribute("aria-pressed", String((state.radix?.(name) || 10) === radix));
                    b.onclick = () => {
                        change("radix", { name, radix });
                        bases
                            .querySelectorAll("button")
                            .forEach((option) => option.setAttribute("aria-pressed", String(option === b)));
                    };
                    bases.append(b);
                });
                field("lw.numberBase", bases);
                if (state.gain?.eligible(name))
                    field(
                        "lw.gain",
                        Gain.input(
                            doc,
                            t,
                            () => state.gain.get(name),
                            (gain) => change("gain", { name, gain })
                        )
                    );
            }
            const color = doc.createElement("input");
            color.type = "color";
            color.value = style.color;
            color.setAttribute("aria-label", t("lw.curveColor"));
            const line = doc.createElement("div");
            line.className = "series-line";
            line.setAttribute("role", "group");
            line.setAttribute("aria-label", t("lw.curveLine"));
            let selectedLine = style.line;
            const updateStyle = () => change("style", { name, style: { color: color.value, line: selectedLine } });
            ["solid", "dashed", "dotted"].forEach((value) => {
                const option = doc.createElement("button");
                option.type = "button";
                option.dataset.line = value;
                option.textContent = t("lw.line." + value);
                option.setAttribute("aria-pressed", String(selectedLine === value));
                option.onclick = () => {
                    selectedLine = value;
                    line.querySelectorAll("button").forEach((b) =>
                        b.setAttribute("aria-pressed", String(b === option))
                    );
                    updateStyle();
                };
                line.append(option);
            });
            color.oninput = updateStyle;
            const appearance = doc.createElement("div");
            appearance.className = "series-appearance";
            appearance.append(color, line);
            field("lw.curveStyle", appearance).hidden = !!item?.isComposite;
            const actions = doc.createElement("div");
            actions.className = "series-menu-actions";
            menu.append(actions);
            button(
                "seriesOnly",
                "lw.onlyThis",
                () => {
                    change("focus", name);
                    close();
                },
                actions
            ).hidden = !!item?.isComposite;
            button(
                "seriesRemove",
                "lw.removeWatch",
                () => {
                    change("remove", name);
                    menu.classList.add("hidden");
                },
                actions
            );
            menu.classList.remove("hidden");
            const rect = pageZoom.rect(anchor);
            menu.style.left =
                Math.max(
                    4,
                    Math.min(
                        pageZoom.viewport(doc.defaultView).width - menu.offsetWidth - 4,
                        (point ? pageZoom.coordinate(point.clientX, doc) : undefined) ?? rect.left
                    )
                ) + "px";
            menu.style.top =
                Math.max(
                    4,
                    Math.min(
                        pageZoom.viewport(doc.defaultView).height - menu.offsetHeight - 4,
                        (point ? pageZoom.coordinate(point.clientY, doc) : undefined) ?? rect.bottom
                    )
                ) + "px";
            (menu.querySelector(".series-type") || $("seriesRemove")).focus();
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
                const displayName = env.displayName ? env.displayName(name) : name;
                swatch.setAttribute("aria-label", displayName + ": " + t(off ? "lw.showCurve" : "lw.hideCurve"));
                swatch.textContent = "";
                swatch.style.background = off ? "#808080" : state.style(name).color;
                swatch.style.borderStyle = state.style(name).line === "solid" ? "solid" : "dashed";
            }
        }
        function value(name, point) {
            if (env.formatValue) return env.formatValue(name, point);
            return point ? (point.valueText ?? env.fmtNum(point.v)) : t("lw.noReading");
        }
        let tooltipKey = "";
        function refresh() {
            const s = get(),
                c = s.chart,
                a = s.analysis;
            $("restoreCurves").hidden = !a.previousHidden;
            fitControl.refresh();
            $("chartUndo").disabled = !c.viewHistory?.length || !!(c.drag || c.endpointDrag || c.timelineDrag);
            status.textContent =
                t(
                    s.frozen
                        ? s.running
                            ? "lw.viewFrozenRunning"
                            : "lw.viewFrozen"
                        : c.follow
                          ? "lw.viewFollowing"
                          : "lw.viewHistory"
                ) +
                " · " +
                t(yModeKey(c));
            $("freeze").textContent = t(s.frozen ? "lw.resume" : "lw.freeze");
            const hits = c.hits || [];
            const labels = hits.map((hit) => (env.tooltipName ? env.tooltipName(hit.name) : hit.name));
            const values = hits.map((hit) => value(hit.name, hit.point));
            const key = JSON.stringify([hits, labels, values, hits.map((h) => s.style(h.name)), s.lang]);
            tooltip.classList.toggle("hidden", !hits.length);

            if (key !== tooltipKey) {
                tooltipKey = key;
                tooltip.textContent = "";
                hits.forEach((hit, index) => {
                    const row = doc.createElement("div");
                    row.className = "curve-hit";
                    row.style.borderLeftColor = s.style(hit.name).color;
                    row.textContent = labels[index] + ": " + values[index];
                    row.setAttribute("aria-label", labels[index] + ": " + values[index]);
                    row.dataset.rawName = hit.name;
                    tooltip.append(row);
                });
            }
            const p = c.pointer || { x: 70, y: 20 };
            tooltip.style.left =
                Math.max(4, Math.min($("chartStage").clientWidth - tooltip.offsetWidth - 4, p.x + 16)) + "px";
            tooltip.style.top =
                Math.max(4, Math.min($("chartStage").clientHeight - tooltip.offsetHeight - 4, p.y + 16)) + "px";
            const selected = c.hoverName || (c.pointer ? hits[0]?.name : null);
            doc.querySelectorAll("[data-series-name]").forEach((el) =>
                el.classList.toggle("curve-emphasis", el.dataset.seriesName === selected)
            );
        }
        return { decorate, refresh };
    }
    return { create, createActions };
});
