# J-Link compatibility / J-Link 兼容性

Implementation and software acceptance evidence: [2026-09-21 record](JLINK-IMPLEMENTATION-2026-09-21.md).

EmberProbe uses OpenOCD's J-Link backend. A marketplace label such as “V9 JLinkOB” is not a complete hardware identity. Record the actual OB implementation, firmware and hardware strings, serial number, USB interfaces and their drivers before deciding whether a driver change is appropriate. The audit and upstream references are in [J-Link audit](JLINK-AUDIT-2026-09-20.md).

EmberProbe 使用 OpenOCD 的 J-Link 后端。“V9 JLinkOB”这类网购名称不足以判定兼容性，必须结合实际 OB 型号、固件、硬件字符串、序列号、USB 接口和驱动信息。版本标签不等于驱动兼容保证。

## Configure a connection / 配置连接

Probe selection and transport are automatic by default. Configure manual overrides in the VS Code EmberProbe settings / 在 VS Code 的 EmberProbe 插件设置中配置手动覆盖：

| Setting | Meaning / 含义 |
| --- | --- |
| `emberprobe.probeSerial` | Decimal J-Link serial / J-Link 十进制序列号 |
| `emberprobe.transport` | `auto` by default; optional `swd` / `jtag` override / 默认自动，可手动覆盖协议 |
| `emberprobe.adapterSpeedKhz` | Integer kHz; `0` keeps script defaults / 整数 kHz，`0` 保留脚本默认速度 |

A unique J-Link with a readable serial is selected automatically. Explicit serial settings take precedence over the last successful workspace binding; missing selected or bound devices never cause fallback to another probe. Multiple unbound devices require one device selection in the UI; Agent callers receive a structured ambiguity error. Failed or cancelled connections do not update history. When OS inventory is unavailable, an explicit serial can still be used, but cannot establish a verified success record.

For J-Link, explicit transport overrides take precedence, followed by a valid successful connection record. Known Cortex-M targets default to SWD; other targets retain the interface script default. OpenOCD validates the selected protocol using interface-only configuration with `noinit`. This checks software configuration, not board wiring or physical probe capabilities. There is no automatic speed reduction, protocol retry or reset.

On Windows x64, selecting `jlink.cfg` with a uniquely identified J-Link using the SEGGER USB driver displays a warning and a WinUSB/SEGGER dropdown beside **Select Debugger**. Chip reads, sampling, debugging and downloads reject this driver with `PROBE_DRIVER_UNSUPPORTED` before target startup. Selecting **WinUSB** explicitly runs the signed helper and may request administrator authorization. The original driver is exported before the change; selecting **SEGGER** in the same dropdown restores a driver previously changed by EmberProbe, even if OpenOCD is unavailable. The helper only changes the confirmed debug interface of supported J-Link USB products; an unknown interface or driver remains untouched. The helper pins the SHA-256 of its paired libwdi DLL and verifies it before loading elevated code. Local MSVC builds produce unsigned helper files for development testing; public release requires the signing and VSIX verification pipeline. A development build without its native helper reports a missing-helper error when WinUSB is selected. Linux still uses udev permissions and macOS has no Windows driver step.

可读取序列号的唯一 J-Link 自动选定；明确设置优先，其次使用工作区成功绑定。指定或绑定的设备不在线时，不会改连另一台。多设备且无绑定时，界面只需选择设备；Agent 返回歧义错误。协议覆盖优先于有效成功记录，已知 Cortex-M 默认 SWD，其他目标保留接口脚本默认协议。预检使用 `noinit` 验证软件配置，不探测接线、不初始化目标，也不自动降速或切换重试。Windows x64 下若已识别的 J-Link 使用 SEGGER 驱动，读取、采样、调试和下载会在目标启动前报驱动不支持；用户须在“选择调试器”右侧主动选择 WinUSB，完成管理员授权。下拉栏中的 SEGGER 可恢复 EmberProbe 曾备份的原驱动。

Windows inventory is read through the bundled read-only helper when available, avoiding PowerShell startup on each operation. Repeated SEGGER-to-WinUSB switches reuse the previously prepared driver package. The selector stays busy until the selected WinUSB interface can be opened by OpenOCD; this check does not initialize the MCU target. Windows device installation policy checks may still take time. A later `TARGET_NOT_CONNECTED` or `cannot read IDR` error concerns the target SWD connection, even when the USB interface is ready.

Windows 下优先用内置只读 helper 枚举探针，避免每次操作都启动 PowerShell。重复切换到 WinUSB 时复用已准备的驱动包；下拉栏保持加载状态，直到 OpenOCD 能打开所选接口。该检查不初始化 MCU。Windows 的驱动安装策略检查仍可能耗时。若之后出现 `TARGET_NOT_CONNECTED` 或 `cannot read IDR`，应排查目标芯片的 SWD 连接。

Success history is workspace-local and is written only after a valid target memory read, successful debugger target connection, or successful download/chip read. It never overwrites user settings. Protocol reuse requires the same device identity, target, executable and scripts fingerprint (the complete scripts tree is hashed to cover sourced files). If fingerprinting is unavailable, protocol history is not reused or updated. Standalone scripts without workspace storage use the same decision rules without persistent history. Explicit serial, transport and speed overrides are configured in VS Code settings. Existing write authorization remains bound to the resolved physical connection.

成功记录保存在工作区内部状态，只有有效目标内存读取、调试目标连接或下载/芯片读取成功后才更新，不覆盖用户设置。设备身份、目标、OpenOCD 或脚本变化会使协议记录失效；指纹不可用时不复用或更新协议记录。独立脚本使用相同决策规则，但没有工作区存储时不持久记忆。显式序列号、协议和速度覆盖项在 VS Code 插件设置中配置。写入授权仍绑定解析后的实际连接。

`probe.list` reads OS USB metadata only: Windows PnP, Linux sysfs, or macOS system_profiler. Windows composite interfaces are grouped by their physical parent. Unknown serial/driver fields remain unknown. Capability preflight checks the selected OpenOCD build with `noinit` before starting a hardware operation. A custom interface script is trusted user code; it must not perform explicit hardware operations during configuration.

`probe.list` 只读取操作系统 USB 元数据；Windows 复合接口按物理父设备合并。无法读取的信息保持未知，不猜测序列号。能力检查使用 `noinit`，不会自动初始化目标。仅在用户主动选择 WinUSB 时才更改驱动；枚举、预检和硬件操作不会自动更改驱动。自定义接口脚本属于用户信任的代码，应避免在配置阶段显式操作硬件。

## Agent and CLI / Agent 与命令行

`config.get` / `config.set` expose `probeSerial` and `adapterSpeedKhz`. Flash program and verify scripts accept `--probe-serial <decimal>` and `--adapter-speed-khz <integer>`, together with `--transport swd|jtag`. Preflight records parameter sources, selected identity and errors; it does not install or replace a USB driver.

Agent 配置接口支持序列号和速度；烧录、校验脚本支持上述参数。预检记录参数来源与错误，不安装或替换 USB 驱动。

Write confirmations bind the ELF and connection identity. Persisted workspace write trust additionally binds the connection, so older ELF-only trust is invalidated. External DAP writes bind the debug session and workspace. Changing connection settings while a session runs prevents further writes until that session is stopped and restarted; reads continue using the existing connection.

写入确认绑定 ELF 与连接身份；工作区持久授权同样绑定连接，旧的仅绑定 ELF 的授权失效。外部 DAP 写入绑定调试会话与工作区。会话运行中更改连接设置后，旧会话禁止继续写入，须停止并重新启动；读取仍使用原连接。

## Diagnose without guessing / 按证据诊断

An Ozone session holding a probe and an incompatible USB driver are different failure modes. Close the competing session for a busy error. `Failed to open device` alone does not prove either cause. Inspect the diagnostic code, native log, interface driver and device presence. OpenOCD and Ozone generally cannot own the same debug interface concurrently. Official WinUSB support depends on the exact J-Link/OB implementation and firmware; replacing a legacy SEGGER driver can affect SEGGER tools.

Ozone 占用与 USB 驱动不兼容是不同问题。占用错误应先释放竞争会话；单独一条 `Failed to open device` 不能证明根因。应查看错误码、原生日志、接口驱动及设备是否在线。OpenOCD 和 Ozone 通常不能同时独占同一调试接口。官方 WinUSB 支持取决于准确型号与固件，替换旧 SEGGER 驱动可能影响 SEGGER 工具。

The sidebar diagnostic panel supports expanding and copying structured errors. Diagnostics preserve native failure details, voltage readings and firmware/hardware information when emitted by the probe. Missing reference-voltage measurements on an OB are not proof that the target is unpowered.

侧边栏诊断可展开、复制；日志可提供电压、固件和硬件信息。OB 未提供参考电压测量值，不等于目标必然断电。

## Verification boundary / 验证边界

Software tests cover enumeration fixtures for all three OS families, identity selection, parameter order, native error classification, worker transport, confirmation binding and HIL success markers. These fixtures do not certify real USB drivers or probe firmware. A connected `1366:0101` J-Link V9 passed the native install, restore, extension driver-service, and interface-only OpenOCD checks on Windows build 26300.9550 using an unsigned local development helper; see the [hardware record](JLINK-DRIVER-HIL-2026-09-24.md). Signed-VSIX validation, Windows 10, composite J-Link devices, and Ozone interoperability still require the dedicated-board [HIL procedure](../test/hil/README.md). Record exact identities before adding a broader hardware-tested compatibility claim.

软件测试覆盖三类系统的枚举样例、身份选择、参数顺序、原生日志诊断、Worker 传递、授权绑定和 HIL 成功标记，但不认证真实驱动或固件。已连接的 `1366:0101` J-Link V9 使用未签名的本地开发 helper，在 Windows 构建号 26300.9550 上通过原生安装、恢复、扩展驱动服务及 OpenOCD 仅接口检查；详见[实机记录](JLINK-DRIVER-HIL-2026-09-24.md)。签名 VSIX、Windows 10、复合接口 J-Link 和 Ozone 互操作仍须按专用板 HIL 流程验收。
