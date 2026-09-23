# J-Link compatibility / J-Link 兼容性

Implementation and software acceptance evidence: [2026-09-21 record](JLINK-IMPLEMENTATION-2026-09-21.md).

EmberProbe uses OpenOCD's J-Link backend. A marketplace label such as “V9 JLinkOB” is not a complete hardware identity. Record the actual OB implementation, firmware and hardware strings, serial number, USB interfaces and their drivers before deciding whether a driver change is appropriate. The audit and upstream references are in [J-Link audit](JLINK-AUDIT-2026-09-20.md).

EmberProbe 使用 OpenOCD 的 J-Link 后端。“V9 JLinkOB”这类网购名称不足以判定兼容性，必须结合实际 OB 型号、固件、硬件字符串、序列号、USB 接口和驱动信息。版本标签不等于驱动兼容保证。

## Configure a connection / 配置连接

Connections are automatic by default. Manual overrides remain under **Other configuration → Advanced probe settings / 其他配置 → 探针高级设置**, or workspace settings:

| Setting | Meaning / 含义 |
| --- | --- |
| `emberprobe.probeSerial` | Decimal J-Link serial / J-Link 十进制序列号 |
| `emberprobe.transport` | `auto` by default; optional `swd` / `jtag` override / 默认自动，可手动覆盖协议 |
| `emberprobe.adapterSpeedKhz` | Integer kHz; `0` keeps script defaults / 整数 kHz，`0` 保留脚本默认速度 |

A unique J-Link with a readable serial is selected automatically. Explicit serial settings take precedence over the last successful workspace binding; missing selected or bound devices never cause fallback to another probe. Multiple unbound devices require one device selection in the UI; Agent callers receive a structured ambiguity error. Failed or cancelled connections do not update history. When OS inventory is unavailable, an explicit serial can still be used, but cannot establish a verified success record.

For J-Link, explicit transport overrides take precedence, followed by a valid successful connection record. Known Cortex-M targets default to SWD; other targets retain the interface script default. OpenOCD validates the selected protocol using interface-only configuration with `noinit`. This checks software configuration, not board wiring or physical probe capabilities. There is no automatic speed reduction, protocol retry, reset or driver replacement.

可读取序列号的唯一 J-Link 自动选定；明确设置优先，其次使用工作区成功绑定。指定或绑定的设备不在线时，不会改连另一台。多设备且无绑定时，界面只需选择设备；Agent 返回歧义错误。协议覆盖优先于有效成功记录，已知 Cortex-M 默认 SWD，其他目标保留接口脚本默认协议。预检使用 `noinit` 验证软件配置，不探测接线、不初始化目标，也不自动降速、切换重试或替换驱动。

Success history is workspace-local and is written only after a valid target memory read, successful debugger target connection, or successful download/chip read. It never overwrites user settings. Protocol reuse requires the same device identity, target, executable and scripts fingerprint (the complete scripts tree is hashed to cover sourced files). If fingerprinting is unavailable, protocol history is not reused or updated. Standalone scripts without workspace storage use the same decision rules without persistent history. Old explicit settings remain overrides. Use “Restore automatic connection and forget previous device” in advanced settings to clear the serial/protocol/speed overrides and previous device binding. Existing write authorization remains bound to the resolved physical connection.

成功记录保存在工作区内部状态，只有有效目标内存读取、调试目标连接或下载/芯片读取成功后才更新，不覆盖用户设置。设备身份、目标、OpenOCD 或脚本变化会使协议记录失效；指纹不可用时不复用或更新协议记录。独立脚本使用相同决策规则，但没有工作区存储时不持久记忆。旧的显式设置继续作为覆盖项；需要更换设备并恢复自动选择时，使用高级设置中的“恢复自动连接并忘记原设备”，清除序列号、协议、速度覆盖及原设备绑定。写入授权仍绑定解析后的实际连接。

`probe.list` reads OS USB metadata only: Windows PnP, Linux sysfs, or macOS system_profiler. Windows composite interfaces are grouped by their physical parent. Unknown serial/driver fields remain unknown. Capability preflight checks the selected OpenOCD build with `noinit` before starting a hardware operation. A custom interface script is trusted user code; it must not perform explicit hardware operations during configuration.

`probe.list` 只读取操作系统 USB 元数据；Windows 复合接口按物理父设备合并。无法读取的信息保持未知，不猜测序列号。能力检查使用 `noinit`，不会自动初始化目标。自定义接口脚本属于用户信任的代码，应避免在配置阶段显式操作硬件。

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

Software tests cover enumeration fixtures for all three OS families, identity selection, parameter order, native error classification, worker transport, confirmation binding and HIL success markers. These fixtures do not certify real USB drivers or probe firmware. No physical J-Link OB V9, V10, or Ozone interoperability result is claimed by the software tests. Follow the dedicated-board [HIL procedure](../test/hil/README.md) and record exact identities before adding a hardware-tested compatibility claim.

软件测试覆盖三类系统的枚举样例、身份选择、参数顺序、原生日志诊断、Worker 传递、授权绑定和 HIL 成功标记，但不认证真实驱动或固件。本次软件测试不代表已实测用户的 V9 JLinkOB、V10 或 Ozone 互操作。真实硬件验收须遵循专用板 HIL 流程。
