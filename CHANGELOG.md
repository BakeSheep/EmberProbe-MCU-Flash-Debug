# Change Log

All notable changes to the "vscode-plugin-demo" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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