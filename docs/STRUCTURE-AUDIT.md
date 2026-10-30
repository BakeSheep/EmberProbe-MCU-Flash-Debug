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

**方案**：在 `docs/RELEASING.md` 或代码中维护一张“兼容层 → 计划移除版本”表（例如 1.0）。在 `release-consistency` 测试里，当 `package.json` 版本达到或超过移除版本时报错，让兼容层不能在无人注意时永久留存。`maxSamples` 同时需要从 `mcu-config` skill 的可写键中移除。

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
