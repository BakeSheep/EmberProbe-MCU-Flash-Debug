"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

const configured = { elf: "app.elf", debugger: "interface/stlink.cfg", mcu: "stm32f4x.cfg" };

scenario("Show installed CubeMX versions inline and mismatched requirements in the configuration notice", () => {
    for (const [state, versions] of [
        ["version-mismatch", ["1.11.0"]],
        ["version-mismatch", ["1.13.0", "1.11.0"]],
        ["missing", []],
        ["unknown", []],
        ["installed", ["1.12.1", "1.13.0"]]
    ]) {
        const required = "1.12.1";
        const page = render(
            getModernWebviewContent(
                {
                    ...configured,
                    cubemxStatus: "CubeMX 已就绪",
                    cubemxFirmware: { family: "H7", requiredVersion: required, versions, state }
                },
                "zh"
            )
        );
        try {
            const row = page.document.querySelector(".cubemx-config-row");
            assert.strictEqual(row.parentElement, page.document.querySelector("#otherConfig > .tree"));
            assert.strictEqual(row.previousElementSibling.dataset.command, "mcu-vscode.selectIoc");
            assert.strictEqual(row.querySelector(".cubemx-firmware-label").textContent, "CubeMX / 固件包");
            assert.strictEqual(row.querySelector(".cubemx-package-name").textContent, "STM32Cube H7");
            assert.strictEqual(row.querySelector(".cubemx-current-version").textContent, versions.join(", ") || "—");
            assert.ok(!row.textContent.includes("需求") && !row.textContent.includes("已就绪"));
            assert.strictEqual(row.querySelector("details, select"), null);
            assert.strictEqual(row.querySelectorAll("button").length, 1);
            assert.strictEqual(row.querySelector(".tag").textContent, "可选");

            const notice = page.document.querySelector('[data-notice-id="cubemx-firmware"]');
            if (state === "version-mismatch") {
                assert.strictEqual(notice.closest("details").id, "otherConfig");
                assert.ok(page.document.getElementById("noticeConfig").hidden);
                assert.ok(notice.classList.contains("notice--warning"));
                assert.strictEqual(notice.querySelector(".notice-title").textContent, "固件包版本不匹配");
                assert.strictEqual(
                    notice.querySelector("li").textContent,
                    `STM32Cube H7 需要 ${required}，已安装 ${versions.join(", ")}。`
                );
            } else assert.strictEqual(notice, null);

            const refresh = row.querySelector(".cubemx-refresh");
            assert.strictEqual(page.window.getComputedStyle(refresh).borderRadius, "4px");
            refresh.click();
            assert.strictEqual(page.messages.at(-1).cmd, "mcu-vscode.refreshCubeMxFirmware");
            page.send({ type: "setLang", lang: "en" });
            assert.strictEqual(refresh.title, "Recheck firmware");
            assert.strictEqual(
                page.document.getElementById(refresh.getAttribute("aria-labelledby")).textContent,
                "Recheck firmware"
            );
            assert.strictEqual(row.querySelector(".tag").textContent, "Optional");
            if (notice) {
                assert.strictEqual(
                    page.document.querySelector("#noticeFirmware li").textContent,
                    `STM32Cube H7 requires ${required}. Installed versions ${versions.join(", ")}.`
                );
            }
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
});

scenario("Keep tool failures visible without repeating successful CubeMX detection", () => {
    for (const [status, error, expected] of [
        ["CubeMX 已就绪", "", ""],
        ["CubeMX is ready", "", ""],
        ["已找到 CubeMX2 安装", "", ""],
        ["未找到 CubeMX", "", "未找到 CubeMX"],
        ["CubeMX 已就绪", '<invalid path>"', "固件包待确认"]
    ]) {
        const page = render(getModernWebviewContent({ cubemxStatus: status, cubemxFirmwareError: error }, "zh"));
        try {
            const message = page.document.querySelector(".cubemx-status");
            assert.strictEqual(message.textContent, expected);
            if (error) assert.strictEqual(message.title, error);
            assert.strictEqual(page.document.querySelector('[data-command="mcu-vscode.installCubeMxFirmware"]'), null);
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
});

scenario("List all installed CubeMX2 pack versions and warn only for incompatible packs", () => {
    const packs = [
        { name: "stm32c5xx_dfp", requiredVersion: "^2.1.0", versions: ["2.0.0"], state: "version-mismatch" },
        { name: "cmsis", requiredVersion: "6.0.0", versions: ["6.0.0"], state: "installed" },
        { name: "hal", requiredVersion: "1.0.0", versions: ["1.1.0"], state: "version-mismatch" },
        { name: "conditional", requiredVersion: "${VERSION}", versions: ["2.0.0"], state: "unknown" }
    ];
    const page = render(getModernWebviewContent({ cubemxFirmware: { generator: "cubemx2", packs } }, "en"));
    try {
        const row = page.document.querySelector(".cubemx-config-row");
        assert.strictEqual(row.querySelector(".cubemx-firmware-label").textContent, "CubeMX2 / Packs");
        assert.strictEqual(row.querySelector("details, select"), null);
        assert.deepStrictEqual(
            Array.from(row.querySelectorAll(".cubemx-package-name"), (name) => name.textContent),
            packs.map(({ name }) => name)
        );
        assert.deepStrictEqual(
            Array.from(row.querySelectorAll(".cubemx-current-version"), (version) => version.textContent),
            packs.map(({ versions }) => versions.join(", "))
        );
        assert.deepStrictEqual(
            Array.from(page.document.querySelectorAll("#noticeFirmware li"), (item) => item.textContent),
            [
                "stm32c5xx_dfp requires ^2.1.0. Installed versions 2.0.0.",
                "hal requires 1.0.0. Installed versions 1.1.0."
            ]
        );
        page.assertHealthy();
    } finally {
        page.close();
    }
});

scenario("Keep CubeMX executable paths in machine-wide User settings rather than the sidebar", () => {
    const properties = Object.assign(
        {},
        ...require("../package.json").contributes.configuration.map((group) => group.properties)
    );
    for (const key of ["emberprobe.cubemxPath", "emberprobe.cubemx2Path"]) {
        assert.strictEqual(properties[key].scope, "machine");
        assert.strictEqual(properties[key].type, "string");
        assert.strictEqual(properties[key].default, "");
    }
    const sidebar = render(getModernWebviewContent(configured, "zh"));
    try {
        sidebar.assertHealthy();
        assert.strictEqual(sidebar.document.querySelector('[data-command="mcu-vscode.selectCubeMx"]'), null);
        assert.strictEqual(sidebar.document.querySelector('[data-command="mcu-vscode.selectCubeMx2"]'), null);
        assert.ok(sidebar.document.querySelector('#otherConfig [data-command="mcu-vscode.selectIoc"]'));
    } finally {
        sidebar.close();
    }
});

// MCU configuration is a folded card above flash/debug whose row names the chip family and probe.
let view = render(getModernWebviewContent(configured, "zh"));
try {
    view.assertHealthy();
    const doc = view.document;
    const config = doc.getElementById("mcuConfigSection");
    assert.strictEqual(config.nextElementSibling.id, "agentConfigSection");
    assert.strictEqual(config.nextElementSibling.nextElementSibling.id, "flashDebugSection");
    assert.strictEqual(config.previousElementSibling.id, "noticeGlobal");
    assert.strictEqual(config.open, false, "the configuration card is folded on first use");
    const summary = doc.getElementById("mcuConfigSummary");
    assert.strictEqual(summary.textContent, "STM32F4x · ST-Link");
    assert.strictEqual(config.querySelector("summary .config-title").textContent, "MCU 配置");
    view.send({ type: "setLang", lang: "en" });
    assert.strictEqual(config.querySelector("summary .config-title").textContent, "MCU Configuration");
    assert.strictEqual(summary.textContent, "STM32F4x · ST-Link", "a language change keeps the summary");
    view.send({ type: "debuggerConfig", debugger: "jlink.cfg" });
    assert.strictEqual(summary.textContent, "STM32F4x · J-Link");
    view.send({ type: "debuggerConfig", debugger: "" });
    assert.strictEqual(summary.textContent, "", "an incomplete configuration names nothing");

    // Agent integrations have their own peer card and fold independently of MCU configuration.
    const agents = doc.getElementById("agentConfigSection");
    assert.strictEqual(agents.open, false);
    assert.strictEqual(agents.parentElement, config.parentElement);
    assert.strictEqual(doc.getElementById("skillStatus").closest("details"), agents);
    assert.strictEqual(doc.getElementById("skillStatus").closest("#memoryAnalysisSection"), null);
    assert.strictEqual(doc.querySelector(".skill-row, .skill-tree"), null);
    const optional = agents.querySelector(":scope > summary > .tag");
    assert.strictEqual(optional.textContent, "Optional");
    assert.strictEqual(view.window.getComputedStyle(optional).borderRadius, "4px");
    // MCP clients sit in their own dropdown, folded until asked for.
    const mcpMenu = doc.getElementById("mcpClientsSection");
    assert.strictEqual(mcpMenu.parentElement.closest("details"), agents);
    assert.strictEqual(mcpMenu.open, false);
    assert.strictEqual(doc.getElementById("mcpClientList").closest("details"), mcpMenu);
    const mcpLabel = doc.getElementById("mcpLabel");
    const checkMcpConnection = doc.getElementById("mcpCheckConnection");
    const mcpNotice = () => doc.querySelector('[data-notice-id="mcp-connection"]');
    assert.strictEqual(mcpLabel.textContent, "MCP server");
    assert.strictEqual(mcpLabel.nextElementSibling, checkMcpConnection);
    assert.ok(checkMcpConnection.querySelector("svg"));
    assert.strictEqual(checkMcpConnection.title, "Recheck MCP connection");
    checkMcpConnection.click();
    assert.strictEqual(mcpMenu.open, true, "refresh reveals the connection status inside the server section");
    assert.deepStrictEqual(view.messages.at(-1), { type: "checkMcpConnection" });
    assert.strictEqual(checkMcpConnection.disabled, true);
    assert.strictEqual(mcpNotice().closest("details"), mcpMenu);
    assert.strictEqual(mcpNotice().querySelector(".notice-text").textContent, "Checking…");
    view.send({ type: "mcpConnection", state: "connected", toolCount: 42 });
    assert.strictEqual(checkMcpConnection.disabled, false);
    assert.strictEqual(mcpNotice().querySelector(".notice-text").textContent, "MCP connected · 42 tools");
    assert.ok(view.messages.some((message) => message.type === "getMcpClients"));
    view.send({
        type: "mcpClients",
        busy: "",
        clients: [
            { client: "copilot", state: "builtin", actions: [], files: [] },
            { client: "claude", state: "installed", actions: ["uninstall"], files: ["/home/.claude.json"] },
            { client: "codex", state: "outdated", actions: ["upgrade", "uninstall"], files: ["/home/config.toml"] },
            { client: "gemini", state: "notInstalled", actions: ["install"], files: [] },
            { client: "json", state: "invalid", actions: ["copy"], files: [], error: "broken file" }
        ]
    });
    const client = (name) => agents.querySelector(`[data-client="${name}"]`);
    const actions = (name) => [...client(name).querySelectorAll("button")].map((button) => button.textContent);
    assert.deepStrictEqual(actions("claude"), ["Remove"]);
    assert.deepStrictEqual(actions("codex"), ["Upgrade", "Remove"]);
    assert.deepStrictEqual(actions("gemini"), ["Install"]);
    assert.strictEqual(client("claude").querySelector("small").textContent, "Installed");
    assert.strictEqual(client("claude").querySelector("small").title, "/home/.claude.json");
    assert.strictEqual(client("codex").querySelector("small").textContent, "Outdated");
    assert.strictEqual(client("copilot").querySelector("small").textContent, "Built in");
    assert.deepStrictEqual(actions("copilot"), []);
    assert.strictEqual(client("json").querySelector("small").title, "broken file");
    view.send({ type: "setLang", lang: "zh" });
    assert.deepStrictEqual(actions("codex"), ["升级", "移除"]);
    assert.strictEqual(checkMcpConnection.title, "重新检测 MCP 连通性");
    assert.strictEqual(mcpNotice().querySelector(".notice-text").textContent, "MCP 已连通 · 42 个工具");
    for (const [state, error] of [
        ["initialize", "无法启动或初始化 EmberProbe MCP 服务器。"],
        ["tools", "MCP 服务器未返回工具列表。"],
        ["timeout", "MCP 连通性检测超时。"]
    ]) {
        checkMcpConnection.click();
        view.send({ type: "mcpConnection", state });
        assert.strictEqual(checkMcpConnection.disabled, false);
        assert.strictEqual(mcpNotice().getAttribute("role"), "alert");
        assert.strictEqual(mcpNotice().querySelector(".notice-text").textContent, error);
    }
    checkMcpConnection.click();
    mcpMenu.open = false;
    view.send({ type: "mcpConnection", state: "connected", toolCount: 42 });
    assert.ok(mcpNotice().classList.contains("notice--success"));
    assert.strictEqual(mcpNotice().closest("details"), mcpMenu);
    assert.strictEqual(mcpMenu.open, false, "a completed check respects a subsequent collapse");
    client("codex").querySelector('[data-action="upgrade"]').click();
    assert.deepStrictEqual(view.messages.at(-1), { type: "mcpClientAction", client: "codex", action: "upgrade" });
    assert.ok(
        [...agents.querySelectorAll("#mcpClientList button")].every((button) => button.disabled),
        "one change runs at a time"
    );
    assert.strictEqual(config.open, false, "installing the MCP server needs no MCU configuration");
    view.send({ type: "mcpClients", clients: [], busy: "", error: "write failed" });
    assert.strictEqual(doc.getElementById("mcpClientError").textContent, "write failed");
    view.messages.length = 0;
    agents.open = true;
    agents.dispatchEvent(new view.window.Event("toggle"));
    assert.deepStrictEqual(view.messages.at(-1), { type: "getMcpClients" });
    view.messages.length = 0;
    view.window.dispatchEvent(new view.window.Event("focus"));
    assert.ok(view.messages.some((message) => message.type === "getMcpClients"));
    agents.open = false;
    view.messages.length = 0;
    view.window.dispatchEvent(new view.window.Event("focus"));
    assert.ok(!view.messages.some((message) => message.type === "getMcpClients"), "a folded card reads no files");

    // An operation that needs the configuration opens the card while it is incomplete.
    doc.querySelector('[data-command="mcu-vscode.download"]').click();
    assert.strictEqual(config.open, true);
    assert.strictEqual(view.getState().sections.mcuConfigSection, true);
} finally {
    view.close();
}

// A complete configuration stays folded when an operation runs.
view = render(getModernWebviewContent(configured, "en"));
try {
    view.document.querySelector('[data-command="mcu-vscode.download"]').click();
    assert.strictEqual(view.document.getElementById("mcuConfigSection").open, false);
} finally {
    view.close();
}

// The status line and the flash notices share one box; a notice takes the status line's place.
view = render(getModernWebviewContent({}, "en"));
try {
    const doc = view.document;
    const box = doc.querySelector("#flashDebugSection > .flash-notice-box");
    assert.ok(box.contains(doc.getElementById("statusText")));
    assert.ok(box.contains(doc.getElementById("noticeFlash")));
    view.send({ type: "initSuccess" });
    assert.strictEqual(doc.getElementById("statusText").textContent, "Extension service ready");
    assert.strictEqual(doc.getElementById("flashStatus").dataset.state, "ready");
    view.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: { level: "info", busy: true } });
    assert.strictEqual(doc.getElementById("noticeFlash").hidden, false);
    view.send({ type: "noticeClear", area: "flash", id: "mcu-vscode.download" });
    assert.strictEqual(doc.getElementById("noticeFlash").hidden, true);
} finally {
    view.close();
}
scenario("Workspace access stays first, follows host state and can retry failed changes", () => {
    const page = render(getModernWebviewContent({}, "zh"));
    try {
        const doc = page.document;
        const control = doc.getElementById("agentWorkspaceAccess");
        const row = doc.querySelector("#agentConfigSection .agent-block > :first-child");
        assert.ok(row.contains(control));
        assert.strictEqual(row.nextElementSibling.id, "mcpClientsSection");
        assert.strictEqual(control.getAttribute("aria-labelledby"), "agentWorkspaceAccessLabel");
        assert.strictEqual(doc.getElementById("agentWorkspaceAccessLabel").textContent, "工作区 Agent 访问");
        assert.strictEqual(control.disabled, true, "wait for authoritative access and workspace availability");
        page.send({ type: "agentAccess", access: "unset", enabled: false, card: "" });
        assert.strictEqual(control.disabled, true);
        page.send({ type: "agentPermissions", fullAccess: false, available: true });
        assert.strictEqual(control.disabled, false, "the switch exists even without skills or MCP configuration");
        control.click();
        assert.deepStrictEqual(page.messages.at(-1), {
            type: "executeCommand",
            cmd: "mcu-vscode.enableAgentAccess"
        });
        const count = page.messages.length;
        control.click();
        assert.strictEqual(page.messages.length, count, "ignore repeated clicks while saving");
        assert.strictEqual(control.getAttribute("aria-checked"), "false", "do not assume enabling succeeded");
        page.send({ type: "agentPermissions", fullAccess: false, available: true });
        assert.strictEqual(control.disabled, true, "permission refresh does not finish the access command");
        page.send({ type: "commandError", cmd: "mcu-vscode.enableAgentAccess" });
        assert.strictEqual(control.disabled, false, "failed changes can be retried");
        control.click();
        page.send({ type: "agentAccess", enabled: true, card: "enabled" });
        page.send({ type: "commandSuccess", cmd: "mcu-vscode.enableAgentAccess" });
        assert.strictEqual(control.getAttribute("aria-checked"), "true");
        assert.strictEqual(control.disabled, false);
        assert.strictEqual(doc.querySelector('#noticeGlobal [data-notice-id="agent-access"]'), null);
        control.click();
        assert.strictEqual(page.messages.at(-1).cmd, "mcu-vscode.disableAgentAccess");
        page.send({ type: "agentAccess", enabled: false, card: "disabled" });
        page.send({ type: "commandSuccess", cmd: "mcu-vscode.disableAgentAccess" });
        assert.strictEqual(control.getAttribute("aria-checked"), "false");
        page.send({ type: "agentAccess", access: "unset", enabled: true, card: "" });
        assert.strictEqual(control.getAttribute("aria-checked"), "true", "show access enabled by skills or MCP");
        page.send({ type: "agentPermissions", fullAccess: false, available: false });
        assert.strictEqual(control.disabled, true, "no access changes without an open, trusted workspace");
        page.send({ type: "setLang", lang: "en" });
        assert.strictEqual(doc.getElementById("agentWorkspaceAccessLabel").textContent, "Workspace Agent access");
        assert.strictEqual(control.getAttribute("aria-checked"), "true", "language changes preserve host state");
        page.send({ type: "agentAccess", enabled: false, legacyGlobal: { version: "1.0.0" } });
        assert.ok(doc.querySelector('#noticeGlobal [data-notice-id="agent-legacy"]'));
        page.assertHealthy();
    } finally {
        page.close();
    }
});
scenario("Full-access switch uses confirmed host state and reports failure without retaining a grant", () => {
    const page = render(getModernWebviewContent({}, "zh"));
    try {
        const control = page.document.getElementById("agentFullAccess");
        assert.strictEqual(control.disabled, true);
        assert.ok(page.messages.some((message) => message.type === "getAgentPermissions"));
        page.send({ type: "agentPermissions", fullAccess: false, available: true });
        control.click();
        assert.deepStrictEqual(page.messages.at(-1), { type: "setAgentFullAccess", enabled: true });
        assert.strictEqual(control.disabled, true);
        assert.strictEqual(control.getAttribute("aria-checked"), "false", "wait for the host to persist the grant");
        page.send({ type: "agentPermissions", fullAccess: true, available: true });
        assert.strictEqual(control.getAttribute("aria-checked"), "true");
        control.click();
        assert.deepStrictEqual(page.messages.at(-1), { type: "setAgentFullAccess", enabled: false });
        page.send({ type: "agentPermissions", fullAccess: false, available: true, error: "save failed" });
        assert.strictEqual(control.getAttribute("aria-checked"), "false");
        assert.strictEqual(control.disabled, false);
        assert.strictEqual(page.document.getElementById("agentPermissionError").textContent, "save failed");
        page.send({ type: "agentPermissions", fullAccess: false, available: false });
        assert.strictEqual(control.disabled, true);
        assert.strictEqual(page.document.getElementById("agentPermissionError").hidden, true);
        page.send({ type: "setLang", lang: "en" });
        assert.strictEqual(
            page.document.getElementById("agentFullAccessLabel").textContent,
            "Allow all Agent operations"
        );
        page.assertHealthy();
    } finally {
        page.close();
    }
});
console.log("Sidebar layout: peer MCU/Agent cards, confirmed permissions and shared flash notices");
