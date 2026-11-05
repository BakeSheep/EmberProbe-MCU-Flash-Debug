"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("../valueTree"));
    else root.EmberProbeSeriesGain = factory(root.EmberProbeValueTree);
})(globalThis, function (values) {
    function multiply(value, gain) {
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        const result = value * gain;
        return Number.isFinite(result) ? result : null;
    }

    // Keep all settings and projection caches in the page's transient state, never in saveUi().
    function create(state) {
        const gainState = (state.gain = { values: Object.create(null), cache: null });
        function eligible(name) {
            const item = state.watch.find((entry) => entry.name === name);
            return !!(
                item &&
                !item.isComposite &&
                !item.isPointer &&
                !state.symbols.get(name)?.isPointer &&
                /^(?:[ui](?:8|16|32|64)|f(?:32|64))$/.test(item.type)
            );
        }
        const get = (name) => gainState.values[name] ?? 1;
        function set(name, value) {
            if (!eligible(name) || !Number.isFinite(value) || get(name) === value) return false;
            if (value === 1) delete gainState.values[name];
            else gainState.values[name] = value;
            gainState.cache = null;
            return true;
        }
        function forget(name) {
            for (const path of Object.keys(gainState.values)) {
                if (path === name || path.startsWith(name + ".") || path.startsWith(name + "[")) {
                    delete gainState.values[path];
                    gainState.cache = null;
                }
            }
        }
        function format(name, node, radix) {
            const gain = get(name);
            if (gain === 1) return values.fmtExact(node.value, node.valueText, node.enumText, radix);
            const value = multiply(node.value, gain);
            return values.fmtExact(value, null, null, Number.isInteger(value) ? radix : 10);
        }
        // Hit testing uses these display points too, so tooltip values must not be multiplied a second time.
        function formatPoint(name, point, radix) {
            return values.fmtExact(
                point.v,
                point.valueText,
                null,
                get(name) === 1 || Number.isInteger(point.v) ? radix : 10
            );
        }
        function project(series) {
            if (gainState.cache?.source === series) return gainState.cache.series;
            const projected = series.map((part) => {
                const gain = get(part.item.name);
                if (gain === 1 || !eligible(part.item.name)) return part;
                const arr = part.arr.map((point) => ({ ...point, v: multiply(point.v, gain), valueText: undefined }));
                return {
                    ...part,
                    arr,
                    // A raw summary may count readings that overflow only in the display projection.
                    visibleCount: arr.some((point, i) => point.v === null && part.arr[i].v !== null)
                        ? undefined
                        : part.visibleCount
                };
            });
            gainState.cache = { source: series, series: projected };
            return projected;
        }
        return { eligible, get, set, forget, format, formatPoint, project };
    }

    function input(doc, t, get, change) {
        const group = doc.createElement("div");
        group.className = "series-gain";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", t("lw.gain"));
        const field = doc.createElement("input");
        field.className = "series-gain-input";
        field.type = "number";
        field.step = "any";
        field.value = String(get());
        field.setAttribute("aria-label", t("lw.gain"));
        const commit = () => {
            const value = field.value.trim() ? Number(field.value) : NaN;
            if (Number.isFinite(value)) change(value);
        };
        field.oninput = commit;
        field.onblur = () => {
            field.value = String(get());
        };
        field.onkeydown = (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                commit();
                field.value = String(get());
            }
        };
        for (const direction of [-1, 1]) {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "ghost";
            button.textContent = direction < 0 ? "−" : "+";
            button.setAttribute("aria-label", t(direction < 0 ? "lw.gainDecrease" : "lw.gainIncrease"));
            button.onclick = () => {
                // Trim binary rounding noise without rounding directly entered small gains to zero.
                change(Number((get() + direction * 0.1).toPrecision(15)));
                field.value = String(get());
            };
            group.append(button);
            if (direction < 0) group.append(field);
        }
        return group;
    }
    return { create, input };
});
