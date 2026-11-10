"use strict";
// The bottom panel's RTT terminal: one screen per up channel (EmberProbeRttAnsi), channel tabs when there are several,
// and an input box below the output like the Debug Console's. In raw input mode the box gives way to keystrokes typed
// into the output area. The host keeps each channel's scrollback and sends it as a snapshot whenever this page loads.
const api = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
const I18N = window.__I18N__ || { zh: {}, en: {} };
const LANG = window.__LANG__ === "en" ? "en" : "zh";
function t(key, params) {
    return window.EmberProbeRuntime.translate(I18N, LANG, key, params);
}
const MAX_LINES = 10000;
const saved = (api?.getState && api.getState()) || {};
const state = {
    status: "stopped",
    inputMode: "line",
    channels: new Map(), // index -> { index, name, active, hasInput, screen, unread }
    selected: Number.isSafeInteger(saved.selected) ? saved.selected : null,
    history: {},
    pending: 0, // The id of the line being sent, 0 when none is.
    seq: 0,
    histPos: null,
    draft: ""
};
const tabs = document.getElementById("tabs"),
    output = document.getElementById("output"),
    lines = document.getElementById("lines"),
    empty = document.getElementById("empty"),
    inputRow = document.getElementById("inputRow"),
    input = document.getElementById("input"),
    inputError = document.getElementById("inputError"),
    rawHint = document.getElementById("rawHint");

function selectedChannel() {
    return state.channels.get(state.selected) || null;
}

function saveState() {
    api?.setState?.({ selected: state.selected });
}

function channelLabel(channel) {
    return "#" + channel.index + (channel.name ? " " + channel.name : "");
}

function renderTabs() {
    const list = [...state.channels.values()];
    tabs.hidden = list.length < 2;
    tabs.replaceChildren(
        ...list.map((channel) => {
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "tab";
            tab.setAttribute("role", "tab");
            tab.dataset.channel = String(channel.index);
            const selected = channel.index === state.selected;
            tab.setAttribute("aria-selected", String(selected));
            tab.classList.toggle("selected", selected);
            tab.classList.toggle("stopped", !channel.active);
            tab.classList.toggle("unread", !!channel.unread && !selected);
            // Channel names come from the firmware, so they render as text, never as markup.
            tab.textContent = channelLabel(channel);
            if (!channel.active) tab.title = t("rtt.panel.channelStopped");
            return tab;
        })
    );
}

// One row of a screen as styled spans.
function renderRow(screen, index) {
    const row = document.createElement("div");
    row.className = "line";
    for (const segment of screen.segments(index)) {
        const { classes, inline } = EmberProbeRttAnsi.styleClasses(segment.style);
        if (!classes.length && !inline.color && !inline.backgroundColor) {
            row.append(segment.text);
            continue;
        }
        const span = document.createElement("span");
        span.className = classes.join(" ");
        if (inline.color) span.style.color = inline.color;
        if (inline.backgroundColor) span.style.backgroundColor = inline.backgroundColor;
        span.textContent = segment.text;
        row.append(span);
    }
    return row;
}

function atBottom() {
    return output.scrollHeight - output.scrollTop - output.clientHeight < 4;
}

function scrollToBottom() {
    output.scrollTop = output.scrollHeight;
}

function renderScreen() {
    const channel = selectedChannel();
    empty.hidden = !!channel;
    if (!channel) {
        lines.replaceChildren();
        return;
    }
    const screen = channel.screen;
    lines.replaceChildren(...screen.lines.map((_line, index) => renderRow(screen, index)));
    scrollToBottom();
}

// Redraws what a write changed: rows it dropped from the top go, rows from its first changed one are rebuilt.
function renderChange(screen, change) {
    const follow = atBottom();
    for (let count = 0; count < change.dropped && lines.firstChild; count++) lines.firstChild.remove();
    while (lines.children.length > change.from) lines.lastChild.remove();
    for (let index = change.from; index < screen.lines.length; index++) lines.append(renderRow(screen, index));
    if (follow) scrollToBottom();
}

function select(index) {
    if (!state.channels.has(index)) return;
    state.selected = index;
    state.channels.get(index).unread = false;
    state.histPos = null;
    showInputError("");
    saveState();
    renderTabs();
    renderScreen();
    renderInput();
}

// Keeps the channel list in line with the host's, creating screens for new channels.
function syncChannels(list) {
    const next = new Map();
    for (const item of [...(list || [])].sort((a, b) => a.index - b.index)) {
        const channel = state.channels.get(item.index) || {
            index: item.index,
            screen: EmberProbeRttAnsi.createScreen({ maxLines: MAX_LINES }),
            unread: false
        };
        channel.name = item.name || "";
        channel.active = item.active === true;
        channel.hasInput = item.hasInput === true;
        next.set(item.index, channel);
    }
    const changed = next.size !== state.channels.size || [...next.keys()].some((key) => !state.channels.has(key));
    state.channels = next;
    if (!next.has(state.selected)) {
        state.selected = next.size ? next.keys().next().value : null;
        saveState();
        renderScreen();
    } else if (changed && lines.children.length === 0) renderScreen();
    renderTabs();
}

function applyStatus(message) {
    state.status = message.state || "stopped";
    state.inputMode = message.inputMode === "raw" ? "raw" : "line";
    state.history = message.history && typeof message.history === "object" ? message.history : {};
    syncChannels(message.channels);
    renderInput();
}

function usable() {
    const channel = selectedChannel();
    return state.status === "running" && !!channel?.active && !!channel.hasInput;
}

function renderInput() {
    const raw = state.inputMode === "raw";
    inputRow.hidden = raw;
    rawHint.hidden = !raw;
    output.tabIndex = raw ? 0 : -1;
    const running = state.status === "running";
    input.disabled = !usable() || state.pending !== 0;
    input.placeholder = t(running ? (usable() ? "rtt.input.placeholder" : "rtt.input.noDown") : "rtt.input.notRunning");
}

function showInputError(text) {
    inputError.textContent = text || "";
    inputError.hidden = !text;
}

function sentLines() {
    const sent = state.history[state.selected];
    return Array.isArray(sent) ? sent : [];
}

// Up and Down walk the channel's sent lines; the line being typed is kept as a draft below the newest one.
function recall(step) {
    const sent = sentLines();
    if (!sent.length) return;
    if (state.histPos === null) {
        if (step > 0) return;
        state.draft = input.value;
        state.histPos = sent.length;
    }
    const to = Math.min(sent.length, Math.max(0, state.histPos + step));
    state.histPos = to === sent.length ? null : to;
    input.value = to === sent.length ? state.draft : sent[to];
}

function submit() {
    if (!api || input.disabled || state.pending !== 0 || state.selected === null) return;
    state.pending = ++state.seq;
    showInputError("");
    api.postMessage({ type: "rttSend", id: state.pending, channel: state.selected, text: input.value });
    renderInput();
}

// Raw mode: what a key sends, as a terminal would encode it, or null for keys left to the page.
const RAW_KEYS = {
    Enter: "\r",
    Backspace: "\x7f",
    Tab: "\t",
    Escape: "\x1b",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Home: "\x1b[H",
    End: "\x1b[F",
    Delete: "\x1b[3~"
};
function rawKey(event) {
    if (event.metaKey || event.altKey) return null;
    if (event.ctrlKey) {
        // Copying a selection keeps working.
        if (event.key.toLowerCase() === "c" && String(window.getSelection?.() || "")) return null;
        if (event.key.length === 1 && /[a-z@[\\\]^_]/i.test(event.key))
            return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
        return null;
    }
    if (Object.hasOwn(RAW_KEYS, event.key)) return RAW_KEYS[event.key];
    return event.key.length === 1 || [...event.key].length === 1 ? event.key : null;
}

function sendRaw(data) {
    if (!api || !data || state.inputMode !== "raw" || !usable()) return;
    showInputError("");
    api.postMessage({ type: "rttSendRaw", channel: state.selected, data });
}

tabs.addEventListener("click", (event) => {
    const tab = event.target.closest?.(".tab");
    if (tab) select(Number(tab.dataset.channel));
});
inputRow.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
});
input.addEventListener("input", () => {
    state.histPos = null;
    showInputError("");
});
input.addEventListener("keydown", (event) => {
    // Enter and arrows during IME composition belong to the IME.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    recall(event.key === "ArrowUp" ? -1 : 1);
});
output.addEventListener("keydown", (event) => {
    if (state.inputMode !== "raw" || event.isComposing || event.keyCode === 229) return;
    const data = rawKey(event);
    if (data === null) return;
    event.preventDefault();
    sendRaw(data);
});
output.addEventListener("compositionend", (event) => sendRaw(event.data));
output.addEventListener("paste", (event) => {
    if (state.inputMode !== "raw") return;
    event.preventDefault();
    sendRaw(event.clipboardData?.getData("text") || "");
});
// A click that selects nothing puts the caret in the input box, as in the Debug Console.
output.addEventListener("mouseup", () => {
    if (state.inputMode === "line" && !input.disabled && !String(window.getSelection?.() || "")) input.focus();
});

EmberProbeMessages.connect(window, {
    rttPanelSnapshot(message) {
        state.channels = new Map();
        lines.replaceChildren();
        applyStatus(message);
        for (const item of message.channels || []) {
            const channel = state.channels.get(item.index);
            if (channel && item.text) channel.screen.write(item.text);
        }
        renderScreen();
    },
    rttPanelStatus(message) {
        applyStatus(message);
    },
    rttOutput(message) {
        const channel = state.channels.get(message.channel);
        if (!channel || typeof message.text !== "string") return;
        const change = channel.screen.write(message.text);
        if (channel.index === state.selected) renderChange(channel.screen, change);
        else if (!channel.unread) {
            channel.unread = true;
            renderTabs();
        }
    },
    // A sent line leaves the box; a refused one stays, with the reason.
    rttSendResult(message) {
        if (message.id !== state.pending) return;
        state.pending = 0;
        if (message.ok) {
            input.value = "";
            state.histPos = null;
            showInputError("");
        } else showInputError(message.message || t("rtt.input.invalid"));
        renderInput();
        input.focus?.();
    },
    rttInputProblem(message) {
        if (message.channel === state.selected) showInputError(message.message || t("rtt.input.invalid"));
    },
    rttClearRequest() {
        const channel = selectedChannel();
        if (!channel) return;
        channel.screen.clear();
        renderScreen();
        api?.postMessage({ type: "rttClear", channel: channel.index });
    }
});
renderInput();
api?.postMessage({ type: "ready" });
/* exported state */
