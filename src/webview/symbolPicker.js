"use strict";
// ELF variable picker shared by the sidebar variable pane and the live watch import dialog: the user-variable filter,
// name and member search, expandable composites and their paged member rows. Each page builds its
// own rows (see `render`).
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const symbolPicker = factory(commonJs ? require("./runtime") : root.EmberProbeRuntime);
    if (commonJs) module.exports = symbolPicker;
    else root.EmberProbeSymbolPicker = symbolPicker;
})(typeof globalThis === "object" ? globalThis : this, function (runtime) {
    const VARIABLE_LIMIT = 500;
    const MEMBER_PAGE = 64;
    const MAX_AUTO_EXPANDED = 8;
    const SEARCH_CONCURRENCY = 4;
    const MAX_INDEXED_ROOTS = 1024;
    const MAX_INDEXED_MEMBERS = 32768;
    // Heuristic origin filter; the extension classifies symbols from DWARF source paths, types and names.
    function isUserVariable(symbol) {
        return !symbol.origin || symbol.origin === "user";
    }
    function needsLayout(symbol) {
        return (
            (symbol.isComposite || symbol.isReference) &&
            !symbol.cppTypeUnavailable &&
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

    function reconcile(container, nodes) {
        const kept = new Set(nodes);
        for (const node of Array.from(container.children)) if (!kept.has(node)) node.remove();
        let next = container.firstElementChild;
        for (const node of nodes) {
            if (next === node) next = next.nextElementSibling;
            else container.insertBefore(node, next);
        }
    }

    function setDisclosureRow(record, build) {
        if (!record.row) {
            record.row = build(record.arrow);
            return;
        }
        // Rebuild changed labels/controls without detaching the button, even during a click.
        const placeholder = document.createElement("span");
        placeholder.onclick = () => record.arrow.click();
        const next = build(placeholder);
        const wrap = record.arrow.parentElement;
        const nextWrap = placeholder.parentElement;
        reconcile(
            wrap,
            Array.from(nextWrap.children, (node) => (node === placeholder ? record.arrow : node))
        );
        reconcile(
            record.row,
            Array.from(next.children, (node) => (node === nextWrap ? wrap : node))
        );
        record.row.className = next.className;
    }

    function memberRow(row, path, depth) {
        if (path) row.dataset.pickerPath = path;
        row.dataset.pickerMember = "";
        row.style.setProperty("--picker-indent", Math.min(depth, 6) * 12 + "px");
        return row;
    }

    function treeRows(node, symbol) {
        const entries = [];
        if (node.promoted) entries.push({ leaf: { ...node.promoted, label: symbol } });
        if (node.unavailable) entries.push({ unavailable: node.unavailable });
        for (const child of node.children.values()) {
            const composite = child.children.size && child.leaves.find((leaf) => leaf.isComposite);
            if (child.children.size) entries.push({ branch: child, composite });
            for (const leaf of child.leaves) if (leaf !== composite) entries.push({ leaf });
            if (!child.children.size && child.unavailable) entries.push({ unavailable: child.unavailable });
        }
        return entries;
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

    function updateCheckboxSelections(content, checked) {
        for (const input of content.querySelectorAll(
            "input[data-leaf-path], input[data-symbol-name], .imp-branch-checkbox"
        )) {
            if (input.memberEntries) updateBranchCheckbox(input, checked);
            else input.checked = checked(input.dataset.leafPath ?? input.dataset.symbolName);
        }
    }

    function rememberCheckboxSelection(content, checkbox, picks, checked) {
        if (checkbox.type !== "checkbox") return;
        const entries = checkbox.memberEntries || (checkbox.leafEntry ? [checkbox.leafEntry] : []);
        for (const entry of entries) picks.set(entry.path, checkbox.checked ? entry : null);
        if (checkbox.dataset.symbolName) picks.set(checkbox.dataset.symbolName, checkbox.checked ? true : null);
        updateCheckboxSelections(content, checked);
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

    function create(page) {
        const { t, state, valueTree } = page;
        let searchTimer = null;
        let searchQuery = "";
        let searchUserOnly;
        let searchJob;
        let indexedMembers = 0;
        const details = new Map();
        const names = new WeakMap();
        const backgroundRequests = new Set();
        const automaticallyOpened = new Set();
        let roots = new Map();
        const searchExpanded = new Map();
        const empty = document.createElement("div");
        empty.className = "empty";

        function pool() {
            const all = page.symbols();
            return page.userOnly() ? all.filter(isUserVariable) : all;
        }
        function requestLayout(symbol, background = false) {
            const name = symbol.name;
            const request = {
                type: "resolveCompositeLayout",
                name,
                version: state.version,
                ...(state.generation != null ? { generation: state.generation } : {})
            };
            if (page.pending.has(name)) {
                if (!background && backgroundRequests.delete(name)) page.post?.({ ...request, promote: true });
                return;
            }
            page.pending.add(name);
            if (background) backgroundRequests.add(name);
            page.post?.(background ? { ...request, background: true } : request);
        }
        function cancelSearch() {
            clearTimeout(searchTimer);
            searchTimer = null;
            searchJob = undefined;
        }
        function queueSearch(delay) {
            if (searchTimer !== null || !searchJob || searchJob.next === searchJob.candidates.length) return;
            searchTimer = setTimeout(() => {
                searchTimer = null;
                if (page.active && !page.active()) return;
                const job = searchJob;
                while (page.pending.size < SEARCH_CONCURRENCY && job.next < job.candidates.length) {
                    const symbol = job.candidates[job.next++];
                    if (needsLayout(symbol) && !page.pending.has(symbol.name)) requestLayout(symbol, true);
                }
            }, delay);
        }
        function scheduleSearch(query, symbols) {
            const userOnly = page.userOnly();
            if (query !== searchQuery) {
                searchExpanded.clear();
                automaticallyOpened.clear();
            } else if (userOnly !== searchUserOnly) automaticallyOpened.clear();
            searchQuery = query;
            searchUserOnly = userOnly;
            if (!query || !page.typesReady() || !page.post) return cancelSearch();
            const source = page.symbols();
            if (searchJob?.query === query && searchJob.userOnly === userOnly && searchJob.source === source) return;
            cancelSearch();
            searchJob = { query, userOnly, source, candidates: symbols.filter(needsLayout), next: 0 };
            queueSearch(180);
        }
        function resolved(symbol) {
            backgroundRequests.delete(symbol.name);
            if (page.active && !page.active()) return false;
            queueSearch(0);
            if (roots.has(symbol.name)) return true;
            if (!searchQuery) return false;
            return !!matchingMembers(symbol, searchQuery) || (!roots.size && !pool().some(needsLayout));
        }
        function emptyText(query, symbols) {
            const all = page.symbols();
            if (query && (!page.typesReady() || symbols.some(needsLayout))) return t("sb.searchingMembers");
            if (!symbols.length && all.length) return t("sb.noUserVars", { count: all.length });
            return all.length ? t("sb.noMatch") : t("sb.noImportable");
        }

        function forgetDetails(symbol) {
            const cached = details.get(symbol);
            if (!cached) return;
            indexedMembers -= cached.leaves.length;
            details.delete(symbol);
        }
        function detailsFor(symbol) {
            const showRaw = valueTree.showRaw(symbol.name);
            const cached = details.get(symbol);
            if (
                cached &&
                cached.layout === symbol.compositeLayout &&
                cached.graph === symbol.runtimeLayout &&
                cached.expansions === symbol.layoutExpansions &&
                cached.displayName === symbol.displayName &&
                (!cached.selection?.sampled || state.latest[symbol.name] != null) &&
                cached.showRaw === showRaw &&
                cached.language === page.language()
            ) {
                details.delete(symbol);
                details.set(symbol, cached);
                return cached;
            }
            const selection = runtime.runtimeSelection(symbol, state.latest[symbol.name]);
            const branchTypes = new Map();
            const leaves = valueTree.selectionLeaves(symbol, selection, branchTypes);
            const result = {
                layout: symbol.compositeLayout,
                graph: symbol.runtimeLayout,
                expansions: symbol.layoutExpansions,
                displayName: symbol.displayName,
                language: page.language(),
                showRaw,
                selection,
                branchTypes,
                leaves
            };
            forgetDetails(symbol);
            details.set(symbol, result);
            indexedMembers += leaves.length;
            while (details.size > MAX_INDEXED_ROOTS || indexedMembers > MAX_INDEXED_MEMBERS)
                forgetDetails(details.keys().next().value);
            return result;
        }
        function searchableNames(symbol) {
            const display = page.displayName(symbol);
            const cached = names.get(symbol);
            if (cached?.display === display) return cached;
            const entry = { display, linkName: symbol.name.toLowerCase(), displayName: display.toLowerCase() };
            names.set(symbol, entry);
            return entry;
        }
        function matchingMembers(symbol, query) {
            if (!symbol.compositeLayout && !symbol.runtimeLayout) return null;
            const data = detailsFor(symbol);
            if (data.query !== query) {
                data.index ||= data.leaves.map((leaf) => ({
                    leaf,
                    linkName: leaf.path.toLowerCase(),
                    displayName: page.displayName({ name: leaf.displayPath || leaf.path }).toLowerCase()
                }));
                const leaves = [];
                for (const entry of data.index)
                    if (entry.linkName.includes(query) || entry.displayName.includes(query)) leaves.push(entry.leaf);
                if (!leaves.length && !data.selection && query.includes("["))
                    leaves.push(...indexedArrayLeaves(symbol, query, data));
                data.query = query;
                data.match = leaves.length ? memberTree(symbol, leaves, []) : null;
            }
            return data.match;
        }
        function indexedArrayLeaves(symbol, query, data) {
            const { linkName, displayName } = searchableNames(symbol);
            const base = [linkName, displayName].find((name) => runtime.isDescendantPath(query, name));
            if (!base) return [];
            const targetPath = linkName + query.slice(base.length);
            if (!runtime.memberPathSegments(symbol.name + query.slice(base.length))) return [];
            return valueTree
                .collectLeaves(symbol.compositeLayout, symbol.name, symbol.address, {
                    showRaw: data.showRaw,
                    includePointers: true,
                    targetPath,
                    onBranch: (path, typeName) => {
                        if (typeName) data.branchTypes.set(path, typeName);
                    }
                })
                .filter((leaf) => !leaf.isReference);
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

        function disclosure(path, symbolName, depth) {
            const key = depth ? JSON.stringify([symbolName, path]) : path;
            const arrow = document.createElement("button");
            arrow.type = "button";
            arrow.className = page.arrowClass;
            arrow.textContent = "▶";
            const body = document.createElement("div");
            body.className = page.childrenClass;
            runtime.createVariableNotices(body, t, document.createElement("div"));
            const list = document.createElement("div");
            const record = {
                arrow,
                body,
                list,
                branches: new Map(),
                leaves: new Map(),
                shown: MEMBER_PAGE,
                path,
                depth
            };
            let options;
            function update(force = false) {
                const { filtered, autoOpen, draw } = options;
                const open = filtered ? (searchExpanded.get(key) ?? autoOpen) : (page.expanded()[key] ?? autoOpen);
                const revision = open ? options.revision() : null;
                arrow.setAttribute("aria-expanded", String(open));
                arrow.classList.toggle("open", open);
                body.classList.toggle("open", open);
                if (open && (force || !record.open || record.revision !== revision)) {
                    runtime.resetVariableNotices(body, t);
                    if (list.parentElement !== body) body.prepend(list);
                    draw(record);
                    runtime.finishVariableNotices(body);
                } else if (!open && record.open) {
                    runtime.resetVariableNotices(body, t);
                    list.replaceChildren();
                    body.replaceChildren();
                    record.branches.clear();
                    record.leaves.clear();
                }
                record.open = open;
                record.revision = revision;
            }
            record.more = (count) => {
                record.shown += count;
                update(true);
            };
            record.update = (next) => {
                options = next;
                update();
            };
            arrow.onclick = (event) => {
                event.stopPropagation();
                if (options.filtered) searchExpanded.set(key, !record.open);
                else page.expanded()[key] = !record.open;
                update();
            };
            return record;
        }

        function renderTree(record, node, context) {
            const { symbol, filtered, branchTypes, rows } = context;
            const entries = treeRows(node, page.displayName(symbol));
            const nodes = [];
            const branches = new Map();
            const leaves = new Map();
            const depth = record.depth + 1;
            for (const entry of entries.slice(0, record.shown)) {
                if (entry.branch) {
                    const { branch, composite } = entry;
                    const child = record.branches.get(branch.path) || disclosure(branch.path, symbol.name, depth);
                    if (child.model !== branch) {
                        setDisclosureRow(child, (arrow) =>
                            branchRow(branch, arrow, composite, branchTypes, rows.branchControls)
                        );
                        memberRow(child.row, branch.path, depth);
                        child.arrow.setAttribute(
                            "aria-label",
                            t("lw.toggleMemberTree", { name: page.displayName({ name: branch.path }) })
                        );
                        child.model = branch;
                    }
                    child.update({
                        filtered,
                        autoOpen: filtered || !!symbol.layoutExpansions?.[branch.path],
                        draw: (open) => renderTree(open, branch, context),
                        revision: () => branch
                    });
                    branches.set(branch.path, child);
                    nodes.push(child.row, child.body);
                } else if (entry.leaf) {
                    const leaf = entry.leaf;
                    const row = record.leaves.get(leaf) || memberRow(rows.leaf(leaf), leaf.path, depth);
                    leaves.set(leaf, row);
                    nodes.push(row);
                } else {
                    const notice = memberRow(document.createElement("div"), null, depth);
                    notice.className = "picker-member-notice";
                    runtime.createVariableNotices(notice, t, document.createElement("div"));
                    page.layoutExpansion().render(notice, entry.unavailable, symbol.name, t);
                    runtime.finishVariableNotices(notice);
                    nodes.push(notice);
                }
            }
            record.branches = branches;
            record.leaves = leaves;
            reconcile(record.list, nodes);
            if (record.shown < entries.length)
                runtime.renderArrayMore(
                    record.body,
                    entries.length - record.shown,
                    t,
                    record.more,
                    record.path,
                    page.displayName({ name: record.path })
                );
        }

        function populate(record, symbol, match, rows) {
            const { body } = record;
            if (!symbol.compositeLayout && !symbol.runtimeLayout) {
                if (needsLayout(symbol) && page.post) {
                    requestLayout(symbol);
                    valueTree.note(body, { text: { key: "lw.layoutLoading" }, busy: true });
                } else
                    valueTree.note(
                        body,
                        symbol.layoutError || symbol.unsupportedReason || t("lw.compositeNoLayout"),
                        "warning"
                    );
                record.list.replaceChildren();
                return;
            }
            const data = detailsFor(symbol);
            const { selection, leaves, branchTypes } = data;
            valueTree.renderRawMembersUi(body, state.latest[symbol.name] || symbol.compositeLayout, symbol.name);
            if (selection)
                valueTree.note(
                    body,
                    t(
                        selection.sampled
                            ? "lw.runtimeMembersReadOnly"
                            : selection.entries.length
                              ? "lw.runtimeMembersSelectable"
                              : "lw.runtimeMembersHint"
                    )
                );
            if (selection && leaves.some((leaf) => leaf.layoutExpanded))
                valueTree.note(body, t("lw.layoutStaticStorage"));
            if (symbol.compositeLayout?.truncated || symbol.runtimeLayout?.truncated)
                valueTree.note(body, t("lw.layoutPartial"), "warning");
            if (!match && !data.tree) {
                const unavailable = runtime.displayUnavailableRows(
                    symbol.compositeLayout,
                    symbol.name,
                    64,
                    symbol,
                    data.showRaw
                );
                data.tree = memberTree(symbol, leaves, unavailable);
            }
            renderTree(record, match || data.tree, { symbol, filtered: !!match, branchTypes, rows });
        }
        function rootRow(symbol, record, match, rows, autoOpen) {
            const composite = !!(
                symbol.isComposite ||
                (symbol.isReference && runtime.runtimeWatchEntry(symbol.name, symbol)?.isComposite)
            );
            if (record?.symbol !== symbol || !!record.arrow !== composite)
                record = composite ? disclosure(symbol.name, symbol.name, 0) : {};
            const name = page.displayName(symbol);
            const header = JSON.stringify([
                name,
                symbol.typeName,
                symbol.watchType,
                symbol.origin,
                symbol.sourceFile,
                symbol.layoutError || "",
                symbol.hasDwarfWriteType,
                symbol.isReference,
                symbol.isEnum,
                symbol.isBoolean,
                symbol.isConst,
                symbol.isPointer,
                symbol.isMemberPointer,
                symbol.pointerTarget,
                !!symbol.compositeLayout,
                !!symbol.runtimeLayout,
                symbol.unsupportedReason || "",
                page.language(),
                page.typesReady()
            ]);
            if (record.header !== header) {
                if (composite) {
                    setDisclosureRow(record, (arrow) => rows.composite(symbol, arrow));
                    record.row.dataset.pickerPath = symbol.name;
                    record.arrow.setAttribute("aria-label", t("lw.toggleMemberTree", { name }));
                } else record.row = rows.scalar(symbol);
                record.header = header;
            }
            record.symbol = symbol;
            if (composite)
                record.update({
                    filtered: !!match,
                    autoOpen,
                    draw: (open) => populate(open, symbol, match, rows),
                    revision: () =>
                        match || (symbol.compositeLayout || symbol.runtimeLayout ? detailsFor(symbol) : header)
                });
            return record;
        }
        function render(content, query, rows) {
            const symbols = pool();
            scheduleSearch(query, symbols);
            const matches = new Map();
            const matching = symbols.filter((symbol) => {
                if (!query) return true;
                const { linkName, displayName } = searchableNames(symbol);
                if (linkName.includes(query) || displayName.includes(query)) return true;
                if (!symbol.isComposite && !symbol.isReference) return false;
                const match = matchingMembers(symbol, query);
                if (match) matches.set(symbol.name, match);
                return !!match;
            });
            const list = matching.slice(0, VARIABLE_LIMIT);
            const next = new Map();
            const nodes = [];
            for (const symbol of list) {
                const match = matches.get(symbol.name);
                if (match && automaticallyOpened.size < MAX_AUTO_EXPANDED) automaticallyOpened.add(symbol.name);
                const record = rootRow(
                    symbol,
                    roots.get(symbol.name),
                    match,
                    rows,
                    !!match && automaticallyOpened.has(symbol.name)
                );
                next.set(symbol.name, record);
                nodes.push(record.row);
                if (record.body) nodes.push(record.body);
            }
            roots = next;
            if (!list.length) {
                empty.textContent = emptyText(query, symbols);
                nodes.push(empty);
            }
            reconcile(content, nodes);
            return { pool: symbols, matching, list };
        }

        function invalidate(name) {
            forgetDetails(state.symbols.get(name));
        }
        function sampleChanged(name, tree, visible) {
            const symbol = state.symbols.get(name);
            const cached = details.get(symbol);
            if ((!visible && !cached?.selection) || !runtime.runtimeGraph(symbol)) return false;
            if (runtime.runtimeTreeShape(state.latest[name]) === runtime.runtimeTreeShape(tree)) return false;
            forgetDetails(symbol);
            return visible && !!(cached?.selection || runtime.runtimeSelection(symbol, tree));
        }
        function clearRows() {
            roots.clear();
        }
        function reset() {
            cancelSearch();
            searchUserOnly = undefined;
            searchExpanded.clear();
            automaticallyOpened.clear();
            details.clear();
            indexedMembers = 0;
            backgroundRequests.clear();
            clearRows();
        }
        return { pool, render, requestLayout, resolved, cancelSearch, invalidate, sampleChanged, reset, clearRows };
    }
    return {
        isUserVariable,
        create,
        watchMember,
        updateBranchButton,
        updateBranchCheckbox,
        updateCheckboxSelections,
        rememberCheckboxSelection
    };
});
