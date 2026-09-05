# 技术债整改记录

本轮保留原有未提交修改，不修改版本号、标签、远端保护规则，不执行 HIL 或发布。
以下是工作区变更与验证记录；逻辑批次并不代表已经提交或通过远端阶段验收。

## 根因与证据

| 问题 | 根因 | 实施与回归 |
| --- | --- | --- |
| 配置部分提交 | 按字段边校验边写入，后续字段错误时前面的配置已改变 | 完整校验后串行提交；逆序回滚；返回 rollbackErrors 和实际 snapshot。configuration-store、lifecycle-regressions |
| 背压期间提前恢复读取 | 修改列表、恢复调试等入口直接重新启用采样 | SamplingCoordinator 集中裁决；Provider 所有启用入口使用同一约束。lifecycle-regressions、cortex-debug-integration、provider-state |
| Agent 启动失败无法重试 | 就绪前保存 bridge，失败后对象仍被视作已启动 | 共享启动 Promise、生命周期代次、失败关闭服务器、停止等待启动清理。agent-service、lifecycle-regressions |
| 重开面板显示等待 | 初始化使用 DAP 状态，实时广播另行判断托管采样 | 图表和侧栏使用相同采样快照。cortex-debug-integration、webview |
| 取消启动后仍获得探针 | 等待路径/端口期间停止未释放启动租约，旧回调缺少身份检查 | 显式租约及每个异步边界取消检查；旧会话数据/状态/断线事件失效。provider-state |
| CI 重复工作 | 每个平台 check 后 quality/coverage 重跑测试，push 与 PR 重复触发 | 三平台只执行普通检查及 bundle；独立 Ubuntu 质量任务只执行一次覆盖率测试 |
| macOS Run checks 失败 | **未确认具体断言**；已有日志接口返回 403，只能看到失败步骤与退出码 | 增加逐文件 stdout/stderr、耗时、超时、汇总和环境信息，等待同一提交的 macOS 诊断运行 |

历史失败基线：[运行 33880416836](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/actions/runs/33880416836)。
路径真实身份、环境隔离、进程退出与定时器改进均不能单独证明已解决上述 macOS 失败。

## 五个逻辑批次

1. **CI 与诊断**：自动发现普通顶层测试，发布元数据测试独立；语法/测试分离入口；每文件 120 秒上限、失败后继续收集、超时清理进程树；记录 OS/架构/Node/npm/SHA。环境 PATH、HOME、USERPROFILE、OPENOCD_SCRIPTS 隔离，每文件 finally 清理。普通任务 15 分钟、Extension Host 20 分钟；失败上传 14 天。日常 PR/master push/manual，同一分支取消旧任务；发布不取消。
2. **测试与缺陷**：四项已复现缺陷回归；聚合服务测试拆分；源码匹配改 DOM/DAP 行为；状态机注入时钟；进程存活检查注入；随机 TCP 端口；仅允许预期断连错误；真实路径及符号链接越界测试；跨平台进程适配器与真实 Node 子进程 smoke test。
3. **状态与租约**：DebugLifecycle、SamplingCoordinator、WatchListStore 承接生命周期、采样状态和观察列表缓存；删除布尔申请资源接口。列表保存、ELF 选择、配置更新、自动识别、手动刷新统一刷新读取计划及面板；重绑定写入项时保留用户设置的值和范围。
4. **解析与 Webview**：DWARF 拆为 binary/constants/forms/parser/types；新增缺失、损坏、不支持、预算超限 diagnostics，保留原 types/layouts API；损坏后续 CU 保留健康布局。芯片识别拆为 rules/parser/执行入口。Webview 共享 runtime 状态/类型/国际化，独立消息路由、芯片展示和 Canvas 图表展示；保持消息协议及交互。
5. **共享策略与清理**：OpenOCD 版本判断统一到随 Skills 分发的 openocd-policy；Cortex-Debug 启动兼容策略集中到 debugLifecycle；配置清单移至 targetCatalog。删除无调用旧采样接口、空 AgentOrchestrator 和失效辅助方法；同步发布文档。

## 测试删改对照

| 原测试或断言 | 处理及替代行为 |
| --- | --- |
| services.test.js | 删除聚合文件；原配置、Flash、Fault、Agent、ELF、OpenOCD、Skills、LiveWatch、ChipInfo 行为迁至各自 `*-service.test.js` / configuration-store.test.js |
| Cortex-Debug 源码正则、顺序与出现次数 | 替换为完整 Provider 模块加载并模拟 VS Code/DAP 调用、会话事件及可控启动超时 |
| Webview 模板源码、引号、空白、变量名断言 | 替换为锁定 jsdom 26.1.0 的真实 renderer DOM、消息、点击、语言、状态、写入反馈/CSV 行为；Canvas 独立模拟 |
| webview.test.js 中 LiveWatchSession 断线测试 | 保留并迁移到 live-watch-disconnect.test.js |
| feedback-prompt.test.js 模板字符串断言 | 删除，服务语义与国际化测试保留；提示框显示和关闭消息由 webview.test.js 验证 |
| webview-assets.test.js HTML/Provider 源码匹配 | 改 HTML DOM/CSP 指令解析和多 scope 资产隔离；资源来源、nonce、禁止内联脚本安全契约保留 |
| release-workflow.test.js YAML 字符串匹配 | YAML 结构验证，mock gh 验证草稿创建/上传/最后公开、失败不公开、403 不误作不存在、公开版本不修改 |
| decodeSamples / 空 AgentOrchestrator 专用断言 | 生产能力已合并至 decodeConsumerSamples / AgentService，相应行为在 live-watch-service、agent-service、lifecycle-regressions 验证 |
| 固定休眠、假定 PID 不存在 | 调试状态机改可控 fake-clock，归档清理注入存活检查，e2e 改有上限的实际就绪检查 |
| ELF/DWARF、SVD、CSV、授权、协议、安全路径、旧 Skills/指针迁移 | 保留；新增损坏 CU 降级、真实路径别名和越界回归 |

所有新抽出的模块纳入现有覆盖率；原全局阈值 80% 行/语句、75% 函数、65% 分支不变。
三个新协调模块另由 `check-coordinator-coverage.js` 对各模块逐项执行相同阈值；未添加覆盖率排除项维持通过。
原 Provider 与 renderer 排除仍在，但新 runtime/messages/chipView/chart 不再被 Webview 目录的旧整体排除吞掉。

## CI 与发布运维

- `npm run check:syntax` 只检查语法；`npm run test:unit` 只跑普通测试；`npm run check` 两者各一次；`npm run quality` lint/format/typecheck 后覆盖率测试一次。
- `test-results/tests/summary.json` 含环境及每文件退出码、信号、耗时、超时状态；同目录日志保留完整 stdout/stderr。日志中的 runner 自检故意生成 exit 3 / 124，外层该测试文件通过才算成功。
- e2e 固定 VS Code 1.136.1，每次隔离用户和扩展目录；失败日志复制至 `test-results/e2e/logs` 后清理临时用户目录。
- checkout/setup-node v5 的 **Action 自身**使用 Node 24；测试程序仍可由 setup-node 选择 Node 20。自托管 HIL runner 最低版本为 **2.327.1**，来源：[checkout v5](https://github.com/actions/checkout#checkout-v5)、[setup-node](https://github.com/actions/setup-node)。
- HIL 只响应显式手动/既有定时触发，并要求 HIL_ENABLED=true；独立板卡环境、全局互斥、matrix max-parallel=1。当前入口依赖 Node 内置模块及仓库 OpenOCD 参数构造模块，不需 npm 安装；不得从普通 CI 调用。
- Release 复用三平台、质量和 e2e 全部门禁。gates 失败不会进入 build，build 失败不会进入 publish；发布元数据校验仍在打包前。脚本先创建/复用草稿，上传成功才公开；已公开版本保持不变。

## 兼容路径退出条件

| 路径 | 保留依据与范围 | 退出条件 |
| --- | --- | --- |
| Windows Cortex-Debug 1.12.1 短启动超时 | 现有平台/版本恢复策略，限制未完成的 startDebugging 等待；其余平台/版本保持 60 秒 | 不再支持该版本且新版真实初始化/终止回归通过 |
| OpenOCD 最低 0.12.0 / prerelease 判定 | 扩展与独立 Flash Skill 需要相同协议能力 | 最低版本要求变化时只修改共享策略并更新两端行为用例 |
| 旧 Agent 指针、Skills 安装迁移 | 已有用户工作区升级仍需迁移旧目录与描述文件 | 明确退出旧格式支持后才删除；本轮保留测试 |

## 验收边界

本机为 Windows；Node 24 与 Node 20.20.2 分别验证。最终命令结果记录在本文件末尾。
未推送工作区变更，因此没有本轮远端阶段运行链接。Ubuntu/macOS 同一提交通过、同一 SHA 连续三次完整 CI、macOS 具体失败回归仍待远端验收；不通过自动重试掩盖失败。
未运行实际硬件、HIL、真实 Cortex-Debug 探针会话或发布。Provider 仍保留较多 VS Code 事件适配与消息处理，后续可继续收敛；本轮不宣称消除全部技术债。

## 最终本地验证（2026-09-05）

| 验证 | 结果 | 本地证据 |
| --- | --- | --- |
| Windows / Node 20.20.2：`node scripts/run-tests.js`（与 npm run check 相同入口） | 142 个语法/测试文件，0 失败 | `.cache/check-node20.log`、`test-results/tests/summary.json` |
| Windows / Node 20.20.2：`node esbuild.js` | 通过 | `.cache/bundle-node20.log` |
| Windows / Node 24.13.1：`npm run quality` | lint、Prettier、typecheck、56 个普通测试、全局和协调模块覆盖率门禁均通过 | `.cache/quality-final.log`、`coverage/coverage-summary.json` |
| Windows / Node 24.13.1：`npm run test:e2e` | bundle + VS Code 1.136.1，3 项 smoke tests 通过，退出码 0 | `.cache/e2e-final.log` |
| `git diff --check` | 通过 | 工作区检查 |

最终覆盖率：行/语句 **82.63%**，函数 **91.57%**，分支 **71.63%**。
真实 Agent HTTP 服务测试覆盖描述文件写入失败后释放服务器、重试成功、停止清理未完成请求和描述文件。
Windows 沙箱曾阻止 esbuild/Node 20 读取祖先目录（EPERM），以上 Node 20 与 Extension Host 验证经批准在沙箱外完成；这属于本地执行限制，不能用作 macOS CI 失败根因。

| 远端验收 | 状态 |
| --- | --- |
| 批次 1～5 的运行链接 | 尚无；变更仍在本地工作区，未创建五个独立提交 |
| Windows/Ubuntu/macOS 同一提交全绿 | 待推送后的 CI 验证 |
| 同一 SHA 连续三次完整 CI | 待执行，不启用自动重试 |
| macOS 原失败具体断言及对应回归 | 待取得诊断日志，未标记解决 |
| HIL / 真实探针 / Release 发布 | 本轮未执行 |
