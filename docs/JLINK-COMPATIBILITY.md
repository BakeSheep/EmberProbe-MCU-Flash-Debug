# J-Link compatibility / J-Link 兼容性

Implementation and software acceptance evidence: [2026-09-21 record](JLINK-IMPLEMENTATION-2026-09-21.md).

EmberProbe uses OpenOCD's J-Link backend. A marketplace label such as “V9 JLinkOB” is not a complete hardware identity. Record the actual OB implementation, firmware and hardware strings, serial number, USB interfaces and their drivers before deciding whether a driver change is appropriate. The audit and upstream references are in [J-Link audit](JLINK-AUDIT-2026-09-20.md).

EmberProbe 使用 OpenOCD 的 J-Link 后端。“V9 JLinkOB”这类网购名称不足以判定兼容性，必须结合实际 OB 型号、固件、硬件字符串、序列号、USB 接口和驱动信息。版本标签不等于驱动兼容保证。

## Configure a connection / 配置连接

Use **Probe connection / 探针连接设置** in the sidebar, or workspace settings:

| Setting | Meaning / 含义 |
| --- | --- |
| `emberprobe.probeSerial` | Decimal J-Link serial / J-Link 十进制序列号 |
| `emberprobe.transport` | Explicit `swd` or `jtag` for J-Link, according to board wiring / J-Link 必须按接线明确选择协议 |
| `emberprobe.adapterSpeedKhz` | Integer kHz; `0` keeps script defaults / 整数 kHz，`0` 保留脚本默认速度 |

The first interactive J-Link connection asks for the transport when it is `auto`. SWD is offered first, but requires selection. Agent calls return `PROBE_TRANSPORT_REQUIRED` instead of opening a prompt. A unique probe with a readable serial may be selected automatically; multiple devices require a serial. Duplicate or ambiguous identities block connection. If a selected probe is absent, EmberProbe does not fall back to another probe. When OS inventory is unavailable, an explicit serial can still be used, with an inventory-unavailable note.

首次交互连接若协议为 `auto`，界面要求选择 SWD/JTAG；Agent 收到结构化错误，不会弹窗代选。可读取序列号的唯一探针可以自动选定，多探针必须指定序列号；重复或不明确的身份会阻止连接。指定探针不在线时不会改连其他探针。操作系统枚举不可用时可使用明确序列号，但枚举结果不视为已验证。

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
