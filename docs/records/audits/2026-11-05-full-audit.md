# EmberProbe 全量审查（2026-11-05，v0.9.1）

- 基线：`master` @ `098e0b9`（Release EmberProbe v0.9.1），审查开始时工作树干净。
- 方式：只读静态审查（按领域并行）+ 独立执行本机验证流水线。未修改任何产品或测试代码；本文件是唯一新增文件，未提交。
- 范围：`src/`（215 个 JS，约 6.4 万行）、`test/`（238 个顶层测试）、`scripts/`、`skills/`、`docs/`、`.github/workflows/`、`package.json`、构建与发布配置。
- 环境：Windows 10.0.26300 x64，Node v24.13.1，npm 11.8.0（CI 使用 Node 20/24）。

## 一、总体结论

**工程质量高，无 P0。** 本次实际执行的门禁全部通过：237 个普通测试 0 失败、全局行覆盖率 92.3%、分支 86.97%、coordinator/安全模块单独门槛通过；lint、Prettier、`tsc`、bundle、release-consistency、内置 OpenOCD 打包检查均通过。已核实的关键不变量包括：探针单一所有权与失败释放、Tcl 分帧/超时后丢弃连接、写事务 halt‑RMW‑回读语义、Bridge 认证与 Host 校验、二次确认一次性且绑定计划、Webview CSP 与转义、DAP 句柄与停止代次绑定、多核共享组租约、ELF 快照与 TOCTOU 防护。

**问题分布：P0 0 项，P1 5 项，P2 22 项，P3 22 项。**

P1 集中在三类系统性风险：

1. **“未确认”路径的语义不完整**：写事务失败后丢失已写入项（H1）；OpenOCD 退出未确认后再次启动会“假成功”（H2）。
2. **分层边界退化**：Webview 消息路由持有整个 Provider 而非窄上下文且零独立测试（A1）；18 个宿主/领域模块反向依赖 `src/webview/` 的浏览器资产（A2）。
3. **发布文档与实现冲突**：README 仍在教用户配置 v0.9.1 已删除的设置（D1，需用户决定是否改 README）。

另一个独立于代码质量的验证盲区：**Extension Host e2e 在本机 Windows 稳定失败**，而 CI 只在 Linux 上运行 e2e，Windows/macOS 没有该门禁（见第二节）。

### 建议的优先顺序

1. 修 H1/H2（异常路径语义）与 S1/S3（授权 fail‑closed）——改动小、风险收益比最高。
2. 修 S2（SVD 寄存器地址区段校验），把 `peripherals.*` 从“任意地址读写”收回到外设区。
3. 做 A2（宿主与 webview 资产解耦）与 A1（路由窄上下文 + 路由单测）。
4. 补 T1/T2（授权模块与 probeCoordinator 的单文件覆盖门槛、删除 c8 不合理排除）。
5. 定位并修复 Windows e2e，使 CI 至少覆盖一个 Windows Extension Host 任务。
6. D1 与文档类问题；README 需用户明确授权后再改。

## 二、验证结果（本次实际执行）

| 命令                                | 结果          | 关键输出                                                                                                                                                                                                             |
| ----------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                     | **通过**      | `519 files checked; 0 failed`（282 个源码语法检查 + 237 个普通测试）                                                                                                                                                 |
| `npm run quality`                   | **通过**      | lint / Prettier / `tsc` 全通过；c8 全局 `stmts 92.3 / branch 86.97 / funcs 92.07 / lines 92.3`；`Coordinator and safety coverage gates passed`                                                                        |
| `npm run bundle`                    | **通过**      | esbuild 6 个入口全部产出                                                                                                                                                                                             |
| `npm run check:release`             | **通过**      | `1 files checked; 0 failed`                                                                                                                                                                                          |
| `npm run check:openocd-bundle`      | **通过**      | 内置 OpenOCD no‑echo / 日志静默 / 连接复用 / 身份与来源校验 / 原生冒烟均通过                                                                                                                                          |
| `npm run test:e2e`                  | **失败**      | Extension Host 引导阶段 `MODULE_NOT_FOUND: ...\test\e2e\fixtures`，连续两次稳定复现，未进入任何测试用例                                                                                                               |
| `npm audit --omit=dev`              | 1 high        | `body-parser@2.3.0` DoS（经 `@modelcontextprotocol/sdk@1.32.1 → express@5.3.0`）；MCP 服务器只使用 `StdioServerTransport`（`src/mcp/server.js:273`），未发现 HTTP transport，故**实际不可达**，仍建议升级或裁剪依赖 |
| `npm audit`（含 dev）               | 8 项          | 6 moderate + 2 high，全部在 eslint/c8 依赖链（minimatch、glob、brace-expansion、body-parser），仅开发期                                                                                                                |

**未执行、因此未验证的部分：**

- `test/hil`（实板测试）：需要专用开发板与探针，本次未运行；软件测试不构成实板支持证明。
- `test/gdb`（外部 GNU 工具链的 GDB/STL/镜像传输测试）：本机未确认 ARM GDB 工具链，未运行。
- macOS/Linux 平台验证：本次仅在 Windows 上执行；交叉平台结论来自静态审查与 CI 配置，不是本次运行结果。
- 打包 VSIX（`npm run package`，CI 的 Linux 任务负责）：本次未执行。

**e2e 失败的性质**：`runTests` 启动 VS Code 1.136.1（使用 `.vscode-test` 缓存）后，Extension Host 把作为工作区传入的 `test/e2e/fixtures` 目录当成了测试入口去 `require`，在加载测试套件前即退出（`@vscode/test-electron/out/runTest.js:65` 会把 `launchArgs` 拼接在 `--extensionTestsPath` 之前）。两次运行结果一致，排除偶发。该现象的根因尚未定位（与 VS Code 1.136.1 的 CLI/测试引导行为、缓存安装或 Windows 参数解析有关，待验证）；与本次审查未触碰代码这一事实一致，但它说明 Windows 上的 Extension Host 实际不可用，属于验证盲区。CI 的 `extension-host` 任务只跑 `ubuntu-latest`（`.github/workflows/ci.yml:217-240`）。

## 三、P1 问题（5 项）

### P1-H1 写事务失败路径丢失“已写入项”语义

- **证据**：`src/liveWatch.js:1427-1432`（只有 `LIVE_READ_CANCELLED` 附带 `writtenItems`）、`src/liveWatch.js:997-1002`（预算超时抛 `LIVE_READ_BUDGET_EXCEEDED`）、`src/services/writeExecution.js:198-208`（只映射 `LIVE_READ_CANCELLED`）。
- **影响**：写入前 N 项成功后，若写入后的回读（after‑read）遇到预算超时、Tcl 错误或连接错误，上层只看到“读取超预算/读取失败”，无法判断内存是否已被修改。Agent 或 UI 可能按“未写入”重试，或误报为只读失败，进而产生重复写入或错误结论。
- **建议**：写入开始后，任何异常都应带上 `writtenItems/totalItems`；把预算超时显式映射为 `DEBUG_STATE_CHANGED(unverified)` 一类“状态未知”结果，而不是普通读错误。
- **置信度**：确认（触发需要慢探针/多变量，概率中等）。

### P1-H2 停止未确认后 `start()` 假成功

- **证据**：`src/services/liveWatchController.js:962-966`（`running && session` 直接复用并 `post sb.sampling`）、`src/services/liveWatchController.js:1122-1150`（stop 失败保留 session 与 lease，只置 `exitUnconfirmed`）、`src/services/samplingCoordinator.js:71-79`（`standaloneRunning` 即 `canRead`）。现有测试 `test/provider-state.test.js:197-204` 只固定“未确认退出保留 session、允许重试 stop”，并未固定再次 start 的行为。
- **影响**：OpenOCD 退出未被确认后 lease 仍 active，用户再点“开始”会显示采样成功，但实际没有任何进程；`canRead` 仍为 true，后续读取/写入进入失效通道。
- **建议**：`_start` 遇到 `exitUnconfirmed`/`session.stopped` 时拒绝启动，返回 `PROBE_EXIT_UNCONFIRMED` 并提示先重试停止或重新连接。
- **置信度**：确认（代码路径），触发为边界条件。

### P1-A1 消息路由以整个 Provider 为上下文，且没有任何独立测试

- **证据**：`src/controllers/webviewRoutes.js:5` 注释中的 `page = { host, post, watchKey, vscode }`；`sidebarRoutes.js` 中 `host._*` 引用约 78 次、涉及 30+ 个不同 Provider 成员，`livePanelRoutes.js` 约 79 次；路由内仍承担参数/generation 校验、CSV 命名、错误组装等逻辑；全仓测试没有任何文件直接测试 `createSidebarHandler`/`createLivePanelHandler`。
- **影响**：路由层与 Provider 私有成员强绑定，重命名/搬迁既无编译期保护也无测试保护；2026-10-30 结构审计设定的“handler 只拿窄上下文”目标未落地。
- **建议**：每页构造一个只含所需服务与 `post` 的窄对象；为两页路由各补一个假 page 单测（至少覆盖未知消息、非法载荷、代表性路由）。
- **置信度**：高。

### P1-A2 宿主/领域模块反向依赖 Webview 浏览器资产

- **证据**：至少 18 个非 webview 模块 `require` 了 `src/webview/**`：`validation.js:10`、`elfSymbols.js:24`、`liveWatchView.js:4`、`mainViewProvider.js:19-20`、`agentOperations.js:175`、`agentPlans.js:4`、`archiveChartHistoryStore.js:5`、`archiveHistoryIndex.js:5`、`chartBackgroundController.js:2`、`chartBackgroundStore.js:2`、`elfViewController.js:4-5`、`liveWatchService.js:3`、`pointerSymbolizer.js:4`、`runtimeObjectReader.js:5`、`runtimeWatch.js:4`、`seriesStyleStore.js:2`、`writeExecution.js:5`、`livePanelRoutes.js:7`、`chartHistoryWorker.js:7`。
- **影响**：`AGENTS.md` 定义 `src/webview/` 是“原样投放、不打包”的浏览器资产；现在这些文件被 esbuild 打进扩展与 Worker，同一份代码在浏览器和 Node 两端双跑。页面侧一旦（有意或无意）引入 `window`/`document` 依赖，宿主侧就会崩溃；反之宿主侧的 Node 依赖也会破坏页面。边界事实已失守，只是当前恰好没有触发。
- **建议**：把环境无关的纯函数（命名、显示、列编码、指针格式、设置广播）迁到 `src/shared/`（或 `src/webview` 之外的共享模块），`src/webview/**` 只保留浏览器绑定与薄适配器；`webviewAssets` 的“原样投放”假设才重新成立。
- **置信度**：高。

### P1-D1 README 仍在教用户配置 v0.9.1 已删除的设置

- **证据**：`README.md:275` 仍把 `emberprobe.probeSerial` 列为可用设置并描述优先级；`README.md:81` 称序列号“可在第三章探针高级设置中调整”；`README.md:294-302` 仍演示 `emberprobe.memory.regionKinds`。`CHANGELOG.md:45-50`、`docs/guide/settings.md:35,40` 已声明移除；`package.json` 的 21 项设置中不存在这两个键；`configurationStore.js:66` 把 `probeSerial` 固定为空；`configuration-store.test.js:31-40` 断言其不存在。英文 `README_EN.md` 不含这些内容，中英文已不一致。
- **影响**：用户配置不存在的设置（VS Code 会显示未知配置），预期的序列号优先级与内存区域分类不会发生；与 0.9.1 发布说明冲突。
- **建议**：删除该行与“内存区域类型”小节，改为指向侧栏选择与自动分类；在 `docs-links.test.js` 增加“README 中 `emberprobe.*` 键必须存在于 `package.json` contributes”的静态校验。
- **注意**：`AGENTS.md` 规定不得修改 `README.md`（除用户明确要求）。本条只报告，不代改；是否处理由用户决定。
- **置信度**：高。

## 四、P2 问题（22 项）

### 硬件与会话路径

- **P2-H3 一次性 OpenOCD 执行没有有界退出确认**：`src/services/openocdExec.js:138-170` 超时只 `kill`，仅等 `close` 才 `finish`；`src/openocdRunner.js:270-300,398-464` 同理（flash 120 s）。驱动/内核挂死时 promise 可能永不 settle，chipInfo/download 的 lease 永久占用，只能重载窗口。建议复用 `openocdProcess.waitForChildExit/terminate` 做注入时钟驱动的有界等待，超界返回 `resultUnknown`。置信度：确认（缺边界）。
- **P2-H4 Worker 在拿到 childPid 前崩溃会遗留 OpenOCD 进程**：`src/samplingSession.js:20-29` 的 `childPid` 只来自 `message.state`，`:70-83` 的 fail 只在已知 childPid 时 kill。孤儿进程继续持有 USB 探针，后续操作全部 `PROBE_BUSY`，直到手工杀进程/reload。建议 Worker spawn 后立即单独上报 childPid，失败路径必尝试终止并校验 PID 身份。置信度：可能（窗口小，缺崩溃注入测试）。
- **P2-H5 Worker 请求无超时，shutdown 无界等待**：`src/samplingSession.js:84-97`（request 无截止）、`:191-211`（stop 等该请求）、`src/mainViewProvider.js:1156-1157`（shutdown await 无界）。Worker 卡死时扩展停用/重载被拖住，OpenOCD 跨窗口存活。建议 request 加注入时钟截止，stop 超时后 `worker.terminate` + 确认子进程退出兜底。置信度：确认（无超时）。
- **P2-H6 resume 失败后目标保持 halted 且不标记降级**：`src/memoryWrite.js:120-147` 恢复运行失败只抛错；`src/liveWatch.js:1390-1401` 独立采样非对齐写会 halt 再恢复。写成功但恢复失败时目标停住，后续采样“成功”却读到冻结值，没有暂停提示。建议 resume 失败重试一次并标记暂停原因/降级，details 带 `targetHalted`。置信度：确认。
- **P2-H7 批量读一错全失**：`src/liveWatch.js:1005-1057` 单条 Tcl 命令 join 最多 8 个 group，`:1270-1303` 只有 incompatible 或 scatterFailed 才降级逐段。一批中一段不可读（MPU/非法范围）即整批 Tcl 错误，同批变量该周期全部丢失，且只报一次“读取内存失败”。建议多 group 遇 Tcl 错误时退化为逐 group 读取。置信度：确认（行为），触发可能。
- **P2-H8 Tcl RPC 无鉴权，随机回环端口只是提高门槛**：`src/liveWatch.js:35-48`、`src/openocdProcess.js:58-62` 只 `bindto 127.0.0.1`；`src/tclTransport.js` 协议无认证。同机任意进程枚举端口即可 halt/`write_memory`/`shutdown`。OpenOCD 限制下难以根治，建议在安全文档中写明威胁模型（是否可接受属设计决策，待确认）。

### 内置调试器

- **P2-D2 符号目录/长读取阻塞控制请求，超时会杀掉整个 GDB 会话**：`src/debug/session.js:233-244` 控制请求只能插队并标记 `cancelled`，`:264-270` 仍须等当前请求结束；`src/debug/symbolDirectory.js:12-15,173` 用 60 s 超时；`src/debug/mi.js:159-195` 任一 MI 超时即 `fail()` 杀进程并 reject 全部 pending。展开 Globals/大页时 F5/继续可能表现为卡死 15-60 s，超过 60 s 则整个调试会话终止。建议把目录加载改为可分段放弃的任务（AbortSignal/批次校验）并上报 progress，至少把超预算降级为“globals 不可用”而非终止会话。置信度：确认（机制），时长取决于固件规模。
- **P2-D3 控制超时后 bridge 的 `transitionKind` 不复位**：`src/services/debugSessionBridge.js:463-476`（收到控制请求即置 transition）、`:926-971`（`_control` 超时/异常直接 throw）、`:152-160,262-266`（`canRead`/`assertPausedAccess` 以 transition 拒绝）。清理只发生在 stopped/continued/terminated/failed 事件（`:578-638`），无自愈定时器。适配器半死时暂停读取/写入/Agent 访问会长期被拒，直到下一次事件或手动切会话。建议 `_control` 的 catch/finally 按 operationToken/stopEpoch 条件清除 transition 并触发一次状态重同步。置信度：确认（缺清理），触发可能。
- **P2-D4 FreeRTOS 栈填充扫描失败会中断链表遍历**：`src/services/freeRtosSnapshot.js:200-221` 栈扫描 `read` 未 try/catch，`:223-239` 链表遍历直接 await；`:240-259` 只在整条链级 catch 后写诊断。单个任务栈范围不可读/超预算时，同链表后续任务全部从快照消失。建议把栈扫描拆成可失败步骤（只标记该任务 fillEstimate 不可用），预算耗尽时继续枚举任务。置信度：确认（代码路径），触发少见。
- **P2-D5 烧录固定 60 s MI 超时会中途终止并杀 GDB**：`src/services/debugImages.js:289,298,312`（`-target-download` 60000）、`:245`（compare-sections 60000）；`src/debug/mi.js:159-195` 超时即 `fail()`。慢速 SWD + 较大固件可能超时，导致下载中断、Flash 半写入、会话终止且不可续传。建议按镜像大小/实测速率估算超时并留余量，区分“可重试传输超时”与“会话终止”，超时后至少复位目标并给出明确诊断。置信度：可能（取决于速度/镜像大小）。

### 安全与信任边界

- **P2-S1 确认 ID 未绑定用户所选 once/workspace，`remember` 由调用方决定**：`src/flashAuthorization.js:124-166`（choices 返回给调用方，`remember` 只取 `options.remember`）、`src/services/agentFlashService.js:109-142`、`src/services/writeExecution.js:291-337`、`src/cubemxAuthorization.js:31-46`、`src/mcp/confirm.js:173-179`（无 elicitation 时把 `confirmationId` 直接交给 agent）。被提示注入的 skill 脚本或持 token 的本地进程可在用户答“仅一次”后仍传 `remember:true`，把一次性授权升级为 24 h 持久授权。MCP elicitation 路径已正确映射 choice，可作为实现参考。建议按 choice 派生不同 ID，或在 pending 记录 choice 并在 consume 时比对。置信度：确认（代码路径），影响受 token + 可信工作区限制。
- **P2-S2 外设读写不校验 SVD 寄存器地址所属区段**：`src/services/svdPeripheralService.js:960-971` 地址直接取自 SVD，`:984-1069` 只有会话/世代 guard，`:52` 只有 32 位整数范围；agent 可无确认 `config.set svd`（`configurationStore.js:142`、`agentOperations.js:52-73`），`peripherals.read` 无需确认（`src/mcp/tools.js:425-454`）。伪造 SVD 可把“寄存器”定义在 Flash/option bytes/RAM，使 `peripherals.write` 的确认框看起来像普通外设写入，从而绕过烧写与 `.data/.bss` 写入限制；`peripherals.read` 可把任意内存/固件内容回传 agent。建议绑定 SVD 时校验寄存器地址落在设备外设/PPB 区（或与 ROM 表/已知存储器映射对照），对未知来源 SVD 提高确认等级并审计 svd 变更。置信度：确认（无区间校验），实际影响取决于用户是否细看确认。
- **P2-S3 `canRememberWrite` 在缺少 `selectionIdentity` 时 fail-open**：`skills/_emberprobe/probe-connection.js:163`（`if (!family) return result;`，不带 `selectionIdentity`）、`:91`（`!connection?.selectionIdentity?.anonymous` 对 undefined 返回 true）、`src/flashAuthorization.js:87-93` 据此允许 remember。`docs/design/agent-trust-boundaries.md:22,31` 与 `test/flash-workspace-permission.test.js:84-95` 都声称“匿名探针永不 remember”。agent 先 `config.set debugger=任意已存在 interface/*.cfg`（`isSafeCfgPath` 放行、无需确认）即可走无 `selectionIdentity` 分支，用户选 workspace 后 24 h 内同一 cfg 下换物理探针可无确认烧写。建议 `canRememberWrite` 要求显式 `selectionIdentity` 且 `anonymous === false`；`resolveProbeConnection` 无 family 时也返回 `{ anonymous: true }`。置信度：确认（代码），触发需用户选择 remember 且存在未知族 interface cfg。

### 架构与代码质量

- **P2-A3 组合根不完整，构造路径分裂**：`NoticeService`（`src/mainViewProvider.js:218`）、`MemoryAnalysisController`（`:512`）、`ChartBackgroundController`（`:692`）、`SeriesStyleStore`（`:711`）、`LivePanelRegistry`（`:713`）由 Provider 直接 `new`，`composition.js` 不构造；`RtosViewService` 在 `composition.js:460`、`mainViewProvider.js:263`、`sidebarRoutes.js:237` 三处有构造路径。与 `CLAUDE.md`“`composition.js` 构造 Provider 持有的服务”不一致，注入/替换规则分裂。建议把这 5 个普通服务移入 `createServices`，删除路由内的兜底构造。置信度：高。
- **P2-A4 Webview 函数长度护栏有盲区**：`eslint.config.js` 对 `src/webview/**` 全量排除 `max-lines-per-function`，原因是“UMD 工厂函数就是整个文件”，但该理由不覆盖内层页面工厂。实测 15 个 >300 行函数：`valueTree` create 650、`peripherals` create 578、`writeList` create 510、`exportDialog` create 366、`panelLayout` create 319、`chart` paintChart 451 / paint 342 等。建议只豁免 UMD 外壳，内层函数纳入 300 行（或先对 >500 的三个 create 设单文件上限，随拆分下调）。置信度：高。
- **P2-A5 “每页一个 `state` 对象”只部分成立**：`src/webview/liveWatch/renderer.js` 仍有 31 个顶层可变 `var`（`:253-261,436-532,620-658,1005-1010,1605-1725`），`state` 只有 21 个 key；`src/webview/sidebar/renderer.js` 有 6 个（`:47,151-152,180,230,795`），`state` 14 个 key。测试通过 `window.eval("state")` 读不到全量状态。建议把残余可变绑定并入 `state`（如 `state.chart`）。置信度：高。
- **P2-A6 图表重绘无抽样/步进保护**：`src/webview/liveWatch/chart.js` `paintChart` 451 行、12 个 for 循环，全文件无 decimation/stride/pixelPerPoint 类逻辑；每序列上限 360001 点（`chartHistoryStore` MAX_POINTS）。视口放大到全量程时每帧遍历全部点，主线程掉帧风险；`prepared` 缓存只避免重算基线，不减少绘制量。建议按像素宽度做 min/max 抽稀（每列两点）或按 rAF 预算裁剪。置信度：中（需压测量化，待验证）。
- **P2-A7 死导出累积**：`src/` 内 67 个导出符号除定义外全仓（src/test/scripts/skills）无引用，例如 `controllers` 的 `SIDEBAR_ROUTES`/`LIVE_PANEL_ROUTES`/`csvExportFileName`、`probeCoordinator` 的 `ProbeLease`、`mcp/results` 的 `MAX_TEXT`、`chip/rules.js` 的 11 个常量、`dwarf/typeIdentity` 的 `equivalentTypes`、`writeAuthorization` 的 `writePlanIdentity`、`openocdInstaller` 的 `archiveDigest`/`BUNDLED_DIR`。`tsc`/`no-unused-vars` 不覆盖导出面。建议改为模块内常量/函数，或用 lint 规则清理。置信度：高。

### 测试与文档

- **P2-T1 单文件覆盖率门槛未覆盖授权/安全核心**：`scripts/check-coordinator-coverage.js:5-17` 只列 11 个 service 加 `elf-file`、`svdWorker`；`src/writeAuthorization.js`、`flashAuthorization.js`、`peripheralWriteAuthorization.js`、`cubemxAuthorization.js`、`agentBridge.js`、`probeCoordinator.js`、`validation.js` 没有单文件门槛（`probeCoordinator` 有 20+ 测试引用但同样无门槛）。安全模块回退可被全局约 90% 的覆盖率掩盖。建议至少把四个 `*Authorization`、`probeCoordinator`、`agentBridge` 加入门槛。置信度：高。
- **P2-T2 c8 排除了 3 个有专门测试的真实逻辑模块**：`.c8rc.json:8-11` 排除 `autoDetect.js`（156 行）、`chipInfo.js`（98 行）、`openocdInstaller.js`（265 行），三者都被生产代码引用（`composition.js:10`、`mainViewProvider.js:9,17`、`openocdChecker.js:12`）且分别有 `auto-detect.test.js`、`chip-info.test.js`、`openocd-installer.test.js`。这些文件的分支完全不受门槛约束，与“renderer 已计入覆盖”的方向相反。建议删除排除项或写明理由（`extension.js` 与两个 30-37 行 view 壳可保留）。置信度：中高。
- **P2-T3 普通测试仍有约 25 处固定 sleep（20 个文件）**：如 `test/rtos-view.test.js:47,50,142`（30/180 ms）、`test/peripheral-view.test.js:210`（180 ms）、`test/sampling-archive.test.js:40`（200 ms）、`test/chart-host.test.js:35,592`（70 ms）、`test/archive-history.test.js:841,845`、`test/value-display.test.js:20`、`test/csv-export.test.js:42`、`test/openocd-exec.test.js:205`。`test/helpers/wait.js:4-13` 已提供 `waitFor`，`AGENTS.md` 明确要求跨 Worker/子进程/文件 I/O 用条件等待。CI 负载高时易 flaky。建议改为 `waitFor` 或 `render-webview` 的 FakeClock；有意测真实时间的用例（`sampling-clock`、`adaptive-sampling:142` 等）保留并注释。置信度：高。
- **P2-V1 Windows Extension Host e2e 不可用且无门禁**：见第二节。`npm run test:e2e` 在本机连续两次在引导阶段失败；`.github/workflows/ci.yml:217-240` 只在 `ubuntu-latest` 运行。建议在 CI 增加 Windows（或至少 macOS）e2e 矩阵，并先在干净缓存/最新 `@vscode/test-electron` 上复现定位。置信度：确认（本机失败），根因待验证。

## 五、P3 问题（22 项）

| 编号  | 问题                                                                                | 证据                                                                                                    | 置信度 |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| P3-H1 | debug 模式 silent 响应共享单一临时文件，未来并发即串话                              | `src/tclTransport.js:180-243`（`_responseFile` 每次覆盖；共享 `rpcTimeoutMs/probing`）                  | 可能   |
| P3-H2 | `runtimeObjectReader` 未使用注入时钟，违反 AGENTS 时钟约定                           | `src/services/runtimeObjectReader.js:81,156`（`Date.now()`）vs `src/liveWatch.js:1229`                  | 确认   |
| P3-H3 | `autoDetect` 全并发打开最多 2000 个 ELF，EMFILE 时镜像被静默丢弃                     | `src/autoDetect.js:7,72-85`                                                                             | 确认   |
| P3-H4 | 内置 OpenOCD 摘要同步整包读取，阻塞扩展主机                                          | `src/openocdInstaller.js:88-98`（`readFileSync` 算 sha256）                                             | 确认   |
| P3-D1 | 多处依赖英文 GDB 消息文本（本地化/措辞变化即静默降级）                               | `src/debug/session.js:1188-1199,900`、`variables.js:55,311`、`symbolDirectory.js:176,281`、`debugImages.js:251` | 可能   |
| P3-D2 | `stackTrace` 把 DAP 的 `levels:0`（全部帧）当 20 帧                                  | `src/debug/session.js:1168-1169`（`args.levels \|\| 20`）                                              | 确认   |
| P3-D3 | DAP 面向用户的字符串未走 i18n                                                       | `src/debug/session.js:1229-1233,381,872`；`errors.js:4-8` 已约定错误带 i18n key                          | 确认   |
| P3-D4 | 用户 Python printer 的安全边界只在初始化时加固一次                                   | `src/services/prettyPrinting.js:32-39,56-63`；`src/debug/variables.js:46-58` 后续只用 captureConsole     | 确认   |
| P3-D5 | 每个变量节点多 1-2 条 MI；hover 缓存无上限                                           | `src/debug/variables.js:164-192`；`src/debug/session.js:986-1024`（`hoverEvaluations` 无上限）           | 确认   |
| P3-S1 | 0o600 在 Windows 被 Node 忽略，文档“减少跨账户暴露”只在 NTFS 继承 ACL 下成立          | `src/agentBridge.js:107`、`src/services/bridgeRegistry.js:56`、`docs/design/agent-trust-boundaries.md:88-89` | 理论   |
| P3-S2 | `config.set` 无确认即可改 elf/svd/iocPath/debugger/mcu/transport/adapterSpeed/tclPort | `src/services/configurationStore.js:33-44`                                                              | 确认   |
| P3-S3 | Webview 资产 `flag:"wx"` 吞 EEXIST，内容寻址文件名可预测                             | `src/webviewAssets.js:107-113`                                                                          | 理论   |
| P3-S4 | `openocdInstaller` tar 解包无条目数/总大小预算                                       | `src/openocdInstaller.js:151-177`                                                                       | 理论   |
| P3-S5 | Bridge 无速率限制，可挤占 ConfirmationStore 的 32 条 FIFO 造成确认 DoS               | `src/confirmationStore.js:13-16`                                                                        | 低     |
| P3-A1 | `run-tests.js` 启动即清空报告目录，`check`/`quality` 并发会互删报告；语法检查不覆盖 `test/` | `scripts/run-tests.js:166,182-195`                                                                      | 中     |
| P3-A2 | esbuild 的扩展入口 target `node18`，Worker/debugAdapter 入口 target `node20`；`engines.vscode ^1.85` 的扩展宿主是 Node 18 | `esbuild.js:15,31,41,50,59,68,80`                                                                       | 待验证 |
| P3-A3 | `docs/design/webview-ui.md` 未记录共享层/页面适配器/`state` 约定                     | `docs/design/webview-ui.md`（37 行）                                                                    | 高     |
| P3-T1 | 升级兼容路径未登记 compat-layers（旧指针区域名、旧 tab、旧 skills 全局、旧图状态）    | `src/webview/liveWatch/renderer.js:532`、`src/webview/runtime.js:266,293`、`src/services/livePanelRegistry.js:73`、`skillStatusService.js:11` | 中     |
| P3-T2 | 新静态检查 `docs-links.test.js` 未用 `scenario()`                                    | `test/docs-links.test.js`（78 行）                                                                      | 中     |
| P3-T3 | `probe-selection.md` 与 `test/hil/README.md` 的 probeSerial 措辞易读成已删除的设置    | `docs/design/probe-selection.md:7`、`test/hil/README.md:141`                                            | 中     |
| P3-DOC1 | 命令面板/视图标题只有中文，无 `package.nls.json`，与双语设置不一致                   | `package.json:89-141`；根目录无 `package.nls.json`                                                      | 高     |
| P3-DEP1 | 生产依赖 1 项 high（`body-parser` DoS，经 MCP SDK→express；MCP 只用 stdio，实际不可达）；dev 依赖 8 项 | `npm audit`                                                                                             | 事实   |

## 六、分领域结论（已核实的关键不变量）

**硬件与会话**：探针单一所有权（`ProbeCoordinator.acquire` 覆盖 download/debugStart/liveStart/agentRead/chipInfo/targetScan，transition/release 幂等，失败路径 finally 释放）；Tcl `0x1A` 分帧、1 MiB 失控流保护、超时后整连接丢弃且迟到响应不复用；写事务自然宽度窄写 + 回读、窄写丢失回退 32 位 RMW、仅自身 halt 才 resume；读侧 `targetEpoch`/deadline 守卫、每周期 4096 B/32 命令预算与独占仲裁；启动参数 `shell:false`、`-s/-f` realpath + `isSafeCfgPath`、transport/speed/serial/rtos 白名单、Tcl 仅 `127.0.0.1` 随机端口；Worker 代际过滤、backlog 三上限 + gap、多核共享组关闭 Tcl 运行时读写。

**内置调试器**：handle/变量与停止代次三重校验（`generation` + `executionEpoch` + `threadGeneration`），resume 后旧帧句柄报 stale；MI 流/异步记录、转义/嵌套/超限处理，解析失败 `fail()` 全量 reject 并 kill GDB；DAP 顺序 launch→response→initialized、configurationDone→stopped/continued、disconnect→terminated；控制请求可插队并取消尾部读取，写内存不被控制打断；内部 halt 与真实断点竞争区分正确；多核身份含探针/目标/传输/序列号/速度/RTOS/核数，末成员退出并确认 exit 后才释放租约。

**安全**：Bridge 仅 `127.0.0.1` + 随机端口，Host 必须等于 `socket.localPort`（防 DNS rebinding），24 B token 用 `timingSafeEqual`，仅 `POST /v1/call`，64 KiB 上限；每次 dispatch 重校验 workspace trust 与关闭状态，full-access 只能由侧栏设置、无 Bridge 方法可自授权；二次确认 128-bit 随机 ID、5 min TTL、指纹绑定 ELF sha/target/probe/写入项字节/SVD sha/`.ioc` 前后 hash，consume 先 delete 再比对 → 一次性、参数变化即失效；ELF 单句柄读取 + 52 B 头 + 64 MiB 上限 + size/mtime 变化拒绝 + 0600 私有快照；SVD 解析拒绝 DOCTYPE/ENTITY；skill/zip/tar/SVD 落盘有 realpath 包含性检查；Webview 权威 nonce CSP、拒绝 `on*`/内联脚本，全仓无 `eval`/`new Function`；MCP elicitation 默认 deny。

**架构**：Provider 仍是视图/接线（1343 行、90 个方法、最长 104 行），无循环依赖（对 215 个 src 文件做 require 图 + Tarjan，SCC 均为 1）；路由表化到位（sidebar 18 / live 13 / 共享 6）；尺寸棘轮未过期（见下）；webview 共享层有效（564 个函数中同体对 0，同名 26 组中仅 6 组是页面接线）；资源有界（`MAX_POINTS=360001`、backlog 16 MB、archive ≤64 MB、刷新节流）。

**测试**：238 个顶层测试 100% 登记；fast 组字母序受 `test-runner.test.js:190-193` 守护；无 `.only/.skip/todo`、无环境条件跳过普通测试；`assert.throws/rejects` 1164 处；`scenario()` 417 次/85 文件；`test-helper-reuse` 拦截 helper 副本；`docs-links`、`i18n-keys`、`configuration-store` 三个静态测试有效守护文档/键表/设置结构；`compat-layers` 4 项与 `release-consistency` 五处版本一致。

## 七、ESLint 尺寸棘轮现状

口径为 ESLint `max-lines`/`max-lines-per-function`（跳过空行与注释），由审计实测：

| 文件                                   | 实测（最长函数） | 现有上限 | 结论                                                                 |
| -------------------------------------- | ---------------- | -------- | -------------------------------------------------------------------- |
| `src/webview/liveWatch/renderer.js`    | 2848             | 2848     | 相等；拆分时同步下调                                                 |
| `src/webview/sidebar/renderer.js`      | 1694             | 1694     | 相等（b82292c 已下调过）                                             |
| `src/webview/runtime.js`               | 1543             | 1543     | 自 2026-10-30 未降；建议拆“命名/显示 vs 布局数据”，降到 1500 内并删条目 |
| `src/dwarf/parser.js`（最长函数）      | 769              | 769      | 相等                                                                |
| `src/dwarf/runtimeTypes.js`（最长函数）| 368（另有 341）  | 368      | 同文件两函数均纳入上限，偏松；拆一个即可删条目                       |

全仓超过 1500 行的文件恰为表中前 3 个，没有“超限却未登记”的文件；非 webview 函数超过 300 行且未登记的为 0。缺口在 webview 函数（P2-A4）。另有 5 个 ≥1000 行的 service 接近上限，建议列入下次拆分候选：`debugSessionBridge` 1146、`liveWatchController` 1102、`runtimeObjectReader` 1092、`cubemxService` 1090、`svdPeripheralService` 1035。

## 八、修复顺序建议

1. **异常路径语义（H1/H2）**：`writtenItems` 全路径附带 + “状态未知”结果映射；`_start` 拒绝 `exitUnconfirmed`。两项都能用现有测试夹具覆盖，风险低。
2. **授权严格化（S1/S3）**：确认 ID 绑定用户选择（MCP elicitation 的实现可复用）；`canRememberWrite` 要求显式非匿名 `selectionIdentity`。
3. **SVD 区段校验（S2）**：至少要拒绝落在 Flash/option bytes/RAM/PPB 之外的“寄存器”；对 agent 可改的 `svd` 设置提高确认等级。
4. **分层回归（A2/A1）**：先迁 `runtime.js`/`chartTransport.js` 等纯逻辑到 `src/shared/`，再收窄路由上下文并补路由单测。
5. **门禁补齐（T1/T2/V1）**：安全模块单文件覆盖率门槛、删除 c8 排除、Windows e2e 定位与 CI 矩阵。
6. **其余 P2/P3**：按领域排期（debug 控制响应性、FreeRTOS 任务枚举、图表抽稀需先压测）。

## 九、审查方法与限制

- 分五条只读审计线（硬件/采样、DAP/GDB‑MI、安全与信任边界、架构与 Webview、测试与文档），由 Lead 统一复核证据、执行验证流水线并撰写本报告。所有结论都要求能定位到源码行或命令输出；标注“可能/待验证”的条目表示需要动态验证或产品决策。
- 未使用 Team 的写权限修改产品代码；本次唯一新增文件是本报告。验证运行会写入 `dist/`、`coverage/`、`test-results/`（均为 `.gitignore` 中的生成目录），`git status` 除本报告外保持干净。
- 软件测试通过不等于实板支持：HIL 未执行，`test/hil/README.md` 的实板矩阵仍需在发布前单独验证；`test/gdb` 外部工具链测试也未执行。
