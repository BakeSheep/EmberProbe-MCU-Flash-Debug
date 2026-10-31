"use strict";
// Value display shared by the sidebar and live watch pages. Each page passes an adapter for what
// differs between them: its symbol table, its latest readings and, on the chart, number bases.
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const valueTree = factory(commonJs ? require("./runtime") : root.EmberProbeRuntime);
    if (commonJs) module.exports = valueTree;
    else root.EmberProbeValueTree = valueTree;
})(typeof globalThis === "object" ? globalThis : this, function (runtime) {
    function fmtNum(v) {
        if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
        v = Number(v);
        if (Number.isInteger(v)) return String(v);
        const a = Math.abs(v);
        return a !== 0 && (a >= 1e7 || a < 1e-4) ? v.toExponential(4) : String(Number(v.toFixed(5)));
    }
    // A radix of 16 or 2 shows the number with a 0x/0b prefix; anything else shows it as read.
    function fmtExact(value, valueText, enumText, radix) {
        if (radix === 16 || radix === 2) {
            // Keep exact 64-bit readings out of Number; fractional values use numerical base conversion.
            const number =
                valueText != null && /^-?\d{1,20}$/.test(String(valueText))
                    ? BigInt(valueText)
                    : value != null && Number.isFinite(value)
                      ? value
                      : null;
            if (number !== null) {
                const negative = number < 0;
                const digits = (negative ? -number : number).toString(radix).toUpperCase();
                return (negative ? "-" : "") + (radix === 16 ? "0x" : "0b") + digits;
            }
        }
        if (enumText) return String(enumText);
        return valueText !== null && valueText !== undefined ? String(valueText) : fmtNum(value);
    }

    // `page` supplies:
    //   t(key, params)        translation
    //   symbol(name)          the ELF symbol listed under `name`
    //   layoutSymbol(path)    the symbol or watch whose layout describes `path`
    //   reading(name)         { value, valueText, enumText, pointer } last sampled for a scalar watch
    //   lastPointers()        pointer targets remembered from earlier sessions, by path
    //   radix(name)           optional number base for `name`
    function create(page) {
        const radix = page.radix || (() => 10);
        // Pointer metadata for a scalar watch; the layout walk runs once per render, not per refresh.
        let displayInfos = new WeakMap();

        function formatNode(node, name) {
            if (node?.functionEmpty) return page.t("lw.functionEmpty");
            if (node?.isPointer) return runtime.pointerLabel(node, page.t);
            return node ? fmtExact(node.value, node.valueText, node.enumText, radix(name)) : "—";
        }
        function resolveDisplayInfo(item) {
            if (item.isPointer) return item;
            const direct = page.symbol(item.name);
            if (direct?.isPointer) return direct;
            const symbol = page.layoutSymbol(item.name);
            return (
                runtime
                    .displayLayoutLeaves(
                        symbol,
                        symbol?.compositeLayout,
                        runtime.variableBaseName(item.name),
                        symbol?.address,
                        { showRaw: true, includePointers: true }
                    )
                    .find((leaf) => leaf.path === item.name) || item
            );
        }
        function displayInfo(item) {
            if (!displayInfos.has(item)) displayInfos.set(item, resolveDisplayInfo(item));
            return displayInfos.get(item);
        }
        function scalarDisplay(item) {
            const info = displayInfo(item);
            const reading = page.reading(item.name);
            // Before the first sample a pointer shows the target it had when last sampled.
            const last = info.isPointer && reading.value === undefined && page.lastPointers()[item.name];
            if (last) return formatNode({ ...info, ...last, stale: true }, item.name);
            return formatNode(
                {
                    ...info,
                    ...reading.pointer,
                    value: reading.value,
                    valueText: reading.valueText,
                    enumText: reading.enumText
                },
                item.name
            );
        }
        return {
            formatNode,
            displayInfo,
            scalarDisplay,
            resetDisplayInfos() {
                displayInfos = new WeakMap();
            }
        };
    }

    return { fmtNum, fmtExact, create };
});
