"use strict";
const assert = require("assert");
const vm = require("vm");
const fs = require("fs");
const modernView = require("../src/modernView");
const liveWatchView = require("../src/liveWatchView");
const { LiveWatchSession } = require("../src/liveWatch");

function validateScripts(name, html) {
  const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g), match => match[1]);
  assert.ok(scripts.length > 0, `${name} should contain scripts`);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `${name}-${index}.js` }));
}

const sidebar = modernView.getModernWebviewContent({ elf: "app.elf", debugger: "stlink.cfg", mcu: "stm32f4x.cfg", svd: "" });
validateScripts("modernView", sidebar);
assert.ok(sidebar.includes('id="liveValues"'));
assert.ok(sidebar.includes('id="liveToggle"'));
assert.ok(sidebar.includes('id="openocdCard"'), "sidebar should contain an OpenOCD status card");
assert.ok(sidebar.includes('id="openocdInstall"'), "OpenOCD card should offer bundled installation");
assert.ok(sidebar.includes("type:'openocdAction',action:'select'"), "OpenOCD path selection should be handled inside the sidebar");
assert.ok(sidebar.includes("m.type==='openocdStatus'"), "sidebar should render OpenOCD status messages");
assert.ok(sidebar.includes('id="availableVars"'));
assert.ok(sidebar.includes('type:\'saveSidebarWatch\''), "sidebar should persist an independent watch list");
assert.ok(sidebar.includes('class="variable-browser"'), "ELF variable browser should be collapsible");
assert.ok(sidebar.includes('.variable-browser:not([open])>summary:before{transform:rotate(0)}'), "closed ELF browser should restore its right-pointing arrow");
assert.ok(sidebar.includes('id="varResizeHandle"'), "ELF variable browser should expose a full-width resize handle");
assert.ok(sidebar.includes('.available{resize:none}'), "native corner-only resizing should be disabled");
assert.ok(sidebar.includes('class="available-head"'), "variable metadata should use aligned columns");
assert.ok(sidebar.indexOf('id="varResizeHandle"') > sidebar.indexOf('id="availableVars"'), "resize handle should sit below the ELF variable list");
assert.ok(sidebar.includes('class="tree-row auto-row"'), "auto detection should be visually distinct inside MCU configuration");
assert.ok(sidebar.includes('class="tree-divider">手动配置'), "manual MCU configuration should have a visual separator");
assert.ok(!sidebar.includes('>推荐</span>'), "auto detection should not show a recommendation badge");
assert.ok(!sidebar.includes('<summary>关键操作</summary>'), "redundant key-actions section should be removed");
assert.ok(sidebar.includes('sym.isComposite'), "sidebar should guard aggregate variables");
assert.ok(sidebar.includes('<summary>芯片信息</summary>'), "sidebar should include a chip info section");
assert.ok(sidebar.includes('id="chipRead"'), "chip info section should offer a read button");
assert.ok(sidebar.includes('id="chipBody"'), "chip info section should render results into a body container");
assert.ok(sidebar.includes("type:'readChipInfo'"), "chip info read should post a dedicated message");
assert.ok(sidebar.includes("m.type==='chipInfo'"), "sidebar should render chip info payloads");
assert.ok(sidebar.includes("m.type==='chipInfoStatus'"), "sidebar should reflect chip info status");
assert.ok(sidebar.includes("type:'copyText'"), "UID row should copy via the extension clipboard bridge");
assert.ok(sidebar.includes('详细信息'), "chip info should provide a collapsible details area");
assert.ok(sidebar.includes('调试连接') && sidebar.includes('运行信息'), "details should group debug-connection and run-info");

const panel = liveWatchView.getLiveWatchContent({ maxSamples: -10, intervalMs: 1 });
validateScripts("liveWatchView", panel);
assert.ok(panel.includes('id="timeWindow"'));
assert.ok(panel.includes('id="freeze"'));
assert.ok(panel.includes('html,body{width:100%;height:100%;overflow:hidden}'), "panel should fit its webview without page scrolling");
assert.ok(panel.includes('card.append(rm,sw,main,val,sel)'), "remove button should be the first control in each variable card");
assert.ok(panel.includes("rm.textContent='-'"), "graph remove control should use a minus sign");
assert.ok(panel.includes('id="sideSplitter"'), "current-value column should expose a vertical splitter");
assert.ok(panel.includes('id="sideToggle"'), "current-value column should be collapsible");
assert.ok(panel.includes('.side-toggle:before'), "collapse control should use a compact pane-layout icon");
assert.ok(panel.includes('.layout.side-collapsed .side-toggle{color:var(--vscode-focusBorder)'), "collapsed value pane should have a distinct toggle state");
assert.ok(panel.indexOf('id="sideToggle"') < panel.indexOf('id="run"'), "value-pane toggle should sit before the sampling button");
assert.ok(panel.includes('input[type=number]::-webkit-inner-spin-button'), "number inputs should suppress theme-inconsistent native spinners");
assert.ok(panel.includes('.overlay{background:color-mix(in srgb,var(--vscode-editor-background)'), "import overlay should follow the active editor theme");
assert.ok(panel.includes("impHead.className='imp-head'"), "import dialog should render an aligned metadata header");
assert.ok(panel.includes("z.className='size'"), "import dialog should align size in its own column");
assert.ok(panel.includes('if(sym.isComposite)'), "graph importer should reject aggregate variables");

const extensionSource = fs.readFileSync(require.resolve("../src/extension"), "utf8");
const checkerSource = fs.readFileSync(require.resolve("../src/openocdChecker"), "utf8");
assert.ok(extensionSource.includes("type: 'openocdStatus'"), "extension should publish OpenOCD state to the sidebar");
assert.ok(!checkerSource.includes('showWarningMessage'), "missing OpenOCD must not use notification popups");
assert.ok(!checkerSource.includes('ProgressLocation.Notification'), "OpenOCD installation progress should stay in the sidebar");
assert.ok(extensionSource.includes("sym.isComposite ="), "ELF enrichment should classify structures and arrays");
assert.ok(extensionSource.includes("readChipInfoAction"), "extension should implement a chip info read action");
assert.ok(extensionSource.includes("type: 'chipInfo'"), "extension should publish chip info to the sidebar");
assert.ok(extensionSource.includes("this._chipInfoRunning"), "chip info reads should guard against concurrent probe usage");
assert.ok(extensionSource.includes("clipboard.writeText"), "extension should copy chip UID via the VS Code clipboard API");
assert.ok(extensionSource.includes("_scalarWatchList"), "persisted aggregate watches should be filtered before sampling");
assert.ok(panel.includes('"maxSamples":100'), "maxSamples should be clamped");
assert.ok(panel.includes('"intervalMs":20'), "interval should be clamped");

// 连接失效必须一次性停止采样并拒绝整个 FIFO，避免迟到响应串到下一个请求。
let disconnects = 0;
let rejected = 0;
const session = new LiveWatchSession(null, {}, { onDisconnect: () => { disconnects++; } });
session.queue.push({ reject: () => { rejected++; } }, { reject: () => { rejected++; } });
session._abortConnection(new Error("timeout"));
session._abortConnection(new Error("duplicate"));
assert.strictEqual(session.stopped, true);
assert.strictEqual(session.queue.length, 0);
assert.strictEqual(rejected, 2);
assert.strictEqual(disconnects, 1);

// start() 进行中触发 abort：应拒绝 start Promise 而非调用 onDisconnect，避免重复通知
let startErr = null;
const session2 = new LiveWatchSession(null, {}, { onDisconnect: () => { disconnects++; } });
session2._startReject = (err) => { startErr = err; };
session2._abortConnection(new Error("child exited during connect"));
assert.ok(startErr && startErr.message === "child exited during connect", "start promise should be rejected with the abort reason");
assert.strictEqual(session2._startReject, null, "_startReject should be cleared after deferral");
assert.strictEqual(disconnects, 1, "onDisconnect must not fire while start is in flight");

console.log("Webview & live session tests passed");
