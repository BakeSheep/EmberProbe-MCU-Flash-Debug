# EmberProbe

EmberProbe 是一款面向 Cortex-M 开发的 VS Code 扩展。它基于 OpenOCD，提供固件烧录、Cortex-Debug 调试、目标自动识别与实时变量观测，界面完全中英双语（English / 简体中文）。

> [English documentation](README_EN.md)

## 功能特性

- 自动检测工作区中最新的 ELF 文件。
- 通过 `.ioc`、CMake 和链接脚本推断 MCU 目标。
- 自动识别 ST-Link、J-Link、CMSIS-DAP、XDS110、Nu-Link 等调试探针。
- 在侧边栏检测 OpenOCD 环境并展示其状态；Windows x64 支持一键离线安装，也可指向已有的 OpenOCD 可执行文件。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态；即使选错目标配置，也能从硬件寄存器自动纠正实际的芯片系列。
- OpenOCD 终端只显示解析后的关键事件：成功时给出固件/芯片/Flash/写入校验的摘要，失败时给出原因与排障提示。
- 在侧边栏汇总编程、校验、复位与错误事件。
- 基于所选 ELF、探针、目标与可选的 SVD 启动 Cortex-Debug 调试会话。
- 实时变量观测：在目标运行时非侵入式读取 Cortex-M 内存；侧边栏提供独立数值列表，图表面板提供可折叠、可拖拽的当前值列与实时曲线。
- **中英双语界面**，支持即时切换 - 详见[语言](#语言)。
- 可选安装 `mcu-download` 与 `mcu-live-watch` Agent Skills 到当前工作区，分别用于下载固件和读取实时变量。

## 环境要求

- Visual Studio Code 1.85 或更高版本
- [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug)（仅调试时需要）
- OpenOCD：Windows x64 可在侧边栏一键安装；其他平台请自行安装并选择可执行文件路径

## 快速上手

1. 打开包含 MCU 项目的工作区，并从活动栏打开 EmberProbe。
2. 在 **OpenOCD 环境** 状态卡片中确认环境就绪；若缺失，选择“安装”或“选择路径”。
3. 点击“自动检测配置”，或手动选择 ELF 固件、调试器与 MCU 目标；SVD 文件为可选项。
4. 点击“下载”进行烧录与校验；安装 Cortex-Debug 后可点击“调试”启动调试会话。
5. 在“芯片信息”区点击“读取”，查看芯片内核、系列、Device ID、Flash 容量、UID、调试链路与运行状态。
6. 若要观测运行中的变量，在“实时数值”区从 ELF 变量列表中添加变量并开始采样，或打开图表面板。

## 语言

EmberProbe 提供完全中英双语的界面（English / 简体中文）。

- **切换按钮**：使用 **EmberProbe 侧边栏右上角**的语言按钮在中英文之间切换。它是一个简单的开关（而非下拉菜单），中文激活时显示 `EN`，英文激活时显示 `中`。
- **即时切换**：侧边栏立即重新渲染，无需重载。独立的实时变量图表面板有自己的切换按钮，并与侧边栏保持同步；你的选择会跨会话保存。
- **自动检测**：首次使用时，EmberProbe 跟随你的 VS Code 显示语言 - `zh-*` 区域使用中文，其他区域使用英文。手动切换会覆盖此设置并被记住。
- **覆盖范围**：侧边栏 UI、芯片信息、OpenOCD 环境状态卡片、下载进度日志、实时采样状态、命令错误与 VS Code 通知均已翻译。
- **注意**：`EmberProbe OpenOCD` 伪终端日志摘要与少量底层运行时错误细节仍为中文；常见状态与失败原因为双语。

## OpenOCD 环境

OpenOCD 的检测、缺失、安装进度、校验结果与错误全部在 EmberProbe 侧边栏展示 - 不会用角落通知打扰你。

- **安装**：在 Windows x64 上，使用扩展自带的 xPack OpenOCD 包，离线安装到 VS Code 全局扩展存储目录。
- **选择路径**：选择已安装的 `openocd.exe`（Windows）或 `openocd`（macOS/Linux）；扩展会在保存配置前校验版本。
- **重新检测**：重新检查 `emberprobe.openocdPath` 当前指向的程序。
- **安全替换**：升级自带的 OpenOCD 时，会先解压到暂存目录并校验，因此不可运行的新版本不会破坏现有安装。

OpenOCD 也会在下载、调试或实时观测前自动检查；当其缺失时，EmberProbe 会打开侧边栏并展示修复入口。环境就绪后，状态卡片会自动隐藏，不挡视线。

## 芯片信息

侧边栏“芯片信息”区通过 OpenOCD 单次非侵入式读取基础芯片信息：

- **摘要卡片**：内核名（如 Cortex-M3）、芯片系列（如 STM32F1x）、适配器时钟、内核版本、目标状态与调试探针。
- **详情**（默认折叠）：Device ID、Revision ID、Flash 容量、端序、UID（一键复制）、调试器型号、传输方式、目标电压与 Target name；芯片处于 halt 状态时还会读取 PC/SP/LR 寄存器。
- **智能识别**：根据 SCB CPUID、DBGMCU_IDCODE、Flash 容量寄存器与 UID 寄存器的实测硬件值识别芯片系列，因此即使选错 MCU 目标配置也能显示正确的系列。
- **非侵入式**：仅在读取身份信息时执行短暂的 halt->读取->恢复，绝不会为了读取寄存器而暂停正在运行的程序；读取后立即释放探针。
- **互斥**：与下载、实时观测和调试会话互斥，避免探针争用。

## 实时变量观测

侧边栏列出当前 ELF 的所有全局/静态变量；点击变量可将其加入独立数值列表。使用命令面板项 `EmberProbe: Live Variable Watch` 打开图表面板：

- 工作原理：以服务模式运行 OpenOCD，并通过 Tcl-RPC **在目标运行时非侵入式读取 RAM**；变量地址来自所选 ELF 的符号表。
- 用法：先在侧边栏选择 ELF、调试器与 MCU 目标；侧边栏数值列表与图表的变量列表相互独立。图表面板可从 ELF 导入变量或按名称添加，并可调整/折叠当前值列、选择观测类型（u8/i8/u16/i16/u32/i32/f32）。
- 类型支持：标量优先使用 DWARF 类型信息；结构体和数组在变量列表中明确标记为复合类型，无法加入采样（暂不展开成员）；64 位标量暂不支持。
- 限制：仅支持 Cortex-M 及固定地址的全局/静态变量；采样带宽有限（约 10–50 Hz），高频信号请使用 SWO trace（规划中）。
- 与烧录互斥：探针同一时间只能被一个 OpenOCD 使用，因此不要与下载/调试会话同时运行。
- 相关设置：`emberprobe.tclPort`、`emberprobe.sampleIntervalMs`、`emberprobe.maxSamples`。

> 此功能受 [MCUViewer](https://github.com/klonyyy/MCUViewer)（GPLv3）启发而独立实现；未使用其任何代码，与该项目无任何关联。

## 开发与构建

```powershell
npm install
npm run check
npm run package
```

`npm run package` 先通过 esbuild 将运行时依赖打包进 `dist/extension.js`，再生成 `dist/emberprobe.vsix`。当前扩展版本为 `0.3.0`。

## 项目结构

```text
src/       扩展实现
resources/ Windows x64 OpenOCD 包及其自带的许可证
media/     商城与活动栏图标
skills/    自带的 Agent Skills
test/      轻量解析器测试
esbuild.js 单文件 VSIX 打包构建配置
```

## 许可证与归属

扩展代码采用 MIT 许可证。本项目衍生自 `yingwudao.mcu-vscode` 0.0.2 - 详见 [NOTICE.md](NOTICE.md)；npm 运行时依赖与自带 xPack OpenOCD 的许可证及来源信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
