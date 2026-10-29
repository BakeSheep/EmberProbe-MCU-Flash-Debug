"use strict";
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const runtime = factory(
        commonJs ? require("./elfDiagnostics") : root.EmberProbeElfDiagnostics,
        commonJs ? require("./notice") : root.EmberProbeNotice
    );
    if (commonJs) module.exports = runtime;
    else root.EmberProbeRuntime = runtime;
})(typeof globalThis === "object" ? globalThis : this, function (elfDiagnostics, notice) {
    const MAX_COMPOSITE_DEPTH = 32;
    const MAX_TYPE_ALIASES = 256;
    const MAX_LAYOUT_PATH_DEPTH = 256;
    const MAX_LAYOUT_VISITS = 65536;
    const SUPPORTED_TYPES = ["u8", "i8", "u16", "i16", "u32", "i32", "f32", "u64", "i64", "f64"];
    const WIDTHS = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 };
    // Shared warning triangle (notices and write-risk markers); styled through the given class.
    function warningIconSvg(className) {
        return notice.noticeIconSvg("warning", className);
    }
    function typeByteLength(type) {
        return WIDTHS[type] || 4;
    }
    function defaultType(size) {
        return size === 1 ? "u8" : size === 2 ? "u16" : size === 8 ? "u64" : "u32";
    }
    // Compilation-unit scope of an internal-linkage variable, in GDB style: 'dir/file.c'::name,
    // "file.c"::name, file.c::name, dir/file.c::name, or the symbol address 0x2000abcd::name.
    // An unquoted scope must end in a file extension (or be an address), so C++ names such as
    // ns::value never parse as scoped.
    const UNQUOTED_SCOPE = /^[\w.+~/\\-]{1,512}$/;
    const ADDRESS_SCOPE = /^0x[0-9a-fA-F]{1,8}$/;
    function plainScope(file) {
        return UNQUOTED_SCOPE.test(file) && (/\.[A-Za-z0-9_+]+$/.test(file) || ADDRESS_SCOPE.test(file));
    }
    function variableScope(name) {
        const text = String(name || "");
        let file, length;
        if (text[0] === "'" || text[0] === '"') {
            const end = text.indexOf(text[0], 1);
            if (end < 2 || end > 1025 || text.slice(end + 1, end + 3) !== "::") return null;
            file = text.slice(1, end);
            if (/[\x00-\x1f]/.test(file)) return null;
            length = end + 3;
        } else {
            const end = text.indexOf("::");
            if (end < 1 || !plainScope((file = text.slice(0, end)))) return null;
            length = end + 2;
        }
        return /^[A-Za-z_]/.test(text.slice(length)) ? { file, name: text.slice(length), prefixLength: length } : null;
    }
    // Canonical scoped name; quoted only when the scope cannot be written bare. Null when unrepresentable.
    function scopedVariableName(file, name) {
        if (plainScope(file)) return file + "::" + name;
        if (!file || file.length > 1024 || /[\x00-\x1f]/.test(file)) return null;
        if (!file.includes("'")) return "'" + file + "'::" + name;
        return file.includes('"') ? null : '"' + file + '"::' + name;
    }
    function variableBaseName(name) {
        let depth = 0;
        const scope = variableScope(name);
        for (let index = scope ? scope.prefixLength : 0; index < name.length; index++) {
            if (name[index] === "<") depth++;
            else if (name[index] === ">") depth--;
            else if (!depth && (name[index] === "." || name[index] === "[")) {
                const suffix = name.slice(index).match(/^\.\d+(?=\.|\[|$)/);
                if (suffix) index += suffix[0].length - 1;
                else return name.slice(0, index);
            }
        }
        return name;
    }
    function variableDisplayName(item, symbols) {
        const name = item.name || "";
        const lookup = (key) =>
            typeof symbols?.get === "function" ? symbols.get(key) : symbols?.find((symbol) => symbol.name === key);
        const direct = lookup(name);
        // Initial ELF chunks use the raw linkage name as a placeholder. They must not replace
        // a readable name already attached to a saved/runtime watch entry while DWARF loads.
        if (direct?.displayName && direct.displayName !== name) return direct.displayName;
        const baseName = variableBaseName(name);
        const base = lookup(baseName);
        if (baseName !== name && base?.displayName && base.displayName !== baseName)
            return base.displayName + name.slice(baseName.length);
        return item.displayName || name;
    }
    // Lists keep compilation-unit scope secondary, while the identity remains the raw symbol name.
    function renderSymbolName(element, name, symbol) {
        element.classList.remove("source-qualified-name");
        const scope = variableScope(name);
        if (!scope) {
            renderVariableName(element, name, symbol.name);
            return;
        }
        element.textContent = "";
        element.classList.remove("qualified-name");
        element.classList.add("source-qualified-name");
        const label = element.ownerDocument.createElement("span");
        label.className = "symbol-name-label";
        label.textContent = scope.name;
        const source = element.ownerDocument.createElement("span");
        source.className = "symbol-source";
        source.textContent = scope.file;
        element.append(label, source);
        element.dataset.rawName = symbol.name;
        element.setAttribute("aria-label", name);
        element.title = name + (symbol.sourceFile ? "\n" + symbol.sourceFile : "");
        if (Number.isFinite(symbol.address)) element.title += "\n0x" + symbol.address.toString(16).toUpperCase();
        else if (/^0x[\da-f]+$/i.test(symbol.address || "")) element.title += "\n" + symbol.address;
    }
    function variableNameParts(name) {
        let depth = 0;
        const scope = variableScope(name);
        let split = scope ? scope.prefixLength : 0;
        for (let index = split; index < name.length; index++) {
            if (name[index] === "<" || name[index] === "[") depth++;
            else if (name[index] === ">" || name[index] === "]") depth--;
            else if (!depth && name[index] === ".") split = index + 1;
            else if (!depth && name.slice(index, index + 2) === "::") split = ++index + 1;
        }
        return split > 0 && split < name.length
            ? { prefix: name.slice(0, split), leaf: name.slice(split) }
            : { prefix: "", leaf: name };
    }
    function shortVariableName(name) {
        const parts = variableNameParts(name);
        return (parts.prefix ? "." : "") + parts.leaf;
    }
    // Shortest qualified suffixes that keep every name distinct: a.x.Ref and b.y.Ref become .x.Ref and .y.Ref.
    function uniqueShortVariableNames(names) {
        const suffixes = names.map((name) => {
            const out = [];
            let rest = name,
                tail = "";
            for (;;) {
                const parts = variableNameParts(rest);
                tail = parts.leaf + tail;
                out.push(tail);
                if (!parts.prefix) return out;
                const separator = parts.prefix.endsWith("::") ? "::" : ".";
                rest = parts.prefix.slice(0, -separator.length);
                tail = separator + tail;
            }
        });
        const depth = names.map(() => 0);
        for (let changed = true; changed;) {
            changed = false;
            const counts = new Map();
            suffixes.forEach((list, index) => {
                const label = list[depth[index]];
                counts.set(label, (counts.get(label) || 0) + 1);
            });
            suffixes.forEach((list, index) => {
                if (counts.get(list[depth[index]]) > 1 && depth[index] < list.length - 1) {
                    depth[index]++;
                    changed = true;
                }
            });
        }
        return suffixes.map((list, index) => {
            const label = list[depth[index]];
            return label === names[index] ? label : (label.startsWith(".") ? "" : ".") + label;
        });
    }
    function renderVariableName(element, name, rawName = name) {
        const parts = variableNameParts(name);
        element.textContent = "";
        element.classList.toggle("qualified-name", !!parts.prefix);
        if (parts.prefix) {
            const prefix = element.ownerDocument.createElement("span");
            prefix.className = "variable-name-prefix";
            prefix.textContent = parts.prefix;
            const leaf = element.ownerDocument.createElement("span");
            leaf.className = "variable-name-leaf";
            leaf.textContent = parts.leaf;
            element.append(prefix, leaf);
        } else element.textContent = name;
        element.title = name;
        element.dataset.rawName = rawName;
        element.setAttribute("aria-label", name);
    }
    // Detached subroots are selected by concrete symbol path, never merged into the root.
    function layoutBranch(symbol, node, path) {
        const expanded = symbol?.layoutExpansions?.[path];
        if (
            !expanded ||
            !Number.isSafeInteger(symbol.layoutExpansionGeneration) ||
            expanded.byteSize !== node?.byteSize ||
            !node?.expansionHandle ||
            !["depth-limit", "expansion-budget"].includes(node.unobservable) ||
            symbol.layoutExpansionGeneration !== symbol.compositeLayout?.expansionGeneration ||
            expanded.expansionGeneration !== symbol.layoutExpansionGeneration
        )
            return node;
        const { unobservable, expansionHandle, ...identity } = node;
        return { ...identity, compositeLayout: expanded, expansionRoot: true };
    }
    function formatPointer(value) {
        const number = typeof value === "number" || typeof value === "bigint" ? Number(value) : NaN;
        if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) return null;
        return "0x" + number.toString(16).toUpperCase().padStart(8, "0");
    }
    // Library objects (std::atomic, std::array, std::function...) keep their meaningful value
    // in one internal member. Return the member route to it, through bases and internal members.
    function summaryRoute(node, summary = (node?.compositeLayout || node)?.stdSummary) {
        if (!summary?.targets?.length) return null;
        const pending = [{ node, route: [] }];
        let visits = 0;
        while (pending.length && ++visits <= 256) {
            const { node: current, route } = pending.shift();
            const container = current?.compositeLayout || current;
            for (const member of container?.members || []) {
                if (summary.targets.includes(member.name)) return [...route, member];
                if (
                    (member.isBase || member.memberRole || member.name === "") &&
                    (member.compositeLayout || member.members) &&
                    route.length < 8
                )
                    pending.push({ node: member, route: [...route, member] });
            }
        }
        return null;
    }
    function memberVisible(member, showRaw = false) {
        return !!showRaw || !member?.memberRole;
    }
    // Unqualified symbol name for compact pointer targets: `lab::g_widgets` -> `g_widgets`.
    // Qualifiers inside template arguments or parameter lists stay untouched.
    function shortSymbolName(name) {
        const text = String(name || "");
        let depth = 0;
        let split = 0;
        for (let index = 0; index < text.length; index++) {
            const char = text[index];
            if (char === "<" || char === "(" || char === "[") depth++;
            else if (char === ">" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
            else if (!depth && text.startsWith("::", index)) split = ++index + 1;
        }
        return text.slice(split) || text;
    }
    function hexOffset(offset) {
        return Number.isSafeInteger(offset) && offset > 0 ? "+0x" + offset.toString(16).toUpperCase() : "";
    }
    // Target text from host pointerInfo; `full` keeps qualified names for the tooltip.
    function pointerTargetText(info, full) {
        const name = (value) => (full ? String(value || "") : shortSymbolName(value));
        if (info.kind === "data")
            return (
                "&" +
                name(info.name) +
                (typeof info.memberPath === "string"
                    ? info.memberPath + hexOffset(info.memberOffset)
                    : Number.isInteger(info.index)
                      ? "[" + info.index + "]"
                      : hexOffset(info.offset))
            );
        if (info.kind === "function") {
            const base = name(info.name);
            const bare = full ? base : base.replace(/\(.*$/s, "");
            return info.offset ? bare + hexOffset(info.offset) : full || /\(/.test(bare) ? bare : bare + "()";
        }
        if (info.kind === "vtable") return name(info.dynamicTypeName || info.name);
        if (info.kind === "peripheral") return "&" + info.name + hexOffset(info.offset);
        return "";
    }
    const LEGACY_POINTER_REGIONS = new Set(["Flash", "RAM", "Peripheral", "System", "invalid"]);
    // Compact pointer cell: the target replaces the address, which stays in the tooltip
    // and is what a click copies. Addresses without a symbol remain the only information.
    function pointerLabel(node, t) {
        const label = pointerTargetLabel(node, t);
        if (!node?.stale || !label.copy) return label;
        const { isNull, ...rest } = label;
        return { ...rest, stale: true, title: (label.title || label.text) + " · " + t("lw.pointerLastSampled") };
    }
    function pointerTargetLabel(node, t) {
        const value = pointerNodeValue(node);
        const hex = formatPointer(value);
        if (!hex) return { text: "—", title: "—" };
        if (Number(value) === 0) return { text: t("lw.pointerNull"), title: hex, copy: hex, isNull: true };
        if (typeof node.pointerString === "string" && node.pointerString)
            return { text: node.pointerString, title: hex + " → " + node.pointerString, copy: hex };
        const info = node.pointerInfo;
        if (info && ["data", "function", "vtable", "peripheral"].includes(info.kind) && info.name)
            return {
                text: pointerTargetText(info, false),
                title: hex + " → " + pointerTargetText(info, true),
                copy: hex
            };
        if (info?.kind === "region")
            return { text: hex, title: hex + " → " + t("lw.pointerRegion." + info.region), copy: hex };
        if (info?.kind === "invalid")
            return { text: hex, title: hex + " → " + t("lw.pointerInvalid"), copy: hex, invalid: true };
        const legacy = typeof node.pointerText === "string" ? node.pointerText.trim().replace(/^→\s*/, "") : "";
        if (legacy && !LEGACY_POINTER_REGIONS.has(legacy))
            return { text: legacy, title: hex + " " + node.pointerText.trim(), copy: hex };
        return { text: hex, title: hex, copy: hex };
    }
    function pointerDisplay(value, t, pointerText, pointerInfo) {
        return pointerLabel({ value, pointerText, pointerInfo }, t).text;
    }
    // Value cells accept plain text or a pointerLabel() result. Pointer rows mirror the
    // NULL state so their expansion toggle and pointee hide while there is no target.
    function setValueCell(cell, display) {
        const label = typeof display === "object" && display ? display : { text: String(display ?? "") };
        const title = label.title || label.text;
        if (cell.textContent !== label.text) cell.textContent = label.text;
        if (cell.title !== title) cell.title = title;
        if (label.copy) cell.dataset.copy = label.copy;
        else delete cell.dataset.copy;
        cell.classList.toggle("pointer-invalid", !!label.invalid);
        cell.classList.toggle("pointer-stale", !!label.stale);
        const row = cell.parentElement;
        if (row?.classList.contains("pointer-row")) row.classList.toggle("pointer-null", !!label.isNull);
    }
    // A value the host held from an earlier sample while the target changed it mid-read: dimmed like a
    // last-sampled pointer, with the same tooltip. The next setValueCell clears it.
    function markValueHeld(cell, t) {
        cell.classList.add("pointer-stale");
        const suffix = " · " + t("lw.pointerLastSampled");
        if (!cell.title.endsWith(suffix)) cell.title += suffix;
    }
    function copyValueText(cell) {
        return cell.dataset.copy || cell.textContent;
    }
    function pointerNodeValue(node) {
        const value = node?.pointerValue ?? node?.value;
        if (value != null) return value;
        if (["nullptr", "NULL"].includes(node?.valueText)) return 0;
        return /^0x[0-9a-f]{1,8}$/i.test(node?.valueText || "") ? Number(node.valueText) : undefined;
    }
    // Labels may be promoted, but the returned path always addresses the original storage.
    function summaryRow(node, path, offset = 0) {
        const summary = (node?.compositeLayout || node)?.stdSummary;
        const route = summaryRoute(node);
        if (!route?.length) return null;
        let rawPath = path;
        for (const member of route) {
            rawPath = layoutMemberPath(rawPath, member);
            offset += Number(member.offset) || 0;
        }
        const presence = summary.presence && summaryRoute(node, { targets: summary.presence });
        return {
            node: route[route.length - 1],
            path: rawPath,
            offset,
            isConst:
                !!node.isConst ||
                !!node.compositeLayout?.isConst ||
                route.some((member) => member.isConst || member.compositeLayout?.isConst),
            displayPath: path,
            kind: summary.kind,
            empty: summary.kind === "function" && presence?.[presence.length - 1]?.value === 0
        };
    }
    function displayTreeShape(tree) {
        const flags = (node, depth = 0) =>
            node && depth <= MAX_COMPOSITE_DEPTH
                ? [
                      node.isPointer,
                      node.memberRole,
                      node.stdSummary,
                      node.collapsed,
                      node.members?.map((member) => flags(member, depth + 1)),
                      node.elements?.map((element) => flags(element, depth + 1))
                  ]
                : null;
        return JSON.stringify([runtimeTreeShape(tree), flags(tree)]);
    }
    function displayUnavailableRows(layout, path, maxEntries = 64, symbol, showRaw = false) {
        if (showRaw) return layoutUnavailableRows(layout, path, maxEntries, symbol);
        const rows = [];
        const pending = [{ node: layout, path, depth: 0 }];
        let visits = 0;
        while (pending.length && rows.length < maxEntries && ++visits <= MAX_LAYOUT_VISITS) {
            const current = pending.pop();
            const node = layoutBranch(symbol, current.node, current.path);
            if (!node || current.depth > MAX_LAYOUT_PATH_DEPTH) continue;
            if (node.unobservable) {
                rows.push({
                    path: current.path,
                    unobservable: node.unobservable,
                    expansionHandle: node.expansionHandle
                });
                continue;
            }
            const summary = summaryRow(node, current.path);
            if (summary) pending.push({ node: summary.node, path: summary.path, depth: current.depth + 1 });
            else if (node.compositeLayout)
                pending.push({ ...current, node: node.compositeLayout, depth: current.depth + 1 });
            else if (node.kind === "array") {
                for (let index = Math.min(Number(node.totalElements) || 0, 16) - 1; index >= 0; index--)
                    pending.push({ ...current, node: node.elementType, path: current.path + "[" + index + "]" });
            } else
                for (let index = (node.members || []).length - 1; index >= 0; index--) {
                    const member = node.members[index];
                    if (memberVisible(member))
                        pending.push({
                            node: member,
                            path: layoutMemberPath(current.path, member),
                            depth: current.depth
                        });
                }
        }
        return rows;
    }
    function hiddenMemberCount(node) {
        let count = 0;
        let visits = 0;
        const walk = (current, depth = 0) => {
            if (!current || depth > MAX_COMPOSITE_DEPTH || ++visits > MAX_LAYOUT_VISITS) return;
            const container = current.compositeLayout || current;
            const promoted = summaryRoute(container)?.at(-1);
            for (const member of container.members || container.fields || []) {
                if (member.memberRole && member !== promoted) count++;
                walk(member, depth + 1);
            }
            for (const element of container.elements || []) walk(element, depth + 1);
            if (container.elementType) walk(container.elementType, depth + 1);
        };
        walk(node);
        return count;
    }
    let variableNoticeSequence = 0;
    // Opened notice groups, by footer state key and group, so a re-rendered card keeps them open.
    const openNoticeGroups = new Set();
    // A render root owns its footer even while detached. Nested member rows route to that root;
    // inline pointee bodies can own independent scopes so a sample only replaces their own state.
    // stateKey (the variable name) keeps opened notice groups across re-renders of the same card.
    function createVariableNotices(root, t, footer, onCopy, stateKey) {
        let inherited;
        for (
            let current = root.parentElement || root.variableNoticeParent;
            current;
            current = current.parentElement || current.variableNoticeParent
        ) {
            if (current.variableNotices) {
                inherited = current.variableNotices;
                break;
            }
        }
        if (!footer && inherited) {
            root.variableNotices = {
                root,
                footer: inherited.footer,
                area: inherited.area,
                shared: inherited.shared,
                prefix: inherited.prefix + ++variableNoticeSequence + "-",
                ownsFooter: false
            };
            return inherited.footer;
        }
        footer ||= root.ownerDocument.createElement("div");
        footer.classList.add("variable-notices");
        const groupKey = (key) => JSON.stringify([stateKey, key]);
        const area = notice.createNoticeArea(footer, {
            t,
            onAction: (action) => action.run?.(),
            onCopy,
            isGroupOpen: (key) => stateKey != null && openNoticeGroups.has(groupKey(key)),
            onGroupToggle: (key, open) => {
                if (stateKey == null) return;
                if (open) openNoticeGroups.add(groupKey(key));
                else openNoticeGroups.delete(groupKey(key));
            }
        });
        // shared: notice id -> (owning scope prefix -> payload). Card-wide states (waiting, hidden
        // members, partial layout) are shown once per footer however many pointee scopes report them.
        const scope = {
            root,
            footer,
            area,
            shared: new Map(),
            prefix: "variable-" + ++variableNoticeSequence + "-",
            ownsFooter: true
        };
        root.variableNotices = scope;
        return footer;
    }
    function showSharedNotice(scope, id) {
        const payloads = [...scope.shared.get(id).values()];
        const merged = payloads[0].merge ? payloads[0].merge(payloads) : payloads[0];
        return scope.area.set(id, { level: "info", compact: true, dismissible: false, ...merged });
    }
    function variableNoticeScope(container, t) {
        for (let current = container; current; current = current.parentElement || current.variableNoticeParent)
            if (current.variableNotices) return current.variableNotices;
        createVariableNotices(container, t);
        container.append(container.variableNotices.footer);
        return container.variableNotices;
    }
    function resetVariableNotices(root, t, onCopy) {
        if (!root.variableNotices) createVariableNotices(root, t, undefined, onCopy);
        const scope = root.variableNotices;
        if (scope.ownsFooter) {
            scope.shared.clear();
            scope.area.clearAll();
            return;
        }
        for (const id of scope.area.ids()) if (id.startsWith(scope.prefix)) scope.area.clear(id);
        // A shared notice stays while another scope still reports it.
        for (const [id, owners] of scope.shared) {
            const before = owners.size;
            for (const prefix of [...owners.keys()]) if (prefix.startsWith(scope.prefix)) owners.delete(prefix);
            if (owners.size === before) continue;
            if (owners.size) showSharedNotice(scope, id);
            else {
                scope.shared.delete(id);
                scope.area.clear(id);
            }
        }
    }
    function finishVariableNotices(root) {
        const footer = root.variableNotices?.footer;
        // External card footers stay outside the collapsible body; inline scopes append locally.
        if (root.variableNotices?.ownsFooter && footer && (!footer.parentElement || footer.parentElement === root))
            root.append(footer);
    }
    // An untitled notice describes the whole card, so it is shared: a pointee body that reports the
    // same text adds no second box. Titled notices name a path; equal ones fold into one group.
    // options.shared forces sharing under an explicit id (its payload may merge the reports).
    function renderVariableNotice(container, message, t, id, options = {}) {
        const scope = variableNoticeScope(container, t);
        const payload = typeof message === "string" ? { text: message } : message;
        const key = id || JSON.stringify([payload.title, payload.text]);
        let node;
        if (options.shared || (!id && !payload.title)) {
            const sharedId = "shared:" + key;
            if (!scope.shared.has(sharedId)) scope.shared.set(sharedId, new Map());
            scope.shared.get(sharedId).set(scope.prefix, payload);
            node = showSharedNotice(scope, sharedId);
        } else {
            const level = payload.level || "info";
            node = scope.area.set(scope.prefix + key, {
                level,
                compact: true,
                dismissible: false,
                // A loading row stays on its own, beside the group it came from.
                group: payload.title && !payload.busy ? JSON.stringify([level, payload.text]) : "",
                ...payload
            });
        }
        // All presentation comes from notice.css; callers may retain semantic query hooks.
        finishVariableNotices(scope.root);
        return node;
    }
    function renderMemberVisibility(container, node, name, showRaw, t, toggle) {
        const hidden = showRaw ? 0 : hiddenMemberCount(node);
        if (!showRaw && !hidden) return;
        // Pointee bodies share their card's raw-member switch, so their counts join one notice.
        const base = variableBaseName(name);
        renderVariableNotice(
            container,
            {
                text: { key: showRaw ? "lw.rawMembersVisible" : "lw.hiddenMembers", params: { n: hidden } },
                actions: [{ label: { key: showRaw ? "lw.hideRawMembers" : "lw.showRawMembers" }, run: toggle }],
                merge: (payloads) => ({
                    ...payloads[0],
                    text: {
                        ...payloads[0].text,
                        params: { n: payloads.reduce((sum, entry) => sum + entry.text.params.n, 0) }
                    }
                }),
                decorate: (row) => {
                    row.classList.add("member-visibility");
                    row.querySelector(".notice-text").classList.add("hidden-members");
                    const button = row.querySelector(".notice-action");
                    button.classList.add("raw-members-toggle");
                    button.dataset.variableName = base;
                    button.setAttribute("aria-pressed", String(!!showRaw));
                }
            },
            t,
            "members:" + base,
            { shared: true }
        );
    }
    // Static array rows start at 16 elements; each click reveals the next page.
    const ARRAY_PAGE = 64;
    function arrayShownCount(total, shown) {
        return Math.min(Number(total) || 0, Math.max(16, Number(shown) || 0));
    }
    function renderArrayMore(container, remaining, t, more, path = "", displayPath = path) {
        renderVariableNotice(
            container,
            {
                title: displayPath,
                text: { key: "lw.arrayMore", params: { n: remaining } },
                actions: [
                    {
                        label: { key: "lw.arrayShowMore", params: { n: Math.min(remaining, ARRAY_PAGE) } },
                        run: () => more(ARRAY_PAGE)
                    }
                ],
                decorate: (row) => row.classList.add("array-more")
            },
            t,
            "array:" + path
        );
    }
    // Display-only collection. Bulk chart collection keeps pointers and raw internals out.
    function displayLayoutLeaves(symbol, layout, name, baseAddr, options = {}) {
        const out = [];
        const { showRaw = false, includePointers = false, maxArray = 16 } = options;
        const maxDepth = symbol?.layoutExpansions ? MAX_LAYOUT_PATH_DEPTH : MAX_COMPOSITE_DEPTH;
        let visits = 0;
        const walk = (node, path, offset, labelPath, depth = 0, flags = {}) => {
            if (!node || node.unobservable || depth > maxDepth || out.length >= 1000 || ++visits > MAX_LAYOUT_VISITS)
                return;
            flags = { ...flags, isConst: flags.isConst || !!node.isConst };
            const promoted = !showRaw && summaryRow(node, path, offset);
            if (promoted) {
                walk(promoted.node, promoted.path, promoted.offset, labelPath, depth + 1, {
                    ...flags,
                    isConst: flags.isConst || promoted.isConst
                });
                return;
            }
            if (node.compositeLayout) {
                walk(node.compositeLayout, path, offset, labelPath, depth, flags);
            } else if (node.kind === "array") {
                const elementType = node.elementType || {};
                for (let index = 0; index < Math.min(Number(node.totalElements) || 0, maxArray); index++) {
                    const childPath = path + "[" + index + "]";
                    const element = layoutBranch(symbol, elementType, childPath);
                    walk(
                        element,
                        childPath,
                        offset + index * (Number(elementType.byteSize) || 0),
                        labelPath + "[" + index + "]",
                        depth + 1,
                        { ...flags, layoutExpanded: flags.layoutExpanded || !!element.expansionRoot }
                    );
                }
            } else if (node.members) {
                for (const original of node.members) {
                    if (!memberVisible(original, showRaw)) continue;
                    const childPath = layoutMemberPath(path, original);
                    const member = layoutBranch(symbol, original, childPath);
                    walk(
                        member,
                        childPath,
                        offset + (Number(member.offset) || 0),
                        layoutMemberPath(labelPath, member),
                        depth + 1,
                        { ...flags, layoutExpanded: flags.layoutExpanded || !!member.expansionRoot }
                    );
                }
            } else if (node.watchType && (includePointers || !node.isPointer)) {
                out.push({
                    path,
                    label: labelPath.slice(name.length),
                    ...(labelPath !== path ? { displayPath: labelPath, displayName: labelPath } : {}),
                    address: (Number(baseAddr) + offset) >>> 0,
                    size: Number(node.byteSize) || typeByteLength(node.watchType),
                    type: node.watchType,
                    typeName: node.typeName || node.watchType,
                    ...(node.isPointer ? { isPointer: true, pointerTarget: node.pointerTarget } : {}),
                    ...(flags.layoutExpanded
                        ? { layoutExpanded: true, staticRuntimeStorage: !!symbol?.runtimeLayout }
                        : {}),
                    ...(node.enumEncodingInferred ? { enumEncodingInferred: true } : {}),
                    ...(node.isBoolean ? { isBoolean: true } : {}),
                    ...(Number.isInteger(node.bitSize) ? { bitSize: node.bitSize, bitOffset: node.bitOffset } : {}),
                    ...(flags.isConst ? { isConst: true } : {}),
                    ...(node.isReference ? { isReference: true } : {}),
                    ...(node.isMemberPointer ? { isMemberPointer: true } : {})
                });
            }
        };
        walk(layout, name, 0, name);
        return out;
    }
    function displayRuntimeSelection(symbol, tree, showRaw = false) {
        const selection = runtimeSelection(symbol, tree);
        if (!selection) return null;
        const metadata = new Map();
        const promotedEntries = new Map();
        const graph = runtimeGraph(symbol);
        const promote = (node, segments, role) => {
            if (!node || showRaw || role || node.unavailable || node.unobservable || promotedEntries.size >= 200)
                return;
            const path =
                symbol.name +
                segments
                    .map((segment) => (segment.kind === "index" ? "[" + segment.index + "]" : "." + segment.name))
                    .join("");
            const summary = summaryRow(node, path);
            if (!summary) return;
            const route = summaryRoute(node);
            const entry = runtimeWatchEntry(summary.path, symbol, [
                ...segments,
                ...route.filter((member) => member.name).map((member) => ({ kind: "member", name: member.name }))
            ]);
            // The existing semantic-path validator remains authoritative for every recipe.
            if (!entry || entry.isComposite) return;
            promotedEntries.set(summary.path, {
                ...entry,
                path: summary.path,
                label: path.slice(symbol.name.length),
                displayPath: path,
                displayName: variableDisplayName({ name: path }, [symbol]),
                typeName: summary.node.typeName || entry.type,
                ...(summary.node.isPointer || ["pointer", "reference"].includes(summary.node.kind)
                    ? { isPointer: true, pointerTarget: summary.node.pointerTarget }
                    : {})
            });
        };
        let summaryVisits = 0;
        const summaryType = (id, depth = 0) => {
            const type = runtimeType(graph, id);
            if (!type || depth > 8 || ++summaryVisits > 256) return null;
            return {
                ...type,
                members: (type.fields || []).slice(0, 256).map((field) => ({
                    ...runtimeType(graph, field.type),
                    ...field,
                    ...(field.isBase || field.memberRole ? summaryType(field.type, depth + 1) : {}),
                    name: field.name,
                    memberRole: field.memberRole
                }))
            };
        };
        let visits = 0;
        const walk = (node, path, role, depth = 0, segments = []) => {
            if (!node || depth > MAX_COMPOSITE_DEPTH || ++visits > MAX_LAYOUT_VISITS) return;
            metadata.set(path, { ...node, memberRole: role || node.memberRole });
            promote(node, segments, role || node.memberRole);
            for (const member of node.members || [])
                walk(
                    member,
                    member.isBase || member.name === "?" || /^@base\d+$/.test(member.name)
                        ? path
                        : layoutMemberPath(path, member),
                    role || member.memberRole,
                    depth + 1,
                    member.name ? [...segments, { kind: "member", name: member.name }] : segments
                );
            for (const element of node.elements || [])
                walk(element, path + "[" + element.index + "]", role, depth + 1, [
                    ...segments,
                    { kind: "index", index: element.index }
                ]);
        };
        const walkType = (id, path, role, depth = 0, segments = []) => {
            const type = runtimeType(graph, id);
            if (!type || depth > MAX_COMPOSITE_DEPTH || ++visits > MAX_LAYOUT_VISITS) return;
            metadata.set(path, {
                memberRole: role,
                isPointer: ["pointer", "reference"].includes(type.kind),
                typeName: type.typeName
            });
            if (type.stdSummary) {
                summaryVisits = 0;
                promote(summaryType(id), segments, role);
            }
            if (type.stl) return;
            for (const field of type.fields || [])
                walkType(
                    field.type,
                    field.isBase || field.name === "?" ? path : layoutMemberPath(path, field),
                    role || field.memberRole,
                    depth + 1,
                    field.name ? [...segments, { kind: "member", name: field.name }] : segments
                );
            if (type.kind === "array")
                for (let index = 0; index < Math.min(type.count || 0, 16); index++)
                    walkType(type.target, path + "[" + index + "]", role, depth + 1, [
                        ...segments,
                        { kind: "index", index }
                    ]);
        };
        if (tree) walk(tree, symbol.name);
        else walkType(graph?.root, symbol.name);
        return {
            ...selection,
            entries: selection.entries
                .filter((entry) => memberVisible(metadata.get(entry.path), showRaw))
                .map((entry) => {
                    const info = metadata.get(entry.path);
                    return { ...entry, ...(info?.isPointer ? { isPointer: true, typeName: info.typeName } : {}) };
                })
                .filter((entry) => !promotedEntries.has(entry.path))
                .concat([...promotedEntries.values()])
                .slice(0, 200)
        };
    }
    function layoutMemberPath(path, member) {
        return member.name
            ? path + "." + member.name
            : member.unobservable || member.expansionRoot
              ? path + ".?"
              : path;
    }
    function* layoutArrayIndices(symbol, layout, path, start = 0, end = layout.totalElements) {
        if (!layout.elementType?.unobservable) {
            for (let index = start; index < end; index++) yield index;
            return;
        }
        const indices = new Set();
        for (const key of Object.keys(symbol?.layoutExpansions || {})) {
            if (!key.startsWith(path + "[")) continue;
            const suffix = key.slice(path.length).match(/^\[(\d+)\]$/);
            const index = suffix ? Number(suffix[1]) : -1;
            if (index >= start && index < end && !layoutBranch(symbol, layout.elementType, key)?.unobservable)
                indices.add(index);
        }
        yield* [...indices].sort((a, b) => a - b);
    }
    function layoutUnavailableRows(layout, path, maxEntries = 64, symbol) {
        const rows = [];
        const pending = [{ node: layout, path, depth: 0 }];
        let visits = 0;
        while (pending.length && rows.length < maxEntries && ++visits <= MAX_LAYOUT_VISITS) {
            const current = pending.pop();
            const node = layoutBranch(symbol, current.node, current.path);
            if (!node || current.depth > MAX_LAYOUT_PATH_DEPTH) continue;
            if (node.unobservable) {
                rows.push({
                    path: current.path,
                    unobservable: node.unobservable,
                    expansionHandle: node.expansionHandle
                });
                continue;
            }
            if (node.compositeLayout)
                pending.push({ ...current, node: node.compositeLayout, depth: current.depth + 1 });
            else if (node.kind === "array") {
                const shown = Math.min(Number(node.totalElements) || 0, 16);
                for (let index = shown - 1; index >= 0; index--)
                    pending.push({ ...current, node: node.elementType, path: current.path + "[" + index + "]" });
            } else
                for (let index = (node.members || []).length - 1; index >= 0; index--) {
                    const member = node.members[index];
                    pending.push({ node: member, depth: current.depth, path: layoutMemberPath(current.path, member) });
                }
        }
        return rows;
    }
    function layoutExpansionError(code, t) {
        return t(
            ["STALE_LAYOUT_HANDLE", "ELF_CHANGED"].includes(code)
                ? "lw.layoutStale"
                : ["DWARF_BUDGET_EXCEEDED", "LAYOUT_EXPANSION_LIMIT", "INVALID_COMPOSITE_LAYOUT"].includes(code)
                  ? "lw.layoutExpansionLimit"
                  : "lw.layoutExpansionFailed"
        );
    }
    function createLayoutExpansionUi({ post, version, generation, symbol, displayName, changed }) {
        const requests = new Map();
        const key = (name, path) => JSON.stringify([name, path]);
        return {
            reset() {
                requests.clear();
            },
            render(container, entry, name, t) {
                const pathLabel = displayName
                    ? displayName(entry.path)
                    : variableDisplayName({ name: entry.path }, [symbol(name)].filter(Boolean));
                const expandable =
                    entry.expansionHandle && ["depth-limit", "expansion-budget"].includes(entry.unobservable);
                const state = expandable && requests.get(key(name, entry.path));
                const stale =
                    expandable &&
                    generation?.() != null &&
                    symbol(name)?.compositeLayout?.expansionGeneration !== generation();
                const code = stale ? "STALE_LAYOUT_HANDLE" : state?.error;
                const limited = [
                    "STALE_LAYOUT_HANDLE",
                    "ELF_CHANGED",
                    "DWARF_BUDGET_EXCEEDED",
                    "LAYOUT_EXPANSION_LIMIT",
                    "INVALID_COMPOSITE_LAYOUT"
                ].includes(code);
                const message = {
                    title: pathLabel,
                    text: code ? layoutExpansionError(code, t) : unobservableReason(entry.unobservable, t),
                    level: state?.loading
                        ? "info"
                        : code
                          ? limited
                              ? "warning"
                              : "error"
                          : unobservableLevel(entry.unobservable),
                    busy: !!state?.loading,
                    actions: expandable
                        ? [
                              {
                                  label: { key: state?.loading ? "lw.layoutLoading" : "lw.layoutLoadMore" },
                                  run: () => {
                                      const id = key(name, entry.path);
                                      if (requests.get(id)?.loading || stale) return;
                                      const current = symbol(name);
                                      const request = {
                                          type: "expandLayout",
                                          name,
                                          path: entry.path,
                                          handle: entry.expansionHandle,
                                          generation: current?.compositeLayout?.expansionGeneration,
                                          version: version()
                                      };
                                      requests.set(id, { ...request, loading: true });
                                      post(request);
                                      changed();
                                  }
                              }
                          ]
                        : [],
                    decorate: (row) => {
                        row.classList.add("layout-expansion-row");
                        if (code)
                            row.querySelector(".notice-content > .notice-text").classList.add("layout-expansion-error");
                        if (expandable) {
                            const button = row.querySelector(".notice-action");
                            button.classList.add("layout-expand");
                            button.dataset.path = entry.path;
                            button.disabled = !!state?.loading || !!stale;
                        }
                    }
                };
                renderVariableNotice(container, message, t, "layout:" + entry.path);
            },
            receive(message) {
                if (message.version !== version() || (generation?.() != null && message.generation !== generation()))
                    return false;
                const current = symbol(message.name);
                if (!current || current.compositeLayout?.expansionGeneration !== message.generation) return false;
                const id = key(message.name, message.path);
                const request = requests.get(id);
                if (request && request.handle !== message.handle) return false;
                if (message.layout) {
                    current.layoutExpansionGeneration = message.generation;
                    current.layoutExpansions ||= Object.create(null);
                    current.layoutExpansions[message.path] = message.layout;
                    requests.delete(id);
                } else if (request) requests.set(id, { ...request, loading: false, error: message.code });
                else return false;
                changed();
                return true;
            }
        };
    }
    function unobservableReason(code, t) {
        const key =
            {
                "depth-limit": "lw.layoutDepthLimit",
                "expansion-budget": "lw.layoutExpansionBudget",
                "type-cycle": "lw.layoutTypeCycle",
                "virtual-base": "lw.layoutVirtualBase",
                "base-location": "lw.layoutLocationUnavailable",
                "member-location": "lw.layoutLocationUnavailable"
            }[code] || "lw.compositeNoLayout";
        return t(key);
    }
    function unobservableLevel(code) {
        return code === "type-cycle" ? "error" : "warning";
    }
    function unavailableNotice(node, t) {
        const reason = node.unavailable;
        const keys = {
            "opaque-pointee": ["warning", "lw.pointeeOpaque"],
            "not-ram": ["warning", "lw.pointeeNotRam"],
            "memory-unavailable": ["error", "lw.pointeeMemoryUnavailable"],
            cycle: ["error", "lw.pointeeCycle"],
            "expansion-budget": ["warning", "lw.layoutExpansionBudget"],
            "depth-limit": ["warning", "lw.layoutDepthLimit"],
            changing: ["info", "lw.objectChanging"]
        };
        const detail = node.unavailableDetail ? { detail: String(node.unavailableDetail) } : {};
        if (node.unavailableCode === "LIVE_NULL_POINTER") return { level: "info", text: t("lw.pointeeNull") };
        // The cycle's budget is shared by the whole card, so every unread member shares one untitled notice.
        if (node.unavailableCode === "LIVE_READ_BUDGET_EXCEEDED")
            return { level: "warning", text: t("lw.objectReadBudget"), title: "", ...detail };
        const entry = keys[reason];
        return entry
            ? { level: entry[0], text: t(entry[1]), ...detail }
            : {
                  level: "error",
                  text: t("lw.pointeeUnavailable"),
                  detail: String(node.unavailableDetail || reason || "")
              };
    }
    function translate(tables, language, key, params) {
        const table = tables[language] || tables.zh || {};
        const value = table[key] ?? tables.zh?.[key] ?? key;
        return String(value).replace(/{([a-zA-Z0-9_]+)}/g, (_match, name) =>
            params?.[name] != null ? String(params[name]) : ""
        );
    }
    function runtimeWatchEntry(name, symbol, segments = []) {
        const graph = symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout;
        if (!graph) return null;
        const unwrap = (id) => {
            for (let depth = 0; depth < MAX_TYPE_ALIASES; depth++) {
                const type = graph.types[id];
                if (!type) return null;
                if (type.kind !== "alias") return type;
                id = type.target;
            }
            return null;
        };
        const rootType = unwrap(graph.root);
        if (!rootType) return null;
        // Aggregates containing STL use semantic reads too. Their unrelated raw pointers
        // stay as address values; only paths through STL may chase target storage.
        const hasPointerTypes = (graph.types || []).some(
            (entry) => entry?.kind === "pointer" || entry?.kind === "reference"
        );
        const hasContainers = runtimeContainsContainer(graph, graph.root);
        const field = (type, name) => runtimeFieldType(graph, type, name);
        const inherits = (type, base, seen = new Set()) => {
            if (!type || seen.has(type)) return false;
            if (type === base) return true;
            seen.add(type);
            return (type.fields || []).some((entry) => entry.isBase && inherits(unwrap(entry.type), base, seen));
        };
        const member = (type, name) => {
            const known = field(type, name);
            if (known) return known;
            if (!type?.fields?.some((entry) => entry.name.startsWith("_vptr"))) return null;
            const candidates = (graph.dynamicTypes || [])
                .map((entry) => unwrap(entry.type))
                .filter((entry) => inherits(entry, type))
                .map((entry) => field(entry, name))
                .filter(Boolean);
            return candidates.length &&
                candidates.every(
                    (entry) =>
                        entry.kind === candidates[0].kind &&
                        entry.typeName === candidates[0].typeName &&
                        entry.watchType === candidates[0].watchType &&
                        entry.byteSize === candidates[0].byteSize
                )
                ? candidates[0]
                : null;
        };
        let type = rootType;
        let enteredContainer = !!rootType.stl;
        // Raw pointers outside STL are followed only where the path explicitly dereferences
        // them (`.value` or `->`), one user-requested level at a time, and never into
        // void, function or declaration-only targets.
        let followed = false;
        for (const segment of segments) {
            if (!type) return null;
            if (["pointer", "reference"].includes(type.kind) && !enteredContainer) {
                const explicit =
                    segment.kind === "dereference" || (segment.kind === "member" && segment.name === "value");
                if (!explicit || (type.pointerTarget && type.pointerTarget !== "data")) return null;
                followed = true;
                type = unwrap(type.target);
                continue;
            }
            if (type.kind === "reference") type = unwrap(type.target);
            if (type?.kind === "pointer") {
                type = unwrap(type.target);
                if (segment.kind === "dereference" || (segment.kind === "member" && segment.name === "value")) continue;
            } else if (segment.kind === "dereference") return null;
            if (type?.stl) {
                enteredContainer = true;
                if (segment.kind === "index" || (segment.kind === "member" && segment.name === "value")) {
                    if (segment.kind === "index" && (!Number.isSafeInteger(segment.index) || segment.index < 0))
                        return null;
                    const named = ["unique_ptr", "shared_ptr", "weak_ptr", "optional", "variant"].includes(type.stl);
                    if ((segment.kind === "index" && named) || (segment.kind === "member" && !named)) return null;
                    if (/map$/.test(type.stl)) {
                        const pairs = graph.types.filter(
                            (entry) =>
                                entry.stl === "pair" &&
                                entry.args?.length === 2 &&
                                entry.args.every(
                                    (id, index) => unwrap(id)?.typeName === unwrap(type.args[index])?.typeName
                                )
                        );
                        type =
                            pairs.length &&
                            pairs.every(
                                (entry) => entry.typeName === pairs[0].typeName && entry.byteSize === pairs[0].byteSize
                            )
                                ? pairs[0]
                                : null;
                    } else if (type.stl === "tuple") type = unwrap(type.args?.[segment.index]);
                    else if (type.stl === "variant") {
                        const alternatives = type.args.map(unwrap);
                        type = alternatives.every((entry) => entry?.watchType === alternatives[0]?.watchType)
                            ? alternatives[0]
                            : null;
                    } else type = unwrap(type.args?.[0]);
                } else if (type.stl === "pair" && ["first", "second"].includes(segment.name))
                    type = unwrap(type.args[segment.name === "first" ? 0 : 1]);
                else return null;
            } else if (segment.kind === "index" && type?.kind === "array") {
                if (!Number.isSafeInteger(segment.index) || segment.index < 0 || segment.index >= type.count)
                    return null;
                type = unwrap(type.target);
            } else if (segment.kind === "member") type = member(type, segment.name);
            else return null;
        }
        if (!followed && hasPointerTypes && !hasContainers) return null;
        if (!followed && segments.some((segment) => segment?.kind === "dereference")) return null;
        if (type?.stl) enteredContainer = true;
        const rawPointer = !enteredContainer && ["pointer", "reference"].includes(type?.kind);
        if (type?.kind === "reference" && !rawPointer) type = unwrap(type.target);
        if (!type || type.unobservable || type.kind === "unavailable" || (type.kind === "scalar" && !type.watchType))
            return null;
        const named = variableDisplayName({ name }, [symbol]);
        const displayName = followed && /\.value$/.test(named) ? "*" + named.slice(0, -".value".length) : named;
        return {
            name,
            address: symbol.address,
            size: symbol.size,
            type: rawPointer ? "u32" : type.watchType || "",
            ...(segments.length && type.typeName ? { typeName: type.typeName } : {}),
            ...(rawPointer && type.kind === "pointer"
                ? { isPointer: true, pointerTarget: type.pointerTarget || "data" }
                : {}),
            isComposite: !rawPointer && type.kind !== "scalar",
            compositeLayout: symbol.compositeLayout || null,
            ...(symbol.layoutExpansions
                ? {
                      layoutExpansions: symbol.layoutExpansions,
                      layoutExpansionGeneration: symbol.layoutExpansionGeneration
                  }
                : {}),
            runtimeLayout: graph,
            runtimeSegments: segments,
            ...(followed || (hasContainers && !enteredContainer) ? { runtimeStaticPointers: true } : {}),
            ...(followed ? { derefPath: true } : {}),
            ...(displayName !== name ? { displayName } : {})
        };
    }
    // Member segments of a watch path (`a.b[2]->c`), after its base symbol name.
    function memberPathSegments(name) {
        const text = String(name || "");
        const base = variableBaseName(text);
        const rest = text.slice(base.length);
        const segments = [];
        const pattern = /\.(@base\d+|\?|[A-Za-z_]\w*)|\[(\d+)\]|->([A-Za-z_]\w*)/y;
        while (pattern.lastIndex < rest.length) {
            const match = pattern.exec(rest);
            if (!match || segments.length > MAX_LAYOUT_PATH_DEPTH) return null;
            if (match[1]) segments.push({ kind: "member", name: match[1] });
            else if (match[2] !== undefined) segments.push({ kind: "index", index: Number(match[2]) });
            else segments.push({ kind: "dereference" }, { kind: "member", name: match[3] });
        }
        return { base, segments };
    }
    // The read-only watch entry showing what one pointer row points to, or null when
    // the target cannot be dereferenced safely (null graph, void/function/incomplete).
    function pointerDerefEntry(path, symbol) {
        const parsed = memberPathSegments(path);
        if (!parsed || !symbol?.name || parsed.base !== symbol.name || !runtimeGraph(symbol)) return null;
        return runtimeWatchEntry(path + ".value", symbol, [...parsed.segments, { kind: "member", name: "value" }]);
    }
    // Member route (`.a.@base0.b`) of a runtime watch below another runtime object, or null.
    // Dereferences (`.value`) and indexes are not taken from the parent tree: the parent reads
    // pointers inside its target as addresses and bounds container elements.
    function runtimeMemberRoute(name, ancestor) {
        if (typeof name !== "string" || !ancestor || !name.startsWith(ancestor)) return null;
        const rest = name.slice(ancestor.length);
        const route = [];
        const pattern = /\.(@base\d+|[A-Za-z_]\w*)/y;
        while (pattern.lastIndex < rest.length) {
            const match = pattern.exec(rest);
            if (!match || match[1] === "value") return null;
            route.push(match[1]);
        }
        return route.length ? route : null;
    }
    // Watch entries created by expanding a pointer row: `<pointer path>.value`.
    function isPointeeEntry(item) {
        return !!item?.derefPath && /\.value$/.test(String(item.name || ""));
    }
    // Opened paths of each runtime object (pointer target, STL container) in a view, relative to its
    // watch name. While "sample expanded pointer parts only" is on, the host reads just these parts.
    function runtimeExpansionPaths(items, expanded, placedPointees) {
        const result = Object.create(null);
        const open = Object.keys(expanded).filter((key) => expanded[key]);
        let count = 0;
        for (const item of items) {
            if (!item?.runtimeLayout || !item.isComposite || ++count > 256) continue;
            const paths = [];
            if (expanded[item.name] || isPointeeEntry(item) || placedPointees.has(item.name)) paths.push("");
            for (const key of open)
                if (key.length > item.name.length && key.startsWith(item.name) && /^[.[]/.test(key[item.name.length]))
                    paths.push(key.slice(item.name.length));
            result[item.name] = paths.slice(0, 512);
        }
        return result;
    }
    function pointeeParentPath(name) {
        return String(name).slice(0, -".value".length);
    }
    // Entries nested below `name`: its own pointee chain (`name.value`, `name.value.x.value`...).
    function isPointeeDescendant(item, name) {
        const text = String(item?.name || "");
        return isPointeeEntry(item) && text.startsWith(name) && /^[.[]/.test(text.slice(name.length));
    }
    // Disclosure toggle placed first in a pointer row; the pointee body follows the row.
    function renderPointerToggle(row, path, open, t, onToggle, displayPath = path) {
        const button = row.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "pointer-toggle" + (open ? " open" : "");
        button.textContent = "\u25b6";
        button.title = t("lw.pointerTarget");
        button.setAttribute("aria-label", t("lw.pointerTarget") + ": " + displayPath);
        button.setAttribute("aria-expanded", String(!!open));
        button.dataset.path = path;
        button.onclick = (event) => {
            event.stopPropagation();
            event.preventDefault();
            onToggle();
        };
        row.classList.add("pointer-row", "has-pointee");
        row.prepend(button);
        return button;
    }
    function runtimeGraph(symbol) {
        return symbol?.runtimeLayout || symbol?.compositeLayout?.runtimeLayout || null;
    }
    function runtimeType(graph, id) {
        for (let depth = 0; graph && depth < MAX_TYPE_ALIASES; depth++) {
            const type = graph.types?.[id];
            if (!type || type.kind !== "alias") return type || null;
            id = type.target;
        }
        return null;
    }
    function runtimeContainsContainer(graph, id, seen = new Set(), depth = 0) {
        const type = runtimeType(graph, id);
        if (!type || type.unobservable || seen.has(type) || depth > MAX_COMPOSITE_DEPTH) return false;
        if (type.stl) return true;
        seen.add(type);
        if (type.kind === "array") return runtimeContainsContainer(graph, type.target, seen, depth + 1);
        // Pointers are storage values here, not owned nested objects.
        return (
            ["class", "union"].includes(type.kind) &&
            (type.fields || []).some((field) => runtimeContainsContainer(graph, field.type, seen, depth + 1))
        );
    }
    function runtimeFieldId(graph, type, name, seen = new Set(), depth = 0) {
        if (!type || type.unobservable || seen.has(type) || depth > MAX_COMPOSITE_DEPTH) return null;
        const direct = (type.fields || []).filter((field) => field.name === name && !field.unobservable);
        if (direct.length) return direct.length === 1 ? direct[0].type : null;
        const next = new Set(seen).add(type);
        const inherited = (type.fields || [])
            .filter((field) => field.isBase || field.name === "?")
            .map((field) => runtimeFieldId(graph, runtimeType(graph, field.type), name, next, depth + 1))
            .filter((id) => id != null);
        return inherited.length === 1 ? inherited[0] : null;
    }
    function runtimeFieldType(graph, type, name) {
        const id = runtimeFieldId(graph, type, name);
        return id == null ? null : runtimeType(graph, id);
    }
    // A rejected semantic path must never become a raw STL storage watch.
    function requiresRuntimePath(symbol, segments = []) {
        const graph = runtimeGraph(symbol);
        let type = runtimeType(graph, graph?.root);
        for (const segment of segments) {
            if (type?.stl) return true;
            if (segment.kind === "member") type = runtimeFieldType(graph, type, segment.name);
            else if (["index", "range", "all"].includes(segment.kind) && type?.kind === "array")
                type = runtimeType(graph, type.target);
            else return false;
        }
        return !!type && runtimeContainsContainer(graph, graph.types.indexOf(type));
    }
    // Pointer annotations of a sampled tree, keyed by watch path, so a reopened view can show
    // the last known targets until sampling runs again. Display hints only.
    function pointerSnapshots(tree, path, out = Object.create(null), limit = 512) {
        let visits = 0;
        const walk = (node, nodePath, depth) => {
            if (!node || depth > MAX_COMPOSITE_DEPTH || ++visits > MAX_LAYOUT_VISITS) return;
            if (node.isPointer && Object.keys(out).length < limit) {
                const value = pointerNodeValue(node);
                if (value != null && !node.unavailable)
                    out[nodePath] = {
                        value,
                        ...(node.valueText != null ? { valueText: node.valueText } : {}),
                        ...(node.pointerText ? { pointerText: node.pointerText } : {}),
                        ...(node.pointerInfo ? { pointerInfo: node.pointerInfo } : {}),
                        ...(node.pointerString ? { pointerString: node.pointerString } : {})
                    };
            }
            for (const member of node.members || []) walk(member, layoutMemberPath(nodePath, member), depth + 1);
            for (const element of node.elements || []) walk(element, nodePath + "[" + element.index + "]", depth + 1);
        };
        walk(tree, path, 0);
        return out;
    }
    // A value-less tree of a runtime watch built from its type graph. It gives pointer rows (and the
    // pointees saved below them) a place before the first sample; `remembered` supplies last known targets.
    function placeholderRuntimeTree(symbol, remembered = null) {
        const graph = runtimeGraph(symbol);
        if (!graph?.types) return null;
        let id = graph.root;
        for (const segment of symbol.runtimeSegments || []) {
            const type = runtimeType(graph, id);
            if (!type || type.unobservable || type.stl) return null;
            if (["pointer", "reference"].includes(type.kind)) {
                if (segment.kind !== "dereference" && !(segment.kind === "member" && segment.name === "value"))
                    return null;
                id = type.target;
            } else if (segment.kind === "index" && type.kind === "array") id = type.target;
            else if (segment.kind === "member") {
                id = runtimeFieldId(graph, type, segment.name);
                if (id == null) return null;
            } else return null;
        }
        let nodes = 0;
        const build = (typeId, path, depth) => {
            const type = runtimeType(graph, typeId);
            if (!type) return { kind: "unavailable", unobservable: "member-location" };
            // Same display node limit as the host's sampled trees (MAX_DISPLAY_NODES in runtimeObjectReader.js).
            if (depth > MAX_COMPOSITE_DEPTH || ++nodes > 1024)
                return {
                    kind: "unavailable",
                    unobservable: depth > MAX_COMPOSITE_DEPTH ? "depth-limit" : "expansion-budget"
                };
            if (type.unobservable)
                return { kind: "unavailable", typeName: type.typeName, unobservable: type.unobservable };
            const identity = { typeName: type.typeName, placeholder: true };
            if (["pointer", "reference"].includes(type.kind))
                return {
                    kind: "scalar",
                    type: "u32",
                    ...identity,
                    typeName: type.typeName || type.kind,
                    isPointer: true,
                    pointerTarget: type.pointerTarget,
                    value: null,
                    ...(remembered?.[path] ? { ...remembered[path], stale: true } : {})
                };
            if (type.stl || ["class", "union"].includes(type.kind))
                return {
                    kind: type.stl ? "class" : type.kind,
                    ...identity,
                    ...(type.stdSummary ? { stdSummary: type.stdSummary } : {}),
                    members: type.stl
                        ? []
                        : (type.fields || [])
                              .filter((field) => !field.name.startsWith("_vptr"))
                              .map((field) => ({
                                  name: field.name,
                                  ...(field.memberRole ? { memberRole: field.memberRole } : {}),
                                  // Matches the sampled tree, which reports such members as unavailable.
                                  ...(field.unobservable
                                      ? { kind: "unavailable", unobservable: field.unobservable }
                                      : build(field.type, layoutMemberPath(path, field), depth + 1))
                              }))
                };
            if (type.kind === "array") {
                const count = Math.min(Number(type.count) || 0, 16);
                return {
                    kind: "array",
                    ...identity,
                    totalElements: type.count,
                    partial: type.count > count,
                    elements: Array.from({ length: count }, (_unused, index) => ({
                        index,
                        ...build(type.target, path + "[" + index + "]", depth + 1)
                    }))
                };
            }
            if (type.kind === "scalar" && type.watchType)
                return { kind: "scalar", type: type.watchType, ...identity, value: null };
            return { kind: "unavailable", typeName: type.typeName, unobservable: "no-watch-type" };
        };
        const tree = build(id, symbol.name, 0);
        return tree.kind === "unavailable" ? null : tree;
    }
    function runtimeSelection(symbol, tree) {
        const graph = runtimeGraph(symbol);
        if (!runtimeContainsContainer(graph, graph?.root)) return null;
        const entries = [];
        const add = (segments) => {
            const suffix = segments.map((s) => (s.kind === "index" ? `[${s.index}]` : `.${s.name}`)).join("");
            const entry = runtimeWatchEntry(symbol.name + suffix, symbol, segments);
            if (entry && suffix && !entries.some((item) => item.path === entry.name))
                entries.push({ ...entry, path: entry.name, label: suffix, typeName: entry.type });
        };
        const walkTree = (node, segments, depth = 0) => {
            if (!node || node.unavailable || node.unobservable || depth > MAX_COMPOSITE_DEPTH || entries.length >= 200)
                return;
            if (Object.prototype.hasOwnProperty.call(node, "value")) add(segments);
            else {
                if (segments.length && requiresRuntimePath(symbol, segments)) add(segments);
                for (const member of node.members || [])
                    walkTree(
                        member,
                        member.name === "?" || /^@base\d+$/.test(member.name)
                            ? segments
                            : [...segments, { kind: "member", name: member.name }],
                        depth + 1
                    );
                for (const element of node.elements || [])
                    walkTree(element, [...segments, { kind: "index", index: element.index }], depth + 1);
            }
        };
        const walkType = (id, segments, depth = 0) => {
            const type = runtimeType(graph, id);
            if (!type || type.unobservable || depth > MAX_COMPOSITE_DEPTH || entries.length >= 200) return;
            if (type.stl && segments.length) add(segments);
            if (["scalar", "pointer", "reference"].includes(type.kind)) return add(segments);
            if (["unique_ptr", "shared_ptr", "weak_ptr", "optional"].includes(type.stl)) {
                const path = [...segments, { kind: "member", name: "value" }];
                add(path);
                return walkType(type.args?.[0], path, depth + 1);
            }
            if (type.stl === "variant") return add([...segments, { kind: "member", name: "value" }]);
            if (type.stl === "pair") {
                ["first", "second"].forEach((name, index) =>
                    walkType(type.args?.[index], [...segments, { kind: "member", name }], depth + 1)
                );
            } else if (type.stl === "tuple") {
                (type.args || []).forEach((id, index) =>
                    walkType(id, [...segments, { kind: "index", index }], depth + 1)
                );
            } else if (type.stl === "array" || type.kind === "array") {
                const array = type.stl
                    ? runtimeType(graph, type.fields?.find((f) => f.name === "_M_elems")?.type)
                    : type;
                for (let index = 0; index < Math.min(array?.count || 0, 16); index++)
                    walkType(array.target, [...segments, { kind: "index", index }], depth + 1);
            } else if (!type.stl) {
                for (const field of type.fields || []) {
                    if (field.name.startsWith("_vptr")) continue;
                    walkType(
                        field.type,
                        field.isBase || field.name === "?"
                            ? segments
                            : [...segments, { kind: "member", name: field.name }],
                        depth + 1
                    );
                }
            }
        };
        if (tree) walkTree(tree, []);
        else walkType(graph.root, []);
        return { entries, sampled: !!tree };
    }
    // Values change each sample; only changes to rows or their target addresses need new DOM.
    function runtimeTreeShape(tree) {
        const shape = (node) =>
            node
                ? [
                      node.kind,
                      node.name,
                      node.index,
                      node.type,
                      node.typeName,
                      node.address,
                      Object.prototype.hasOwnProperty.call(node, "value"),
                      node.unavailable,
                      node.unavailableCode,
                      node.unobservable,
                      node.truncated,
                      node.members?.map(shape),
                      node.elements?.map(shape)
                  ]
                : null;
        return JSON.stringify(shape(tree));
    }
    function renderElfDiagnostics(element, warnings, error, label, t) {
        if (!element) return;
        error = elfDiagnostics.formatDiagnostic(error, t);
        const entries = Array.isArray(warnings)
            ? [
                  ...new Set(
                      warnings.map((item) => elfDiagnostics.formatDiagnostic(item, t)).filter((item) => item.trim())
                  )
              ].slice(0, 64)
            : [];
        // A notice box: the first message is the text, the rest fold into its details panel.
        element.noticeArea ||= notice.createNoticeArea(element, { t });
        const lines = [...(error ? [error] : []), ...entries.filter((message) => message !== error)].map((message) =>
            String(message).slice(0, 2000)
        );
        if (!lines.length) return element.noticeArea.clear("elf");
        element.noticeArea.set("elf", {
            level: error ? "error" : "warning",
            title: label,
            text: lines[0],
            detail: lines.slice(1).join("\n"),
            dismissible: false
        });
    }
    // Only one aligned 32-bit word can be written while the core keeps running; anything else is written
    // as a short halt + read-modify-write transaction. Returns "" for non-halting writes.
    function writeHaltRisk(address, byteLength) {
        const size = Number(byteLength) || 0;
        if (size > 4) return "wide";
        if (size < 4) return "subword";
        return (Number(address) >>> 0) % 4 ? "unaligned" : "";
    }
    // Shared by the sidebar gate and the host's write rejection; sampling intent alone is not write readiness.
    function writeUnavailableKey(status) {
        if (status.canWrite === true) return "";
        if (status.connectionStale) return "sb.writeConnectionChanged";
        if (status.pauseReason === "archive_backpressure") return "sb.writeArchiveBusy";
        if (!(status.intentEnabled ?? status.running)) return "sb.writeNeedSampling";
        if (
            [
                "live.dapReading",
                "live.dapRetrying",
                "live.dapFailed",
                "live.dapReadUnsupported",
                "live.dapWriting",
                "live.debugConflict",
                "live.debugTclDegraded",
                "live.needVar"
            ].includes(status.key)
        )
            return status.key;
        if (status.mode === "debug-paused-reading") return "live.dapReading";
        if (status.mode === "debug-paused-unsupported") return "live.dapReadUnsupported";
        if (status.mode === "debug-session-conflict") return "live.debugConflict";
        if (status.mode === "debug-paused-writing") return "live.dapWriting";
        if (status.mode === "debug-paused-ready") return "sb.writeDebuggerUnsupported";
        return "sb.writeUnavailable";
    }
    function liveState(previous, message) {
        return {
            running:
                typeof message.intentEnabled === "boolean"
                    ? message.intentEnabled
                    : typeof message.running === "boolean"
                      ? message.running
                      : !!previous.running,
            canRead: typeof message.canRead === "boolean" ? message.canRead : !!previous.canRead,
            canWrite: typeof message.canWrite === "boolean" ? message.canWrite : !!previous.canWrite,
            // Halting writes (sub-word, unaligned, 64-bit) need run control; a running debug session keeps it.
            haltWrite:
                typeof message.haltWrite === "boolean"
                    ? message.haltWrite
                    : typeof message.canWrite === "boolean"
                      ? message.canWrite
                      : !!previous.haltWrite,
            fresh:
                message.source === "dap"
                    ? message.snapshotReady === true
                    : message.source === "openocd" && message.canRead === true
        };
    }
    return {
        MAX_COMPOSITE_DEPTH,
        MAX_TYPE_ALIASES,
        unobservableReason,
        layoutUnavailableRows,
        layoutBranch,
        layoutMemberPath,
        formatPointer,
        summaryRoute,
        memberVisible,
        shortSymbolName,
        pointerLabel,
        pointerDisplay,
        setValueCell,
        markValueHeld,
        runtimeExpansionPaths,
        copyValueText,
        pointerNodeValue,
        summaryRow,
        hiddenMemberCount,
        createVariableNotices,
        resetVariableNotices,
        finishVariableNotices,
        renderVariableNotice,
        unavailableNotice,
        renderMemberVisibility,
        arrayShownCount,
        renderArrayMore,
        displayLayoutLeaves,
        displayRuntimeSelection,
        displayTreeShape,
        displayUnavailableRows,
        layoutArrayIndices,
        layoutExpansionError,
        createLayoutExpansionUi,
        MAX_LAYOUT_PATH_DEPTH,
        MAX_LAYOUT_VISITS,
        SUPPORTED_TYPES,
        typeByteLength,
        defaultType,
        variableBaseName,
        variableScope,
        scopedVariableName,
        variableDisplayName,
        variableNameParts,
        shortVariableName,
        uniqueShortVariableNames,
        renderVariableName,
        renderSymbolName,
        translate,
        runtimeWatchEntry,
        memberPathSegments,
        pointerDerefEntry,
        isPointeeEntry,
        runtimeMemberRoute,
        pointeeParentPath,
        isPointeeDescendant,
        renderPointerToggle,
        runtimeGraph,
        requiresRuntimePath,
        runtimeSelection,
        placeholderRuntimeTree,
        pointerSnapshots,
        runtimeTreeShape,
        liveState,
        writeHaltRisk,
        writeUnavailableKey,
        warningIconSvg,
        renderElfDiagnostics
    };
});
