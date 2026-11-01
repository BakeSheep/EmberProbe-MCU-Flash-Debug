"use strict";
// ELF variable picker shared by the sidebar variable pane and the live watch import dialog: the user-variable filter,
// name and member search, expandable composites with their member notes, and the row budget. Each page builds its
// own rows (see `render`).
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const symbolPicker = factory(commonJs ? require("./runtime") : root.EmberProbeRuntime);
    if (commonJs) module.exports = symbolPicker;
    else root.EmberProbeSymbolPicker = symbolPicker;
})(typeof globalThis === "object" ? globalThis : this, function (runtime) {
    const VARIABLE_LIMIT = 500;
    const ROW_LIMIT = VARIABLE_LIMIT * 2;
    // Heuristic origin filter; the extension classifies symbols from DWARF source paths, types and names.
    function isUserVariable(symbol) {
        return !symbol.origin || symbol.origin === "user";
    }
    function needsLayout(symbol) {
        return symbol.isComposite && !symbol.compositeLayout && !symbol.runtimeLayout && !symbol.layoutError;
    }

    // page: { t, state, valueTree, layoutExpansion(), displayName(item), symbols() for all ELF symbols, userOnly(),
    // expanded() for open composites by name, pending (Set of requested layouts), typesReady(), post(message) or null
    // without a host, active() while the picker is shown, childrenClass }
    function create(page) {
        const { t, state } = page;
        let searchTimer = null,
            searchQuery = "";
        function pool() {
            const all = page.symbols();
            return page.userOnly() ? all.filter(isUserVariable) : all;
        }
        function requestLayout(symbol) {
            page.pending.add(symbol.name);
            page.post?.({ type: "resolveCompositeLayout", name: symbol.name, version: state.version });
        }
        function cancelSearch() {
            clearTimeout(searchTimer);
            searchTimer = null;
        }
        // Composite layouts load lazily; a member search asks for up to four missing layouts at a time.
        function scheduleSearch(query) {
            const ready = page.typesReady();
            if (query !== searchQuery || !query || !ready) {
                cancelSearch();
                searchQuery = query;
            }
            if (!query || !ready || !page.post || searchTimer !== null) return;
            searchTimer = setTimeout(() => {
                searchTimer = null;
                if (page.active && !page.active()) return;
                const slots = Math.max(0, 4 - page.pending.size);
                pool()
                    .filter((symbol) => needsLayout(symbol) && !page.pending.has(symbol.name))
                    .slice(0, slots)
                    .forEach((symbol) => requestLayout(symbol));
            }, 180);
        }
        function emptyText(query, symbols) {
            const all = page.symbols();
            if (query && (!page.typesReady() || symbols.some(needsLayout))) return t("sb.searchingMembers");
            if (!symbols.length && all.length) return t("sb.noUserVars", { count: all.length });
            return all.length ? t("sb.noMatch") : t("sb.noImportable");
        }
        // rows: { composite(symbol, open, toggle) -> { row, arrow }, leaf(leaf, symbol) -> row, scalar(symbol) -> row }.
        // The composite row wires `toggle` to its arrow and name; the picker adds the member list below it.
        function render(content, query, rows) {
            const symbols = pool(),
                { valueTree } = page;
            scheduleSearch(query);
            const memberMatches = new Map();
            const matching = symbols.filter((symbol) => {
                if (
                    !query ||
                    symbol.name.toLowerCase().includes(query) ||
                    page.displayName(symbol).toLowerCase().includes(query)
                )
                    return true;
                if (!symbol.isComposite) return false;
                const selection = runtime.runtimeSelection(symbol, state.latest[symbol.name]);
                const matches = valueTree
                    .selectionLeaves(symbol, selection)
                    .filter(
                        (leaf) =>
                            leaf.path.toLowerCase().includes(query) ||
                            page.displayName({ name: leaf.path }).toLowerCase().includes(query)
                    );
                if (!matches.length) return false;
                memberMatches.set(symbol.name, matches);
                return true;
            });
            const list = matching.slice(0, VARIABLE_LIMIT);
            let leafRows = 0;
            function composite(symbol) {
                let open = !!page.expanded()[symbol.name] || memberMatches.has(symbol.name),
                    ownLeafRows = 0;
                const kids = document.createElement("div");
                kids.className = page.childrenClass + (open ? " open" : "");
                const clear = () => {
                    leafRows -= ownLeafRows;
                    ownLeafRows = 0;
                    runtime.resetVariableNotices(kids, t);
                    kids.textContent = "";
                };
                const populate = () => {
                    clear();
                    if (!symbol.compositeLayout && !symbol.runtimeLayout) {
                        valueTree.note(
                            kids,
                            symbol.layoutError || symbol.unsupportedReason || t("lw.compositeNoLayout"),
                            "warning"
                        );
                        return;
                    }
                    valueTree.renderRawMembersUi(
                        kids,
                        state.latest[symbol.name] || symbol.compositeLayout,
                        symbol.name
                    );
                    const selection = runtime.runtimeSelection(symbol, state.latest[symbol.name]);
                    const leaves = memberMatches.get(symbol.name) || valueTree.selectionLeaves(symbol, selection);
                    if (selection)
                        valueTree.note(
                            kids,
                            t(
                                selection.sampled
                                    ? "lw.runtimeMembersReadOnly"
                                    : selection.entries.length
                                      ? "lw.runtimeMembersSelectable"
                                      : "lw.runtimeMembersHint"
                            )
                        );
                    if (selection && leaves.some((leaf) => leaf.layoutExpanded))
                        valueTree.note(kids, t("lw.layoutStaticStorage"));
                    if (symbol.compositeLayout?.truncated || symbol.runtimeLayout?.truncated)
                        valueTree.note(kids, t("lw.layoutPartial"), "warning");
                    for (const entry of runtime.displayUnavailableRows(
                        symbol.compositeLayout,
                        symbol.name,
                        64,
                        symbol,
                        valueTree.showRaw(symbol.name)
                    ))
                        page.layoutExpansion().render(kids, entry, symbol.name, t);
                    const shownLeaves = Math.min(leaves.length, Math.max(0, ROW_LIMIT - list.length - leafRows));
                    leaves.slice(0, shownLeaves).forEach((leaf) => kids.appendChild(rows.leaf(leaf, symbol)));
                    ownLeafRows = shownLeaves;
                    leafRows += shownLeaves;
                    if (leaves.length > shownLeaves)
                        valueTree.note(kids, t("lw.arrayMore", { n: leaves.length - shownLeaves }));
                    runtime.finishVariableNotices(kids);
                };
                // An opened composite without a layout asks the host for it once.
                const expand = () => {
                    populate();
                    if (needsLayout(symbol) && !page.pending.has(symbol.name)) requestLayout(symbol);
                };
                const toggle = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    open = !open;
                    page.expanded()[symbol.name] = open;
                    arrow.classList.toggle("open", open);
                    kids.classList.toggle("open", open);
                    if (open) expand();
                    else clear();
                };
                const { row, arrow } = rows.composite(symbol, open, toggle);
                content.appendChild(row);
                if (open) expand();
                content.appendChild(kids);
            }
            list.forEach((symbol) => {
                if (symbol.isComposite) composite(symbol);
                else content.appendChild(rows.scalar(symbol));
            });
            if (!list.length) {
                const empty = document.createElement("div");
                empty.className = "empty";
                empty.textContent = emptyText(query, symbols);
                content.appendChild(empty);
            }
            return { pool: symbols, matching, list };
        }
        return { pool, render, cancelSearch };
    }
    return { isUserVariable, create };
});
