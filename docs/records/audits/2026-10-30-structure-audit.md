# 结构堆积审计（2026-10-30，基于 v0.9.0）

本轮清理（死代码、注释英文化、测试整合）之后，剩下的问题已经不是“多余的代码”，而是“放错位置、重复实现的代码”。下面按收益排序，给出每项的现状数据、成因和分步方案。数据均来自当前工作树。

## 本轮已完成（作为基线）

- 净删除约 2.2k 行：未接线的方法与导出、≤v0.7 迁移、旧脚本、47 个无引用 i18n 键；ESLint 新增 `no-unused-vars`，防止未使用的变量和导入再次积累。
- 注释：775 组中文注释已改写为英文，13 组变更日志式注释删除，测试里 110 条中文断言消息英文化。面向用户和 Agent 的中文文案不在此列。
- 测试：
    - 删除 3 个已被后端历史取代的测试或基准；`dwarf-zstd-budget` 并入 `dwarf-budget`。
    - 6 份逐字复制的约 110 行 DIE 树构造器和 6 组字节编码函数，收拢到 `test/helpers/dwarf-tree.js`。
    - `render-webview` 支持 `FakeClock`，替代节流等待的真实 sleep。
    - 修复 `cubemxLog` 每行复制 1 MiB 日志尾部的二次复杂度（这是产品代码问题，CubeMX 输出长时会占用扩展宿主 CPU）。
    - 耗时：全量 `npm test` 从 57.3 s 降到 53.4 s（4 进程）；`cubemx-generation-safety` 从 8.4 s 降到 1.0 s，`pointer-targets` 从 7.8 s 降到 2.2 s。

## 结果（分支 `refactor/structure-accumulation`，2026-11-01）

| 指标                              | 审计时                                                 | 现在                                                                                        |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `MainViewProvider`（ESLint 计数） | 6718 行，最长方法 430 行                               | 1343 行，没有超过 300 行的方法                                                              |
| 波形页 / 侧栏 renderer            | 4483 / 3118 行                                         | 2902 / 1756 行                                                                              |
| 两页同名平行实现                  | 37 组                                                  | 6 组（页面接线）                                                                            |
| `liveWatch.js`                    | 2155 行                                                | 1420 行                                                                                     |
| ESLint 单独上限项                 | 文件 5 项，函数 3 项                                   | 文件 3 项（两个 renderer、`runtime.js`），函数 2 项（`dwarf/parser`、`dwarf/runtimeTypes`） |
| 测试文件                          | 240 个，65.5k 行                                       | 224 个，64.8k 行                                                                            |
| 全量测试（4 进程，同一台机器）    | `npm test` 53.4 s                                      | `npm run check` 43 s                                                                        |
| 全局行覆盖率                      | 87.8%（两个 renderer、`viewport.js`、Provider 不计入） | 91.87%（都已计入）                                                                          |
| 兼容层                            | 没有登记                                               | 登记 5 项：4 项在 1.0.0 移除，`writeAuthorization` 的 fail-closed 检查永久保留              |

**仍未达到默认上限的部分**（上限只降不升，后续拆分时同步下调）：

- 波形页 renderer 2902 行。
- `runtime.js` 1543 行。这次没有动它，两页的共享代码放进了新的 `valueTree.js` 和 `symbolPicker.js`。
- `dwarf/parser` 中最长函数 769 行，`dwarf/runtimeTypes` 368 行。

**验证范围**：只做了软件验证（`check`、`quality`、`bundle`、Extension Host e2e，以及内置 OpenOCD dummy 适配器上的 no-echo 和 scatter 检查）。P2 ManagedOpenOcdSession 改动了采样与写入的硬件路径，没有跑 HIL；发布前应按 `test/hil/README.md` 在实板上验证。

**后续维护**：这份文档不在 `scripts/docs-cleanup.js` 的 `MAIN_DOCS` 里，发版时会被清理。长期规则写在：

- `AGENTS.md`：模块边界、测试约定、尺寸上限、兼容层登记。
- `eslint.config.js`：尺寸棘轮，webview 按 classic script lint。
- `scripts/compat-layers.js`：兼容层登记表，由 `compat-layers.test.js` 和 `release-consistency` 守护。
- `test-helper-reuse.test.js`、`i18n-keys.test.js`：拦截测试辅助函数副本和死 i18n 键。

## 执行进度

- [x] P3 护栏
    - `eslint.config.js` 加了尺寸棘轮：单文件上限 1500 行，非 webview 单函数上限 300 行。超限文件按现值单独设上限，只降不升。
    - 新增 `i18n-keys.test.js`：动态前缀从源码中识别，扫描覆盖 skills。顺带删除 6 个死键，并修正 mockup 中已过时的 SVD 下载消息。
    - 新增 `test-helper-reuse.test.js`：顺带让 `cpp-display-name` 改用共享的 `buildElf32`。
- [x] P2 兼容层
    - 新增登记表 `scripts/compat-layers.js`，由 `compat-layers.test.js` 检查。
    - `release-consistency` 在版本达到 1.0.0 时报错。
    - `maxSamples` 已从 Agent 可写键和 `mcu-config` 文档中移除。
- [x] P1 Webview 渲染器
    - [x] 交付路径统一：webview 只从 `src/webview` 读取，打包后 prelude 只执行一次（此前执行 2–3 次）。
    - [x] 修复两个潜在显示问题：侧栏非限定指针名丢首字母；运行时基类被当作 `@base0` 嵌套显示。
    - [x] 新增共享 prelude 模块 `src/webview/valueTree.js`，承载值显示、指针记忆、指针展开、叶子/嵌套/布局/运行时树渲染、复合值刷新和刷新节流；两页各传一个适配器。同名平行实现从 37 组降到 7 组（约 120 行，剩余为页面接线：`t`、`applyI18n`、`setLang`、`noticeArea`、`togglePointee`、`updateValues`、`isUserVariable`）。
    - 两页统一后的行为：侧栏指针目标行补上 `aria-label`，嵌套类型补上 `title`，非指针的 collapsed 节点按波形页规则提示。
    - [x] 每页的观察列表、ELF 符号、读数和展开状态收拢为一个 `state` 对象，`valueTree` 直接读取它，不再经过逐项存取函数；测试通过 `window.eval("state")` 访问。webview 改为 `sourceType: "script"` 的标准 lint（`vars: "all"`），未引用的顶层函数会直接报错，只供测试使用的名字须写进 `/* exported */`。
    - [x] 新增共享 prelude 模块 `src/webview/symbolPicker.js`：侧栏变量面板和波形页导入对话框共用用户变量过滤、名称与成员搜索（每次最多补 4 个布局）、复合变量展开与成员提示、行数预算；两页只各自构造行。同名平行实现再降到 6 组（113 行，均为页面接线）。统一后的行为：侧栏已展开但缺布局的复合变量在重绘时也会请求布局（与波形页一致）；修复侧栏在展开行已请求布局时点击 “+” 不生效的问题。
    - [x] 行数目标：按功能拆出页面模块——侧栏 `sidebar/writeList.js`（写入列表）；波形页 `liveWatch/exportDialog.js`（CSV 导出）、`liveWatch/panelLayout.js`（值面板停靠/浮动布局）、`liveWatch/variableEntry.js`（添加变量输入与自动补全）。侧栏 renderer 3118 → 1756 行，波形页 renderer 4483 → 2902 行（ESLint 计数）。两页内联的脚本总量各减少约 40 KB（侧栏 446 → 406 KB，波形页 561 → 520 KB）。
    - [x] 页面代码计入覆盖率：`render-webview` 把已知的页面脚本块拆回源文件，在页面上下文里按真实文件名逐个执行，c8 因此能把覆盖率映射回每个模块。两个 renderer 和 `viewport.js` 不再从 `.c8rc.json` 排除，renderer 显式声明 `"use strict"`（此前靠拼接在 `notice.js` 之后才处于严格模式）。此前一直显示 0% 的 `memoryView`、`peripherals` 现为 97%、90%；全局行覆盖率 87.85% → 90.68%（多计入约 4,600 行 renderer 代码）。
- [x] P1 MainViewProvider（Provider 6718 → 1339 行，构造函数 390 → 61 行，没有超过 300 行的方法，`eslint.config.js` 中 Provider 的两个覆盖项都已删除，Provider 计入覆盖率）
    - [x] 消息路由表：侧栏和波形页的消息 `switch` 移到 `src/controllers/sidebarRoutes.js`、`livePanelRoutes.js`，按消息类型查表（`Object.hasOwn`）。两页都有的 5 种消息（copyText、setLang、expandLayout、resolveCompositeLayout、saveRuntimeExpansions）共用 `webviewRoutes.js` 里的一份实现；`_handlePeripheralViewRequest` 的 if 链并入路由表。侧栏消息失败时记录日志，不再变成无人处理的 rejection。`CACHE_KEYS` 移到 `src/cacheKeys.js`，`connectedProbeId` 移到 `validation.js`。Provider 6718 → 6043 行。
    - [x] Agent 计划纯函数：`_agentVariablePlan`、`_agentWritePlan`、`_decodeAgentSample` 移到 `src/services/agentPlans.js`（`readPlan`、`writePlan`、`decodeSample`），ELF 符号通过 `readElf` 回调传入，参数校验仍先于读取 ELF。删除只在测试中走到的 `refreshSymbols` 选项（生产调用方都传 `false`）和 `_agentSymbolResolver` 包装（直接用 `elfSymbols.createSymbolResolver`）。12 个测试文件改为直接调用；原先给 Provider 打桩计划的 4 处改为提供 ELF 符号，让调用方跑真实计划。Provider 6043 → 5681 行。
    - [x] 采样控制器 a（读取计划）：新建 `src/services/liveWatchController.js`，Provider 通过原型上的 `_sampling`（首次使用时创建）访问。移入合并读取计划、运行时 RAM 过滤与预算、消费者解码类型、把计划下发给采样会话或调试服务器、`refreshSamplingPlan`；运行时 RAM 缓存和拒绝/超预算提示键归控制器所有，Provider 只调用 `invalidateRuntimeRam()`、`resetRuntimeNotices()`。`debugReadPlanKey` 移到 `liveWatchService`。24 个测试文件改为通过 `_sampling` 访问或打桩。Provider 5681 → 5392 行。
    - [x] 采样控制器 b（会话生命周期）：启动/停止、启动代际与 lease、退出未确认、采样频率与无上限开关、指针只采展开部分、样本批量下发、背压和 gap、指针外设刷新移入控制器，`_live*` 字段改为控制器自己的 `session`、`intent`、`consumers`、`intervalMs` 等。Provider 构造时把配置的频率和两个工作区开关作为参数传给控制器，`vscode` 和 `ManagedOpenOcdSession` 由 Provider 模块注入（测试仍可经 `loadProvider` 替换）。两个状态键和 `latestByName` 随之移走。31 个测试文件（含 e2e、HIL 各 1 个）改为经 `_sampling` 访问。Provider 5392 → 4691 行。
    - [x] ELF 变化（与计划的偏差：单独成 `src/services/elfViewController.js`，经 `_elfView` 访问，没有并入采样控制器。它管的是 ELF 怎样到达视图和监视列表，与采样无关，并入后采样控制器会逼近 1500 行上限）：ELF 加载进度推送、所选复合变量的布局预取、监视列表按新符号重绑定、布局展开请求、`invalidate`/`refreshBindings`、ELF 版本标识。`rebindPromise`、`watchNameChanges` 归该控制器所有。视图同步（`_syncSidebarTarget`/`_syncGraphTarget`）属于视图生命周期，留在 Provider。20 个测试文件改为经 `_elfView` 访问。Provider 4691 → 4354 行。
    - [x] 调试启动与烧录命令：`debug`/`attachDebug` 命令主体、托管 OpenOCD 调试服务器启停、共享调试组、启动看门狗与失败清理、外部 GDB attach、VS Code 调试会话与 adapter 事件、调试后恢复采样、GDB 预热移入 `src/services/debugLaunch.js`（`DebugLaunch`，经公开的 `provider.debugLaunch` 访问，`extension.js` 直接调用它的 `handleSessionStart` 等入口）。`_managedDebug*`、`_debug*` 启动状态、生命周期和预热对象归它所有；`vscode`、调试工具查找、OpenOCD 脚本和调试服务器控制器由 Provider 模块注入，测试仍可经 `loadProvider` 替换。`debugControlService.startDebug` 直接调用 `debugLaunch.start`，不再绕回命令表。`download` 命令移到 `src/services/flashCommand.js` 的 `runDownload(host, vscode, resource)`。测试直接设置的启动状态（token、lease、启动失败标记等）改为公开字段；e2e 和外部调试测试的“不得进入 OpenOCD 路径”桩改到 `debugLaunch.startManagedServer`，否则会悄悄失效。`tsc` 检查补上两处只在被移走代码中赋值的字段（`savingFrequency`、主机事件循环监视器），现归采样控制器所有。23 个测试文件迁移。Provider 4354 → 3284 行，最大函数 430 → 358 行（构造函数）。
    - [x] 写入执行：UI 写和 Agent 写共用的 `src/services/writeExecution.js`（`WriteExecution`，经 `_writes` 访问）——写入所走的探针连接、固件一致性与身份检查、计划绑定的确认授权、带回读的写执行、托管服务器运行时读的静默。侧栏写入的排队与“拖动滑块时跳过被新值取代的旧值”从路由移进 `queueUiWrite`，路由只负责回复 `writeResult`。`targetChangedWriteError` 及其消息表随之移走。11 个测试文件迁移；一个拷贝 Provider 自有属性的测试夹具改为创建自己的写控制器，否则会沿用另一个 Provider 的 `vscode`。Provider 3284 → 2944 行。
    - [x] Agent 操作：`src/services/agentOperations.js`（`AgentOperations`，经 `_agentOps` 访问）承担 Agent 路由在探针上做的事——短会话读取与多次采样、采样控制、加入监视列表、CSV 导出、故障读取、CubeMX 执行与配置修改；探针仲裁 `withProbe` 和 Agent 读取会话、取消标记、采样运行集归它所有。`vscode` 和 `ManagedOpenOcdSession` 由 Provider 模块注入。访问决策移到 `agentService.js` 的纯函数 `agentAccessDecision`，`AgentService.sync(decision)` 负责启停 Bridge 并记录关闭原因；Provider 只收集工作区输入。删除转发用的 `_handleAgentCall`，e2e 直接调用 `_agentService.call`。（偏差：与审计“操作并入 `agentService`”不同，`agentService.js` 仍只负责 Bridge 生命周期与派发，避免产生新的千行模块。）21 个测试文件迁移。Provider 2944 → 2323 行。
    - [x] 已连接探针列表（计划外的一步，为把 Provider 压到 2000 行以下）：`src/services/connectedProbes.js`（`ConnectedProbes`，经 `_connectedProbes` 访问）承担侧栏的探针列表——清点轮询、每个探针读到的芯片、工作区的探针选择记录、J-Link USB 驱动提示与切换。驱动切换标记、列表修订号、上次发出的消息、芯片读取状态归它所有；`vscode` 和 `listProbes` 由 Provider 模块注入（测试仍可经 `loadProvider` 替换清点模块）。控制器的存储字段改为类字段声明，不再占构造函数的行数。10 个测试文件迁移。Provider 2323 → 1944 行。
    - [x] 组合根：`src/composition.js` 的 `createServices(host, context, { vscode })` 构造 Provider 持有的 34 个 Service，按领域分成探针、采样、工作区（配置/CubeMX/ELF/SVD/状态卡片）、Agent 四个构造函数；跨领域的构造期引用用局部变量传递，回调在运行时经 `host` 读取成员，测试或 e2e 之后替换的成员照样生效。Provider 构造函数只保留视图状态并逐项接收 Service（348 → 61 行），删除 Provider 的单函数行数覆盖项。`extension.js` 不再读取 Provider 私有成员：改用 `refreshCubeMxStatus()`、`language`、`viewState()`。`test/helpers/load-provider.js` 新增 `createProvider()`，用假 VS Code API 和临时目录里的扩展上下文运行真实构造函数；新测试 `provider-construction` 检查组合根构造的每个 Service 都被持有、回调能到达 Provider、`shutdown()` 能收尾。（偏差：计划中“把本 Phase 改过的 `Object.create` 测试都改用 `createProvider()`”没有做。约 90 处调用分布在 52 个文件，只包一层 `Object.create` 没有实际收益，Phase 4 合并测试时还要再改一次；`createProvider()` 改为提供此前缺少的真实构造路径。）Provider 1944 → 1622 行。
    - [x] 波形历史供给（计划外的一步，让 Provider 回到 1500 行默认上限以内）：`src/services/chartHistoryFeed.js`（`ChartHistoryFeed`，经 `_historyFeed` 访问）承担各波形面板与历史缓存之间的往来——共享积压预算内的批量追加、每个面板的历史条目、从采样归档恢复、worker 失败后的重启退避（最多三次）、“历史已受限”提示只发一次。待处理追加、宿主侧排队字节、恢复任务、重试次数和两个提示标记归它所有，退避常量随之移走。10 个测试文件迁移。Provider 1622 → 1339 行，低于默认上限，删除 Provider 的文件行数覆盖项；ESLint 上限表里已没有 Provider。
    - [x] Provider 计入覆盖率：此前把 `mainViewProvider.js` 移出 `.c8rc.json` 的排除列表不起作用，它仍不出现在报告里。原因有两个：`loadProvider` 用 `vm.runInThisContext` 在源码前拼接包装函数，偏移与磁盘文件对不上；文件末尾还残留旧 TypeScript 构建留下的 `//# sourceMappingURL=extension.js.map`，v8-to-istanbul 找不到这个 map，c8 便静默丢弃该文件。`loadProvider` 改用 `vm.compileFunction`，按文件 URL 编译未改动的源码（与 Node 加载模块的方式一致），并删除那行注释。Provider 现为 80.2% 行 / 69.5% 函数覆盖，全局行覆盖率 90.02% → 89.81%，仍高于 80% 门槛。
- [x] P2 ManagedOpenOcdSession（`liveWatch.js` 2155 → 1420 行，低于默认上限，`eslint.config.js` 中它的覆盖项已删除；审计列出的四件事——进程、Tcl 传输、读取计划、写事务——都已拆出）
    - [x] 读取计划：每周期预算检查、按地址编译读取批次、8/16/32 位传输形状移到 `src/liveWatchReadPlan.js`，Provider 侧的采样控制器、`samplingSession` 和测试直接引用它。顺带删除只写不读的 `vscode`、`_compiledBatches`、`_variableDeadline` 字段，`ManagedOpenOcdSession` 和 `OpenOcdDebugController` 不再接收 `vscode` 参数，删除 `LiveWatchSession` 别名和没有外部使用者的导出。`liveWatch.js` 2155 → 1941 行。
    - [x] 时钟注入：会话的墙上时间、单调毫秒、样本时间戳和所有定时器改走 `options.clock`（`now`、`monotonicMs`、`sampleNow`、`schedule`、`cancel`，缺省为系统时钟），取代原来的 `now`/`sampleNow` 选项。8 个测试不再替换全局 `Date.now` 或 `process.hrtime.bigint`；`unlimited-sampling` 推进时钟，不再真实等待 1 秒。
    - [x] Tcl 传输：`src/tclTransport.js`（`TclTransport`，会话经 `this.tcl` 持有）承担 socket 挂接、`0x1a` 分帧的 FIFO、单命令超时、1 MiB 失控流保护、no-echo 探测、debug 模式的私有响应文件、拒绝队列、启动期间的命令暂挂和能力探测（失败只丢弃连接、不上报）。连接失败经 `onFailure` 交给会话的 `_abortConnection`，断开和降级的编排仍在会话里。测试用 `session.tcl.attach(socket)` 取代 `session.socket = …; session._setupSocket()`。`scripts/check-openocd-noecho.js` 直接驱动 `TclTransport`，已对打包的 OpenOCD（dummy 适配器）重新跑过。系统时钟移到 `samplingClock.js` 供两者共用。`liveWatch.js` 1941 → 1647 行。
    - [x] OpenOCD 进程：`src/openocdProcess.js`（`OpenOcdProcess`，会话经 `this.server` 持有）承担命令行构造、spawn 与找不到可执行文件的报错、逐行日志、诊断用的日志尾和 Tcl 就绪检测、退出等待，以及停止升级（关闭请求未发出时 kill，每次等待超时后再 kill、SIGKILL）。日志行的含义（探针丢失、轮询失败、错误上报）和退出的唯一上报仍在会话里。第二次 kill 之后的等待原来漏用注入时钟，现在也走 `options.clock`。修正 `samplingWorker` 上报给宿主的 `childPid`（宿主在 Worker 崩溃时据此结束 OpenOCD；没有测试覆盖，是 tsc 发现的），并在 `sampling-isolation` 补上断言。新增 `test/helpers/load-module.js`，两个测试改用它加载被替换了 `child_process` 的模块。`liveWatch.js` 1647 → 1522 行。
    - [x] 写事务：`src/memoryWrite.js`（`MemoryWriter`，会话经 `this.writer` 持有）承担托管调试的写预算校验、按自然宽度只写变量自身字节并回读、32 位读改写回退、`write_memory` 命令回退，以及事务期间暂停运行中的目标并恢复（事务本身的错误优先于恢复失败）。独占仲裁、读取保护和取消时的已写项计数仍在会话的 `writeAndVerify`。`samplingSession` 改为顶层引用 `validateManagedWritePlan`。`liveWatch.js` 1522 → 1420 行。
    - 偏差：计划的完成标准是 `liveWatch.js` 少于 1200 行，实际 1420 行。剩下的主要是读取执行（批量与 scatter 读取、运行时对象读取、读取批次缓存，约 370 行）。它和采样节拍共用每周期的读取保护、目标代际、RAM 段、scatter 能力状态和连接确认，拆出去只能通过回指会话的引用访问这些状态，等于把耦合搬个位置，所以留在会话里。
- [x] P2 测试结构
    - [x] 模块加载器：测试里手写的 4 份“替换部分 `require` 后执行生产模块”的加载器（含 `loadProvider`）统一为 `test/helpers/load-module.js` 的 `loadModule`，按文件 URL 编译，覆盖率能映射回源文件。`test-helper-reuse` 新增按内容检查的场景，防止再出现副本（`flash-skills` 的加载器还要替换 `process` 并取出未导出的 `main`，保留）。
    - [x] 剩余真实等待：
        - `render-webview` 的 `clock` 选项同时接管页面的 `Date.now`。`write-stepping` 用 `FakeClock` 推进滑块的 300 ms 稳定计时，并补上“稳定前不写”的断言。
        - `MemoryAnalysisController` 接受 `clock`（schedule/cancel），`memory-sidebar` 推进链接脚本变更的合并计时，断言一串变更只触发一次刷新。
        - `unlimited-sampling` 的宿主暂停改为推进会话的单调时钟，`hostHoldMs` 由范围断言改为精确等于 300。
        - `sampling-isolation` 的固定等待改为等条件成立。600 ms 的宿主阻塞保留：它就是被测对象，而且 Worker 启动后的前约 300 ms 采样偏慢，缩短后计数会贴近断言下限。
        - 测试里 3 份 `wait`/`waitFor` 副本统一为 `test/helpers/wait.js`，并加入 `test-helper-reuse` 的保留名。`adaptive-sampling` 的 250 ms 保留，速率和 P95 统计需要真实时间窗口。
        - 合计：前四个文件在 4 进程全量运行中从 6.5 s 降到 3.8 s。
    - [x] 慢测试（单独运行的耗时）：
        - `chart-history-capacity` 4.9 s → 1.0 s。两项容量测试按比例缩小，边界关系不变：
            - 首批样本：64 MB 预算配 1000 和 2600 项，与原来 512 MB 配 7800 和 20000 一样，一项一个整块会刚好超出和远超预算。这个前提改为显式断言。
            - 稳定淘汰：5000 条曲线配 6 MB，每条曲线的字节数与 20000 条配 24 MB 相同，同样在第 64 帧进入淘汰压力。`--stress` 仍跑原规模。
        - `openocd-installer` 7.1 s → 3.6 s。默认运行时的那次解压成为每次运行唯一的真实解压：
            - 安装、替换、校验失败和损坏包改用测试中生成的小 tar.gz，它不依赖预置包，因此 macOS 上也会跑。
            - 目标配置加载改用默认运行时的可执行文件。
            - “缓存损坏”场景改为把可执行文件移开再还原，不再删除。
    - [x] 按模块合并：
        - 合并方式：
            - 每个原文件成为合并文件里的一个具名 async 段，经 `helpers/scenario` 依次运行，失败信息带段名。
            - 顶层 `require` 按模块合并后提到文件头。同名但指向不同模块（如 `fs` 与 `fs/promises`），或同一模块用了不同别名的，留在各自段内。
            - 原文件末尾的 `(async () => {…})().catch(…)` 去掉外壳，内容并入所在段。
            - 段内断言逐字保留。
        - `chart-*` 18 → 4：
            - `chart-history-store`：容量、摘要、Worker。
            - `chart-host`：面板迁移与多面板、面板身份、重开恢复、记录、视口传输。
            - `chart-webview`：控件、交互、抖动带、进制、呈现、平滑渲染、视口运算、视口请求、远程历史。
            - 偏差：
                - `chart-remote-history` 只驱动页面、不经过 Provider，归入 `chart-webview` 而不是宿主。
                - `chart-background-icon` 保持独立。它覆盖图标提取、宿主存储与路由、页面绘制三段，共用同一组图像夹具，拆到宿主和页面两个文件会复制夹具；它本身对应一个功能模块，不是修复命名。
        - `dwarf-*` 9 → 3：
            - `dwarf-parse`：DWARF 4/5 形式与伴随文件、跳过局部变量。
            - `dwarf-layout`：复合布局、类型矩阵、深层 C++ 布局、展开句柄。
            - `dwarf-budget`：各类预算、全局预算、部分解析。
            - 偏差：`dwarf-partial` 测的是全局预算耗尽后的部分解析结果，归入预算而不是解析。
        - 分组：
            - 合并文件都在 `integration`。原来属于 `fast` 的 `chart-transport`、`chart-viewport` 和 6 个 `dwarf-*`，并进了同一文件里更慢的测试。
            - `docs/guide/variables/waveform-panels.md`、`docs/design/chart-history.md` 和 `test/perf/parse-bench.js` 中的旧文件名已更新。
        - 覆盖率：合并前后各跑一次 c8，逐个源文件对比，没有任何文件的未覆盖行、分支、函数或语句数增加。V8 合并更少进程时重复的块区间变少，部分文件的分支总数和已覆盖数同步减少 1–9 个，未覆盖数不变。
        - 效果：测试文件减少 20 个。`npm run check` 43 s（合并前 45 s），各测试文件耗时之和 193 s → 170 s。

## P1：MainViewProvider 是上帝对象

**现状**：`src/mainViewProvider.js` 共 7074 行，单个类 6854 行，包含：

- 222 个方法、137 个实例字段、95 个 `require`；构造并持有 22 个 Service。
- 最大的几个方法：`registerCommandHandlers` 455 行，`openLiveWatchPanel` 415 行，构造函数 390 行，`resolveWebviewView` 385 行（侧栏消息 `switch` 有 56 个分支），`_startLiveWatch` 241 行。
- 按方法名归类：Agent 相关 35 个方法、1134 行；调试 31 个、699 行；观察列表 13 个、929 行。

**成因**：`src/services/` 已有 83 个模块，硬件和业务逻辑大多已下沉。但每加一个功能，就在 Provider 上加“一个字段 + 一个方法 + 一个消息分支”来编排。状态和编排仍集中在一处，Service 之间也通过 Provider 互相访问。例如 `agentService.accessState` 由 Provider 直接赋值。

**方案**（每步独立提交，每步后跑 `npm run check` 和 `npm run test:e2e`）：

1. **消息路由表化**：把 `resolveWebviewView` 和 `openLiveWatchPanel` 中的消息分支，改成 `{ [type]: handler }` 映射。映射放在 `src/controllers/sidebarMessages.js` 和 `livePanelMessages.js`，handler 只拿到一个窄上下文对象（所需 Service 加 `post`），不再拿整个 Provider。这一步不改行为，风险最低，可直接切掉约 800 行。
2. **AgentController**：抽出 `_withAgentProbe`、`_agentVariablePlan`、`_agentWritePlan`、`_addAgentWatch` 和访问决策（`_agentAccessDecision` 等），与 `agentService` 合并为 `src/services/agentOperations.js`；`accessState` 改由 Service 自己计算。e2e 依赖的 `_handleAgentCall` 先保留为转发。
3. **WatchController**：`_startLiveWatch`、`_refreshSamplingPlan`、`_onElfChange` 和读取计划合并逻辑，移到 `liveWatchService` 旁边。
4. **调试启动**：`_startManagedDebugServer`、`_prepareGroupedDebugConfiguration`、`prepareExternalDebug` 移到 `debugControlService`，或新建 `debugLaunch` 模块。
5. **组合根**：把 390 行的构造函数改成 `createServices(context)`，返回依赖图；Provider 只负责视图生命周期和事件接线。

**完成标准**：Provider 少于 2000 行；`test/helpers/load-provider.js` 的使用者大多改为直接测试新模块。

## P1：两个 Webview 渲染器重复实现

**现状**：`src/webview/liveWatch/renderer.js` 4586 行，`src/webview/sidebar/renderer.js` 3212 行。

- 按函数名配对，有 37 组平行实现、共约 1270 行，例如 `sbRenderRuntimeTree` 与 `renderRuntimeTreeInto`、`sbRenderLayout` 与 `renderLayoutInto`、`sbRememberPointers` 与 `rememberPointers`、`sbScalarDisplay` 与 `scalarDisplay`。很多对已经出现细微差异（如 `fmtExact` 是 4 行对 19 行）。
- 两者都是全局作用域的经典脚本：顶层函数分别有 183 和 126 个，可变顶层绑定分别有 118 和 72 个。

**成因**：侧栏先实现了复合类型、指针和运行时树显示，波形窗口再复制一份加 `sb` 前缀以避免全局名冲突，之后每次修复都要改两遍。`src/webview/runtime.js`（1614 行）本来就是共享层，但只承载了数据逻辑，没有承载渲染逻辑。

**方案**：

1. **值显示**：把 `scalarDisplay`、`fmtExact`、`watchDisplayInfo`、`fmtDisplayNode` 移入 `runtime.js`，参数化差异（类名、数字进制）。
2. **指针状态**：把 `remember/forget/resetLastPointers`、`pointerPointee`、`pointerSymbol` 改为 `createPointerState({ save })` 工厂，两页各持一个实例，只注入各自的保存函数（`saveUi`/`saveSbUi`）。
3. **树渲染**：`renderLayout`、`renderRuntimeTree`、`renderLeaf`、`nestShell` 移入共享模块，通过一个小适配器（类名表、展开状态存取、消息发送）区分两页。
4. **页面状态**：顺带把可变全局变量收拢进每页一个 `state` 对象，让纯逻辑可以脱离 jsdom 测试。

**回归网**：`pointer-targets`、`pointer-display` 和 `runtime-*` 测试已经用 `for (const sidebar of [true, false])` 同时覆盖两页，每一步都能直接验证。

## P2：ManagedOpenOcdSession 过大

**现状**：`src/liveWatch.js` 2345 行，其中 `ManagedOpenOcdSession` 类 1999 行，混合了进程生命周期、Tcl 传输（FIFO、超时、失控流保护）、读取计划编译和写事务（halt、读改写、回读）四件事。

**方案**：拆成 `OpenOcdProcess`（spawn/shutdown）、`TclTransport`（socket、FIFO、超时、断开语义）、`ReadPlanner`（`compileReadBatches` 等纯函数，已基本独立）和 `WriteTransaction`。拆分时必须保持 `samplingWorker` 路径的时间预算和断开语义；`live-watch-disconnect` 与 `live-watch-integration` 是主要回归测试。

## P2：兼容层缺少退出时间

按“只保 v0.8+ 升级”的决定，以下兼容层保留：

| 位置                                                   | 用途                           |
| ------------------------------------------------------ | ------------------------------ |
| `agentBridge` 的 `legacyPointer`                       | 给旧版 skill 脚本写工作区指针  |
| `probeSelectionStore` 的 `LEGACY_SUCCESS_KEY`          | 给旧版 skill 提供 v2 探针视图  |
| `samplingFrequency` 回退读取 `sampleIntervalMs`        | 旧采样间隔设置                 |
| `emberprobe.maxSamples`（已弃用，`mcu-config` 仍暴露） | 公开设置，值不再生效           |
| `writeAuthorization` 把布尔值 `true` 视为未信任        | fail-closed 安全检查，长期保留 |

**方案**：在 `docs/development/releasing.md` 或代码中维护一张“兼容层 → 计划移除版本”表（例如 1.0）。在 `release-consistency` 测试里，当 `package.json` 版本达到或超过移除版本时报错，让兼容层不能在无人注意时永久留存。`maxSamples` 同时需要从 `mcu-config` skill 的可写键中移除。

## P2：测试按“一次修复一个文件”增长

**现状**：

- 240 个测试文件共 65.5k 行，超过 `src/` 的 61.4k 行。
- 按前缀统计：`chart-*` 18 个（5610 行）、`debug-*` 14 个、`sampling-*` 13 个、`agent-*` 12 个、`openocd-*` 10 个。不少文件名对应的是某次修复，而不是某个模块。

**方案**：

- **新增约定**（建议写入 `AGENTS.md`）：修复或新行为优先在该模块已有测试文件里加 `scenario(...)`；只有新模块才新建测试文件。共享构造器统一放在 `test/helpers/`（`elf-fixture`、`dwarf-tree`、`render-webview`、`chart-history-host`、`fake-clock`）。
- **按模块合并**：
    - `chart-*` 归为三类：历史存储（`chartHistoryStore`/worker）、宿主（host/transport）、Webview。
    - `dwarf-*` 归为三类：解析、布局和类型、预算。
    - 合并时用 c8 的逐文件覆盖确认没有丢失独占覆盖。
- **剩余真实等待**：`sampling-isolation`（约 1.2 s）、`unlimited-sampling`（约 1.35 s）、`write-stepping`（0.4 s）、`memory-sidebar`（0.35 s）。在计时器可注入的地方改用 `FakeClock`。
- **慢但合理的测试**：
    - `openocd-installer`（11 s）真实解压内置包并运行 OpenOCD，可考虑同一次运行中复用解压结果。
    - `chart-history-capacity`（8.5 s）向存储写入数百万个样本，其中 7800 项的规模可以缩小。
    - `chart-history-summary`（6 s）在逐点比对参考实现。

## P3：防止再次堆积的自动化

- **i18n**：两份语言表各 1000 个键。建议加一个测试，静态扫描 `t("…")` 字面量，配合动态前缀白名单，报告未使用的键。本轮的 47 个死键就是这样扫出来的。
- **Webview 顶层函数**：`src/webview/**` 跨文件共享全局作用域，ESLint 只能用 `vars: "local"`，查不出未使用的顶层函数。建议在 CI 中加一个脚本，列出没有任何引用的顶层函数。完成 P1 的模块化之后，这一步可以退回标准 lint。
- **重复构造器**：评审时注意测试中新出现的 `function leb(`、`function u32(` 一类辅助函数，应改为复用 `test/helpers/dwarf-tree.js`。
