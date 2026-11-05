# RTT 设计

用户行为见 [RTT 日志](../guide/flash-debug.md#rtt-日志)。选型过程见 [2026-11-03 审计](../records/audits/2026-11-03-rtt-audit.md)。

EmberProbe 用 OpenOCD 内建的 `rtt` 命令读取 SEGGER RTT，J-Link 和 CMSIS-DAP 走同一条路径。不支持 SWO/ITM、半主机和 defmt 解码。

## 分层

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 控制块与命令 | `src/rttControlBlock.js` | 确定 `rtt setup` 的地址和范围，校验并拼接命令，解析通道列表 |
| 会话控制 | `src/rttControl.js`，`ManagedOpenOcdSession.rttControl` | 在独占锁下发送 `rtt` 命令 |
| 编排 | `src/services/rttController.js` | 宿主选择、跟随、租约、退避重试、停止顺序 |
| 终端与日志 | `src/services/rttTerminalService.js`、`rttLogWriter.js` | 伪终端、down 输入、时间戳、日志轮转、侧栏状态 |
| Agent | `rtt.*` 路由、`rtt_*` MCP 工具、`skills/mcu-rtt` | 状态、游标读取、启动和停止 |

## 不变量

1. **一个探针只有一个 OpenOCD。** RTT 挂在当前持有探针的会话上：调试托管 server 优先，其次实时观察，都没有时以 `rtt` 操作取得租约，起一个自有会话。
2. **自有会话不对外共享。** Agent 读取、Agent 烧录预检和芯片信息会让它先退出，结束后恢复。后台目标扫描不抢占，遇到 `rtt` 租约时按探针繁忙处理。烧录前 RTT 断开，烧录后重新解析 ELF 地址。
3. **Tcl 连接不承载 RTT 数据。** `tclTransport` 是单套接字 FIFO，超时会中止整条连接。它只发控制命令，调试模式下经 `sendChecked` 走私有结果文件，不广播给 GDB。数据走 `rtt server` 的 TCP 端口，由扩展主机直连 `127.0.0.1`，不经过采样 Worker。
4. **`rttControl` 需要四处配合。** 会话方法、`SamplingSession` 代理、Worker 白名单和 `OpenOcdDebugController` 透传，与 `peripheralTransaction` 相同。
5. **只支持单核。** 多核共享调试组关闭了运行时 Tcl（`capabilities.runtimeRead === false`），返回 `RTT_MULTICORE_UNSUPPORTED`。外部 GDB 模式没有 Tcl 通道，不可用。
6. **时间来自注入的时钟。** 重试、结算间隔和时间戳都由 `FakeClock` 驱动。

## 控制块定位

优先级为设置的地址、ELF `_SEGGER_RTT`、设置的搜索范围、ELF 可写段、链接脚本第一个 RAM 区。

`rtt start` 只搜索一次，未命中时 Tcl 结果为空，所以 EmberProbe 自行把这种情况报告为未找到控制块。搜索卡住导致 Tcl 超时则报 `RTT_SCAN_TIMEOUT`，不再显示采样连接重置。搜索会阻塞 Tcl，而超时会重置借用的会话，所以范围按 32 KiB 分片（重叠 16 字节）逐段 `rtt start`，片间释放会话。自动上限 1 MiB，手动上限 16 MiB，超出报 `RTT_SCAN_RANGE_TOO_LARGE`。

通道列表用 `rtt channels`，不用 `rtt channellist`：OpenOCD 跳过 size 为 0 的通道，只有前者带真实通道号。

VS Code 对没有默认值的整数设置返回 0，所以每个 RTT 设置都写明默认值，`pollingIntervalMs` 用 0 表示不发送轮询命令。

## 生命周期

状态由 `RttController` 持有：手动启动后跟随会话变化，宿主切换时重新挂载，探针空闲 1 秒后恢复自有会话，无可跟随时停止。控制块未就绪时按退避重试，有次数上限，ELF 重载期间同样重试。

停止顺序是关 socket、`rtt server stop`、`rtt stop`，确认会话退出后才释放自有租约。

每次挂载都用新的 generation 创建缓冲，所以旧游标不会指向新数据，而是返回 `reset: true`，并从最早保留的数据开始。

## 输入

down 输入经同号通道的 RTT TCP 端口写入，整行发送。OpenOCD 接收不代表固件已处理，缓冲中尚有未读数据时可能丢弃输入。只有发送成功的输入写入日志，缓冲溢出和挂载边界的标记也会写入。

## Agent 边界

Agent 只有 `rtt.status`、`rtt.read`、`rtt.start`、`rtt.stop`，没有 down 通道写入：向目标发送输入属于敏感操作，首版不开放，由测试固定。`rtt.read` 只读扩展主机的缓冲，不访问探针，`rtt.status` 不暴露本地端口。`rtt.start` 与侧栏走同一路径，终端和卡片保持一致，并把真实错误返回给 Agent。

UTF-8 模式下，末尾不完整的字符留到下一次读取，`nextCursor` 指向它的第一个字节。缓冲按字节上限丢弃旧数据（`droppedBytes`），不反压目标；块模式通道靠扩展主机持续读取来避免阻塞。RTT 输出是固件数据，skill 要求 Agent 不把它当作指令。
