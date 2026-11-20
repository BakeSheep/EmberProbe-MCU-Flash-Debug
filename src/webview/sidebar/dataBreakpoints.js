"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeSidebarDataBreakpoints = factory();
})(globalThis, function () {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const MENU_INSET = 4;
    const MENU_RIGHT_INSET = 12;
    // 16px stroke glyphs drawn in currentColor, so menu selection and disabled colors apply.
    const ICONS = {
        check: "M3.5 8.4l3 3 6-6.6",
        pause: "M6 4v8M10 4v8",
        condition: "M10.2 3.3l2.5 2.5-6.6 6.6-3 .5.5-3z"
    };
    const stateOf = (entry) => (!entry.enabled ? "disabled" : entry.verified ? "enabled" : "failed");
    function create({ state, box, api, t, setNotice, writeMenu }, displayName) {
        const doc = box.ownerDocument;
        const post = (message) => api?.postMessage(message);
        const notice = (title) => setNotice("live", "dataBreakpoint", { level: "error", title });
        state.dataBreakpoints = {
            entries: [],
            sessionId: null,
            epoch: null,
            available: false,
            paused: false,
            sequence: 0,
            pending: new Map(),
            menu: null,
            target: null,
            info: null,
            generation: null
        };
        const get = () => state.dataBreakpoints;
        const accessLabel = (type) =>
            t({ write: "sb.dataWrite", read: "sb.dataRead", readWrite: "sb.dataAccess" }[type]);
        const statusLabel = (entry) =>
            t({ enabled: "sb.dataEnabled", disabled: "sb.dataDisabled", failed: "sb.dataFailed" }[stateOf(entry)]);
        const entryTitle = (entry) =>
            [accessLabel(entry.accessType), statusLabel(entry), entry.description, entry.condition, entry.message]
                .filter(Boolean)
                .join(" · ");
        function send(action, args = {}, context = null) {
            const s = get();
            const requestId = ++s.sequence;
            s.pending.set(requestId, { action, context, sessionId: s.sessionId, epoch: s.epoch });
            post({
                type: "sidebarDataBreakpoint",
                action,
                sessionId: s.sessionId,
                epoch: s.epoch,
                generation: s.generation,
                requestId,
                ...args
            });
        }
        function close(restore = false) {
            const s = get();
            const anchor = s.target?.anchor;
            s.menu?.remove();
            s.menu = null;
            s.target = null;
            s.info = null;
            if (restore && anchor?.isConnected) anchor.focus();
        }
        function element(tag, className, text) {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }
        function icon(name) {
            const svg = doc.createElementNS(SVG_NS, "svg");
            svg.setAttribute("viewBox", "0 0 16 16");
            svg.setAttribute("aria-hidden", "true");
            svg.setAttribute("class", "data-breakpoint-icon");
            const path = doc.createElementNS(SVG_NS, "path");
            path.setAttribute("d", ICONS[name]);
            svg.appendChild(path);
            return svg;
        }
        function refreshMarks() {
            const s = get();
            for (const row of box.querySelectorAll("[data-breakpoint-path]")) {
                const points = s.entries.filter((entry) => entry.name === row.dataset.breakpointPath);
                const current = row.querySelector(":scope > .data-breakpoint-mark");
                row.classList.toggle("has-data-breakpoint", points.length > 0);
                if (!points.length) {
                    current?.remove();
                    continue;
                }
                // Value refreshes call this often; keep the node (and an open tooltip) when nothing changed.
                const signature = JSON.stringify(
                    points.map((entry) => [entry.accessType, stateOf(entry), entry.condition, entry.message])
                );
                if (current?.dataset.signature === signature) continue;
                current?.remove();
                const mark = element("span", "data-breakpoint-mark");
                mark.dataset.signature = signature;
                mark.classList.toggle(
                    "disabled",
                    points.every((entry) => !entry.enabled)
                );
                mark.classList.toggle(
                    "failed",
                    points.some((entry) => entry.enabled && !entry.verified)
                );
                mark.title = points.map(entryTitle).join("\n");
                mark.setAttribute("aria-label", mark.title);
                row.appendChild(mark);
            }
        }
        // Every actionable control is a <button>; arrow-key navigation walks them in DOM order.
        function button(parent, label, action, args, { disabled = false, glyph = null, className = "", checked } = {}) {
            const control = element("button", "data-breakpoint-item" + (className ? " " + className : ""));
            control.type = "button";
            control.disabled = disabled;
            if (checked === undefined) control.setAttribute("role", "menuitem");
            else {
                control.setAttribute("role", "menuitemradio");
                control.setAttribute("aria-checked", String(checked));
            }
            const gutter = element("span", checked === undefined ? "data-breakpoint-gutter" : "data-breakpoint-choice");
            if (glyph) gutter.appendChild(icon(glyph));
            control.append(gutter, element("span", "data-breakpoint-label", label));
            control.onclick = () => {
                const context = get().target;
                send(action, args, context);
                close(true);
            };
            parent.appendChild(control);
            return control;
        }
        function conditionButton(entry) {
            const label = t("sb.dataCondition");
            const control = element("button", "data-breakpoint-tool");
            control.type = "button";
            control.disabled = !entry;
            control.setAttribute("role", "menuitem");
            control.title = label;
            control.appendChild(icon("condition"));
            control.appendChild(element("span", "data-breakpoint-sr", label));
            if (entry)
                control.onclick = () => {
                    send("condition", { id: entry.id, condition: entry.condition }, get().target);
                    close(true);
                };
            return control;
        }
        function menuCard(menu, title, showTitle = true) {
            const card = element("div", "data-breakpoint-menu-card");
            card.setAttribute("role", "group");
            card.setAttribute("aria-label", title);
            if (showTitle) {
                const heading = element("div", "data-breakpoint-card-title", title);
                heading.setAttribute("aria-hidden", "true");
                card.appendChild(heading);
            }
            menu.appendChild(card);
            return card;
        }
        function storageText(info) {
            if (!info?.dataId || !info.address) return "";
            return t("sb.dataStorage", { address: info.address, bytes: info.bytes });
        }
        function drawAccess(menu, s, accessType) {
            const { dataId, accessTypes } = s.info || {};
            const entries = s.entries.filter(
                (entry) =>
                    entry.accessType === accessType &&
                    (entry.name === s.target.name || (dataId && entry.dataId === dataId))
            );
            const current = dataId && entries.find((entry) => entry.dataId === dataId);
            const primary = current || entries.find((entry) => entry.enabled) || entries[0];
            const checked = Boolean(primary?.enabled);
            const toggleEntry = current || (checked ? primary : null);
            const group = element("div", "data-breakpoint-access");
            const row = element("div", "data-breakpoint-option");
            group.appendChild(row);
            button(
                row,
                accessLabel(accessType),
                toggleEntry ? "enable" : "add",
                toggleEntry ? { id: toggleEntry.id, enabled: !checked } : { name: s.target.name, dataId, accessType },
                {
                    disabled: !s.info || (!checked && (!dataId || !accessTypes?.includes(accessType))),
                    glyph: checked ? "check" : null,
                    checked
                }
            );
            row.appendChild(conditionButton(s.info && primary));
            if (primary) {
                row.title = entryTitle(primary);
                const status = stateOf(primary);
                const detail = [
                    !current ? primary.description : "",
                    status !== "enabled" ? statusLabel(primary) : "",
                    primary.condition
                ]
                    .filter(Boolean)
                    .join(" · ");
                if (detail) group.appendChild(element("div", "data-breakpoint-detail " + status, detail));
            }
            // A pointer can resolve to a new address, and a failed edit can leave a prior watchpoint.
            // Keep each retained condition accessible under its access type.
            for (const entry of entries) {
                if (entry === primary) continue;
                const extra = element("div", "data-breakpoint-option");
                extra.title = entryTitle(entry);
                const detail = [entry.description, entry.condition, statusLabel(entry)].filter(Boolean).join(" · ");
                button(
                    extra,
                    detail,
                    "enable",
                    { id: entry.id, enabled: !entry.enabled },
                    {
                        disabled: !s.info,
                        glyph: entry.enabled ? "check" : null,
                        checked: entry.enabled,
                        className: "data-breakpoint-retained"
                    }
                );
                extra.appendChild(conditionButton(s.info && entry));
                group.appendChild(extra);
            }
            menu.appendChild(group);
        }
        function drawWriteCard(menu, name) {
            const card = menuCard(menu, t("sb.writeList"), false);
            const action = writeMenu(name);
            menu.dataset.writeState = JSON.stringify([action.selected, action.key]);
            const control = button(
                card,
                t(action.selected ? "sb.removeFromWrite" : "sb.addToWrite"),
                "",
                {},
                {
                    disabled: !!action.key,
                    glyph: action.selected ? "check" : "condition",
                    className: "watch-write-action"
                }
            );
            control.title = action.key ? t(action.key) : "";
            control.onclick = () => {
                action.run();
                close(true);
            };
            if (action.key) card.appendChild(element("div", "data-breakpoint-note watch-write-note", t(action.key)));
        }
        function drawBreakpointCard(menu, s) {
            const card = menuCard(menu, t("sb.dataMenu"));
            if (!s.available) {
                card.appendChild(element("div", "data-breakpoint-note", t("sb.dataNoSession")));
                return;
            }
            if (!s.paused) {
                button(card, t("sb.dataPause"), "pause", {}, { glyph: "pause" });
                return;
            }
            const storage = storageText(s.info);
            if (storage) {
                const meta = element("div", "data-breakpoint-head-meta", storage);
                if (s.info.description) meta.title = s.info.description;
                card.appendChild(meta);
            }
            for (const accessType of ["write", "read", "readWrite"]) drawAccess(card, s, accessType);
            if (!s.info?.dataId) {
                const loading = !s.info;
                const note = element(
                    "div",
                    "data-breakpoint-note" + (loading ? "" : " warn"),
                    loading ? t("sb.dataLoading") : s.info.description || t("sb.dataUnsupported")
                );
                note.setAttribute("role", "status");
                card.appendChild(note);
            }
        }
        function draw() {
            const s = get();
            if (!s.menu || !s.target) return;
            const menu = s.menu;
            const head = element("div", "data-breakpoint-head");
            head.appendChild(element("div", "data-breakpoint-head-name", displayName({ name: s.target.name })));
            menu.replaceChildren(head);
            if (writeMenu) drawWriteCard(menu, s.target.name);
            drawBreakpointCard(menu, s);
            const view = doc.defaultView;
            const zoom = view.EmberProbePageZoom;
            const width = doc.documentElement.clientWidth || view.innerWidth;
            const visibleWidth = zoom ? zoom.coordinate(width, doc) : width;
            const visibleHeight = zoom ? zoom.viewport(view).height : view.innerHeight;
            menu.style.setProperty(
                "--data-breakpoint-menu-width",
                Math.max(0, visibleWidth - MENU_INSET - MENU_RIGHT_INSET) + "px"
            );
            const position = s.target.position;
            menu.style.left =
                Math.max(MENU_INSET, Math.min(position.x, visibleWidth - menu.offsetWidth - MENU_RIGHT_INSET)) + "px";
            menu.style.top =
                Math.max(MENU_INSET, Math.min(position.y, visibleHeight - menu.offsetHeight - MENU_INSET)) + "px";
            (menu.querySelector("button:not(:disabled)") || menu).focus();
        }
        function open(name, anchor, event) {
            close();
            const s = get();
            const rect = anchor.getBoundingClientRect();
            const zoom = doc.defaultView.EmberProbePageZoom;
            const coordinate = (value) => (zoom ? zoom.coordinate(value, doc) : value);
            s.target = {
                name,
                anchor,
                position: { x: coordinate(event?.clientX ?? rect.left), y: coordinate(event?.clientY ?? rect.bottom) }
            };
            s.menu = doc.createElement("div");
            s.menu.className = "data-breakpoint-menu";
            s.menu.setAttribute("role", "menu");
            s.menu.setAttribute("aria-label", t(writeMenu ? "sb.variableMenu" : "sb.dataMenu"));
            s.menu.tabIndex = -1;
            doc.body.appendChild(s.menu);
            draw();
            if (s.available && s.paused) send("info", { name }, s.target);
        }
        function decorate(row, name) {
            row.dataset.breakpointPath = name;
            row.tabIndex = 0;
            row.setAttribute("aria-haspopup", "menu");
        }
        box.addEventListener("contextmenu", (event) => {
            const row = event.target.closest("[data-breakpoint-path]");
            if (!row) return;
            event.preventDefault();
            event.stopPropagation();
            open(row.dataset.breakpointPath, row, event);
        });
        box.addEventListener("keydown", (event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            const row = event.target.closest("[data-breakpoint-path]");
            if (!row) return;
            event.preventDefault();
            event.stopPropagation();
            open(row.dataset.breakpointPath, row);
        });
        doc.addEventListener("pointerdown", (event) => {
            if (get().menu && !get().menu.contains(event.target)) close();
        });
        doc.addEventListener("keydown", (event) => {
            const s = get();
            if (!s.menu) return;
            if (event.key === "Escape") {
                event.preventDefault();
                close(true);
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const items = [...s.menu.querySelectorAll("button:not(:disabled)")];
                const index = items.indexOf(doc.activeElement);
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
            } else if (event.key === "Tab") close();
        });
        doc.defaultView.addEventListener("wheel", () => close(), { capture: true, passive: true });
        doc.defaultView.addEventListener("blur", () => close());
        function receive(message) {
            const s = get();
            const pending = s.pending.get(message.requestId);
            if (pending) s.pending.delete(message.requestId);
            if (message.requestId && !pending) return;
            if (pending && pending.sessionId !== s.sessionId) return;
            if (pending && pending.action !== "pause" && pending.epoch !== s.epoch) return;
            if (message.type === "sidebarDataBreakpointError") {
                if (pending?.action === "info" && s.target === pending.context) {
                    s.info = { description: message.message };
                    draw();
                } else if (pending?.action !== "list") notice(message.message);
                return;
            }
            const changed =
                s.sessionId !== message.sessionId ||
                s.epoch !== message.epoch ||
                s.available !== message.available ||
                s.paused !== message.paused;
            if (s.sessionId !== message.sessionId) s.entries = [];
            Object.assign(s, {
                sessionId: message.sessionId,
                epoch: message.epoch,
                paused: message.paused,
                available: message.available
            });
            if (changed) close();
            if (message.entries) s.entries = message.entries;
            if (message.generation !== undefined) s.generation = message.generation;
            refreshMarks();
            if (pending?.action === "pause" && pending.context?.anchor.isConnected) {
                open(pending.context.name, pending.context.anchor);
            } else if (pending?.action === "info" && s.target === pending.context) {
                s.info = message.info;
                draw();
            }
            if (changed && s.available) send("list");
            if (pending && ["add", "enable", "condition"].includes(pending.action)) {
                const failed = s.entries.find((entry) => entry.enabled && !entry.verified && entry.message);
                if (failed) notice(failed.message);
            }
        }
        // Rows are rebuilt by full renders and by lazy composite/pointer expansion. Watching the list
        // keeps marks, leaf decoration and the open menu's anchor in step without hooks at each site.
        function rendered() {
            for (const row of box.querySelectorAll("[data-path]:not([data-breakpoint-path])"))
                decorate(row, row.dataset.path);
            // Scalar watch cards are identified by their value cell.
            for (const cell of box.querySelectorAll(".value-row:not([data-breakpoint-path]) > [data-value-name]"))
                decorate(cell.parentElement, cell.dataset.valueName);
            const anchor = get().target?.anchor;
            if (anchor && !anchor.isConnected) close();
            refreshMarks();
        }
        new doc.defaultView.MutationObserver(rendered).observe(box, { childList: true, subtree: true });
        function refreshWrite() {
            const s = get();
            if (!writeMenu || !s.target || !s.menu) return;
            const action = writeMenu(s.target.name);
            if (s.menu.dataset.writeState !== JSON.stringify([action.selected, action.key])) draw();
        }
        const routes = { sidebarDataBreakpoints: receive, sidebarDataBreakpointError: receive };
        return { decorate, refreshMarks, receive, close, routes, refreshWrite };
    }
    return { create };
});
