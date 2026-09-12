# EmberProbe

EmberProbe 是一款面向 Cortex-M 开发的 VS Code 扩展。它基于 OpenOCD，提供固件烧录、目标自动识别与实时变量观测。

> [English documentation](README_EN.md)

## 功能特性

- 自动检测工作区中最新的 ELF 文件与 MCU 目标。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态。
- ELF文件烧录：一键烧录ELF文件并运行。
- 实时变量观测：在目标运行时非侵入式读取 Cortex-M 内存；侧边栏提供独立数值列表，可同时打开多个拥有独立观察列表和历史缓冲的实时图表面板。
- 实时变量写入：在目标运行时实时更改内存，提供滑条、输入框、鼠标滚轮多种值更改方式，更改后自动回读。
- Cortex-Debug 联动：启动断点调试。
- 可选安装九个 Agent Skills，覆盖固件编程与校验、实时变量读写、SVD 外设调试、Cortex-Debug 会话/断点控制、芯片和故障信息读取、ELF 分析，以及配置同步。

## 环境要求

- Visual Studio Code 1.85 或更高版本
- OpenOCD
- Cortex-Debug 插件(可选)

## 实时变量观测

侧边栏列出当前 ELF 的所有全局/静态变量；点击变量可将其加入独立数值列表。

- 类型支持：标量优先使用 DWARF 类型信息，支持 `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`；结构体、联合体和数组可展开并选择标量叶子成员。
- 64 位精度：`u64/i64` 图表在 ±2^53 外使用 Number 近似值；侧边栏、CSV 和 Agent 结果优先使用精确十进制 `valueText`。
- CSV 导出：采样开始后自动把完整历史写入临时归档，无需另行开启录制；可随时按变量和时间范围流式导出，扩展退出时自动删除内部数据。
- 实时写入：侧边栏可把具有可靠 DWARF 类型且位于 ELF 可写段的标量加入写入列表；写入只在采样会话运行时启用，并在每次写入后回读校验。
- 限制：仅支持 Cortex-M 及固定地址的全局/静态变量；采样带宽有限（约 10–50 Hz）。多面板共享采样启停和间隔，内存占用随面板数线性增长，每个面板分别受 `maxSamples` 限制。
- 相关设置：`emberprobe.tclPort`、`emberprobe.sampleIntervalMs`、`emberprobe.maxSamples`、`emberprobe.samplingArchiveMaxMiB`。

## Agent Skills

侧栏开关开启时在当前工作区安装 EmberProbe Skills，关闭时删除这些技能及共享运行时，保留用户自建技能。不再提供全局安装。`.ioc` 路径选择器直接列出当前工作区内的匹配文件。

- `mcu-flash`：检测并编程最新 ELF，或独立校验片上 Flash；预检和执行结果包含 ELF SHA-256 指纹。
- `mcu-variables`：单次读取、分析趋势、导出图表历史 CSV，或经两阶段确认安全写入标量及复合变量叶子。
- `mcu-chip-info`：按 `identity`、`debug`、`runtime` 分组或指定字段读取芯片信息。
- `mcu-config`：读取或修改 ELF、调试器、MCU、SVD、OpenOCD 和采样参数。
- `mcu-fault-analyzer`：读取并解码 Cortex-M 故障寄存器，并使用当前 ELF 对 PC/LR 进行符号化。
- `mcu-elf-analyze`：离线分析当前 ELF 的 Flash/RAM 占用、段布局和大符号，不占用调试探针。
- `mcu-peripheral-debug`：解析工作区 SVD，查询、读取和解码外设寄存器/位域，并通过每次一次性确认执行暂停态安全写入。
- `mcu-debug-control`：启动、停止和控制 Cortex-Debug 会话，支持暂停/继续/单步/重启以及源码行和函数断点管理。
- `mcu-cubemx`：在 Windows 上经两阶段授权修改已有 `.ioc` 并通过 CubeMX CLI 重新生成初始化代码，包含基线检查、用户代码保护与恢复副本。支持异步生成（`--start` 后用 `--status` 查询、`--cancel --operation-id` 取消）、工作区 JSON 变更文件（`--changes-file`）与显式删除键（`--deletions`）、以及一致性检查（`--check` 快检、`--check --deep` 隔离重生成深检）。

CubeMX 路径位于“MCU 配置 → 其他配置”，插件启动时自动检测并保存为本机全局设置。`.ioc` 默认留空，点击“自动检测配置”后选择工作区工程，也可手动选择或清空。需要与 `.ioc` 版本一致的独立 CubeMX、配套 Java 和已安装固件包；支持在工程根目录或工程内工具链子目录生成，不支持外部路径、链接或生成钩子。授权可选择仅本次或记住当前工程 24 小时，通过 Skill 的 `--reset-permission` 撤销。初始化配置应修改 `.ioc`，业务逻辑放独立源文件或 `USER CODE` 区域；生成成功后仍需使用工程原有构建命令验证。恢复副本保存在工程中的 `.emberprobe-cubemx-*` 目录，确认结果后可自行删除，不应提交到版本库。生成操作记录保存在扩展全局存储中，可在扩展重启后查询 `unchanged / committed / rolledBack / recoveryRequired / unknown` 状态；深检失败时的日志会保留在存储目录中。快检只对比上次提交清单与当前文件，不要求 CubeMX 可用；快检证明“相对记录的变化”，深检证明“当前工具下可再生成的一致性”，两者都不证明构建或硬件行为正确。未确认结果的请求保留 ID，不因超时自动过期；重试前查询状态。已完成请求在下次调用时创建新操作，候选身份包含内容哈希。旧版清单在快检中返回未知，直到确认生成建立新清单。

配置 STM32 target 和 CubeMX 后，侧栏会检查 CubeMX 仓库中的对应系列固件包（含自定义仓库）；选择 `.ioc` 后按其指定版本检查。缺包时可点击“在 CubeMX 中安装”，通过 CubeMX 的原生交互流程完成登录、许可确认及安装。只有 target 时先选择版本；可选版本来自 CubeMX 本机缓存，不代表已验证与工程兼容。返回 VS Code 后重新检查。SVD、CubeMX 和 `.ioc` 均标记为可选。

## 开发与构建

```powershell
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

准备新版本时运行 `npm run release:prepare -- <version> --date YYYY-MM-DD`，脚本会同步版本元数据、README 和 Changelog。推送匹配版本的 `vX.Y.Z` 标签后，Release 工作流会自动创建 GitHub Release 并上传 VSIX；发布及重试方式见 [docs/RELEASING.md](docs/RELEASING.md)。真机测试接入方式见 [test/hil/README.md](test/hil/README.md)。当前扩展版本为 `0.7.5`。

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

### 真实 CubeMX 集成检查

在 Windows 上显式运行 `node scripts/check-cubemx-integration.js <project.ioc> <STM32CubeMX.exe>`，使用已安装的匹配版本及固件包检查根目录和嵌套目录两种生成布局。检查只在临时副本运行，不构建、不烧录、不改原工程；差异会使退出码非零，临时资料路径在输出中保留。普通测试不运行此检查。
