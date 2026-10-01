# Shared OpenOCD groups / 多核共享 OpenOCD

该功能保持实验性；当前验证来自无硬件回归，双核实板验收尚未完成。仅使用现有 OpenOCD controller，不新增原生 SEGGER 后端。

## 配置与启动顺序

先在 EmberProbe 中选择探针、双核目标脚本及 OpenOCD。以下为同一工作区的两核配置示例，替换 ELF 路径，并按实际 `target names` 顺序核对索引：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "CPU 0 launch",
      "type": "emberprobe",
      "request": "launch",
      "executable": "${workspaceFolder}/build/core0.elf",
      "cwd": "${workspaceFolder}",
      "serverGroup": "dual",
      "numberOfProcessors": 2,
      "targetProcessor": 0,
      "rtos": "FreeRTOS",
      "runToEntryPoint": "main"
    },
    {
      "name": "CPU 1 attach",
      "type": "emberprobe",
      "request": "attach",
      "executable": "${workspaceFolder}/build/core1.elf",
      "cwd": "${workspaceFolder}",
      "serverGroup": "dual",
      "numberOfProcessors": 2,
      "targetProcessor": 1,
      "rtos": "FreeRTOS"
    }
  ]
}
```

启动首核并等待 initialized 与成功的 launch/attach 响应后，再启动另一个配置。首个成员也可使用 attach。其他核固件应已部署：加入现有组强制 attach，不自动下载或复位。暂不支持并发 compound 启动；初始化中的成员会使新的加入返回 `DEBUG_GROUP_BUSY`。首核 launch 的默认复位／下载可能影响整个设备。

`serverGroup` 允许 1–64 个字母、数字、下划线、点和短横线，以字母或数字开头；核数须为 2–32。`targetProcessor` 为从零开始的索引；可选 `targetName` 必须与该索引的实际目标名一致。启动时为每个目标配置独立 GDB 端口，选定当前目标，向组内所有目标配置同一个 RTOS，再初始化 OpenOCD。依据 [OpenOCD target 配置](https://openocd.org/doc/html/CPU-Configuration.html) 与 [server 配置](https://openocd.org/doc/html/Server-Configuration.html)；目标脚本决定芯片级复位行为。

组内成员须共享实际工作区、OpenOCD 路径、探针、目标脚本、传输方式、序列号、速度、核数与 RTOS 设置。各核可以有独立 ELF、symbolFiles 和 primary RTOS 符号镜像。当前每个扩展 provider 管理一个物理组；不同组不会绕过探针独占。不同核使用不同 RTOS 的组合尚不支持。

## 会话路由与退出

多个会话出现时，在 RTOS 面板上方选择会话；该选择同时路由侧栏暂停变量读取、外设操作和 Agent 控制。Agent 的 `debug.status` 返回候选 `sessions`；使用 `debug.select` 的 `sessionId`，或 `serverGroup` 加 `targetProcessor` 精确选择。每次选择均限制在当前工作区，歧义时拒绝。CLI 示例：

```text
node <skill-dir>/scripts/debug.js --workspace <workspace> --status
node <skill-dir>/scripts/debug.js --workspace <workspace> --select --group dual --core 1
```

每个会话独立保留运行／暂停状态、DAP 能力和停止任务；未选中核的事件不能改变所选核。切换核增加停止代次，废弃旧变量及 RTOS 读取结果并清空任务表；写入与执行控制期间不可切换。写入授权绑定所选 DAP session 身份。侧栏仍使用用户选定 ELF 的 DWARF 地址，读取／写入前必须与当前核 executable 一致；选择对应 ELF 后重试。RTOS 快照直接使用当前适配器的主镜像。

停止一个核不会停止同组其他成员。最后一个成员退出时停止 OpenOCD，确认进程退出后再释放唯一探针租约；退出未确认则保留租约和服务器引用。启动失败与超时只清理该成员；服务器提前退出会终止所有成员。共享组不支持 restart，请先结束所有会话后重新 launch。多目标运行期 Tcl 采样关闭，暂停读取通过所选 DAP；不承诺跨核同步单步或 SMP 一致快照。用户显式 GDB hooks 按配置执行，其芯片级副作用仍由用户命令和目标脚本决定。

## 验证范围

普通测试覆盖核数／名称／端口、RTOS 参数顺序、加入失败、超时、退出确认与租约保留、多会话暂停／控制隔离、工作区选择、旧结果失效、CLI、ELF 匹配和 RTOS 下拉框。侧栏使用模拟快照检查 320／420 像素预览。测试不连接真实探针，也不证明双核板卡兼容。

专用双核硬件验收需记录 OS、OpenOCD／GDB、目标脚本、两核固件和 RTOS 版本，确认两核分别暂停／恢复／停止、任务表所属核、首核 launch 的芯片复位行为、失败恢复，以及末成员退出后探针可重新独占。遵循 [HIL 指南](../test/hil/README.md)，现有只读 H750 不用于下载、复位或写入验证。

## English

Experimental `serverGroup` shares one managed OpenOCD process and probe lease across per-core GDB/DAP sessions. Start the first configuration, wait for successful initialization, then attach other cores with matching physical settings. Joining never automatically downloads or resets. Select an unambiguous current-workspace session in the RTOS panel or Agent `debug.select`; states and snapshots stay scoped to that session, and sidebar variables require the matching ELF. Groups disable restart and running Tcl sampling. Closing one member preserves the others; final-member cleanup releases the lease only after confirmed process exit. Hardware-independent regressions and simulated sidebar previews do not establish dual-core board support or synchronized SMP snapshots.
