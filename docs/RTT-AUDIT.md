# RTT 日志支持审计（2026-11-03，基于 master `5c982e6`）

目标：全面支持 SEGGER RTT（Real-Time Transfer）日志：查看目标板输出、向 down 通道输入、保存日志，并让 Agent 只读取用日志。本文记录现状、约束、选型和分阶段计划；用户文档见 [RTT.md](RTT.md)。

## 现状：没有 RTT 支持

| 能力                                    | 现状                                                                   | 证据                                              |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| 控制块定位                              | 无。只在变量来源筛选中把 `_SEGGER_RTT` 归为 middleware                 | `src/variableOrigin.js` `originFromName`          |
| OpenOCD `rtt` 命令                      | 无。托管 OpenOCD 只开 Tcl 端口（调试模式另开 GDB 端口），telnet 关闭   | `src/openocdProcess.js` `managedServerLaunch`     |
| J-Link RTT                              | 无。J-Link 只经 OpenOCD `jlink` 驱动，没有 JLinkGDBServer / 19021 端口 | `docs/JLINK-COMPATIBILITY.md`                     |
| 通道、down 输入、终端、日志文件、时间戳 | 无                                                                     | —                                                 |
| Agent / MCP                             | 无 `rtt.*` 路由或工具                                                  | `src/services/agentRoutes.js`、`src/mcp/tools.js` |
| SWO/ITM、半主机                         | 无。外部 GDB server 文档明确不支持 SWO/RTT                             | `docs/EXTERNAL-GDB-SERVER.md`                     |
| 测试                                    | 只有 `variable-origin.test.js` 断言 `_SEGGER_RTT` 的分类               | —                                                 |

内置 OpenOCD 为 `0.12.0+dev-02228`，包含 `rtt setup/start/stop/polling_interval/channellist/server` 命令，RTT TCP 服务启动时输出 `Listening on port N for rtt connections`。

## 架构约束

1. **一个探针只有一个 OpenOCD。** `probeCoordinator` 是严格互斥的（`PROBE_BUSY`），实时观察、调试和 Agent 读取都通过借用当前会话共存。RTT 不能另起 OpenOCD，必须挂在当前持有探针的会话上；无会话时以新的 `rtt` 操作取得租约。
2. **Tcl 连接不能承载 RTT 数据。** `tclTransport` 是单套接字 FIFO，无请求 ID，超时会中止整条连接，并且被采样占用。只通过它发送 `rtt setup/start/server` 等控制命令（在会话的独占锁下，经 `sendChecked`；调试模式下自动走 `_sendSilent`，避免结果广播给 GDB）。数据走 OpenOCD 的 `rtt server` TCP 端口，由扩展主机直连 `127.0.0.1`。
3. **生产环境的会话在 Worker 中。** `isolated: true` 时 `ManagedOpenOcdSession` 是 `samplingWorker` 中的代理；新增控制方法需要会话方法、`SamplingSession` 代理、Worker 白名单和 `OpenOcdDebugController` 透传四处配合（同 `peripheralTransaction`）。数据端口不经 Worker。
4. **多核共享调试组关闭了运行时 Tcl**（`capabilities.runtimeRead === false`），RTT 首版只支持单核目标。
5. **外部 GDB server 模式没有 Tcl 通道**，RTT 不可用，维持文档中的“不支持”。
6. **时间一律来自注入的时钟**，重试、轮询间隔和时间戳都要能被 `FakeClock` 驱动。

## 已确定的选型

| 抉择       | 结论                                                                               | 理由                                                                                      |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 传输       | OpenOCD 内建 `rtt server`                                                          | OpenOCD 自行轮询环形缓冲，双向通道开箱即用，J-Link 与 CMSIS-DAP 一致；不占采样的 Tcl 预算 |
| 共存       | 复用当前会话（调试托管 server 优先，其次实时观察），否则自起轻量会话               | 调试和采样时也能看日志                                                                    |
| 启动       | 手动启动，随后跟随会话切换自动重挂，会话结束即停                                   | 避免未经请求占用探针                                                                      |
| 控制块定位 | 设置的地址 > ELF `_SEGGER_RTT` > 设置的搜索范围 > ELF 可写段 > 链接脚本 RAM 区     | 符号给出精确地址；无符号固件仍可扫描                                                      |
| UI         | 每个 up 通道一个 VS Code Pseudoterminal，回车把整行写入同号 down 通道              | 原生 ANSI 颜色与键盘输入                                                                  |
| 终端选项   | 主机时间戳（默认关）、保存到文件（大小轮转）、多通道                               | 不做 defmt 等二进制解码                                                                   |
| Agent      | 只读 `rtt.status`、`rtt.read`（游标），以及 `rtt.start/stop`；不提供 down 通道写入 | 写目标输入属于敏感操作，首版不开放                                                        |

## 风险与对策

| 风险                                        | 对策                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 复位或固件尚未初始化时找不到控制块          | `rtt start` 失败后按退避重试，有次数上限，并在终端显示状态                                                 |
| 烧录后控制块地址变化                        | 烧录前断开 RTT；烧录后重新从 ELF 解析地址再挂载                                                            |
| 自动扫描范围过大导致每次 `rtt start` 很慢   | 自动扫描上限 1 MiB，手动范围上限 16 MiB，超出报 `RTT_SCAN_RANGE_TOO_LARGE`，提示设置地址                   |
| 块模式（flags=2）通道在主机读得慢时阻塞目标 | 状态中显示通道模式；数据端由扩展主机持续读取，Agent 缓冲按字节上限丢弃旧数据（`droppedBytes`），不反压目标 |
| 调试模式下 Tcl 结果广播到 GDB               | 控制命令经 `sendChecked`，调试模式自动走私有结果文件                                                       |
| 命令注入                                    | 地址、大小、端口、通道号、轮询间隔都在 `src/rttControlBlock.js` 中校验为整数范围后才拼接命令               |
| 会话切换后的旧游标                          | `RttBuffer.reset()` 进入新 generation，旧游标返回 `reset: true` 并从最早保留的数据开始                     |

## 分阶段计划与进度

| 阶段 | 内容                                                                                                                                                    | 状态               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1    | 本审计与 [RTT.md](RTT.md)                                                                                                                               | 完成               |
| 2    | 纯逻辑模块：`src/rttControlBlock.js`（定位、命令、`channellist` 解析）、`src/rttBuffer.js`（游标缓冲）、`src/rttLineFormatter.js`（换行、时间戳、ANSI） | 完成，单元测试覆盖 |
| 3    | 会话层 `rttControl`：会话方法、Worker 代理与白名单、调试控制器透传、多核拒绝                                                                            | 待做               |
| 4    | `src/services/rttController.js`：宿主选择、跟随切换、`rtt` 租约、重试、停止顺序                                                                         | 待做               |
| 5    | 终端 UI、日志文件、命令、设置、侧栏按钮、i18n                                                                                                           | 待做               |
| 6    | Bridge 路由、MCP 工具、`skills/mcu-rtt`                                                                                                                 | 待做               |
| 7    | 文档、CHANGELOG、硬件验证记录（HIL 仅在明确要求时运行）                                                                                                 | 待做               |

## English

EmberProbe had no RTT support before this work. The only reference was the `_SEGGER_RTT` origin classification. RTT will use OpenOCD's built-in `rtt` commands and `rtt server` TCP ports for every probe type, because J-Link also runs through OpenOCD. RTT attaches to whichever OpenOCD session owns the probe and takes its own `rtt` lease only when no session is running. Control commands go over the session's Tcl connection under its exclusive lock. Data is read from the RTT TCP port by the extension host, never through the Tcl FIFO. Each up channel gets a VS Code pseudoterminal, with optional host timestamps, a log file and down-channel line input. Agents get read-only cursor reads plus start and stop. Stage 2 (pure location, command and formatting modules) is complete; stages 3–7 are pending.
