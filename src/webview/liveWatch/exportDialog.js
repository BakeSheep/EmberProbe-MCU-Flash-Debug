"use strict";
// CSV export dialog of the live watch page: the archived series to export, a marquee to tick many rows at once and
// the time range. The host lists the archive (samplingArchiveInfo with openExport) and writes the file (exportCsv).
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const exportDialog = factory(commonJs ? require("../cardReorder") : root.EmberProbeCardReorder);
    if (commonJs) module.exports = exportDialog;
    else root.EmberProbeExportDialog = exportDialog;
})(typeof globalThis === "object" ? globalThis : this, function (cardReorder) {
    function exportBounds(candidates) {
        let from = Infinity,
            to = -Infinity;
        (candidates || []).forEach(function (c) {
            (c.buffer || []).forEach(function (p) {
                const time = Number(p && p.t);
                if (Number.isFinite(time)) {
                    from = Math.min(from, time);
                    to = Math.max(to, time);
                }
            });
        });
        return { from: from, to: to };
    }
    // The host archives separate type interpretations as "name [type]". Keep that key for export, but present its
    // variable name and sampled type in their own columns.
    function candidate(name, info, page) {
        const archivedType = / \[([ui](?:8|16|32|64)|f32|f64)\]$/.exec(name),
            variableName = archivedType ? name.slice(0, -archivedType[0].length) : name;
        let displayName =
            info.displayNames &&
            Object.prototype.hasOwnProperty.call(info.displayNames, name) &&
            typeof info.displayNames[name] === "string" &&
            info.displayNames[name];
        if (archivedType && displayName && displayName.endsWith(archivedType[0])) {
            displayName = displayName.slice(0, -archivedType[0].length);
        }
        const item =
            page.state.watch.find(function (entry) {
                return entry.name === variableName;
            }) || page.state.symbols.get(variableName);
        return {
            name: name,
            displayName: displayName && displayName !== variableName ? displayName : page.displayName(variableName),
            type: archivedType ? archivedType[1] : item && (item.typeName || item.type || item.watchType),
            buffer: [{ t: info.firstTimestampMs }, { t: info.lastTimestampMs }]
        };
    }

    // page: { $, t, state, post, notice(key), displayName(name), formatElapsed(ms), historyRevision(),
    // clearPending() }
    function create(page) {
        const { $, t } = page;
        let candidates = [],
            openedAt = 0,
            timelineStart = 0,
            timelineEnd = 0,
            drag = null;
        function selected() {
            const picked = [];
            $("exportSeries")
                .querySelectorAll("input[type=checkbox]:checked")
                .forEach(function (cb) {
                    const item = candidates[Number(cb.dataset.index)];
                    if (item) picked.push(item);
                });
            return picked;
        }
        function setSelection(invert) {
            if (!candidates.length) return;
            endDrag();
            $("exportSeries")
                .querySelectorAll("input[type=checkbox]")
                .forEach(function (cb) {
                    if (cb.closest("tr").hidden) return;
                    cb.checked = invert ? !cb.checked : true;
                });
            setupTimeline(selected());
        }
        function filter() {
            endDrag();
            const query = $("exportSearch").value.trim().toLowerCase();
            $("exportSeries")
                .querySelectorAll("tbody tr")
                .forEach(function (row) {
                    const item = candidates[Number(row.querySelector("input").dataset.index)];
                    row.hidden =
                        !item.displayName.toLowerCase().includes(query) && !item.name.toLowerCase().includes(query);
                });
            $("exportSeries").scrollTop = 0;
        }
        function updateTimeline(changed) {
            const from = $("exportFromRange"),
                to = $("exportToRange"),
                span = Math.max(1, timelineEnd - timelineStart);
            let a = Number(from.value),
                b = Number(to.value);
            if (a > b) {
                if (changed === "from") {
                    b = a;
                    to.value = String(b);
                } else {
                    a = b;
                    from.value = String(a);
                }
            }
            $("exportRangeFill").style.left = (a / span) * 100 + "%";
            $("exportRangeFill").style.width = ((b - a) / span) * 100 + "%";
            $("exportSelection").textContent = t("lw.exportSelectedRange", {
                from: page.formatElapsed(a),
                to: page.formatElapsed(b)
            });
        }
        function setupTimeline(picked) {
            const bounds = exportBounds(picked);
            timelineStart = Number.isFinite(bounds.from) ? Math.min(bounds.from, openedAt) : openedAt;
            timelineEnd = Math.max(timelineStart, openedAt);
            const span = Math.max(1, Math.round(timelineEnd - timelineStart)),
                from = $("exportFromRange"),
                to = $("exportToRange");
            from.min = to.min = "0";
            from.max = to.max = String(span);
            from.value = "0";
            to.value = String(span);
            $("exportAxisStart").textContent = "00:00";
            $("exportAxisEnd").textContent = page.formatElapsed(span);
            updateTimeline();
        }
        function range() {
            const a = Number($("exportFromRange").value),
                b = Number($("exportToRange").value),
                from = timelineStart + a,
                to = timelineStart + b;
            if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
            if (a === 0 && b === Number($("exportToRange").max)) return {};
            return { from: from, to: to };
        }
        function endDrag(event) {
            const current = drag;
            if (!current || (event && event.pointerId !== current.pointerId)) return;
            drag = null;
            cancelAnimationFrame(current.frame);
            current.marquee.remove();
            if (current.box.hasPointerCapture?.(current.pointerId))
                current.box.releasePointerCapture(current.pointerId);
            if (event && event.type === "pointerup" && !current.moved && current.checkbox) {
                current.checkbox.checked = !current.checkbox.checked;
            }
            setupTimeline(selected());
        }
        function updateDrag() {
            if (!drag || !drag.moved) return;
            const box = drag.box,
                rect = box.getBoundingClientRect(),
                left = rect.left + box.clientLeft,
                top = rect.top + box.clientTop,
                headerHeight = box.querySelector("thead").getBoundingClientRect().height,
                x = Math.max(0, Math.min(box.clientWidth, drag.clientX - left)) + box.scrollLeft,
                y = Math.max(headerHeight, Math.min(box.clientHeight, drag.clientY - top)) + box.scrollTop,
                x1 = Math.min(drag.x, x),
                x2 = Math.max(drag.x, x),
                y1 = Math.min(drag.y, y),
                y2 = Math.max(drag.y, y);
            drag.marquee.hidden = false;
            Object.assign(drag.marquee.style, {
                left: x1 + "px",
                top: y1 + "px",
                width: x2 - x1 + "px",
                height: y2 - y1 + "px"
            });
            drag.rows.forEach(function (row) {
                const hit = row.left <= x2 && row.right >= x1 && row.top <= y2 && row.bottom >= y1;
                row.checkbox.checked = hit ? !row.checked : row.checked;
            });
        }
        // Holding the marquee near the top or bottom edge scrolls the list, faster closer to the edge.
        function scrollDrag(now) {
            if (!drag || !drag.moved) return;
            const box = drag.box,
                rect = box.getBoundingClientRect(),
                top = rect.top + box.clientTop + box.querySelector("thead").getBoundingClientRect().height,
                bottom = rect.top + box.clientTop + box.clientHeight,
                edge = Math.min(28, (bottom - top) / 3),
                speed =
                    drag.clientY < top + edge
                        ? -Math.min(1, (top + edge - drag.clientY) / edge)
                        : drag.clientY > bottom - edge
                          ? Math.min(1, (drag.clientY - bottom + edge) / edge)
                          : 0;
            box.scrollTop += speed * Math.min(32, now - drag.lastFrame) * 0.5;
            drag.lastFrame = now;
            updateDrag();
            drag.frame = requestAnimationFrame(scrollDrag);
        }
        function beginDrag(event) {
            if (event.button !== 0 || drag || !candidates.length) return;
            const box = $("exportSeries"),
                rect = box.getBoundingClientRect(),
                left = rect.left + box.clientLeft,
                top = rect.top + box.clientTop;
            if (
                event.target.closest("thead") ||
                event.clientX >= left + box.clientWidth ||
                event.clientY >= top + box.clientHeight
            )
                return;
            event.preventDefault();
            const row = event.target.closest("tbody tr"),
                marquee = document.createElement("div");
            marquee.className = "export-marquee";
            marquee.hidden = true;
            box.appendChild(marquee);
            drag = {
                box: box,
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                checkbox: row && row.querySelector("input"),
                x: event.clientX - left + box.scrollLeft,
                y: event.clientY - top + box.scrollTop,
                clientX: event.clientX,
                clientY: event.clientY,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
                marquee: marquee,
                frame: 0,
                lastFrame: performance.now(),
                rows: Array.from(box.querySelectorAll("tbody tr:not([hidden])"), function (entry) {
                    const bounds = entry.getBoundingClientRect(),
                        checkbox = entry.querySelector("input");
                    return {
                        checkbox: checkbox,
                        checked: checkbox.checked,
                        left: bounds.left - left + box.scrollLeft,
                        right: bounds.right - left + box.scrollLeft,
                        top: bounds.top - top + box.scrollTop,
                        bottom: bounds.bottom - top + box.scrollTop
                    };
                })
            };
            box.setPointerCapture?.(event.pointerId);
        }
        function moveDrag(event) {
            if (!drag || !cardReorder.samePointer(event, drag)) return;
            if (!(event.buttons & 1)) {
                endDrag(event);
                return;
            }
            drag.clientX = event.clientX;
            drag.clientY = event.clientY;
            if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4) {
                drag.moved = true;
                drag.lastFrame = performance.now();
                drag.frame = requestAnimationFrame(scrollDrag);
            }
            updateDrag();
        }
        function hide() {
            endDrag();
            $("exportOverlay").classList.add("hidden");
            page.notice(null);
        }
        // Ask the host for the archived series; its reply opens the dialog through `show`.
        function open() {
            if (page.clearPending()) return;
            page.post({ type: "samplingArchiveInfo", openExport: true, historyRevision: page.historyRevision() });
        }
        function defaultFileName() {
            const stamp = new Date(),
                pad = function (n) {
                    return String(n).padStart(2, "0");
                };
            return (
                "emberprobe-live-" +
                stamp.getFullYear() +
                pad(stamp.getMonth() + 1) +
                pad(stamp.getDate()) +
                "-" +
                pad(stamp.getHours()) +
                pad(stamp.getMinutes()) +
                pad(stamp.getSeconds())
            );
        }
        function show(info) {
            endDrag();
            $("exportFileName").value = "";
            $("exportFileName").placeholder = defaultFileName();
            $("exportSearch").value = "";
            const names = Array.isArray(info && info.variables) ? info.variables : [],
                first = Number(info && info.firstTimestampMs),
                last = Number(info && info.lastTimestampMs);
            if (!names.length || !Number.isFinite(first) || !Number.isFinite(last)) {
                candidates = [];
                $("exportSeries").textContent = "";
                page.notice("lw.noDataToExport");
                $("exportOverlay").classList.remove("hidden");
                return;
            }
            candidates = names.map(function (name) {
                return candidate(name, { ...info, firstTimestampMs: first, lastTimestampMs: last }, page);
            });
            openedAt = last;
            const box = $("exportSeries"),
                table = document.createElement("table"),
                header = table.createTHead().insertRow(),
                body = table.createTBody();
            ["lw.exportVariableName", "lw.exportDataType"].forEach(function (key) {
                const cell = document.createElement("th");
                cell.scope = "col";
                cell.dataset.i18n = key;
                cell.textContent = t(key);
                header.appendChild(cell);
            });
            box.replaceChildren(table);
            box.scrollTop = 0;
            candidates.forEach(function (item, index) {
                const row = body.insertRow(),
                    nameCell = row.insertCell(),
                    typeCell = row.insertCell(),
                    label = document.createElement("label"),
                    cb = document.createElement("input"),
                    name = document.createElement("span");
                cb.type = "checkbox";
                cb.checked = true;
                cb.dataset.index = String(index);
                cb.onchange = function () {
                    setupTimeline(selected());
                };
                name.className = "export-series-name";
                name.textContent = name.title = item.displayName;
                typeCell.className = "export-series-type";
                typeCell.textContent = typeCell.title = item.type || t("lw.unknownType");
                label.append(cb, name);
                nameCell.appendChild(label);
            });
            setupTimeline(candidates);
            page.notice(info.limitReached ? "lw.archiveTruncated" : info.limited ? "lw.memoryHistoryLimited" : null);
            $("exportOverlay").classList.remove("hidden");
        }
        function apply() {
            const picked = selected();
            if (!picked.length) {
                page.notice("lw.exportNoSeries");
                return;
            }
            const opts = range();
            if (!opts) {
                page.notice("lw.exportInvalidRange");
                return;
            }
            page.post({
                type: "exportCsv",
                fileName:
                    ($("exportFileName").value.trim() || $("exportFileName").placeholder).replace(/\.csv$/i, "") +
                    ".csv",
                historyRevision: page.historyRevision(),
                names: picked.map(function (c) {
                    return c.name;
                }),
                fromMs: opts.from,
                toMs: opts.to
            });
            hide();
        }
        // Cleared history: drop the listed series and close the dialog.
        function clear() {
            candidates = [];
            hide();
        }
        $("export").onclick = open;
        $("exportCancel").onclick = hide;
        $("exportApply").onclick = apply;
        $("exportSearch").oninput = filter;
        $("exportSelectAll").onclick = function () {
            setSelection(false);
        };
        $("exportInvert").onclick = function () {
            setSelection(true);
        };
        $("exportOverlay").onclick = function (e) {
            if (e.target === $("exportOverlay")) hide();
        };
        $("exportSeries").addEventListener("pointerdown", beginDrag);
        $("exportSeries").addEventListener("pointermove", moveDrag);
        $("exportSeries").addEventListener("pointerup", endDrag);
        $("exportSeries").addEventListener("pointercancel", endDrag);
        $("exportSeries").addEventListener("lostpointercapture", endDrag);
        $("exportSeries").onclick = function (event) {
            if (event.detail) event.preventDefault();
        };
        window.addEventListener("blur", function () {
            endDrag();
        });
        $("exportFromRange").oninput = function () {
            updateTimeline("from");
        };
        $("exportToRange").oninput = function () {
            updateTimeline("to");
        };
        return {
            open,
            selected,
            show,
            hide,
            apply,
            clear,
            get candidates() {
                return candidates;
            },
            get drag() {
                return drag;
            }
        };
    }
    return { create };
});
