# Change Log

All notable changes to the "vscode-plugin-demo" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- 新增侧栏独立实时数值列表：展示当前 ELF 的全部全局/静态变量，点击后加入数字查看，不与图表变量列表互相影响。
- 新增 `mcu-live-watch` Agent Skill，可通过 OpenOCD Tcl-RPC 读取当前实时变量值。

### Changed

- 图表面板自适应 Webview 可用空间，当前数值栏支持折叠与左右拖拽调整宽度，折叠按钮会通过分栏方向和高亮状态区分展开/折叠。
- ELF 变量浏览区支持折叠及从底部分界线拖拽调整高度；变量类型与地址使用对齐列展示。
- 自动检测配置收纳到 MCU 配置区并与手动配置做视觉区分，移除冗余的“推荐”标记与“关键操作”区。
- 图表导入窗口将变量类型、地址和大小拆分为对齐列，并使用跟随 VS Code 明暗主题的遮罩。

### Fixed

- 修复嵌套的“ELF 全部变量”面板折叠后箭头仍保持向下的问题。
- 修复浅色主题下采样间隔输入框出现白色原生微调按钮的问题。
- 修复侧栏与图表的开始/停止采样状态不同步，以及部分 ELF 全局变量无法出现在列表中的问题。
- 结构体和数组现在会被识别为不支持直接采样的复合类型，避免按标量错误读取。

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
