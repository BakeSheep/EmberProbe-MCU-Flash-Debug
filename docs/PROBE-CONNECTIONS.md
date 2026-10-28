# Probe connections / 探针连接

Connection preflight follows the selected OpenOCD interface with `noinit`, without loading a target or initializing hardware. It resolves sourced Tcl scripts and variables before reading OS metadata. Custom interface scripts remain trusted user code and must not explicitly perform hardware operations during configuration.

连接预检使用 `noinit` 执行所选接口脚本及其引用，解析实际后端和选择参数，不加载目标脚本、不初始化硬件。自定义接口脚本仍属于用户信任的代码，应避免在配置阶段显式操作硬件。

## Selection / 设备选择

Priority is explicit `probeSerial`, interface-script serial, the probe the user picked in the sidebar for this interface script, then a unique present device; several devices of one type are told apart by automatic mode's target chip check (below). Inventory is filtered by effective family, configured VID/PID and product selector. FTDI channel and other captured interface parameters participate in the connection fingerprint; a channel is not a separate physical USB probe. Multiple interfaces of a Windows composite device are grouped under their physical parent. When the OS query is unavailable or recognizes no matching device, OpenOCD applies the interface script default selection; a picked serial is still passed. On Linux, a USB device whose sysfs metadata cannot be read within the query budget (for example a target board's own USB device while the kernel retries it) is skipped and reported in the connection notes instead of discarding the inventory; the probes that were read are still selected, but a missing serial is no longer reported absent because the skipped device could be that probe, and the serial is passed to OpenOCD to enforce. If no device can be read, the inventory is unavailable. A pick made under a different interface profile is ignored, and the sidebar list asks for a new pick. Generic FTDI USB-UART bridges are listed only when the interface script selects their USB IDs.

选择顺序为显式 `probeSerial`、接口脚本序列号、用户在侧栏为当前接口脚本点选的探针、当前唯一设备；同类型多台时由自动模式按目标芯片区分（见下文）。枚举按实际家族、VID/PID 和产品选择参数过滤。FTDI 通道及捕获到的接口参数进入连接指纹；不同通道不重复计算为物理 USB 探针。Windows 复合接口按物理父设备合并。系统查询不可用或未识别到匹配设备时，由 OpenOCD 按接口脚本默认方式选择；点选设备的序列号仍会传入。Linux 下若某个 USB 设备（例如调试中目标板自身的 USB 设备，内核正在重试）在查询时限内无法读取 sysfs 信息，只跳过该设备并在连接诊断中注明，不再使整份枚举失效；已读到的探针照常选择，但被跳过的设备可能正是所选探针，因此不再据此判定序列号缺席，而是把序列号交给 OpenOCD 校验。所有设备都无法读取时视为枚举不可用。接口参数改变后，之前的点选不再使用，需在侧栏列表中重新点选。通用 FTDI USB 串口芯片仅在接口脚本选择其 USB ID 时列为探针。

| Backend / 后端 | Rules / 规则 |
| --- | --- |
| J-Link | Decimal serial validation and Windows driver checks remain in place / 保留十进制序列号及 Windows 驱动检查 |
| CMSIS-DAP, ST-Link, XDS110, Nu-Link, TI-ICDI | Unique-device and exact-serial selection use the same preflight / 共用唯一设备及精确序列号预检 |
| FTDI, FT232R, VSLLINK | Use the script's effective USB IDs; FTDI requires explicit VID/PID configuration / 按脚本实际 USB ID 枚举；FTDI 须配置 VID/PID |
| KitProg | This backend cannot enforce a serial filter; a configured serial is ignored and only one matching device may be connected / 该后端无法执行序列号过滤，忽略已配置序列号，只允许一台匹配设备 |
| Other OpenOCD adapters / 其他 OpenOCD 适配器 | Pass through to OpenOCD; an explicit serial is passed as `adapter serial` / 直通 OpenOCD，显式序列号按 `adapter serial` 传入 |

A Windows instance-ID tail is an OS selection hint, not proof of the USB descriptor string: Windows turns spaces into `_`. For example, `ATK_20190528` must not automatically become `adapter serial ATK_20190528` when the real serial is `ATK 20190528`. Automatic selection of a unique Windows device omits the serial filter. A tail without `_` is treated as the exact serial for picked probes, the sidebar list and write trust. An explicit true serial matches its Windows alias, preserves internal spaces and is passed as a single Tcl word. Control characters and Tcl metacharacters are rejected. J-Link numeric identities retain their existing handling.

Windows 设备实例尾串只是系统选择线索，不证明 USB 描述符原文。若真实序列号为 `ATK 20190528`，自动识别不能将 `ATK_20190528` 原样传给 OpenOCD。Windows 会把空格转为 `_`。唯一设备自动连接时省略序列号过滤；不含 `_` 的尾串按精确序列号用于点选的探针、侧栏列表及写入许可。用户显式配置的真实序列号可匹配其 Windows 别名，保留内部空格，作为单个 Tcl 参数传递。控制字符及 Tcl 元字符会被拒绝，J-Link 数字身份沿用原规则。

If multiple matching devices are present, selection must be enforceable by OpenOCD. Devices with usable serial selectors, including Windows aliases without `_`, can be picked in the sidebar list; an operation that cannot choose stops with `PROBE_SELECTION_REQUIRED`, and one started from the UI opens that list instead of prompting. Anonymous devices or aliases containing `_` cannot distinguish several probes safely; disconnect the others or configure the exact USB serial. A missing picked probe is never silently replaced. Records are written as version 3; older records are read without the probe they name (see [J-Link compatibility](JLINK-COMPATIBILITY.md)). Records without a pick save only the interface script and never bind the next attached probe as the previous device.

多台匹配设备并存时，OpenOCD 必须能够执行选择。具有可用序列号（含不带 `_` 的 Windows 别名）的设备可在侧栏列表中点选；无法确定时操作以 `PROBE_SELECTION_REQUIRED` 停止，从界面发起的操作会展开该列表，而不是弹出选择框。无序列号设备或含 `_` 的 Windows 别名不能安全区分多台探针，应断开其他设备或显式填写真实 USB 序列号。点选的设备缺席时不自动替换。记录按第三版写入；旧记录读取时忽略其中的探针（见 [J-Link 兼容性](JLINK-COMPATIBILITY.md)）。未点选时只记录接口脚本，下次重新解析物理设备。

The sidebar's **Connected probe** row lists every attached probe, shows which one this order selects and lets the user choose another; a device of another type also switches the interface script to that type's default. See [J-Link compatibility](JLINK-COMPATIBILITY.md) for its behavior and the per-device J-Link driver switch.

侧栏“已连接调试器”一行列出所有已连接的探针，标出按上述顺序选中的设备，并可改选其他设备；选择不同类型的设备时，接口脚本会同时改为该类型的默认脚本。具体行为及按设备切换 J-Link 驱动见 [J-Link 兼容性](JLINK-COMPATIBILITY.md)。

## Automatic mode and the target chip / 自动模式与目标芯片

The **Auto** button is temporarily hidden; the behavior below still applies when no probe is fixed. Automatic mode (no `probeSerial` setting and no picked probe) follows the target chip instead of keeping a probe. Every operation it starts — chip read, fault read, flash, verification, debugging and sampling — reads CPUID, the target's DBGMCU IDCODE and the 96-bit UID right after OpenOCD's `init`, in the operation's own OpenOCD process. The reads take 2–6 ms and never halt, reset or write the target. When a field read differs from the chip recorded for the workspace's target configuration, OpenOCD ends with `shutdown error` before the operation's first command and the operation reports `PROBE_TARGET_MISMATCH`; a field that cannot be read is not a mismatch, and silicon revisions are ignored (CPUID variant and revision, IDCODE REV_ID), so only the core part number, DEV_ID and UID count. A successful operation records the chip it read (workspace state `mcu.selectedProbe`, `source: "auto"`, with `target` and `chip`) and no probe serial, so automatic mode stays active. The sidebar shows the checked chip; after a mismatch it shows both chips and **Use this chip**, which records the chip found. With several probes of the configured family, Automatic mode uses the one connected to the recorded chip, or without a record the only one whose chip is of the configured STM32 series. Earlier readings are tried first and the operation's own check catches a stale one; otherwise every candidate is read at once with a short session (init, the three reads, shutdown). A J-Link on the SEGGER driver on Windows cannot be read; when that leaves the choice open, the operation stops with that probe's `PROBE_DRIVER_UNSUPPORTED` and its driver warning, and opens the sidebar list, where the card's dropdown switches the driver. Any other unsettled choice stops with `PROBE_SELECTION_REQUIRED`; an operation started from the UI opens the sidebar list, which shows each probe's chip, for the user to pick one. A probe kept by the user or the `probeSerial` setting is used as named, without a check. External GDB server sessions use a server started outside EmberProbe and are not checked. Targets without a known DBGMCU or UID address compare only CPUID.

“自动”按钮暂时隐藏；未固定探针时仍保留下述行为。自动模式（未设置 `probeSerial`、未固定探针）跟随目标芯片，而不是固定某台探针。它发起的每个操作（读取芯片、故障读取、烧录、校验、调试、采样）都在本操作自己的 OpenOCD 进程中，于 `init` 之后立即读取 CPUID、目标的 DBGMCU IDCODE 及 96 位 UID，耗时 2–6 ms，不暂停、不复位、不写入目标。读到的字段与工作区为当前目标配置记录的芯片不同时，OpenOCD 在操作的第一条命令之前以 `shutdown error` 结束，操作报告 `PROBE_TARGET_MISMATCH`；读不到的字段不算不一致；芯片修订版本（CPUID 的 variant/revision、IDCODE 的 REV_ID）不参与比较，只比较内核型号、DEV_ID 与 UID。操作成功后记录本次读到的芯片（工作区状态 `mcu.selectedProbe`，`source: "auto"`，含 `target` 与 `chip`），不记录探针序列号，因此保持自动模式。侧栏显示正在校验的芯片；发生不一致后显示两颗芯片及“改用当前芯片”，点击后记录当前芯片。配置类型的探针有多台时，自动模式选用连接着已记录芯片的那台；尚无记录时，选用唯一一台芯片属于所配置 STM32 系列的探针。优先使用之前的读数，读数过期由操作自身的校验发现；否则用简短会话（init、三项读取、shutdown）同时读取所有候选探针。Windows 下使用 SEGGER 驱动的 J-Link 无法读取；因此无法确定时，操作以该探针的 `PROBE_DRIVER_UNSUPPORTED` 停止并给出驱动提醒，同时展开侧栏列表，可在其卡片的下拉中切换驱动。其他无法确定的情况以 `PROBE_SELECTION_REQUIRED` 停止；从界面发起的操作会展开侧栏列表，列表中显示每台探针的芯片，由用户点选。用户固定的探针或 `probeSerial` 设置按指定使用，不做校验。外部 GDB 服务器会话使用 EmberProbe 之外启动的服务器，不做校验。没有已知 DBGMCU/UID 地址的目标只比较 CPUID。

## TCP interfaces / TCP 接口

采样连接使用预检解析的后端种类：`tcp`（CMSIS-DAP TCP / ST-Link TCP）的 Tcl RPC 超时为 5000 ms，其他后端仍为 2000 ms，超时报错仍是 `OPENOCD_RPC_TIMEOUT`。独立 TCP 采样在 `init` 后用 `info commands poll_interval` 守卫把目标后台轮询设为 500 ms（`poll_period` 只控制服务器主循环，不改变目标轮询）；当前随包 OpenOCD 尚无 `poll_interval`，保持默认 100 ms，较新的自定义 OpenOCD 才生效。调试模式不改轮询。持续轮询失败仍须至少 3 次且跨越 3000 ms 才锁定，500 ms 轮询下约 3 秒触发。

Sampling uses the preflight-resolved backend kind: TCP Tcl RPCs allow 5000 ms; other backends retain 2000 ms and the same `OPENOCD_RPC_TIMEOUT` handling. Only standalone TCP sampling sets 500 ms background target polling after initialization through `poll_interval`, guarded by `info commands poll_interval` (`poll_period` only times the server loop). The bundled OpenOCD does not have `poll_interval` yet and keeps the 100 ms default; newer custom builds apply it. Debug polling defaults stay unchanged. The existing failure lock still requires at least three failures spanning 3000 ms, about three seconds with continuous 500 ms polling.

CMSIS-DAP TCP requires explicit backend selection and a host in the interface script. A configured TCP host with `backend auto` returns `PROBE_BACKEND_AMBIGUOUS` to avoid implicit USB/TCP fallback. Port defaults to 4441. For example:

```tcl
source [find interface/cmsis-dap.cfg]
cmsis-dap backend tcp
cmsis-dap tcp host probe.example
cmsis-dap tcp port 4441
```

CMSIS-DAP TCP 须在接口脚本中明确选择后端及主机。配置 TCP 主机但仍使用 `backend auto` 时返回 `PROBE_BACKEND_AMBIGUOUS`，避免自动切换 USB/TCP；默认端口为 4441。

ST-Link TCP uses OpenOCD's local ST-Link server endpoint, `127.0.0.1:7184` by default; `st-link backend tcp 7185` overrides the port. The HLA equivalent is `hla stlink_backend tcp 7185`. Both TCP families skip local USB inventory and bind authorization to the endpoint, effective profile and configured serial. Host and port remain script configuration; no TCP settings panel is added.

ST-Link TCP 连接本机 ST-Link server，默认 `127.0.0.1:7184`；可用 `st-link backend tcp 7185` 修改端口，HLA 对应 `hla stlink_backend tcp 7185`。两类 TCP 接口均跳过本机 USB 枚举，授权绑定端点、实际配置及显式序列号。主机和端口继续在脚本中配置，不新增 TCP 设置面板。

See the [OpenOCD adapter documentation](https://openocd.org/doc/html/Debug-Adapter-Configuration.html) and [ST-Link backend implementation](https://github.com/openocd-org/openocd/blob/master/src/jtag/drivers/stlink_usb.c) for backend command semantics.

## Writes and prompts / 写入与提示

Serial-less probes and automatically selected Windows aliases containing `_` bind pending confirmations to the current OS attachment: Windows last-arrival FILETIME, Linux USB bus/address and sysfs inode/change time, or a matched macOS IORegistry entry ID. Reattachment invalidates the pending confirmation even when the port or instance path is reused. If this identity cannot be read, including when the OS query finds no matching device, inspection can continue but firmware download, debug launch, target pause/reset and memory writes are rejected with `PROBE_IDENTITY_UNVERIFIED`; configure the exact USB serial to enable them. Attach without firmware download remains available.

无序列号探针及自动选择的含 `_` Windows 别名，使用当前系统连接身份绑定待确认操作：Windows 最后接入时间、Linux USB 总线/地址及 sysfs inode/变更时间，或匹配的 macOS IORegistry entry ID。重新插拔后，即使端口或实例路径相同，原确认也会失效。无法读取连接身份（包括系统查询未找到匹配设备）时仍可检查设备，但固件下载、下载固件的调试启动、目标暂停/复位及内存写入返回 `PROBE_IDENTITY_UNVERIFIED`，配置准确 USB 序列号后即可使用；不下载固件的 attach 仍可使用。

Agent memory writes through these probes offer `once` only and require confirmation for every operation. Existing 24-hour trust cannot bypass this requirement. Flash and peripheral writes keep their existing per-operation confirmation. UI write/download/launch clicks remain explicit individual operations; this change adds no second approval dialog.

这类探针的 Agent 内存写入仅提供 `once`，每次操作都须确认；既有 24 小时许可不能跳过确认。Flash 和外设写入沿用原有逐次确认。界面中的写入、下载、调试启动点击仍各自代表一次显式操作，不新增第二次审批弹窗。

The UI uses the sidebar's **Connected probe** list, localized error notifications and connection diagnostics; no prompt asks for a probe. Normal unique-device connections need no additional user action. Unsupported selectors, ambiguous identities and invalid TCP configuration stop before hardware initialization and explain the required correction.

前端使用侧栏“已连接调试器”列表、中文/英文错误通知和连接诊断，不弹出探针选择框。普通唯一设备连接不增加操作步骤；选择机制不受支持、身份歧义、TCP 配置无效时，在初始化硬件前停止并提示修正方法。

Software tests cover OS inventory fixtures, profile resolution, selection and authorization invalidation. Interface-only checks with bundled OpenOCD validate Tcl command compatibility. They do not establish real-board support; hardware validation must be recorded separately under the [HIL procedure](../test/hil/README.md).

软件测试覆盖各系统枚举样例、接口解析、设备选择及授权失效；随包 OpenOCD 的接口检查验证 Tcl 命令兼容性。这些检查不证明真机支持，硬件结果须按 [HIL 流程](../test/hil/README.md) 单独记录。
