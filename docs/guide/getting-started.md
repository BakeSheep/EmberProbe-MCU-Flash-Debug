# 开始使用

安装工具链、连接探针、配置 OpenOCD 目标。

## 调试工具链

调试需要 ARM GDB、objdump 和 nm。EmberProbe 直接使用本机已有的工具链，不需要另外安装一份。如果已经装过 STM32CubeCLT、STM32CubeIDE 或 ST bundles，通常无需任何配置。

### 查找顺序

点击调试时按以下顺序查找，三个工具都存在才会采用：

1. `launch.json` 中的工具路径，以及 `emberprobe.gdbPath`、`emberprobe.armToolchainPath`、`emberprobe.objdumpPath` 设置。
2. 之前在目录选择框里选定的工具链目录。
3. 系统 PATH。VS Code 启动后才安装的工具也能找到。
4. ST 工具的常见安装位置：先查 ST bundles，再查 CubeCLT 和 CubeIDE。
5. 都没有时提示选择目录，选 `bin` 或包含 `bin` 的目录都可以。

### 手动指定

工具链装在非标准位置时，直接配置 bin 目录：

```json
{
  "emberprobe.armToolchainPath": "C:/ST/STM32CubeCLT_1.18.0/GNU-tools-for-STM32/bin"
}
```

GDB 和 binutils 分开安装时，同时设置 `emberprobe.gdbPath` 和 `emberprobe.armToolchainPath`。工具前缀默认是 `arm-none-eabi`，其他前缀用 `emberprobe.armToolchainPrefix` 设置。

### 自动查找的位置

| 系统 | ST bundles | CubeCLT、CubeIDE |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\stm32cube\bundles` | `C:\ST`，以及 Program Files、Program Files (x86)、LOCALAPPDATA 下的 `STMicroelectronics`、`ST` |
| Linux | `~/.local/share/stm32cube/bundles`（遵循 `XDG_DATA_HOME`） | `/opt/st`、`/opt/ST`、`/opt`、`/usr/local/STMicroelectronics`、`~/ST` |
| macOS | `~/Library/Application Support/stm32cube/bundles` | `/Applications/STMicroelectronics`、`/Applications`、`~/Applications` |

同一工具有多个版本时优先用最新版本。

### 限制

- 查找只读取目录，不运行 ST 命令，不下载工具，也不修改设置。
- 自动找到的路径不保存，ST 工具更新后会重新发现；手动选定的目录会被记住。
- 使用本机 GDB 不会启动 ST 的调试服务器。EmberProbe 仍通过 OpenOCD 或显式配置的外部服务器连接。

### 常见问题

**装了工具链仍提示找不到**：确认三个工具都在同一目录且可执行。安装位置太深或不标准时用 `emberprobe.armToolchainPath` 指定。

**用错了版本**：设置 `emberprobe.armToolchainPath` 固定版本，设置优先于自动查找。

## 探针连接

插上探针、选好调试器脚本和目标脚本即可使用。只连一台探针时不需要做任何选择；多台时在侧栏点选。J-Link 的驱动问题见 [J-Link](#j-link)。

### 选择探针

侧栏“选择调试器”下方的“已连接调试器”一行列出所有连接的探针，与当前脚本无关，新插入的设备会自动出现。

- **对勾**：下一次操作将使用的设备。悬停可看原因，比如已选择、唯一设备或按目标芯片选择。
- **点击设备**：保存为当前工作区的探针。选择不同类型的设备时，调试器脚本会自动改为该类型的默认脚本。
- **刷新按钮**：立即检测，并读取每台探针所连的芯片，在序列号后显示内核型号（如 `Cortex-M4`）。读取不暂停、不复位、不写入目标。
- **未连接**：已保存的设备被拔出时显示此状态，不会改用其他设备。
- **不可选**：同类型多台且没有可靠序列号的设备无法区分，会列出原因。

从界面发起的操作无法确定探针时，这个列表会自动展开，不会弹出选择框。

### 选择优先级

1. 显式指定的序列号（独立烧录脚本的 `--probe-serial`）。
2. 调试器脚本中写明的序列号。
3. 在侧栏点选的探针。
4. 当前唯一的设备。
5. 同类型多台时，按目标芯片自动区分。

点选的探针按工作区保存在本机，不写入设置文件。

### 按目标芯片自动区分

没有点选探针时，EmberProbe 跟随目标芯片而不是某台探针：每次操作开始时读取芯片标识，与工作区记录的芯片比较。

- 芯片不一致时操作在开始前停止，侧栏显示两颗芯片和“改用当前芯片”。确实换了板子时点击它即可。
- 多台同类型探针时，使用连着已记录芯片的那台。
- 校验不暂停、不复位、不写入目标。
- 点选探针后按所选设备使用，不再校验。

### 支持的探针

| 探针 | 说明 |
| --- | --- |
| J-Link | 见 [J-Link](#j-link) |
| CMSIS-DAP、ST-Link、XDS110、Nu-Link、TI-ICDI | 多台时按序列号区分 |
| FTDI、FT232R、VSLLINK | 由调试器脚本决定 USB ID，FTDI 须在脚本中配置 VID/PID |
| KitProg | 无法按序列号区分，同时只能连接一台 |
| 其他 OpenOCD 适配器 | 直接交给 OpenOCD 处理 |

### 网络探针

CMSIS-DAP TCP 和 ST-Link TCP 在调试器脚本中配置，插件没有单独的设置面板。

CMSIS-DAP TCP 必须明确选择后端和主机，默认端口 4441：

```tcl
source [find interface/cmsis-dap.cfg]
cmsis-dap backend tcp
cmsis-dap tcp host probe.example
cmsis-dap tcp port 4441
```

ST-Link TCP 连接本机的 ST-Link server，默认 `127.0.0.1:7184`，可用 `st-link backend tcp 7185` 修改端口；HLA 脚本对应 `hla stlink_backend tcp 7185`。

### 没有序列号的探针

没有可靠序列号的探针可以检查和读取。多台并存时断开其他设备，或在调试器脚本中写明真实序列号。

系统无法确认这类探针的连接身份时，固件下载、下载固件的调试启动、暂停、复位和内存写入会被拒绝，配置准确的 USB 序列号后即可使用。不下载固件的 attach 不受影响。

Windows 会把序列号中的空格显示为 `_`，例如真实序列号 `ATK 20190528` 显示为 `ATK_20190528`。在脚本中写序列号时要写真实值。

### 常见问题

| 提示 | 含义与处理 |
| --- | --- |
| `PROBE_SELECTION_REQUIRED` | 有多台探针且无法自动确定，在侧栏列表中点选 |
| `PROBE_TARGET_MISMATCH` | 连接的芯片与记录不同，确认板子后点击“改用当前芯片” |
| `PROBE_IDENTITY_UNVERIFIED` | 无法确认探针身份，在调试器脚本中写明真实序列号 |
| `PROBE_BACKEND_AMBIGUOUS` | 配置了 TCP 主机但后端仍是 `auto`，在脚本中写 `cmsis-dap backend tcp` |
| `PROBE_DRIVER_UNSUPPORTED` | Windows 上的 J-Link 用了 SEGGER 驱动，见 [J-Link](#j-link) |

## J-Link

EmberProbe 通过 OpenOCD 使用 J-Link，这要求 J-Link 在 Windows 上使用 WinUSB 驱动。侧栏可以直接切换，也可以随时切回 SEGGER 驱动。Linux 使用 udev 权限，macOS 没有驱动步骤。

### 连接

1. 在“选择调试器”中选 `jlink.cfg`。
2. 在“已连接调试器”中确认设备，选择规则见[探针连接](#探针连接)。
3. 协议和速度默认自动。需要手动指定时使用以下设置：

| 设置 | 含义 |
| --- | --- |
| `emberprobe.transport` | 默认 `auto`，可改为 `swd` 或 `jtag` |
| `emberprobe.adapterSpeedKhz` | 整数 kHz。`0` 使用脚本默认速度；非零值作为速度上限和烧录时钟 |
| `emberprobe.samplingAdapterSpeedKhz` | 独立采样的时钟，`0` 沿用上一项。修改后采样会重新连接 |

已知的 Cortex-M 目标默认使用 SWD。EmberProbe 不会自动降速或切换协议重试。

### 切换到 WinUSB（Windows x64）

Windows 上使用 SEGGER 驱动的 J-Link 不能读取、采样、调试或下载。

1. 在“已连接调试器”中找到这台 J-Link 的卡片，把驱动下拉改为 **WinUSB**，不需要先选中它。
2. 同意管理员授权。发布包中的驱动工具未签名，Windows 可能提示未知发布者，也可能被本机策略阻止。
3. 下拉框结束加载后重试原操作。

切换前原驱动会被备份。下拉改回 **SEGGER** 即可恢复。**切换到 WinUSB 后，Ozone 等 SEGGER 工具可能无法使用这台 J-Link，需要时切回。**

操作被驱动阻止时，右下角也会出现警告：

- **切换到 WinUSB**：切换被阻止的那台 J-Link，完成后手动重试。
- **忽略**：当前工作区不再提醒，但操作仍被阻止。

### 手动更换驱动

卡片显示“驱动需手动处理”时，说明这台 J-Link 无法通过自动校验，比如 USB 型号不在已验证列表中。悬停可看原因，接口详情写在“EmberProbe 芯片信息”输出面板。此时用 Zadig 等工具手动更换驱动。

### 硬件差异

“V9 JLinkOB”这类网购名称不代表真实硬件。WinUSB 支持取决于实际的 OB 型号和固件。排查时应记录固件、硬件字符串、序列号和各 USB 接口的驱动。

### 常见问题

**`Failed to open device`**：可能是探针被占用，也可能是驱动不兼容，单看这一句无法判断。先关闭 Ozone 等占用探针的程序，再看驱动。OpenOCD 和 Ozone 通常不能同时使用同一调试接口。

**`TARGET_NOT_CONNECTED` 或 `cannot read IDR`**：USB 已正常，问题在目标板的 SWD 连接。检查接线、供电和复位引脚。

**读不到参考电压**：OB 探针可能不提供电压测量，这不代表目标没上电。

**Linux 上 CMSIS-DAP 崩溃（`buffer overflow detected`）**：部分系统 OpenOCD 0.12.0 有此缺陷。EmberProbe 在 Linux x64 内置了修复后的 OpenOCD，把 `emberprobe.openocdPath` 保持默认即可。不要通过删除序列号绕过，那样会失去探针选择。

**错误信息**：侧栏诊断可展开和复制，提交问题时请附上完整内容。

## OpenOCD 与目标配置

EmberProbe 在 Windows x64 和 Linux x64 上内置 OpenOCD，`emberprobe.openocdPath` 保持默认即可，无需单独安装。目标脚本列表来自所用 OpenOCD 自带的脚本，在侧栏选择。

要使用自己的 OpenOCD，在侧栏“配置 OpenOCD 路径”中选择，或设置 `emberprobe.openocdPath`，并使用该构建配套的 scripts。

### 额外提供的目标名

内置脚本之外，这几个名称可以直接选用。它们只是现有实现的别名，不代表新增了芯片支持：

| 目标脚本 | 实际使用 | 用途 |
| --- | --- | --- |
| `numicroM0.cfg` | `numicro.cfg` | NuMicro M0 |
| `numicroM4.cfg` | `numicro_m4.cfg` | NuMicro M4 |
| `stm32mp13x.cfg` | `st/stm32mp13x.cfg` | STM32MP13 |
| `stm32mp15x.cfg` | `st/stm32mp15x.cfg` | STM32MP15 |
| `renesas_rz_g2.cfg` | `renesas_rz.cfg` | Renesas RZ |
| `rp2040-core0.cfg` | `rp2040.cfg` | 只调试 RP2040 的 core 0 |

### STM32C0

使用 `stm32c0x.cfg`，支持 C011/C031/C051/C071/C091/C092。C0 没有 JTAG 引脚，`transport` 为 `auto` 时使用 SWD。

### STM32C5（实验性）

使用 `stm32c5x.cfg`，支持 C531/C532/C542、C551/C552/C562、C591/C593/C5A3。这一支持**尚未经过实板验证**。

- 调试器脚本用 `interface/stlink.cfg`、J-Link 或 CMSIS-DAP。`interface/stlink-hla.cfg` 不支持此目标，会在启动前被拒绝。
- 只能擦除、编程和读取 Flash，不能操作选项字节和 RDP。
- 擦写速度尚未测量。
- 使用自己的 OpenOCD 时需要它自带 C5 脚本和 Flash loader，否则报 `FLASH_LOADER_MISSING`。

### 限制

- 目标脚本能加载不代表每块板子都能用，也不代表所有功能都可用。实板支持需要单独验证。
- 需要额外驱动的厂商配置没有内置，包括 WCH、HPMicro、较新的 APM32/AT32 型号、STM32H5，以及更多的 Espressif 和 TI 系列。

## 相关文档

- [探针选择与连接设计](../design/probe-selection.md)
- [内置 OpenOCD 的构建与校验](../design/openocd-build.md)
