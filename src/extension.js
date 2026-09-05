"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require("vscode");
const openocdChecker = require("./openocdChecker");
const { MainViewProvider } = require("./mainViewProvider");
let activeProvider = null;

function activate(context) {
    console.log("MCU_VSCODE 下载与调试器已激活！");
    const provider = new MainViewProvider(context);
    activeProvider = provider;

    const subscriptions = [
        vscode.window.registerWebviewViewProvider("mcu-vscode.mainView", provider),
        vscode.commands.registerCommand("mcu-vscode.folderDebug", resource => provider.commandHandlers["mcu-vscode.debug"](resource)),
        vscode.commands.registerCommand("mcu-vscode.folderDownload", resource => provider.commandHandlers["mcu-vscode.download"](resource)),
        vscode.commands.registerCommand("mcu-vscode.openLiveWatch", () => provider.commandHandlers["mcu-vscode.openLiveWatch"]()),
        vscode.commands.registerCommand("mcu-vscode.manageAgentSkills", () => provider.commandHandlers["mcu-vscode.manageAgentSkills"]()),
        vscode.commands.registerCommand("mcu-vscode.downloadOfficialSvd", () => provider.commandHandlers["mcu-vscode.downloadOfficialSvd"]()),
        vscode.commands.registerCommand("mcu-vscode.selectExistingSvd", () => provider.commandHandlers["mcu-vscode.selectExistingSvd"]()),
        vscode.commands.registerCommand("mcu-vscode.switchWorkspaceSvd", () => provider.commandHandlers["mcu-vscode.switchWorkspaceSvd"]()),
        vscode.commands.registerCommand("mcu-vscode.checkOpenOcd", async () => {
            await vscode.commands.executeCommand("workbench.view.extension.mcu-vscode-container");
            await provider.refreshOpenOcdStatus(true);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("emberprobe.openocdPath")) {
                openocdChecker.resetCache();
                provider.refreshOpenOcdStatus(true);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await provider.stopAgentBridge().catch(() => {});
            provider.refreshSkillStatus().catch(() => {});
        }),
        {
            dispose: () => {
                provider.shutdown().catch(() => {});
            }
        },
        vscode.debug.registerDebugConfigurationProvider("cortex-debug", {
            async resolveDebugConfiguration(folder, config) {
                await provider.prepareForCortexDebug(folder, config);
                return config;
            }
        }),
        vscode.debug.registerDebugAdapterTrackerFactory("cortex-debug", {
            createDebugAdapterTracker(session) {
                provider.handleDebugSessionStart(session);
                return {
                    onWillReceiveMessage: message => provider.handleDebugAdapterRequest(session, message),
                    onDidSendMessage: message => provider.handleDebugAdapterMessage(session, message),
                    onError: error => console.error("Cortex-Debug adapter error:", error),
                    onExit: () => provider.handleDebugAdapterExit(session)?.catch(error => {
                        console.error("Unable to clean up after Cortex-Debug adapter exit:", error);
                    })
                };
            }
        }),
        vscode.debug.onDidStartDebugSession(session => provider.handleDebugSessionStart(session)),
        vscode.debug.onDidTerminateDebugSession(session => provider.handleDebugSessionTerminate(session).catch(error => {
            console.error("Unable to restore EmberProbe sampling after Cortex-Debug:", error);
        }))
    ];
    context.subscriptions.push(...subscriptions);

    provider.refreshOpenOcdStatus(false);
    provider.refreshSkillStatus().catch(() => {});
    if (process.env.EMBERPROBE_E2E === "1") {
        return { viewState: () => ({ sidebar: !!provider._sidebarReady, graph: [...provider._livePanels.values()].some(entry => entry.ready) }) };
    }
}

async function deactivate() {
    const provider = activeProvider;
    activeProvider = null;
    if (provider) {
        await provider.shutdown();
    }
    console.log("MCU_VSCODE 下载与调试器已停用！");
}
