# 调试工具链查找

EmberProbe 使用本机的 ARM GDB、objdump 和 nm，无需为 EmberProbe 单独安装一份工具链。调试启动按以下顺序查找：

1. `launch.json` 中的工具路径及 `emberprobe.gdbPath`、`emberprobe.armToolchainPath`、`emberprobe.objdumpPath` 设置；同名 launch 设置优先。
2. 用户之前通过目录选择框选定、保存在当前工作区状态中的工具链目录。
3. VS Code 进程的 PATH；Windows/Linux 启动时若仍未找到，再刷新本机 PATH，以识别 VS Code 启动后安装的工具。
4. 已安装 ST 工具链的常见目录，先检查 ST bundles，再检查 CubeCLT / CubeIDE。
5. 仍未找到时提示用户选择工具链目录；可选择 `bin` 或直接包含 `bin` 的工具链目录。

只有 GDB、objdump 和 nm 都存在且可执行时，候选才会被采用。失效的设置、旧目录和不完整安装会跳过；自动发现可补全显式指定的 GDB 或 binutils 路径。默认工具前缀为 `arm-none-eabi`，自定义前缀仍需匹配实际文件。

## ST 自动发现位置

| 系统 | ST bundles | CubeCLT / CubeIDE 常见父目录 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\stm32cube\bundles`，缺少该环境变量时使用用户目录下的 `AppData\Local` | `C:\ST`，Program Files、Program Files (x86) 和 LOCALAPPDATA 下的 `STMicroelectronics` / `ST` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/stm32cube/bundles` | `/opt/st`、`/opt/ST`、`/opt`、`/usr/local/STMicroelectronics`、`~/ST` |
| macOS | `~/Library/Application Support/stm32cube/bundles` | `/Applications/STMicroelectronics`、`/Applications`、`~/Applications` |

Bundles 检查 `gnu-tools-for-stm32/<版本>/bin`；若其不含 GDB，也会尝试 `gnu-gdb-for-stm32/<版本>/bin` 中的独立 GDB。每类版本按数字降序检查，跳过缺失或不可用的工具。

CubeCLT 检查安装目录下的 `GNU-tools-for-STM32/bin`。CubeIDE 检查 `plugins`、`STM32CubeIDE/plugins` 或 macOS 的 `Contents/Eclipse/plugins` 中 GNU tools 插件的 `tools/bin`。

发现过程只读取固定层级，不运行 ST 命令、下载工具或修改设置。每个目录最多读取 256 项，每次发现最多读取 4096 项，每个目录最多保留 32 个匹配项；非标准安装位置或超出扫描范围时仍可手动配置。

自动发现的路径不写入工作区记录，后续查找可随 ST 工具更新重新发现。用户手动选定的目录仍会被记住。后台 GDB 预热使用相同的本机查找逻辑，但不会启动 shell 刷新 PATH 或弹出选择框。

可直接配置完整工具链的 bin 目录，例如：

```json
{
  "emberprobe.armToolchainPath": "C:/ST/STM32CubeCLT_1.18.0/GNU-tools-for-STM32/bin"
}
```

如果 GDB 和 binutils 分开安装，同时设置 `emberprobe.gdbPath` 与 `emberprobe.armToolchainPath` 即可。复用本地 GDB 不会启动 ST 的调试服务器，EmberProbe 原有的 OpenOCD 或显式外部服务器连接方式保持不变。

## 验证范围

普通测试使用临时目录覆盖三种系统的路径布局、完整与拆分工具包、旧版本排序、缺失文件及查找优先级，不需要连接探针。跨平台目录 fixture 不代表已经在对应系统或真实板卡上完成验证。
