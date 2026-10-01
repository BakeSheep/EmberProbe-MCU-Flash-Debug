"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeRtosView = factory();
})(globalThis, function () {
    function create({ api, t, uiState }) {
        const section = document.getElementById("rtosSection"),
            status = document.getElementById("rtosStatus"),
            body = document.getElementById("rtosTasks"),
            filter = document.getElementById("rtosFilter"),
            sort = document.getElementById("rtosSort"),
            refresh = document.getElementById("rtosRefresh"),
            sessionPicker = document.getElementById("rtosSession");
        if (!section || !status || !body || !filter || !sort || !refresh) return null;
        const state = {
            debug: { state: "none", sessionId: "", stopEpoch: 0, supported: false },
            snapshot: null,
            requested: "",
            pending: false,
            error: ""
        };
        section.open = !!uiState.rtosExpanded;
        const key = (message) => `${message.sessionId}:${message.stopEpoch}`;
        const current = (message) => key(message) === key(state.debug);
        const canRead = () => state.debug.supported && state.debug.state === "paused";
        function request(manual = false) {
            if (!section.open || !canRead() || state.pending || (!manual && state.requested === key(state.debug)))
                return;
            state.requested = key(state.debug);
            state.pending = true;
            state.error = "";
            api?.postMessage({ type: "rtosRefresh" });
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
                    option.textContent = `${session.name} · ${session.serverGroup || t("rtos.core")}/${session.targetProcessor}`;
                    sessionPicker.append(option);
                }
                sessionPicker.value = state.debug.sessionId || "";
            }
            refresh.disabled = !canRead() || state.pending;
            const stale = state.snapshot && (!current(state.snapshot) || state.debug.state !== "paused");
            status.textContent =
                state.error ||
                (state.pending
                    ? t("rtos.reading")
                    : stale
                      ? t("rtos.stale")
                      : !canRead()
                        ? t("rtos.pause")
                        : state.snapshot?.partial
                          ? t("rtos.partial")
                          : state.snapshot?.kernel?.state === "not-started"
                            ? t("rtos.notStarted")
                            : state.snapshot?.kernel?.state === "no-tasks"
                              ? t("rtos.noTasks")
                              : t("rtos.ready"));
            if (state.snapshot?.diagnostics?.length)
                status.textContent += " · " + state.snapshot.diagnostics.join("; ");
            const query = filter.value.toLowerCase();
            const tasks = (state.snapshot?.tasks || []).filter((task) =>
                [task.name, task.state, task.tcbAddress].some((value) => String(value).toLowerCase().includes(query))
            );
            tasks.sort(
                sort.value === "priority"
                    ? (left, right) => right.priority - left.priority || left.name.localeCompare(right.name)
                    : (left, right) => String(left[sort.value] || "").localeCompare(String(right[sort.value] || ""))
            );
            body.replaceChildren();
            for (const task of tasks) {
                const row = document.createElement("tr");
                const estimate = task.stack?.fillEstimate;
                const stack =
                    estimate?.complete && Number.isFinite(estimate.usedPercent)
                        ? `${estimate.usedPercent.toFixed(1)}% (${t("rtos.estimate")})`
                        : "—";
                const fields = [task.name, task.state, task.priority, task.tcbAddress, stack];
                for (const value of fields) {
                    const cell = document.createElement("td");
                    cell.textContent = String(value ?? "—");
                    row.append(cell);
                }
                row.title = `${t("rtos.savedSp")}: ${task.stack?.savedPointer || "—"}\n${t("rtos.basePriority")}: ${task.basePriority ?? "—"}\n${t("rtos.runtime")}: ${task.runtime?.counter ?? "—"}`;
                body.append(row);
            }
        }
        section.addEventListener("toggle", () => {
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
                    if (message.sessionId !== state.debug.sessionId) state.snapshot = null;
                }
                state.debug = message;
                render();
                request();
            },
            onSnapshot(message) {
                if (!current(message) || !canRead()) return;
                state.snapshot = message;
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
