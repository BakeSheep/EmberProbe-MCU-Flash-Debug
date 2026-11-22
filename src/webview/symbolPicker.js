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
        return (
            (symbol.isComposite || symbol.isReference) &&
            !runtime.runtimeGraph(symbol) &&
            !symbol.compositeLayout &&
            !symbol.layoutError
        );
    }

    function memberTree(symbol, leaves, unavailable) {
        const root = { children: new Map() };
        function insert(path) {
            let parent = root;
            let prefix = symbol.name;
            // Split only the relative member path. ELF symbol names can contain dots or brackets.
            for (const part of runtime.relativeMemberParts(path, symbol.name)) {
                prefix += part;
                if (!parent.children.has(part))
                    parent.children.set(part, {
                        path: prefix,
                        label: part.replace(/^\./, ""),
                        children: new Map(),
                        leaves: []
                    });
                parent = parent.children.get(part);
            }
            return parent;
        }
        const seen = new Set();
        for (const leaf of leaves) {
            if (seen.has(leaf.path)) continue;
            seen.add(leaf.path);
            const node = insert(leaf.displayPath || leaf.path);
            // A promoted STL value can be shown at the same path as its owning object.
            if (node === root) root.promoted = leaf;
            else node.leaves.push({ ...leaf, label: node.label });
        }
        for (const entry of unavailable) {
            const node = insert(entry.path);
            node.unavailable = entry;
        }
        return root;
    }

    function branchMembers(node) {
        const composite = node.leaves.find((leaf) => leaf.isComposite);
        return composite ? [composite] : node.leaves.concat(...Array.from(node.children.values(), branchMembers));
    }

    function updateBranchButton(button, watched, t) {
        const count = button.memberEntries.filter((member) => watched.has(member.name)).length;
        const all = count === button.memberEntries.length;
        button.classList.toggle("on", all);
        button.textContent = all ? "✓" : count ? "−" : "+";
        button.setAttribute("aria-pressed", all ? "true" : count ? "mixed" : "false");
        button.title = t(all ? "sb.removeBranchMembers" : "sb.addBranchMembers", { n: button.memberEntries.length });
        button.setAttribute("aria-label", button.title);
    }

    function updateBranchCheckbox(checkbox, checked) {
        const count = checkbox.memberEntries.filter((entry) => checked(entry.path)).length;
        checkbox.checked = count > 0 && count === checkbox.memberEntries.length;
        checkbox.indeterminate = count > 0 && !checkbox.checked;
    }

    function rememberCheckboxSelection(content, checkbox, picks, checked) {
        if (checkbox.type !== "checkbox") return;
        const entries = checkbox.memberEntries || (checkbox.leafEntry ? [checkbox.leafEntry] : []);
        for (const entry of entries) picks.set(entry.path, checkbox.checked ? entry : null);
        if (checkbox.dataset.symbolName) picks.set(checkbox.dataset.symbolName, checkbox.checked ? true : null);
        for (const input of content.querySelectorAll("input[data-leaf-path], .imp-branch-checkbox")) {
            if (input.memberEntries) updateBranchCheckbox(input, checked);
            else input.checked = checked(input.dataset.leafPath);
        }
    }

    // Static leaves and validated runtime recipes retain the same watch fields whether chosen alone or in a branch.
    function watchMember(leaf, displayName) {
        const { runtimeLayout, runtimeSegments, runtimeLeaf, runtimeStaticPointers, compositeLayout, isComposite } =
            leaf;
        return {
            name: leaf.path,
            displayName: displayName({ name: leaf.displayPath || leaf.path, displayName: leaf.displayName }),
            address: leaf.address,
            size: leaf.size || runtime.typeByteLength(leaf.type),
            type: leaf.type,
            ...(leaf.isPointer ? { isPointer: true, typeName: leaf.typeName, pointerTarget: leaf.pointerTarget } : {}),
            ...(isComposite && leaf.typeName ? { typeName: leaf.typeName } : {}),
            ...(leaf.layoutExpanded ? { layoutExpanded: true, staticRuntimeStorage: leaf.staticRuntimeStorage } : {}),
            ...(leaf.isBoolean ? { isBoolean: true } : {}),
            ...(Number.isInteger(leaf.bitSize) ? { bitSize: leaf.bitSize, bitOffset: leaf.bitOffset } : {}),
            ...(leaf.isConst ? { isConst: true } : {}),
            ...(leaf.isReference ? { isReference: true, typeName: leaf.typeName } : {}),
            ...(leaf.isMemberPointer ? { isMemberPointer: true } : {}),
            ...(leaf.enumEncodingInferred ? { enumEncodingInferred: true } : {}),
            ...(runtimeLayout
                ? { runtimeLayout, runtimeSegments, runtimeLeaf, runtimeStaticPointers, compositeLayout, isComposite }
                : {})
        };
    }

    // page: { t, state, valueTree, layoutExpansion(), displayName(item), symbols() for all ELF symbols, userOnly(),
    // expanded() for open composites by name, pending (Set of requested layouts), typesReady(), post(message) or null
    // without a host, active() while the picker is shown, arrowClass, childrenClass }
    function create(page) {
        const { t, state } = page;
        let searchTimer = null,
            searchQuery = "";
        const searchExpanded = new Map();
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
            if (query !== searchQuery) searchExpanded.clear();
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
        function branchRow(branch, arrow, composite, branchTypes, controls) {
            const { rowClass, nameWrapClass, nameClass } = page.branchStyle;
            const path = page.displayName({ name: branch.path });
            const typeName = composite?.typeName || branchTypes.get(branch.path) || t("lw.compositeType");
            const { selection, columns } = controls(branchMembers(branch), path, typeName, composite);
            const row = document.createElement("div");
            row.className = rowClass + " picker-branch";
            const wrap = document.createElement("span");
            wrap.className = nameWrapClass;
            const name = document.createElement("span");
            name.className = nameClass;
            name.textContent = branch.label;
            name.title = path;
            name.onclick = () => arrow.click();
            wrap.append(arrow);
            if (selection) wrap.append(selection);
            wrap.append(name);
            row.append(wrap, ...columns);
            return row;
        }
        // Rows supply selection controls; the picker owns the tree, disclosures and the visible row budget.
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
                if (!symbol.isComposite && !symbol.isReference) return false;
                const selection = runtime.runtimeSelection(symbol, state.latest[symbol.name]);
                const branchTypes = new Map();
                const matches = valueTree.selectionLeaves(symbol, selection, branchTypes).filter(
                    (leaf) =>
                        leaf.path.toLowerCase().includes(query) ||
                        page
                            .displayName({ name: leaf.displayPath || leaf.path })
                            .toLowerCase()
                            .includes(query)
                );
                if (!matches.length) return false;
                memberMatches.set(symbol.name, { leaves: matches, branchTypes });
                return true;
            });
            const list = matching.slice(0, VARIABLE_LIMIT);
            let remaining = ROW_LIMIT - list.length;
            function appendMember(parent, row, depth) {
                remaining--;
                row.dataset.pickerMember = "";
                row.style.setProperty("--picker-indent", Math.min(depth, 6) * 12 + "px");
                parent.append(row);
            }
            function disclosure(parent, path, autoOpen, rowFor, populate, depth = 0, symbolName = path) {
                const expanded = page.expanded();
                const key = depth ? JSON.stringify([symbolName, path]) : path;
                const kids = document.createElement("div");
                kids.className = page.childrenClass;
                const arrow = document.createElement("button");
                arrow.type = "button";
                arrow.className = page.arrowClass;
                arrow.textContent = "▶";
                arrow.setAttribute("aria-label", t("lw.toggleMemberTree", { name: page.displayName({ name: path }) }));
                let open = autoOpen === "search" ? (searchExpanded.get(key) ?? true) : (expanded[key] ?? autoOpen);
                const update = () => {
                    arrow.setAttribute("aria-expanded", String(!!open));
                    arrow.classList.toggle("open", !!open);
                    kids.classList.toggle("open", !!open);
                    if (open) {
                        runtime.resetVariableNotices(kids, t);
                        populate(kids);
                    } else if (kids.childElementCount) {
                        remaining += kids.querySelectorAll("[data-picker-member]").length;
                        runtime.resetVariableNotices(kids, t);
                        kids.replaceChildren();
                    }
                };
                arrow.onclick = (event) => {
                    event.stopPropagation();
                    open = !open;
                    if (autoOpen === "search") searchExpanded.set(key, open);
                    else expanded[key] = open;
                    update();
                };
                const row = rowFor(arrow);
                row.dataset.pickerPath = path;
                if (depth) appendMember(parent, row, depth);
                else parent.append(row);
                parent.append(kids);
                update();
            }
            function renderTree(kids, node, symbol, filtered, depth, branchTypes) {
                const entries = [];
                if (node.promoted) entries.push({ leaf: { ...node.promoted, label: page.displayName(symbol) } });
                if (node.unavailable) entries.push({ unavailable: node.unavailable });
                for (const child of node.children.values()) {
                    const composite = child.children.size && child.leaves.find((leaf) => leaf.isComposite);
                    if (child.children.size) entries.push({ branch: child, composite });
                    for (const leaf of child.leaves) if (leaf !== composite) entries.push({ leaf });
                    if (!child.children.size && child.unavailable) entries.push({ unavailable: child.unavailable });
                }
                for (const [index, entry] of entries.entries()) {
                    if (!remaining) {
                        valueTree.note(kids, t("lw.arrayMore", { n: entries.length - index }));
                        break;
                    }
                    if (entry.branch) {
                        const { branch, composite } = entry;
                        disclosure(
                            kids,
                            branch.path,
                            filtered ? "search" : !!symbol.layoutExpansions?.[branch.path],
                            (arrow) => branchRow(branch, arrow, composite, branchTypes, rows.branchControls),
                            (body) => renderTree(body, branch, symbol, filtered, depth + 1, branchTypes),
                            depth,
                            symbol.name
                        );
                    } else if (entry.leaf) {
                        const row = rows.leaf(entry.leaf);
                        row.dataset.pickerPath = entry.leaf.path;
                        appendMember(kids, row, depth);
                    } else {
                        const notice = document.createElement("div");
                        notice.className = "picker-member-notice";
                        appendMember(kids, notice, depth);
                        runtime.createVariableNotices(notice, t, document.createElement("div"));
                        page.layoutExpansion().render(notice, entry.unavailable, symbol.name, t);
                        runtime.finishVariableNotices(notice);
                    }
                }
                runtime.finishVariableNotices(kids);
            }
            function composite(symbol) {
                const matches = memberMatches.get(symbol.name);
                function populate(kids) {
                    if (!symbol.compositeLayout && !symbol.runtimeLayout) {
                        valueTree.note(
                            kids,
                            symbol.layoutError || symbol.unsupportedReason || t("lw.compositeNoLayout"),
                            "warning"
                        );
                        if (needsLayout(symbol) && !page.pending.has(symbol.name)) requestLayout(symbol);
                        return;
                    }
                    valueTree.renderRawMembersUi(
                        kids,
                        state.latest[symbol.name] || symbol.compositeLayout,
                        symbol.name
                    );
                    const selection = runtime.runtimeSelection(symbol, state.latest[symbol.name]);
                    const branchTypes = matches?.branchTypes || new Map();
                    const leaves = matches?.leaves || valueTree.selectionLeaves(symbol, selection, branchTypes);
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
                    const unavailable = matches
                        ? []
                        : runtime.displayUnavailableRows(
                              symbol.compositeLayout,
                              symbol.name,
                              64,
                              symbol,
                              valueTree.showRaw(symbol.name)
                          );
                    renderTree(kids, memberTree(symbol, leaves, unavailable), symbol, !!matches, 1, branchTypes);
                }
                disclosure(
                    content,
                    symbol.name,
                    matches ? "search" : false,
                    (arrow) => rows.composite(symbol, arrow),
                    populate
                );
            }
            list.forEach((symbol) => {
                if (
                    symbol.isComposite ||
                    (symbol.isReference && runtime.runtimeWatchEntry(symbol.name, symbol)?.isComposite)
                )
                    composite(symbol);
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
    return {
        isUserVariable,
        create,
        watchMember,
        updateBranchButton,
        updateBranchCheckbox,
        rememberCheckboxSelection
    };
});
