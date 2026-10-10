# probe-rs 烧录实现差异审计

修复跟进：以下发现保留修复前基线及复现记录。五项问题已接入软件修复：强制侧栏写后校验和单连接复位、等待自动采样适配器退出、补齐前后门禁、共用下载后的 ELF 刷新/采样恢复、增加阶段和结果未知诊断。F5 Launch 同时默认开启校验。当前行为与无硬件回归范围见 [烧录行为说明](PROBE-RS-FLASH.md)；本报告不构成实板验收。

审计日期：2026-10-10（Asia/Taipei）。代码基线：`e3b28da9fa062c9cfb6c4494db49a8fd7dbbeb2e` 及当前工作区；上游基线：本机 `probe-rs 0.32.0 (48f5e4d)` 和上游 `v0.32.0` 源码。

范围包括侧栏/文件夹菜单下载、F5 Launch/Attach、Agent Flash，以及与 OpenOCD 对应入口的差异。审计阶段没有执行硬件烧录、复位、驱动切换或 HIL，仅新增此报告并保留工作区已有未提交改动；后续修复单独记录在上面的行为说明中。下文源码行号对应修复前的审计基线。

结论：probe-rs 已接入基本 ELF 下载，但侧栏路径尚未达到 OpenOCD 侧栏的校验、连接准备、结果诊断和下载后恢复能力。F5 使用另一条 DAP 路径；不能用 F5 可透传的选项证明侧栏或 Agent 已支持这些功能。

## 实现入口

| 入口                  | OpenOCD                                                                                      | probe-rs                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 侧栏 / 文件夹下载     | `commandHandlers["mcu-vscode.download"]` → `FlashService.download` → 连接预检 → `runOpenOcd` | 同一命令分流到 `_downloadProbeRs` → `downloadWithProbeRs` → `execFile`             |
| F5 Launch             | 原生 DAP → GDB/MI → `DebugImages.download`                                                   | `resolveProbeRsDebugConfiguration` → `ProbeRsDebugAdapter` → `probe-rs dap-server` |
| F5 Attach             | 跳过 `DebugImages.download`                                                                  | 配置器强制 `flashingEnabled: false`                                                |
| Agent 烧录 / 独立校验 | `AgentFlashService`，镜像指纹、快照、授权与探针租约                                          | `AgentFlashService.request` 返回 `BACKEND_UNSUPPORTED`                             |

证据：[下载命令](../src/mainViewProvider.js#L1078)、[probe-rs 侧栏入口](../src/mainViewProvider.js#L720)、[OpenOCD FlashService](../src/services/flashService.js#L11)、[probe-rs CLI 服务](../src/services/probeRsFlashService.js#L44)、[F5 配置器](../src/services/probeRsConfiguration.js#L18)、[GDB 镜像下载](../src/services/debugImages.js#L234)、[Agent 后端限制](../src/services/agentFlashService.js#L30)。

## 需要修复的问题

### 1. P1：侧栏下载没有写后校验

`probeRsArgs("download", ...)` 只追加芯片、探针、速度、协议和镜像路径，没有 `--verify`；成功判定仅要求 download/reset 两个进程没有报错。OpenOCD 侧栏明确执行 `program ... verify reset exit`。

上游 CLI 的写后读回是单独的 `--verify` 开关。当前 probe-rs 成功消息证明工具完成了所请求的流程，不能证明 Flash 内容与快照逐字节一致。建议侧栏默认开启写后校验，并让校验失败阻止复位及成功提示。

证据：[参数构造](../src/services/probeRsFlashService.js#L9)、[下载与复位](../src/services/probeRsFlashService.js#L49)、[OpenOCD 校验命令](../skills/_emberprobe/openocd-flash.js#L5)、[上游 CLI 校验与复位选项](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/util/common_options.rs#L17)。

F5 是独立路径：扩展允许透传 `flashingConfig.verifyAfterFlashing`，但没有把它默认设为 `true`；上游该布尔字段默认值为 `false`。OpenOCD 的 F5 `-target-download` 也不能直接等同于侧栏的显式 `program ... verify`。

证据：[本地 F5 默认值](../src/services/probeRsConfiguration.js#L48)、[上游 FlashingConfig](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/configuration.rs#L294)。

### 2. P2：自动采样转下载没有等待适配器退出

`_downloadProbeRs` 对自动采样会话等待 `stopLiveWatch()` 和 Bridge 的 `state === "none"`，随后立即申请 `download` 租约。会话结束可以早于 dap-server 的 USB 清理与进程退出；此时 `debugServer` 租约仍由适配器持有。

无硬件复现：自动采样会话已结束，模拟适配器仍持有 `debugServer` 租约。下载返回 `PROBE_BUSY`，没有调用该适配器的 `waitForExit()`，没有启动烧录。租约保护仍有效；问题是一次下载请求在正常退出过程中提前失败。

另一个分支对已有 `_liveSession` 先发起停止，再申请下载租约，最后才 `await stopped`。如果采样服务在异步停止完成时释放租约，申请操作会先失败。这个分支可能出现在原生设置切换后端而旧采样连接仍存在时。

建议复用 probe-rs 调试切换中的退出确认机制，等待物理连接关闭后再申请下载租约；超时继续保留原租约，并返回明确的退出未确认错误。

证据：[下载切换顺序](../src/mainViewProvider.js#L723)、[F5 切换中的 waitForExit](../src/mainViewProvider.js#L650)、[stopLiveWatch](../src/mainViewProvider.js#L4615)、[适配器仅在 close 后释放租约](../src/services/probeRsDebugAdapter.js#L131)。

### 3. P2：下载成功后缺少符号刷新和采样恢复

OpenOCD 下载先保存 `resumeSampling`，成功后执行 `_refreshElfBindings()`，清理旧样本、重新绑定变量和布局，再恢复原采样意图。probe-rs 下载只提示成功并释放租约。

自动采样会话在停止时还会把 `_samplingIntent` 置为 `false`。无硬件成功流程确认：停止采样 → 等待会话结束 → 下载 → 成功消息；没有符号刷新，也没有恢复采样。用户必须重新启动观测，面板没有在下载完成时主动清除并刷新旧固件的变量结果。

这里确认的是下载后刷新和恢复缺失；没有把它扩大为“所有后续读写都会使用旧地址”。其他 ELF 身份和变化检查仍存在。

建议把两个后端接入相同的下载完成流程：仅在下载成功、符号刷新成功后按原意图恢复采样；刷新或重连失败单独提示。

证据：[probe-rs 成功处理](../src/mainViewProvider.js#L734)、[OpenOCD 恢复流程](../src/mainViewProvider.js#L1106)、[OpenOCD 下载后的 finally](../src/mainViewProvider.js#L1168)、[刷新与样本失效](../src/mainViewProvider.js#L3311)。

### 4. P2：侧栏下载缺少驱动切换门禁

probe-rs F5 和 OpenOCD 连接准备都会调用 `_assertProbeDriverIdle()`。probe-rs 独立下载没有此检查。驱动切换操作设置 `_probeDriverSwitching`，但不持有 coordinator 租约，所以仅申请 `download` 租约不能覆盖这个状态。

无硬件断言确认：在 `_probeDriverSwitching === true`、没有其他租约的情况下，probe-rs 下载仍调用执行器并提示成功。侧栏按钮禁用可以保护正常点击，但文件夹下载命令直接调用处理器；如果在驱动切换期间通过 VS Code 原生设置改为 probe-rs，服务端没有相应拒绝。

建议在下载入口及异步停止后的执行前调用统一门禁。关于未被 Bridge 跟踪的活动调试会话、关闭中和退出未确认标志，本次也确认独立入口缺少相同的显式检查；已有 coordinator 租约仍会拦截它所覆盖的状态，未据此宣称发生了实机并发访问。

证据：[probe-rs 下载入口](../src/mainViewProvider.js#L720)、[门禁实现](../src/mainViewProvider.js#L1223)、[OpenOCD beforePrepare 绑定](../src/mainViewProvider.js#L301)、[连接准备门禁](../src/services/probeConnectionService.js#L56)、[驱动切换状态](../src/mainViewProvider.js#L5755)、[文件夹命令](../src/extension.js#L24)。

### 5. P2：复位重新连接，部分成功和超时诊断不足

probe-rs 侧栏先运行 download，再运行独立 reset，每个进程默认超时 120 秒。第二步需要重新打开探针。无硬件注入确认：download 成功后 reset 连接失败，调用仍抛出普通错误，界面统一显示“下载失败”，没有结构化的 `programmed`、`verified`、`reset` 阶段结果。

OpenOCD 侧栏在同一连接中编程、校验、复位；失败诊断包含阶段，超时标记 `resultUnknown: true`、`retryable: false`。probe-rs 目前主要保留 Node 错误和输出尾部，没有对应的结果不确定语义。

上游 CLI 已提供 download 的 `--reset`，会在同一个 session 中复位核心 0。建议默认校验后使用此选项，并统一输出阶段及超时诊断。单连接仍不能提供失败回滚；编程中断后的 Flash 状态需要单独验证，不能自动重写。

证据：[两个子进程与超时](../src/services/probeRsFlashService.js#L26)、[普通下载失败消息](../src/mainViewProvider.js#L740)、[OpenOCD 超时诊断](../src/openocdRunner.js#L233)、[上游同会话复位](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/util/cli.rs#L470)。

## 功能接入差异

| 能力                        | OpenOCD 侧栏                    | probe-rs 侧栏                                      | probe-rs F5                                      |
| --------------------------- | ------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| ELF32 小端及无扩展名 ELF    | 共用 `inspectElf`               | 共用 `inspectElf`                                  | 普通文件预检，后续由上游读取                     |
| 64 MiB 上限、哈希、私有快照 | 有                              | 有                                                 | 本地配置器未封装相同保障                         |
| 写后校验                    | 默认显式执行                    | 未传 `--verify`                                    | 可透传 `verifyAfterFlashing`，默认未开启         |
| 写前比对并跳过一致镜像      | 未提供同等入口                  | 未传 `--preverify`                                 | 可透传 `verifyBeforeFlashing`                    |
| 烧录、复位连接              | 同一 OpenOCD 进程               | download/reset 两次连接                            | 由活动 dap-server 管理                           |
| 进度与结果                  | 流式解析、阶段与诊断            | 缓冲输出，成功日志未展示                           | 上游 DAP 进度消息可转发给 VS Code                |
| 连接策略                    | interface/target 脚本及连接预检 | 芯片、探针选择器、速度；入口未传协议或复位连接策略 | 可透传 `wireProtocol`、`connectUnderReset`       |
| 全片擦除 / 保留扇区未写字节 | 无同等独立选项入口              | 未封装 `--chip-erase` / `--restore-unwritten`      | 可透传 `fullChipErase` / `restoreUnwrittenBytes` |
| 成功后符号刷新、采样恢复    | 有                              | 缺少                                               | 调试生命周期独立管理                             |
| Agent 烧录 / 独立校验       | 支持既有授权流水线              | `BACKEND_UNSUPPORTED`                              | 不替代 Agent 授权入口                            |

probe-rs 侧栏的 `probeRsSettings()` 没有返回 `protocol`，虽然 `probeRsArgs()` 支持该字段，当前调用不会传入。`emberprobe.transport` 的描述明确是 OpenOCD 专用设置，因此这是 probe-rs 侧栏连接选项未接入，不能直接判定为 OpenOCD 设置失效的 bug。F5 的 `wireProtocol` 也不会自动应用到侧栏。

证据：[侧栏设置](../src/services/probeRsConfiguration.js#L8)、[协议参数构造](../src/services/probeRsFlashService.js#L17)、[transport 的设置范围](../package.json#L216)。

HEX/BIN 与多镜像需要按入口区分：两个侧栏都只接受共用预检允许的 ELF32 小端文件；OpenOCD F5 通过 `loadFiles` 支持 ELF/HEX/BIN，BIN 要求显式地址。probe-rs 上游 CLI 有格式和基地址选项，但侧栏未封装。F5 虽保留 `formatOptions`，`programBinary` 同时承担调试信息加载，纯 HEX/BIN 路径不能据此视为已完成接入和验收。

此外，扩展配置器会保留多个 `coreConfigs`，但上游 v0.32.0 的 `SessionData::new` 明确要求只配置一个 core；保留数组并不建立多核或多镜像烧录支持。

证据：[OpenOCD 镜像规范](../src/services/debugImages.js#L149)、[本地 coreConfigs 处理](../src/services/probeRsConfiguration.js#L24)、[上游单 core 限制及调试信息读取](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/session_data.rs#L132)。

当前 probe-rs CLI 继承父进程环境，上游选项可受 `PROBE_RS_PROTOCOL`、`PROBE_RS_PROBE`、`PROBE_RS_DRY_RUN`、`PROBE_RS_ALLOW_ERASE_ALL` 等影响。侧栏没有显式展示这些有效选项。后续统一烧录计划时应明确其来源，尤其不能只检查参数数组就宣称特殊擦除权限始终未启用。本次未设置这些环境变量，也没有复现实机效果。

另一个上游源码观察：v0.32.0 的 CLI `attach_probe` 调用 RPC `select_probe`，没有传递 `non_interactive`；多候选分支仍尝试读取 stdin。扩展传入 `--non-interactive`，但多探针场景的快速失败语义仍需针对本机版本验证，不能仅凭参数存在作保证。本次没有连接或枚举多探针来验证这一点。

证据：[继承环境的执行器](../src/services/probeRsFlashService.js#L31)、[上游环境选项](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/util/common_options.rs#L85)、[上游 CLI 选择调用](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/util/cli.rs#L55)。

## 已有保护和验证范围

两个侧栏都共用单文件句柄的有界 ELF 读取、哈希、读前读后状态检查和私有快照；probe-rs 不是完全缺少镜像安全。子进程使用参数数组，烧录期间持有 `download` 租约，正常和失败返回均清理快照。原生 probe-rs 适配器在 `close` 后释放租约，退出未确认时继续持有。Agent Flash 的拒绝分支没有形成绕过授权的直接烧录路径。

十个现有无硬件测试文件通过：

```text
node test/rust-probe-rs.test.js
node test/probe-rs-safety.test.js
node test/probe-rs-debug-adapter.test.js
node test/backend-routing.test.js
node test/flash-safety.test.js
node test/flash-service.test.js
node test/flash-refresh.test.js
node test/flash-skills.test.js
node test/flash-process.test.js
node test/debug-images.test.js
```

Flash 安全测试在 Windows 沙箱内首次受到 `fs.realpath` 的 EPERM 限制，换用工作区临时目录后仍受限；随后在自动审批允许的沙箱外执行并通过。其他涉及临时镜像或子进程的相关验证也使用允许的执行环境。

额外使用临时审计脚本执行真实生产方法，替换 VS Code、镜像预检和子进程为模拟对象，确认参数、成功/复位失败、采样租约退出时序、刷新恢复缺失和驱动切换门禁。临时脚本在审计结束时移除，没有注册为正常测试。真实 probe-rs 仅用于版本、帮助和参数解析检查。

现有正常测试对 probe-rs Flash 的直接覆盖主要是 `rust-probe-rs.test.js` 的参数构造；`probe-rs-safety.test.js` 检查调试准备与读写安全，`flash-refresh.test.js` 覆盖 OpenOCD 恢复。正常测试未找到直接执行 `downloadWithProbeRs` / `_downloadProbeRs` 的场景。现有 HIL 脚本会调用 `_downloadProbeRs`，但不能替代上述失败及并发时序的无硬件覆盖。

证据：[参数测试](../test/rust-probe-rs.test.js#L63)、[OpenOCD 恢复测试](../test/flash-refresh.test.js#L114)、[既有 HIL 下载入口](../test/hil/vscode-probe-rs/suite/index.js#L31)。这些结果不建立新的芯片、平台或实板支持，也不提供同条件烧录性能对比。

建议修复顺序：默认写后校验；统一下载前门禁和进程退出确认；统一下载后的符号刷新与采样恢复；同连接复位及阶段诊断；最后把 probe-rs 执行器接入既有 Agent Flash 镜像、连接身份和 UI 授权流程，并补充专门的无硬件测试。Agent 接入不能只删除 `BACKEND_UNSUPPORTED`。
