"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");
const { AgentBridge } = require("../src/agentBridge");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { loadProvider } = require("./helpers/load-provider");
const exec = promisify(execFile);

(async () => {
    for (const lang of ["zh", "en"]) {
        const value = "C:\\工具 <test>\\STM32CubeMX.exe";
        const view = render(getModernWebviewContent({ cubemxPath: value, iocPath: "C:\\工程\\demo.ioc" }, lang));
        try {
            view.assertHealthy();
            const button = view.document.querySelector('#otherConfig [data-command="mcu-vscode.selectCubeMx"]');
            assert(button);
            assert.strictEqual(button.querySelector("small").title, value);
            button.click();
            assert.strictEqual(view.messages.at(-1).cmd, "mcu-vscode.selectCubeMx");
            view.document.querySelector('#otherConfig [data-command="mcu-vscode.selectIoc"]').click();
            assert.strictEqual(view.messages.at(-1).cmd, "mcu-vscode.selectIoc");
            const toggle = view.document.getElementById("skillStatus");
            assert.strictEqual(toggle.getAttribute("role"), "switch");
            view.send({
                type: "skillStatus",
                scopes: { workspace: { state: "notInstalled" }, global: { state: "installed" } }
            });
            assert.strictEqual(toggle.getAttribute("aria-checked"), "false");
            toggle.click();
            assert.strictEqual(view.messages.at(-1).cmd, "mcu-vscode.manageAgentSkills");
            assert.strictEqual(toggle.disabled, true);
            view.send({ type: "skillStatus", installed: 9, total: 9, scopes: { workspace: { state: "installed" } } });
            assert.strictEqual(toggle.getAttribute("aria-checked"), "true");
            assert.strictEqual(toggle.textContent, "");
            assert.strictEqual(toggle.disabled, false);
            view.send({ type: "skillStatus", scopes: { workspace: null } });
            assert.strictEqual(toggle.disabled, true);
            const icons = [
                view.document.querySelector("#svdSelect svg"),
                button.querySelector("svg"),
                view.document.querySelector('[data-command="mcu-vscode.selectIoc"] svg')
            ];
            assert.strictEqual(new Set(icons.map((icon) => icon.innerHTML)).size, 3);
        } finally {
            view.window.close();
        }
    }
    let scans = 0;
    const Provider = loadProvider(
        { window: { showInformationMessage() {}, showWarningMessage() {} } },
        {
            "./autoDetect": { detectWorkspace: async () => ({}) }
        }
    );
    const provider = Object.create(Provider.prototype);
    provider._cubemxConfiguration = {
        detectIoc: async () => {
            scans++;
            return "demo.ioc";
        }
    };
    provider._context = { workspaceState: { get: () => "", update: async () => {} } };
    provider.updateView = () => {};
    provider._t = (key) => key;
    await provider.runAutoDetect(false);
    assert.strictEqual(scans, 0, "automatic sidebar detection must not select an ioc");
    await provider.runAutoDetect(true);
    assert.strictEqual(scans, 1);

    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-bridge-")));
    const calls = [];
    const bridge = new AgentBridge(
        root,
        async (method, params) => {
            calls.push({ method, params });
            return { method, params };
        },
        path.join(root, "storage")
    );
    try {
        await bridge.start();
        const script = path.resolve(__dirname, "../skills/mcu-cubemx/scripts/cubemx.js");
        const candidate = path.join(root, "candidate.txt");
        await fs.writeFile(candidate, "configuration");
        for (const action of ["detect", "inspect", "prepare", "execute", "permission", "reset-permission", "cancel"]) {
            const argv = [script, "--workspace", root, "--" + action];
            if (action === "prepare" || action === "execute") argv.push("--candidate", candidate);
            if (action === "execute") argv.push("--confirm", "approval", "--remember");
            const result = JSON.parse((await exec(process.execPath, argv)).stdout);
            assert.strictEqual(result.method, "cubemx." + (action === "reset-permission" ? "permission" : action));
        }
        const execution = calls.find((call) => call.method === "cubemx.execute");
        assert.strictEqual(execution.params.candidatePath, candidate);
        assert.strictEqual(execution.params.confirmationId, "approval");
        assert.strictEqual(execution.params.remember, true);
        assert(/^req_/.test(execution.params.requestId), "execute sends a generated request id");
        // Re-running the same command reuses the persisted request id so the service-side
        // dedup returns the original operation instead of generating again.
        await exec(process.execPath, [
            script,
            "--workspace",
            root,
            "--execute",
            "--candidate",
            candidate,
            "--confirm",
            "approval",
            "--remember"
        ]);
        const executions = calls.filter((call) => call.method === "cubemx.execute");
        assert.strictEqual(executions.length, 2);
        assert.strictEqual(executions[1].params.requestId, executions[0].params.requestId);
        assert.deepStrictEqual(calls.find((call) => call.params.action === "reset").params, { action: "reset" });
        await assert.rejects(
            exec(process.execPath, [script, "--unknown"]),
            (error) => error.code === 1 && !!JSON.parse(error.stderr).error
        );
    } finally {
        await bridge.stop();
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("CubeMX sidebar, startup detection and Bridge CLI integration tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
