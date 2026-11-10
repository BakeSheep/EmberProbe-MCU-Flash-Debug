"use strict";

const { CACHE_KEYS } = require("../cacheKeys");
const { normalizeWatchList } = require("../validation");

class SidebarDataBreakpoints {
    constructor({ host, bridge, vscode }) {
        this.host = host;
        this.bridge = bridge;
        this.vscode = vscode;
        this.tail = Promise.resolve();
    }
    status() {
        const session = this.bridge.activeSession;
        return {
            sessionId: session?.type === "emberprobe" ? session.id : null,
            paused: this.bridge.paused,
            epoch: this.bridge.stopEpoch,
            available:
                session?.type === "emberprobe" &&
                !this.bridge.conflict &&
                !this.bridge.replBusy &&
                !this.bridge.transitionKind
        };
    }
    post(body = {}) {
        const message = { type: "sidebarDataBreakpoints", ...body, ...this.status() };
        this.host._webviewView?.webview.postMessage(message);
        return message;
    }
    changed() {
        // Status invalidates open menus immediately; list is explicitly requested by the view.
        this.post({ invalidated: true });
    }
    adapterMessage(session, message) {
        if (
            session === this.bridge.activeSession &&
            message?.type === "event" &&
            message.event === "emberprobe.sidebarDataBreakpointsChanged"
        )
            this.post(message.body);
    }
    validateName(name) {
        const entries = normalizeWatchList([{ name }], this.host.readElfSymbols().symbols);
        const entry = entries[0];
        // Runtime display paths can contain synthetic .value or STL summaries. They must
        // never be reinterpreted as similarly named C++ members by GDB.
        if (!entry || entry.isComposite || entry.runtimeLayout || entry.bitSize !== undefined)
            throw new Error(this.host._t("sb.dataUnsupported"));
        return entry.name;
    }
    // Bridge requests run one at a time in arrival order. A busy flag rejected the automatic
    // list refresh or the menu's storage query whenever the two overlapped.
    exclusive(task) {
        const run = this.tail.then(task, task);
        this.tail = run.catch(() => {});
        return run;
    }
    current(message) {
        const status = this.status();
        if (!status.available) throw new Error(this.host._t("sb.dataNoSession"));
        if (message.sessionId !== status.sessionId || message.epoch !== status.epoch)
            throw new Error(this.host._t("sb.dataStale"));
        return this.bridge.activeSession;
    }
    async request(message) {
        this.current(message);
        if (!["pause", "list", "info", "add", "enable", "condition", "remove"].includes(message.action))
            throw new Error(this.host._t("sb.dataUnsupported"));
        let condition;
        if (message.action === "condition") {
            // Ask before queueing so an open input box never holds up other menu requests.
            condition = await this.vscode.window.showInputBox({
                prompt: this.host._t("sb.dataConditionPrompt"),
                value: message.condition || "",
                validateInput: (value) =>
                    value.length > 1024 || /[\x00-\x1f\x7f]/.test(value) ? this.host._t("sb.dataUnsupported") : null
            });
            if (condition === undefined) return this.post({ requestId: message.requestId, cancelled: true });
        }
        return this.exclusive(async () => {
            // Re-check after waiting in the queue: a resume or session switch makes the request stale.
            const session = this.current(message);
            if (message.action === "pause") {
                await this.bridge.control("pause");
                if (session !== this.bridge.activeSession) throw new Error(this.host._t("sb.dataStale"));
                return this.post({ requestId: message.requestId, action: "pause" });
            }
            if (message.action !== "list") this.bridge.assertPausedAccess();
            const epoch = this.bridge.stopEpoch;
            const inspection = this.bridge.inspectionEpoch;
            const elfGeneration = this.host._elfService?.generation;
            const args = { action: message.action, generation: message.generation, id: message.id };
            if (["info", "add"].includes(message.action)) args.name = this.validateName(message.name);
            if (message.action === "add")
                Object.assign(args, {
                    dataId: message.dataId,
                    accessType: message.accessType,
                    description: message.description
                });
            if (message.action === "enable") args.enabled = message.enabled;
            if (message.action === "condition") args.condition = condition;
            const guard = () => {
                if (
                    session !== this.bridge.activeSession ||
                    epoch !== this.bridge.stopEpoch ||
                    inspection !== this.bridge.inspectionEpoch ||
                    elfGeneration !== this.host._elfService?.generation ||
                    this.bridge.transitionKind ||
                    this.bridge.replBusy
                )
                    throw new Error(this.host._t("sb.dataStale"));
            };
            guard();
            const result = await session.customRequest("emberprobe.sidebarDataBreakpoints", args);
            guard();
            return this.post({ ...result, requestId: message.requestId, action: message.action });
        });
    }
    async pruneWatchList(items) {
        const previous = this.host._watchLists.read(CACHE_KEYS.sidebarWatchList);
        const removed = previous
            .filter((entry) => !items.some((item) => item.name === entry.name))
            .map((entry) => entry.name);
        if (!removed.length || this.bridge.activeSession?.type !== "emberprobe") return;
        await this.exclusive(async () => {
            const session = this.bridge.assertUniqueSession();
            const guard = () => {
                if (session !== this.bridge.activeSession || this.bridge.replBusy || this.bridge.transitionKind)
                    throw new Error(this.host._t("sb.dataStale"));
            };
            const before = await session.customRequest("emberprobe.sidebarDataBreakpoints", { action: "list" });
            guard();
            const covered = before.entries.some((entry) =>
                removed.some(
                    (name) =>
                        entry.name === name || entry.name.startsWith(name + ".") || entry.name.startsWith(name + "[")
                )
            );
            if (!covered) return;
            // Never pause here: a running target is interrupted and resumed by the adapter's
            // whole-set update, so removing a watch row (also from the Agent) cannot halt the MCU.
            await session.customRequest("emberprobe.sidebarDataBreakpoints", { action: "removeNames", names: removed });
        });
    }
}

module.exports = { SidebarDataBreakpoints };
