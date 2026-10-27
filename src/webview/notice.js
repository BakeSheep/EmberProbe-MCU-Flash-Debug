"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeNotice = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
    const LEVELS = ["error", "warning", "info", "success"];
    const SUCCESS_MS = 4000;
    // One 16px stroke family. The warning triangle is the one RTOS status and write-risk markers have used;
    // filled dots carry class "dot" so outlined circles stay hollow.
    const ICONS = {
        error: '<circle cx="8" cy="8" r="6.25"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"/>',
        warning:
            '<path d="M6.85 2.67a1.33 1.33 0 0 1 2.3 0l5.34 9.33a1.33 1.33 0 0 1-1.16 2H2.67a1.33 1.33 0 0 1-1.16-2Z"/><path d="M8 5v4.5"/><circle class="dot" cx="8" cy="11.5" r=".6"/>',
        info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.2v4.3"/><circle class="dot" cx="8" cy="4.9" r=".6"/>',
        success: '<circle cx="8" cy="8" r="6.25"/><path d="M5.3 8.3l1.9 1.9 3.6-4"/>',
        busy: '<path d="M8 1.75A6.25 6.25 0 1 1 1.75 8"/>'
    };

    function normalizeLevel(level) {
        return LEVELS.includes(level) ? level : "info";
    }

    function noticeIconSvg(level, className, busy) {
        const shape = busy ? ICONS.busy : ICONS[normalizeLevel(level)];
        return (
            '<svg class="' +
            className +
            '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
            shape +
            "</svg>"
        );
    }

    // A box of notices keyed by source: setting an id replaces that source's notice in place, so one
    // operation never stacks duplicates. Success fades on its own; errors stay until dismissed or replaced.
    function createNoticeArea(container, options = {}) {
        const doc = container.ownerDocument;
        const t = options.t || ((key) => key);
        const later = options.setTimeout || setTimeout;
        const cancel = options.clearTimeout || clearTimeout;
        const entries = new Map();
        container.classList.add("notice-area");
        container.hidden = true;

        function resolve(value) {
            if (value == null || value === "") return "";
            if (typeof value === "string") return value;
            if (!value.key) return String(value.message || "");
            const text = t(value.key, value.params);
            // A key derived from an error code may have no translation; the raw message stands in.
            return text === value.key && value.fallback != null ? String(value.fallback) : text;
        }
        function element(tag, className, text) {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text != null) node.textContent = text;
            return node;
        }
        function button(className, text) {
            const node = element("button", className, text);
            node.type = "button";
            return node;
        }
        // Layout: a head row (icon, title, then the actions and close as one button group on the right) and,
        // below the title, the body text, suggestions and the diagnostic toggle. A notice without a title is
        // just the head row with its text.
        function build(id, notice) {
            const level = normalizeLevel(notice.level);
            const box = element(
                "div",
                "notice notice--" +
                    level +
                    (notice.busy ? " notice--busy" : "") +
                    (notice.compact ? " notice--compact" : "")
            );
            box.dataset.noticeId = id;
            box.setAttribute("role", level === "error" ? "alert" : "status");
            const title = resolve(notice.title);
            const text = resolve(notice.text !== undefined ? notice.text : notice);
            const head = element("div", "notice-head");
            head.insertAdjacentHTML("afterbegin", noticeIconSvg(level, "notice-icon", notice.busy));
            head.append(element("div", title ? "notice-title" : "notice-text", title || text));
            const buttons = element("div", "notice-buttons");
            // One action sits beside the close button; several would crowd the title, so they get a row below.
            const actions = (notice.actions || []).map((action) => {
                const node = button(
                    "notice-button notice-action" + (action.primary ? " primary" : ""),
                    resolve(action.label)
                );
                node.addEventListener("click", () => options.onAction?.(action, id, notice));
                return node;
            });
            const actionRow = actions.length > 1 ? element("div", "notice-actions") : null;
            if (actionRow) actionRow.append(...actions);
            else buttons.append(...actions);
            // Errors and event warnings can be closed; state-driven notices pass dismissible: false.
            if (notice.dismissible ?? (level === "error" || level === "warning")) {
                const close = button("notice-button notice-close", "×");
                close.title = t("notice.close");
                close.setAttribute("aria-label", t("notice.close"));
                close.addEventListener("click", () => {
                    clear(id);
                    options.onDismiss?.(id, notice);
                });
                buttons.append(close);
            }
            if (buttons.childNodes.length) {
                head.classList.add("notice-head--buttons");
                head.append(buttons);
            }
            box.append(head);
            const content = element("div", "notice-content");
            if (title && text) content.append(element("div", "notice-text", text));
            const items = (notice.items || []).map(resolve).filter(Boolean);
            if (items.length) {
                const list = element("ul", "notice-items");
                for (const item of items) list.append(element("li", "", item));
                content.append(list);
            }
            if (actionRow) content.append(actionRow);
            const fullDetail = resolve(notice.detail);
            const detail = fullDetail === text || fullDetail === title ? "" : fullDetail;
            if (notice.diagnostic || detail) {
                const json = (value) => (value && Object.keys(value).length ? JSON.stringify(value, null, 2) : "");
                // The panel skips what the box already says; the copied report keeps everything.
                const rest = { ...notice.diagnostic };
                delete rest.likelyCause;
                delete rest.suggestedActions;
                if (rest.message === detail || rest.message === text) delete rest.message;
                const report = [detail, json(notice.diagnostic)].filter(Boolean).join("\n\n");
                const panel = element("div", "notice-diagnostic");
                panel.id = "notice-diagnostic-" + String(id).replace(/[^\w-]/g, "_");
                panel.hidden = true;
                panel.append(element("pre", "", [detail, json(rest)].filter(Boolean).join("\n\n")));
                const copy = button("notice-copy", t("notice.copyDiagnostic"));
                // The copy confirms itself in place; there is no "copied" notification any more.
                copy.addEventListener("click", () => {
                    options.onCopy?.(report);
                    copy.textContent = t("common.copied");
                    later(() => (copy.textContent = t("notice.copyDiagnostic")), 1500);
                });
                panel.append(copy);
                const toggle = button("notice-toggle", t("notice.details"));
                toggle.setAttribute("aria-expanded", "false");
                toggle.setAttribute("aria-controls", panel.id);
                toggle.addEventListener("click", () => {
                    panel.hidden = !panel.hidden;
                    toggle.setAttribute("aria-expanded", String(!panel.hidden));
                });
                const footer = element("div", "notice-footer");
                footer.append(toggle);
                content.append(footer, panel);
            }
            if (content.childNodes.length) box.append(content);
            return box;
        }
        function sync() {
            container.hidden = entries.size === 0;
        }
        function set(id, notice) {
            if (!notice) return clear(id);
            const previous = entries.get(id);
            if (previous?.timer) cancel(previous.timer);
            const node = build(id, notice);
            // An update keeps the diagnostic panel the user opened.
            if (previous?.node.querySelector(".notice-toggle[aria-expanded='true']"))
                node.querySelector(".notice-toggle")?.click();
            if (previous) previous.node.replaceWith(node);
            else container.append(node);
            const entry = { notice, node, timer: null };
            const timeout = notice.timeoutMs || (normalizeLevel(notice.level) === "success" ? SUCCESS_MS : 0);
            if (timeout && !notice.sticky)
                entry.timer = later(() => {
                    if (entries.get(id) === entry) clear(id);
                }, timeout);
            entries.set(id, entry);
            sync();
        }
        function clear(id) {
            const entry = entries.get(id);
            if (!entry) return;
            if (entry.timer) cancel(entry.timer);
            entry.node.remove();
            entries.delete(id);
            sync();
        }
        function clearAll() {
            for (const id of [...entries.keys()]) clear(id);
        }
        // Notices keep their keys, so a language switch renders them again instead of keeping stale text.
        function relocalize() {
            for (const [id, entry] of entries) {
                const node = build(id, entry.notice);
                entry.node.replaceWith(node);
                entry.node = node;
            }
        }
        return {
            set,
            clear,
            clearAll,
            relocalize,
            has: (id) => entries.has(id),
            get: (id) => entries.get(id)?.notice,
            ids: () => [...entries.keys()]
        };
    }

    // Shapes an extension-side UI error ({ key, params, message|error, diagnostic }) into a notice: the
    // operation that failed is the title, the likely cause is the body, and the raw error moves into the
    // diagnostic panel whenever a readable cause replaces it.
    // title is an i18n key or a { key, params } value.
    function errorNotice(message, title) {
        const diagnostic = message?.diagnostic;
        const raw = message?.message || (typeof message?.error === "string" ? message.error : "") || "";
        // Errors without their own key still get the user's language through their code; the raw text,
        // often English or tool output, then moves into the diagnostic panel.
        const codeKey = !message?.key && diagnostic?.code ? "err." + diagnostic.code : "";
        const reason = message?.key
            ? { key: message.key, params: message.params }
            : codeKey
              ? { key: codeKey, fallback: raw }
              : raw;
        const cause = diagnostic?.likelyCause || "";
        return {
            level: "error",
            title: title ? (typeof title === "string" ? { key: title } : title) : cause ? reason : "",
            text: cause || reason,
            detail: (cause && title) || codeKey ? raw : "",
            items: Array.isArray(diagnostic?.suggestedActions) ? diagnostic.suggestedActions : [],
            diagnostic
        };
    }

    // Turns a host message ({ level, key|message, titleKey?, title?, error?, detail?, ... }) into a notice.
    function hostNotice(payload) {
        const { error, titleKey, detail, ...rest } = payload || {};
        if (!error) return { ...rest, detail, title: titleKey ? { key: titleKey } : rest.title };
        const base = errorNotice(error, titleKey || rest.title);
        return {
            ...rest,
            ...base,
            level: rest.level || "error",
            items: rest.items?.length ? rest.items : base.items,
            detail: [base.detail, detail].filter(Boolean).join("\n\n")
        };
    }

    return { LEVELS, noticeIconSvg, createNoticeArea, errorNotice, hostNotice };
});
