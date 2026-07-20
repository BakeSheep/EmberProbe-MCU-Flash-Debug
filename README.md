# EmberProbe

EmberProbe 是一款面向 Cortex-M 的 VS Code 扩展，基于 OpenOCD 提供固件烧录、Cortex-Debug 调试、自动目标检测和实时变量查看。

## 功能特性

- 自动检测工作区中最新的 ELF 文件。
- 通过 `.ioc`、CMake 和链接文件推断 MCU 目标。
- 自动识别 ST-Link、J-Link、CMSIS-DAP、XDS110、Nu-Link 等调试探针。
- 在侧边栏检测 OpenOCD 环境并展示状态；Windows x64 支持离线一键安装，也可以选择已有的 OpenOCD 路径。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态；即使用户选错目标配置也能通过硬件寄存器自动识别实际芯片家族。
- OpenOCD 终端仅展示解析后的关键事件：成功时汇总固件/芯片/Flash/写入校验信息，失败时给出原因与排查建议。
- 在侧边栏汇总编程、校验、复位及错误事件。
- 基于所选的 ELF、探针、目标及可选的 SVD 启动 Cortex-Debug 调试会话。
- 实时变量查看：运行中非侵入读取 Cortex-M 的 RAM；侧栏提供独立的数字查看列表，图表面板提供可折叠、可拖拽的当前数值栏和实时曲线。
- 可选地安装 `mcu-download` 与 `mcu-live-watch` Agent Skill 到当前工作区，分别用于下载固件和读取实时变量。

## 环境要求

- Visual Studio Code 1.85 及以上版本
- [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug)（仅调试功能需要）
- OpenOCD：Windows x64 可在插件侧边栏一键安装；其他平台请安装后选择可执行文件路径

## 快速开始

1. 打开包含 MCU 工程的工作区，并从活动栏进入 EmberProbe。
2. 在 **OpenOCD 环境** 状态卡中确认环境就绪；未安装时选择“一键安装”或“选择路径”。
3. 点击“自动检测配置”，或手动选择 ELF 固件、调试器和 MCU 目标；SVD 文件可选。
4. 点击“下载”完成烧录和校验；安装 Cortex-Debug 后可点击“调试”启动调试会话。
5. 在“芯片信息”区域点击“读取”可查看芯片内核、系列、Device ID、Flash 容量、UID、调试链路与运行状态。
6. 如需观察运行中变量，在“实时数值”区域从 ELF 变量列表添加变量并开始采样，或打开图表面板。

## OpenOCD 环境

OpenOCD 的检测、缺失、安装进度、验证结果和错误都显示在 EmberProbe 侧边栏，不会使用右下角通知打断操作。

- **一键安装**：Windows x64 使用扩展内置的 xPack OpenOCD 预置包，可离线安装到 VS Code 扩展全局存储目录。
- **选择路径**：选择已经安装的 `openocd.exe`（Windows）或 `openocd`（macOS/Linux），扩展会先执行版本验证再保存配置。
- **重新检测**：重新检查 `emberprobe.openocdPath` 当前指向的程序。
- **安全替换**：升级内置 OpenOCD 时会先解压到暂存目录并验证，新版本不可运行时不会破坏已有安装。

下载、调试或实时查看前也会自动检查 OpenOCD；缺失时 EmberProbe 会打开侧边栏并显示处理入口。环境就绪后状态卡自动隐藏，不打扰正常操作。

## 芯片信息

侧栏“芯片信息”区域通过 OpenOCD 一次性非侵入读取芯片基本信息：

- **摘要卡**：内核名称（如 Cortex-M3）、芯片系列（如 STM32F1x）、适配器时钟、内核修订、目标状态、调试探针。
- **详细信息**（默认折叠）：Device ID、Revision ID、Flash 容量、字节序、UID（可一键复制）、调试器型号、传输协议、目标电压、Target 名称；芯片已暂停时还会读取 PC/SP/LR 寄存器。
- **智能识别**：通过 SCB CPUID、DBGMCU_IDCODE、Flash 容量寄存器和 UID 寄存器的硬件实测值自动识别芯片家族，即使用户选错了 MCU 目标配置也能显示正确的芯片系列。
- **非侵入式**：仅在读取身份信息时短暂 halt→读取→resume，绝不主动暂停运行中的程序来读取寄存器；读取完成后立即释放探针。
- **互斥保护**：与下载、实时查看、调试会话互斥，避免探针占用冲突。

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
npm install
npm run check
npm run package
```

`npm run package` 会先通过 esbuild 将运行时依赖打入 `dist/extension.js`，再生成 `dist/emberprobe.vsix`。当前扩展版本为 `0.2.1`。

## 项目结构

```text
src/       扩展实现代码
resources/ Windows x64 OpenOCD 预置包及随包许可证
media/     应用市场和活动栏图标
skills/    内置 Agent Skill
test/      轻量级解析器测试
esbuild.js VSIX 单文件 bundle 构建配置
```

## 许可证与来源

扩展代码使用 MIT 许可证。本项目衍生自 `yingwudao.mcu-vscode` 0.0.2，详见 [NOTICE.md](NOTICE.md)；npm 运行时依赖与内置 xPack OpenOCD 的许可证及源码信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
