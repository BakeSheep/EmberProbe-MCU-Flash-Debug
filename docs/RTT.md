# RTT 日志（开发中）

> 状态：控制块定位、会话编排、终端、日志文件、命令和侧栏已完成；Agent 接口尚未提供。尚未经过真实硬件验证。设计与进度见 [RTT-AUDIT.md](RTT-AUDIT.md)。

EmberProbe 通过 OpenOCD 内建的 RTT 支持读取 SEGGER RTT 输出，J-Link 和 CMSIS-DAP 用法相同。固件需要集成 SEGGER RTT（`SEGGER_RTT.c`），例如用 `SEGGER_RTT_printf(0, ...)` 或把 `printf` 重定向到通道 0。

## 控制块定位

按以下顺序确定 `rtt setup` 的地址和范围：

1. 设置 `emberprobe.rtt.controlBlockAddress`（如 `0x24000000`）：直接使用该地址。
2. 当前 ELF 中的 `_SEGGER_RTT` 符号：使用其精确地址和大小（大小不足 72 字节时按 72 字节）。
3. 设置 `emberprobe.rtt.searchRange`（`{ "address": "0x20000000", "size": "0x20000" }`）：在该范围内搜索 `"SEGGER RTT"` 标识，最大 16 MiB。
4. ELF 中可写的已分配段：间隔不超过 64 KiB 的段合并为一个区间，先搜含 `.bss` 的区间，其余按大小依次搜索，控制块放在独立 RAM 段时也能找到。
5. 链接脚本中的第一个 RAM 区。

第 4、5 步自动扫描最多 1 MiB：首个区间超出时报 `RTT_SCAN_RANGE_TOO_LARGE`，需要设置地址或搜索范围；第 4 步其余区间超出总量时不搜索。范围按 32 KiB 分片搜索，每片之间释放会话，所以实时观察和调试可以继续；适配器速度很低时建议直接设置地址。配置了地址时不需要 ELF；ELF 正在重新加载时 RTT 会等待后重试。符号名区分大小写；ELF 中有多个 `_SEGGER_RTT` 时报 `RTT_CONTROL_BLOCK_AMBIGUOUS`。

## 显示

- 每个 up 通道一个终端，LF/CRLF 统一为 CRLF，单独的 CR 保留（进度行覆盖），跨数据块的 UTF-8 字符会被正确拼接，ANSI 颜色原样显示。
- 可选主机时间戳 `[HH:MM:SS.mmm]`，在一行的第一个字节到达时记录。
- 保存到文件时可去除 ANSI 序列。

## 通道模式

`rtt channels` 的 flags 对应 SEGGER 模式：0 = skip（缓冲满丢弃）、1 = trim（截断）、2 = block（目标等待主机读取）。block 模式在主机未读取时会让目标阻塞，调试暂停时尤其要注意。未配置（大小为 0）的通道不会列出，其余通道保留固件中的通道号。

## 启动与终端

在侧栏「RTT 日志」卡片中点击「启动」，或执行 `mcu-vscode.startRtt`（EmberProbe: 启动 RTT 日志）。默认读取 up 通道 0；通过 `emberprobe.rtt.channels` 选择其他通道，例如 `[0, 2]`，最多 16 个。所选通道固件暂未配置时继续重试；只缺其中一部分时照常启动，并提示缺少的通道。每个选中的已配置 up 通道会打开一个 `EmberProbe RTT #N <name>` 终端，保留 ANSI 颜色并将换行归一为 CRLF。

- `mcu-vscode.stopRtt` 停止 RTT 并释放自有会话；终端保留已有输出和结束原因，下次启动继续使用。`mcu-vscode.showRttTerminals` 显示或重新打开终端。运行中关闭终端不会停止 RTT 或文件记录。
- 启动失败、后台重试耗尽和连接中断都显示在侧栏 RTT 卡片的提示框中（卡片折叠时自动展开），失败原因同时写入终端最后一行。
- 在终端输入一行并回车，将发送到同号 down 通道；退格可编辑。每行最多 1023 个 UTF-8 字节（加换行共 1024 字节），且含换行不能超过 down 缓冲容量（大小减 1），超出时整行不发送。没有 down 缓冲、超长和发送失败的提示都显示在该终端中，不写入日志；只有发送成功的输入才写入日志。OpenOCD 接收输入不代表固件已处理，缓冲中尚有未读数据时仍可能丢弃输入。
- `mcu-vscode.rttToggleTimestamps` 或 `emberprobe.rtt.timestamps` 切换主机时间戳，立即生效。
- `mcu-vscode.rttSaveLog` 选择已有目录并开始持续保存；再次执行停止保存。也可设置 `emberprobe.rtt.logFile.enabled/directory`。空目录使用工作区根目录，相对路径从该根目录解析；无工作区时指定绝对路径。
- 单通道记录为 `rtt.log`，多通道为 `rtt-chN.log`。`emberprobe.rtt.logFile.maxBytes` 默认 8 MiB（最小 4 字节），写满后轮转为 `.1`，仅保留一个备份；大块输出会拆分，保留 UTF-8 字符边界。已有文件继续追加。
- `emberprobe.rtt.logFile.stripAnsi` 默认开启，日志移除 ANSI 转义；关闭可保留原始转义。日志写入失败会提示并停止该文件的记录，终端继续输出；修改日志设置或重新启动 RTT 后再次尝试。已启用保存但无法确定目录（无工作区且路径非绝对）时，卡片和提示框都会说明。

RTT 手动启动后跟随会话变化，在烧录等操作期间暂停并清除未发送的输入。重新挂载时标记输出边界；缓冲溢出时显示数据丢失提示，这两种标记也写入日志。地址、搜索范围、通道和 OpenOCD 轮询间隔的修改需停止并重新启动 RTT；时间戳和日志设置立即生效。软件测试使用假会话、TCP 和注入时钟，不代表真实板卡验证。

## English

EmberProbe reads SEGGER RTT output through OpenOCD's built-in RTT support. J-Link and CMSIS-DAP probes work the same way. The control block address is chosen in this order:

1. `emberprobe.rtt.controlBlockAddress`
2. the ELF `_SEGGER_RTT` symbol
3. `emberprobe.rtt.searchRange` (up to 16 MiB)
4. the writable ELF section spans: the one around `.bss` first, then the others by size, so a block in its own RAM section is found
5. the first linker RAM region

Automatic scans (steps 4 and 5) are capped at 1 MiB: a first span over the cap reports `RTT_SCAN_RANGE_TOO_LARGE`, and later spans over it are skipped. Ranges are searched in 32 KiB slices, releasing the session between them; on a very slow adapter, set the address. A configured address needs no ELF, and RTT retries while the ELF reloads. Channels keep their firmware numbers, and unconfigured channels are not listed. Each up channel will get its own terminal, with CRLF normalization, UTF-8 joining, ANSI pass-through and optional host timestamps. Commands and terminals are implemented; Agent access is still in development and hardware validation is pending; see [RTT-AUDIT.md](RTT-AUDIT.md).

Start RTT from the sidebar card or `mcu-vscode.startRtt`; stop with `mcu-vscode.stopRtt`. Select up to 16 up channels with `emberprobe.rtt.channels` (default `[0]`). RTT keeps retrying while the firmware has configured none of them, and starts with a warning when only some are missing. Each configured selected channel has its own terminal; Enter sends a line to the matching down channel. A line is capped at 1023 UTF-8 bytes plus LF and must fit the down buffer (its size minus one); a longer line is not sent. Input problems are shown in that terminal and stay out of the log, which records only input that was sent. Closing a running terminal keeps capture running; `mcu-vscode.showRttTerminals` reopens it. After a stop the terminals stay readable with the reason as their last line and the next start reuses them. Start failures, an exhausted background retry and lost connections appear in the RTT card's notice box, expanding the card if needed. Input delivery to firmware is not acknowledged, and a down buffer still holding unread data may discard input.

Use `mcu-vscode.rttToggleTimestamps` for host timestamps and `mcu-vscode.rttSaveLog` to choose an existing log directory or stop saving. The corresponding settings are `emberprobe.rtt.timestamps` and `emberprobe.rtt.logFile.enabled/directory/maxBytes/stripAnsi`. Relative directories resolve against the workspace; an empty directory uses its root. Logs append to `rtt.log` or `rtt-chN.log` for multiple channels, rotate at 8 MiB by default, and retain one `.1` backup. Rotation preserves UTF-8 character boundaries. ANSI escapes are removed by default. A log file that fails stays off until the log settings change or RTT restarts; the terminal keeps running. Saving with no resolvable directory is called out in the card. Timestamp and logging changes apply live; other RTT configuration changes require a restart. Session changes clear unfinished input, and attachment boundaries and data gaps are marked in both the terminal and the log. No hardware validation has been performed.
