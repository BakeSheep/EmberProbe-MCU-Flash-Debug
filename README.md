# EmberProbe

EmberProbe 是一款 VS Code 扩展，基于 OpenOCD 实现嵌入式 MCU 固件的烧录与调试。

## 功能特性

- 自动检测工作区中最新的 ELF 文件。
- 通过 `.ioc`、CMake 和链接文件推断 MCU 目标。
- 自动识别 ST-Link、J-Link、CMSIS-DAP、XDS110、Nu-Link 等调试探针。
- 将完整的 OpenOCD 输出流式传输到专用终端。
- 在侧边栏汇总编程、校验、复位及错误事件。
- 基于所选的 ELF、探针、目标及可选的 SVD 启动 Cortex-Debug 调试会话。
- 可选地安装 `mcu-download` Agent Skill 到当前工作区。

## 环境要求

- Visual Studio Code 1.80 及以上版本
- OpenOCD
- 用于调试的 Cortex-Debug

## 开发构建

```powershell
npm run check
npm run package
```

打包后的扩展将输出到 `dist/emberprobe.vsix`。

## 项目结构

```text
src/       扩展实现代码
media/     应用市场和活动栏图标
skills/    内置 Agent Skill
test/      轻量级解析器测试
```

## 许可证与来源

MIT。本项目衍生自 `yingwudao.mcu-vscode` 0.0.2，详见 [NOTICE.md](NOTICE.md) 了解归属与出处说明。
