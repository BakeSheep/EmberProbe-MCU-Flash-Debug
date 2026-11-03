# RTT 日志（开发中）

> 状态：控制块定位、命令和格式化模块已完成；启动命令、终端和 Agent 接口尚未提供。设计与进度见 [RTT-AUDIT.md](RTT-AUDIT.md)。

EmberProbe 通过 OpenOCD 内建的 RTT 支持读取 SEGGER RTT 输出，J-Link 和 CMSIS-DAP 用法相同。固件需要集成 SEGGER RTT（`SEGGER_RTT.c`），例如用 `SEGGER_RTT_printf(0, ...)` 或把 `printf` 重定向到通道 0。

## 控制块定位

按以下顺序确定 `rtt setup` 的地址和范围：

1. 设置 `emberprobe.rtt.controlBlockAddress`（如 `0x24000000`）：直接使用该地址。
2. 当前 ELF 中的 `_SEGGER_RTT` 符号：使用其精确地址和大小（大小不足 72 字节时按 72 字节）。
3. 设置 `emberprobe.rtt.searchRange`（`{ "address": "0x20000000", "size": "0x20000" }`）：在该范围内搜索 `"SEGGER RTT"` 标识，最大 16 MiB。
4. ELF 中可写的已分配段：取包含 `.bss` 的连续区间（间隔不超过 64 KiB 的段合并），否则取最大的区间。
5. 链接脚本中的第一个 RAM 区。

第 4、5 步自动扫描最多 1 MiB，超出时报 `RTT_SCAN_RANGE_TOO_LARGE`，需要设置地址或搜索范围。符号名区分大小写；ELF 中有多个 `_SEGGER_RTT` 时报 `RTT_CONTROL_BLOCK_AMBIGUOUS`。

## 显示

- 每个 up 通道一个终端，LF/CRLF 统一为 CRLF，单独的 CR 保留（进度行覆盖），跨数据块的 UTF-8 字符会被正确拼接，ANSI 颜色原样显示。
- 可选主机时间戳 `[HH:MM:SS.mmm]`，在一行的第一个字节到达时记录。
- 保存到文件时可去除 ANSI 序列。

## 通道模式

`rtt channellist` 的 flags 对应 SEGGER 模式：0 = skip（缓冲满丢弃）、1 = trim（截断）、2 = block（目标等待主机读取）。block 模式在主机未读取时会让目标阻塞，调试暂停时尤其要注意。

## English

EmberProbe reads SEGGER RTT output through OpenOCD's built-in RTT support. J-Link and CMSIS-DAP probes work the same way. The control block address is chosen in this order:

1. `emberprobe.rtt.controlBlockAddress`
2. the ELF `_SEGGER_RTT` symbol
3. `emberprobe.rtt.searchRange` (up to 16 MiB)
4. the writable ELF section span around `.bss`
5. the first linker RAM region

Automatic scans (steps 4 and 5) are capped at 1 MiB. Each up channel will get its own terminal, with CRLF normalization, UTF-8 joining, ANSI pass-through and optional host timestamps. Commands, the terminal and Agent access are still in development; see [RTT-AUDIT.md](RTT-AUDIT.md).
