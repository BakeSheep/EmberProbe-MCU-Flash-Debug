"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require("vscode");
const openocdChecker = require("./openocdChecker");
const { MainViewProvider } = require("./mainViewProvider");
const { validateDebugConfiguration } = require("./services/debugConfiguration");
const { ReplFocusRestorer } = require("./services/replFocus");
let activeProvider = null;

function activate(context) {
    console.log("MCU_VSCODE 下载与调试器已激活！");
    const provider = new MainViewProvider(context);
    activeProvider = provider;
    const replFocus = new ReplFocusRestorer({ focusRepl: () => vscode.commands.executeCommand("workbench.debug.action.focusRepl") });
    const userSelection = [vscode.TextEditorSelectionChangeKind.Keyboard, vscode.TextEditorSelectionChangeKind.Mouse];

    const subscriptions = [
        vscode.window.registerWebviewViewProvider("mcu-vscode.mainView", provider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand("mcu-vscode.folderDebug", resource => provider.commandHandlers["mcu-vscode.debug"](resource)),
        vscode.commands.registerCommand("mcu-vscode.folderAttachDebug", resource => provider.commandHandlers["mcu-vscode.attachDebug"](resource)),
        vscode.commands.registerCommand("mcu-vscode.folderDownload", resource => provider.commandHandlers["mcu-vscode.download"](resource)),
        vscode.commands.registerCommand("mcu-vscode.openLiveWatch", () => provider.commandHandlers["mcu-vscode.openLiveWatch"]()),
        // Chart tabs left open at shutdown come back with their state when VS Code restarts.
        vscode.window.registerWebviewPanelSerializer("emberprobe.liveWatch", {
            deserializeWebviewPanel: async (panel, state) => provider.restoreLiveWatchPanel(panel, state)
        }),
        vscode.commands.registerCommand("mcu-vscode.manageAgentSkills", () => provider.commandHandlers["mcu-vscode.manageAgentSkills"]()),
        vscode.commands.registerCommand("mcu-vscode.installMcpServer", () => provider.commandHandlers["mcu-vscode.installMcpServer"]()),
        vscode.commands.registerCommand("mcu-vscode.enableAgentAccess", () => provider.commandHandlers["mcu-vscode.enableAgentAccess"]()),
        vscode.commands.registerCommand("mcu-vscode.disableAgentAccess", () => provider.commandHandlers["mcu-vscode.disableAgentAccess"]()),
        vscode.commands.registerCommand("mcu-vscode.downloadOfficialSvd", () => provider.commandHandlers["mcu-vscode.downloadOfficialSvd"]()),
        vscode.commands.registerCommand("mcu-vscode.selectExistingSvd", () => provider.commandHandlers["mcu-vscode.selectExistingSvd"]()),
        vscode.commands.registerCommand("mcu-vscode.switchWorkspaceSvd", () => provider.commandHandlers["mcu-vscode.switchWorkspaceSvd"]()),
        vscode.commands.registerCommand("mcu-vscode.checkOpenOcd", async () => {
            await vscode.commands.executeCommand("workbench.view.extension.mcu-vscode-container");
            await provider.refreshOpenOcdStatus(true);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("emberprobe.experimental.externalGdb")) provider.externalDebugSettingsChanged().catch(console.error);
            const connectionChanged = ["openocdPath", "transport", "probeSerial", "adapterSpeedKhz"].some(key => event.affectsConfiguration("emberprobe." + key));
            const samplingSpeedChanged = event.affectsConfiguration("emberprobe.samplingAdapterSpeedKhz");
            if (connectionChanged || samplingSpeedChanged) provider.connectionConfigurationChanged(samplingSpeedChanged, !connectionChanged);
            if (["sampleFrequencyHz", "sampleIntervalMs"].some(key => event.affectsConfiguration("emberprobe." + key))) provider.samplingFrequencyConfigurationChanged();
            if (event.affectsConfiguration("emberprobe.samplingArchiveMaxMiB")) provider.samplingArchiveConfigurationChanged();
            if (event.affectsConfiguration("emberprobe.cubemxPath")) provider._cubemxConfiguration.detect().catch(console.error);
            if (event.affectsConfiguration("emberprobe.mcp.toolsets")) provider.mcpConfigurationChanged();
            if (event.affectsConfiguration("emberprobe.openocdPath")) {
                openocdChecker.resetCache();
                provider.refreshOpenOcdStatus(true);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await provider.stopAgentBridge().catch(() => {});
            provider.refreshSkillStatus(true).catch(console.error);
            provider.mcpConfigurationChanged();
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            provider.scheduleGdbWarmup();
            provider.refreshSkillStatus(true).catch(console.error);
            provider.mcpConfigurationChanged();
        }),
        {
            dispose: () => {
                provider.shutdown().catch(() => {});
            }
        },
        vscode.debug.registerDebugConfigurationProvider("cortex-debug", {
            async resolveDebugConfiguration(folder, config) {
                const generation = provider.beginForeignDebug();
                try {
                    await provider.prepareForCortexDebug(folder, config);
                    return provider.isForeignDebugCurrent(generation) ? config : undefined;
                } catch (error) {
                    if (provider.isForeignDebugCurrent(generation)) provider.finishForeignDebug();
                    throw error;
                }
            }
        }),
        vscode.debug.registerDebugConfigurationProvider("emberprobe", {
            async resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
                if (!vscode.workspace.isTrusted) throw new Error("Debugging requires a trusted workspace");
                if (provider._matchesManagedDebugSession({ configuration: config })) return config;
                const validated = validateDebugConfiguration(config, folder);
                if (validated.servertype === "external") return provider.prepareExternalDebug(folder, validated);
                return await provider.commandHandlers["mcu-vscode.debug"](folder.uri, validated) || undefined;
            }
        }),
        ...["emberprobe", "cortex-debug"].map(type => vscode.debug.registerDebugAdapterTrackerFactory(type, {
            createDebugAdapterTracker(session) {
                provider.handleDebugSessionStart(session);
                // Only the built-in debugger returns focus to the Debug Console after console stepping.
                const focus = type === "emberprobe" ? replFocus : null;
                return {
                    onWillReceiveMessage: message => {
                        focus?.handleRequest(session, message);
                        provider.handleDebugAdapterRequest(session, message);
                    },
                    onDidSendMessage: message => {
                        focus?.handleMessage(session, message);
                        provider.handleDebugAdapterMessage(session, message);
                    },
                    onError: error => console.error("Debug adapter error:", error),
                    onExit: () => {
                        focus?.sessionEnded(session);
                        return provider.handleDebugAdapterExit(session)?.catch(error => {
                            console.error("Unable to clean up after debug adapter exit:", error);
                        });
                    }
                };
            }
        })),
        replFocus,
        vscode.window.onDidChangeActiveTextEditor(() => replFocus.editorActivity("reveal")),
        vscode.window.onDidChangeTextEditorSelection(event => {
            replFocus.editorActivity(userSelection.includes(event.kind) ? "user" : "reveal");
        }),
        vscode.debug.onDidStartDebugSession(session => provider.handleDebugSessionStart(session)),
        vscode.debug.onDidTerminateDebugSession(session => provider.handleDebugSessionTerminate(session).catch(error => {
            console.error("Unable to restore EmberProbe sampling after debugging:", error);
        }))
    ];
    context.subscriptions.push(...subscriptions);
    if (vscode.window.onDidChangeWindowState) context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            if (state.focused) provider.updateView().catch(console.error);
        })
    );

    provider.refreshOpenOcdStatus(false);
    provider.scheduleGdbWarmup();
    provider._cubemxConfiguration.detect().catch(console.error);
    provider.refreshSkillStatus(true).catch(console.error);
    // 支持 MCP API 的宿主注册 server definition provider；旧版本安静跳过，外部客户端仍可用启动器。
    const mcpRegistered = provider.activateMcp();
    if (process.env.EMBERPROBE_E2E === "1") {
        return { debugTestProvider: provider, mcpRegistered, viewState: () => ({ sidebar: !!provider._sidebarReady, graph: [...provider._livePanels.values()].some(entry => entry.ready) }) };
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
