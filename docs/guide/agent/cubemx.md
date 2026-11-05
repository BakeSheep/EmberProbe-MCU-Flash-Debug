# CubeMX 代码生成

[English](cubemx.en.md)

让 Agent 修改 CubeMX 配置并生成代码，用的是你本机安装的 STM32CubeMX 或 STM32CubeMX2。生成前会先检查，不会静默覆盖你的改动。

## 配置工具路径

在 VS Code **用户设置**中配置，本机所有工作区共用：

| 设置 | 工具 |
| --- | --- |
| `emberprobe.cubemxPath` | STM32CubeMX，用于 `.ioc` 工程 |
| `emberprobe.cubemx2Path` | STM32CubeMX2 启动器（如 `stm32cubemx2-1.1.2.exe`），用于 `.ioc2` 工程 |

留空时自动查找，找到后保存到用户设置，不会替换已保存的路径。Agent 能读取这两个路径，但不能修改。

CubeMX2 自动查找支持 Windows 和 Linux，macOS 暂不支持。

## 选择工程

在侧栏选择 `.ioc` 或 `.ioc2` 文件。工程文件决定使用哪个工具，没有单独的设置。侧栏的固件包检查只适用于 `.ioc` 工程。

## 生成流程

1. 让 Agent 提出修改。这一步只在临时副本上进行，不写工作区。
2. Agent 展示工程和变更，等你在对话中确认。
3. EmberProbe 重新生成当前配置和新配置两份结果，比较后再写回工程。
4. 写回前备份被修改的文件。

可以在确认时选择记住 24 小时，见 [Agent 权限](permissions.md)。

Agent 可用的操作见 `mcu-cubemx` skill 和 [MCP 工具](mcp.md#工具)。

## 用户代码

**`.ioc` 工程**：写在 `USER CODE` 块内的代码会保留。

**`.ioc2` 工程**：生成的源文件没有 `USER CODE` 块。`main.c`、`main.h`、启动文件、链接脚本等归你所有，已存在时不会被覆盖，只在结果的 `warnings` 中列出。其他生成文件归 CubeMX2 所有，改动过会被判定为冲突。

## 处理冲突

`CUBEMX_BASELINE_DRIFT` 表示工程里的生成文件被改过，与工具重新生成的结果不一致。查看错误中的 `details.changes`，并对比 `details.baselineOutput` 下工具重新生成的版本。

常见情况：在 `cmake/stm32cubemx/CMakeLists.txt` 里手动加了源文件，而这个文件是生成的。把它移到你自己的顶层 CMake 文件：

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    Core/Src/stress_test.c
)
```

确认后删除生成列表中手动加的条目，再重新准备。EmberProbe 不会替你移动或丢弃这些修改。

## CubeMX2 的要求

- 必须安装工程记录的 CubeMX2 版本（`mx2Version`）。EmberProbe 不迁移工程。
- 所需的 pack 要在 CubeMX2 界面中安装，EmberProbe 不下载。缺少时报 `CUBEMX2_PACK_MISSING`。
- 不能通过 Agent 新建或删除工程、安装 pack、启用中间件组件。
- 目前只在 Windows 上验证过，尚未提供侧栏配置界面。

## 限制

- 生成成功不代表能编译，也不代表硬件上能跑。
- 工程目录内的符号链接如果涉及 CubeMX 的输入或输出，生成会被拒绝。
- 每次操作的日志和备份保存在扩展存储中，结果的 `diagnosticsPath` 给出位置。

## 常见问题

**写回中断，结果显示 `recoveryRequired`**：备份在 `diagnosticsPath` 的 `backup/` 下，可用它恢复。

**`CUBEMX_EXIT_UNCONFIRMED`**：工具没有确认退出，新的生成会被阻止。用 `cubemx.cancel` 重试结束进程。

**`CUBEMX2_VERSION_MISMATCH`**：安装工程记录的 CubeMX2 版本。

## 相关文档

- [CubeMX 生成设计（英文）](../../design/cubemx-pipeline.md)
- [Agent 权限](permissions.md)
