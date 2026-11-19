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
    const watchWriteModule =
        typeof module === "object" && module.exports ? require("./watchWrites") : globalThis.EmberProbeWatchWrites;
    const { watchWriteBinding } = watchWriteModule;
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
        return runtime.writeHaltRisk(item.fromWatch ? item.writeBinding?.address : item.address, typeWidth(item));
    }

    // page: { box, count, state, t, displayName(item), post(message) or null without a host, changed() after the
    // list changes, notice: { set(notice), clear(), level() } }
    function create(page) {
        const { box, state, t } = page;
        let cells = Object.create(null),
            timers = Object.create(null),
            lastAt = Object.create(null),
            latestSeq = Object.create(null),
            retiredSeq = Object.create(null),
            // Last value known to be on the target per write card; a failed write rolls back to it.
            confirmed = Object.create(null),
            seq = 0,
            access = { canWrite: false, haltWrite: false, halted: false, unavailableKey: "sb.writeNeedSampling" };
        const watchWrites = watchWriteModule.create({ state, canRead: () => access.canWrite, has, toggle });
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
            page.post?.({
                type: "saveSidebarWrite",
                items: state.writeList.map((item) =>
                    item.fromWatch && item.name in confirmed ? { ...item, value: confirmed[item.name] } : item
                )
            });
        }
        function has(name) {
            return state.writeList.some((w) => w.name === name);
        }
        function gateKey(item, candidate = item.fromWatch ? watchWrites.entry(item.name) : null) {
            if (!access.canWrite) return access.unavailableKey;
            if (item.fromWatch) {
                const binding = watchWriteBinding(item.writeBinding);
                if (!binding) return "sb.writeBindingMissing";
                if (!candidate?.entry) return candidate?.key || "sb.writeSampleRequired";
                if (JSON.stringify(binding) !== JSON.stringify(candidate.entry.writeBinding))
                    return "sb.writeBindingChanged";
            }
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
            if (item.fromWatch && !item.writeBinding) return null;
            const risk = writeRisk(item);
            if (!risk) return null;
            const icon = document.createElement("span");
            icon.className = "write-risk";
            icon.tabIndex = 0;
            icon.setAttribute("role", "img");
            icon.innerHTML = runtime.warningIconSvg("write-risk-icon");
            icon.dataset.tip = t("sb.writeRisk." + risk, {
                bits: typeWidth(item) * 8,
                addr:
                    "0x" + ((Number(item.writeBinding?.address ?? item.address) || 0) >>> 0).toString(16).toUpperCase()
            });
            icon.setAttribute("aria-label", icon.dataset.tip);
            icon.addEventListener("mouseenter", () => showRiskTip(icon));
            icon.addEventListener("focus", () => showRiskTip(icon));
            icon.addEventListener("mouseleave", () => hideRiskTip(icon));
            icon.addEventListener("blur", () => hideRiskTip(icon));
            return icon;
        }
        function cancelPending(name, notify = false) {
            if (timers[name]) {
                clearTimeout(timers[name]);
                delete timers[name];
            }
            delete lastAt[name];
            if (notify && latestSeq[name] !== undefined) {
                retiredSeq[name] = latestSeq[name];
                page.post?.({ type: "cancelSidebarWrite", name, seq: latestSeq[name] });
            }
            delete latestSeq[name];
            const card = cells[name];
            if (card) {
                card.sliderEdited = false;
                card.input.classList.remove("pending");
            }
        }
        function remove(name) {
            cancelPending(name, !!cells[name]?.item.fromWatch);
            delete confirmed[name];
            delete retiredSeq[name];
            state.writeList = state.writeList.filter((w) => w.name !== name);
            render();
            page.changed();
            save();
        }
        function toggle(entry) {
            if (has(entry.name)) return remove(entry.name);
            if (entry.fromWatch ? !watchWriteBinding(entry.writeBinding) : !canAddStatic(entry)) return;
            const type = entry.type || "u32",
                bounds = defBounds(type),
                base = {
                    name: entry.name,
                    displayName: page.displayName(entry),
                    address: entry.address,
                    size: entry.size,
                    ...(entry.fromWatch ? { fromWatch: true, writeBinding: entry.writeBinding } : {})
                };
            if (entry.isBoolean) {
                state.writeList.push({
                    ...base,
                    type,
                    isBoolean: true,
                    min: 0,
                    max: 1,
                    value: Number(entry.value ?? state.latest[entry.name]) ? 1 : 0
                });
            } else if (isWideInt(type)) {
                state.writeList.push({
                    ...base,
                    type,
                    value: entry.valueText ?? state.latestText[entry.name] ?? "0"
                });
            } else {
                let v = Number(entry.value ?? state.latest[entry.name]);
                if (!Number.isFinite(v)) v = 0;
                const item = { ...base, type, min: bounds[0], max: bounds[1], value: v };
                widenWriteBounds(item, v);
                state.writeList.push(item);
            }
            render();
            page.changed();
            save();
        }
        function canAddStatic(entry) {
            if (
                !runtime.SUPPORTED_TYPES.includes(entry.watchType || entry.type) ||
                entry.runtimeLayout ||
                entry.staticRuntimeStorage ||
                entry.isComposite ||
                entry.isConst ||
                entry.isReference ||
                entry.isMemberPointer ||
                entry.isPointer ||
                entry.enumEncodingInferred ||
                Number.isInteger(entry.bitSize) ||
                !Number.isSafeInteger(entry.address) ||
                entry.address <= 0
            )
                return false;
            const end = entry.address + Math.max(typeWidth(entry), Number(entry.size) || 0);
            return (
                !state.writeRanges ||
                state.writeRanges.some(({ start, end: limit }) => entry.address >= start && end <= limit)
            );
        }
        function post(item) {
            if (!page.post || !has(item.name)) return;
            const candidate = item.fromWatch ? watchWrites.entry(item.name) : null;
            const gate = gateKey(item, candidate);
            if (gate) {
                feedback({ key: gate });
                return;
            }
            delete retiredSeq[item.name];
            latestSeq[item.name] = ++seq;
            cells[item.name]?.input.classList.add("pending");
            page.post({
                type: "writeVariable",
                name: item.name,
                value: item.value,
                seq,
                ...(item.fromWatch
                    ? { fromWatch: true, binding: item.writeBinding, writeContext: candidate.entry.writeContext }
                    : {})
            });
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
                sliderEdited: false,
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
            if (latestSeq[item.name] !== undefined) input.classList.add("pending");
            return row;
        }
        function bindWide(item, { input }, steps, bottom) {
            steps.forEach((step) => (step.hidden = true));
            bottom.remove();
            const commit = () => {
                if (gateKey(item)) return;
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
                if (gateKey(item)) return;
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
                if (gateKey(item)) return;
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
                if (gateKey(item)) return;
                card.sliderEdited = true;
                const v = typed(slider.value);
                item.value = v;
                input.value = fmtNum(v);
                send(item, false);
            });
            slider.addEventListener("change", () => {
                if (item.fromWatch && !card.sliderEdited) return;
                card.sliderEdited = false;
                setValue(Number(slider.value), true);
            });
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
        function applyGate(card, candidate = card.item.fromWatch ? watchWrites.entry(card.item.name) : null) {
            const { item } = card;
            const gate = gateKey(item, candidate),
                title = gate ? t(gate) : "";
            const previous = card.gate;
            card.gate = gate;
            card.row.classList.toggle("gated", !!gate);
            if (gate && item.fromWatch && previous !== gate) {
                cancelPending(item.name, true);
                if (item.name in confirmed) card.setVal(confirmed[item.name]);
            } else if (gate && timers[item.name]) {
                clearTimeout(timers[item.name]);
                delete timers[item.name];
            }
            card.controls.forEach((control) => {
                control.disabled = !!gate;
                control.title = title;
            });
            if (!gate && item.fromWatch && previous) updateFromSample(card, candidate.entry);
            return gate;
        }
        // Live status: { canWrite, haltWrite, halted (debugger paused), unavailableKey }.
        function setAccess(next) {
            const contextChanged = watchWrites.setContext(next.canWrite ? (next.writeContext ?? null) : null);
            const changed =
                next.canWrite !== access.canWrite ||
                next.haltWrite !== access.haltWrite ||
                next.unavailableKey !== access.unavailableKey;
            if (!next.canWrite) watchWrites.invalidate();
            access = next;
            for (const card of Object.values(cells)) {
                if (contextChanged && card.item.fromWatch) {
                    cancelPending(card.item.name, true);
                    if (card.item.name in confirmed) card.setVal(confirmed[card.item.name]);
                    card.gate = "sb.writeSampleRequired";
                }
                if (changed || contextChanged) applyGate(card);
            }
            page.refreshMenu?.();
        }
        // Input checks fade on their own; a failed write stays until dismissed or the next write succeeds.
        function feedback(next) {
            if (!next) return page.notice.clear();
            page.notice.set(next.level === "error" ? next : { level: "warning", timeoutMs: 5000, ...next });
        }
        function knownValue(item) {
            if (item.fromWatch) {
                const entry = watchWrites.entry(item.name)?.entry;
                return entry ? (isWideInt(item.type) ? entry.valueText : entry.value) : undefined;
            }
            if (isWideInt(item.type)) return state.latestText[item.name] ?? confirmed[item.name];
            const sampled = state.latest[item.name];
            const value = sampled === null || sampled === undefined ? NaN : Number(sampled);
            if (Number.isFinite(value)) return isFloat(item.type) ? value : Math.round(value);
            return confirmed[item.name];
        }
        function reportFailure(m) {
            let error = m.key || m.message ? m : { key: "sb.commandFailed" };
            const progress = m.details;
            const moved = m.code === "WRITE_TARGET_CHANGED" || m.code === "DEBUG_STATE_CHANGED";
            const verified = moved && progress?.verified === true && !progress.resultUnknown;
            if (progress?.resultUnknown || (moved && typeof progress?.written !== "boolean")) {
                error = { ...m, key: "sb.writeResultUnknown", params: {} };
            } else if (moved) {
                const state = progress.verified ? "verified" : progress.written ? "unverified" : "notWritten";
                const keys = {
                    verified: "sb.writeTargetChanged.verified",
                    unverified: "sb.writeTargetChanged.unverified",
                    notWritten: "sb.writeTargetChanged.notWritten"
                };
                error = {
                    ...m,
                    key: keys[state],
                    params: { written: progress.writtenItems ?? 1, total: progress.totalItems ?? 1 }
                };
            }
            feedback(
                notice.hostNotice({
                    error,
                    ...(verified ? { level: "warning", timeoutMs: 0 } : {}),
                    title: {
                        key: verified ? "sb.writeVerifiedTitle" : "sb.writeFailTitle",
                        params: { name: page.displayName({ name: m.name }) }
                    }
                })
            );
        }
        // A retired request can still report its write progress, without updating the current card.
        function onResult(m) {
            m = { ...m, code: m.diagnostic?.code || m.code, details: m.diagnostic?.details || m.details };
            if (latestSeq[m.name] === undefined || m.seq !== latestSeq[m.name]) {
                if (retiredSeq[m.name] !== undefined && retiredSeq[m.name] === m.seq) {
                    delete retiredSeq[m.name];
                    if (!m.ok && (typeof m.details?.written === "boolean" || m.details?.resultUnknown))
                        reportFailure(m);
                }
                return;
            }
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
                    const value = isWideInt(card.item.type) ? (m.valueText ?? m.value) : m.value;
                    card.setVal(value);
                    confirmed[m.name] = value;
                    if (card.item.fromWatch) save();
                } else {
                    // Show what the target still holds, not the rejected value, so steps start from it.
                    cancelPending(m.name);
                    if (!m.details?.resultUnknown && !m.details?.written && !m.details?.results?.length) {
                        const known = knownValue(card.item);
                        if (known !== undefined) {
                            card.setVal(known);
                            confirmed[m.name] = known;
                            save();
                        }
                    } else if (card.item.fromWatch) delete confirmed[m.name];
                }
            }
            if (!m.ok && cells[m.name]?.item.fromWatch) {
                watchWrites.block(m.name);
                applyGate(cells[m.name]);
            }
            if (m.ok) {
                if (page.notice.level() === "error") feedback(null);
            } else reportFailure(m);
        }
        function updateFromSample(card, entry) {
            const { item } = card;
            const value = isWideInt(item.type) ? entry.valueText : Number(entry.value);
            if (value == null || (typeof value === "number" && !Number.isFinite(value))) return;
            confirmed[item.name] = value;
            card.setVal(value);
        }
        function refreshWatchGates() {
            for (const card of Object.values(cells)) if (card.item.fromWatch) applyGate(card);
            page.refreshMenu?.();
        }
        function sampled(samples) {
            const focused = document.activeElement;
            const active = Object.values(cells).filter(
                ({ item, input, slider, sliderEdited }) =>
                    item.fromWatch &&
                    (sliderEdited ||
                        timers[item.name] ||
                        latestSeq[item.name] !== undefined ||
                        focused === input ||
                        focused === slider)
            );
            watchWrites.sampled(samples, (name) => {
                // Check pending values even if the final sample in the same batch restores the address.
                for (const card of active) if (card.item.name.startsWith(name)) applyGate(card);
            });
            refreshWatchGates();
        }
        // Sampled values move idle cards; a card being dragged, typed into or waiting for a result keeps its value.
        function sync() {
            state.writeList.forEach((item) => {
                const card = cells[item.name];
                if (!card) return;
                const candidate = item.fromWatch ? watchWrites.entry(item.name) : null;
                if (item.fromWatch ? applyGate(card, candidate) : gateKey(item)) return;
                if (Date.now() - (lastAt[item.name] || 0) < 1000) return;
                if (timers[item.name]) return;
                if (card.input.classList.contains("pending")) return;
                const ae = document.activeElement;
                if (ae === card.input || ae === card.slider) return;
                if (item.fromWatch) return updateFromSample(card, candidate.entry);
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
            for (const item of state.writeList) if (item.fromWatch) cancelPending(item.name, true);
            retiredSeq = Object.create(null);
            state.writeList = items.map((item) => {
                const binding = item.fromWatch && watchWriteBinding(item.writeBinding);
                return binding ? { ...item, ...binding, writeBinding: binding } : item;
            });
            confirmed = Object.create(null);
            render();
        }
        return {
            has,
            canAddStatic,
            toggle,
            render,
            load,
            setAccess,
            onResult,
            sync,
            menu: watchWrites.menu,
            sampled,
            invalidate() {
                watchWrites.invalidate();
                refreshWatchGates();
            },
            setExpansions(expansions) {
                watchWrites.setExpansions(expansions);
                refreshWatchGates();
            },
            forget: watchWrites.forget,
            displayName: watchWrites.displayName
        };
    }
    return { shiftSliderBounds, addWriteStep, create };
});
