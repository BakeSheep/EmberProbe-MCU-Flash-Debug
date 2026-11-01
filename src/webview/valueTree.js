"use strict";
// Watch values shared by the sidebar and live watch pages: value text, remembered pointer targets and
// the member tree of composite watches. Each page passes an adapter for what differs between them
// (see `create`); the chart adds number bases, curve swatches and array ranges.
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
    function isComposite(item) {
        return !!(item && item.isComposite && (item.compositeLayout || item.runtimeLayout));
    }
    // Pointer fields of a scalar sample, kept beside its value.
    function pointerReading(sample) {
        return {
            ...(sample.isPointer || sample.pointerText ? { isPointer: true } : {}),
            pointerText: sample.pointerText,
            pointerInfo: sample.pointerInfo,
            pointerString: sample.pointerString
        };
    }
    // `stale` is true below a node the host held from an earlier sample (see runtimeSampleHold.js).
    function walkLeaves(node, path, visit, stale) {
        if (!node) return;
        stale = !!stale || !!node.stale;
        visit(path, node, stale);
        for (const member of node.members || [])
            walkLeaves(member, runtime.layoutMemberPath(path, member), visit, stale);
        for (const element of node.elements || []) walkLeaves(element, path + "[" + element.index + "]", visit, stale);
    }
    // Runs `run` at most once per `interval` ms; a call inside the interval runs once when it ends.
    function createThrottle(interval, run) {
        let timer = null;
        let last = 0;
        function fire() {
            last = Date.now();
            run();
        }
        return {
            schedule() {
                if (timer !== null) return;
                const elapsed = Date.now() - last;
                if (elapsed >= interval) {
                    fire();
                    return;
                }
                timer = setTimeout(() => {
                    timer = null;
                    fire();
                }, interval - elapsed);
            },
            // Lets the next call run at once.
            reset() {
                last = 0;
            }
        };
    }
    // Pointer targets last sampled per watch path. They are saved with the view so a reopened page still
    // names them, and belong to the ELF version they were sampled from: they show only while it is loaded.
    function createPointerMemory(version, save, saved) {
        let pointers = saved?.pointers && saved.version ? saved.pointers : Object.create(null);
        let pointersVersion = saved?.pointers && saved.version ? String(saved.version) : "";
        let timer = null;
        function reset(next) {
            pointers = Object.create(null);
            pointersVersion = next || "";
        }
        function remember(entries) {
            const current = version();
            if (!current) return;
            let changed = false;
            if (pointersVersion !== current) {
                reset(current);
                changed = true;
            }
            for (const [path, next] of Object.entries(entries)) {
                if (JSON.stringify(pointers[path]) !== JSON.stringify(next)) {
                    pointers[path] = next;
                    changed = true;
                }
            }
            if (!changed || timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                save();
            }, 2000);
        }
        return {
            // Snapshots sampled from another ELF never name targets in the loaded one.
            shown() {
                const current = version();
                return current && pointersVersion === current ? pointers : Object.create(null);
            },
            remember,
            rememberSample(sample) {
                if (!(sample.isPointer || sample.pointerText) || sample.value == null || sample.diagnostic) return;
                remember({
                    [sample.name]: {
                        value: sample.value,
                        ...(sample.valueText != null ? { valueText: sample.valueText } : {}),
                        ...(sample.pointerText ? { pointerText: sample.pointerText } : {}),
                        ...(sample.pointerInfo ? { pointerInfo: sample.pointerInfo } : {}),
                        ...(sample.pointerString ? { pointerString: sample.pointerString } : {})
                    }
                });
            },
            forget(name) {
                for (const path of Object.keys(pointers))
                    if (path === name || path.startsWith(name + ".") || path.startsWith(name + "["))
                        delete pointers[path];
            },
            // Drops every remembered target but keeps the ELF version they belong to.
            clear() {
                reset(pointersVersion);
            },
            // Drops targets of an ELF that is no longer loaded; true when something was dropped.
            expire() {
                const current = version();
                if (!current || !pointersVersion || pointersVersion === current) return false;
                reset(current);
                return true;
            },
            saved() {
                return { pointers, version: pointersVersion };
            }
        };
    }

    // `page` supplies:
    //   t(key, params)              translation
    //   classes                     CSS classes: row, name, type, value (member rows); nest, head, arrow,
    //                               headName, headType, members (nested composites); note
    //   state                       the page state; read here: watch (list), symbols (ELF symbols by name),
    //                               version (loaded ELF), latest, latestText, latestEnum, latestPointer
    //                               (readings by name; a runtime watch reads as its sampled tree), and
    //                               expanded, rawMembers, arrayShown (saved with the view)
    //   radix(name)                 optional number base for `name`
    //   savedPointers               { pointers, version } restored with the view
    //   displayName(path)           readable name for a path
    //   save()                      saves the view state
    //   rerender()                  redraws the watch list
    //   rerenderPicker()            redraws the variable picker
    //   post(message)               sends a message to the host
    //   copy(text)                  copies text through the host
    //   layoutExpansion()           the page's layout expansion UI
    //   requestPointerLayout(name)  asks for the runtime type graph a scalar pointer needs to expand
    //   togglePointee(entry)        adds or removes a pointee watch entry
    //   decorateLeaf(row, nameCell, { path, address, watchType, node }) → the row's first element
    //   scalarCell(cell, name)      registers the value cell of a scalar pointee watch
    function create(page) {
        const state = page.state;
        const classes = page.classes;
        const t = (key, params) => page.t(key, params);
        const radix = page.radix || (() => 10);

        const baseName = (path) => runtime.variableBaseName(String(path));
        const pointers = createPointerMemory(() => state.version, page.save, page.savedPointers);
        // Pointer metadata for a scalar watch; the layout walk runs once per render, not per refresh.
        let displayInfos = new WeakMap();
        // Value cells of composite members by path, runtime bodies by watch name, and the pointee
        // entries drawn inside their pointer rows or, without one, as stand-alone cards.
        let cells = Object.create(null);
        let bodies = Object.create(null);
        let placed = new Set();
        let fallback = new Set();
        let runtimeExpansionsLoaded = false;
        let sentRuntimeExpansions = null;

        function element(tag, className) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            return node;
        }
        function copyOnClick(cell) {
            cell.addEventListener("click", (event) => {
                event.stopPropagation();
                if (cell.textContent) page.copy(runtime.copyValueText(cell));
            });
        }
        function note(container, text, level = "info") {
            const node = runtime.renderVariableNotice(container, typeof text === "string" ? { text, level } : text, t);
            node.querySelector(".notice-text")?.classList.add(classes.note);
        }
        function layoutSymbol(path) {
            const name = runtime.variableBaseName(path);
            const symbol = state.symbols.get(name);
            return symbol?.compositeLayout ? symbol : state.watch.find((item) => item.name === name) || symbol;
        }
        function showRaw(path) {
            return !!state.rawMembers[baseName(path)];
        }

        function formatNode(node, name) {
            if (node?.functionEmpty) return t("lw.functionEmpty");
            if (node?.isPointer) return runtime.pointerLabel(node, t);
            return node ? fmtExact(node.value, node.valueText, node.enumText, radix(name)) : "—";
        }
        function resolveDisplayInfo(item) {
            if (item.isPointer) return item;
            const direct = state.symbols.get(item.name);
            if (direct?.isPointer) return direct;
            const symbol = layoutSymbol(item.name);
            return (
                runtime
                    .displayLayoutLeaves(symbol, symbol?.compositeLayout, baseName(item.name), symbol?.address, {
                        showRaw: true,
                        includePointers: true
                    })
                    .find((leaf) => leaf.path === item.name) || item
            );
        }
        function displayInfo(item) {
            if (!displayInfos.has(item)) displayInfos.set(item, resolveDisplayInfo(item));
            return displayInfos.get(item);
        }
        function scalarDisplay(item) {
            const info = displayInfo(item);
            const value = state.latest[item.name];
            // Before the first sample a pointer shows the target it had when last sampled.
            const last = info.isPointer && value === undefined && pointers.shown()[item.name];
            if (last) return formatNode({ ...info, ...last, stale: true }, item.name);
            return formatNode(
                {
                    ...info,
                    ...state.latestPointer[item.name],
                    value,
                    valueText: state.latestText[item.name],
                    enumText: state.latestEnum[item.name]
                },
                item.name
            );
        }
        // A static layout row has no value until sampled; a pointer in it shows its last known target.
        function withLastPointer(node, path) {
            const last = node?.isPointer && node.value == null && !node.stale && pointers.shown()[path];
            return last && state.latest[baseName(path)] === undefined ? { ...node, ...last, stale: true } : node;
        }
        function renderRawMembersUi(container, node, name) {
            runtime.renderMemberVisibility(container, node, name, showRaw(name), t, () => {
                state.rawMembers[baseName(name)] = !showRaw(name);
                page.save();
                page.rerender();
                page.rerenderPicker();
            });
        }

        // Expansion needs the base symbol's runtime type graph. Composite watches load it with their
        // layout; a scalar pointer variable requests it once here and re-renders when it arrives.
        function pointerSymbol(path) {
            const symbol = state.symbols.get(baseName(path));
            if (runtime.runtimeGraph(symbol)) return symbol;
            const layout = layoutSymbol(path);
            if (!runtime.runtimeGraph(layout) && symbol?.hasRuntimeLayout && !symbol.layoutError)
                page.requestPointerLayout(symbol.name);
            return layout;
        }
        // Pointer rows expand in place. A pointee already present in the sampled tree toggles
        // locally; otherwise opening adds the read-only `<path>.value` watch, nested here.
        function pointerPointee(row, path, label, node, renderInline) {
            const host = element("div");
            host.variableNoticeParent = row;
            if (renderInline) {
                const toggle = runtime.renderPointerToggle(
                    row,
                    path,
                    !!state.expanded[path],
                    t,
                    () => {
                        const open = !state.expanded[path];
                        state.expanded[path] = open;
                        host.classList.toggle("open", open);
                        toggle.classList.toggle("open", open);
                        toggle.setAttribute("aria-expanded", String(open));
                        page.save();
                    },
                    page.displayName(path)
                );
                host.className = "pointer-pointee" + (state.expanded[path] ? " open" : "");
                renderInline(host);
                return host;
            }
            row.classList.add("pointer-row");
            const entry = node?.isPointer && runtime.pointerDerefEntry(path, pointerSymbol(path));
            if (!entry) return null;
            const item = state.watch.find((watched) => watched.name === entry.name);
            runtime.renderPointerToggle(row, path, !!item, t, () => page.togglePointee(entry), page.displayName(path));
            if (!item) return null;
            host.className = "pointer-pointee open";
            renderPointee(host, item, label);
            return host;
        }
        function renderPointee(host, item, label) {
            placed.add(item.name);
            if (isComposite(item)) {
                bodies[item.name] = host;
                renderRuntimeBody(host, state.latest[item.name], item.name);
                return;
            }
            // A scalar target (`int *`, `char *` string preview, pointer to pointer) is one row.
            const row = element("div", classes.row);
            row.dataset.path = item.name;
            const name = element("span", classes.name);
            name.textContent = "*" + runtime.shortVariableName(label).replace(/^\./, "");
            name.title = page.displayName(item.name);
            name.setAttribute("aria-label", name.title);
            const type = element("span", classes.type);
            type.textContent = item.typeName || item.type || "";
            type.title = type.textContent;
            const value = element("span", classes.value);
            copyOnClick(value);
            page.scalarCell(value, item.name);
            const leaf = { path: item.name, address: item.address, watchType: item.type };
            row.append(page.decorateLeaf(row, name, leaf), type, value);
            host.appendChild(row);
            const nested = pointerPointee(row, item.name, name.textContent, displayInfo(item));
            if (nested) host.appendChild(nested);
            runtime.setValueCell(value, scalarDisplay(item));
        }

        function renderLeaf(container, label, typeName, path, watchType, address, node, renderInline) {
            const row = element("div", classes.row);
            row.dataset.path = path;
            const name = element("span", classes.name);
            name.textContent = label;
            name.title = page.displayName(node?.displayPath || path);
            name.setAttribute("aria-label", name.title);
            const type = element("span", classes.type);
            type.textContent = typeName || watchType || "";
            type.title = type.textContent;
            const value = element("span", classes.value);
            value.displayNode = node;
            value.summaryPath = node?.summaryPath;
            copyOnClick(value);
            cells[path] = value;
            row.append(page.decorateLeaf(row, name, { path, address, watchType, node }), type, value);
            container.appendChild(row);
            const host = node?.isPointer && pointerPointee(row, path, label, node, renderInline);
            if (host) container.appendChild(host);
            runtime.setValueCell(value, formatNode(withLastPointer(node, path), path));
        }
        // Collapsible head and body of a nested composite; returns the body to render into.
        function nestShell(container, fieldName, typeName, path, displayPath = path) {
            const wrap = element("div", classes.nest);
            const head = element("div", classes.head);
            const open = !!state.expanded[path];
            const arrow = element("span", classes.arrow + (open ? " open" : ""));
            arrow.textContent = "▶";
            const name = element("span", classes.headName);
            name.textContent = fieldName;
            name.title = page.displayName(displayPath);
            const type = element("span", classes.headType);
            type.textContent = typeName || "";
            type.title = type.textContent;
            head.append(arrow, name, type);
            const body = element("div", classes.members + (open ? " open" : ""));
            head.onclick = () => {
                const next = !state.expanded[path];
                state.expanded[path] = next;
                body.classList.toggle("open", next);
                arrow.classList.toggle("open", next);
                page.save();
            };
            wrap.append(head, body);
            container.appendChild(wrap);
            return body;
        }
        function renderNest(container, layout, fieldName, path, baseAddr, offset, displayPath = path) {
            const body = nestShell(container, fieldName, layout.typeName, path, displayPath);
            renderLayout(body, layout, path, baseAddr, offset, null, displayPath);
        }
        // `range` ({ start, end }) shows a chosen slice of a top-level array; without one the first
        // page is shown and can grow.
        function renderLayout(container, layout, path, baseAddr, offset, range, displayPath = path) {
            if (!layout) return;
            const raw = showRaw(path);
            const promoted = !raw && runtime.summaryRow(layout, path, offset);
            if (promoted) {
                renderSummary(container, promoted, baseAddr, path);
                return;
            }
            const symbol = layoutSymbol(path);
            if (layout.kind === "struct" || layout.kind === "union" || layout.kind === "class") {
                const members = layout.members || [];
                for (const original of members) {
                    if (!runtime.memberVisible(original, raw)) continue;
                    const member = runtime.layoutBranch(symbol, original, runtime.layoutMemberPath(path, original));
                    const memberPath = runtime.layoutMemberPath(path, member);
                    const memberOffset = offset + (Number(member.offset) || 0);
                    const summary = !raw && runtime.summaryRow(member, memberPath, memberOffset);
                    if (summary) renderSummary(container, summary, baseAddr, member.name, member.typeName);
                    else if (member.unobservable)
                        page.layoutExpansion().render(
                            container,
                            { ...member, path: memberPath },
                            runtime.variableBaseName(path),
                            t
                        );
                    else if (member.compositeLayout && !member.name)
                        renderLayout(
                            container,
                            member.compositeLayout,
                            memberPath,
                            baseAddr,
                            memberOffset,
                            null,
                            displayPath
                        );
                    else if (member.compositeLayout)
                        renderNest(
                            container,
                            member.compositeLayout,
                            member.name,
                            memberPath,
                            baseAddr,
                            memberOffset,
                            runtime.layoutMemberPath(displayPath, member)
                        );
                    else if (member.watchType)
                        renderLeaf(
                            container,
                            member.name,
                            member.typeName || member.watchType,
                            memberPath,
                            member.watchType,
                            baseAddr + memberOffset,
                            {
                                ...member,
                                ...(displayPath !== path
                                    ? { displayPath: runtime.layoutMemberPath(displayPath, member) }
                                    : {})
                            }
                        );
                }
                if (!members.length) note(container, t("lw.compositeNoLayout"), "warning");
            } else if (layout.kind === "array") {
                const elementType = layout.elementType || {};
                const total = Number(layout.totalElements) || 0;
                const size = Number(elementType.byteSize) || 0;
                let start = 0;
                let end = runtime.arrayShownCount(total, state.arrayShown[path]);
                if (range) {
                    start = Math.max(0, Number(range.start) || 0);
                    end = Math.min(total, Number.isNaN(Number(range.end)) ? total : Number(range.end));
                    end = Math.min(end, start + 256);
                }
                if (!elementType.watchType && !elementType.compositeLayout && !elementType.unobservable) {
                    note(container, t("lw.compositeNoLayout"), "warning");
                    return;
                }
                for (let i = start; i < end; i++) {
                    const elementPath = path + "[" + i + "]";
                    const elementOffset = offset + i * size;
                    const item = runtime.layoutBranch(symbol, elementType, elementPath);
                    if (item.unobservable)
                        page.layoutExpansion().render(
                            container,
                            { ...item, path: elementPath },
                            runtime.variableBaseName(path),
                            t
                        );
                    else if (item.compositeLayout)
                        renderNest(
                            container,
                            item.compositeLayout,
                            "[" + i + "]",
                            elementPath,
                            baseAddr,
                            elementOffset,
                            displayPath + "[" + i + "]"
                        );
                    else
                        renderLeaf(
                            container,
                            "[" + i + "]",
                            elementType.typeName || elementType.watchType,
                            elementPath,
                            elementType.watchType,
                            baseAddr + elementOffset,
                            { ...item, ...(displayPath !== path ? { displayPath: displayPath + "[" + i + "]" } : {}) }
                        );
                }
                // A chosen range stays as chosen; the default first page can grow.
                if (total > end && range) note(container, t("lw.arrayMore", { n: total - end }));
                else if (total > end)
                    runtime.renderArrayMore(
                        container,
                        total - end,
                        t,
                        (count) => {
                            state.arrayShown[path] = end + count;
                            page.save();
                            page.rerender();
                        },
                        path,
                        page.displayName(displayPath)
                    );
            }
        }
        function renderSummary(container, summary, baseAddr, label, typeName) {
            const node = {
                ...summary.node,
                displayPath: summary.displayPath,
                summaryPath: summary.displayPath,
                functionEmpty: summary.empty
            };
            const layout = node.compositeLayout || ((node.members || node.elements || node.kind === "array") && node);
            if (node.unobservable)
                page.layoutExpansion().render(container, { ...node, path: summary.path }, baseName(summary.path), t);
            else if (layout)
                renderNest(container, layout, label, summary.path, baseAddr, summary.offset, summary.displayPath);
            else
                renderLeaf(
                    container,
                    label,
                    typeName || node.typeName || node.watchType,
                    summary.path,
                    node.watchType || node.type,
                    node.address ?? baseAddr + summary.offset,
                    node
                );
        }
        // Nested structs and array elements get a collapsible head, as in static layouts; base
        // classes, anonymous members and a pointer's own target stay flat.
        function renderRuntimeTree(container, tree, path, label = "value", promoted = false, nest = false) {
            if (!tree) return;
            const raw = showRaw(path);
            const summary = !promoted && !raw && runtime.summaryRow(tree, path);
            if (summary) {
                const target = { ...summary.node, displayPath: path, summaryPath: path, functionEmpty: summary.empty };
                if (target.members || target.elements) {
                    const wrap = element("div", classes.nest);
                    const head = element("button", classes.head + " summary-head");
                    head.type = "button";
                    head.textContent = label;
                    head.title = page.displayName(path);
                    const body = element("div", classes.members + (state.expanded[path] ? " open" : ""));
                    head.setAttribute("aria-expanded", String(!!state.expanded[path]));
                    head.onclick = () => {
                        const open = !state.expanded[path];
                        state.expanded[path] = open;
                        body.classList.toggle("open", open);
                        head.setAttribute("aria-expanded", String(open));
                        page.save();
                    };
                    renderRuntimeTree(body, target, summary.path, label, true);
                    wrap.append(head, body);
                    container.appendChild(wrap);
                } else renderRuntimeTree(container, target, summary.path, label, true);
                return;
            }
            const pointer = tree.isPointer || tree.valueText === "nullptr";
            const hasValue = Object.prototype.hasOwnProperty.call(tree, "value");
            if (nest && !pointer && !hasValue && (tree.members || tree.elements)) {
                const body = nestShell(container, label, tree.typeName, path, tree.displayPath || path);
                renderRuntimeTree(body, tree, path, label, promoted);
                return;
            }
            const renderMembers = (target) => {
                for (const member of tree.members || []) {
                    if (!runtime.memberVisible(member, raw)) continue;
                    const childPath = runtime.layoutMemberPath(path, member);
                    if (member.unobservable)
                        page.layoutExpansion().render(
                            target,
                            { ...member, path: childPath },
                            runtime.variableBaseName(path),
                            t
                        );
                    else
                        renderRuntimeTree(
                            target,
                            {
                                ...member,
                                ...(tree.displayPath
                                    ? { displayPath: runtime.layoutMemberPath(tree.displayPath, member) }
                                    : {})
                            },
                            childPath,
                            pointer && member.name === "value" ? "*" + label : member.name || "value",
                            false,
                            !!member.name &&
                                !member.isBase &&
                                !/^@base\d+$/.test(member.name) &&
                                !(pointer && member.name === "value")
                        );
                }
                if (tree.collapsed) note(target, t("lw.runtimeCollapsed"));
            };
            // A closed pointer keeps its disclosure: opening it asks the host to read the target.
            const inline = pointer && (tree.members?.length || tree.collapsed) ? renderMembers : null;
            if (pointer || hasValue)
                renderLeaf(
                    container,
                    label,
                    tree.typeName || tree.type || "",
                    path,
                    tree.type || (pointer ? "u32" : undefined),
                    tree.address,
                    { ...tree, ...(pointer ? { isPointer: true } : {}) },
                    inline
                );
            if (tree.members && !inline) renderMembers(container);
            else if (tree.elements)
                for (const item of tree.elements)
                    renderRuntimeTree(
                        container,
                        {
                            ...item,
                            ...(tree.displayPath ? { displayPath: tree.displayPath + "[" + item.index + "]" } : {})
                        },
                        path + "[" + item.index + "]",
                        "[" + item.index + "]",
                        false,
                        true
                    );
            if (tree.elements && tree.collapsed) note(container, t("lw.runtimeCollapsed"));
            if (tree.unobservable)
                page.layoutExpansion().render(container, { ...tree, path }, runtime.variableBaseName(path), t);
            else if (tree.unavailable)
                note(container, { title: page.displayName(path), ...runtime.unavailableNotice(tree, t) });
        }
        function renderRuntimeBody(body, sampled, name) {
            // Without a sample the type graph still yields the rows, so pointer rows keep their pointees.
            const tree =
                sampled ||
                runtime.placeholderRuntimeTree(
                    state.watch.find((item) => item.name === name),
                    pointers.shown()
                );
            const shape = JSON.stringify([showRaw(name), !sampled, runtime.displayTreeShape(tree)]);
            if (body.dataset.runtimeShape === shape) return;
            for (const path of Object.keys(cells)) if (body.contains(cells[path])) delete cells[path];
            runtime.resetVariableNotices(body, t, page.copy);
            body.textContent = "";
            body.dataset.runtimeShape = shape;
            if (tree?.truncated) note(body, t("lw.layoutPartial"), "warning");
            const symbol = layoutSymbol(name);
            renderRawMembersUi(body, sampled || symbol?.compositeLayout, name);
            renderRuntimeTree(body, tree, name);
            for (const entry of runtime.displayUnavailableRows(
                symbol?.compositeLayout,
                name,
                64,
                symbol,
                showRaw(name)
            ))
                page.layoutExpansion().render(body, entry, name, t);
            if (!sampled) note(body, t("lw.waitSamples"));
            runtime.finishVariableNotices(body);
        }
        // Fills the body of a composite watch card and returns the notices footer that follows it.
        function renderCompositeBody(body, item, range) {
            const footer = runtime.createVariableNotices(body, t, element("div"), page.copy, item.name);
            if (item.runtimeLayout) {
                bodies[item.name] = body;
                renderRuntimeBody(body, state.latest[item.name], item.name);
            } else {
                const layout = item.compositeLayout || {};
                renderRawMembersUi(body, layout, item.name);
                if (layout.truncated) note(body, t("lw.layoutPartial"), "warning");
                renderLayout(body, layout, item.name, Number(item.address) >>> 0, 0, range || null);
            }
            return footer;
        }
        function updateComposite(name) {
            const tree = state.latest[name];
            if (!tree) return;
            const nodes = new Map();
            const held = new Set();
            walkLeaves(tree, name, (path, node, stale) => {
                nodes.set(path, node);
                if (stale) held.add(path);
            });
            nodes.forEach((node, path) => {
                const cell = cells[path];
                if (!cell) return;
                const summary = cell.summaryPath && runtime.summaryRow(nodes.get(cell.summaryPath), cell.summaryPath);
                runtime.setValueCell(
                    cell,
                    formatNode(
                        { ...cell.displayNode, ...node, ...(summary ? { functionEmpty: summary.empty } : {}) },
                        path
                    )
                );
                if (held.has(path)) runtime.markValueHeld(cell, t);
            });
        }
        // A new sample of a runtime watch, already stored as its reading: remembers its pointer
        // targets and redraws its body when one is shown.
        function treeSampled(name, tree) {
            pointers.remember(runtime.pointerSnapshots(tree, name));
            const body = bodies[name];
            if (body) renderRuntimeBody(body, tree, name);
        }
        // A member watch shown by its composite's tree, or an expanded pointee's, instead of its own row.
        function isLeafChild(name) {
            const rootName = baseName(name);
            if (rootName === name) return false;
            const watch = state.watch;
            const parent = watch.find((item) => item.name === rootName && isComposite(item));
            if (parent)
                return (
                    !!cells[name] && !(parent.runtimeLayout && watch.find((item) => item.name === name)?.layoutExpanded)
                );
            return (
                !!cells[name] &&
                watch.some(
                    (item) => item.runtimeLayout && isComposite(item) && runtime.runtimeMemberRoute(name, item.name)
                )
            );
        }
        function collectLeaves(layout, name, baseAddr, options = {}) {
            return runtime.displayLayoutLeaves(layoutSymbol(name), layout, name, baseAddr, options);
        }
        function selectionLeaves(symbol, runtimeSelected) {
            const showRawMembers = showRaw(symbol.name);
            const statics = collectLeaves(symbol.compositeLayout, symbol.name, symbol.address, {
                showRaw: showRawMembers,
                includePointers: true
            });
            if (!runtimeSelected) return statics;
            const visible = runtime.displayRuntimeSelection(symbol, state.latest[symbol.name], showRawMembers);
            return (visible?.entries || []).concat(statics.filter((leaf) => leaf.layoutExpanded));
        }
        // Opened paths of each runtime object (pointer target, STL container), relative to its watch
        // name. While "sample expanded pointer parts only" is on, the host reads just these parts.
        // Nothing is sent before the host's watch list arrives, so a fresh view cannot clear them.
        function syncRuntimeExpansions() {
            if (!runtimeExpansionsLoaded) return;
            const value = runtime.runtimeExpansionPaths(state.watch, state.expanded, placed);
            const key = JSON.stringify(value);
            if (key === sentRuntimeExpansions) return;
            sentRuntimeExpansions = key;
            page.post({ type: "saveRuntimeExpansions", expansions: value });
        }

        return {
            pointers,
            formatNode,
            displayInfo,
            scalarDisplay,
            layoutSymbol,
            showRaw,
            note,
            renderRawMembersUi,
            pointerPointee,
            renderLayout,
            renderCompositeBody,
            updateComposite,
            treeSampled,
            isLeafChild,
            collectLeaves,
            selectionLeaves,
            syncRuntimeExpansions,
            runtimeExpansionsReady() {
                runtimeExpansionsLoaded = true;
            },
            // Starts a redraw of the watch list.
            reset() {
                displayInfos = new WeakMap();
                cells = Object.create(null);
                bodies = Object.create(null);
                placed = new Set();
                fallback = new Set();
            },
            get cells() {
                return cells;
            },
            get bodies() {
                return bodies;
            },
            get placed() {
                return placed;
            },
            get fallback() {
                return fallback;
            }
        };
    }

    return { fmtNum, fmtExact, isComposite, pointerReading, walkLeaves, createThrottle, create };
});
