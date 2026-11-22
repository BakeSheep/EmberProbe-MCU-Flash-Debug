"use strict";
// Card-scoped notices shared by composite and scalar variable views: external card footers,
// inline pointee sub-scopes, raw-member visibility switches, and static array pagination.
(function (root, create) {
    if (typeof module === "object" && module.exports) module.exports = create;
    else root.EmberProbeVariableNotices = create;
})(globalThis, function ({ notice, hiddenMemberCount, variableBaseName }) {
    let variableNoticeSequence = 0;
    // Opened notice groups, by footer state key and group, so a re-rendered card keeps them open.
    const openNoticeGroups = new Set();
    // Static array rows start at 16 elements; each click reveals the next page.
    const ARRAY_PAGE = 64;

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

    return {
        createVariableNotices,
        resetVariableNotices,
        finishVariableNotices,
        renderVariableNotice,
        renderMemberVisibility,
        arrayShownCount,
        renderArrayMore
    };
});
