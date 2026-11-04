"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeAgentControls = factory();
})(globalThis, function () {
    function create({ document, api, state, uiState, setNotice, clearNotice, t }) {
        const control = document.getElementById("agentFullAccess");
        const error = document.getElementById("agentPermissionError");
        state.agentPermissions = { fullAccess: false, available: false };
        control.onclick = () => {
            if (control.disabled || !api) return;
            control.disabled = true;
            api.postMessage({ type: "setAgentFullAccess", enabled: !state.agentPermissions.fullAccess });
        };
        const receive = (message) => {
            state.agentPermissions = { fullAccess: message.fullAccess === true, available: message.available === true };
            control.setAttribute("aria-checked", String(state.agentPermissions.fullAccess));
            control.disabled = !state.agentPermissions.available || message.busy === true;
            error.textContent = message.error || "";
            error.hidden = !message.error;
        };
        const localized = (tag, key, className) => {
            const element = document.createElement(tag);
            element.className = className || "";
            element.setAttribute("data-i18n", key);
            element.textContent = t(key);
            return element;
        };
        function clientRow(item, busy) {
            const row = document.createElement("div");
            row.className = `mcp-client mcp-client-${item.state}`;
            row.dataset.client = item.client;
            const copy = document.createElement("span");
            copy.className = "row-copy";
            const status = localized("small", `mcp.state.${item.state}`);
            status.title = item.error || item.files.join("\n");
            const name = localized("span", `mcp.client.${item.client}`, "mcp-client-name");
            name.setAttribute("data-i18n-title", `mcp.client.${item.client}`);
            name.title = name.textContent;
            copy.append(name, status);
            row.append(copy);
            for (const action of item.actions) {
                const button = localized("button", `mcp.action.${action}`, "mini agent-install");
                button.type = "button";
                button.dataset.action = action;
                button.disabled = busy;
                button.setAttribute("aria-describedby", `mcpClient-${item.client}`);
                button.onclick = () => {
                    state.mcpClients.busy = item.client;
                    for (const other of document.querySelectorAll("#mcpClientList button")) other.disabled = true;
                    api?.postMessage({ type: "mcpClientAction", client: item.client, action });
                };
                row.append(button);
            }
            copy.firstChild.id = `mcpClient-${item.client}`;
            return row;
        }
        function renderClients(message) {
            const { clients = [], busy = "", error: failure = "" } = message;
            state.mcpClients = { clients, busy };
            document.getElementById("mcpClientList").replaceChildren(...clients.map((item) => clientRow(item, !!busy)));
            const failed = document.getElementById("mcpClientError");
            failed.textContent = failure;
            failed.hidden = !failure;
        }
        function renderSkills(message) {
            const el = document.getElementById("skillStatus");
            if (!el) return;
            const workspace = message?.scopes?.workspace;
            uiState.sidebarStatus ||= {};
            uiState.sidebarStatus.skill = {
                state: message.state,
                busy: !!message.busy,
                scopes: workspace ? { workspace: { state: workspace.state } } : {}
            };
            api?.setState?.(uiState);
            el.classList.toggle("status-ready", !!workspace || message.state !== "checking");
            el.setAttribute("aria-checked", String(!!workspace && workspace.state !== "notInstalled"));
            el.disabled = !workspace || !!message.busy;
        }
        function renderAccess(message) {
            refresh();
            const card = message?.card || "";
            if (!card) clearNotice("global", "agent-access");
            else
                setNotice("global", "agent-access", {
                    level: "info",
                    text: { key: card === "enabled" ? "agent.accessEnabled" : "agent.accessDisabled" },
                    actions: [
                        {
                            label: { key: card === "enabled" ? "agent.disable" : "agent.enable" },
                            primary: card !== "enabled",
                            command:
                                card === "enabled" ? "mcu-vscode.disableAgentAccess" : "mcu-vscode.enableAgentAccess"
                        }
                    ],
                    dismissible: false
                });
            const old = message?.legacyGlobal;
            if (!old) clearNotice("global", "agent-legacy");
            else
                setNotice("global", "agent-legacy", {
                    level: "warning",
                    text: { key: "agent.legacyGlobal", params: { version: old.version || "?" } },
                    actions: [{ label: { key: "agent.cleanup" }, command: "mcu-vscode.cleanupGlobalSkills" }],
                    dismissible: false
                });
        }
        const skillToggle = document.getElementById("skillStatus");
        if (skillToggle)
            skillToggle.onclick = () => {
                if (skillToggle.disabled || !api) return;
                skillToggle.classList.add("animate");
                skillToggle.disabled = true;
                api.postMessage({ type: "executeCommand", cmd: "mcu-vscode.manageAgentSkills" });
            };
        const refresh = () => api?.postMessage({ type: "getAgentPermissions" });
        const card = document.getElementById("agentConfigSection");
        // Client configuration changes outside the editor, so it is read again whenever the card can be seen.
        const refreshClients = () => {
            if (card.open) api?.postMessage({ type: "getMcpClients" });
        };
        card.addEventListener("toggle", refreshClients);
        document.defaultView.addEventListener("focus", () => {
            refresh();
            refreshClients();
        });
        refresh();
        api?.postMessage({ type: "getMcpClients" });
        return { receive, renderSkills, renderAccess, renderClients };
    }
    return { create };
});
