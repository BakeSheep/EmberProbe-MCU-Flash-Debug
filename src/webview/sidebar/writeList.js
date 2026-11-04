"use strict";
// Sidebar write list: variables are added from the same ELF variable pane as the watch list; dragging writes
// continuously at up to 10 Hz, and writeResult reports the outcome. The page passes the shared `state`, its
// notices and the variable pane refresh (see `create`).
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const writeList = commonJs
        ? factory(
              require("../runtime"),
              require("../valueTree"),
              require("../cardReorder"),
              require("../notice"),
              require("../pageZoom")
          )
        : factory(
              root.EmberProbeRuntime,
              root.EmberProbeValueTree,
              root.EmberProbeCardReorder,
              root.EmberProbeNotice,
              root.EmberProbePageZoom
          );
    if (commonJs) module.exports = writeList;
    else root.EmberProbeWriteList = writeList;
})(typeof globalThis === "object" ? globalThis : this, function (runtime, valueTree, cardReorder, notice, pageZoom) {
    const { fmtNum } = valueTree;
    const WRITE_INTERVAL_MS = 100;
    // While the debugger is paused the CPU never sees intermediate drag values, yet every write makes the debugger
    // refresh variables and RTOS views, so only the settled value is written
    const PAUSED_WRITE_SETTLE_MS = 300;
    const TYPE_RANGE = {
        u8: [0, 255],
        i8: [-128, 127],
        u16: [0, 65535],
        i16: [-32768, 32767],
        u32: [0, 4294967295],
        i32: [-2147483648, 2147483647]
    };
    function isWideInt(type) {
        return type === "u64" || type === "i64";
    }
    function isFloat(type) {
        return type === "f32" || type === "f64";
    }
    function defBounds(type) {
        if (isWideInt(type)) return null;
        if (isFloat(type)) return [-1, 1];
        const r = TYPE_RANGE[type];
        if (type === "u8" || type === "i8" || type === "u16" || type === "i16") return [r[0], r[1]];
        return [0, 100];
    }
    // Widen the slider range when a sampled or read-back value falls outside it, so the slider can show the current
    // value (same rule as the initial range when added to the write list)
    function widenWriteBounds(item, v) {
        let min = Number(item.min),
            max = Number(item.max);
        if (!Number.isFinite(v) || !Number.isFinite(min) || !Number.isFinite(max) || (v >= min && v <= max))
            return false;
        if (v > max) max = 2 * Math.abs(v);
        if (v < min) min = -2 * Math.abs(v) || 0;
        const range = TYPE_RANGE[item.type];
        if (range) {
            min = Math.max(range[0], min);
            max = Math.min(range[1], max);
        }
        item.min = min;
        item.max = max;
        return true;
    }
    // A typed value outside the slider moves the slider window so the old value keeps its offset.
    function shiftSliderBounds(min, max, current, next) {
        const lo = Number(min),
            hi = Number(max),
            from = Number(current),
            to = Number(next);
        if (![lo, hi, from, to].every(Number.isFinite) || hi <= lo || (to >= lo && to <= hi))
            return { min: lo, max: hi };
        const span = hi - lo,
            anchor = Math.min(hi, Math.max(lo, from)),
            offset = anchor - lo,
            newMin = to - offset;
        return { min: newMin, max: newMin + span };
    }
    function clampToType(v, type) {
        if (!Number.isFinite(v)) return 0;
        const r = TYPE_RANGE[type];
        if (!r) return v;
        return Math.min(r[1], Math.max(r[0], Math.round(v)));
    }
    function normalizeWideInteger(raw, type) {
        const text = String(raw).trim();
        if (!/^[+-]?\d+$/.test(text)) return null;
        try {
            const value = BigInt(text),
                min = type === "u64" ? 0n : -(1n << 63n),
                max = type === "u64" ? (1n << 64n) - 1n : (1n << 63n) - 1n;
            return value < min || value > max ? null : value.toString(10);
        } catch {
            return null;
        }
    }
    function stepFor(item) {
        if (isFloat(item.type)) {
            const value = Math.abs(Number(item.value));
            if (!Number.isFinite(value) || value < 1) return 0.001;
            return Math.max(0.001, Math.pow(10, Math.floor(Math.log10(value)) - 2));
        }
        const v = Math.abs(Math.trunc(Number(item.value) || 0));
        return v < 100 ? 1 : Math.pow(10, Math.floor(Math.log10(v)) - 1);
    }
    function addWriteStep(value, delta, type) {
        const result = value + delta;
        if (!Number.isFinite(result)) return value;
        if (!isFloat(type)) return result;
        const step = Math.abs(delta);
        // Steps are decimal powers. Snap only representation noise near that decimal grid,
        // including f32 values decoded into a JavaScript double, without erasing off-grid values.
        const ticks = Math.round(result / step);
        const snapped = Number(`${ticks}e${Math.round(Math.log10(step))}`);
        const epsilon = type === "f32" ? 2 ** -23 : Number.EPSILON;
        const tolerance = Math.min(step / 4, Math.max(Math.abs(value), step) * epsilon);
        return Number.isFinite(snapped) && Math.abs(result - snapped) <= tolerance ? snapped : result;
    }
    function typeWidth(item) {
        return runtime.SUPPORTED_TYPES.includes(item.type) ? runtime.typeByteLength(item.type) : Number(item.size) || 0;
    }
    // Aligned 32-bit variables can be written while the CPU runs; 8/16-bit, unaligned and 64-bit writes briefly halt
    // for a read-modify-write
    function writeRisk(item) {
        return runtime.writeHaltRisk(item.address, typeWidth(item));
    }

    // page: { box, count, state, t, displayName(item), post(message) or null without a host, changed() after the
    // list changes, notice: { set(notice), clear(), level() } }
    function create(page) {
        const { box, state, t } = page;
        let cells = Object.create(null),
            timers = Object.create(null),
            lastAt = Object.create(null),
            latestSeq = Object.create(null),
            // Last value known to be on the target per write card; a failed write rolls back to it.
            confirmed = Object.create(null),
            seq = 0,
            access = { canWrite: false, haltWrite: false, halted: false, unavailableKey: "sb.writeNeedSampling" };
        const reorder =
            box &&
            cardReorder.attach(box, {
                onMove: (name, target, after) => {
                    const next = cardReorder.moveBlock(state.writeList, name, target, after);
                    if (next === state.writeList) return;
                    state.writeList = next;
                    render();
                    save();
                }
            });
        function save() {
            page.post?.({ type: "saveSidebarWrite", items: state.writeList });
        }
        function has(name) {
            return state.writeList.some((w) => w.name === name);
        }
        function gateKey(item) {
            if (!access.canWrite) return access.unavailableKey;
            return !access.haltWrite && writeRisk(item) ? "sb.writeNeedHalt" : "";
        }
        // The risk note is a custom overlay: a native title cannot limit its width and would stack with the name's
        // title
        let riskTip = null;
        function showRiskTip(icon) {
            if (!riskTip) {
                riskTip = document.createElement("div");
                riskTip.className = "write-risk-tip";
                riskTip.id = "writeRiskTip";
                riskTip.setAttribute("role", "tooltip");
                document.body.appendChild(riskTip);
            }
            riskTip.textContent = icon.dataset.tip;
            riskTip.hidden = false;
            icon.setAttribute("aria-describedby", riskTip.id);
            const anchor = pageZoom.rect(icon),
                width = riskTip.offsetWidth,
                height = riskTip.offsetHeight,
                viewWidth = pageZoom.viewport(window).width,
                viewHeight = pageZoom.viewport(window).height;
            const left = Math.max(4, Math.min(anchor.left, viewWidth - width - 4));
            const below = anchor.bottom + 4;
            riskTip.style.left = left + "px";
            riskTip.style.top = (below + height > viewHeight - 4 ? Math.max(4, anchor.top - height - 4) : below) + "px";
        }
        function hideRiskTip(icon) {
            if (riskTip) riskTip.hidden = true;
            icon?.removeAttribute("aria-describedby");
        }
        function riskIcon(item) {
            const risk = writeRisk(item);
            if (!risk) return null;
            const icon = document.createElement("span");
            icon.className = "write-risk";
            icon.tabIndex = 0;
            icon.setAttribute("role", "img");
            icon.innerHTML = runtime.warningIconSvg("write-risk-icon");
            icon.dataset.tip = t("sb.writeRisk." + risk, {
                bits: typeWidth(item) * 8,
                addr: "0x" + ((Number(item.address) || 0) >>> 0).toString(16).toUpperCase()
            });
            icon.setAttribute("aria-label", icon.dataset.tip);
            icon.addEventListener("mouseenter", () => showRiskTip(icon));
            icon.addEventListener("focus", () => showRiskTip(icon));
            icon.addEventListener("mouseleave", () => hideRiskTip(icon));
            icon.addEventListener("blur", () => hideRiskTip(icon));
            return icon;
        }
        function cancelPending(name) {
            if (timers[name]) {
                clearTimeout(timers[name]);
                delete timers[name];
            }
            delete lastAt[name];
            delete latestSeq[name];
        }
        function remove(name) {
            cancelPending(name);
            delete confirmed[name];
            state.writeList = state.writeList.filter((w) => w.name !== name);
            render();
            page.changed();
            save();
        }
        function toggle(entry) {
            if (has(entry.name)) return remove(entry.name);
            const type = entry.type || "u32",
                bounds = defBounds(type),
                base = {
                    name: entry.name,
                    displayName: page.displayName(entry),
                    address: entry.address,
                    size: entry.size
                };
            if (entry.isBoolean) {
                state.writeList.push({
                    ...base,
                    type,
                    isBoolean: true,
                    min: 0,
                    max: 1,
                    value: Number(state.latest[entry.name]) ? 1 : 0
                });
            } else if (isWideInt(type)) {
                state.writeList.push({ ...base, type, value: state.latestText[entry.name] || "0" });
            } else {
                let v = Number(state.latest[entry.name]);
                if (!Number.isFinite(v)) v = 0;
                const item = { ...base, type, min: bounds[0], max: bounds[1], value: v };
                widenWriteBounds(item, v);
                state.writeList.push(item);
            }
            render();
            page.changed();
            save();
        }
        function post(item) {
            if (!page.post || !has(item.name)) return;
            const gate = gateKey(item);
            if (gate) {
                feedback({ key: gate });
                return;
            }
            latestSeq[item.name] = ++seq;
            cells[item.name]?.input.classList.add("pending");
            page.post({ type: "writeVariable", name: item.name, value: item.value, seq });
        }
        function send(item, immediate) {
            const name = item.name;
            if (timers[name]) {
                clearTimeout(timers[name]);
                delete timers[name];
            }
            const now = Date.now();
            const later = (wait) => {
                timers[name] = setTimeout(() => {
                    delete timers[name];
                    lastAt[name] = Date.now();
                    post(item);
                }, wait);
            };
            if (immediate) {
                lastAt[name] = now;
                post(item);
            } else if (access.halted) later(PAUSED_WRITE_SETTLE_MS);
            else {
                const wait = WRITE_INTERVAL_MS - (now - (lastAt[name] || 0));
                if (wait > 0) return later(wait);
                lastAt[name] = now;
                post(item);
            }
        }
        function setBound(item, key, v) {
            if (item.isBoolean) return;
            if (!Number.isFinite(v)) return;
            if (!isFloat(item.type)) v = Math.round(v);
            if (key === "min") item.min = Math.min(v, Number(item.max));
            else item.max = Math.max(v, Number(item.min));
        }
        function bindBound(el, item, key, sync) {
            el.addEventListener(
                "wheel",
                (e) => {
                    e.preventDefault();
                    setBound(
                        item,
                        key,
                        addWriteStep(Number(item[key]) || 0, e.deltaY < 0 ? stepFor(item) : -stepFor(item), item.type)
                    );
                    sync();
                    save();
                },
                { passive: false }
            );
            el.onclick = () => {
                const inp = document.createElement("input");
                inp.className = "bound-input";
                inp.value = String(item[key]);
                el.replaceWith(inp);
                inp.focus();
                inp.select();
                let done = false;
                const finish = (commit) => {
                    if (done) return;
                    done = true;
                    if (commit) setBound(item, key, Number(inp.value.trim()));
                    inp.replaceWith(el);
                    sync();
                    save();
                };
                inp.onkeydown = (e) => {
                    if (e.key === "Enter") finish(true);
                    else if (e.key === "Escape") finish(false);
                };
                inp.onblur = () => finish(true);
            };
        }
        function typedValueError(item, value) {
            if (isFloat(item.type)) return "";
            const type = item.isBoolean ? "bool" : item.type;
            if (!Number.isInteger(value)) return t("sb.writeValueNotInteger", { type, value });
            const [min, max] = item.isBoolean ? [0, 1] : TYPE_RANGE[item.type] || [value, value];
            return value < min || value > max ? t("sb.writeValueOutOfRange", { type, value, min, max }) : "";
        }
        function element(tag, className, text) {
            const el = document.createElement(tag);
            el.className = className;
            if (text !== undefined) el.textContent = text;
            return el;
        }
        function button(className, text) {
            const el = element("button", className, text);
            el.type = "button";
            return el;
        }
        function buildCard(item, label) {
            const wide = isWideInt(item.type),
                row = element("div", "write-row" + (wide ? " wide" : "")),
                main = element("div", "write-main"),
                top = element("div", "write-top"),
                nm = element("span", "value-name"),
                displayName = page.displayName(item);
            nm.textContent = label || runtime.shortVariableName(displayName);
            nm.title = displayName;
            nm.dataset.rawName = item.name;
            nm.setAttribute("aria-label", displayName);
            const dot = element("span", "write-dot"),
                nmWrap = element("span", "write-name-wrap"),
                risk = riskIcon(item);
            if (risk) {
                // The icon sits beside the name, not inside it, so the name's title never covers the risk tip.
                const line = element("span", "write-name-line");
                line.append(risk, nm);
                nmWrap.append(dot, line);
            } else nmWrap.append(dot, nm);
            const ctl = element("span", "write-ctl"),
                minus = button("step-btn", "−"),
                input = element("input", "write-input"),
                plus = button("step-btn", "+"),
                bottom = element("div", "write-bottom");
            input.value = wide ? String(item.value ?? "0") : fmtNum(item.value);
            nmWrap.appendChild(element("span", "value-type", item.isBoolean ? "bool" : item.type || "u32"));
            ctl.append(minus, input, plus);
            top.append(nmWrap, ctl);
            const minL = element("span", "bound"),
                slider = element("input", "write-slider"),
                maxL = element("span", "bound");
            slider.type = "range";
            bottom.append(minL, slider, maxL);
            main.append(top, bottom);
            const rm = element("button", "watch-remove", "✕");
            rm.title = t("sb.removeFromWrite");
            rm.onclick = () => remove(item.name);
            row.append(main, rm);
            if (!(item.name in confirmed)) confirmed[item.name] = item.value;
            const card = (cells[item.name] = {
                item,
                row,
                input,
                slider,
                dot,
                controls: [minus, plus, input, slider],
                setVal: (v) => {
                    if (item.isBoolean) v = Number(v) ? 1 : 0;
                    item.value = v;
                    input.value = wide ? String(v) : fmtNum(v);
                    if (wide) return;
                    if (!item.isBoolean && widenWriteBounds(item, Number(v))) {
                        card.syncSlider();
                        save();
                    } else slider.value = String(Math.min(Number(item.max), Math.max(Number(item.min), v)));
                }
            });
            if (wide) bindWide(item, card, [minus, plus], bottom);
            else bindNumber(item, card, minL, maxL);
            applyGate(card);
            return row;
        }
        function bindWide(item, { input }, steps, bottom) {
            steps.forEach((step) => (step.hidden = true));
            bottom.remove();
            const commit = () => {
                const value = normalizeWideInteger(input.value, item.type);
                if (value === null) {
                    input.value = String(item.value ?? "0");
                    feedback({ key: "sb.invalidWriteValue" });
                    return;
                }
                if (value !== String(item.value)) {
                    item.value = value;
                    input.value = value;
                    save();
                    send(item, true);
                }
            };
            input.onkeydown = (e) => {
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") input.value = String(item.value ?? "0");
            };
            input.onblur = commit;
        }
        function bindNumber(item, card, minL, maxL) {
            const { input, slider } = card,
                [minus, plus] = card.controls;
            const syncSlider = (card.syncSlider = () => {
                if (item.isBoolean) {
                    item.min = 0;
                    item.max = 1;
                }
                slider.min = String(item.min);
                slider.max = String(item.max);
                slider.step = isFloat(item.type) ? "any" : "1";
                slider.value = String(Math.min(Number(item.max), Math.max(Number(item.min), Number(item.value) || 0)));
                minL.textContent = fmtNum(item.min);
                maxL.textContent = fmtNum(item.max);
            });
            syncSlider();
            const typed = (v) =>
                item.isBoolean
                    ? Math.min(1, Math.max(0, Math.round(Number(v))))
                    : isFloat(item.type)
                      ? Number(v)
                      : clampToType(Number(v), item.type);
            const setValue = (v, immediate) => {
                v = typed(v);
                if (!Number.isFinite(v)) v = 0;
                if (Object.is(v, -0)) v = 0;
                item.value = v;
                input.value = fmtNum(v);
                syncSlider();
                save();
                send(item, immediate);
            };
            const commitInput = () => {
                const text = input.value.trim();
                if (text === fmtNum(item.value)) return;
                const raw = Number(text);
                // An emptied box is not a request to write 0.
                if (!text || !Number.isFinite(raw)) {
                    input.value = fmtNum(item.value);
                    return;
                }
                // Typed values are written exactly or not at all; never clamp or round them silently.
                const invalid = typedValueError(item, raw);
                if (invalid) {
                    input.value = fmtNum(item.value);
                    feedback({ text: invalid });
                    return;
                }
                if (raw !== item.value) {
                    const bounds = shiftSliderBounds(item.min, item.max, item.value, raw);
                    item.min = bounds.min;
                    item.max = bounds.max;
                    setValue(raw, true);
                } else input.value = fmtNum(item.value);
            };
            input.onkeydown = (e) => {
                if (e.key === "Enter") commitInput();
                else if (e.key === "Escape") input.value = fmtNum(item.value);
            };
            input.onblur = commitInput;
            const inputValue = () => {
                const text = input.value.trim();
                // Empty or unchanged display text keeps the full precision of the last known value.
                if (!text || text === fmtNum(item.value)) return Number(item.value) || 0;
                const value = Number(text);
                return Number.isFinite(value) ? value : Number(item.value) || 0;
            };
            const stepped = (direction) => {
                const value = inputValue();
                return addWriteStep(value, direction * stepFor({ ...item, value }), item.type);
            };
            input.addEventListener(
                "wheel",
                (e) => {
                    // Scrolling the panel across an unfocused value box must not write to the target.
                    if (gateKey(item) || document.activeElement !== input) return;
                    e.preventDefault();
                    setValue(stepped(e.deltaY < 0 ? 1 : -1), false);
                },
                { passive: false }
            );
            minus.onclick = () => setValue(stepped(-1), true);
            plus.onclick = () => setValue(stepped(1), true);
            slider.addEventListener("input", () => {
                const v = typed(slider.value);
                item.value = v;
                input.value = fmtNum(v);
                send(item, false);
            });
            slider.addEventListener("change", () => setValue(Number(slider.value), true));
            if (!item.isBoolean) {
                bindBound(minL, item, "min", syncSlider);
                bindBound(maxL, item, "max", syncSlider);
            }
        }
        function render() {
            hideRiskTip();
            box.textContent = "";
            cells = Object.create(null);
            page.count.textContent = String(state.writeList.length);
            if (!state.writeList.length) {
                box.appendChild(element("div", "empty", t("sb.writeEmpty")));
                return;
            }
            const labels = runtime.uniqueShortVariableNames(state.writeList.map((item) => page.displayName(item)));
            state.writeList.forEach((item, index) => {
                const card = buildCard(item, labels[index]);
                cardReorder.decorate(card, item.name, t("sb.dragToReorder", { name: page.displayName(item) }));
                box.appendChild(card);
            });
            reorder?.refresh();
        }
        function applyGate(card) {
            const gate = gateKey(card.item),
                title = gate ? t(gate) : "";
            card.row.classList.toggle("gated", !!gate);
            card.controls.forEach((control) => {
                control.disabled = !!gate;
                control.title = title;
            });
        }
        // Live status: { canWrite, haltWrite, halted (debugger paused), unavailableKey }.
        function setAccess(next) {
            const changed =
                next.canWrite !== access.canWrite ||
                next.haltWrite !== access.haltWrite ||
                next.unavailableKey !== access.unavailableKey;
            access = next;
            if (changed) Object.values(cells).forEach(applyGate);
        }
        // Input checks fade on their own; a failed write stays until dismissed or the next write succeeds.
        function feedback(next) {
            if (!next) return page.notice.clear();
            page.notice.set(next.level === "error" ? next : { level: "warning", timeoutMs: 5000, ...next });
        }
        function knownValue(item) {
            if (isWideInt(item.type)) return state.latestText[item.name] ?? confirmed[item.name];
            const sampled = state.latest[item.name];
            const value = sampled === null || sampled === undefined ? NaN : Number(sampled);
            if (Number.isFinite(value)) return isFloat(item.type) ? value : Math.round(value);
            return confirmed[item.name];
        }
        // Write result feedback: the dot before the variable name lights up and fades (green on success, red on
        // failure); failures also show the reason in the write notice
        function onResult(m) {
            if (m.seq !== latestSeq[m.name]) return;
            delete latestSeq[m.name];
            const card = cells[m.name];
            if (card) {
                card.input.classList.remove("pending");
                card.dot.className = "write-dot " + (m.ok ? "ok" : "err");
                void card.dot.offsetWidth;
                card.dot.classList.add("flash");
                if (m.ok) {
                    state.latest[m.name] = m.value;
                    state.latestText[m.name] = m.valueText ?? null;
                    state.latestEnum[m.name] = m.enumText ?? null;
                    card.setVal(m.valueText ?? m.value);
                    confirmed[m.name] = m.valueText ?? m.value;
                } else {
                    // Show what the target still holds, not the rejected value, so steps start from it.
                    cancelPending(m.name);
                    const known = knownValue(card.item);
                    if (known !== undefined) {
                        card.setVal(known);
                        save();
                    }
                }
            }
            if (m.ok) {
                if (page.notice.level() === "error") feedback(null);
            } else
                feedback(
                    notice.hostNotice({
                        error: m.key || m.message ? m : { key: "sb.commandFailed" },
                        title: { key: "sb.writeFailTitle", params: { name: page.displayName({ name: m.name }) } }
                    })
                );
        }
        // Sampled values move idle cards; a card being dragged, typed into or waiting for a result keeps its value.
        function sync() {
            state.writeList.forEach((item) => {
                const card = cells[item.name];
                if (!card) return;
                if (Date.now() - (lastAt[item.name] || 0) < 1000) return;
                if (timers[item.name]) return;
                if (card.input.classList.contains("pending")) return;
                const ae = document.activeElement;
                if (ae === card.input || ae === card.slider) return;
                if (isWideInt(item.type)) {
                    const text = state.latestText[item.name];
                    if (text != null) {
                        card.setVal(text);
                        confirmed[item.name] = text;
                    }
                    return;
                }
                const sampled = state.latest[item.name];
                if (sampled === null || sampled === undefined) return;
                let v = Number(sampled);
                if (!Number.isFinite(v)) return;
                if (!isFloat(item.type)) v = Math.round(v);
                card.setVal(v);
                confirmed[item.name] = v;
            });
        }
        // The host's saved list replaces the cards and forgets their confirmed values.
        function load(items) {
            state.writeList = items.slice();
            confirmed = Object.create(null);
            render();
        }
        return { has, toggle, render, load, setAccess, onResult, sync };
    }
    return { shiftSliderBounds, addWriteStep, create };
});
