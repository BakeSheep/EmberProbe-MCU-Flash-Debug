# MCP harness 验收：OpenCode（2026-11-05）

结论：**阶段 1、2 通过；阶段 3–6 未验证。** 确认路径尚未在此客户端实测。

| 项目     | 内容                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| 客户端   | OpenCode CLI 与 Bridge 日志均为 `2.2.5`                                                                            |
| 模型     | `stepfun-step-plan/step-5-preview`                                                                                 |
| 运行方式 | `opencode run --standalone --format json`，通过 `OPENCODE_CONFIG_CONTENT` 拒绝 Shell、编辑和 EmberProbe 写入类工具 |
| 目标     | STM32H750 + CMSIS-DAP `LU_2022_8888`，工程 `H750_RTOS_CPP_Test`                                                    |
| 被测构建 | EmberProbe 0.9.0，`mcp-server.js` SHA-256 `0a14c3c82cb0c50340f8aeb87306ffaece2a8c4800694366833ab6b186ed025e`       |
| 脚本基线 | `protocol`、`read` 通过                                                                                            |
| 轮次     | `2026-11-05-opencode-02`                                                                                           |

## 结果

| 阶段       | 结论   | 依据                                                                                             |
| ---------- | ------ | ------------------------------------------------------------------------------------------------ |
| C1–C5 连接 | 通过   | 拒绝规则生效后可见 19 个工具（连接时共 39 个），服务器说明可见，三类权限均未授权，调试和采样空闲 |
| R1–R6 只读 | 通过   | 探针、芯片、变量、采样、外设和缺失符号诊断均与工具原始结果一致                                   |
| 阶段 3–6   | 未验证 | 无人值守运行，没有操作者回答确认；`ALLOW_FLASH` 为 `no`                                          |

Bridge 日志有 17 行，时间 06:47:04–06:47:54（UTC），与回报的 EmberProbe 调用一一对应，没有写入或烧录方法。

## 观察

- 第一轮 `2026-11-05-opencode-01` 作废：`opencode run` 连接了更新前启动的后台服务（`opencode serve --service`，2.1.4），Bridge 日志显示 `opencode/2.1.4`，通过环境变量传入的拒绝规则也没有生效，Agent 能看到全部 39 个工具。该轮没有写入调用。
- `--standalone` 使用私有服务，版本和配置都来自本次运行。用只读工具验证过拒绝规则：`rtos_status` 和 `debug_breakpoints_list` 被拒绝后从 Code Mode 消失，调用报 `Unknown tool`，Bridge 没有收到请求。
- 模型通过 Code Mode 的 `execute` 工具运行 JS，再调用 `tools.emberprobe.*`，所以客户端工具记录里只有 `execute`。核对 EmberProbe 调用要看 JS 内容和 Bridge 日志。
- 工具注解不可见，MCP prompts 不可见。
- `variables_sample` 请求 50 ms，实际间隔约 63 ms。
