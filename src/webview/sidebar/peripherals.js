"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbePeripheralView = factory();
})(globalThis, function () {
    const AUTO_READ_LIMIT = 64;

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
            svdPath: "",
            pending: new Set(),
            drafts: new Map()
        };
        let rendering = false;
        function save() {
            uiState.peripheralExpanded = [...state.expanded].slice(0, 100);
            uiState.peripheralFormat = state.mode;
            api?.setState?.(uiState);
        }
        function request(type, payload = {}) {
            api?.postMessage({ type, ...payload });
        }
        function note(text, error = false) {
            status.textContent = text;
            status.classList.toggle("error", error);
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
        function requestReads(targets) {
            if (!state.debug.canRead || !api) return;
            for (let offset = 0; offset < targets.length; offset += 32)
                request("peripheralReadRequest", { targets: targets.slice(offset, offset + 32) });
        }
        function refreshExpanded() {
            if (!state.debug.canRead) return;
            const targets = [];
            for (const [name, registers] of state.children) {
                if (!state.expanded.has(name)) continue;
                for (const register of registers) {
                    if (safeToRead(register) && (targets.length < AUTO_READ_LIMIT || state.expanded.has(register.path)))
                        targets.push(register.path);
                }
            }
            requestReads([...new Set(targets)]);
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
        function addValue(row, value, bits, changed) {
            const span = document.createElement("span");
            span.className = `peripheral-value${changed ? " changed" : ""}`;
            span.textContent = formatValue(value, bits, state.mode);
            row.appendChild(span);
        }
        function renderWriteControls(row, target, bits, field, currentValue) {
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
                    note(state.error, true);
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
            input.disabled = !state.debug.canWrite || draft.pending;
            validation();
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
            if (!safeToWrite(register, field)) addValue(row, value?.value, field.bitWidth, !!reading?.changed);
            if (value?.enum) {
                const detail = document.createElement("small");
                detail.className = "peripheral-enum";
                detail.textContent = value.enum;
                detail.title = value.enumDescription || value.enum;
                row.appendChild(detail);
            }
            if (safeToWrite(register, field)) renderWriteControls(row, field.path, field.bitWidth, field, value?.value);
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
                    if (state.debug.canRead && safeToRead(register) && !reading) requestReads([register.path]);
                }
            );
            expand.disabled = !register.fields.length;
            row.appendChild(expand);
            const name = button("peripheral-name", register.name, t("peripheral.readRegister"), () => {
                if (state.debug.canRead && safeToRead(register)) requestReads([register.path]);
            });
            row.appendChild(name);
            if (!safeToWrite(register)) addValue(row, reading?.value, register.size, !!reading?.changed);
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
                    if (!state.children.has(peripheral.name)) requestRegisters(peripheral.name);
                    else if (state.debug.canRead) refreshExpanded();
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
            try {
                format.textContent = state.mode.toUpperCase();
                refresh.disabled = !state.debug.canRead || !state.svdPath;
                filter.disabled = !state.svdPath;
                tree.textContent = "";
                if (!state.svdPath) {
                    note(t("peripheral.enableHint"));
                    return;
                }
                if (state.error) note(state.error, true);
                else if (!state.catalog) note(t("peripheral.loading"));
                else if (state.debug.state === "running") note(t("peripheral.running"));
                else if (state.debug.state === "paused") note(t("peripheral.paused"));
                else note(t("peripheral.noSession"));
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
        function onCatalog(message) {
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
            state.pending.delete(message.name);
            state.children.set(message.name, message.registers || []);
            render();
            if (state.expanded.has(message.name) && state.debug.canRead)
                requestReads(
                    (message.registers || [])
                        .filter(safeToRead)
                        .slice(0, AUTO_READ_LIMIT)
                        .map((item) => item.path)
                );
        }
        function onRead(message) {
            if (message.session?.epoch !== undefined && message.session.epoch !== state.debug.epoch) return;
            for (const item of message.registers || []) {
                const previous = state.readings.get(item.path);
                state.readings.set(item.path, {
                    ...item,
                    changed: !!(previous?.value && item.value && previous.value !== item.value)
                });
                for (const [target, draft] of state.drafts) {
                    if (!draft.awaitingRead || (target !== item.path && !target.startsWith(`${item.path}.`))) continue;
                    const value =
                        target === item.path ? item.value : item.fields?.find((entry) => entry.path === target)?.value;
                    draft.awaitingRead = false;
                    if (value !== undefined) {
                        draft.value = formatValue(value, draft.bits, state.mode);
                        draft.dirty = false;
                    } else if (item.error) state.error = item.error;
                }
            }
            render();
        }
        function onWrite(message) {
            const draft = state.drafts.get(message.target);
            if (draft) {
                draft.pending = false;
                draft.awaitingRead = true;
            }
            state.error = "";
            render();
            const register = message.result?.results?.[0]?.register;
            if (register) requestReads([register]);
        }
        function onDebug(message) {
            const wasPaused = state.debug.canRead;
            const oldEpoch = state.debug.epoch;
            state.debug = message;
            if (oldEpoch !== message.epoch) state.drafts.clear();
            render();
            if (message.canRead && (!wasPaused || oldEpoch !== message.epoch)) refreshExpanded();
        }
        function onError(message) {
            if (message.operation === "peripheralRegistersRequest") state.pending.clear();
            if (message.operation === "peripheralWriteRequest") {
                for (const [target, draft] of state.drafts) {
                    if (message.target && target !== message.target) continue;
                    draft.pending = false;
                    draft.awaitingRead = false;
                }
            }
            state.error = message.message || t("peripheral.failed");
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
        refresh.onclick = refreshExpanded;
        format.onclick = () => {
            state.mode = { hex: "dec", dec: "bin", bin: "hex" }[state.mode];
            save();
            render();
        };
        section.addEventListener("toggle", () => {
            if (section.open && state.svdPath && !state.catalog) requestCatalog();
        });
        render();
        return { render, onCatalog, onRegisters, onRead, onWrite, onDebug, onError, onSvdStatus, requestCatalog };
    }

    return { create, formatValue, safeToRead, safeToWrite };
});
