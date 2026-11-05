"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbePeripheralView = factory();
})(globalThis, function () {
    const AUTO_READ_LIMIT = 64;
    const POLL_INTERVAL_MS = 50;
    const POLL_RETRY_MS = 1000;
    const CHANGE_HOLD_MS = 1000;
    // Expected while the connection or debug state moves; the next round settles them.
    const TRANSIENT_POLL_ERRORS = new Set([
        "DEBUG_CONTROL_BUSY",
        "DEBUG_STATE_CHANGED",
        "PERIPHERAL_ACCESS_BUSY",
        "PERIPHERAL_SAMPLING_REQUIRED",
        "PROBE_BUSY"
    ]);

    function formatValue(value, bits, mode) {
        if (value === undefined || value === null || value === "") return "—";
        try {
            const number = BigInt(value);
            if (mode === "dec") return number.toString(10);
            if (mode === "bin") return `0b${number.toString(2).padStart(bits || 1, "0")}`;
            return `0x${number
                .toString(16)
                .toUpperCase()
                .padStart(Math.ceil((bits || 4) / 4), "0")}`;
        } catch {
            return "—";
        }
    }

    function validateWriteValue(raw, bits, field, t) {
        const value = String(raw || "").trim();
        if (!value || value.length > 128) return { error: t("peripheral.invalidValue") };
        const enumeration = field?.enumerations?.find((item) => item.name.toLowerCase() === value.toLowerCase());
        if (enumeration && enumeration.mask !== null && enumeration.mask !== undefined)
            return { error: t("peripheral.invalidValue") };
        let number;
        if (enumeration) number = BigInt(enumeration.value);
        else {
            const normalized = value.replace(/_/g, "");
            if (!/^(?:\+?[0-9]+|0x[0-9a-f]+|0b[01]+|#[01]+)$/i.test(normalized))
                return { error: t("peripheral.invalidValue") };
            number = BigInt(normalized.startsWith("#") ? `0b${normalized.slice(1)}` : normalized);
        }
        if (number < 0n || number >= 1n << BigInt(bits)) return { error: t("peripheral.valueRange", { bits }) };
        return { number };
    }

    function safeToRead(register) {
        return (
            register.access !== "write-only" &&
            !register.readAction &&
            !register.fields.some((field) => !!field.readAction)
        );
    }

    function safeToWrite(register, field) {
        return (
            register.access === "read-write" &&
            !register.readAction &&
            !register.modifiedWriteValues &&
            register.fields.every(
                (item) => item.access === "read-write" && !item.readAction && !item.modifiedWriteValues
            ) &&
            (!field || field.access === "read-write")
        );
    }

    function create({ api, t, uiState }) {
        const section = document.getElementById("peripheralSection");
        const tree = document.getElementById("peripheralTree");
        const status = document.getElementById("peripheralStatus");
        const filter = document.getElementById("peripheralFilter");
        const refresh = document.getElementById("peripheralRefresh");
        const format = document.getElementById("peripheralFormat");
        if (!section || !tree || !status || !filter || !refresh || !format) return null;
        const state = {
            catalog: null,
            children: new Map(),
            readings: new Map(),
            expanded: new Set(Array.isArray(uiState.peripheralExpanded) ? uiState.peripheralExpanded : []),
            mode: ["hex", "dec", "bin"].includes(uiState.peripheralFormat) ? uiState.peripheralFormat : "hex",
            query: "",
            debug: { state: "none", epoch: 0, canRead: false, canWrite: false },
            error: "",
            warning: "",
            svdPath: "",
            pending: new Set(),
            drafts: new Map()
        };
        let rendering = false;
        let refreshTimer;
        let pollTimer = null;
        let pollOutstanding = 0;
        let pollStartedAt = 0;
        let pollError = "";
        // Rendered value, editor and enum nodes by target, so a poll updates them without rebuilding the tree.
        const liveNodes = new Map();
        function liveNode(target) {
            if (!liveNodes.has(target)) liveNodes.set(target, {});
            return liveNodes.get(target);
        }
        function deferRefresh() {
            clearTimeout(refreshTimer);
            if (!section.open || !state.debug.canRead) return;
            refreshTimer = setTimeout(refreshExpanded, 150);
        }
        function save() {
            uiState.peripheralExpanded = [...state.expanded].slice(0, 100);
            uiState.peripheralFormat = state.mode;
            api?.setState?.(uiState);
        }
        function request(type, payload = {}) {
            api?.postMessage({
                type,
                ...payload,
                ...(state.debug.generation === undefined
                    ? {}
                    : { accessGeneration: state.debug.generation, svdPath: state.svdPath })
            });
        }
        // The card's one notice: an error until dismissed or cleared, otherwise a hint about what to do next.
        const notices = window.EmberProbeNotice.createNoticeArea(status, {
            t,
            onDismiss: () => {
                state.error = "";
            }
        });
        function note(text, level = "info", busy = false) {
            notices.set("status", { level, text, busy, dismissible: level === "error" });
        }
        function requestCatalog() {
            if (!state.svdPath || !api) return;
            request("peripheralCatalogRequest");
        }
        function requestRegisters(name) {
            if (!api || state.pending.has(name)) return;
            state.pending.add(name);
            request("peripheralRegistersRequest", { name });
        }
        function requestReads(targets, automatic = false, poll = false) {
            if ((automatic && !section.open) || !state.debug.canRead || !api) return;
            for (let offset = 0; offset < targets.length; offset += 32) {
                if (poll) pollOutstanding++;
                request("peripheralReadRequest", {
                    targets: targets.slice(offset, offset + 32),
                    ...(poll ? { poll: true } : {})
                });
            }
        }
        // Registers refresh only on the sampling connection, where the target runs and nothing else is arbitrating.
        function polling() {
            return section.open && state.debug.canRead && state.debug.mode === "standalone" && !document.hidden;
        }
        function schedulePoll(delay = POLL_INTERVAL_MS) {
            if (pollTimer !== null || pollOutstanding || !polling()) return;
            pollTimer = setTimeout(() => {
                pollTimer = null;
                if (!polling()) return;
                pollStartedAt = Date.now();
                requestReads(expandedTargets(), true, true);
            }, delay);
        }
        // One round at a time: a slow probe lowers the rate instead of queueing reads.
        function settlePoll(failed = false) {
            pollOutstanding = Math.max(0, pollOutstanding - 1);
            if (pollOutstanding) return;
            schedulePoll(failed ? POLL_RETRY_MS : Math.max(0, POLL_INTERVAL_MS - (Date.now() - pollStartedAt)));
        }
        // Without a paused DAP session, registers are accessed only at natural 8/16/32-bit widths.
        function widthAccessible(bits) {
            return !state.debug.mode || state.debug.mode === "debug-paused" || [8, 16, 32].includes(bits);
        }
        function readableNow(register) {
            return safeToRead(register) && widthAccessible(register.size);
        }
        function expandedTargets() {
            const targets = [];
            for (const [name, registers] of state.children) {
                if (!state.expanded.has(name)) continue;
                for (const register of registers) {
                    if (
                        readableNow(register) &&
                        (targets.length < AUTO_READ_LIMIT || state.expanded.has(register.path))
                    )
                        targets.push(register.path);
                }
            }
            return [...new Set(targets)];
        }
        function refreshExpanded() {
            if (!section.open || !state.debug.canRead) return;
            if (polling()) schedulePoll(0);
            else requestReads(expandedTargets(), true);
        }
        function button(className, label, title, onClick) {
            const element = document.createElement("button");
            element.type = "button";
            element.className = className;
            element.textContent = label;
            element.title = title;
            element.setAttribute("aria-label", title);
            element.onclick = onClick;
            return element;
        }
        function addValue(row, target, value, bits, changed) {
            const span = document.createElement("span");
            Object.assign(liveNode(target), { span, bits });
            span.className = `peripheral-value${changed ? " changed" : ""}`;
            span.textContent = formatValue(value, bits, state.mode);
            row.appendChild(span);
        }
        function renderWriteControls(row, target, bits, field, currentValue, registerBits = bits) {
            let draft = state.drafts.get(target);
            if (!draft) {
                draft = { value: "", bits, dirty: false, pending: false, awaitingRead: false };
                state.drafts.set(target, draft);
            }
            if (!draft.dirty && !draft.pending && !draft.awaitingRead)
                draft.value = currentValue == null ? "" : formatValue(currentValue, bits, state.mode);
            const controls = document.createElement("span");
            controls.className = `peripheral-write-ctl ${bits > 32 ? "wide" : bits > 16 ? "normal" : "small"}`;
            const input = document.createElement("input");
            input.className = "peripheral-editor-input";
            input.type = "text";
            input.spellcheck = false;
            input.value = draft.value;
            input.placeholder = "—";
            input.dataset.target = target;
            input.setAttribute("aria-label", `${target}: ${t("peripheral.editValue")}`);
            const minus = button("peripheral-step", "−", t("peripheral.decrease"), () => step(-1));
            const plus = button("peripheral-step", "+", t("peripheral.increase"), () => step(1));
            for (const stepButton of [minus, plus]) stepButton.onmousedown = (event) => event.preventDefault();
            function validation() {
                const result = validateWriteValue(input.value, bits, field, t);
                input.classList.toggle("invalid", draft.dirty && !!result.error);
                input.setAttribute("aria-invalid", String(draft.dirty && !!result.error));
                input.title = result.error || target;
                minus.disabled = !state.debug.canWrite || draft.pending || !!result.error || result.number === 0n;
                plus.disabled =
                    !state.debug.canWrite ||
                    draft.pending ||
                    !!result.error ||
                    result.number === (1n << BigInt(bits)) - 1n;
                return result;
            }
            function commit(raw = input.value) {
                if (draft.pending || !state.debug.canWrite) return;
                const result = validateWriteValue(raw, bits, field, t);
                if (result.error) {
                    state.error = result.error;
                    draft.dirty = true;
                    validation();
                    note(state.error, "error");
                    return;
                }
                draft.value = raw.trim();
                draft.dirty = true;
                draft.pending = true;
                state.error = "";
                render();
                request("peripheralWriteRequest", { target, value: draft.value });
            }
            function step(delta) {
                const result = validation();
                if (result.error || draft.pending) return;
                commit(formatValue(result.number + BigInt(delta), bits, state.mode));
            }
            input.oninput = () => {
                draft.value = input.value;
                draft.dirty = true;
                draft.awaitingRead = false;
                validation();
            };
            input.onkeydown = (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                } else if (event.key === "Escape" && !draft.pending) {
                    draft.dirty = false;
                    state.error = "";
                    render();
                }
            };
            input.onblur = () => {
                if (!rendering && draft.dirty && !draft.pending) commit();
            };
            input.disabled = !state.debug.canWrite || draft.pending || !widthAccessible(registerBits);
            validation();
            Object.assign(liveNode(target), { control: { input, draft, validation }, bits });
            controls.append(minus, input, plus);
            row.appendChild(controls);
        }
        function renderField(register, field, reading) {
            const row = document.createElement("div");
            row.className = "peripheral-node peripheral-field";
            row.title = field.description || field.path;
            const range =
                field.bitWidth === 1
                    ? String(field.bitOffset)
                    : `${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}`;
            const label = document.createElement("span");
            label.className = "peripheral-name";
            label.textContent = `${field.name} [${range}]`;
            row.appendChild(label);
            const value = reading?.fields?.find((item) => item.path === field.path);
            if (!safeToWrite(register, field))
                addValue(row, field.path, value?.value, field.bitWidth, !!reading?.changed);
            if (value?.enum) {
                const detail = document.createElement("small");
                detail.className = "peripheral-enum";
                detail.textContent = value.enum;
                detail.title = value.enumDescription || value.enum;
                liveNode(field.path).enum = detail;
                row.appendChild(detail);
            }
            if (safeToWrite(register, field))
                renderWriteControls(row, field.path, field.bitWidth, field, value?.value, register.size);
            return row;
        }
        function renderRegister(register) {
            const reading = state.readings.get(register.path);
            const row = document.createElement("div");
            row.className = "peripheral-node peripheral-register";
            row.title = [register.path, register.description, register.address].filter(Boolean).join("\n");
            const expand = button(
                "peripheral-disclosure",
                register.fields.length ? (state.expanded.has(register.path) ? "▾" : "▸") : "",
                register.fields.length ? t("peripheral.expand") : register.path,
                () => {
                    if (!register.fields.length) return;
                    if (state.expanded.has(register.path)) state.expanded.delete(register.path);
                    else state.expanded.add(register.path);
                    save();
                    render();
                    if (state.debug.canRead && readableNow(register) && !reading) requestReads([register.path]);
                }
            );
            expand.disabled = !register.fields.length;
            row.appendChild(expand);
            const name = button("peripheral-name", register.name, t("peripheral.readRegister"), () => {
                if (state.debug.canRead && readableNow(register)) requestReads([register.path]);
            });
            row.appendChild(name);
            if (!safeToWrite(register)) addValue(row, register.path, reading?.value, register.size, !!reading?.changed);
            if (reading?.error || !safeToRead(register)) {
                const reason = reading?.error || t("peripheral.readSideEffect");
                row.title = reason;
                row.classList.add("unreadable");
            }
            if (safeToWrite(register)) renderWriteControls(row, register.path, register.size, null, reading?.value);
            tree.appendChild(row);
            if (state.expanded.has(register.path))
                for (const field of register.fields) tree.appendChild(renderField(register, field, reading));
        }
        function renderPeripheral(peripheral) {
            const opened = state.expanded.has(peripheral.name);
            const row = document.createElement("div");
            row.className = "peripheral-node peripheral-group";
            row.title = peripheral.description || peripheral.name;
            const toggle = button("peripheral-disclosure", opened ? "▾" : "▸", t("peripheral.expand"), () => {
                if (opened) state.expanded.delete(peripheral.name);
                else {
                    state.expanded.add(peripheral.name);
                    if (!state.children.has(peripheral.name)) {
                        requestRegisters(peripheral.name);
                    } else if (state.debug.canRead) refreshExpanded();
                }
                save();
                render();
            });
            toggle.setAttribute("aria-expanded", String(opened));
            row.appendChild(toggle);
            const name = button("peripheral-name", peripheral.name, peripheral.description || peripheral.name, () =>
                toggle.click()
            );
            row.appendChild(name);
            tree.appendChild(row);
            if (opened) {
                const children = state.children.get(peripheral.name);
                if (children) {
                    for (const register of children) renderRegister(register);
                } else {
                    const waiting = document.createElement("div");
                    waiting.className = "peripheral-waiting";
                    waiting.textContent = t("peripheral.loading");
                    tree.appendChild(waiting);
                }
            }
        }
        function render() {
            const active = document.activeElement;
            const focusedTarget = active?.classList?.contains("peripheral-editor-input") ? active.dataset.target : null;
            const selection = focusedTarget ? [active.selectionStart, active.selectionEnd] : null;
            rendering = true;
            liveNodes.clear();
            try {
                format.textContent = state.mode.toUpperCase();
                refresh.disabled = !state.debug.canRead || !state.svdPath;
                filter.disabled = !state.svdPath;
                tree.textContent = "";
                if (!state.svdPath) {
                    note(t("peripheral.enableHint"));
                    return;
                }
                if (state.error) note(state.error, "error");
                else if (!state.catalog) note(t("peripheral.loading"), "info", true);
                else if (state.warning) note(state.warning, "warning");
                else if (state.debug.reason === "PERIPHERAL_SAMPLING_REQUIRED") note(t("peripheral.needSampling"));
                else if (!state.debug.canRead) note(t("peripheral.unavailable"));
                else if (state.debug.state === "running") note(t("peripheral.running"));
                else if (state.debug.state === "paused") note(t("peripheral.paused"));
                else note(t("peripheral.sampling"));
                if (!state.catalog) return;
                const query = state.query.toLowerCase();
                const shown = state.catalog.peripherals.filter(
                    (item) =>
                        !query ||
                        [item.name, item.description, ...(item.registerNames || [])].some((text) =>
                            String(text || "")
                                .toLowerCase()
                                .includes(query)
                        )
                );
                if (!shown.length) {
                    const empty = document.createElement("div");
                    empty.className = "peripheral-empty";
                    empty.textContent = t("peripheral.noMatches");
                    tree.appendChild(empty);
                } else for (const item of shown) renderPeripheral(item);
                if (focusedTarget) {
                    const input = [...tree.querySelectorAll(".peripheral-editor-input")].find(
                        (item) => item.dataset.target === focusedTarget
                    );
                    if (input && !input.disabled) {
                        input.focus();
                        if (selection[0] !== null) input.setSelectionRange(...selection);
                    }
                }
            } finally {
                rendering = false;
            }
        }
        function currentResponse(message) {
            return (
                (message.requestGeneration === undefined || message.requestGeneration === state.debug.generation) &&
                (!message.requestSvdPath || message.requestSvdPath === state.svdPath)
            );
        }
        function onCatalog(message) {
            if (!currentResponse(message)) return;
            if (message.svd?.path !== state.svdPath) return;
            if (state.catalog?.svd?.sha256 !== message.svd?.sha256) {
                state.children.clear();
                state.readings.clear();
                state.drafts.clear();
            }
            state.catalog = message;
            state.error = "";
            for (const item of message.peripherals || [])
                if (state.expanded.has(item.name) && !state.children.has(item.name)) requestRegisters(item.name);
            render();
        }
        function onRegisters(message) {
            if (!currentResponse(message)) return;
            state.pending.delete(message.name);
            state.children.set(message.name, message.registers || []);
            render();
            if (section.open && state.expanded.has(message.name) && state.debug.canRead)
                requestReads(
                    (message.registers || [])
                        .filter(readableNow)
                        .slice(0, AUTO_READ_LIMIT)
                        .map((item) => item.path)
                );
            schedulePoll();
        }
        // Updates rendered values in place, so a click or an edit survives; false when the rows must be rebuilt.
        function updateLive(item, reading) {
            let current = true;
            for (const value of [item, ...(item.fields || [])]) {
                const node = liveNodes.get(value.path);
                if (!node) continue;
                const text = formatValue(value.value, node.bits, state.mode);
                if (node.span) {
                    node.span.textContent = text;
                    node.span.classList.toggle("changed", reading.changed);
                }
                const control = node.control;
                if (
                    control &&
                    document.activeElement !== control.input &&
                    !control.draft.dirty &&
                    !control.draft.pending &&
                    !control.draft.awaitingRead
                ) {
                    control.draft.value = control.input.value = text;
                    control.validation();
                }
                if (value !== item && !!value.enum !== !!node.enum) current = false;
                else if (node.enum) {
                    node.enum.textContent = value.enum;
                    node.enum.title = value.enumDescription || value.enum;
                }
            }
            return current;
        }
        function onRead(message) {
            if (message.requestPoll) settlePoll();
            if (!currentResponse(message)) return;
            if (message.session?.epoch !== undefined && message.session.epoch !== state.debug.epoch) return;
            const error = state.error;
            if (message.requestPoll && pollError) {
                if (state.error === pollError) state.error = "";
                pollError = "";
            }
            const now = Date.now();
            let rebuild = !message.requestPoll;
            for (const item of message.registers || []) {
                const previous = state.readings.get(item.path);
                const differs = !!(previous?.value && item.value && previous.value !== item.value);
                const changedAt = differs ? now : previous?.changedAt;
                const reading = {
                    ...item,
                    changedAt,
                    // A poll would clear the mark within one round, so it holds long enough to be seen.
                    changed: differs || !!(message.requestPoll && previous?.changed && now - changedAt < CHANGE_HOLD_MS)
                };
                state.readings.set(item.path, reading);
                if (!!item.error !== !!previous?.error) rebuild = true;
                if (!rebuild && !updateLive(item, reading)) rebuild = true;
                for (const [target, draft] of state.drafts) {
                    if (!draft.awaitingRead || (target !== item.path && !target.startsWith(`${item.path}.`))) continue;
                    const value =
                        target === item.path ? item.value : item.fields?.find((entry) => entry.path === target)?.value;
                    draft.awaitingRead = false;
                    rebuild = true;
                    if (value !== undefined) {
                        draft.value = formatValue(value, draft.bits, state.mode);
                        draft.dirty = false;
                    } else if (item.error) state.error = item.error;
                }
            }
            if (rebuild || state.error !== error) render();
        }
        // A write's outcome is shown even after the target or state changed: the register may already be written.
        function onWrite(message) {
            const current = currentResponse(message);
            const draft = state.drafts.get(message.target);
            if (draft) {
                draft.pending = false;
                draft.awaitingRead = true;
            }
            state.error = "";
            const unverified = message.result?.results?.find((item) => item.verified === false);
            state.warning = unverified
                ? t(
                      unverified.verification === "unavailable"
                          ? "peripheral.readbackUnavailable"
                          : "peripheral.readbackDifferent"
                  )
                : "";
            render();
            const register = message.result?.results?.[0]?.register;
            if (register && current) requestReads([register]);
        }
        function onDebug(message) {
            if (JSON.stringify(message) === JSON.stringify(state.debug)) return;
            const wasPaused = state.debug.canRead;
            const oldEpoch = state.debug.epoch;
            const changed = oldEpoch !== message.epoch || state.debug.generation !== message.generation;
            state.debug = message;
            if (changed) {
                state.drafts.clear();
                state.readings.clear();
                state.pending.clear();
                state.warning = "";
                pollOutstanding = 0;
            }
            render();
            if (!message.canRead || changed) clearTimeout(refreshTimer);
            if (message.canRead && (!wasPaused || changed)) deferRefresh();
            if (changed && !state.catalog && state.svdPath) requestCatalog();
            schedulePoll();
        }
        function onError(message) {
            if (message.requestPoll) {
                settlePoll(true);
                if (TRANSIENT_POLL_ERRORS.has(message.code)) return;
            }
            const write = message.operation === "peripheralWriteRequest";
            if (!write && !currentResponse(message)) return;
            if (message.operation === "peripheralRegistersRequest") {
                state.pending.clear();
            }
            if (write) {
                for (const [target, draft] of state.drafts) {
                    if (message.target && target !== message.target) continue;
                    draft.pending = false;
                    draft.awaitingRead = false;
                }
            }
            const error = message.message || t("peripheral.failed");
            state.error =
                write && message.writeAcknowledged
                    ? t("peripheral.writeDoneThenFailed", { error })
                    : write && message.resultUnknown
                      ? t("peripheral.writeResultUnknown", { error })
                      : error;
            if (message.requestPoll) pollError = state.error;
            render();
        }
        function onSvdStatus(message) {
            if (message.state === "idle") {
                state.svdPath = "";
                state.catalog = null;
                state.children.clear();
                state.readings.clear();
                state.pending.clear();
                state.drafts.clear();
                state.error = "";
                render();
            } else if (message.state === "configured") {
                if (state.svdPath === message.path && state.catalog) return;
                state.svdPath = message.path;
                state.catalog = null;
                state.children.clear();
                state.readings.clear();
                state.pending.clear();
                state.drafts.clear();
                state.error = "";
                render();
                requestCatalog();
            }
        }
        filter.oninput = () => {
            state.query = filter.value.trim();
            render();
        };
        refresh.onclick = () => requestReads(expandedTargets(), true);
        format.onclick = () => {
            state.mode = { hex: "dec", dec: "bin", bin: "hex" }[state.mode];
            save();
            render();
        };
        document.addEventListener("visibilitychange", refreshExpanded);
        section.addEventListener("toggle", () => {
            clearTimeout(refreshTimer);
            if (section.open && state.svdPath && !state.catalog) requestCatalog();
            if (section.open) refreshExpanded();
        });
        render();
        return { render, onCatalog, onRegisters, onRead, onWrite, onDebug, onError, onSvdStatus, requestCatalog };
    }

    return { create, formatValue, safeToRead, safeToWrite };
});
