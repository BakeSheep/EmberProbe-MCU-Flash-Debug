"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeRttView = factory();
})(globalThis, function () {
    // The controller names the operations it yields to; the pending label translates them.
    const YIELD_LABELS = {
        download: "rtt.op.download",
        agentDownload: "rtt.op.agentDownload",
        liveWatch: "rtt.op.liveWatch",
        debug: "rtt.op.debug",
        externalDebug: "rtt.op.externalDebug",
        agentRead: "rtt.op.agentRead",
        chipInfo: "rtt.op.chipInfo"
    };
    const MODE_LABELS = {
        skip: { label: "rtt.mode.skip", hint: "rtt.modeHint.skip" },
        trim: { label: "rtt.mode.trim", hint: "rtt.modeHint.trim" },
        block: { label: "rtt.mode.block", hint: "rtt.modeHint.block" }
    };
    const TELEMETRY_REASONS = {
        RTT_EXACT_ADDRESS_REQUIRED: "rtt.err.exactAddressRequired",
        RTT_TARGET_INVALID: "rtt.err.targetInvalid",
        RTT_MODE_TARGET_CHANGED: "rtt.err.modeTargetChanged",
        RTT_ACCESS_UNSUPPORTED: "rtt.err.accessUnsupported",
        RTT_CHANNEL_UNINITIALIZED: "rtt.err.unknownChannel",
        RTT_INVALID_LAYOUT: "rtt.err.targetInvalid",
        RTT_READ_FAILED: "rtt.err.targetInvalid",
        RTT_VALUE_CHANGED: "rtt.err.targetChanged",
        RTT_IDENTITY_CHANGED: "rtt.err.targetChanged",
        RTT_TARGET_BUDGET_EXCEEDED: "rtt.err.targetBudget",
        LIVE_READ_BUDGET_EXCEEDED: "rtt.err.targetBudget",
        PROBE_CONNECTION_BUSY_TIMEOUT: "rtt.err.targetBudget",
        LIVE_READ_CANCELLED: "rtt.err.cancelled",
        RTT_TELEMETRY_PENDING: "rtt.telemetryPending",
        RTT_NOT_RUNNING: "rtt.err.notRunning"
    };
    const SVG_NS = "http://www.w3.org/2000/svg";
    // Byte counts as B below 1 KiB, then KiB or MiB with one decimal.
    function byteSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    }
    function inputIcon(label) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 12 12");
        svg.setAttribute("class", "rtt-ch-io");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", label);
        const title = document.createElementNS(SVG_NS, "title");
        title.textContent = label;
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", "M4 10V2M1.5 4.5 4 2l2.5 2.5M8 2v8M5.5 7.5 8 10l2.5-2.5");
        svg.append(title, path);
        return svg;
    }
    function create({ api, t, uiState }) {
        const section = document.getElementById("rttSection"),
            stateIcon = document.getElementById("rttState"),
            label = document.getElementById("rttLabel"),
            toggle = document.getElementById("rttToggle"),
            terminals = document.getElementById("rttTerminals"),
            saveLog = document.getElementById("rttSaveLog"),
            timestamps = document.getElementById("rttTimestamps"),
            logPath = document.getElementById("rttLogPath"),
            channels = document.getElementById("rttChannels");
        if (!section || !label || !toggle || !channels) return null;
        uiState.rtt ||= { state: "stopped" };
        const state = uiState.rtt;
        let busy = false;
        // The reason lives in the notice box and the terminal; the label only names the state.
        function labelText(message, current) {
            if (current === "running") return t("rtt.running", { n: (message.channels?.up || []).length });
            if (current === "starting")
                return message.retry ? t("rtt.startingRetry", { attempts: message.retry.attempts }) : t("rtt.starting");
            if (current === "pending-host") {
                const op = YIELD_LABELS[message.yieldedFor];
                return op ? t("rtt.pending", { op: t(op) }) : t("rtt.pendingHost");
            }
            if (message.error) return t("rtt.failed");
            if (message.reason === "host-ended") return t("rtt.stoppedHostEnded");
            if (message.reason === "host-lost") return t("rtt.stoppedLost");
            return t("rtt.stopped");
        }
        function stateClass(message, current) {
            if (current === "running") return "on";
            if (current === "starting" || current === "pending-host") return "busy";
            return message.error || message.reason === "host-lost" ? "err" : "";
        }
        function modeText(mode) {
            const labels = MODE_LABELS[mode];
            return labels ? t(labels.label) : mode || t("rtt.metricUnknown");
        }
        function channelDiagnostics(message, channel, buffer) {
            const diagnostic = document.createElement("div");
            diagnostic.className = "rtt-ch-diagnostics";
            const unknown = t("rtt.metricUnknown");
            const metrics = document.createElement("div");
            metrics.className = "rtt-ch-metrics";
            // One labeled value; an unknown one shows a dash and names itself unknown on hover.
            const metric = (labelKey, value, title) => {
                const cell = document.createElement("div");
                cell.className = "rtt-metric";
                const key = document.createElement("span");
                key.className = "rtt-metric-k";
                key.textContent = t(labelKey);
                const shown = document.createElement("span");
                shown.className = "rtt-metric-v" + (value === null ? " muted" : "");
                shown.textContent = value === null ? "—" : value;
                cell.title = title || (value === null ? unknown : "");
                cell.append(key, shown);
                metrics.append(cell);
            };
            const notes = [];
            const rate = message.state === "running" ? buffer?.rateBytesPerSecond : null;
            metric("rtt.metric.rate", Number.isFinite(rate) && rate >= 0 ? `${Math.round(rate)} B/s` : null);
            const received = buffer?.receivedBytes;
            metric(
                "rtt.metric.received",
                Number.isSafeInteger(received) ? byteSize(received) : null,
                Number.isSafeInteger(received) ? `${received} B` : ""
            );
            const telemetry = message.targetTelemetry;
            const sample = (telemetry?.channels || []).find((entry) => entry.index === channel.index);
            if (
                message.state === "running" &&
                telemetry?.available === true &&
                Number.isFinite(telemetry.sampledAt) &&
                Number.isSafeInteger(sample?.usedBytes) &&
                Number.isSafeInteger(sample?.capacity) &&
                sample.usedBytes >= 0 &&
                sample.usedBytes <= sample.capacity
            ) {
                metric(
                    "rtt.metric.occupancy",
                    `${sample.usedBytes}/${sample.capacity} B`,
                    t("rtt.targetOccupancyHint")
                );
            } else {
                // The reason is the same for every channel; the list shows it once below the channels.
                const reason = TELEMETRY_REASONS[telemetry?.reason];
                const why = t("rtt.targetOccupancyUnknown", { reason: reason ? t(reason) : unknown });
                metric("rtt.metric.occupancy", null, why);
                diagnostic.dataset.occupancyNote = why;
            }
            const evicted = buffer?.start;
            metric(
                "rtt.metric.evicted",
                Number.isSafeInteger(evicted) ? byteSize(evicted) : null,
                t("rtt.targetLossUnknown")
            );
            if (channel.modeState === "pending" || channel.modeState === "mismatch")
                notes.push({
                    warn: true,
                    text: t(channel.modeState === "pending" ? "rtt.modePending" : "rtt.modeMismatch", {
                        desired: modeText(channel.desiredMode),
                        actual: modeText(channel.mode)
                    })
                });
            diagnostic.append(metrics);
            for (const note of notes) {
                const line = document.createElement("div");
                line.className = "rtt-ch-note" + (note.warn ? " warn" : "");
                line.textContent = note.text;
                diagnostic.append(line);
            }
            return diagnostic;
        }
        // Channel names come from the firmware, so they render as text nodes, never as markup.
        function renderChannels(message) {
            channels.replaceChildren();
            const up = message.channels?.up || [];
            if (!up.length) {
                const empty = document.createElement("div");
                empty.className = "empty";
                empty.dataset.i18n = "rtt.empty";
                empty.textContent = t("rtt.empty");
                channels.append(empty);
                return;
            }
            const down = new Map((message.channels?.down || []).map((channel) => [channel.index, channel]));
            const buffers = new Map((message.buffers || []).map((buffer) => [buffer.channel, buffer]));
            const shared = new Set();
            for (const channel of up) {
                const row = document.createElement("div");
                row.className = "rtt-ch";
                const index = document.createElement("span");
                index.className = "rtt-ch-index";
                index.textContent = t("rtt.channel", { n: channel.index });
                const name = document.createElement("span");
                name.className = "rtt-ch-name";
                name.textContent = channel.name || t("rtt.channelDefault");
                const modeLabels = MODE_LABELS[channel.mode];
                const mode = document.createElement("span");
                mode.className = "tag" + (channel.mode === "block" ? " warn" : "");
                mode.textContent = modeText(channel.mode);
                if (modeLabels) mode.title = t(modeLabels.hint);
                row.append(index, name, mode);
                if ((down.get(channel.downChannel ?? channel.index)?.size || 0) > 0)
                    row.append(inputIcon(t("rtt.hasInput")));
                const buffer = buffers.get(channel.index);
                const online = buffer?.connected !== false;
                const link = t(online ? "rtt.connected" : "rtt.disconnected");
                const dot = document.createElement("i");
                dot.className = "rtt-ch-dot" + (online ? "" : " off");
                dot.setAttribute("role", "img");
                dot.setAttribute("aria-label", link);
                dot.title = link;
                const diagnostics = channelDiagnostics(message, channel, buffer);
                if (diagnostics.dataset.occupancyNote) shared.add(diagnostics.dataset.occupancyNote);
                row.append(dot, diagnostics);
                channels.append(row);
            }
            for (const text of shared) {
                const note = document.createElement("div");
                note.className = "rtt-ch-note rtt-channels-note";
                note.textContent = text;
                channels.append(note);
            }
        }
        function renderOption(button, enabled) {
            if (!button) return;
            button.classList.toggle("primary", enabled);
            button.setAttribute("aria-pressed", String(enabled));
        }
        function renderOptions() {
            const view = state.view || {};
            if (terminals) terminals.disabled = !(view.terminals > 0);
            renderOption(saveLog, view.log?.enabled === true);
            renderOption(timestamps, view.timestamps === true);
            if (!logPath) return;
            const directory = view.log?.directory || "";
            logPath.hidden = view.log?.enabled !== true;
            logPath.classList.toggle("warn", !directory);
            logPath.textContent = directory ? t("rtt.logPath", { path: directory }) : t("rtt.logNoDirectory");
            logPath.title = directory;
        }
        function render(message) {
            state.status = message = message || state.status || {};
            if (message.view) state.view = message.view;
            const currentState = message.state || "stopped";
            toggle.textContent = t(currentState !== "stopped" ? "sb.stop" : "sb.start");
            toggle.disabled = busy;
            if (stateIcon) stateIcon.className = `live-state ${stateClass(message, currentState)}`.trim();
            if (label.hasAttribute("data-i18n")) label.removeAttribute("data-i18n");
            label.textContent = labelText(message, currentState);
            renderChannels(message);
            renderOptions();
        }
        toggle.onclick = () => {
            if (toggle.disabled || !api) return;
            api.postMessage({
                type: "executeCommand",
                cmd:
                    state.status.state && state.status.state !== "stopped"
                        ? "mcu-vscode.stopRtt"
                        : "mcu-vscode.startRtt"
            });
        };
        render();
        return {
            render() {
                render(state.status);
            },
            setBusy(next) {
                busy = next;
                toggle.disabled = next;
            },
            onStatus(message) {
                render(message);
            },
            // A failure the user did not watch happen must not stay hidden in a collapsed card.
            reveal() {
                section.open = true;
                section.scrollIntoView?.({ block: "nearest" });
            }
        };
    }
    return { create };
});
