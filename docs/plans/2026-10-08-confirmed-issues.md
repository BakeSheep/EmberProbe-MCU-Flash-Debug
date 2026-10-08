# Confirmed Issues Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 本会话使用已安装的 executing-plans 工作流；用户已授权实施，沿用当前工作区并保留已有文档，不创建额外会话或提交。

**Goal:** 修复汇总中的 I01–I14，并对 T01–T04 和可明确验证的 E 类加固落实安全、兼容的实现。

**Architecture:** 保留 probeCoordinator 和会话/暂停代次保护。区分采样停止、进程关闭与硬件租约释放；增加有界子进程终止、输入预算及扩展侧人工批准，不将错误响应结束等同于硬件已空闲。

**Tech Stack:** ES2022 CommonJS、Node 20/24、VS Code 1.85、Worker threads、内置 assert 测试。

---

## Task 1: 采样取消和断开状态（I01–I03、I12）
- 修改 src/mainViewProvider.js、src/liveWatch.js、src/services/samplingCoordinator.js 和双语提示。
- 先加入 ELF 等待期间停止、Agent prepare/端口期间取消、断开关闭尚未确认的回归用例。
- 任何 await 后的旧操作不得改写意图、创建新硬件会话或提交迟到数据。
- stop 立即停读并显示关闭中；仅确认退出后显示断开完成；失败保留句柄/租约并允许重试。
- 调试接管使用同一停止/取消等待流程。
- 验证：provider-state、agent-sampling-control、live-watch-integration、external-debug-host、cortex-debug-integration。

## Task 2: 解析结果与状态发布解耦（I04）
- 修改 src/services/openocdStatusService.js。
- 并发 refresh 不得使有效 resolve 返回 null；旧 UI 发布仍受代次保护。
- 验证：openocd-status-service 并发同路径/不同路径用例。

## Task 3: 故障收尾（I05、I06、I13）
- 为 CubeMX/GDB 增加终止升级与退出确认；进程未退出时保留工作占用和停止重试。
- 图表 fail 主动终止 Worker，restart/dispose 等待同一终止流程。
- 验证：cubemx-generation-safety、cubemx、debug-mi、external-debug、chart-history。

## Task 4: 输入预算和对齐（I07、I08、I11）
- 为 DWARF CU/诊断和 ELF 符号/字符串遍历增加独立预算。
- 在 SVD 读写计划阶段拒绝不支持的访问宽度/非对齐地址。
- 验证正常编译器产物、压缩 DWARF、损坏头放大、符号超限和非对齐读写，无实际硬件。

## Task 5: 设置与烧写镜像（I09、I10）
- 统一 maxSamples 范围；明确迁移到已有的自动历史/内存预算，避免继续呈现有效却无效的设置。
- UI 在准备连接前生成有摘要的私有 ELF 快照，仅消费该镜像并安全清理。
- 验证配置事务、镜像在准备期间变化、读取失败和退出清理。

## Task 6: XML 后台处理（I14）
- 复用 SVD Worker 执行库校验，按摘要/设备身份缓存和去重。
- 避免 list/findCompatible 重复完整解析；读入前检查尺寸。
- 验证缓存、损坏/超限输入、Worker 失败和正常自定义 SVD。

## Task 7: 独立批准和信任边界（T01–T04）
- 注入 VS Code 批准服务；敏感 Agent 操作必须经过扩展 UI 的实际批准。
- 保留既有 confirmationId、摘要/目标/连接/代次/原值绑定；记住许可由批准选项决定。
- verify 的临时 halt 也走批准；自定义 SVD 保留支持并显示来源及地址。
- 删除自动随机端口失败后的 6666 回退，保留显式端口配置及回环绑定。
- Bridge 明确拒绝未受信任工作区；调用前检查技能改动，并按当前内容批准自定义版本。
- 更新 docs 和共享技能工作流，保持用户显式授权语义。
- 验证拒绝、过期/目标变化、记住选择、并发请求与测试注入批准器；不执行真实硬件操作。

## Task 8: 可验证的工程加固（E 类）
- 清理接口丢参/死代码，统一确认容量，补齐消息和部分渲染校验、本地化。
- 对同步扫描、长会话缓存和热路径采用有预算的改进，保留迟到事件/历史隔离语义。
- 质量检查范围按实际错误修复推进；性能改动以测量/回归为依据，不做无收益大重构。

## Task 9: 文档与完成验证
- 更新问题汇总为实施状态及验证证据，不改 README。
- 运行 npm run check、npm run quality、npm run bundle、npm run test:e2e。
- GDB/镜像改动另运行相关 test/gdb/ 入口，使用 CI 的本机工具链。
- 输出修改内容、验证结果及尚未完成的实板验收。

## 实施结果（2026-10-08）

- Task 1–7 完成：I01–I14 已整改，T01–T04 已采用独立 UI 批准和明确的本机信任策略。
- Task 8 的可验证加固完成；终止会话/归档代次的进一步容量策略、完整 provider/webview 类型及覆盖率范围、未量化图表热路径重构保留为后续工程项，详见问题汇总第七节。
- Task 9 完成：check（363 项，0 失败）、quality（含人工批准服务独立门槛）、bundle、Extension Host E2E、ARM 枚举/DWARF 组合和外部 GDB 模拟服务器检查全部通过，git diff --check 通过。
- 验证环境：Windows、Node 24.13.1、已安装 ARM GNU 工具链。所有目标读取/写入接口均为模拟；没有执行 HIL、真实固件编程、驱动切换或发布。
- 回归额外覆盖：重复启动现有采样会话继续接收有效样本、退出失败后重试、批准期间计划变化和权限重置使待确认弹窗失效。
