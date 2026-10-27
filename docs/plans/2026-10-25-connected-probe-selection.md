# 已连接调试器选择：审计与设计

日期：2026-10-25。范围：调试器（物理探针）选择与 Windows J-Link 驱动切换的系统性重构方案。基于对 master `22b79ff`/`8eb4c5d` 的只读审计；未改动实现，未连接硬件。

## 1. 结论摘要

- **根因**：“当前用哪台物理探针”从未成为一个显式状态，而是每条代码路径各自从五个来源临时推导：`emberprobe.probeSerial` 设置、工作区成功记录 `mcu.successfulProbeConnection`、预检快速选择的临时结果、`selectedDeviceId`、以及“清单里恰好只有一台”。不同路径推导结果不一致时就出错，修一处又冒一处。
- **用户反馈的故障**（“提示 SEGGER → 点切换到 WinUSB → 报找不到 J-Link”）就是这个问题：预检按快速选择/记忆解析出 A，点击按钮后 [`_changeJlinkDriver`](../../src/mainViewProvider.js#L6605) 只按设置重新解析，得到 `null`，在调用 helper、弹 UAC 之前就失败。
- **方案**：侧栏在“选择调试器”（接口 cfg）旁并列新增 **“已连接调试器”** 下拉栏，列出所有已连接探针（不受 cfg 过滤）。选择结果写入唯一的工作区选择记录，所有路径（预检、驱动切换、监视、Agent）共用一个解析函数。SEGGER J-Link 的 WinUSB/SEGGER 驱动下拉从“选择调试器”移到所选设备之后，按设备切换。
- **分阶段**：阶段 0 是可单独发版的热修复；阶段 1–3 完成重构。

## 2. 现状审计

### 2.1 选择来源

| 来源 | 存储 | 写入方 | 位置 |
| --- | --- | --- | --- |
| `emberprobe.probeSerial` | VS Code 工作区设置（`.vscode/settings.json`，可能被提交进仓库） | 用户、Agent `config.set` | [configurationStore.js:162](../../src/services/configurationStore.js#L162) |
| 成功记录 `mcu.successfulProbeConnection` v1/v2 | workspaceState | 操作成功后 `recordSuccess` | [probeConnectionService.js:158](../../src/services/probeConnectionService.js#L158) |
| 预检快速选择 | 仅当前请求的局部变量 `request` | 交互式 `prepare` | [probeConnectionService.js:110](../../src/services/probeConnectionService.js#L110) |
| `selectedDeviceId` | 同上，临时 | 无序列号的唯一设备 | [probeConnectionService.js:133](../../src/services/probeConnectionService.js#L133) |
| 唯一设备 / 接口脚本序列号 | 推导 | `resolveProbeConnection` | [probe-connection.js:170](../../skills/_emberprobe/probe-connection.js#L170) |

### 2.2 消费者

| 消费者 | 使用的来源 | 位置 |
| --- | --- | --- |
| 预检（读芯片、采样、调试、下载） | 设置 + 成功记录 + 快速选择 | [probe-preflight.js:146](../../skills/_emberprobe/probe-preflight.js#L146) |
| SEGGER 驱动警告（右下角通知） | 预检的错误详情 `instanceId` | [mainViewProvider.js:393](../../src/mainViewProvider.js#L393) |
| 驱动切换（侧栏下拉与通知按钮） | **仅**设置 + 成功记录 | [mainViewProvider.js:6619](../../src/mainViewProvider.js#L6619) |
| 侧栏驱动下拉的显示/隐藏、3 s 监视 | 设置 + 成功记录 | [mainViewProvider.js:6546](../../src/mainViewProvider.js#L6546) |
| Agent / skill 脚本 | Bridge 配置快照（含 `successfulConnection`） | [flash-common.js:447](../../skills/_emberprobe/flash-common.js#L447)、[mainViewProvider.js:1117](../../src/mainViewProvider.js#L1117) |

### 2.3 已确认的缺陷

用真实模块复现（只构造清单，不访问硬件）：

| 场景 | 预检警告 | 点击“切换到 WinUSB” |
| --- | --- | --- |
| 单台普通 J-Link | 有 | 正常进入 helper |
| 多台 J-Link，在快速选择中选了一台 | 有 | `No uniquely selected supported J-Link is connected` |
| 单台 J-Link，但工作区记住的是另一台 | 有（先让用户重选） | 同上 |
| 复合 J-Link，调试接口无法唯一识别 | 有（`instanceId` 实为 USB 父设备） | 同上 |
| PID 不在允许列表 | 有 | 同上 |

其他问题：

1. [jlink-driver.js:75](../../skills/_emberprobe/jlink-driver.js#L75)：只要有接口使用 `jlink` 服务就阻止操作，这是对的；但分类结果不是 `repair` 时仍弹出带“切换”按钮的通知，按钮注定失败。
2. `PROBE_DRIVER_SELECTION_REQUIRED` 没有 i18n，中文界面里直接显示英文。
3. [zh.js:132](../../src/i18n/zh.js#L132) 提示“在‘选择调试器’右侧选择 WinUSB”，但上述场景中该下拉是隐藏的（[renderer.js:2563](../../src/webview/sidebar/renderer.js#L2563)），多 J-Link 用户只能手动填写设置。
4. 快速选择的结果不持久化；SEGGER 驱动下操作永远不成功，成功记录也永远不会写入，所以每次都要重选。
5. 驱动切换的忙碌判断是全局的：`_probeCoordinator.anyActive()` 和 helper 的进程检查（[main.c:215](../../native/driver-helper/main.c#L215)，任意 `openocd.exe`/`JLink*.exe`）都会因另一台探针在用而拒绝，错误文案没有说明原因。
6. 写 `probeSerial` 会改动 `.vscode/settings.json`，如果该文件被提交进仓库，队友机器上的探针序列号不同，会触发 `PROBE_SELECTED_NOT_FOUND`。

## 3. 目标与非目标

目标：

- 只有一份“当前选择的物理探针”状态，所有路径用同一个解析函数，结果一致。
- 无论 cfg 选的是什么，用户都能看到所有已连接探针，以及每台的可选状态和原因。
- 多台 J-Link 可以各自切换驱动；按钮只在能成功的情况下出现。
- 选择的探针拔掉后不会被静默替换（保持现有策略）。
- Agent 与 UI 看到的选择一致；Agent 的歧义报错和确认规则不变。

非目标：

- 不改变驱动 helper 的安全边界（PID 允许列表、仅改已确认的调试接口、备份与回滚、libwdi 哈希校验）。
- 不新增自动驱动切换；仍然只在用户主动选择时切换。
- 不处理网络 / 本地 / 自定义接口脚本内部的设备选择（仍由脚本决定）。

## 4. 设计

### 4.1 状态模型

保留一个显式覆盖项，新增一个工作区选择记录：

| 层级 | 存储 | 含义 |
| --- | --- | --- |
| 接口脚本内的序列号 | cfg（`profile.scriptSerial`） | 由脚本决定，界面只读 |
| `emberprobe.probeSerial` | 工作区设置 | **显式覆盖**，语义不变；设置后下拉栏锁定为该值，并提示“由设置 emberprobe.probeSerial 指定” |
| `mcu.selectedProbe`（新，v3） | workspaceState，按机器保存，不进仓库 | 下拉栏选择、预检快速选择、操作成功都写入这里；取代 `mcu.successfulProbeConnection` |
| 唯一设备 | 推导 | 没有任何记录时自动选中 |

`mcu.selectedProbe` 结构：

```js
{
    version: 3,
    family: "jlink",            // probeFamily
    probe: "jlink.cfg",         // 选择时的接口 cfg
    serial: "123456789",        // 可信 USB 序列号；无序列号设备为空
    deviceId: "USB\\VID_1366&PID_0101\\000123456789",
    attachmentId: "",           // 无序列号设备：仅在同一次插入期间有效
    profile: "",                // 接口 profile 指纹（预检后才有）
    source: "user" | "success"  // 仅用于诊断，不影响优先级
}
```

迁移：读取时若没有 v3，把旧的 `mcu.successfulProbeConnection` v1/v2 当作 `source: "success"` 使用；第一次写 v3 时删除旧键。Bridge 配置快照继续提供 `successfulConnection` 字段（从 v3 映射），保证已安装的旧版 skill 脚本仍可用。

无序列号设备：只记录 `deviceId + attachmentId`。重新插拔后 `attachmentId` 改变，记录视为“未连接”，要求重选，不猜测。

### 4.2 统一解析函数

在 `skills/_emberprobe/probe-selection.js`（新，与 Agent 共享）中实现：

```js
resolveSelectedProbe({ debugger, probeSerial, selectedProbe, profile }, inventory)
// => { state, device, serial, source, reason }
// state: "selected" | "absent" | "ambiguous" | "none" | "script" | "not-applicable"
```

- 优先级：接口脚本 > 设置覆盖 > `mcu.selectedProbe` > 唯一设备。
- `resolveProbeConnection` 改为调用它，其余逻辑（传输协议、`adapterSerial`、写入身份）不变；错误码保持兼容（`PROBE_SELECTION_REQUIRED`、`PROBE_SELECTED_NOT_FOUND`、`PROBE_IDENTITY_AMBIGUOUS`）。
- `jlinkDriverChoice` 删除，驱动状态改为按设备计算（4.3）。
- 预检、驱动切换、下拉栏标记“当前选中”、Agent 全部经由这个函数。

### 4.3 探针清单服务

新增 `src/services/probeInventoryService.js`，取代 `_startJlinkDriverMonitor`：

- 数据来源：`listProbes({ family: "all" })`。Windows 优先使用原生 `listWindowsProbeRows`（已包含 `service`/`driverProvider`/`driverInf`），再退回 PowerShell；随后经 `ProbeDriverService.reconcileInventory` 修正刚切换过驱动的设备。
- 节奏：只在侧栏可见时轮询，上一次扫描完成后等 3 s；连续多次无变化后放宽到 10 s。并发请求合并为一次（single-flight）。提供手动刷新。
- 每台设备输出一条供界面使用的记录：

```js
{
    key,                 // 规范化 deviceId（无序列号设备附带 attachmentId）
    family, label, name, serial, serialTrusted,
    defaultCfg,          // "jlink.cfg" | "cmsis-dap.cfg" | "stlink.cfg" | ...
    selected,            // resolveSelectedProbe 的结果
    selectable, reason,  // 例如多台且无可信序列号 → false + i18n 原因
    driver: { kind: "repair" | "ready" | "unknown" | "unsupported" | "not-applicable", reason }
}
```

- `driver` 直接复用 `classifyJlinkDriver`，按设备计算，不再依赖当前选择。

### 4.4 cfg 与设备联动

- 由**设备带动 cfg**：选中设备后，若 `probeFamily(当前 cfg)` 与设备的 `family` 不同，则通过 `configurationStore.update({ debugger: defaultCfg })` 改成该类型的默认 cfg，同时写入 `mcu.selectedProbe`（一次事务，失败回滚）。同类型的 cfg（例如 `stlink-v2.cfg`）保持不变。
- 和 cfg 不同类型的设备照常列出，选项文字标注类型。
- 以下情况设备栏显示“由接口脚本决定”并禁用：cfg 的 profile 是 `tcp`/`local`/`unknown`，或脚本中写死了序列号。界面判断用 `probeFamily(cfg 名称)`（不启动 OpenOCD）；需要 OpenOCD capability 才能确定的情况，在预检时报错并给出说明。
- `selectDebugger`（[mainViewProvider.js:721](../../src/mainViewProvider.js#L721)）改 cfg 后，若当前选择的设备类型不符，清除 `mcu.selectedProbe`。

### 4.5 侧栏界面

在 [modernView.js](../../src/modernView.js) 的 `debuggerRow()` 之后新增 `connectedProbeRow()`：

```
[探针图标] 选择调试器        jlink.cfg
[USB 图标] 已连接调试器      [ J-Link · 123456789 · SEGGER 驱动 ▾ ]  [ WinUSB ▾ ] ↻
```

- 第一个下拉（`<select id="connectedProbe">`）的选项：
  - `自动（唯一设备）`：清除选择记录。
  - 每台设备：`<类型> · <序列号或“无序列号”> · <驱动/状态>`，`title` 写完整名称、`deviceId` 和原因。
  - 不可选的设备显示但设为 `disabled`，例如“多台设备时无可信序列号，OpenOCD 无法区分”。
  - 已选但不在线：`（未连接）J-Link · 123456789`，保持选中，不自动替换。
  - 设置覆盖时：整个下拉禁用，只显示覆盖值和说明。
  - 没有设备：`未检测到调试器`。
- 第二个下拉（驱动）：原来的 `jlinkDriverChoice` 从 `debuggerRow()` 移到这里，只对当前选中的 Windows x64 J-Link，且 `driver.kind` 为 `repair`/`ready` 时显示。为 `unknown`/`unsupported` 时改为显示状态标记，悬停显示原因和手动处理办法（Zadig、SEGGER J-Link Configurator 的 WinUSB 选项）。
- 原生 `<select>` 的选项里放不下第二个下拉，所以“为另一台 J-Link 切驱动”的操作是：先在第一个下拉选中它，再操作第二个下拉。
- 忙碌状态沿用 `setProbeDriverBusy` / `cpuProbeOwned` 的规则；会话进行中两个下拉都禁用（沿用 `_assertConnectionEditable`）。
- `mockup/` 使用真实前端，需要补上新状态的模拟数据（单台、多台、无序列号、SEGGER、WinUSB、不支持、未连接、设置覆盖）。

### 4.6 驱动切换与警告通知

- `_changeJlinkDriver(driver, deviceKey)`：用 `deviceKey` 在新扫描的清单中定位设备，重新分类，必须是 `repair`（切到 WinUSB）或 `ready`（恢复 SEGGER）。不再按设置重新解析。
- 预检的 `PROBE_DRIVER_UNSUPPORTED` 详情补充 `deviceId`、`probeSerial`、`driverKind`。`onDriverUnsupported`：
  - `driverKind === "repair"`：通知带“切换到 WinUSB”按钮，绑定这台设备的 `deviceKey`。
  - 其他情况：通知不带切换按钮，只说明原因，并把接口清单（实例 ID、服务、驱动提供者、INF）写入输出面板。
- 忙碌判断：
  - 扩展内：从 `anyActive()` 改为“这台设备是否有租约”。若 `probeCoordinator` 暂无按设备查询的接口，就先保持全局判断，只改错误文案。
  - helper 的全局进程检查保持不变（无法从进程判断它用的是哪台 J-Link），退出码 11 的文案改为“检测到正在运行的调试进程（openocd.exe / JLink*.exe），可能正在使用其他探针”。

### 4.7 预检快速选择

交互式 `prepare` 中用户在快速选择里选了设备后，写入 `mcu.selectedProbe`（`source: "user"`），下拉栏随之更新。之后的驱动切换、监视、Agent 都使用同一个选择。

### 4.8 Agent / Bridge

- `config.get` 增加只读字段 `selectedProbe`（有效选择及其来源）；`config.set probeSerial` 仍是设置覆盖，语义不变。
- `probe.list` 保持只读 OS 元数据，可额外标注 `selected: true`。
- 规则不变：多台设备、没有选择时，Agent 收到带 `choices` 的歧义错误；无可靠序列号的探针只允许 `once`。不新增 Agent 写入 `mcu.selectedProbe` 的接口（避免绕过用户在界面上的选择）。
- 更新 `skills/_emberprobe/agent-workflow.md` 中关于选择来源的描述。

### 4.9 i18n 与文档

- 新增文案：已连接调试器、自动（唯一设备）、未检测到调试器、未连接、由设置指定、由接口脚本决定、无可信序列号无法区分、驱动无法自动切换的原因（PID 不在允许列表 / 调试接口不唯一 / 驱动提供者无法验证）、选择需要/选择已改变/调试进程占用。
- 删除或改写 `probe.winusbRequired` 中“在‘选择调试器’右侧选择”的说法。
- 更新 `docs/JLINK-COMPATIBILITY.md`（中英双语段落）以及 `CHANGELOG.md` Unreleased（双语）。不改 `README.md`。

## 5. 分阶段实施

### 阶段 0：热修复（可单独发版）

1. 预检错误详情带上 `deviceId`/`probeSerial`/`driverKind`；`_showJlinkDriverWarning` 保存这组信息；`_changeJlinkDriver` 用它定位设备，不再按设置重新解析。
2. 只在 `repair` 时显示“切换到 WinUSB”按钮；其他情况显示原因。
3. 快速选择结果写入工作区选择（这一步先复用 `mcu.successfulProbeConnection` v2 结构，阶段 1 再迁移到 v3）。
4. `PROBE_DRIVER_SELECTION_REQUIRED` 等错误补 i18n，区分“多台未指定”和“记住的探针不在线”。
5. 测试：把 2.3 节五个场景写成回归测试。

### 阶段 1：统一选择状态

1. 新增 `probe-selection.js` 和 `mcu.selectedProbe` v3，完成迁移和 Bridge 快照兼容。
2. `resolveProbeConnection`、预检、Agent 路径改用 `resolveSelectedProbe`。
3. 新增 `probeInventoryService`，取代 J-Link 专用监视器。

### 阶段 2：界面与按设备切换驱动

1. 新增 `connectedProbeRow()`、渲染逻辑和消息（`probeInventory`、`selectConnectedProbe`、`selectProbeDriver` 带 `deviceKey`）。
2. 驱动下拉从 `debuggerRow()` 移走；实现 cfg 联动。
3. 补 `mockup/` 状态，截图浅色/深色、中英文。

### 阶段 3：文档与验证

1. 文档、CHANGELOG、agent-workflow。
2. E2E 冒烟；按 `test/hil/README.md` 做人工硬件验证（见 6.3）。

## 6. 测试计划

### 6.1 单元测试（新文件需登记到 `scripts/test-groups.js`）

- `probe-selection.test.js`：优先级（脚本 > 设置 > 选择记录 > 唯一设备）；不在线不替换；无序列号设备的 `attachmentId` 失效；多台无可信序列号时标为不可选；v1/v2 迁移；cfg 类型不符时的处理。
- `probe-inventory-service.test.js`：single-flight、可见性控制轮询、退避、`reconcileInventory` 合并、按设备的驱动分类。
- `jlink-driver-choice.test.js` 扩充：2.3 节五个场景；按钮仅在 `repair` 时出现；`deviceKey` 定位到正确设备；多台 J-Link 中切换非首台的驱动。
- `configuration-store` 相关：设备带动 cfg 的事务与回滚。
- `webview.test.js`：新行渲染、禁用原因、设置覆盖锁定、忙碌状态。
- 保持 c8 覆盖率门槛和 `check-coordinator-coverage.js` 的单服务门槛。

### 6.2 E2E

- `npm run test:e2e`：侧栏新行存在，打开时不报错；无硬件时显示“未检测到调试器”。

### 6.3 硬件验证（人工，需用户明确同意后才能切驱动）

| 组合 | 检查点 |
| --- | --- |
| 单台 J-Link（SEGGER） | 下拉显示 SEGGER；切 WinUSB → UAC → 就绪；恢复 SEGGER |
| 两台 J-Link（一台 SEGGER，一台 WinUSB） | 选中任意一台都能正确显示和切换自己的驱动；另一台不受影响 |
| J-Link + CMSIS-DAP 同时插入 | 两台都列出；切换选择时 cfg 跟随变化；下载走所选设备 |
| 拔掉已选设备 | 显示“未连接”，不自动改选另一台 |
| 无序列号 CMSIS-DAP（单台 / 两台） | 单台可选；两台时禁用并显示原因 |

现有 HIL 设备矩阵见项目记忆（H750/F407 × J-Link/CMSIS-DAP × Win/WSL）。是否有第二台 J-Link 需要确认。

## 7. 风险与待定决策

1. **选择记录存放位置**：本方案用 workspaceState，避免序列号进入 `.vscode/settings.json` 被提交。代价是选择不随仓库共享，也不跨机器同步。`probeSerial` 设置仍可作为团队共享的显式覆盖。
2. **设备带动 cfg**：选中不同类型的设备会自动改 cfg。如果更希望保守，可以改为弹确认，或只标注不匹配、不自动修改。
3. **下拉栏还是快速选择（QuickPick）**：其他配置行用的是 QuickPick，它能显示分组和多行说明。本方案按要求用侧栏内的 `<select>`，原因说明放在 `title` 悬停提示里。
4. **轮询开销**：所有类型一起扫描比只扫 J-Link 慢；原生枚举不可用的机器会退回 PowerShell。需要在慢机器上测一次扫描耗时，必要时把轮询间隔调大。
5. **兼容性**：旧版已安装的 skill 依赖 `successfulConnection` 字段，Bridge 快照需保留映射至少一个大版本。

## 阶段 1 实现记录（2026-10-26，分支 `feat/unified-probe-selection`）

与上文计划的差异：

- **解析优先级以代码为准**：`probeSerial` 设置 > 接口脚本里的序列号 > 已选调试器记录 > 唯一连接设备。上文表格把脚本序列号排在第一位，是笔误。
- **v3 记录不含 `attachmentId`**：只存 `probe / probeSerial / family / deviceId / profile / source`。物理连接身份仍由写操作授权在确认时单独绑定。
- **库存扫描不做单飞合并**：并发扫描各自执行，以最后发起的扫描为 `latest`；驱动切换后的刷新和过期扫描测试依赖这一点。
- **轮询退避推迟到阶段 2**：J-Link 监视仍只在 win32/x64 且选中 `jlink.cfg` 时运行，但已改为扫描所有类型（Windows 原生 cfgmgr32 路径）。
- **`probe.list` 暂不标注已选设备**：标注随阶段 2 的界面行一起做。

## 阶段 2–3 实现记录（2026-10-26，分支 `feat/unified-probe-selection`）

已完成：侧栏“已连接调试器”行（`<select>` + 驱动下拉 + 刷新按钮）、`connectedProbes` / `selectConnectedProbe` / `refreshConnectedProbes` 消息、`selectProbeDriver` 带 `deviceId`、设备带动 cfg（失败回滚）、轮询退避（3 s → 10 s；macOS 10 s → 30 s）、`probe.list` 的 `selected: true` 标记、mockup 模拟数据、文档与 CHANGELOG、E2E 冒烟检查。

与上文计划的差异：

- **改 cfg 时不清除选择记录**：记录里的 `probe` 与当前 cfg 不一致时解析函数本来就会忽略它；切回原 cfg 后记录重新生效。
- **驱动切换的忙碌判断仍是全局的**：`probeCoordinator` 没有按设备查询租约的接口；helper 退出码 11 的文案已在阶段 0 改过。
- **无可靠序列号的设备**：只有在它是同类唯一设备时才可选；选中时清除记录，由“唯一设备”规则选中它。
- **界面验证范围**：mockup 中验证了深色主题中文界面的布局与交互；浅色主题和英文只经 jsdom 测试覆盖。
- **硬件验证（6.3 节）未做**：需要用户同意并连接真实设备（尤其是两台 J-Link 的驱动切换）。
