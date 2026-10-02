"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeRtosView = factory();
})(globalThis, function () {
    function create({ api, t, uiState }) {
        const section = document.getElementById("rtosSection"),
            body = document.getElementById("rtosTasks"),
            filter = document.getElementById("rtosFilter"),
            sort = document.getElementById("rtosSort"),
            refresh = document.getElementById("rtosRefresh"),
            sessionPicker = document.getElementById("rtosSession");
        if (!section || !body || !filter || !sort || !refresh) return null;
        const state = {
            debug: { state: "none", sessionId: "", stopEpoch: 0, supported: false },
            snapshot: uiState.rtosSnapshot || null,
            requested: "",
            pending: false,
            error: ""
        };
        uiState.rtosTaskDetails ||= {};
        section.open = !!uiState.rtosExpanded;
        const key = (message) => `${message.sessionId}:${message.stopEpoch}`;
        const current = (message) => key(message) === key(state.debug);
        const canRead = () => state.debug.supported && state.debug.state === "paused";
        let refreshTimer;
        function deferRefresh() {
            clearTimeout(refreshTimer);
            if (!section.open || !canRead()) return;
            const expected = key(state.debug);
            refreshTimer = setTimeout(() => {
                if (expected === key(state.debug)) request();
            }, 150);
            refreshTimer.unref?.();
        }
        function request(manual = false) {
            if (!section.open || !canRead() || state.pending || (!manual && state.requested === key(state.debug)))
                return;
            state.requested = key(state.debug);
            state.pending = true;
            state.error = "";
            api?.postMessage({ type: "rtosRefresh", includeStackUsage: true });
            render();
        }
        function render() {
            if (sessionPicker) {
                const sessions = state.debug.sessions || [];
                sessionPicker.hidden = sessions.length < 2;
                sessionPicker.replaceChildren();
                const placeholder = document.createElement("option");
                placeholder.value = "";
                placeholder.textContent = t("rtos.chooseSession");
                sessionPicker.append(placeholder);
                for (const session of sessions) {
                    const option = document.createElement("option");
                    option.value = session.id;
                    const core = session.serverGroup || t("rtos.core");
                    option.textContent = `${session.name} · ${Number.isInteger(session.targetProcessor) ? `${core}/${session.targetProcessor}` : core}`;
                    sessionPicker.append(option);
                }
                sessionPicker.value = state.debug.sessionId || "";
            }
            refresh.disabled = !canRead() || state.pending;
            refresh.title = state.error || t("rtos.refresh");
            body.title = state.snapshot?.diagnostics?.join("; ") || "";
            const query = filter.value.toLowerCase();
            const tasks = (state.snapshot?.tasks || []).filter((task) =>
                [task.name, task.state].some((value) => String(value).toLowerCase().includes(query))
            );
            tasks.sort(
                sort.value === "priority"
                    ? (left, right) => right.priority - left.priority || left.name.localeCompare(right.name)
                    : (left, right) => String(left[sort.value] || "").localeCompare(String(right[sort.value] || ""))
            );
            body.replaceChildren();
            const activeKeys = new Set(tasks.map((task) => task.taskKey || `${task.name}:${task.tcbAddress || ""}`));
            for (const taskKey of Object.keys(uiState.rtosTaskDetails))
                if (!activeKeys.has(taskKey)) delete uiState.rtosTaskDetails[taskKey];
            for (const task of tasks) {
                const taskKey = task.taskKey || `${task.name}:${task.tcbAddress || ""}`;
                const row = document.createElement("tr");
                row.className = "rtos-task-row";
                const toggleCell = document.createElement("td");
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "rtos-disclosure";
                toggle.textContent = uiState.rtosTaskDetails[taskKey] ? "▾" : "▸";
                toggle.setAttribute("aria-expanded", String(!!uiState.rtosTaskDetails[taskKey]));
                toggle.setAttribute("aria-label", t("rtos.detailsToggle"));
                row.addEventListener("click", () => {
                    uiState.rtosTaskDetails[taskKey] = !uiState.rtosTaskDetails[taskKey];
                    api?.setState?.(uiState);
                    render();
                });
                toggleCell.append(toggle);
                row.append(toggleCell);
                const estimate = task.stack?.fillEstimate;
                const stack =
                    estimate?.complete && Number.isFinite(estimate.usedPercent)
                        ? `${estimate.usedPercent.toFixed(1)}%`
                        : "—";
                const fields = [task.name, task.state, task.priority, stack];
                for (const value of fields) {
                    const cell = document.createElement("td");
                    cell.textContent = String(value ?? "—");
                    row.append(cell);
                }
                row.title = `${t("rtos.savedSp")}: ${task.stack?.savedPointer || "—"}\n${t("rtos.basePriority")}: ${task.basePriority ?? "—"}\n${t("rtos.runtime")}: ${task.runtime?.counter ?? "—"}`;
                body.append(row);
                if (uiState.rtosTaskDetails[taskKey]) {
                    const detailRow = document.createElement("tr");
                    detailRow.className = "rtos-task-details";
                    const detailCell = document.createElement("td");
                    detailCell.colSpan = 5;
                    const list = document.createElement("dl");
                    const add = (label, value) => {
                        const item = document.createElement("div");
                        item.className = "rtos-detail-item";
                        const term = document.createElement("dt");
                        term.textContent = label;
                        const description = document.createElement("dd");
                        description.textContent = value == null || value === "" ? t("rtos.unavailable") : String(value);
                        item.append(term, description);
                        list.append(item);
                    };
                    const estimateData = task.stack?.fillEstimate;
                    const total = task.stack?.totalBytes;
                    const unused = estimateData?.unusedBytes;
                    add(t("rtos.taskId"), task.taskKey);
                    add(t("rtos.tcb"), task.tcbAddress);
                    add(t("rtos.threadId"), task.threadId);
                    add(t("rtos.basePriority"), task.basePriority);
                    add(t("rtos.priority"), task.priority);
                    add(t("rtos.savedSp"), task.stack?.savedPointer);
                    add(t("rtos.stackBase"), task.stack?.baseAddress);
                    add(t("rtos.stackSize"), total == null ? null : `${total} B`);
                    add(t("rtos.stackUsed"), unused == null || total == null ? null : `${total - unused} B`);
                    add(t("rtos.stackRemaining"), unused == null ? null : `${unused} B`);
                    add(t("rtos.runtime"), task.runtime?.counter);
                    if (state.snapshot?.partial) add(t("rtos.snapshot"), t("rtos.partial"));
                    if (state.snapshot?.diagnostics?.length)
                        add(t("rtos.diagnostics"), state.snapshot.diagnostics.join("; "));
                    detailCell.append(list);
                    detailRow.append(detailCell);
                    body.append(detailRow);
                }
            }
        }
        section.addEventListener("toggle", () => {
            clearTimeout(refreshTimer);
            uiState.rtosExpanded = section.open;
            api?.setState?.(uiState);
            request();
        });
        refresh.addEventListener("click", () => request(true));
        sessionPicker?.addEventListener("change", () => {
            if (sessionPicker.value) api?.postMessage({ type: "debugSelectSession", sessionId: sessionPicker.value });
        });
        filter.addEventListener("input", render);
        sort.addEventListener("change", render);
        render();
        return {
            render,
            state,
            onDebug(message) {
                if (key(message) !== key(state.debug) || message.state !== state.debug.state) {
                    state.pending = false;
                    state.error = "";
                    if (message.sessionId && state.snapshot && message.sessionId !== state.snapshot.sessionId) {
                        state.snapshot = null;
                        delete uiState.rtosSnapshot;
                        api?.setState?.(uiState);
                    }
                }
                state.debug = message;
                render();
                deferRefresh();
            },
            onSnapshot(message) {
                if (!current(message) || !canRead()) return;
                state.snapshot = message;
                uiState.rtosSnapshot = message;
                api?.setState?.(uiState);
                state.pending = false;
                render();
            },
            onError(message) {
                if (!current(message) || !canRead()) return;
                state.pending = false;
                state.error = message.message;
                render();
            }
        };
    }
    return { create };
});
