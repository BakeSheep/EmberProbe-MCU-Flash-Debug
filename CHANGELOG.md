# Change Log

All notable changes to the EmberProbe extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.4.3] - 2026-07-23

### Added

- Agent Bridge 错误响应新增结构化诊断字段：错误码、分类、失败阶段、可能原因、可重试性、建议动作和 OpenOCD 日志摘要。
- 实时变量与趋势采样可区分探针未找到、目标 MCU 未连接、目标未供电、USB 权限、Tcl 端口冲突、通信超时和 OpenOCD 配置错误。
- `mcu-live-watch`、`mcu-chip-info` 与 `mcu-config` 失败时统一向 stderr 输出机器可读的 `diagnostic` JSON。

### Changed

- `mcu-live-watch` 明确要求 Agent 依据诊断结果推理，禁止把任意读取失败表述为“active Tcl service 未启动”或要求用户手动开启采样。

## [0.4.2] - 2026-07-23

### Changed

- Agent 趋势读取现在可在用户未开启采样时自主启动临时采样，完成后自动关闭并释放探针。
- Agent 临时采样的启动、进度、完成与取消状态会同步到侧边栏和图表；用户可从任一界面提前停止。
- 趋势 Skill 直接通过最新 ELF/DWARF 推断变量类型，并只输出紧凑的趋势汇总，避免源码搜索与冗余逐点输出。
- 用户已开启采样时仍复用现有会话，不会在趋势读取结束后关闭用户的采样。

## [0.4.1] - 2026-07-23

### Changed

- Agent 单次读取全局变量现在只需提供变量名；扩展从最新 ELF/DWARF 自动推断类型，并支持唯一的大小写无关名称匹配。
- 已开启实时采样时复用现有 Tcl 连接；未开启时自动临时启动调试探针，读取一次后立即关闭，不再要求用户手动开始采样。
- `mcu-live-watch` 指令明确禁止在正常单次读取前搜索源码声明，从而减少 Agent 工具调用与 token 消耗。
- 工作区安装 `mcu-live-watch` 后会自动激活 EmberProbe Agent Bridge，无需先打开侧边栏。

## [0.4.0] - 2026-07-23

### Added

- Agent Skills 安装状态现在可区分未安装、部分安装、可更新、本地修改和完整安装，并逐项校验四个 Skill 的必需文件。
- 新增 `mcu-chip-info`，支持按字段或 identity/debug/runtime 分组读取芯片信息。
- 新增 `mcu-config`，允许 Agent 在白名单范围内修改 EmberProbe 配置并立即同步侧边栏。
- `mcu-live-watch` 新增侧边栏/图表变量添加、ELF SHA-256 指纹和上升/下降/稳定/波动趋势分析。
- 新增仅监听本机、按工作区令牌鉴权的 Agent Bridge。

### Fixed

- 修复 Windows 下 `Get-PnpDevice` 权限失败后自动检测直接返回空结果的问题；现在降级使用 `pnputil`。
- 扩充 CMSIS-DAP、DAPLink、MCU-Link、Picoprobe、ST-Link、J-Link、XDS110 和 Nu-Link 的名称匹配与回归测试。
- ELF 符号缓存改用内容指纹；ELF 重建后重新解析变量地址，采样期间文件变化会立即停止。

## [0.3.1] - 2026-07-22

### Added

- 侧边栏「ELF 全部变量」栏目新增刷新按钮：重建 elf 后手动刷新即可看到新增变量，无需重载窗口。符号缓存键加入文件大小，配合 mtime 双重判定，避免仅改内容而 mtime 未变时的脏命中。
- ELF 全部变量数徽标紧贴刷新按钮显示，与标题分离不再拥挤。

### Fixed

- 下载前自动停止实时采样并短暂等待 OpenOCD 进程退出、USB 句柄释放；调试会话（cortex-debug）启动或断开时同样自动停止读取，避免探针争抢。
- 修复图表面板「当前数值」栏宽过窄时地址与实时数值重叠的问题：移除地址可见显示，仅保留为悬停提示。

## [0.3.0] - 2026-07-21

### Added

- 界面双语支持（简体中文 / English）：侧边栏右上角新增语言切换按钮，可在中英文之间即时来回切换，无需重载；实时变量图表面板同样内置切换按钮，并与侧栏语言保持同步，语言选择持久化保存。
- 新增统一多语言词典模块（`src/i18n.js`），主进程与 Webview 共用同一份中英文案，覆盖侧栏 UI、芯片信息、OpenOCD 环境状态卡、下载进度日志、实时采样状态、命令错误与原生通知等。主进程向 Webview 发送结构化的 key + 参数，由 Webview 按当前语言即时渲染。
- 首次使用时按 VS Code 显示语言自动选择界面语言（`zh-*` → 中文，其余 → 英文）；用户手动切换后以手动选择为准并持久化保存。

### Note

- `EmberProbe OpenOCD` 伪终端的日志汇总，以及极少数底层运行时错误细节仍保留中文；常见状态与失败原因均已双语化。

## [0.2.1] - 2026-07-20

### Fixed

- 修复 Windows 上 OpenOCD 探测缓存永不命中的问题（where.exe 解析后的绝对路径与配置原始值比较不等）。
- 修复探针互斥守卫的 TOCTOU 竞态：标志位在首个 await 之后才置位，并发操作可绕过守卫导致探针争抢。
- Windows 上裸命令名通过 where.exe 解析完整路径，修复 PATH 中 OpenOCD 探测失败。

## [0.2.0] - 2026-07-20

### Added

- 新增侧栏「芯片信息」区：通过 OpenOCD 非侵入读取芯片信息，按优先级分层展示——顶部状态（未连接/正在读取/读取完成/读取失败）、芯片系列与内核摘要卡、以及适配器时钟/内核修订/目标状态/调试探针的 2×2 核心网格；次要内容收入默认折叠的「详细信息」，分为芯片信息（Device ID/Revision ID/Flash 容量/字节序/UID 可复制）、调试连接（调试器/传输协议/适配器时钟/目标电压/Target）与运行信息（目标状态/PC/SP/LR，仅在芯片已暂停时读取寄存器，绝不主动暂停运行中的程序）。

## [0.1.2] - 2026-07-20

### Added

- 新增 OpenOCD 侧边栏状态卡，集中展示检测、安装、验证和错误状态，并提供一键安装、选择路径与重新检测操作。
- Windows x64 版本内置 OpenOCD 离线预置包，安装前验证可执行文件，失败时保留原安装。
- 新增侧栏独立实时数值列表：展示当前 ELF 的全部全局/静态变量，点击后加入数字查看，不与图表变量列表互相影响。
- 新增 `mcu-live-watch` Agent Skill，可通过 OpenOCD Tcl-RPC 读取当前实时变量值。

### Changed

- 图表面板自适应 Webview 可用空间，当前数值栏支持折叠与左右拖拽调整宽度，折叠按钮会通过分栏方向和高亮状态区分展开/折叠。
- ELF 变量浏览区支持折叠及从底部分界线拖拽调整高度；变量类型与地址使用对齐列展示。
- 自动检测配置收纳到 MCU 配置区并与手动配置做视觉区分，移除冗余的“推荐”标记与“关键操作”区。
- 图表导入窗口将变量类型、地址和大小拆分为对齐列，并使用跟随 VS Code 明暗主题的遮罩。
- 扩展运行时代码改为单文件 bundle，确保 npm 依赖完整进入 VSIX；最低 VS Code 版本调整为 1.85。

### Fixed

- 修复嵌套的“ELF 全部变量”面板折叠后箭头仍保持向下的问题。
- 修复浅色主题下采样间隔输入框出现白色原生微调按钮的问题。
- 修复侧栏与图表的开始/停止采样状态不同步，以及部分 ELF 全局变量无法出现在列表中的问题。
- 结构体和数组现在会被识别为不支持直接采样的复合类型，避免按标量错误读取。
- 修复首次安装或选择 OpenOCD 后当前操作仍使用旧路径，以及工作区配置遮蔽全局配置的问题。
- OpenOCD 缺失提示和安装进度改在侧边栏展示，不再从右下角弹出通知。

## [0.1.1] - 2026-07-17

### Added

- 实时变量查看：解析 DWARF 调试信息，在“从 ELF 导入变量”列表中显示各变量的 C 类型（如 float / uint16_t），并据此设定默认观察类型（float→f32）
- 导入列表提升显示上限并显示变量总数，避免变量被静默截断

### Changed

- 无 DWARF（未用 -g 构建）时类型按大小推测，并在导入列表给出提示

## [0.1.0] - 2026-07-17

### Added

- 新增「实时变量查看」：以 OpenOCD 服务模式 + Tcl-RPC 在 Cortex-M 运行中非侵入读取 RAM，按 ELF 符号显示变量数值并绘制实时曲线
- 独立面板支持从 ELF 导入变量、按名添加、选择类型（u8/i8/u16/i16/u32/i32/f32）、可调采样间隔
- 新增纯 JS 的 ELF32 符号解析与 OpenOCD Tcl-RPC 内存读取（受 MCUViewer 启发的独立实现，未使用其代码）
- 新增配置项 emberprobe.tclPort / emberprobe.sampleIntervalMs / emberprobe.maxSamples
- 实时查看与烧录互斥，避免探针占用冲突

## [0.0.4] - 2026-07-17

### Changed

- OpenOCD 终端不再镜像原始输出，改为逐行解析关键事件
- 成功时汇总展示固件名、芯片/器件 ID、Flash 容量、探针、适配器时钟、写入与校验字节数及耗时
- 失败时解析并列出错误原因，并按错误类型给出排查建议（配置脚本缺失、端口占用、连接失败、供电异常、JTAG/SWD 链路、USB 驱动、超时、读保护、Flash 写入/擦除、校验、未停机等）

## [0.0.3] - 2026-07-17

### Fixed

- 修复 ELF 路径含空格时 OpenOCD program 命令解析失败的问题
- 修复 Nu-Link 调试探针无法自动识别（设备名含连字符）
- OpenOCD 终端日志按行解析着色，正常输出不再全部标红
- 调试会话复用 emberprobe.openocdPath 配置，启动前检测 Cortex-Debug 扩展
- 移除 MCU 列表中的 OpenOCD 自测配置项（faux、test_syntax_error 等）
- 修复 QuickPick 取消时资源泄漏、下载可并发执行、进度消息丢失等问题
- Agent Skill 脚本补充 gd32e23 识别规则，配置名校验兼容非 ASCII 名称
- 资源管理器右键菜单仅在文件夹上显示

## [0.0.2]

- Initial release
