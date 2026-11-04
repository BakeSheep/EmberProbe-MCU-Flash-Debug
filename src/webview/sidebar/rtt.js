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
    const SVG_NS = "http://www.w3.org/2000/svg";
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
            const connected = new Map((message.buffers || []).map((buffer) => [buffer.channel, buffer.connected]));
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
                mode.textContent = modeLabels ? t(modeLabels.label) : channel.mode;
                if (modeLabels) mode.title = t(modeLabels.hint);
                row.append(index, name, mode);
                if ((down.get(channel.index)?.size || 0) > 0) row.append(inputIcon(t("rtt.hasInput")));
                const online = connected.get(channel.index) !== false;
                const link = t(online ? "rtt.connected" : "rtt.disconnected");
                const dot = document.createElement("i");
                dot.className = "rtt-ch-dot" + (online ? "" : " off");
                dot.setAttribute("role", "img");
                dot.setAttribute("aria-label", link);
                dot.title = link;
                row.append(dot);
                channels.append(row);
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
