# EmberProbe

EmberProbe 是一款 VS Code 扩展，基于 OpenOCD 实现嵌入式 MCU 固件的烧录与调试。

## 功能特性

- 自动检测工作区中最新的 ELF 文件。
- 通过 `.ioc`、CMake 和链接文件推断 MCU 目标。
- 自动识别 ST-Link、J-Link、CMSIS-DAP、XDS110、Nu-Link 等调试探针。
- OpenOCD 终端仅展示解析后的关键事件：成功时汇总固件/芯片/Flash/写入校验信息，失败时给出原因与排查建议。
- 在侧边栏汇总编程、校验、复位及错误事件。
- 基于所选的 ELF、探针、目标及可选的 SVD 启动 Cortex-Debug 调试会话。
- 实时变量查看：运行中非侵入读取 Cortex-M 的 RAM；侧栏提供独立的数字查看列表，图表面板提供可折叠、可拖拽的当前数值栏和实时曲线。
- 可选地安装 `mcu-download` 与 `mcu-live-watch` Agent Skill 到当前工作区，分别用于下载固件和读取实时变量。

## 环境要求

- Visual Studio Code 1.80 及以上版本
- OpenOCD
- 用于调试的 Cortex-Debug

## 实时变量查看

侧栏会列出当前 ELF 的全部全局/静态变量，点击变量即可加入独立的数字查看列表；使用命令面板 `EmberProbe: 实时变量查看` 可打开图表面板：

- 原理：以服务模式常驻 OpenOCD，通过 Tcl-RPC 在目标**运行中非侵入地读取 RAM**，变量地址取自所选 ELF 的符号表。
- 使用：先在侧栏选择 ELF、调试器与 MCU 目标；侧栏数字列表和图表变量列表彼此独立。图表面板可从 ELF 导入变量或按名添加，并可调整当前数值栏宽度、折叠数值栏和选择观察类型（u8/i8/u16/i16/u32/i32/f32）。
- 类型支持：标量会优先使用 DWARF 类型信息；结构体与数组会在变量列表中明确标记为复合类型并禁止加入采样，当前暂不展开成员；64 位标量也暂不支持。
- 限制：仅支持 Cortex-M、地址固定的全局/静态变量；采样带宽有限（约 10–50 Hz），高频信号请使用 SWO trace（后续计划）。
- 与烧录互斥：探针同一时刻只能被一个 OpenOCD 占用，请勿与下载/调试会话同时进行。
- 相关配置：`emberprobe.tclPort`、`emberprobe.sampleIntervalMs`、`emberprobe.maxSamples`。

> 本功能为受 [MCUViewer](https://github.com/klonyyy/MCUViewer)（GPLv3）启发的独立实现，未使用其任何代码，与其项目无隶属关系。

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
