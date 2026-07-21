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
const fs = require("fs");
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
    'nds32v3m.cfg', 'nds32v5.cfg', 'ngultra.cfg', 'nhs31xx.cfg', 'npcx.cfg', 'nrf51.cfg', 'nrf52.cfg',
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
    sidebarWatchList: 'mcu.sidebarWatchList'
};
// 核心修改1：添加路径清洗工具函数（处理Windows路径问题）
function cleanWindowsPath(rawPath) {
    if (!rawPath)
        return '';
    // 移除开头的 '/'（如 "/c:/" → "c:/"）
    if (rawPath.startsWith('/') && rawPath[1] === ':') {
        rawPath = rawPath.slice(1);
    }
    // 统一将 '\' 转换为 '/'（OpenOCD 兼容正斜杠）
    return rawPath.replace(/\\/g, '/');
}
// 实现WebviewViewProvider接口的类
class MainViewProvider {
    constructor(context) {
        // 存储命令执行函数（主进程）
        this.commandHandlers = {};
        this._context = context;
        // 语言优先级：用户显式切换过的选择（globalState）> VS Code 显示语言自动匹配（zh-* → 中文，其余 → 英文）
        const savedLang = context.globalState.get('emberprobe.lang');
        this._lang = i18n.SUPPORTED_LANGS.includes(savedLang) ? savedLang : i18n.matchVscodeLang(vscode.env.language);
        this._downloadRunning = false;
        this._recentProgress = [];
        this._liveWatchRunning = false;
        this._liveSession = null;
        this._livePanel = null;
        this._latestGraphSamples = new Map();
        this._latestSidebarSamples = new Map();
        this._liveConsumers = new Set();
        this._symbolCache = null;
        this._chipInfo = null;
        this._chipInfoRunning = false;
        this._liveStarting = false;
        this._openOcdStatus = { state: 'checking', key: 'oc.checking', canInstall: false };
        this._openOcdOperation = 0;
        this.registerCommandHandlers();
    }
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
        this.commandHandlers['mcu-vscode.installAgentSkill'] = async () => skillInstaller.installSkill(vscode, this._context, this._lang);
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
        this.commandHandlers['mcu-vscode.selectMcuCore'] = () => {
            console.log('主进程执行选择 MCU 核心命令');
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = MCU_CORE_LIST.map(cfg => ({ label: cfg }));
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
        // 4. 选择 SVD 文件（核心修改3：使用fsPath+路径清洗）
        this.commandHandlers['mcu-vscode.selectSvd'] = async () => {
            try {
                console.log('主进程执行选择 SVD 文件命令');
                const svdFiles = await vscode.workspace.findFiles('**/*.svd', '{**/node_modules/**,**/.git/**}', 100);
                if (svdFiles.length === 0) {
                    vscode.window.showWarningMessage(this._t('msg.noSvdFound'));
                    return;
                }
                const quickPick = vscode.window.createQuickPick();
                quickPick.items = svdFiles.map(file => {
                    const cleanPath = cleanWindowsPath(file.fsPath); // 替换file.path为file.fsPath，再清洗
                    return {
                        label: path.basename(cleanPath),
                        description: cleanPath
                    };
                });
                quickPick.placeholder = this._t('msg.searchSvd');
                quickPick.canSelectMany = false;
                quickPick.onDidChangeSelection(async selection => {
                    if (selection[0]) {
                        const svdPath = selection[0].description;
                        if (svdPath) {
                            const finalPath = cleanWindowsPath(svdPath); // 二次清洗
                            await this._context.workspaceState.update(CACHE_KEYS.svdPath, finalPath);
                            vscode.window.showInformationMessage(this._t('msg.svdSelected', { name: path.basename(finalPath) }));
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
                console.error('选择 SVD 文件失败：', errorMsg);
                vscode.window.showErrorMessage(this._t('msg.selectSvdFailed', { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            }
        };
        // 5. 启动调试（核心修改4：处理TypeScript类型匹配+路径清洗）
        this.commandHandlers['mcu-vscode.debug'] = async (resource) => {
            try {
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
        };
        // 6. 下载程序（核心修改5：生成命令时清洗路径）
        this.commandHandlers['mcu-vscode.download'] = async (resource) => {
            if (this._downloadRunning) {
                vscode.window.showWarningMessage(this._t('msg.downloadBusy'));
                return false;
            }
            if (this._liveWatchRunning) {
                vscode.window.showWarningMessage(this._t('msg.liveBusyForDownload'));
                return false;
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
                await openocdRunner.runOpenOcd(vscode, { executable, elf: cleanElfPath, probe: debuggerCfg, target: mcuCore, cwd }, event => {
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
    // 打开/聚焦实时变量查看面板（独立 WebviewPanel，编辑区宽度足够绘图）
    openLiveWatchPanel() {
        if (this._livePanel) { this._livePanel.reveal(); return; }
        const cfg = vscode.workspace.getConfiguration('emberprobe');
        const panel = vscode.window.createWebviewPanel('emberprobe.liveWatch', this._t('lw.title'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        this._livePanel = panel;
        const post = (m) => panel.webview.postMessage(m);
        panel.webview.html = liveWatchView.getLiveWatchContent({ maxSamples: cfg.get('maxSamples', 2000), intervalMs: cfg.get('sampleIntervalMs', 100) }, this._lang);
        panel.onDidDispose(() => { this._livePanel = null; });
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
                        this.stopLiveWatch();
                        break;
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
        if (!elfPath) throw Object.assign(new Error(this._t('live.elfFirst')), { i18nKey: 'live.elfFirst' });
        elfPath = cleanWindowsPath(elfPath);
        let buffer;
        let mtimeMs = 0;
        try {
            mtimeMs = fs.statSync(elfPath).mtimeMs;
            if (this._symbolCache?.elfPath === elfPath && this._symbolCache.mtimeMs === mtimeMs) return this._symbolCache.result;
            buffer = fs.readFileSync(elfPath);
        }
        catch (e) { throw Object.assign(new Error(this._t('live.elfReadFail', { path: elfPath })), { i18nKey: 'live.elfReadFail', i18nParams: { path: elfPath } }); }
        const result = elfSymbols.parseElfSymbols(buffer);
        let typeMap = null;
        try { typeMap = dwarf.parseDwarfVariableTypes(buffer); } catch (e) { typeMap = null; }
        for (const sym of result.symbols) {
            const info = typeMap && typeMap.get(sym.name);
            sym.typeName = info && info.typeName ? info.typeName : '';
            sym.isComposite = /^(struct|union)\b/.test(sym.typeName) || /\[\]$/.test(sym.typeName) || (!info?.watchType && sym.size > 4);
            sym.watchType = sym.isComposite ? '' : (info && info.watchType ? info.watchType : elfSymbols.defaultType(sym.size));
            if (sym.isComposite) sym.unsupportedReason = '';
        }
        if (!typeMap || typeMap.size === 0) {
            result.warnings.push(this._t('warn.noDwarf'));
        }
        this._symbolCache = { elfPath, mtimeMs, result };
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
            const byName = new Map(this.readElfSymbols().symbols.map(symbol => [symbol.name, symbol]));
            const filtered = items.filter(item => !byName.get(item.name)?.isComposite);
            if (filtered.length !== items.length) this._context.workspaceState.update(key, filtered);
            return filtered;
        } catch (e) { return items; }
    }
    _syncGraphTarget(post) {
        post({ type: 'watchList', items: this._scalarWatchList(CACHE_KEYS.watchList) });
        post({ type: 'liveStatus', running: this._liveWatchRunning, key: this._liveWatchRunning ? 'sb.sampling' : 'sb.stopped' });
        if (this._latestGraphSamples.size) post({ type: 'liveSample', samples: Array.from(this._latestGraphSamples.values()) });
    }
    _syncSidebarTarget(post) {
        post({ type: 'sidebarWatchList', items: this._scalarWatchList(CACHE_KEYS.sidebarWatchList) });
        try {
            const result = this.readElfSymbols();
            post({ type: 'availableVariables', symbols: result.symbols, warnings: result.warnings });
        } catch (error) {
            post({ type: 'availableVariables', symbols: [], errorKey: error.i18nKey, params: error.i18nParams, error: error.message });
        }
        post({ type: 'liveStatus', running: this._liveWatchRunning, key: this._liveWatchRunning ? 'sb.sampling' : 'sb.stopped' });
        if (this._latestSidebarSamples.size) post({ type: 'liveSample', samples: Array.from(this._latestSidebarSamples.values()) });
    }
    // 图表与侧栏各自维护观察列表；同一变量在两侧可能选择不同观察类型。
    // 读取计划按变量名去重，宽度取两侧的最大值，一次读取覆盖所有消费者。
    _activeReadPlan() {
        const byName = new Map();
        const add = (item) => {
            if (!item?.name) return;
            const len = elfSymbols.typeByteLength(item.type);
            const prev = byName.get(item.name);
            if (!prev) byName.set(item.name, { name: item.name, address: item.address, size: len });
            else if (len > prev.size) prev.size = len;
        };
        this._scalarWatchList(CACHE_KEYS.watchList).forEach(add);
        this._scalarWatchList(CACHE_KEYS.sidebarWatchList).forEach(add);
        return Array.from(byName.values());
    }
    // 各消费者对每个变量的观察类型，用于把同一份原始字节按各自类型解码后分别推送。
    _consumerTypes() {
        const build = (key) => {
            const m = new Map();
            for (const item of this._scalarWatchList(key)) if (item?.name) m.set(item.name, item.type);
            return m;
        };
        return { graph: build(CACHE_KEYS.watchList), sidebar: build(CACHE_KEYS.sidebarWatchList) };
    }
    async startLiveWatch(items, intervalMs, consumer = 'graph') {
        if (this._downloadRunning) throw Object.assign(new Error(this._t('live.downloadRunning')), { i18nKey: 'live.downloadRunning' });
        if (this._chipInfoRunning) throw Object.assign(new Error(this._t('live.chipReading')), { i18nKey: 'live.chipReading' });
        if (this._liveStarting) throw Object.assign(new Error(this._t('live.starting')), { i18nKey: 'live.starting' });
        if (vscode.debug.activeDebugSession) throw Object.assign(new Error(this._t('live.debugActive')), { i18nKey: 'live.debugActive' });
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
            port: cfg.get('tclPort', 6666), intervalMs: intervalMs || cfg.get('sampleIntervalMs', 100)
        }, {
            onSample: (samples, t) => {
                // 同一变量的原始字节按各面板自选的观察类型分别解码，避免图表/侧栏选不同 type 时数值与标签不一致
                const types = this._consumerTypes();
                const graphSamples = [];
                const sidebarSamples = [];
                for (const s of samples) {
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
    async readChipInfoAction() {
        if (this._chipInfoRunning) return;
        if (this._downloadRunning) { this._postChipInfo({ state: 'error', key: 'chip.busyDownload' }); return; }
        if (this._liveWatchRunning) { this._postChipInfo({ state: 'error', key: 'chip.busyLive' }); return; }
        if (vscode.debug.activeDebugSession) { this._postChipInfo({ state: 'error', key: 'chip.busyDebug' }); return; }
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) { this._postChipInfo({ state: 'error', key: 'chip.needConfig' }); return; }
        this._chipInfoRunning = true;
        const configuredExecutable = vscode.workspace.getConfiguration('emberprobe').get('openocdPath', 'openocd');
        const executable = await this._resolveOpenOcdPath(configuredExecutable);
        if (!executable) { this._chipInfoRunning = false; this._postChipInfo({ state: 'error', key: 'chip.notReady' }); return; }
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
        } catch (error) {
            this._postChipInfo({ state: 'error', key: error.i18nKey, params: error.i18nParams, message: error.message || String(error) });
            this._writeChipDiagnostics(diag, null);
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
            localResourceRoots: [vscode.Uri.file(this._context.extensionPath)]
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
                case 'saveSidebarWatch': {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._context.workspaceState.update(CACHE_KEYS.sidebarWatchList, items);
                    if (this._liveSession) {
                        const active = this._activeReadPlan();
                        if (active.length) this._liveSession.setWatch(active);
                        else this.stopLiveWatch();
                    }
                    webviewView.webview.postMessage({ type: 'sidebarWatchList', items });
                    break;
                }
                case 'liveToggle': {
                    try {
                        if (this._liveWatchRunning) this.stopLiveWatch();
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
        webviewView.webview.html = this.getModernWebviewContent();
        // 仅在配置不完整时执行自动检测，避免每次展开视图都全量扫描工作区
        const configured = this._context.workspaceState.get(CACHE_KEYS.elfPath)
            && this._context.workspaceState.get(CACHE_KEYS.debugger)
            && this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!configured)
            setTimeout(() => this.runAutoDetect(false), 0);
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
        const svd = this._context.workspaceState.get(CACHE_KEYS.svdPath);
        return modernView.getModernWebviewContent({
            elf: elf ? path.basename(elf) : '',
            debugger: this._context.workspaceState.get(CACHE_KEYS.debugger) || '',
            mcu: this._context.workspaceState.get(CACHE_KEYS.mcuCore) || '',
            svd: svd ? path.basename(svd) : ''
        }, this._lang);
    }
    updateView() {
        if (this._webviewView) {
            this._webviewView.webview.html = this.getModernWebviewContent();
        }
    }
}
function activate(context) {
    console.log('MCU_VSCODE 下载与调试器已激活！');
    // 实例化Webview视图提供器（无论是否已打开工作区都注册，由各命令自行检查工作区状态）
    const mainViewProvider = new MainViewProvider(context);
    // 注册WebviewViewProvider
    const viewDisposable = vscode.window.registerWebviewViewProvider('mcu-vscode.mainView', mainViewProvider);
    // 订阅命令（兼容右键菜单）
    const folderDebugCmd = vscode.commands.registerCommand('mcu-vscode.folderDebug', (resource) =>
        mainViewProvider['commandHandlers']['mcu-vscode.debug'](resource));
    const folderDownloadCmd = vscode.commands.registerCommand('mcu-vscode.folderDownload', (resource) =>
        mainViewProvider['commandHandlers']['mcu-vscode.download'](resource));
    const openLiveWatchCmd = vscode.commands.registerCommand('mcu-vscode.openLiveWatch', () =>
        mainViewProvider['commandHandlers']['mcu-vscode.openLiveWatch']());
    // 手动检查 OpenOCD 环境：打开 EmberProbe 侧边栏并在状态卡内展示结果。
    const checkOpenOcdCmd = vscode.commands.registerCommand('mcu-vscode.checkOpenOcd', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.mcu-vscode-container');
        await mainViewProvider.refreshOpenOcdStatus(true);
    });
    // 订阅命令
    context.subscriptions.push(viewDisposable, folderDebugCmd, folderDownloadCmd, openLiveWatchCmd, checkOpenOcdCmd);
    // 激活后静默预探测一次填充缓存，避免首次动作才探测造成延迟（不弹通知）
    mainViewProvider.refreshOpenOcdStatus(false);
    // 用户改动 emberprobe.openocdPath 后清空缓存并重新探测，使新路径立即生效
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('emberprobe.openocdPath')) {
            openocdChecker.resetCache();
            mainViewProvider.refreshOpenOcdStatus(true);
        }
    }));
    // 停用时兜底停止实时采样会话（关闭 OpenOCD 服务与 socket）
    context.subscriptions.push({ dispose: () => mainViewProvider.stopLiveWatch() });
}
function deactivate() {
    console.log('MCU_VSCODE 下载与调试器已停用！');
}
//# sourceMappingURL=extension.js.map
