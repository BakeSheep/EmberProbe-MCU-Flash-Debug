# J-Link

[English](jlink.en.md)

EmberProbe 通过 OpenOCD 使用 J-Link，这要求 J-Link 在 Windows 上使用 WinUSB 驱动。侧栏可以直接切换，也可以随时切回 SEGGER 驱动。Linux 使用 udev 权限，macOS 没有驱动步骤。

## 连接

1. 在“选择调试器”中选 `jlink.cfg`。
2. 在“已连接调试器”中确认设备，选择规则见[探针连接](probe-connections.md)。
3. 协议和速度默认自动。需要手动指定时使用以下设置：

| 设置 | 含义 |
| --- | --- |
| `emberprobe.transport` | 默认 `auto`，可改为 `swd` 或 `jtag` |
| `emberprobe.adapterSpeedKhz` | 整数 kHz。`0` 使用脚本默认速度；非零值作为速度上限和烧录时钟 |
| `emberprobe.samplingAdapterSpeedKhz` | 独立采样的时钟，`0` 沿用上一项。修改后采样会重新连接 |

已知的 Cortex-M 目标默认使用 SWD。EmberProbe 不会自动降速或切换协议重试。

## 切换到 WinUSB（Windows x64）

Windows 上使用 SEGGER 驱动的 J-Link 不能读取、采样、调试或下载。

1. 在“已连接调试器”中找到这台 J-Link 的卡片，把驱动下拉改为 **WinUSB**，不需要先选中它。
2. 同意管理员授权。发布包中的驱动工具未签名，Windows 可能提示未知发布者，也可能被本机策略阻止。
3. 下拉框结束加载后重试原操作。

切换前原驱动会被备份。下拉改回 **SEGGER** 即可恢复。**切换到 WinUSB 后，Ozone 等 SEGGER 工具可能无法使用这台 J-Link，需要时切回。**

操作被驱动阻止时，右下角也会出现警告：

- **切换到 WinUSB**：切换被阻止的那台 J-Link，完成后手动重试。
- **忽略**：当前工作区不再提醒，但操作仍被阻止。

## 手动更换驱动

卡片显示“驱动需手动处理”时，说明这台 J-Link 无法通过自动校验，比如 USB 型号不在已验证列表中。悬停可看原因，接口详情写在“EmberProbe 芯片信息”输出面板。此时用 Zadig 等工具手动更换驱动。

## 硬件差异

“V9 JLinkOB”这类网购名称不代表真实硬件。WinUSB 支持取决于实际的 OB 型号和固件。排查时应记录固件、硬件字符串、序列号和各 USB 接口的驱动。

## 常见问题

**`Failed to open device`**：可能是探针被占用，也可能是驱动不兼容，单看这一句无法判断。先关闭 Ozone 等占用探针的程序，再看驱动。OpenOCD 和 Ozone 通常不能同时使用同一调试接口。

**`TARGET_NOT_CONNECTED` 或 `cannot read IDR`**：USB 已正常，问题在目标板的 SWD 连接。检查接线、供电和复位引脚。

**读不到参考电压**：OB 探针可能不提供电压测量，这不代表目标没上电。

**Linux 上 CMSIS-DAP 崩溃（`buffer overflow detected`）**：部分系统 OpenOCD 0.12.0 有此缺陷。EmberProbe 在 Linux x64 内置了修复后的 OpenOCD，把 `emberprobe.openocdPath` 保持默认即可。不要通过删除序列号绕过，那样会失去探针选择。

**错误信息**：侧栏诊断可展开和复制，提交问题时请附上完整内容。

## 相关文档

- [探针连接](probe-connections.md)
- [探针选择与连接设计](../../design/probe-selection.md)
