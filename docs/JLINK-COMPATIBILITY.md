# J-Link compatibility / J-Link 兼容性

EmberProbe uses OpenOCD's J-Link backend. A marketplace label such as “V9 JLinkOB” is not a complete hardware identity. Record the actual OB implementation, firmware and hardware strings, serial number, USB interfaces and their drivers before deciding whether a driver change is appropriate.

EmberProbe 使用 OpenOCD 的 J-Link 后端。“V9 JLinkOB”这类网购名称不足以判定兼容性，必须结合实际 OB 型号、固件、硬件字符串、序列号、USB 接口和驱动信息。版本标签不等于驱动兼容保证。

## Configure a connection / 配置连接

Probe selection and transport are automatic by default. Configure manual overrides in the VS Code EmberProbe settings / 在 VS Code 的 EmberProbe 插件设置中配置手动覆盖：

| Setting | Meaning / 含义 |
| --- | --- |
| `emberprobe.probeSerial` | Decimal J-Link serial; exact USB serial for other supported backends / J-Link 十进制序列号；其他受支持后端的精确 USB 序列号 |
| `emberprobe.transport` | `auto` by default; optional `swd` / `jtag` override / 默认自动，可手动覆盖协议 |
| `emberprobe.adapterSpeedKhz` | Integer kHz; nonzero caps target reset-event requests and is the programming clock, `0` keeps script defaults and programs at the probe's clock / 整数 kHz；非零值约束 target 复位事件提速并作为烧录时钟，`0` 保留脚本默认速度、烧录时使用探针时钟 |
| `emberprobe.samplingAdapterSpeedKhz` | Standalone sampling clock, integer kHz with the same bounds; `0` inherits `adapterSpeedKhz`, nonzero reuses reset-event caps. Changes reconnect standalone sampling; debug/flash clocks stay unchanged / 独立采样链路时钟，整数 kHz 且范围同上；`0` 沿用通用时钟，非零值复用复位事件限速；修改后重连独立采样，不改调试/烧录时钟 |

独立采样写入授权绑定实际生效的链路时钟以及原有探针身份；设置变化使旧采样会话过期并重连，工作区探针记录仍只保存探针选择信息。该设置可在 VS Code 中修改，Agent 配置快照只读提供它，不新增 MCP/Agent 修改参数。

Standalone sampling write authorization includes the effective link clock and the existing probe identity. A setting change makes the old sampling session stale and reconnects it; the workspace probe record still stores only the probe selection. Configure it in VS Code; Agent configuration snapshots expose it read-only, with no new MCP/Agent mutation parameter.

A unique matching probe is selected automatically within the effective interface family. USB serial strings preserve case, leading zeros and internal spaces; J-Link retains decimal validation. Explicit serial settings take precedence over interface-script serials and the probe picked in the sidebar. A missing picked device never causes fallback to another probe. Several devices of one type need an enforceable selector: automatic mode tells them apart by the target chip, otherwise the user picks one in the sidebar, and callers receive a structured ambiguity error. Failed connections do not update the workspace record. When OS inventory is unavailable or recognizes no matching device, an explicit or picked serial is passed to a backend that enforces it; otherwise OpenOCD applies the interface default selection. See [probe connection rules](PROBE-CONNECTIONS.md) for serial-less probes, Windows aliases, additional adapters and TCP interfaces.

在实际接口家族内，唯一匹配的探针会自动选定。USB 序列号保留大小写、前导零及内部空格；J-Link 仍校验十进制序列号。显式配置优先于接口脚本序列号及侧栏点选的设备，所选设备缺席时不自动换用其他设备；同类型多台时，自动模式按目标芯片区分，无法区分时在侧栏点选。系统枚举不可用或未识别到设备时，由 OpenOCD 按接口默认方式选择。无序列号、Windows 别名、其他适配器及 TCP 接口的具体规则见[探针连接说明](PROBE-CONNECTIONS.md)。

A nonzero speed setting wraps existing target reset events and caps their `adapter speed` requests. Original clock, watchdog and Flash initialization remains in place, and requests below the cap are preserved. Apart from the programming clock described in [Flash performance](FLASH-PERFORMANCE.md), no automatic retry or protocol change is performed. Custom scripts that change speed outside these events remain trusted user code.

非零速度设置保留 target 原有复位事件及其时钟、看门狗和 Flash 初始化，只限制其中的 `adapter speed` 提速请求，保留低于上限的速度。除[烧录性能](FLASH-PERFORMANCE.md)所述的烧录时钟外，不自动重试或切换协议；在这些事件之外修改速度的自定义脚本仍属于用户信任的代码。

For J-Link, explicit transport overrides take precedence. Known Cortex-M targets default to SWD; other targets retain the interface script default. OpenOCD validates the selected protocol using interface-only configuration with `noinit`. This checks software configuration, not board wiring or physical probe capabilities. There is no automatic speed reduction, protocol retry or reset.

On Windows x64, every J-Link card in the **Connected probe** row has a WinUSB/SEGGER dropdown; listing a J-Link on the SEGGER driver, or choosing SEGGER there, shows no notification. Chip reads, sampling, debugging and downloads reject this driver with `PROBE_DRIVER_UNSUPPORTED` before target startup. Selecting **WinUSB** explicitly runs the bundled unsigned helper and may request administrator authorization. Windows may show an unknown-publisher prompt or block it under local policy. The original driver is exported before the change. When the J-Link is again on a verified SEGGER driver whose `oemNN.inf` differs from the backup, for example after a SEGGER software update, or a previous backup was interrupted, the next WinUSB switch first exports the current driver to a separate folder and only then replaces the backup and its record; an interrupted refresh is repeated next time. Selecting **SEGGER** in the same dropdown restores a driver previously changed by EmberProbe, even if OpenOCD is unavailable. The helper only changes the confirmed debug interface of supported J-Link USB products; an unknown interface or driver remains untouched. The helper pins the SHA-256 of its paired libwdi DLL and verifies it before loading elevated code. The release pipeline verifies SHA-256 hashes for both native files and their bytes in the VSIX; this does not authenticate their publisher. A development build without its native helper reports a missing-helper error when WinUSB is selected. Linux still uses udev permissions and macOS has no Windows driver step.

可读取序列号的唯一 J-Link 自动选定；明确设置优先，其次使用用户在“已连接调试器”中点选的探针（按本机保存在工作区状态中，不写入设置文件）。指定或点选的设备不在线时，不会改连另一台。同类型多台且未点选时，自动模式按目标芯片区分，无法区分时在侧栏点选；Agent 返回歧义错误。协议覆盖优先，已知 Cortex-M 默认 SWD，其他目标保留接口脚本默认协议。预检使用 `noinit` 验证软件配置，不探测接线、不初始化目标，也不自动降速或切换重试。Windows x64 下若已识别的 J-Link 使用 SEGGER 驱动，读取、采样、调试和下载会在目标启动前报驱动不支持；用户须在“已连接调试器”中该 J-Link 卡片的驱动下拉中主动选择 WinUSB，完成管理员授权。驱动下拉中的 SEGGER 可恢复 EmberProbe 曾备份的原驱动；列出使用 SEGGER 驱动的 J-Link 或在此选择 SEGGER 时不弹出通知。若 J-Link 当前使用的已校验 SEGGER 驱动与备份记录的 `oemNN.inf` 不同（例如更新 SEGGER 软件后），或上次备份中途中断，下次切换到 WinUSB 时会先把当前驱动导出到单独目录，完成后再替换备份及其记录；刷新中断时下次会重做。

On Windows, a blocked SEGGER-driver operation also displays a VS Code warning with **Switch to WinUSB** and **Ignore for this workspace**. Switching uses the same verified driver-change flow as the sidebar, but targets the exact J-Link the blocked operation resolved rather than re-resolving one from settings, so it also works with several J-Links attached; it rechecks that device's USB interface and stops if the device was disconnected. Retry the operation after switching completes. A probe picked from the selection list is remembered for the workspace immediately, even when the operation then fails on the driver, so the sidebar and later operations use the same J-Link. If the J-Link is blocked but its interface cannot be verified for switching (an unlisted USB product, an ambiguous debug interface, or an unverifiable driver provider or INF), the warning offers no switch: it states the reason, writes the interface instance IDs, services, providers and INFs to the EmberProbe Chip Info output, and the driver must be changed manually, for example with Zadig. Ignoring suppresses future driver warning notifications in this workspace, including after reopening it. It does not bypass driver checks or hide operation errors in the extension page. Dismissing the notification without choosing Ignore allows it to appear on the next blocked operation. Concurrent attempts share one pending notification.

Windows 下因 SEGGER 驱动被阻止的操作还会显示 VS Code 右下角警告，提供“切换到 WinUSB”和“忽略（当前工作区不再提醒）”按钮。切换使用侧栏已有的驱动切换流程，但针对被阻止操作所解析的那台 J-Link，不再按设置重新解析，因此插有多台 J-Link 时同样可用；切换前会重新核对该设备的 USB 接口，设备已断开则不切换。完成后需手动重试原操作。在列表中选择的探针会立即记为当前工作区探针（即使操作随后因驱动失败），侧栏和后续操作使用同一台 J-Link。若 J-Link 被阻止但其接口无法通过切换校验（USB 型号不在已验证列表、调试接口不唯一、驱动提供者或 INF 无法验证），警告不提供切换按钮，而是说明原因，并把各接口的实例 ID、服务、驱动提供者和 INF 写入“EmberProbe 芯片信息”输出面板；此时需用 Zadig 等工具手动更换驱动。“忽略”保存在当前工作区，重新打开后仍有效，不影响其他工作区，也不绕过驱动检查或隐藏插件页面中的操作错误。仅关闭通知而未选择“忽略”时，下次操作仍会提醒；并发操作只显示一条待处理通知。

Windows inventory is read through the bundled read-only helper when available, avoiding PowerShell startup on each operation. Repeated SEGGER-to-WinUSB switches reuse the previously prepared driver package. The selector stays busy until the selected WinUSB interface can be opened by OpenOCD; this check does not initialize the MCU target. Windows device installation policy checks may still take time. A later `TARGET_NOT_CONNECTED` or `cannot read IDR` error concerns the target SWD connection, even when the USB interface is ready.

Windows 下优先用内置只读 helper 枚举探针，避免每次操作都启动 PowerShell。发布包中的 helper 与 libwdi 未签名，Windows 可能提示未知发布者或依本机策略阻止运行；发布流程和 helper 会核对文件哈希，但哈希不证明发布者身份。重复切换到 WinUSB 时复用已准备的驱动包；下拉栏保持加载状态，直到 OpenOCD 能打开所选接口。该检查不初始化 MCU。Windows 的驱动安装策略检查仍可能耗时。若之后出现 `TARGET_NOT_CONNECTED` 或 `cannot read IDR`，应排查目标芯片的 SWD 连接。

While the sidebar is visible, the **Connected probe** row below **Select debugger** lists every connected debug probe from read-only USB metadata, whatever interface script is selected. It checks again three seconds after each completed check, slowing to ten seconds after five unchanged checks (ten and thirty seconds on macOS, whose enumeration starts system_profiler); its refresh button and any selection check immediately. A probe attached after configuration therefore appears without reselecting the debugger, and incomplete Windows enumeration is retried on the next check. Returning to a retained sidebar checks immediately. Hidden or closed sidebars stop polling, and superseded checks cannot overwrite newer results. These checks neither open the target nor change a USB driver.

The refresh button also reads the target chip on every listed probe it can open (a short OpenOCD session per probe, all at once, with that probe's interface script and the selected target configuration; nothing is halted, reset or written) and shows its core (for example `Cortex-M4`) after the serial; the tooltip gives the full chip. Nothing is read while an EmberProbe operation holds a probe, and the probe in use shows no chip until the operation ends; a probe held by another program cannot be opened and shows none either. The list marks the device the next operation uses with a check; hovering shows why (setting, selected device, only device, chosen by target chip). Clicking a device saves it as the workspace's selected probe. A device of another type also changes **Select debugger** to that type's default script (`jlink.cfg`, `cmsis-dap.cfg`, `stlink.cfg`, `xds110.cfg` or `nulink.cfg`); another script of the same type, such as `stlink-v2.cfg`, is kept; the card's tooltip names that script beforehand, and the row changes in place without reloading the sidebar or showing a notification. The **Auto** button is temporarily hidden; manual probe selection and refresh remain available. Existing automatic selection behavior is retained (see [probe connections](PROBE-CONNECTIONS.md)). A saved device that is unplugged stays selected and is shown as not connected; no other device is chosen in its place. An operation started from the UI that cannot choose a probe, or whose saved device is unplugged, opens this list instead of a prompt; the probe is only ever picked here. Devices OpenOCD cannot tell apart (several of one type without a reliable USB serial) are listed but disabled, with the reason. When `emberprobe.probeSerial` is set, or a custom interface script selects its own device, the row only shows the result. On Windows x64 each J-Link card carries its own WinUSB/SEGGER dropdown, so a J-Link's driver is changed without selecting it, also in automatic mode; a J-Link the helper cannot verify shows a manual-driver badge on its card whose tooltip gives the reason. Agents see the same choice: `config.get` returns `selectedProbe` and `probe.list` marks that device with `selected: true`; Agents cannot change it.

侧栏可见时，“选择调试器”下方的“已连接调试器”一行根据只读 USB 元数据列出所有已连接的调试器，与所选接口脚本无关。每次检测结束三秒后再次检测，连续五次无变化后放宽到十秒（macOS 枚举需启动 system_profiler，为十秒和三十秒）；点击刷新按钮或做任何选择都会立即检测。因此先配置再插入探针也会自动出现，无须重新选择调试器；Windows 尚未完成枚举时会在下次检测重试。切回保留的侧栏会立即补查，隐藏或关闭侧栏则停止轮询，过期检测结果不会覆盖新结果。这些检测不连接目标芯片，也不更改 USB 驱动。

刷新按钮还会读取列表中每台可打开探针所连接的目标芯片（每台一个简短 OpenOCD 会话，同时进行，使用该探针的接口脚本与所选目标配置；不暂停、不复位、不写入），在序列号之后显示其内核型号（如 `Cortex-M4`），悬停可查看完整芯片信息。EmberProbe 有操作占用探针时不读取，正在使用的探针在操作结束前不显示芯片；被其他程序占用的探针无法打开，同样不显示。列表以对勾标出下一次操作将使用的设备，悬停可查看依据（设置指定、已选择的设备、唯一设备、按目标芯片选择）。点选某台设备后，它会保存为工作区所选探针。若所选设备与当前接口脚本不是同一类型，“选择调试器”会同时改为该类型的默认脚本（`jlink.cfg`、`cmsis-dap.cfg`、`stlink.cfg`、`xds110.cfg` 或 `nulink.cfg`）；同类型的其他脚本（如 `stlink-v2.cfg`）保持不变；卡片的悬停提示会事先注明将切换到的脚本，切换时该行原地更新，不重新加载侧栏，也不弹出通知。“自动”按钮暂时隐藏，手动点选探针与刷新功能保留；已有的自动选择逻辑仍保留（见[探针连接说明](PROBE-CONNECTIONS.md)）。已保存的设备被拔出后仍保持选中，并显示为“未连接”，不会改用其他设备。从界面发起的操作无法确定探针或所选设备已拔出时，会展开此列表而不是弹出选择框；探针只在此处选择。OpenOCD 无法区分的设备（同类型多台且没有可靠 USB 序列号）会列出但不可选，并说明原因。设置了 `emberprobe.probeSerial`，或自定义接口脚本自行选择设备时，该行只显示结果。Windows x64 下，每台 J-Link 的卡片都有自己的 WinUSB/SEGGER 驱动下拉，无需先选中即可切换它的驱动，自动模式下也是如此。helper 无法校验的 J-Link 在其卡片上显示“驱动需手动处理”，悬停可查看原因。Agent 看到的是同一选择：`config.get` 返回 `selectedProbe`，`probe.list` 用 `selected: true` 标出该设备；Agent 不能修改这一选择。

The workspace probe record is stored per machine in workspace state (`mcu.selectedProbe`), never in settings, and never overwrites user settings. A pick in the list records the interface script, serial, probe type, USB device ID, source `user` and the effective interface profile fingerprint; a successful operation on that probe refreshes it, and an operation through the `emberprobe.probeSerial` setting on another device leaves it in place. Without a pick, automatic mode keeps no probe: an operation whose target chip was checked records the chip (`source: "auto"`, see [probe connections](PROBE-CONNECTIONS.md)), and other successful operations record only the interface script (`source: "success"`), so every operation resolves the current physical device again. Records of older releases (v1, v2, and `success` records carrying a serial) named the probe that last connected; they are read without that serial and device, so such workspaces start in automatic mode. A legacy v2 copy (`mcu.successfulProbeConnection`) is kept for older releases and installed skills; if an older release later records another probe there, that record is read the same way. Standalone scripts without workspace storage use the same decision rules without persistent history. Explicit serial, transport and speed overrides are configured in VS Code settings. Write authorization binds the resolved physical connection and interface profile.

工作区探针记录按本机保存在工作区内部状态（`mcu.selectedProbe`），不写入设置文件，也不覆盖用户设置。在列表中点选设备时记录接口脚本、序列号、探针类型、USB 设备 ID、来源 `user` 及实际接口配置指纹；在该设备上操作成功后刷新这条记录，经 `emberprobe.probeSerial` 设置连接其他设备时保持不变。未点选时为自动模式，不记录探针：经过芯片校验的操作记录目标芯片（`source: "auto"`，见[探针连接说明](PROBE-CONNECTIONS.md)），其他成功操作只记录接口脚本（`source: "success"`），每次操作重新确认当前物理设备。旧版本的记录（v1、v2 及带序列号的 `success` 记录）保存的是最近一次连接的探针，读取时忽略其序列号和设备，因此这类工作区从自动模式开始。同时保留旧格式副本（`mcu.successfulProbeConnection`）供旧版本和已安装的 skill 读取；若旧版本之后在其中记录了另一台探针，也按同样方式读取。独立脚本使用相同决策规则，但没有工作区存储时不持久记忆。显式序列号、协议和速度覆盖项在 VS Code 插件设置中配置。写入授权绑定解析后的实际连接及接口配置。

`probe.list` reads OS USB metadata only: Windows PnP, Linux sysfs, or macOS system_profiler. Windows composite interfaces are grouped by their physical parent. Unknown serial/driver fields remain unknown. Capability preflight checks the selected OpenOCD build with `noinit` before starting a hardware operation. A custom interface script is trusted user code; it must not perform explicit hardware operations during configuration.

`probe.list` 只读取操作系统 USB 元数据；Windows 复合接口按物理父设备合并。无法读取的信息保持未知，不猜测序列号。能力检查使用 `noinit`，不会自动初始化目标。仅在用户主动选择 WinUSB 时才更改驱动；枚举、预检和硬件操作不会自动更改驱动。自定义接口脚本属于用户信任的代码，应避免在配置阶段显式操作硬件。

## Agent and CLI / Agent 与命令行

`config.get` / `config.set` expose `probeSerial` and `adapterSpeedKhz`. Flash program and verify scripts accept `--probe-serial <serial>` and `--adapter-speed-khz <integer>`, together with `--transport swd|jtag`. Preflight records parameter sources, selected identity and errors; it does not install or replace a USB driver.

Agent 配置接口支持序列号和速度；烧录、校验脚本支持上述参数。预检记录参数来源与错误，不安装或替换 USB 驱动。

Write confirmations bind the ELF and connection identity. Persisted workspace write trust additionally binds the connection, so older ELF-only trust is invalidated. External DAP writes bind the debug session and workspace. Changing connection settings while a session runs prevents further writes until that session is stopped and restarted; reads continue using the existing connection.

写入确认绑定 ELF 与连接身份；工作区持久授权同样绑定连接，旧的仅绑定 ELF 的授权失效。外部 DAP 写入绑定调试会话与工作区。会话运行中更改连接设置后，旧会话禁止继续写入，须停止并重新启动；读取仍使用原连接。

## Diagnose without guessing / 按证据诊断

### Linux CMSIS-DAP HID serial crash / Linux CMSIS-DAP HID 序列号崩溃

Some system OpenOCD 0.12.0 builds abort with `*** buffer overflow detected ***: terminated`
when the CMSIS-DAP HID backend matches an `adapter serial`. The upstream fix is
[e01e180f](https://github.com/openocd-org/openocd/commit/e01e180f6248590348bad5c354c6b4e0cf1a956a):
the old conversion passed a byte count where `mbstowcs` expects a wide-character count.
J-Link does not use this backend, so a successful J-Link read cannot exclude this defect.
The version string `0.12.0` alone does not establish whether a distribution backported the fix.

部分系统 OpenOCD 0.12.0 构建在 CMSIS-DAP HID 后端匹配 `adapter serial` 时，会以
`*** buffer overflow detected ***: terminated` 崩溃。上游修复 e01e180f 纠正了宽字符转换的长度单位。
J-Link 不走这个后端，因此 J-Link 读取成功与此故障可以同时存在。仅凭版本字符串 `0.12.0`
不能判断系统发行包是否已回移植修复。

Configure a build containing the fix through **Configure OpenOCD Path** in the sidebar or
`emberprobe.openocdPath` in VS Code settings. Retain the exact serial and the matching scripts tree;
removing the serial bypasses physical probe selection. Native crashes are reported as
`OPENOCD_NATIVE_CRASH`, without an automatic retry. One-shot reads retain the executable path,
exit code, termination signal and bounded raw output in diagnostics.

通过侧栏“配置 OpenOCD 路径”或 VS Code 的 `emberprobe.openocdPath` 设置，选择包含修复的构建，
并使用该构建配套的 scripts。保留精确序列号：删除序列号会绕过物理探针选择。
原生崩溃报告为 `OPENOCD_NATIVE_CRASH`，不自动重试；单次读取诊断保留可执行路径、退出码、
退出信号和有界原始日志。具体复现与验证范围见 [Linux CMSIS-DAP 诊断记录](LINUX-CMSIS-DAP-DIAGNOSIS.md)。

The extension includes xPack OpenOCD 0.12.0-7 for Linux x64 as
`resources/openocd-linux-x64.tar.gz`. With the default `openocd` or empty path, the extension
automatically extracts and verifies this runtime offline before hardware startup, then reuses
its archive-specific directory in extension global storage. It does not write settings or change
the system installation. Explicit paths, including `/usr/bin/openocd`, take precedence.
Preparation failures stop the operation without falling back to the affected system build.
The sidebar offers path selection and rechecking; bundled runtime preparation needs no installation action.

插件内置 Linux x64 的 xPack OpenOCD 0.12.0-7。路径为默认 `openocd` 或空值时，
连接硬件前自动离线解压并验证，之后复用扩展全局存储中按预置包 SHA-256 分隔的目录。
自动准备不改写设置或系统安装；包括 `/usr/bin/openocd` 在内的显式路径继续优先。
准备失败时停止操作，不回退到有缺陷的系统构建；侧栏提供路径选择和重新检查，内置运行时无需手动安装。
压缩包保留官方原始文件，并加入 [兼容配置](OPENOCD-TARGETS.md)。上游基础包 SHA-256 为
`94b3790983beaf8ed57e646c0620dd66d705fddae03d290823a6ed3b439468d6`。
合入后的压缩包哈希及原始可执行文件哈希记录在 `resources/openocd-targets-manifest.json`。

### Other connection failures / 其他连接故障

An Ozone session holding a probe and an incompatible USB driver are different failure modes. Close the competing session for a busy error. `Failed to open device` alone does not prove either cause. Inspect the diagnostic code, native log, interface driver and device presence. OpenOCD and Ozone generally cannot own the same debug interface concurrently. Official WinUSB support depends on the exact J-Link/OB implementation and firmware; replacing a legacy SEGGER driver can affect SEGGER tools.

Ozone 占用与 USB 驱动不兼容是不同问题。占用错误应先释放竞争会话；单独一条 `Failed to open device` 不能证明根因。应查看错误码、原生日志、接口驱动及设备是否在线。OpenOCD 和 Ozone 通常不能同时独占同一调试接口。官方 WinUSB 支持取决于准确型号与固件，替换旧 SEGGER 驱动可能影响 SEGGER 工具。

The sidebar diagnostic panel supports expanding and copying structured errors. Diagnostics preserve native failure details, voltage readings and firmware/hardware information when emitted by the probe. Missing reference-voltage measurements on an OB are not proof that the target is unpowered.

侧边栏诊断可展开、复制；日志可提供电压、固件和硬件信息。OB 未提供参考电压测量值，不等于目标必然断电。

## Verification boundary / 验证边界

Software tests cover enumeration fixtures for all three OS families, identity selection, parameter order, native error classification, worker transport, confirmation binding and HIL success markers. These fixtures do not certify real USB drivers or probe firmware. Released-VSIX hardware validation, Windows 10, composite J-Link devices, and Ozone interoperability still require the dedicated-board [HIL procedure](../test/hil/README.md). Record exact identities before adding a broader hardware-tested compatibility claim.

软件测试覆盖三类系统的枚举样例、身份选择、参数顺序、原生日志诊断、Worker 传递、授权绑定和 HIL 成功标记，但不认证真实驱动或固件。发布版 VSIX 的真机验证、Windows 10、复合接口 J-Link 和 Ozone 互操作仍须按专用板 HIL 流程验收。
