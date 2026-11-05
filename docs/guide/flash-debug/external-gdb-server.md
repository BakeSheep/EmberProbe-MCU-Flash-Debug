# External GDB server / 外部 GDB server（实验性）

仅支持用户已启动的 Cortex-M / ARM32 TCP GDB server，使用 EmberProbe 内置调试器进行 attach。该功能默认关闭，通过 VS Code 原生设置配置；插件侧栏、右键和 Agent 的启动调试入口仍使用 OpenOCD。

## 配置与使用

在目标工作区或文件夹的 VS Code 设置中配置：

```json
{
  "emberprobe.experimental.externalGdb.enabled": true,
  "emberprobe.experimental.externalGdb.target": "127.0.0.1:3333",
  "emberprobe.experimental.externalGdb.connectionMode": "extended-remote"
}
```

`target` 必须为 TCP `host:port` 或 `[IPv6]:port`，端口范围 1–65535；不接受串口、URL 或管道命令。`connectionMode` 支持 `remote` 与 `extended-remote`。设置按实际调试文件夹读取，启动时冻结；修改地址不会改变活动连接。开关本身不切换现有调试入口。

在 `launch.json` 添加独立配置，通过 VS Code 的 Run and Debug / F5 选择启动：

```json
{
  "name": "External GDB attach",
  "type": "emberprobe",
  "request": "attach",
  "servertype": "external",
  "executable": "${workspaceFolder}/build/app.elf"
}
```

需可信工作区、与目标固件匹配的本地 ELF，以及现有工具链配置（GDB 与 objdump）。沿用 `emberprobe.gdbPath`、`emberprobe.armToolchainPath` 等原生设置，以及 launch.json 中已有工具链、symbols、source map、printer 和显式 attach hooks。服务器地址与模式只能在原生设置中配置；launch.json 不能提供 `gdbTarget`、`serverpath`、`serverGroup` 或 OpenOCD 选核参数。

连接会确认目标停止状态；若仍在运行，会尝试中断并等待停止，因此 attach 可能暂停目标。支持断点、调用栈、变量、STL、暂停/继续/单步和暂停内存读取。暂停侧栏与 Agent 读写使用选定 DAP 会话，侧栏地址读取和变量写入要求选定 ELF 与会话 ELF 一致，写入保留现有授权及读回验证。RTOS 线程由服务器提供；FreeRTOS 快照依赖匹配 ELF 和可确认的内核布局，不会为外部服务器配置 RTOS。

不支持 launch 下载、自动复位、restart、多核共享、运行期非侵入采样、SWO/RTT 或服务器/驱动管理。不会默认发送 OpenOCD monitor 命令；用户显式 attach hooks 仍按配置执行，请自行确认其服务器兼容性和目标副作用。

## 退出与恢复

1. 在 VS Code 停止调试。插件尝试断开 target 连接并退出本地 GDB，不发送 detach、目标 kill 或 monitor exit。目标退出后的实际状态取决于服务器。
2. 自行停止外部服务器，确认它已释放探针。
3. 在该调试文件夹的原生设置中关闭 `emberprobe.experimental.externalGdb.enabled`。
4. 待当前会话和本地 GDB 清理确认完成后，手动使用原有采样、烧录或 OpenOCD 调试入口；不会自动恢复物理采样。

外部连接尝试后会保存占用保护标记。断开、连接失败或扩展重载不会自动解除；保护期间阻止本插件竞争探针的硬件操作与驱动切换。仅开启设置但未尝试外部连接，不阻止原有功能。关闭开关不强行终止活动会话；若本地 GDB 退出未确认，保护继续保留。异常 adapter 退出后可在确认本地 GDB 已退出后重载工作区，插件检查已记录进程是否仍存活；未能记录进程身份时保守保留保护。

保护仅约束当前扩展实例，不能阻止其他应用或 VS Code 窗口使用同一探针。TCP 可达与否不代表物理探针已释放。

## 验证边界

普通测试覆盖原生设置、隔离编排、占用持久化、线程绑定、ELF 检查、写入身份及退出清理。`test/gdb/external-debug.test.js` 使用真实 ARM GDB 与内存 RSP fixture，验证两种连接模式、暂停读写、断开与同服务器重连；fixture 不连接硬件，拒绝 monitor 命令。Extension Host 测试覆盖 F5 attach、能力更新、Stop 和关闭开关解除保护。

这些测试不证明 J-Link、ST-LINK、pyOCD 等具体服务器或板卡的兼容性。实板验收须单独记录 OS、GDB/server 版本、探针、板卡、固件与停止后的目标状态，并遵循 HIL 授权要求。

## English

Experimental external attach uses EmberProbe's native debugger to connect to an already running Cortex-M / ARM32 TCP GDB server. It is disabled by default. Configure the three `emberprobe.experimental.externalGdb.*` keys in VS Code settings for the actual debug folder, then select an explicit `servertype: "external"`, `request: "attach"` configuration through Run and Debug / F5. Existing sidebar, Explorer and Agent startup commands keep using OpenOCD.

Provide a matching local ELF and the existing GDB/objdump toolchain configuration. Addresses must be `host:port` or `[IPv6]:port`; serial, URL and pipe targets are rejected. Connection settings are frozen at startup, and launch.json cannot override the endpoint/mode or supply OpenOCD server/core options. Breakpoints, stack frames, variables, STL and execution control reuse DAP/MI. Attach may interrupt the target to establish a confirmed paused state. Paused sidebar and Agent memory operations use the selected session, require matching ELF identity, and retain write authorization, stop-generation checks and read-back verification. Server-provided RTOS threads and bounded FreeRTOS snapshots depend on the server and matching symbols; EmberProbe does not configure the external server's RTOS.

Launch downloads, automatic reset, restart, shared multicore groups, running Tcl sampling, SWO/RTT and server/driver management are unsupported. No OpenOCD monitor commands are sent implicitly; explicit attach hooks remain user-controlled.

Stop closes the GDB target connection and the local GDB process, without detach, target kill or server exit commands. The server remains user-owned. After any connection attempt, a persistent probe hold prevents competing hardware operations and automatic sampling recovery. Stop the external server yourself, disable the experimental setting in that debug folder, wait for session/GDB cleanup, then manually use the existing hardware functions. Disabling does not terminate an active session; unconfirmed local GDB cleanup retains the hold. The hold survives extension reloads, applies only to this extension instance, and cannot arbitrate other applications or windows.

Hardware-free unit, Extension Host and real ARM GDB/RSP tests do not establish compatibility with specific probe servers or boards. Record real-board acceptance separately with server/toolchain versions and the target state after Stop.
