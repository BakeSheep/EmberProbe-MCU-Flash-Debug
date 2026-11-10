"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeSidebarDataBreakpoints = factory();
})(globalThis, function () {
    const SVG_NS = "http://www.w3.org/2000/svg";
    // 16px stroke glyphs drawn in currentColor, so menu selection and disabled colors apply.
    const ICONS = {
        check: "M3.5 8.4l3 3 6-6.6",
        pause: "M6 4v8M10 4v8",
        disable: "M8 3.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9M4.8 11.2l6.4-6.4",
        enable: "M8 3.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9M5.9 8.1l1.4 1.4 2.8-2.9",
        condition: "M10.2 3.3l2.5 2.5-6.6 6.6-3 .5.5-3z",
        remove: "M3.5 5h9M6.5 5V3.5h3V5M4.8 5l.6 7.5h5.2L11.2 5"
    };
    const stateOf = (entry) => (!entry.enabled ? "disabled" : entry.verified ? "enabled" : "failed");
    function create({ state, box, api, t, setNotice }) {
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
                mark.title = points
                    .map((entry) =>
                        [
                            accessLabel(entry.accessType),
                            statusLabel(entry),
                            entry.description,
                            entry.condition,
                            entry.message
                        ]
                            .filter(Boolean)
                            .join(" · ")
                    )
                    .join("\n");
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
                control.setAttribute("role", "menuitemcheckbox");
                control.setAttribute("aria-checked", String(checked));
            }
            const gutter = element("span", "data-breakpoint-gutter");
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
        function tool(parent, label, glyph, action, args, danger = false) {
            const control = element("button", "data-breakpoint-tool" + (danger ? " danger" : ""));
            control.type = "button";
            control.setAttribute("role", "menuitem");
            control.title = label;
            control.appendChild(icon(glyph));
            // The visually hidden label keeps the accessible name and textContent equal to the action.
            control.appendChild(element("span", "data-breakpoint-sr", label));
            control.onclick = () => {
                const context = get().target;
                send(action, args, context);
                close(true);
            };
            parent.appendChild(control);
        }
        function separator(menu) {
            const line = element("div", "data-breakpoint-separator");
            line.setAttribute("role", "separator");
            menu.appendChild(line);
        }
        function storageText(info) {
            if (!info?.dataId || !info.address) return "";
            return t("sb.dataStorage", { address: info.address, bytes: info.bytes });
        }
        function drawEntry(menu, entry) {
            const row = element("div", "data-breakpoint-entry " + stateOf(entry));
            row.setAttribute("role", "group");
            row.setAttribute("aria-label", accessLabel(entry.accessType) + " · " + statusLabel(entry));
            row.title = [entry.description, entry.message].filter(Boolean).join("\n");
            const dot = element("span", "data-breakpoint-dot");
            dot.setAttribute("aria-hidden", "true");
            const copy = element("span", "data-breakpoint-entry-copy");
            copy.appendChild(element("span", "data-breakpoint-entry-title", accessLabel(entry.accessType)));
            if (entry.condition) copy.appendChild(element("code", "data-breakpoint-condition", entry.condition));
            else if (stateOf(entry) !== "enabled")
                copy.appendChild(element("span", "data-breakpoint-entry-state", statusLabel(entry)));
            const tools = element("span", "data-breakpoint-tools");
            tool(
                tools,
                t(entry.enabled ? "sb.dataDisable" : "sb.dataEnable"),
                entry.enabled ? "disable" : "enable",
                "enable",
                {
                    id: entry.id,
                    enabled: !entry.enabled
                }
            );
            tool(tools, t("sb.dataCondition"), "condition", "condition", { id: entry.id, condition: entry.condition });
            tool(tools, t("sb.dataRemove"), "remove", "remove", { id: entry.id }, true);
            row.append(dot, copy, tools);
            menu.appendChild(row);
        }
        function draw() {
            const s = get();
            if (!s.menu || !s.target) return;
            const menu = s.menu;
            menu.replaceChildren();
            const head = element("div", "data-breakpoint-head");
            head.appendChild(element("div", "data-breakpoint-head-name", s.target.name));
            const meta = element("div", "data-breakpoint-head-meta");
            head.appendChild(meta);
            menu.appendChild(head);
            if (!s.available) {
                meta.textContent = t("sb.dataNoSession");
            } else if (!s.paused) {
                meta.textContent = t("sb.dataMenu");
                separator(menu);
                button(menu, t("sb.dataPause"), "pause", {}, { glyph: "pause" });
            } else {
                meta.textContent = storageText(s.info) || t("sb.dataMenu");
                if (s.info?.description) head.title = s.info.description;
                separator(menu);
                for (const accessType of ["write", "read", "readWrite"]) {
                    const existing = s.entries.some(
                        (entry) => entry.dataId === s.info?.dataId && entry.accessType === accessType
                    );
                    button(
                        menu,
                        accessLabel(accessType),
                        "add",
                        { name: s.target.name, dataId: s.info?.dataId, accessType },
                        {
                            disabled: !s.info?.dataId || existing || !s.info.accessTypes?.includes(accessType),
                            glyph: existing ? "check" : null,
                            checked: existing
                        }
                    );
                }
                if (!s.info?.dataId) {
                    const loading = !s.info;
                    const note = element(
                        "div",
                        "data-breakpoint-note" + (loading ? " loading" : " warn"),
                        loading ? t("sb.dataLoading") : s.info.description || t("sb.dataUnsupported")
                    );
                    note.setAttribute("role", "status");
                    menu.appendChild(note);
                }
                const points = s.entries.filter(
                    (entry) => entry.name === s.target.name || (s.info?.dataId && entry.dataId === s.info.dataId)
                );
                if (points.length) {
                    separator(menu);
                    menu.appendChild(element("div", "data-breakpoint-section", t("sb.dataActive")));
                    for (const entry of points) drawEntry(menu, entry);
                }
            }
            const zoom = doc.defaultView.EmberProbePageZoom;
            const viewport = zoom
                ? zoom.viewport(doc.defaultView)
                : { width: doc.defaultView.innerWidth, height: doc.defaultView.innerHeight };
            const position = s.target.position;
            menu.style.left = Math.max(4, Math.min(position.x, viewport.width - menu.offsetWidth - 4)) + "px";
            menu.style.top = Math.max(4, Math.min(position.y, viewport.height - menu.offsetHeight - 4)) + "px";
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
            s.menu.setAttribute("aria-label", t("sb.dataMenu"));
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
        const routes = { sidebarDataBreakpoints: receive, sidebarDataBreakpointError: receive };
        return { decorate, refreshMarks, receive, close, routes };
    }
    return { create };
});
