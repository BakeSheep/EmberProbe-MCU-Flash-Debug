# RTT 设计

用户行为见 [RTT 日志](../guide/flash-debug.md#rtt-日志)。选型过程见 [2026-11-03 审计](../records/audits/2026-11-03-rtt-audit.md)。

EmberProbe 用 OpenOCD 内建的 `rtt` 命令读取 SEGGER RTT，J-Link 和 CMSIS-DAP 走同一条路径。不支持 SWO/ITM、半主机和 defmt 解码。

## 分层

| 层           | 模块                                                    | 职责                                                        |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------- |
| 控制块与命令 | `src/rttControlBlock.js`                                | 确定 `rtt setup` 的地址和范围，校验并拼接命令，解析通道列表 |
| 目标描述符   | `src/rttTarget.js`                                      | 验证小端 ARM32 控制块，采样环占用，单次 Flags 写入和读回    |
| 会话控制     | `src/rttControl.js`，`ManagedOpenOcdSession.rttControl` | 在独占锁下发送 `rtt` 命令及有界描述符事务                   |
| 编排         | `src/services/rttController.js`                         | 宿主选择、跟随、租约、退避重试、停止顺序                    |
| 终端与日志   | `src/services/rttTerminalService.js`、`rttLogWriter.js` | 伪终端、down 输入、时间戳、日志轮转、侧栏状态               |
| Agent        | `rtt.*` 路由、`rtt_*` MCP 工具、`skills/mcu-rtt`        | 状态、游标读取、启动和停止                                  |

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

每次手动启动冻结通道选择和轮询配置，自动重试、让出后恢复和宿主跟随复用同一快照。默认轮询 10 ms，显式配置 0 选择原有 100 ms；每次完整附着发送 `setup → stop → start → polling_interval → channels`。内置 OpenOCD 在 start 前修改间隔会先注册计时器，随后 start 再注册，故顺序不可交换。stop 也使复用的 started 会话重新采用当前 setup。通道初始化重试只查询列表。

OpenOCD 一次轮询每个通道最多读 1024 B，所以吞吐上限由轮询间隔和单次轮询耗时决定。J-Link V9 上一次轮询约 6 到 8 ms，主要耗在 USB 往返上，提高时钟帮助不大；曾试过在一次轮询内继续读取的补丁，5 ms 预算下没有提升，已移除，见[实测记录](../records/validation/rtt-board-2026-11-06.md)。

## 描述符、占用与模式

`rtt channels` 不返回控制块地址，扫描范围起点也不等于命中地址。因此新描述符功能要求显式地址或 ELF `_SEGGER_RTT` 精确地址；范围扫描仍支持日志，目标占用标为不可用，模式覆盖报 `RTT_EXACT_ADDRESS_REQUIRED`。

`rttTarget` 通过标准 memory 命令读取 24 B header、24 B ARM32 描述符；先确认运行时小端、完整 ID、上下行数量及地址算术，再检查选中通道的 buffer、size、Flags 和偏移。事务复用 `rttControl` 的独占锁和 targetEpoch，至多 4 KiB、24 条命令、250 ms（命令之间检查，单条命令仍受 Tcl RPC 超时约束）。没有嵌套调用 `peripheralTransaction`。

选中通道约每秒采样一次，连续描述符合并读取。`usedBytes = (WrOff - RdOff + size) % size`，可用容量 `size - 1`；偏移会并发变化，因此只报告采样瞬时估计。失败、重置、停止或过期结果不能充当当前占用。遥测任务不重入、不积压；与控制操作共享仲裁，失败不主动停止 TCP 输出。Agent 查询只投影缓存。

`rtt.channels` 支持整数或 `{ index, mode? }`，mode 可为 skip/trim/block，省略时由固件控制。规范化拒绝重复编号和未知字段。覆盖要求用户从 VS Code 启动、当前写连接可验证，启动意图绑定连接、选择的探针/目标、ELF 和控制块地址。先等指定覆盖通道初始化及 TCP 接收连接就绪，再写模式；未初始化有界退避，不能默默跳过覆盖。

Flags 只改低两位，写前复核描述符身份和旧值，单次自然宽度写后读回。未知结果或部分成功报告具体状态，不自动重发或回滚。后续固件修改 Flags 只更新实际模式和不一致状态，不循环强制覆盖；停止 RTT 不恢复原 Flags，遗留 block 可能堵住固件。

## 字节与损失语义

接收总量是该 generation 中的 TCP 原始字节数，速率取累计字节差除以注入的单调时间差，空闲归零、换代重算。UTF-8 cursor、带时间戳的文件大小不用于计算接收速率。

主机缓冲是非消费型历史：`bytes/capacity` 是保留的历史，`start` 是累计历史淘汰，不代表所有消费者实际错过数据。`droppedBytes` 只统计某个有效 cursor 距最早保留位置的缺口。终端从已知 generation 的 cursor 0 开始，数字缺口和换代未知缺口分别写入终端及日志。

标准 RTT 无通用的固件拒收计数，`targetDroppedBytes` 固定为 null，不以低占用或主机 `droppedBytes=0` 声称端到端完整。HIL 用测试固件 ch0 status 的 seq、written/dropped 前后差与有限发送区间核对，完整行必须含换行；63 B 尾片段只算部分记录。固件 maxWriteCycles 是累计最大值，不能相减推导本次阻塞时长。

## 生命周期

状态由 `RttController` 持有：启动后跟随会话变化，宿主切换时重新挂载，探针空闲 1 秒后恢复自有会话，无可跟随时停止。控制块未就绪时按退避重试，有次数上限，ELF 重载期间同样重试。

停止顺序是关 socket、`rtt server stop`、`rtt stop`，确认会话退出后才释放自有租约。

`rtt.autoStart` 是第三种启动来源 `auto`，只借用已持有探针的会话，从不打开自有会话，所以不会抢占探针；和 agent 一样不能承担 mode 写入。每个宿主只尝试一次：失败后报告一次，由用户手动恢复；用户停止时记下当前宿主，同一宿主上不再自动启动。宿主消失后计数清零。自动启动可能遇到停在复位处的目标，所以精确控制块的重试上限放宽到约 5 分钟；扫描保持原有上限，避免长期占用探针。借用调试服务器的启动（不论来源）同样放宽：调试启动停在入口断点时，启动代码已清零控制块而固件尚未初始化 RTT，要等用户继续运行才找得到。

通道数据端口连续重连失败后，控制器重新附着一次（重启 RTT 与端口服务）；同一通道在连上之前再次耗尽，则以 `RTT_CHANNEL_DISCONNECTED` 停止，不保留没有数据的 running 状态。

通道模式写入期间若宿主锁忙，写入尚未发生，按 100 ms 间隔重试直到模式期限。其他失败仍不重试，因为结果可能未知。

每次挂载都用新的 generation 创建缓冲，所以旧游标不会指向新数据，而是返回 `reset: true`，并从最早保留的数据开始。

## 呈现

字节进入 `RttBuffer` 后不再改变，格式只影响终端和文本日志。`text` 按所选编码流式解码并规范行尾；`raw` 只解码；`hex` 按收到的块转储，短块立即显示，偏移取缓冲游标，所以缺口之后地址仍然正确。

虚拟终端标记是 `0xFF` 加 `0123456789ABCDEF` 中的一个字节，只在通道 0 解析。支持的多字节编码都不会产生 0xFF，只有 latin1 可能写出这对字节，所以提供 `rtt.virtualTerminals` 关闭。标记必须在解码前切出，否则多字节解码器会把它们吞进替换字符；块尾的 0xFF 留到下一块。

时间戳是主机接收时间。默认随 50 ms 终端节拍读取，打开时间戳后每个 socket 块到达时就读取，避免节拍再引入误差；关闭时不这样做，高数据率下不产生额外的同步日志写入。同一次 OpenOCD 轮询的数据仍共享时间。RTT 没有标准的时间戳帧，固件时间需要 defmt 这类约定，这里不解析。

原始日志（`rtt.logFile.raw`）在格式化之前写入，保证文件内容与线上字节完全一致，因此不写边界和缺口标记。

## 输入

down 输入经通道的 RTT TCP 端口写入。OpenOCD 接收不代表固件已处理，缓冲中尚有未读数据时可能丢弃输入。只有发送成功的整行输入写入文本日志，缓冲溢出和挂载边界的标记也会写入。raw 输入逐次发送按键，不回显也不写日志，单次写入上限与 `write()` 相同。

`rtt server start` 把一个端口绑定到一个通道号的两个方向，所以 `down` 映射到其他通道号时要多开一个只用于输入的服务器。连上它会让 OpenOCD 也读取同号 up 通道，这部分字节直接丢弃；该 up 通道若有固件输出，不能同时用这种方式查看。服务器总数受 `MAX_SERVER_COMMANDS` 限制，超出时启动失败。输入固定为 UTF-8：编码只作用于固件输出，非 ASCII 命令发往其他编码的固件时不会转换。

## Agent 边界

Agent 只有 `rtt.status`、`rtt.read`、`rtt.start`、`rtt.stop`，没有 down 通道写入：向目标发送输入属于敏感操作，首版不开放，由测试固定。`rtt.read` 只读扩展主机的缓冲，不访问探针，`rtt.status` 只投影缓存的速率与目标遥测，不暴露本地端口。`rtt.start` 与侧栏共享服务路径，但显式携带 agent 来源；存在 mode 覆盖时，在取得探针前以 `RTT_MODE_REQUIRES_UI_START` 拒绝，要求用户从 VS Code 启动。已经由用户启动的 RTT 可继续被 Agent 读取。

文本读取时，末尾不完整的字符留到下一次读取，`nextCursor` 指向它的第一个字节。通道配置了其他编码时按该编码解码，并返回 `textEncoding`。缓冲按字节上限丢弃旧数据（`droppedBytes`），不反压目标；块模式通道靠扩展主机持续读取来避免阻塞。RTT 输出是固件数据，skill 要求 Agent 不把它当作指令。
