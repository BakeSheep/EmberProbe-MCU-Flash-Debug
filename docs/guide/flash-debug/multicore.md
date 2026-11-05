# 多核调试

[English](multicore.en.md)

用一个 OpenOCD 和一台探针同时调试芯片的多个核，每个核一个调试会话。**这是实验性功能，还没有经过双核实板验收。**

## 配置

先在 EmberProbe 中选好探针、双核目标脚本和 OpenOCD，然后在 `launch.json` 中为每个核写一项配置。替换 ELF 路径，并按实际 `target names` 的顺序核对索引：

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

| 字段 | 要求 |
| --- | --- |
| `serverGroup` | 组名，1–64 个字母、数字、下划线、点或短横线，以字母或数字开头 |
| `numberOfProcessors` | 2–32 |
| `targetProcessor` | 从 0 开始的核索引 |
| `targetName` | 可选，必须与该索引的实际目标名一致 |

## 启动顺序

1. 启动第一个核，等它初始化完成。
2. 再启动其他核。其他核的固件必须已经部署好：加入组时只会 attach，不下载也不复位。

不支持同时启动多个配置（compound），初始化期间加入会返回 `DEBUG_GROUP_BUSY`。第一个核的 `launch` 默认会复位和下载，可能影响整个芯片。

## 切换核

出现多个会话后，在 RTOS 面板上方选择会话。这个选择同时决定侧栏暂停读取、外设操作和 Agent 控制发往哪个核。

切换后，变量和任务表重新读取。写入和执行控制期间不能切换。

侧栏变量使用选定的 ELF，必须与当前核的固件一致；不一致时选择对应的 ELF 后重试。

Agent 用 `debug.status` 查看候选会话，用 `debug.select` 选择：

```text
node <skill-dir>/scripts/debug.js --workspace <workspace> --status
node <skill-dir>/scripts/debug.js --workspace <workspace> --select --group dual --core 1
```

## 结束

停止一个核不影响其他核。最后一个核退出时才停止 OpenOCD 并释放探针。

## 限制

- 组内成员必须使用相同的探针、OpenOCD、目标脚本、传输方式、速度、核数和 RTOS 设置。各核可以用不同的 ELF。
- 各核使用不同 RTOS 的组合暂不支持。
- 不支持组内 Restart，请结束所有会话后重新启动。
- 组内不能在运行时采样，变量和外设只能在暂停时访问。
- 不保证跨核同步单步，也不保证多核一致的快照。

## 相关文档

- [调试会话设计](../../design/debug-sessions.md)
- [RTOS 调试](rtos.md)
