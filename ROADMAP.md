# EmberProbe Roadmap

EmberProbe 的长期定位是：面向 Cortex-M 的烧录、在线观测、故障诊断与 Agent 自动化工具链。

## 0.6：在线观测

- 支持 `u64/i64/f64`、枚举、位域、指针和字符串。
- 支持采样录制、CSV/JSON 导出、游标、缩放和统计摘要。
- 支持阈值告警、条件触发和变化捕获。
- 设计统一的长生命周期 `ProbeSession`，减少 OpenOCD 和 USB 重启。

## 0.7：故障诊断

- 恢复 Cortex-M 异常栈帧，识别 EXC_RETURN、MSP/PSP。
- 将 PC/LR 和调用栈映射到 ELF 符号、源文件与行号。
- 增加 FreeRTOS 任务、栈余量及崩溃任务分析。
- 生成与 ELF SHA-256 绑定、可离线复盘的故障报告。

## 1.0：稳定发布

- 完成跨平台 OpenOCD 安装包和来源校验。
- 完成 Agent Bridge、Webview CSP 与变量写入安全审计。
- 发布 Cortex-M 能力矩阵，并对非 Cortex-M 目标进行明确功能门控。
- 稳定 Agent API、错误码和配置迁移策略。

