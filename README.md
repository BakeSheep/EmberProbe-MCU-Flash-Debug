# EmberProbe

EmberProbe 是一款面向 Cortex-M 开发的 VS Code 扩展。它基于 OpenOCD，提供固件烧录、目标自动识别与实时变量观测。

> [English documentation](README_EN.md)

## 功能特性

- 自动检测工作区中最新的 ELF 文件。
- 通过 `.ioc`、CMake 和链接脚本推断 MCU 目标。
- 在侧边栏检测 OpenOCD 环境并展示其状态；Windows x64 支持一键离线安装，也可指向已有的 OpenOCD 可执行文件。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态。
- 实时变量观测：在目标运行时非侵入式读取 Cortex-M 内存；侧边栏提供独立数值列表，图表面板提供可折叠、可拖拽的当前值列与实时曲线。
- 可选安装八个 Agent Skills，覆盖固件下载与校验、实时变量读写、芯片和故障信息读取、ELF 分析，以及配置同步。

## 环境要求

- Visual Studio Code 1.85 或更高版本
- OpenOCD

## 实时变量观测

侧边栏列出当前 ELF 的所有全局/静态变量；点击变量可将其加入独立数值列表。

- 类型支持：标量优先使用 DWARF 类型信息；结构体、联合体和数组可展开并选择标量叶子成员，图表也可按数组元素或范围导入；64 位标量暂不支持。
- 实时写入：侧边栏可把具有可靠 DWARF 类型且位于 ELF 可写段的标量加入写入列表；写入只在采样会话运行时启用，并在每次写入后回读校验。
- 限制：仅支持 Cortex-M 及固定地址的全局/静态变量；采样带宽有限（约 10–50 Hz）。
- 相关设置：`emberprobe.tclPort`、`emberprobe.sampleIntervalMs`、`emberprobe.maxSamples`。

## Agent Skills

- `mcu-download`：检测并下载最新 ELF，预检和执行结果包含 ELF SHA-256 指纹。
- `mcu-live-watch`：只单次读取或分析趋势。临时趋势采样的启动、进度与关闭会同步到侧边栏和图表。安装该 Skill 的工作区会自动激活 Agent Bridge。也可添加变量到侧边栏、图表或两者。
- `mcu-chip-info`：按 `identity`、`debug`、`runtime` 分组或指定字段读取芯片信息。
- `mcu-config`：读取或修改 ELF、调试器、MCU、SVD、OpenOCD 和采样参数。
- `mcu-var-write`：按变量名安全写入标量或复合变量叶子成员，使用两阶段确认、ELF 指纹绑定和写后回读校验。
- `mcu-fault-analyzer`：读取并解码 Cortex-M 故障寄存器，并使用当前 ELF 对 PC/LR 进行符号化。
- `mcu-elf-analyze`：离线分析当前 ELF 的 Flash/RAM 占用、段布局和大符号，不占用调试探针。
- `mcu-flash-verify`：读取目标 Flash 并与当前 ELF 的可加载内容进行校验。

扩展通过只监听本机的 Agent Bridge 处理配置和界面联动，并继续统一管理探针互斥。ELF 每次读取都会重新计算内容指纹和解析符号；采样期间 ELF 改变时会中止，避免继续使用旧变量地址。

## 开发与构建

```powershell
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

准备新版本时运行 `npm run release:prepare -- <version> --date YYYY-MM-DD`，脚本会同步版本元数据、README 和 Changelog。推送匹配版本的 `vX.Y.Z` 标签后，Release 工作流会自动创建 GitHub Release 并上传 VSIX；发布及重试方式见 [docs/RELEASING.md](docs/RELEASING.md)。真机测试接入方式见 [test/hil/README.md](test/hil/README.md)。当前扩展版本为 `0.5.3`。

## 项目结构

```text
src/       扩展实现
resources/ Windows x64 OpenOCD 包及其自带的许可证
media/     商城与活动栏图标
skills/    自带的 Agent Skills
test/      单元测试与 OpenOCD Tcl-RPC 集成测试
esbuild.js 单文件 VSIX 打包构建配置
```

## 许可证与归属

扩展代码采用 MIT 许可证。npm 运行时依赖与自带 xPack OpenOCD 的许可证及来源信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
