# EmberProbe Roadmap

EmberProbe 的长期定位是：面向 Cortex-M 的烧录、在线观测、故障诊断与 Agent 自动化工具链。

## 当前阶段：0.5 基础产品化

### P0：发布一致性与文档

- [x] 建立版本、锁文件、Changelog、README 和 Skill 清单的一致性检查。
- [x] 更新中英文文档，使其反映复合变量、变量写入和八个 Agent Skills 的当前能力。
- [x] 增加跨平台 CI，在 Windows、Linux 和 macOS 上执行检查与打包构建。
- [x] 增加统一 release 脚本，自动升级版本并生成发布条目。

### P0：架构拆分

- [x] 抽取 `ProbeCoordinator`，集中保存下载、实时采样、芯片读取、Agent 读取和调试启动状态。
- [x] 将探针冲突规则迁入 `ProbeCoordinator`，由租约而非分散布尔判断管理所有权。
- [x] 从 `MainViewProvider` 拆分 `FlashService`、`FaultService`、`AgentService` 和 `ConfigurationStore`。
- [x] 将侧边栏及图表的内联脚本、样式转换为内容寻址的外部资源，并采用 nonce CSP。

### P0：测试体系

- [x] 保留现有解析器和业务单元测试。
- [x] 增加 Fake OpenOCD Tcl-RPC 集成测试，覆盖读取、连续地址合并和写入。
- [x] 增加发布一致性回归测试。
- [x] 增加 VS Code Extension Host 端到端测试。
- [x] 建立 STM32F1/F4、nRF52、RP2040 夜间真机回归矩阵工作流；实际执行需配置带开发板的 self-hosted runners。
- [x] 增加覆盖率、Lint、格式和类型检查门禁。

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

## 多架构方向

近期继续以 Cortex-M 深度能力为主。若正式支持 RISC-V 或 Xtensa，先引入 `ArchitectureBackend`，再分别实现架构相关的寄存器、故障和实时观测能力，避免只支持目标选择却无法使用核心功能。
