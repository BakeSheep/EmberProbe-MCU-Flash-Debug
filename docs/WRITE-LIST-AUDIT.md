# 写入列表与 ELF 变量浏览器审计

审计日期：2026-10-08。范围：侧栏写入列表、ELF 全部变量浏览器、列表持久化与 Agent Bridge 能力。

## 结论与修复

| 检查项 | 原有行为 | 本次结果 |
| --- | --- | --- |
| 带前缀的写入名称 | 完整前缀和末级名称分行显示，没有用 `.` 缩写 | 写入卡片显示 `.末级名称`，例如 `app::plant.data.voltage` 显示 `.voltage`；悬停和无障碍名称保留完整路径，存储、采样和写入仍使用原始符号身份 |
| 从 ELF 加入查看/写入列表后回到顶部 | 本地操作清空并重建浏览器，保存后后台又回传完整 ELF 快照 | 选择按钮、文本和提示就地更新；本地保存不再回传侧栏列表，所有列表保存不再重复发送 ELF 快照 |
| Agent 加入用户写入列表 | `watch.add` 仅接受 `sidebar`、`chart`、`both`，对应查看列表和图表；没有写入列表接口 | 确认当前不支持；本次没有新增此能力。`variables.write` 是经过写入授权的目标内存操作，不是列表管理接口 |
| 写入时 ELF 窗口闪烁 | 数字输入、加减、滚轮、滑块提交会保存写入列表，从而触发 ELF reset/chunk/types 全量推送 | 保存仍更新持久化状态和采样计划，但不再重复推送 ELF 数据；写入结果继续按请求序号反馈 |

## 同类操作

- 移除查看/写入项、移除复合变量及其成员：改为局部更新 ELF 选择按钮。
- 编辑写入上下限，包括滚轮与文本编辑：共用列表保存路径，不再重复推送 ELF 快照。
- Agent 加入查看列表或图表，以及图表列表保存：同样不再重复发送已有 ELF 快照。
- 调试写入过程中临时禁用、恢复写入控件，以及采样状态变化：只更新控件禁用状态，不重建写入卡片，保留当前输入、滑块和 pending/result 状态。
- 普通标量采样和写入结果：更新值或结果指示，不重建 ELF 浏览器。
- 复合布局解析、类型加载、运行时容器成员形状变化：确实需要更新浏览器结构。先在 DocumentFragment 内构建，再一次替换内容，恢复浏览器的纵向和横向滚动位置。
- 用户修改或清空搜索条件：从第一条筛选结果开始显示。
- ELF 切换或主动刷新仍保留原有加载流程；结果数量缩小、内容暂时为空时，浏览器会自然限制可用滚动范围。

本次没有调整硬件写入规划、授权、地址/类型校验、探针所有权或会话身份绑定。缩略名可能同名，完整路径可通过悬停查看；执行身份不受影响。

## 验证

- `test/write-list-view.test.js`：选择/移除的 DOM 身份、焦点、滚动位置、缩略名与写入身份、状态门控与在途反馈、结构更新恢复滚动、搜索归零、不支持的 Agent destination。
- `test/provider-state.test.js`：列表保存仍持久化、修剪样本、刷新采样计划及同步图表；跳过 ELF 快照和本地侧栏回传。
- `test/cpp-variable-names.test.js`：完整 C++ 路径、缩略显示与原始符号身份。
- Windows x64、Node 24.13.1：`npm run check` 360 项通过；`npm run quality` 通过，覆盖率检查执行 169 项，行/语句 86.05%、分支 83.53%、函数 91.76%，独立服务和安全模块门槛通过。
- `npm run test:e2e`（包括 `npm run bundle`）：通过 VS Code 1.136.1 Extension Host 冒烟测试。
- 本地模拟页在 Edge 无头浏览器的 360px、240px 宽度复核通过；加入查看列表、提交写入值和切换写入门控后，滚动位置保持 2069px，ELF 容器子节点替换次数为 0，行和写入输入框身份保持不变。截图保存在本地 `output/playwright/write-list-360px.png` 和 `output/playwright/write-list-240px.png`。
- 沙箱内的完整测试因临时文件 `realpath`、`rename` 和 `symlink` 的 `EPERM` 失败；沙箱外重跑全部通过。
- 未连接探针或执行实板写入；软件验证不代表硬件兼容性验证。

## 实现位置

- [侧栏 renderer](../src/webview/sidebar/renderer.js)：名称、选择按钮、浏览器结构刷新、写入控件门控。
- [MainViewProvider](../src/mainViewProvider.js)：列表保存及 Webview 同步。
- [Agent 路由](../src/services/agentRoutes.js)：`watch.add` 和 `variables.write` 路由；支持的 destination 由 `MainViewProvider._addAgentWatch` 校验。
- [变量读取技能参考](../skills/mcu-variables/references/reading.md)：`--add-to sidebar|chart|both`。
