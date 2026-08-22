"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const modernView = require("./modernView");
const autoDetect = require("./autoDetect");
const skillInstaller = require("./skillInstaller");
const openocdRunner = require("./openocdRunner");
const openocdChecker = require("./openocdChecker");
const liveWatch = require("./liveWatch");
const liveWatchView = require("./liveWatchView");
const elfSymbols = require("./elfSymbols");
const dwarf = require("./dwarf");
const chipInfo = require("./chipInfo");
const faultInfo = require("./faultInfo");
const validation = require("./validation");
const openocdScripts = require("./openocdScripts");
const { AgentBridge } = require("./agentBridge");
const { WriteAuthorization } = require("./writeAuthorization");
const { ProbeCoordinator } = require("./probeCoordinator");
const { ConfigurationStore } = require("./services/configurationStore");
const { FlashService } = require("./services/flashService");
const { FaultService } = require("./services/faultService");
const { AgentService } = require("./services/agentService");
const { externalizeWebviewHtml } = require("./webviewAssets");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const i18n = require("./i18n");
// 调试器配置列表
const DEBUGGER_LIST = [
    'altera-usb-blaster.cfg', 'altera-usb-blaster2.cfg', 'arm-jtag-ew.cfg', 'ast2600-gpiod.cfg',
    'at91rm9200.cfg', 'beaglebone-jtag-native.cfg', 'beaglebone-swd-native.cfg', 'buspirate.cfg',
    'calao-usb-a9260.cfg', 'chameleon.cfg', 'cmsis-dap.cfg', 'dln-2-gpiod.cfg', 'dummy.cfg',
    'esp_usb_bridge.cfg', 'estick.cfg', 'flashlink.cfg', 'ft232r.cfg', 'imx-native.cfg', 'jlink.cfg',
    'jtag_dpi.cfg', 'jtag_hat_rpi2.cfg', 'jtag_vpi.cfg', 'kitprog.cfg', 'nds32-aice.cfg', 'nulink.cfg',
    'opendous.cfg', 'openjtag.cfg', 'osbdm.cfg', 'parport.cfg', 'parport_dlc5.cfg', 'raspberrypi-native.cfg',
    'raspberrypi2-native.cfg', 'rlink.cfg', 'rshim.cfg', 'stlink-dap.cfg', 'stlink-v1.cfg', 'stlink-v2-1.cfg',
    'stlink-v2.cfg', 'stlink.cfg', 'sysfsgpio-raspberrypi.cfg', 'ti-icdi.cfg', 'ulink.cfg', 'usb-jtag.cfg',
    'usbprog.cfg', 'vdebug.cfg', 'vsllink.cfg', 'xds110.cfg'
];
// MCU核心配置列表
const MCU_CORE_LIST = [
    '1986ве1т.cfg', 'adsp-sc58x.cfg', 'aduc702x.cfg', 'aducm360.cfg', 'allwinner_v3s.cfg',
    'alphascale_asm9260t.cfg', 'altera_fpgasoc.cfg', 'altera_fpgasoc_arria10.cfg', 'am335x.cfg',
    'am437x.cfg', 'amdm37x.cfg', 'ampere_emag.cfg', 'ampere_qs_mq.cfg', 'ar71xx.cfg', 'armada370.cfg',
    'arm_corelink_sse200.cfg', 'at32ap7000.cfg', 'at91r40008.cfg', 'at91rm9200.cfg', 'at91sam3ax_4x.cfg',
    'at91sam3ax_8x.cfg', 'at91sam3ax_xx.cfg', 'at91sam3nXX.cfg', 'at91sam3sXX.cfg', 'at91sam3u1c.cfg',
    'at91sam3u1e.cfg', 'at91sam3u2c.cfg', 'at91sam3u2e.cfg', 'at91sam3u4c.cfg', 'at91sam3u4e.cfg',
    'at91sam3uxx.cfg', 'at91sam3XXX.cfg', 'at91sam4c32x.cfg', 'at91sam4cXXX.cfg', 'at91sam4lXX.cfg',
    'at91sam4sd32x.cfg', 'at91sam4sXX.cfg', 'at91sam4XXX.cfg', 'at91sam7a2.cfg', 'at91sam7se512.cfg',
    'at91sam7sx.cfg', 'at91sam7x256.cfg', 'at91sam7x512.cfg', 'at91sam9.cfg', 'at91sam9260.cfg',
    'at91sam9260_ext_RAM_ext_flash.cfg', 'at91sam9261.cfg', 'at91sam9263.cfg', 'at91sam9g10.cfg',
    'at91sam9g20.cfg', 'at91sam9g45.cfg', 'at91sam9rl.cfg', 'at91sama5d2.cfg', 'at91samdXX.cfg',
    'at91samg5x.cfg', 'atheros_ar2313.cfg', 'atheros_ar2315.cfg', 'atheros_ar9331.cfg', 'atheros_ar9344.cfg',
    'atmega128.cfg', 'atmega128rfa1.cfg', 'atsame5x.cfg', 'atsaml1x.cfg', 'atsamv.cfg', 'avr32.cfg',
    'bcm2711.cfg', 'bcm281xx.cfg', 'bcm2835.cfg', 'bcm2836.cfg', 'bcm2837.cfg', 'bcm4706.cfg',
    'bcm4718.cfg', 'bcm47xx.cfg', 'bcm5352e.cfg', 'bcm6348.cfg', 'bluefield.cfg', 'bluenrg-x.cfg',
    'c100.cfg', 'cc2538.cfg', 'cs351x.cfg', 'davinci.cfg', 'dragonite.cfg', 'dsp56321.cfg',
    'dsp568013.cfg', 'dsp568037.cfg', 'efm32.cfg', 'em357.cfg', 'em358.cfg', 'eos_s3.cfg',
    'epc9301.cfg', 'esi32xx.cfg', 'esp32.cfg', 'esp32s2.cfg', 'esp32s3.cfg', 'esp_common.cfg',
    'exynos5250.cfg', 'feroceon.cfg', 'fm3.cfg', 'fm4.cfg', 'fm4_mb9bf.cfg',
    'fm4_s6e2cc.cfg', 'gd32e23x.cfg', 'gd32vf103.cfg', 'gp326xxxa.cfg', 'hi3798.cfg', 'hi6220.cfg',
    'hilscher_netx10.cfg', 'hilscher_netx50.cfg', 'hilscher_netx500.cfg', 'icepick.cfg', 'imx.cfg',
    'imx21.cfg', 'imx25.cfg', 'imx27.cfg', 'imx28.cfg', 'imx31.cfg', 'imx35.cfg', 'imx51.cfg',
    'imx53.cfg', 'imx6.cfg', 'imx6sx.cfg', 'imx6ul.cfg', 'imx7.cfg', 'imx7ulp.cfg', 'imx8m.cfg',
    'imx8qm.cfg', 'is5114.cfg', 'ixp42x.cfg', 'k1921vk01t.cfg', 'k40.cfg', 'k60.cfg', 'ke0x.cfg',
    'ke1xf.cfg', 'ke1xz.cfg', 'kl25.cfg', 'kl46.cfg', 'klx.cfg', 'ks869x.cfg', 'kx.cfg', 'lpc11xx.cfg',
    'lpc12xx.cfg', 'lpc13xx.cfg', 'lpc17xx.cfg', 'lpc1850.cfg', 'lpc1xxx.cfg', 'lpc2103.cfg',
    'lpc2124.cfg', 'lpc2129.cfg', 'lpc2148.cfg', 'lpc2294.cfg', 'lpc2378.cfg', 'lpc2460.cfg',
    'lpc2478.cfg', 'lpc2900.cfg', 'lpc2xxx.cfg', 'lpc3131.cfg', 'lpc3250.cfg', 'lpc40xx.cfg',
    'lpc4350.cfg', 'lpc4357.cfg', 'lpc4370.cfg', 'lpc84x.cfg', 'lpc8nxx.cfg', 'lpc8xx.cfg',
    'ls1012a.cfg', 'ls1028a.cfg', 'ls1046a.cfg', 'ls1088a.cfg', 'lsch3_common.cfg', 'max32620.cfg',
    'max32625.cfg', 'max3263x.cfg', 'mc13224v.cfg', 'mdr32f9q2i.cfg', 'nds32v2.cfg', 'nds32v3.cfg',
    'nds32v3m.cfg', 'nds32v5.cfg', 'ngultra.cfg', 'nhs31xx.cfg', 'npcx.cfg', 'nordic/nrf51.cfg', 'nordic/nrf52.cfg',
    'nuc910.cfg', 'numicro.cfg', 'omap2420.cfg', 'omap3530.cfg', 'omap4430.cfg', 'omap4460.cfg',
    'omap5912.cfg', 'omapl138.cfg', 'or1k.cfg', 'pic32mx.cfg', 'psoc4.cfg', 'psoc5lp.cfg', 'psoc6.cfg',
    'pxa255.cfg', 'pxa270.cfg', 'pxa3xx.cfg', 'qualcomm_qca4531.cfg', 'quark_d20xx.cfg', 'quark_x10xx.cfg',
    'renesas_r7s72100.cfg', 'renesas_rcar_gen2.cfg', 'renesas_rcar_gen3.cfg', 'renesas_rcar_reset_common.cfg',
    'renesas_rz_five.cfg', 'renesas_rz_g2.cfg', 'renesas_s7g2.cfg', 'rk3308.cfg', 'rk3399.cfg',
    'rp2040-core0.cfg', 'rp2040.cfg', 'rsl10.cfg', 'samsung_s3c2410.cfg', 'samsung_s3c2440.cfg',
    'samsung_s3c2450.cfg', 'samsung_s3c4510.cfg', 'samsung_s3c6410.cfg', 'sharp_lh79532.cfg',
    'sim3x.cfg', 'smp8634.cfg', 'snps_em_sk_fpga.cfg', 'snps_hsdk.cfg', 'spear3xx.cfg', 'stellaris.cfg',
    'stm32f0x.cfg', 'stm32f1x.cfg', 'stm32f2x.cfg', 'stm32f3x.cfg', 'stm32f4x.cfg', 'stm32f7x.cfg',
    'stm32g0x.cfg', 'stm32g4x.cfg', 'stm32h7x.cfg', 'stm32h7x_dual_bank.cfg', 'stm32l0.cfg',
    'stm32l0_dual_bank.cfg', 'stm32l1.cfg', 'stm32l1x_dual_bank.cfg', 'stm32l4x.cfg', 'stm32l5x.cfg',
    'stm32mp13x.cfg', 'stm32mp15x.cfg', 'stm32u5x.cfg', 'stm32w108xx.cfg', 'stm32wbx.cfg', 'stm32wlx.cfg',
    'stm32x5x_common.cfg', 'stm32xl.cfg', 'stm8l.cfg', 'stm8l152.cfg', 'stm8s.cfg', 'stm8s003.cfg',
    'stm8s103.cfg', 'stm8s105.cfg', 'str710.cfg', 'str730.cfg', 'str750.cfg', 'str912.cfg',
    'swm050.cfg', 'ti-ar7.cfg', 'ti-cjtag.cfg',
    'ti_calypso.cfg', 'ti_cc13x0.cfg', 'ti_cc13x2.cfg', 'ti_cc26x0.cfg', 'ti_cc26x2.cfg', 'ti_cc3220sf.cfg',
    'ti_cc32xx.cfg', 'ti_dm355.cfg', 'ti_dm365.cfg', 'ti_dm6446.cfg', 'ti_k3.cfg', 'ti_msp432.cfg',
    'ti_rm4x.cfg', 'ti_tms570.cfg', 'ti_tms570ls20xxx.cfg', 'ti_tms570ls3137.cfg', 'tmpa900.cfg',
    'tmpa910.cfg', 'tnetc4401.cfg', 'u8500.cfg', 'vd_aarch64.cfg', 'vd_cortex_m.cfg', 'vd_riscv.cfg',
    'vd_xtensa_jtag.cfg', 'vybrid_vf6xx.cfg', 'xilinx_zynqmp.cfg', 'xmc1xxx.cfg', 'xmc4xxx.cfg',
    'xmos_xs1-xau8a-10_arm.cfg', 'xtensa-core-esp32.cfg', 'xtensa-core-esp32s2.cfg', 'xtensa-core-esp32s3.cfg',
    'xtensa-core-nxp_rt600.cfg', 'xtensa.cfg', 'zynq_7000.cfg', 'к1879xб1я.cfg'
];
// 缓存键名
const CACHE_KEYS = {
    elfPath: 'mcu.elfPath',
    debugger: 'mcu.debugger',
    mcuCore: 'mcu.mcuCore',
    svdPath: 'mcu.svdPath',
    watchList: 'mcu.watchList',
    sidebarWatchList: 'mcu.sidebarWatchList',
    sidebarWriteList: 'mcu.sidebarWriteList'
};
// 核心修改1：添加路径清洗工具函数（处理Windows路径问题）
function cleanWindowsPath(rawPath) {
    return validation.cleanWindowsPath(rawPath);
}
// 实现WebviewViewProvider接口的类
class MainViewProvider {
    constructor(context) {
        // 存储命令执行函数（主进程）
        this.commandHandlers = {};
        this._context = context;
        this._webviewAssetRootUri = vscode.Uri.joinPath(context.globalStorageUri, "webview-assets");
        // 语言优先级：用户显式切换过的选择（globalState）> VS Code 显示语言自动匹配（zh-* → 中文，其余 → 英文）
        const savedLang = context.globalState.get('emberprobe.lang');
        this._lang = i18n.SUPPORTED_LANGS.includes(savedLang) ? savedLang : i18n.matchVscodeLang(vscode.env.language);
        this._probeCoordinator = new ProbeCoordinator();
        this._recentProgress = [];
        this._liveSession = null;
        this._livePanel = null;
        this._latestGraphSamples = new Map();
        this._latestSidebarSamples = new Map();
        this._liveConsumers = new Set();
        this._consumerTypesCache = null;
        this._symbolCache = null;
        this._chipInfo = null;
        this._openOcdStatus = { state: 'checking', key: 'oc.checking', canInstall: false };
        this._openOcdOperation = 0;
        this._agentReadSession = null;
        this._agentReadCancelled = false;
        this._agentReadDelayTimer = null;
        this._agentReadDelayResolve = null;
        this._agentSamplingStatus = null;
        this._uiWritePromise = Promise.resolve();
        this._writeAuthorization = new WriteAuthorization(context.workspaceState);
        this._configurationStore = new ConfigurationStore({
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            cleanPath: cleanWindowsPath,
            isSafeCfg: openocdRunner.isSafeCfg,
            onChanged: () => {
                this._symbolCache = null;
                this._invalidateConsumerTypes();
                this.updateView();
                this._syncGraphTarget(message => this._livePanel?.webview.postMessage(message));
            }
        });
        this._flashService = new FlashService(openocdRunner);
        this._faultService = new FaultService(faultInfo, elfSymbols);
        this._agentService = new AgentService({
            Bridge: AgentBridge,
            workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            handlers: {
                'config.get': () => this._configurationSnapshot(),
                'config.set': params => this._setAgentConfiguration(params.values || {}),
                'watch.add': params => this._addAgentWatch(params),
                'variables.read': params => this._readAgentVariables(params),
                'variables.sample': params => this._sampleAgentVariables(params),
                'variables.write': params => this._writeAgentVariables(params),
                'variables.write.permission': params => this._agentWritePermission(params),
                'chip.read': () => this.readChipInfoAction(true),
                'fault.read': () => this._readAgentFault(),
                'elf.analyze': params => this._analyzeElf(params || {})
            }
        });
        this.registerCommandHandlers();
    }
    get _downloadRunning() { return this._probeCoordinator.isActive('download'); }
    set _downloadRunning(active) { this._probeCoordinator.setActive('download', active); }
    get _liveWatchRunning() { return this._probeCoordinator.isActive('liveWatch'); }
    set _liveWatchRunning(active) { this._probeCoordinator.setActive('liveWatch', active); }
    get _liveStarting() { return this._probeCoordinator.isActive('liveStart'); }
    set _liveStarting(active) { this._probeCoordinator.setActive('liveStart', active); }
    get _chipInfoRunning() { return this._probeCoordinator.isActive('chipInfo'); }
    set _chipInfoRunning(active) { this._probeCoordinator.setActive('chipInfo', active); }
    get _agentReadRunning() { return this._probeCoordinator.isActive('agentRead'); }
    set _agentReadRunning(active) { this._probeCoordinator.setActive('agentRead', active); }
    get _debugStarting() { return this._probeCoordinator.isActive('debugStart'); }
    set _debugStarting(active) { this._probeCoordinator.setActive('debugStart', active); }
    // 当前界面语言（简体中文/English），由侧边栏或实时面板右上角按钮切换并持久化到全局状态
    _t(key, params) {
        return i18n.t(this._lang, key, params);
    }
    _setLang(lang) {
        this._lang = i18n.normalizeLang(lang);
        this._context.globalState.update('emberprobe.lang', this._lang);
        return this._lang;
    }
    _commandContext(resource) {
        if (resource?.fsPath) {
            const folder = vscode.workspace.getWorkspaceFolder(resource) || vscode.workspace.workspaceFolders?.[0];
            return { folder, cwd: resource.fsPath };
        }
        const elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        if (elfPath) {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(elfPath));
            if (folder) return { folder, cwd: folder.uri.fsPath };
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        return { folder, cwd: folder?.uri.fsPath };
    }
    _postOpenOcdStatus(status) {
        this._openOcdStatus = { ...this._openOcdStatus, ...status };
        this._webviewView?.webview.postMessage({ type: 'openocdStatus', ...this._openOcdStatus });
    }
    _openOcdReporter(operation) {
        return status => {
            if (operation === this._openOcdOperation) this._postOpenOcdStatus(status);
        };
    }
    async refreshOpenOcdStatus(showChecking = true) {
        const operation = ++this._openOcdOperation;
        const report = this._openOcdReporter(operation);
        const target = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
        if (showChecking) report({ state: 'checking', key: 'oc.checking' });
        const result = await openocdChecker.probeOpenOcd(target);
        if (operation !== this._openOcdOperation) return null;
        openocdChecker.setCache(result);
        return openocdChecker.resolveOpenOcdStatus(target, this._context, result, report);
    }
    async _handleOpenOcdAction(action) {
        if (action !== 'install' && action !== 'select') return this.refreshOpenOcdStatus(true);
        const operation = ++this._openOcdOperation;
        const report = this._openOcdReporter(operation);
        if (action === 'install') {
            const resolved = await openocdChecker.installBundledAndConfigure(vscode, this._context, report, this._lang);
            if (!resolved && this._openOcdStatus.state === 'installing') await this.refreshOpenOcdStatus(false);
            return resolved;
        }
        if (action === 'select') {
            const resolved = await openocdChecker.pickOpenOcdPath(vscode, report, this._lang);
            if (!resolved) await this.refreshOpenOcdStatus(false);
            return resolved;
        }
        return null;
    }
    // 烧录/调试/实时查看前解析可用的 OpenOCD 路径；缺失状态只发送到侧边栏。
    async _resolveOpenOcdPath(executable) {
        const operation = ++this._openOcdOperation;
        const report = this._openOcdReporter(operation);
        const target = executable && String(executable).trim();
        const cached = openocdChecker.getCachedResult();
        // 缓存命中且原始配置值一致直接放行，避免每次动作都重新探测
        if (cached && cached.found && (cached.requested || cached.path) === target) {
            report({ state: 'ready', key: cached.version ? 'oc.readyVer' : 'oc.ready', params: { version: cached.version }, result: cached });
            return cached.path;
        }
        // 探测一次并回写缓存，使同一路径后续命中快路径
        const result = await openocdChecker.probeOpenOcd(target);
        openocdChecker.setCache(result);
        if (operation !== this._openOcdOperation) return null;
        const resolved = await openocdChecker.resolveOpenOcdStatus(target, this._context, result, report);
        if (!resolved) vscode.commands.executeCommand('workbench.view.extension.mcu-vscode-container');
        return resolved;
    }
    // 注册命令处理函数（主进程执行）
    registerCommandHandlers() {
        this.commandHandlers['mcu-vscode.autoDetect'] = async () => this.runAutoDetect(true);
        this.commandHandlers['mcu-vscode.manageAgentSkills'] = async () => this.manageAgentSkills();
        this.commandHandlers['mcu-vscode.openLiveWatch'] = async () => this.openLiveWatchPanel();
        // 1. 选择 ELF 文件（核心修改2：使用fsPath+路径清洗）
        this.commandHandlers['mcu-vscode.selectElf'] = async () => {
            try {
                console.log('主进程执行选择 ELF 文件命令');
                const elfFiles = await vscode.workspace.findFiles('**/*.elf', '{**/node_modules/**,**/.git/**}', 100);
                if (elfFiles.length === 0) {
                    vscode.window.showWarningMessage(this._t('msg.noElfFound'));
                    return;
                }
                const quickPick = vscode.window.createQuickPick();
                quickPick.items = elfFiles.map(file => {
                    const cleanPath = cleanWindowsPath(file.fsPath); // 替换file.path为file.fsPath，再清洗
                    return {
                        label: path.basename(cleanPath),
                        description: cleanPath
                    };
                });
                quickPick.placeholder = this._t('msg.searchElf');
                quickPick.canSelectMany = false;
                quickPick.onDidChangeSelection(async selection => {
                    if (selection[0]) {
                        const elfPath = selection[0].description;
                        if (elfPath) {
                            const finalPath = cleanWindowsPath(elfPath); // 二次清洗，双重保障
                            await this._context.workspaceState.update(CACHE_KEYS.elfPath, finalPath);
                            vscode.window.showInformationMessage(this._t('msg.elfSelected', { name: path.basename(finalPath) }));
                            this.updateView();
                        }
                        quickPick.dispose();
                    }
                });
                quickPick.onDidHide(() => quickPick.dispose());
                quickPick.show();
            }
            catch (err) {
                const errorMsg = err.message;
                console.error('选择 ELF 文件失败：', errorMsg);
                vscode.window.showErrorMessage(this._t('msg.selectElfFailed', { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            }
        };
        // 2. 选择调试器（无修改）
        this.commandHandlers['mcu-vscode.selectDebugger'] = () => {
            console.log('主进程执行选择调试器命令');
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = DEBUGGER_LIST.map(cfg => ({ label: cfg }));
            quickPick.placeholder = this._t('msg.searchDebugger');
            quickPick.canSelectMany = false;
            quickPick.onDidChangeSelection(async selection => {
                if (selection[0]) {
                    const debuggerCfg = selection[0].label;
                    await this._context.workspaceState.update(CACHE_KEYS.debugger, debuggerCfg);
                    vscode.window.showInformationMessage(this._t('msg.debuggerSelected', { name: debuggerCfg }));
                    this.updateView();
                    quickPick.dispose();
                }
            });
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        };
        // 3. 选择 MCU 核心（无修改）
        this.commandHandlers['mcu-vscode.selectMcuCore'] = async () => {
            console.log('主进程执行选择 MCU 核心命令');
            const configured = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
            const executable = await this._resolveOpenOcdPath(configured);
            // 展示当前 OpenOCD 实际包含的 target，包括 geehy/* 等厂商子目录。
            // OpenOCD 尚未就绪时仍允许先完成手动配置，继续使用内置列表。
            const discovered = executable ? openocdScripts.discoverTargetConfigs(executable) : [];
            const targets = discovered.length ? discovered : MCU_CORE_LIST;
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = targets.map(cfg => ({ label: cfg }));
            quickPick.placeholder = this._t('msg.searchMcu');
            quickPick.canSelectMany = false;
            quickPick.onDidChangeSelection(async selection => {
                if (selection[0]) {
                    const mcuCore = selection[0].label;
                    await this._context.workspaceState.update(CACHE_KEYS.mcuCore, mcuCore);
                    vscode.window.showInformationMessage(this._t('msg.mcuSelected', { name: mcuCore }));
                    this.updateView();
                    quickPick.dispose();
                }
            });
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        };
        // 4. 启动调试（核心修改4：处理TypeScript类型匹配+路径清洗）
        this.commandHandlers['mcu-vscode.debug'] = async (resource) => {
            try {
                if (this._agentReadRunning) {
                    vscode.window.showWarningMessage(this._t('msg.agentReadBusy'));
                    return false;
                }
                if (this._debugStarting) {
                    vscode.window.showWarningMessage(this._t('msg.debugBusy'));
                    return false;
                }
                this._debugStarting = true;
                console.log('主进程执行启动调试命令');
                let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                let svdPath = this._context.workspaceState.get(CACHE_KEYS.svdPath);
                if (!elfPath || !debuggerCfg || !mcuCore) {
                    vscode.window.showErrorMessage(this._t('msg.configIncomplete'));
                    return false;
                }
                if (!vscode.extensions.getExtension('marus25.cortex-debug')) {
                    vscode.window.showErrorMessage(this._t('msg.needCortexDebug'));
                    return false;
                }
                // 修复类型错误：处理 undefined 情况，用空字符串兜底
                elfPath = cleanWindowsPath(elfPath);
                svdPath = cleanWindowsPath(svdPath || ''); // 关键修复：解决 svdPath 可能为 undefined 的问题
                const { folder: workspaceFolder, cwd } = this._commandContext(resource);
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(this._t('msg.openWorkspaceForDebug'));
                    return false;
                }
                // 与下载共用同一个 OpenOCD 路径配置，避免 OpenOCD 不在 PATH 时调试失败
                const configuredOpenOcdPath = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
                const openocdPath = await this._resolveOpenOcdPath(configuredOpenOcdPath);
                if (!openocdPath) return false;
                const debugConfig = {
                    type: 'cortex-debug',
                    name: this._t('msg.debugConfigName'),
                    request: 'launch',
                    cwd,
                    executable: elfPath,
                    servertype: 'openocd',
                    serverpath: openocdPath,
                    configFiles: [
                        `interface/${debuggerCfg}`,
                        `target/${mcuCore}`
                    ],
                    svdFile: svdPath || undefined
                };
                const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
                if (!started) {
                    vscode.window.showErrorMessage(this._t('msg.debugStartFailed'));
                    return false;
                }
                return true;
            }
            catch (err) {
                const errorMsg = err.message;
                console.error('调试启动失败：', errorMsg);
                vscode.window.showErrorMessage(this._t('msg.debugFailed', { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            }
            finally {
                this._debugStarting = false;
            }
        };
        // 6. 下载程序（核心修改5：生成命令时清洗路径）
        this.commandHandlers['mcu-vscode.download'] = async (resource) => {
            if (this._downloadRunning) {
                vscode.window.showWarningMessage(this._t('msg.downloadBusy'));
                return false;
            }
            if (this._agentReadRunning) {
                vscode.window.showWarningMessage(this._t('msg.agentReadBusy'));
                return false;
            }
            // 下载前自动停止实时采样以释放探针；短暂等待确保 OpenOCD 进程退出、USB 句柄释放
            if (this._liveWatchRunning) {
                this.stopLiveWatch();
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (this._chipInfoRunning) {
                vscode.window.showWarningMessage(this._t('msg.chipBusyForDownload'));
                return false;
            }
            this._downloadRunning = true;
            const configuredExecutable = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
            const executable = await this._resolveOpenOcdPath(configuredExecutable);
            if (!executable) { this._downloadRunning = false; return false; }
            this._recentProgress = [];
            try {
                console.log('主进程执行下载程序命令');
                let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) {
                    vscode.window.showErrorMessage(this._t('msg.configIncomplete'));
                    return false;
                }
                const cleanElfPath = cleanWindowsPath(elfPath);
                const { cwd } = this._commandContext(resource);
                await this._flashService.download(vscode, { executable, elf: cleanElfPath, probe: debuggerCfg, target: mcuCore, cwd }, event => {
                    // 缓冲最近几条进度，视图未打开或刷新时可回放，避免进度静默丢失
                    const message = { type: 'openocdProgress', ...event };
                    this._recentProgress.push(message);
                    if (this._recentProgress.length > 6) this._recentProgress.shift();
                    this._webviewView?.webview.postMessage(message);
                });
                vscode.window.showInformationMessage(this._t('msg.downloadSuccess'));
                return true;
            }
            catch (err) {
                const errorMsg = err.message;
                console.error('固件下载失败：', errorMsg);
                vscode.window.showErrorMessage(this._t('msg.downloadFailed', { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            }
            finally {
                this._downloadRunning = false;
            }
        };
    }
    _configurationSnapshot() {
        return this._configurationStore.snapshot();
    }
    _workspacePath(value, extension) {
        return this._configurationStore.workspacePath(value, extension);
    }
    async _setAgentConfiguration(values) {
        return this._configurationStore.update(values);
    }
    async _addAgentWatch(params) {
        const names = Array.isArray(params.variables) ? params.variables.map(String) : [];
        if (!names.length) throw Object.assign(new Error('No variables supplied'), { code: 'NO_VARIABLES' });
        const destination = params.destination || 'sidebar';
        if (!['sidebar', 'chart', 'both'].includes(destination)) throw Object.assign(new Error('destination must be sidebar, chart, or both'), { code: 'INVALID_DESTINATION' });
        this._symbolCache = null;
        const symbols = this.readElfSymbols().symbols;
        const byName = new Map(symbols.map(symbol => [symbol.name, symbol]));
        const resolved = [];
        const resolvedNames = new Set();
        const appendResolved = item => {
            if (!resolvedNames.has(item.name)) {
                resolvedNames.add(item.name);
                resolved.push(item);
            }
        };
        for (const rawName of names) {
            // 支持路径语法：sensor.x, buf[0], buf[1:5]
            const parsed = elfSymbols.parseMemberPath(rawName);
            const baseName = parsed ? parsed.base : rawName;
            const symbol = byName.get(baseName);
            if (!symbol) throw Object.assign(new Error(`Variable not found in current ELF: ${rawName}`), { code: 'VARIABLE_NOT_FOUND' });
            if (symbol.isComposite) {
                if (!symbol.compositeLayout) throw Object.assign(new Error(`Composite variable has no DWARF layout: ${rawName}`), { code: 'UNSUPPORTED_VARIABLE' });
                if (parsed && parsed.segments.length) {
                    const leaves = elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed);
                    if (!leaves.length) throw Object.assign(new Error(`Invalid composite member path: ${rawName}`), { code: 'INVALID_VARIABLE_PATH' });
                    for (const leaf of leaves) {
                        appendResolved({ name: leaf.path, address: leaf.address, size: leaf.size, type: leaf.type });
                    }
                } else {
                    appendResolved({ name: baseName, address: symbol.address, size: symbol.size, type: '', isComposite: true, compositeLayout: symbol.compositeLayout });
                }
            } else {
                if (!symbol.watchType) throw Object.assign(new Error(`Variable is not a supported scalar: ${rawName}`), { code: 'UNSUPPORTED_VARIABLE' });
                appendResolved({ name: baseName, address: symbol.address, size: symbol.size, type: params.types?.[baseName] || symbol.watchType });
            }
        }
        const results = {};
        const addTo = async (key, target) => {
            const current = this._scalarWatchList(key);
            const existing = new Set(current.map(item => item.name));
            const added = resolved.filter(item => !existing.has(item.name));
            await this._context.workspaceState.update(key, current.concat(added));
            results[target] = { added: added.map(item => item.name), alreadyPresent: resolved.filter(item => existing.has(item.name)).map(item => item.name) };
        };
        if (destination === 'sidebar' || destination === 'both') await addTo(CACHE_KEYS.sidebarWatchList, 'sidebar');
        if (destination === 'chart' || destination === 'both') await addTo(CACHE_KEYS.watchList, 'chart');
        this._invalidateConsumerTypes();
        this._syncSidebarTarget(message => this._webviewView?.webview.postMessage(message));
        this._syncGraphTarget(message => this._livePanel?.webview.postMessage(message));
        if (this._liveSession) this._liveSession.setWatch(this._activeReadPlan());
        return results;
    }
    _agentVariablePlan(params) {
        const raw = Array.isArray(params.variables) ? params.variables : [];
        const requests = raw.map(item => typeof item === 'string' ? { name: item } : {
            name: item?.name,
            type: item?.type
        });
        if (!requests.length) throw Object.assign(new Error('No variables supplied'), { code: 'NO_VARIABLES' });
        this._symbolCache = null;
        const elfResult = this.readElfSymbols();
        const byName = new Map(elfResult.symbols.map(s => [s.name, s]));
        const folded = new Map();
        for (const s of elfResult.symbols) {
            const key = String(s.name || '').toLowerCase();
            if (!folded.has(key)) folded.set(key, []);
            folded.get(key).push(s);
        }
        const scalarRequests = [];
        const compositePlan = [];
        for (const req of requests) {
            const parsed = elfSymbols.parseMemberPath(req.name);
            const baseName = parsed ? parsed.base : req.name;
            let symbol = byName.get(baseName);
            if (!symbol) {
                // 与标量解析一致的大小写不敏感回退：唯一匹配时接受，多匹配交由歧义错误
                const matches = folded.get(String(baseName).toLowerCase()) || [];
                if (matches.length === 1) symbol = matches[0];
                else if (matches.length > 1) throw Object.assign(new Error(`Variable name is ambiguous: ${req.name}`), { code: 'AMBIGUOUS_VARIABLE' });
            }
            if (!symbol) throw Object.assign(new Error(`Variable not found in current ELF: ${req.name}`), { code: 'VARIABLE_NOT_FOUND' });
            if (symbol.isComposite) {
                if (!symbol.compositeLayout) {
                    // 缺布局时不能把完整路径丢进标量解析器，否则会得到误导性的 VARIABLE_NOT_FOUND
                    throw Object.assign(new Error(`Composite variable has no DWARF layout: ${req.name}`), { code: 'COMPOSITE_LAYOUT_MISSING', details: { base: symbol.name, reason: symbol.unsupportedReason } });
                }
                if (parsed && parsed.segments.length
                    && !elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed).length) {
                    throw Object.assign(new Error(`Invalid composite member path: ${req.name}`), { code: 'INVALID_VARIABLE_PATH' });
                }
                const totalSize = Number(symbol.size) || 0;
                compositePlan.push({
                    requestedName: req.name,
                    name: symbol.name,
                    address: Number(symbol.address) >>> 0,
                    size: totalSize,
                    type: '',
                    isComposite: true,
                    compositeLayout: symbol.compositeLayout,
                    pathSpec: parsed
                });
            } else if (parsed && parsed.segments.length) {
                throw Object.assign(new Error(`${req.name} is not a composite variable; member paths are not applicable`), { code: 'INVALID_VARIABLE_PATH' });
            } else {
                scalarRequests.push(req);
            }
        }
        const plan = scalarRequests.length ? elfSymbols.resolveVariableRequests(elfResult.symbols, scalarRequests) : [];
        return { elfResult, plan, compositePlan };
    }
    _decodeAgentSample(plan, samples, compositePlan) {
        const byName = new Map(samples.map(sample => [sample.name, sample]));
        const timestamp = samples.reduce((latest, sample) => Math.max(latest, sample.t || 0), 0) || Date.now();
        const values = {};
        for (const item of plan) {
            const sample = byName.get(item.name);
            values[item.name] = {
                requestedName: item.requestedName,
                value: sample?.bytes ? elfSymbols.decodeValue(sample.bytes, item.type) : null,
                type: item.type,
                address: `0x${item.address.toString(16).toUpperCase()}`
            };
        }
        if (compositePlan) {
            for (const comp of compositePlan) {
                const sample = byName.get(comp.name);
                const fullTree = sample?.bytes ? elfSymbols.decodeComposite(sample.bytes, comp.compositeLayout) : null;
                const node = fullTree ? elfSymbols.navigateCompositeTree(fullTree, comp.pathSpec) : null;
                const baseAddr = comp.address >>> 0;
                const addrHex = off => `0x${((baseAddr + (off || 0)) >>> 0).toString(16).toUpperCase()}`;
                if (elfSymbols.isScalarLeafNode(node)) {
                    // 路径定位到单个标量成员/元素：以标量形式返回，便于趋势分析与阅读
                    values[comp.requestedName] = {
                        requestedName: comp.requestedName,
                        value: node.value,
                        type: node.type,
                        address: addrHex(node.offset)
                    };
                } else {
                    values[comp.requestedName] = {
                        requestedName: comp.requestedName,
                        tree: node,
                        type: 'composite',
                        address: addrHex(node && node.offset)
                    };
                }
            }
        }
        return { timestamp, values };
    }
    _postAgentSampling(running, key, params) {
        this._agentSamplingStatus = running ? { running, key, params, agentOwned: true } : null;
        this._postLive({ type: 'liveStatus', running, key, params, agentOwned: running });
    }
    _waitAgentInterval(intervalMs) {
        return new Promise(resolve => {
            const finish = () => {
                if (this._agentReadDelayTimer) clearTimeout(this._agentReadDelayTimer);
                this._agentReadDelayTimer = null;
                this._agentReadDelayResolve = null;
                resolve();
            };
            this._agentReadDelayResolve = finish;
            this._agentReadDelayTimer = setTimeout(finish, intervalMs);
        });
    }
    async _runAgentSamples(params, count, intervalMs, syncStatus) {
        const { elfResult, plan, compositePlan } = this._agentVariablePlan(params);
        // 合并标量与复合变量的实际读取项：复合变量按基址整体读一次（同名去重），
        // 解码时再按各路径导航；避免同一结构体多次重复读取。
        const readItems = [];
        const seenRead = new Set();
        for (const item of plan) { if (!seenRead.has(item.name)) { seenRead.add(item.name); readItems.push({ name: item.name, address: item.address, size: item.size }); } }
        for (const comp of compositePlan) { if (!seenRead.has(comp.name)) { seenRead.add(comp.name); readItems.push({ name: comp.name, address: comp.address, size: comp.size }); } }

        return this._withAgentProbe(async ({ session, source, temporary }) => {
            if (temporary && syncStatus) this._postAgentSampling(true, 'live.agentSampling', { current: 0, total: count });
            const result = [];
            for (let index = 0; index < count; index++) {
                if (temporary && !this._agentReadRunning) throw Object.assign(new Error('Agent sampling was cancelled by the user'), { code: 'AGENT_READ_CANCELLED' });
                result.push(this._decodeAgentSample(plan, await session.readOnce(readItems), compositePlan));
                if (temporary && syncStatus) this._postAgentSampling(true, 'live.agentSampling', { current: index + 1, total: count });
                if (index + 1 < count) await this._waitAgentInterval(intervalMs);
            }
            return { source, elf: elfResult.elf, samples: result };
        }, { syncStatus, total: count });
    }
    // 获取 Agent 探针会话：复用活动采样连接或创建临时会话，handler({session, source, temporary}) 完成实际读写，
    // finally 中临时会话必释放。互斥与状态同步语义与原 _runAgentSamples 一致。
    async _withAgentProbe(handler, options = {}) {
        const syncStatus = !!options.syncStatus;
        const total = options.total || 0;
        // 若 UI 正在启动采样，短暂等待其完成连接，随后直接复用同一个 Tcl 会话。
        const liveDeadline = Date.now() + 7000;
        while (this._liveStarting && Date.now() < liveDeadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }

        let session = this._liveWatchRunning ? this._liveSession : null;
        let temporary = false;
        let source = 'active-sampling';
        if (!session) {
            if (this._agentReadRunning) throw Object.assign(new Error('Another Agent variable read is in progress'), { code: 'AGENT_READ_BUSY' });
            if (this._downloadRunning || this._chipInfoRunning || this._debugStarting || vscode.debug.activeDebugSession) {
                throw Object.assign(new Error('The debug probe is busy with another operation'), { code: 'PROBE_BUSY' });
            }
            this._agentReadRunning = true;
            this._agentReadCancelled = false;
            try {
                const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!debuggerCfg || !mcuCore) {
                    throw Object.assign(new Error(this._t('live.needConfig')), { code: 'CONFIG_INCOMPLETE', i18nKey: 'live.needConfig' });
                }
                const cfg = vscode.workspace.getConfiguration('emberprobe');
                const executable = await this._resolveOpenOcdPath(cfg.get('openocdPath', 'openocd'));
                if (!executable) {
                    throw Object.assign(new Error(this._t('live.notReady')), { code: 'OPENOCD_NOT_READY', i18nKey: 'live.notReady' });
                }
                if (!this._agentReadRunning) throw Object.assign(new Error('Agent variable read was cancelled'), { code: 'AGENT_READ_CANCELLED' });
                const { cwd } = this._commandContext();
                session = new liveWatch.LiveWatchSession(vscode, {
                    executable,
                    probe: debuggerCfg,
                    target: mcuCore,
                    cwd,
                    port: validation.clampInteger(cfg.get('tclPort', 6666), 6666, 1, 65535),
                    intervalMs: 10000
                }, {});
                this._agentReadSession = session;
                temporary = true;
                source = 'temporary-probe';
            } catch (error) {
                this._agentReadRunning = false;
                throw error;
            }
        }

        let completed = false;
        try {
            if (temporary) {
                if (syncStatus) this._postAgentSampling(true, 'live.agentStarting', { total });
                await session.start();
            }
            const result = await handler({ session, source, temporary });
            completed = true;
            return result;
        } finally {
            if (temporary) {
                try { session.stop(); } catch { /* ignore */ }
                if (this._agentReadSession === session) this._agentReadSession = null;
                this._agentReadRunning = false;
                if (this._agentReadDelayResolve) this._agentReadDelayResolve();
                if (syncStatus) {
                    const key = this._agentReadCancelled ? 'live.agentStopped' : (completed ? 'live.agentDone' : 'live.agentFailed');
                    this._postAgentSampling(false, key, { total });
                }
                this._agentReadCancelled = false;
            }
        }
    }
    async _readAgentVariables(params) {
        const result = await this._runAgentSamples(params, 1, 0, false);
        return { source: result.source, elf: result.elf, ...result.samples[0] };
    }
    async _sampleAgentVariables(params) {
        const count = validation.clampInteger(params.count, 10, 2, 1000);
        const intervalMs = validation.clampInteger(params.intervalMs, 200, 20, 60000);
        return this._runAgentSamples(params, count, intervalMs, true);
    }
    // 解析写入请求：只允许标量符号与复合类型的单个标量叶子路径，且目标地址必须落在
    // ELF 的可写段（SHF_ALLOC|SHF_WRITE，即 .data/.bss）内，防止误写 Flash/外设寄存器。
    _agentWritePlan(values, options = {}) {
        const requests = (Array.isArray(values) ? values : []).map(item => ({ name: String(item?.name || '').trim(), value: item?.value }));
        if (!requests.length) throw Object.assign(new Error('No variables supplied'), { code: 'NO_VARIABLES' });
        if (options.refreshSymbols !== false) this._symbolCache = null;
        const elfResult = this.readElfSymbols();
        const byName = new Map(elfResult.symbols.map(s => [s.name, s]));
        const SHF_WRITE = 1, SHF_ALLOC = 2;
        let writable = [];
        try {
            const parsed = elfSymbols.parseElfSections(fs.readFileSync(elfResult.elf.path));
            writable = parsed.sections.filter(s => (s.flags & (SHF_WRITE | SHF_ALLOC)) === (SHF_WRITE | SHF_ALLOC) && s.size > 0);
        } catch (e) { writable = []; }
        const inWritable = (address, size) => writable.some(s => address >= s.addr && address + size <= s.addr + s.size);
        const items = [];
        const seen = new Set();
        for (const req of requests) {
            if (!req.name) throw Object.assign(new Error('Variable name is required'), { code: 'INVALID_VARIABLE_NAME' });
            const parsed = elfSymbols.parseMemberPath(req.name);
            const baseName = parsed ? parsed.base : req.name;
            const symbol = byName.get(baseName);
            let target;
            if (symbol && symbol.isComposite) {
                if (!symbol.compositeLayout) throw Object.assign(new Error(`Composite variable has no DWARF layout: ${req.name}`), { code: 'UNSUPPORTED_VARIABLE' });
                if (!parsed || !parsed.segments.length) throw Object.assign(new Error(`Writing a whole composite variable is not supported: ${req.name}`), { code: 'UNSUPPORTED_VARIABLE' });
                const leaves = elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed);
                if (leaves.length !== 1) throw Object.assign(new Error(`Write target must resolve to exactly one scalar member: ${req.name}`), { code: leaves.length ? 'UNSUPPORTED_VARIABLE' : 'INVALID_VARIABLE_PATH' });
                target = { name: leaves[0].path, address: leaves[0].address >>> 0, type: leaves[0].type, size: leaves[0].size };
            } else {
                const [plan] = elfSymbols.resolveVariableRequests(elfResult.symbols, [{ name: req.name }]);
                const resolvedSymbol = byName.get(plan.name);
                if (!resolvedSymbol?.hasDwarfWriteType) {
                    throw Object.assign(new Error(`Variable type is not available from DWARF; refusing to guess a write encoding: ${req.name}`), {
                        code: 'WRITE_TYPE_UNKNOWN',
                        details: { name: plan.name, guessedType: plan.type }
                    });
                }
                target = { name: plan.name, address: plan.address, type: plan.type, size: plan.size };
            }
            if (seen.has(target.name)) throw Object.assign(new Error(`Variable requested more than once: ${target.name}`), { code: 'DUPLICATE_VARIABLE' });
            seen.add(target.name);
            const bytes = elfSymbols.encodeValue(req.value, target.type);
            if (!inWritable(target.address, target.size)) {
                throw Object.assign(new Error(`Target address is outside writable RAM sections (.data/.bss): ${req.name}`), { code: 'WRITE_NOT_ALLOWED', details: { name: target.name, address: `0x${target.address.toString(16).toUpperCase()}` } });
            }
            items.push({ requestedName: req.name, name: target.name, address: target.address, type: target.type, size: target.size, bytes, value: elfSymbols.decodeValue(bytes, target.type) });
        }
        return { elfResult, items };
    }
    // 会话内写入执行核心：写前读取 → 写入 → 回读校验，Agent 与侧边栏 UI 写入共用。
    async _executeWritePlan(session, source, plan) {
        const { elfResult, items } = plan;
        const readItems = items.map(i => ({ name: i.name, address: i.address, size: i.size }));
        const before = new Map((await session.readOnce(readItems)).map(s => [s.name, s]));
        await session.writeOnce(items.map(i => ({ address: i.address, bytes: i.bytes })));
        const after = new Map((await session.readOnce(readItems)).map(s => [s.name, s]));
        const results = items.map(i => {
            const prev = before.get(i.name);
            const post = after.get(i.name);
            const verified = !!post?.bytes && post.bytes.length >= i.bytes.length && i.bytes.every((b, k) => post.bytes[k] === b);
            return {
                name: i.requestedName,
                resolvedName: i.name,
                address: `0x${i.address.toString(16).toUpperCase()}`,
                type: i.type,
                previous: prev?.bytes ? elfSymbols.decodeValue(prev.bytes, i.type) : null,
                written: i.value,
                readBack: post?.bytes ? elfSymbols.decodeValue(post.bytes, i.type) : null,
                verified
            };
        });
        if (results.some(r => !r.verified)) {
            throw Object.assign(new Error('Write verification failed: the value read back does not match (the firmware may be overwriting this variable)'), { code: 'WRITE_VERIFY_FAILED', retryable: true, details: { results } });
        }
        return { source, elf: elfResult.elf, results };
    }
    // 高危操作：首次先返回聊天确认请求；一次性确认 ID 与 ELF/地址/类型/值绑定。
    // 用户可选择仅本次授权，或在首次成功写入后记住当前工作区授权。
    async _writeAgentVariables(params) {
        const plan = this._agentWritePlan(params.values);
        const authorization = this._writeAuthorization.authorize(plan, {
            confirmationId: params.confirmationId,
            remember: params.remember
        });
        if (!authorization.authorized) return authorization.response;
        const result = await this._withAgentProbe(({ session, source }) => this._executeWritePlan(session, source, plan));
        let permission = { mode: authorization.mode, trusted: this._writeAuthorization.isTrusted() };
        if (authorization.remember) {
            try { permission = { mode: 'workspace', ...(await this._writeAuthorization.trustWorkspace()), remembered: true }; }
            catch (error) { permission = { mode: 'once', trusted: false, remembered: false, warning: error.message }; }
        }
        return { ...result, permission };
    }
    // 侧边栏写入列表：用户在 UI 中直接操作，不经过 WriteAuthorization 确认；
    // 保留 _agentWritePlan 的全部安全校验（DWARF 类型已知、目标地址在 .data/.bss 可写段内）。
    // 仅在实时采样运行时允许写入，直接复用采样的 Tcl 会话。
    async _writeUiVariable(name, value) {
        if (!this._liveWatchRunning || !this._liveSession) {
            throw Object.assign(new Error(this._t('sb.writeNeedSampling')), { i18nKey: 'sb.writeNeedSampling' });
        }
        const plan = this._agentWritePlan([{ name, value }], { refreshSymbols: false });
        return this._executeWritePlan(this._liveSession, 'active-sampling', plan);
    }
    async _agentWritePermission(params) {
        const action = String(params?.action || 'status');
        if (action === 'status') return this._writeAuthorization.status();
        if (action === 'reset') return this._writeAuthorization.reset();
        throw Object.assign(new Error(`Unsupported write permission action: ${action}`), { code: 'INVALID_PERMISSION_ACTION' });
    }
    // 读取并解码 Cortex-M 故障寄存器；与 chip.read 共用 _chipInfoRunning 互斥（一次性 OpenOCD 进程同一时刻只能有一个）
    async _readAgentFault() {
        const busy = (key, code) => { throw Object.assign(new Error(this._t(key)), { i18nKey: key, code }); };
        if (this._chipInfoRunning) busy('chip.reading', 'CHIP_READ_RUNNING');
        if (this._downloadRunning) busy('chip.busyDownload', 'PROBE_BUSY');
        if (this._liveWatchRunning) busy('chip.busyLive', 'PROBE_BUSY');
        if (this._agentReadRunning) busy('chip.busyAgent', 'PROBE_BUSY');
        if (this._debugStarting || vscode.debug.activeDebugSession) busy('chip.busyDebug', 'PROBE_BUSY');
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) busy('chip.needConfig', 'CONFIG_INCOMPLETE');
        this._chipInfoRunning = true;
        try {
            const executable = await this._resolveOpenOcdPath(vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd'));
            if (!executable) busy('chip.notReady', 'OPENOCD_NOT_READY');
            const { cwd } = this._commandContext();
            return await this._faultService.read(
                { executable, probe: debuggerCfg, target: mcuCore, cwd },
                () => this.readElfSymbols().functions || []
            );
        } finally {
            this._chipInfoRunning = false;
        }
    }
    // 纯静态分析当前 ELF 的 Flash/RAM 占用与最大符号，不占探针
    _analyzeElf(params) {
        const elfResult = this.readElfSymbols();
        let buffer;
        try { buffer = fs.readFileSync(elfResult.elf.path); }
        catch (e) { throw Object.assign(new Error(`Cannot read ELF: ${elfResult.elf.path}`), { code: 'ELF_READ_FAILED', details: { cause: e.message } }); }
        const { sections, programHeaders } = elfSymbols.parseElfSections(buffer);
        const SHF_WRITE = 1, SHF_ALLOC = 2, SHT_NOBITS = 8, PT_LOAD = 1;
        const hex = v => `0x${(v >>> 0).toString(16).toUpperCase()}`;
        // 用 PT_LOAD 段把 VMA 映射到 LMA（.data 在 Flash 中的装载副本）
        const lmaFor = (s) => {
            for (const ph of programHeaders) {
                if (ph.type !== PT_LOAD) continue;
                if (s.addr >= ph.vaddr && s.addr + s.size <= ph.vaddr + Math.max(ph.filesz, ph.memsz)) {
                    return (ph.paddr + (s.addr - ph.vaddr)) >>> 0;
                }
            }
            return s.addr;
        };
        const flashSections = [], ramSections = [];
        let flashTotal = 0, ramTotal = 0;
        for (const s of sections) {
            if (!(s.flags & SHF_ALLOC) || !s.size) continue;
            if (s.type !== SHT_NOBITS) {
                // 有文件内容的装载节占 Flash（按 LMA）：.isr_vector/.text/.rodata/.data 等
                flashSections.push({ name: s.name, address: hex(lmaFor(s)), size: s.size });
                flashTotal += s.size;
            }
            if (s.flags & SHF_WRITE) {
                // 运行期占 RAM 的可写节（按 VMA）：.data/.bss/.noinit 等
                ramSections.push({ name: s.name, address: hex(s.addr), size: s.size });
                ramTotal += s.size;
            }
        }
        const sectionOf = (address) => {
            const hit = sections.find(s => (s.flags & SHF_ALLOC) && s.size && address >= s.addr && address < s.addr + s.size);
            return hit ? hit.name : '';
        };
        const top = validation.clampInteger(params.top, 20, 1, 100);
        const topSymbols = [
            ...(elfResult.functions || []).map(f => ({ name: f.name, kind: 'function', size: f.size, address: f.address })),
            ...elfResult.symbols.map(s => ({ name: s.name, kind: 'object', size: s.size, address: s.address }))
        ].filter(s => s.size > 0)
            .sort((a, b) => b.size - a.size)
            .slice(0, top)
            .map(s => ({ name: s.name, kind: s.kind, section: sectionOf(s.address), size: s.size, address: hex(s.address) }));
        return {
            elf: elfResult.elf,
            flash: { total: flashTotal, sections: flashSections },
            ram: { total: ramTotal, sections: ramSections },
            topSymbols,
            warnings: elfResult.warnings || []
        };
    }
    async _handleAgentCall(method, params) {
        return this._agentService.call(method, params);
    }
    async startAgentBridge() {
        return this._agentService.start();
    }
    async stopAgentBridge() {
        return this._agentService.stop();
    }
    _postSkillStatus(status) {
        this._webviewView?.webview.postMessage({ type: 'skillStatus', ...status });
    }
    async refreshSkillStatus() {
        const status = await skillInstaller.inspectSkills(vscode, this._context);
        this._postSkillStatus(status);
        this._promptSkillUpgrade(status);
        return status;
    }
    // 已安装 Skills 与插件内置版本存在差异（可更新/被修改/不完整）时提示升级；
    // 每个会话最多提示一次，避免侧边栏刷新与工作区切换反复打扰
    _promptSkillUpgrade(status) {
        if (this._skillUpgradePrompted) return;
        if (!['outdated', 'modified', 'partial'].includes(status.state)) return;
        this._skillUpgradePrompted = true;
        const manage = this._t('msg.skillsManage');
        vscode.window.showInformationMessage(this._t('msg.skillsDiffers'), manage)
            .then(choice => {
                if (choice === manage) vscode.commands.executeCommand('mcu-vscode.manageAgentSkills');
            });
    }
    _scopeStateText(scope) {
        if (!scope) return this._t('skill.noWorkspace');
        const hasCount = Number.isFinite(scope.installed) && Number.isFinite(scope.total) && scope.total > 0;
        if (scope.state === 'installed' && hasCount) return this._t('skill.installed', { installed: scope.installed, total: scope.total });
        if (scope.state === 'partial' && hasCount) return this._t('skill.partial', { installed: scope.installed, total: scope.total });
        const key = { outdated: 'skill.outdated', modified: 'skill.modified', notInstalled: 'skill.notInstalled' }[scope.state];
        return this._t(key || 'skill.notInstalled');
    }
    _scopeHasContent(scope) {
        return !!scope && scope.state !== 'notInstalled';
    }
    // Agent Skills 管理入口:选择安装范围(当前项目/全局)或按范围卸载
    async manageAgentSkills() {
        const status = await skillInstaller.inspectSkills(vscode, this._context);
        const hasWorkspace = !!vscode.workspace.workspaceFolders?.[0];
        const items = [];
        if (hasWorkspace) {
            items.push({ id: 'install:workspace', label: `$(folder) ${this._t('skill.menuInstallWorkspace')}`, description: this._scopeStateText(status.scopes.workspace), detail: status.scopes.workspace.root });
        }
        items.push({ id: 'install:global', label: `$(home) ${this._t('skill.menuInstallGlobal')}`, description: this._scopeStateText(status.scopes.global), detail: status.scopes.global.root });
        if (this._scopeHasContent(status.scopes.workspace) || this._scopeHasContent(status.scopes.global)) {
            items.push({ id: 'uninstall', label: `$(trash) ${this._t('skill.menuUninstall')}` });
        }
        const pick = await vscode.window.showQuickPick(items, { placeHolder: this._t('skill.menuPlaceholder') });
        if (!pick) return false;
        let result;
        if (pick.id === 'uninstall') {
            const scope = await this._pickUninstallScope(status, hasWorkspace);
            if (!scope) return false;
            result = await skillInstaller.uninstallSkill(vscode, this._context, this._lang, scope);
        } else {
            result = await skillInstaller.installSkill(vscode, this._context, this._lang, pick.id.split(':')[1]);
        }
        this._postSkillStatus(result);
        return result;
    }
    async _pickUninstallScope(status, hasWorkspace) {
        const items = [];
        if (hasWorkspace && this._scopeHasContent(status.scopes.workspace)) {
            items.push({ id: 'workspace', label: `$(trash) ${this._t('skill.menuUninstallWorkspace')}`, detail: status.scopes.workspace.root });
        }
        if (this._scopeHasContent(status.scopes.global)) {
            items.push({ id: 'global', label: `$(trash) ${this._t('skill.menuUninstallGlobal')}`, detail: status.scopes.global.root });
        }
        if (!items.length) return null;
        const pick = await vscode.window.showQuickPick(items, { placeHolder: this._t('skill.uninstallPlaceholder') });
        if (!pick) return null;
        const root = pick.id === 'global' ? status.scopes.global.root : status.scopes.workspace.root;
        const confirmButton = this._t('skill.uninstallConfirm');
        const confirm = await vscode.window.showWarningMessage(this._t('skill.confirmUninstall', { path: root }), { modal: true }, confirmButton);
        if (confirm !== confirmButton) return null;
        return pick.id;
    }
    // 打开/聚焦实时变量查看面板（独立 WebviewPanel，编辑区宽度足够绘图）
    openLiveWatchPanel() {
        if (this._livePanel) { this._livePanel.reveal(); return; }
        const cfg = vscode.workspace.getConfiguration('emberprobe');
        const panel = vscode.window.createWebviewPanel('emberprobe.liveWatch', this._t('lw.title'), vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this._webviewAssetRootUri]
        });
        this._livePanel = panel;
        const post = (m) => panel.webview.postMessage(m);
        panel.webview.html = this._externalizeWebview(panel.webview, liveWatchView.getLiveWatchContent({
            maxSamples: cfg.get('maxSamples', 2000),
            intervalMs: cfg.get('sampleIntervalMs', 100)
        }, this._lang), 'live-watch');
        panel.onDidDispose(() => {
            this._livePanel = null;
            // 图表面板关闭时，若侧边栏不可见，停止采样以释放探针；侧边栏仍可见则保持运行由其接管
            if (this._liveWatchRunning && !(this._webviewView && this._webviewView.visible)) {
                this.stopLiveWatch();
            }
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.type) {
                    case 'ready':
                        this._syncGraphTarget(post);
                        break;
                    case 'importVariables': {
                        const result = this.readElfSymbols();
                        post({ type: 'variablesList', symbols: result.symbols, warnings: result.warnings });
                        break;
                    }
                    case 'resolveVariable': {
                        const { symbols } = this.readElfSymbols();
                        const found = symbols.find(s => s.name === message.name);
                        if (found) post({ type: 'addResolved', symbol: found });
                        else post({ type: 'liveError', key: 'live.varNotFound', params: { name: message.name } });
                        break;
                    }
                    case 'saveWatch':
                        await this._context.workspaceState.update(CACHE_KEYS.watchList, message.items || []);
                        this._invalidateConsumerTypes();
                        this._pruneSampleMap(this._latestGraphSamples, CACHE_KEYS.watchList);
                        if (this._liveSession) {
                            const active = this._activeReadPlan();
                            if (active.length) this._liveSession.setWatch(active);
                            else this.stopLiveWatch();
                        }
                        break;
                    case 'start':
                        await this._context.workspaceState.update(CACHE_KEYS.watchList, message.items || []);
                        await this.startLiveWatch(message.items || [], message.intervalMs, 'graph');
                        break;
                    case 'stop':
                        if (this._agentReadRunning) this.stopAgentReadIfRunning();
                        else this.stopLiveWatch();
                        break;
                    case 'setInterval':
                        if (this._liveSession) this._liveSession.setIntervalMs(message.intervalMs);
                        break;
                    case 'exportCsv': {
                        if (!message.csv) break;
                        const stamp = new Date(), pad = (n) => String(n).padStart(2, '0');
                        const name = `emberprobe-live-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.csv`;
                        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
                        const target = await vscode.window.showSaveDialog({
                            defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), name),
                            filters: { 'CSV': ['csv'] }
                        });
                        if (!target) break;
                        try {
                            await fs.promises.writeFile(target.fsPath, message.csv, 'utf8');
                            vscode.window.showInformationMessage(this._t('msg.csvExported', { file: path.basename(target.fsPath) }));
                        } catch (error) {
                            vscode.window.showErrorMessage(this._t('msg.csvExportFailed', { msg: error.message }));
                        }
                        break;
                    }
                    case 'setLang': {
                        this._setLang(message.lang);
                        this._webviewView?.webview.postMessage({ type: 'setLang', lang: this._lang });
                        break;
                    }
                }
            } catch (error) {
                post({ type: 'liveError', key: error.i18nKey, params: error.i18nParams, message: error.message });
            }
        });
    }
    // 读取当前 ELF 的全局变量符号，并尽力附带 DWARF 类型信息
    readElfSymbols() {
        let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        if (!elfPath) throw Object.assign(new Error(this._t('live.elfFirst')), { code: 'ELF_NOT_CONFIGURED', i18nKey: 'live.elfFirst' });
        elfPath = cleanWindowsPath(elfPath);
        let buffer;
        let mtimeMs = 0;
        let fileSize = 0;
        try {
            const before = fs.statSync(elfPath);
            mtimeMs = before.mtimeMs;
            fileSize = before.size;
            buffer = fs.readFileSync(elfPath);
            const after = fs.statSync(elfPath);
            if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
                throw new Error('ELF changed while it was being read; retry after the build finishes');
            }
        }
        catch (e) { throw Object.assign(new Error(this._t('live.elfReadFail', { path: elfPath })), { code: 'ELF_READ_FAILED', i18nKey: 'live.elfReadFail', i18nParams: { path: elfPath }, details: { elfPath, cause: e.message } }); }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        if (this._symbolCache?.elfPath === elfPath && this._symbolCache.sha256 === sha256) return this._symbolCache.result;
        const result = elfSymbols.parseElfSymbols(buffer);
        result.elf = { path: elfPath, mtimeMs, size: fileSize, sha256 };
        let typeMap = null;
        let compositeLayouts = null;
        try { typeMap = dwarf.parseDwarfVariableTypes(buffer); } catch (e) { typeMap = null; }
        try { compositeLayouts = dwarf.parseCompositeLayout(buffer); } catch (e) { compositeLayouts = null; }
        for (const sym of result.symbols) {
            const info = typeMap && typeMap.get(sym.name);
            sym.typeName = info && info.typeName ? info.typeName : '';
            const layout = compositeLayouts && compositeLayouts.get(sym.name);
            // 有 DWARF 布局的复合类型标记为可展开；无布局但类型名匹配的大变量仍标记但不可展开
            const hasLayout = !!layout;
            sym.isComposite = hasLayout || /^(struct|union)\b/.test(sym.typeName) || /\[\]$/.test(sym.typeName) || (!info?.watchType && sym.size > 4);
            sym.watchType = sym.isComposite ? '' : (info && info.watchType ? info.watchType : elfSymbols.defaultType(sym.size));
            // 读取可以按大小猜测类型；高危写入只能使用 DWARF 明确给出的标量编码。
            sym.hasDwarfWriteType = !sym.isComposite && !!info?.watchType;
            if (sym.isComposite) {
                sym.compositeLayout = layout || null;
                sym.unsupportedReason = hasLayout ? '' : (this._t('lw.compositeNoLayout'));
            }
        }
        if (!typeMap || typeMap.size === 0) {
            result.warnings.push(this._t('warn.noDwarf'));
        }
        this._symbolCache = { elfPath, mtimeMs, fileSize, sha256, result };
        return result;
    }
    // 图表和侧边栏各自维护选择；同一探针连接采样两边当前启用列表的并集。
    _postLive(message) {
        this._livePanel?.webview.postMessage(message);
        this._webviewView?.webview.postMessage(message);
    }
    _postConsumerStatuses(payload, error = false) {
        const p = typeof payload === 'string' ? { message: payload } : (payload || {});
        const message = { type: 'liveStatus', running: this._liveWatchRunning, ...p, error };
        this._livePanel?.webview.postMessage(message);
        this._webviewView?.webview.postMessage(message);
    }
    _scalarWatchList(key) {
        const items = this._context.workspaceState.get(key) || [];
        try {
            const normalized = validation.normalizeWatchList(items, this.readElfSymbols().symbols);
            if (JSON.stringify(normalized) !== JSON.stringify(items)) this._context.workspaceState.update(key, normalized);
            return normalized;
        } catch (e) { return []; }
    }
    _syncGraphTarget(post) {
        post({ type: 'watchList', items: this._scalarWatchList(CACHE_KEYS.watchList) });
        post({ type: 'liveStatus', ...(this._agentSamplingStatus || {
            running: this._liveWatchRunning,
            key: this._liveWatchRunning ? 'sb.sampling' : 'sb.stopped'
        }) });
        if (this._latestGraphSamples.size) {
            const now = Date.now();
            post({ type: 'liveSample', samples: Array.from(this._latestGraphSamples.values()).map(s => ({ ...s, t: now })) });
        }
    }
    _syncSidebarTarget(post) {
        post({ type: 'sidebarWatchList', items: this._scalarWatchList(CACHE_KEYS.sidebarWatchList) });
        post({ type: 'sidebarWriteList', items: this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || [] });
        try {
            const result = this.readElfSymbols();
            post({ type: 'availableVariables', symbols: result.symbols, warnings: result.warnings });
        } catch (error) {
            post({ type: 'availableVariables', symbols: [], errorKey: error.i18nKey, params: error.i18nParams, error: error.message });
        }
        post({ type: 'liveStatus', ...(this._agentSamplingStatus || {
            running: this._liveWatchRunning,
            key: this._liveWatchRunning ? 'sb.sampling' : 'sb.stopped'
        }) });
        if (this._latestSidebarSamples.size) {
            const now = Date.now();
            const scalarSamples = [];
            const compositeSamples = [];
            for (const s of this._latestSidebarSamples.values()) {
                if (s.tree) compositeSamples.push({ ...s, t: now });
                else scalarSamples.push({ ...s, t: now });
            }
            if (scalarSamples.length) post({ type: 'liveSample', samples: scalarSamples });
            if (compositeSamples.length) post({ type: 'liveCompositeSample', samples: compositeSamples });
        }
    }
    // 图表与侧栏各自维护观察列表；同一变量在两侧可能选择不同观察类型。
    // 读取计划按变量名去重，宽度取两侧的最大值，一次读取覆盖所有消费者。
    // 复合变量（结构体/数组）展开为叶子成员读取项，按变量整体地址范围合并读取。
    _activeReadPlan() {
        const byName = new Map();
        const add = (item) => {
            if (!item?.name) return;
            if (item.isComposite && item.compositeLayout) {
                // 复合变量：展开为叶子成员，整体读取
                const sym = { name: item.name, address: item.address, size: item.size };
                const leaves = elfSymbols.expandCompositeLeaves(sym, item.compositeLayout, null);
                if (leaves.length) {
                    // 用变量基址+总大小作为整体读取范围
                    const totalSize = item.size || leaves.reduce((max, l) => Math.max(max, (l.address - ((item.address >>> 0))) + l.size), 0);
                    byName.set(item.name, { name: item.name, address: item.address, size: totalSize, isComposite: true });
                }
            } else {
                const len = elfSymbols.typeByteLength(item.type);
                const prev = byName.get(item.name);
                if (!prev) byName.set(item.name, { name: item.name, address: item.address, size: len });
                else if (len > prev.size) prev.size = len;
            }
        };
        this._scalarWatchList(CACHE_KEYS.watchList).forEach(add);
        this._scalarWatchList(CACHE_KEYS.sidebarWatchList).forEach(add);
        // 写入列表变量也纳入采样读取，使写入卡片能实时同步当前值；不回写存储，避免丢失 min/max 等 UI 字段
        try {
            const writeItems = this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || [];
            validation.normalizeWatchList(writeItems, this.readElfSymbols().symbols).forEach(add);
        } catch (e) { /* ELF 不可用时忽略写入列表 */ }
        return Array.from(byName.values());
    }
    // 各消费者对每个变量的观察类型，用于把同一份原始字节按各自类型解码后分别推送。
    _consumerTypes() {
        const build = (key) => {
            const m = new Map();
            for (const item of this._scalarWatchList(key)) if (item?.name) m.set(item.name, item.type);
            return m;
        };
        const sidebar = build(CACHE_KEYS.sidebarWatchList);
        // 写入列表变量按自身观察类型解码后推送到侧栏；同名变量以查看列表类型优先
        for (const item of this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || []) {
            if (item?.name && item.type && !sidebar.has(item.name)) sidebar.set(item.name, item.type);
        }
        return { graph: build(CACHE_KEYS.watchList), sidebar };
    }
    _getCachedConsumerTypes() {
        if (!this._consumerTypesCache) this._consumerTypesCache = this._consumerTypes();
        return this._consumerTypesCache;
    }
    _invalidateConsumerTypes() { this._consumerTypesCache = null; }
    _pruneSampleMap(map, keys) {
        const names = new Set();
        for (const key of (Array.isArray(keys) ? keys : [keys])) {
            for (const i of (this._context.workspaceState.get(key) || [])) if (i && i.name) names.add(i.name);
        }
        for (const n of map.keys()) if (!names.has(n)) map.delete(n);
    }
    async startLiveWatch(items, intervalMs, consumer = 'graph') {
        if (this._downloadRunning) throw Object.assign(new Error(this._t('live.downloadRunning')), { i18nKey: 'live.downloadRunning' });
        if (this._chipInfoRunning) throw Object.assign(new Error(this._t('live.chipReading')), { i18nKey: 'live.chipReading' });
        if (this._agentReadRunning) throw Object.assign(new Error(this._t('live.agentReading')), { i18nKey: 'live.agentReading' });
        if (this._liveStarting) throw Object.assign(new Error(this._t('live.starting')), { i18nKey: 'live.starting' });
        if (this._debugStarting || vscode.debug.activeDebugSession) throw Object.assign(new Error(this._t('live.debugActive')), { i18nKey: 'live.debugActive' });
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) throw Object.assign(new Error(this._t('live.needConfig')), { i18nKey: 'live.needConfig' });
        const activeItems = this._activeReadPlan();
        if (!activeItems.length) throw Object.assign(new Error(this._t('live.needVar')), { i18nKey: 'live.needVar' });
        this._liveConsumers.add('graph');
        this._liveConsumers.add('sidebar');
        if (this._liveWatchRunning && this._liveSession) {
            this._liveSession.setWatch(this._activeReadPlan());
            this._postConsumerStatuses({ key: 'sb.sampling' });
            return;
        }
        const cfg = vscode.workspace.getConfiguration('emberprobe');
        const configuredExecutable = cfg.get('openocdPath', 'openocd');
        this._liveStarting = true;
        let executable;
        try { executable = await this._resolveOpenOcdPath(configuredExecutable); } catch (e) { this._liveStarting = false; throw e; }
        if (!executable) { this._liveStarting = false; throw Object.assign(new Error(this._t('live.notReady')), { i18nKey: 'live.notReady' }); }
        const { cwd } = this._commandContext();
        const session = new liveWatch.LiveWatchSession(vscode, {
            executable, probe: debuggerCfg, target: mcuCore, cwd,
            port: validation.clampInteger(cfg.get('tclPort', 6666), 6666, 1, 65535),
            intervalMs: validation.clampInteger(intervalMs || cfg.get('sampleIntervalMs', 100), 100, 20, 10000)
        }, {
            onSample: (samples, t) => {
                // 同一变量的原始字节按各面板自选的观察类型分别解码，避免图表/侧栏选不同 type 时数值与标签不一致
                const types = this._getCachedConsumerTypes();
                const graphSamples = [];
                const sidebarSamples = [];
                const compositeSamples = [];
                // 构建复合变量查找：name → { layout, address }
                const compositeMap = new Map();
                for (const key of [CACHE_KEYS.watchList, CACHE_KEYS.sidebarWatchList]) {
                    for (const item of this._scalarWatchList(key)) {
                        if (item.isComposite && item.compositeLayout && !compositeMap.has(item.name)) {
                            compositeMap.set(item.name, { layout: item.compositeLayout, address: item.address });
                        }
                    }
                }
                for (const s of samples) {
                    const compInfo = compositeMap.get(s.name);
                    if (compInfo && s.bytes) {
                        // 复合变量：按布局解码为树形值
                        const tree = elfSymbols.decodeComposite(s.bytes, compInfo.layout);
                        if (tree) {
                            compositeSamples.push({ name: s.name, tree, t });
                            this._latestSidebarSamples.set(s.name, { name: s.name, tree, t });
                        }
                        continue;
                    }
                    const gType = types.graph.get(s.name);
                    const sType = types.sidebar.get(s.name);
                    if (gType) {
                        const v = s.bytes ? elfSymbols.decodeValue(s.bytes, gType) : null;
                        graphSamples.push({ name: s.name, value: v, t });
                        this._latestGraphSamples.set(s.name, { name: s.name, value: v, t });
                    }
                    if (sType) {
                        const v = s.bytes ? elfSymbols.decodeValue(s.bytes, sType) : null;
                        sidebarSamples.push({ name: s.name, value: v, t });
                        this._latestSidebarSamples.set(s.name, { name: s.name, value: v, t });
                    }
                }
                if (graphSamples.length) this._livePanel?.webview.postMessage({ type: 'liveSample', samples: graphSamples, t });
                if (sidebarSamples.length) this._webviewView?.webview.postMessage({ type: 'liveSample', samples: sidebarSamples, t });
                if (compositeSamples.length) {
                    this._livePanel?.webview.postMessage({ type: 'liveCompositeSample', samples: compositeSamples, t });
                    this._webviewView?.webview.postMessage({ type: 'liveCompositeSample', samples: compositeSamples, t });
                }
            },
            onStatus: (msg) => this._postConsumerStatuses(msg),
            onError: (msg) => this._postLive({ type: 'liveError', message: msg }),
            onDisconnect: (err) => {
                if (this._liveSession !== session) return;
                this._liveSession = null;
                this._liveWatchRunning = false;
                this._liveConsumers.clear();
                this._postConsumerStatuses({ key: err && err.i18nKey, params: err && err.i18nParams, message: (err && err.message) || String(err) }, true);
            }
        });
        session.setWatch(this._activeReadPlan());
        this._liveSession = session;
        this._liveWatchRunning = true;
        try {
            await session.start();
            this._liveStarting = false;
            this._postConsumerStatuses({ key: 'sb.sampling' });
        } catch (error) {
            this._liveStarting = false;
            if (this._liveSession === session) {
                try { session.stop(); } catch (e) { /* ignore */ }
                this._liveSession = null;
                this._liveWatchRunning = false;
            }
            this._liveConsumers.clear();
            this._postConsumerStatuses({ key: error.i18nKey, params: error.i18nParams, message: error.message }, true);
            throw error;
        }
    }
    stopLiveWatch() {
        this._liveConsumers.clear();
        if (this._liveSession) { try { this._liveSession.stop(); } catch (e) { /* ignore */ } this._liveSession = null; }
        this._liveWatchRunning = false;
        this._postConsumerStatuses({ key: 'sb.stopped' });
    }
    // 仅在采样进行中时停止；用于调试会话起止等外部事件触发的自动清理
    stopLiveWatchIfRunning() {
        if (this._liveWatchRunning) this.stopLiveWatch();
    }
    stopAgentReadIfRunning() {
        if (!this._agentReadRunning && !this._agentReadSession) return;
        this._agentReadCancelled = true;
        this._agentReadRunning = false;
        if (this._agentReadDelayResolve) this._agentReadDelayResolve();
        if (this._agentReadSession) {
            try { this._agentReadSession.stop(); } catch { /* ignore */ }
            this._agentReadSession = null;
        }
        this._postAgentSampling(false, 'live.agentStopped');
    }
    // 推送芯片信息状态与（可选的）结果到侧边栏
    _postChipInfo(status, info) {
        const post = (m) => this._webviewView?.webview.postMessage(m);
        if (info) post({ type: 'chipInfo', info });
        if (status) post({ type: 'chipInfoStatus', ...status });
    }
    // 同步侧边栏：视图重建后回放已缓存的芯片信息与当前状态
    _syncChipInfo(post) {
        if (this._chipInfo) post({ type: 'chipInfo', info: this._chipInfo });
        const state = this._chipInfoRunning ? 'reading' : (this._chipInfo ? 'ready' : 'idle');
        const key = this._chipInfoRunning ? 'chip.reading' : (this._chipInfo ? 'chip.done' : 'chip.notRead');
        post({ type: 'chipInfoStatus', state, key });
    }
    // 通过 OpenOCD 一次性读取芯片基本信息；与下载/实时查看/调试互斥（探针同一时刻只能被一个进程占用）
    async readChipInfoAction(forAgent = false) {
        const rejectBusy = (key, code) => {
            const error = Object.assign(new Error(this._t(key)), { i18nKey: key, code });
            this._postChipInfo({ state: 'error', key });
            if (forAgent) throw error;
            return null;
        };
        if (this._chipInfoRunning) return rejectBusy('chip.reading', 'CHIP_READ_RUNNING');
        if (this._downloadRunning) return rejectBusy('chip.busyDownload', 'PROBE_BUSY');
        if (this._liveWatchRunning) return rejectBusy('chip.busyLive', 'PROBE_BUSY');
        if (this._agentReadRunning) return rejectBusy('chip.busyAgent', 'PROBE_BUSY');
        if (this._debugStarting || vscode.debug.activeDebugSession) return rejectBusy('chip.busyDebug', 'PROBE_BUSY');
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) return rejectBusy('chip.needConfig', 'CONFIG_INCOMPLETE');
        this._chipInfoRunning = true;
        const configuredExecutable = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
        let executable;
        try { executable = await this._resolveOpenOcdPath(configuredExecutable); }
        catch (error) {
            this._chipInfoRunning = false;
            if (forAgent) throw error;
            this._postChipInfo({ state: 'error', key: error.i18nKey, params: error.i18nParams, message: error.message || String(error) });
            return null;
        }
        if (!executable) {
            this._chipInfoRunning = false;
            const error = Object.assign(new Error(this._t('chip.notReady')), { i18nKey: 'chip.notReady', code: 'OPENOCD_NOT_READY' });
            this._postChipInfo({ state: 'error', key: 'chip.notReady' });
            if (forAgent) throw error;
            return null;
        }
        this._postChipInfo({ state: 'reading', key: 'chip.reading' });
        let diag = null;
        try {
            const { cwd } = this._commandContext();
            const info = await chipInfo.readChipInfo(vscode, { executable, probe: debuggerCfg, target: mcuCore, cwd }, (ev) => {
                if (ev && ev.stage === 'raw') diag = ev;
            });
            this._chipInfo = info;
            this._postChipInfo({ state: 'ready', key: 'chip.done' }, info);
            this._writeChipDiagnostics(diag, info);
            return info;
        } catch (error) {
            this._postChipInfo({ state: 'error', key: error.i18nKey, params: error.i18nParams, message: error.message || String(error) });
            this._writeChipDiagnostics(diag, null);
            if (forAgent) throw error;
            return null;
        } finally {
            this._chipInfoRunning = false;
        }
    }
    // 将芯片信息读取的原始 OpenOCD 命令与输出写入输出面板，便于诊断（如 ID/UID/Flash 读取异常）
    _writeChipDiagnostics(diag, info) {
        if (!diag) return;
        if (!this._chipOutput) {
            this._chipOutput = vscode.window.createOutputChannel(this._t('diag.channelName'));
            this._context.subscriptions.push(this._chipOutput);
        }
        const ch = this._chipOutput;
        ch.clear();
        ch.appendLine(this._t('diag.title'));
        ch.appendLine(this._t('diag.time', { time: new Date().toLocaleString() }));
        if (info) {
            const kv = [[this._t('diag.kvCore'), info.core], [this._t('diag.kvCoreRev'), info.coreRevision], ['Device ID', info.deviceId], ['Revision ID', info.revId], [this._t('diag.kvFlash'), info.flashSize], ['UID', info.uid], [this._t('diag.kvState'), info.targetState]];
            ch.appendLine(this._t('diag.parsed', { content: kv.filter(x => x[1]).map(x => x[0] + '=' + x[1]).join('，') || this._t('diag.none') }));
        }
        ch.appendLine('');
        ch.appendLine(this._t('diag.commands'));
        (diag.commands || []).forEach(c => ch.appendLine('  -c ' + c));
        ch.appendLine('');
        ch.appendLine(this._t('diag.rawOutput'));
        (diag.lines || []).forEach(l => ch.appendLine('  ' + l));
        // Device ID 或 UID 缺失时自动展示，便于复制反馈
        if (!info || !info.deviceId || !info.uid) ch.show(true);
    }
    // 实现接口要求的resolveWebviewView方法（无修改）
    resolveWebviewView(webviewView) {
        this._webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri, this._webviewAssetRootUri]
        };
        // 监听Webview消息，主进程执行命令（先释放上一次视图的监听器，避免累积）
        this._messageListener?.dispose();
        this._messageListener = webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'executeCommand': {
                    const cmd = message.cmd;
                    try {
                        console.log('主进程接收命令：', cmd);
                        if (this.commandHandlers[cmd]) {
                            const result = await this.commandHandlers[cmd]();
                            if (result === false) break;
                            // 向Webview发送成功消息
                            webviewView.webview.postMessage({
                                type: 'commandSuccess',
                                cmd: cmd
                            });
                        }
                        else {
                            throw Object.assign(new Error(this._t('msg.commandNotRegistered', { cmd })), { i18nKey: 'msg.commandNotRegistered', i18nParams: { cmd } });
                        }
                    }
                    catch (error) {
                        const errorMsg = error.message || this._t('msg.unknownError');
                        console.error('命令执行失败：', errorMsg);
                        // 向Webview发送失败消息
                        webviewView.webview.postMessage({
                            type: 'commandError',
                            cmd: cmd,
                            key: error.i18nKey,
                            params: error.i18nParams,
                            error: errorMsg
                        });
                    }
                    break;
                }
                case 'initCheck': {
                    // Webview初始化检查，直接返回成功（无需依赖commands接口）
                    webviewView.webview.postMessage({ type: 'initSuccess' });
                    // 回放最近的下载进度，避免视图重建后日志丢失
                    for (const progressMessage of this._recentProgress) webviewView.webview.postMessage(progressMessage);
                    this._syncSidebarTarget((message) => webviewView.webview.postMessage(message));
                    this._syncChipInfo((message) => webviewView.webview.postMessage(message));
                    webviewView.webview.postMessage({ type: 'openocdStatus', ...this._openOcdStatus });
                    this.refreshOpenOcdStatus(false);
                    this.refreshSkillStatus().catch(error => console.error('Agent Skills 状态检查失败：', error.message));
                    break;
                }
                case 'openocdAction': {
                    try {
                        await this._handleOpenOcdAction(message.action);
                    } catch (error) {
                        this._postOpenOcdStatus({ state: 'error', key: error.i18nKey, params: error.i18nParams, message: error.message || String(error) });
                    }
                    break;
                }
                case 'refreshVariables': {
                    // 重建 ELF 后手动刷新：清空符号缓存并重新解析、回送变量列表
                    this._symbolCache = null;
                    try {
                        const result = this.readElfSymbols();
                        webviewView.webview.postMessage({ type: 'availableVariables', symbols: result.symbols, warnings: result.warnings });
                    } catch (error) {
                        webviewView.webview.postMessage({ type: 'availableVariables', symbols: [], errorKey: error.i18nKey, params: error.i18nParams, error: error.message });
                    }
                    break;
                }
                case 'saveSidebarWatch': {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._context.workspaceState.update(CACHE_KEYS.sidebarWatchList, items);
                    this._invalidateConsumerTypes();
                    this._pruneSampleMap(this._latestSidebarSamples, [CACHE_KEYS.sidebarWatchList, CACHE_KEYS.sidebarWriteList]);
                    if (this._liveSession) {
                        const active = this._activeReadPlan();
                        if (active.length) this._liveSession.setWatch(active);
                        else this.stopLiveWatch();
                    }
                    webviewView.webview.postMessage({ type: 'sidebarWatchList', items });
                    break;
                }
                case 'saveSidebarWrite': {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._context.workspaceState.update(CACHE_KEYS.sidebarWriteList, items);
                    this._invalidateConsumerTypes();
                    this._pruneSampleMap(this._latestSidebarSamples, [CACHE_KEYS.sidebarWatchList, CACHE_KEYS.sidebarWriteList]);
                    // 写入列表变化同步采样读取计划，使新增变量立即开始实时同步
                    if (this._liveSession) {
                        const active = this._activeReadPlan();
                        if (active.length) this._liveSession.setWatch(active);
                        else this.stopLiveWatch();
                    }
                    webviewView.webview.postMessage({ type: 'sidebarWriteList', items });
                    break;
                }
                case 'writeVariable': {
                    const name = String(message.name || '').trim();
                    const seq = message.seq;
                    // 串行化：同一时刻只有一次写入在途，后续请求排队；失败只回发 writeResult，不弹全局错误
                    this._uiWritePromise = this._uiWritePromise.catch(() => {}).then(async () => {
                        try {
                            const result = await this._writeUiVariable(name, message.value);
                            const r = result.results && result.results[0];
                            webviewView.webview.postMessage({ type: 'writeResult', ok: true, name, value: r ? r.readBack : message.value, seq });
                        } catch (error) {
                            webviewView.webview.postMessage({ type: 'writeResult', ok: false, name, seq, key: error.i18nKey, params: error.i18nParams, message: error.message || String(error) });
                        }
                    });
                    await this._uiWritePromise;
                    break;
                }
                case 'liveToggle': {
                    try {
                        if (this._agentReadRunning) this.stopAgentReadIfRunning();
                        else if (this._liveWatchRunning) this.stopLiveWatch();
                        else {
                            const items = this._context.workspaceState.get(CACHE_KEYS.sidebarWatchList) || [];
                            await this.startLiveWatch(items, message.intervalMs, 'sidebar');
                        }
                    } catch (error) {
                        webviewView.webview.postMessage({ type: 'liveStatus', running: false, key: error.i18nKey, params: error.i18nParams, message: error.message, error: true });
                    }
                    break;
                }
                case 'readChipInfo': {
                    await this.readChipInfoAction();
                    break;
                }
                case 'copyText': {
                    const value = message.text ? String(message.text) : '';
                    if (value) {
                        try { await vscode.env.clipboard.writeText(value); vscode.window.showInformationMessage(this._t('common.copied')); }
                        catch (e) { /* ignore clipboard errors */ }
                    }
                    break;
                }
                case 'setLang': {
                    this._setLang(message.lang);
                    this._livePanel?.webview.postMessage({ type: 'setLang', lang: this._lang });
                    break;
                }
            }
        });
        // 设置初始内容
        webviewView.webview.html = this._externalizeWebview(webviewView.webview, this.getModernWebviewContent(), 'sidebar');
        // 仅在配置不完整时执行自动检测，避免每次展开视图都全量扫描工作区
        const configured = this._context.workspaceState.get(CACHE_KEYS.elfPath)
            && this._context.workspaceState.get(CACHE_KEYS.debugger)
            && this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!configured)
            setTimeout(() => this.runAutoDetect(false).catch(error => {
                console.error('自动检测失败：', error.message);
                this._webviewView?.webview.postMessage({
                    type: 'commandError', cmd: 'mcu-vscode.autoDetect',
                    key: error.i18nKey, params: error.i18nParams, error: error.message
                });
            }), 0);
    }
    // 更新Webview内容（无修改）
    async runAutoDetect(force) {
        const result = await autoDetect.detectWorkspace(vscode);
        const currentElf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        const currentDebugger = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const currentMcu = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (result.elf && (force || !currentElf)) await this._context.workspaceState.update(CACHE_KEYS.elfPath, cleanWindowsPath(result.elf));
        if (result.debugger && (force || !currentDebugger)) await this._context.workspaceState.update(CACHE_KEYS.debugger, result.debugger);
        if (result.mcu && (force || !currentMcu)) await this._context.workspaceState.update(CACHE_KEYS.mcuCore, result.mcu);
        this.updateView();
        const found = [result.elf && this._t('msg.foundElf', { name: path.basename(result.elf) }), result.mcu && this._t('msg.foundMcu', { name: result.mcu }), result.debugger && this._t('msg.foundDebugger', { name: result.debugger })].filter(Boolean);
        if (force) {
            const message = found.length ? this._t('msg.autoDoneWith', { found: found.join(', ') }) : this._t('msg.autoNone');
            found.length ? vscode.window.showInformationMessage(message) : vscode.window.showWarningMessage(message);
        }
        return result;
    }
    getModernWebviewContent() {
        const elf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        return modernView.getModernWebviewContent({
            elf: elf ? path.basename(elf) : '',
            debugger: this._context.workspaceState.get(CACHE_KEYS.debugger) || '',
            mcu: this._context.workspaceState.get(CACHE_KEYS.mcuCore) || ''
        }, this._lang);
    }
    _externalizeWebview(webview, html, scope) {
        return externalizeWebviewHtml({
            html,
            webview,
            vscode,
            assetRootUri: this._webviewAssetRootUri,
            scope
        }).html;
    }
    updateView() {
        if (this._webviewView) {
            this._webviewView.webview.html = this._externalizeWebview(
                this._webviewView.webview,
                this.getModernWebviewContent(),
                'sidebar'
            );
        }
    }
}
function activate(context) {
    console.log('MCU_VSCODE 下载与调试器已激活！');
    // 实例化Webview视图提供器（无论是否已打开工作区都注册，由各命令自行检查工作区状态）
    const mainViewProvider = new MainViewProvider(context);
    mainViewProvider.startAgentBridge().catch(error => console.error('Agent Bridge 启动失败：', error.message));
    // 注册WebviewViewProvider
    const viewDisposable = vscode.window.registerWebviewViewProvider('mcu-vscode.mainView', mainViewProvider);
    // 订阅命令（兼容右键菜单）
    const folderDebugCmd = vscode.commands.registerCommand('mcu-vscode.folderDebug', (resource) =>
        mainViewProvider['commandHandlers']['mcu-vscode.debug'](resource));
    const folderDownloadCmd = vscode.commands.registerCommand('mcu-vscode.folderDownload', (resource) =>
        mainViewProvider['commandHandlers']['mcu-vscode.download'](resource));
    const openLiveWatchCmd = vscode.commands.registerCommand('mcu-vscode.openLiveWatch', () =>
        mainViewProvider['commandHandlers']['mcu-vscode.openLiveWatch']());
    const manageSkillsCmd = vscode.commands.registerCommand('mcu-vscode.manageAgentSkills', () =>
        mainViewProvider['commandHandlers']['mcu-vscode.manageAgentSkills']());
    // 手动检查 OpenOCD 环境：打开 EmberProbe 侧边栏并在状态卡内展示结果。
    const checkOpenOcdCmd = vscode.commands.registerCommand('mcu-vscode.checkOpenOcd', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.mcu-vscode-container');
        await mainViewProvider.refreshOpenOcdStatus(true);
    });
    // 订阅命令
    context.subscriptions.push(viewDisposable, folderDebugCmd, folderDownloadCmd, openLiveWatchCmd, manageSkillsCmd, checkOpenOcdCmd);
    // 激活后静默预探测一次填充缓存，避免首次动作才探测造成延迟（不弹通知）
    mainViewProvider.refreshOpenOcdStatus(false);
    // 激活后检查已安装 Agent Skills 与内置版本的差异，存在差异时提示可升级
    // （不打开侧边栏的用户也能得到提示；每会话最多一次）
    mainViewProvider.refreshSkillStatus().catch(() => {});
    // 用户改动 emberprobe.openocdPath 后清空缓存并重新探测，使新路径立即生效
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('emberprobe.openocdPath')) {
            openocdChecker.resetCache();
            mainViewProvider.refreshOpenOcdStatus(true);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await mainViewProvider.stopAgentBridge().catch(() => {});
        await mainViewProvider.startAgentBridge().catch(error => console.error('Agent Bridge 重启失败：', error.message));
        mainViewProvider.refreshSkillStatus().catch(() => {});
    }));
    // 停用时兜底停止实时采样会话（关闭 OpenOCD 服务与 socket）
    context.subscriptions.push({ dispose: () => {
        mainViewProvider.stopLiveWatch();
        mainViewProvider.stopAgentReadIfRunning();
        mainViewProvider.stopAgentBridge().catch(() => {});
    } });
    // 调试会话起止时自动停止实时采样：启动前释放探针避免冲突；断开后清理可能被扰动的会话
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
        if (session && session.type === 'cortex-debug') {
            mainViewProvider.stopLiveWatchIfRunning();
            mainViewProvider.stopAgentReadIfRunning();
        }
    }));
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
        if (session && session.type === 'cortex-debug') mainViewProvider.stopLiveWatchIfRunning();
    }));
}
function deactivate() {
    console.log('MCU_VSCODE 下载与调试器已停用！');
}
//# sourceMappingURL=extension.js.map
