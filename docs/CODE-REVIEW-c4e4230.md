# EmberProbe 全量代码审查报告

- **审查对象**：`HEAD = c4e4230`（master），工作区干净，**未提交代码已排除**
- **规模**：`src` + `skills` + `scripts` 共 180 个 JS 文件 / ≈47,000 行；约 180 个测试文件
- **方式**：7 个领域并行审计（二进制解析 / 进程执行 / 生命周期并发 / Webview / 配置与性能 / Agent Bridge 与授权 / 烧写与外设写路径）+ Lead 逐条亲验（读码，并对关键断言实际执行模块）
- **改动**：**未修改、创建或删除任何源码文件**；本报告为唯一新增文件
- **静态门禁**：`eslint` 与 `tsc -p jsconfig.quality.json` 均为 **0 错误**
- **局限**：未运行动态测试（`npm run check/quality/bundle/test:e2e` 会写 `test-results/`、`dist/`）；未接触真实硬件，硬件相关结论均为代码级推断

---

## 一、结论速览

| 严重度 | 数量 | 性质 |
| --- | --- | --- |
| P0 设计级 | 1 | 高危硬件操作缺少**强制执行**的人工确认 |
| P1 高 | 5 | 权限边界不一致、故障路径资源泄漏 |
| P2 中 | 19 | 卡死/误报路径、主线程阻塞、可被绕过的加固点 |
| P3 低 / Nit | 35 | 加固纵深、健壮性、性能、可维护性 |

**整体判断**：本项目安全工程水平明显高于同类 VS Code 扩展。未发现可远程利用的漏洞、命令注入（全部 `shell:false` + argv 数组）、路径穿越（zip-slip / tar 均被 `safeZipName` + 逐条 realpath 容器化拦截）、XSS（CSP 非随机数外置化 + 全量转义）或内存越界。真正的风险集中在两类：**① 授权语义（"确认"由调用方自己签发）；② 故障路径上的资源回收（`finally` 抛错、无 SIGKILL 升级导致租约与进程泄漏）**。

---

## 二、P0 设计级

### P0-1 Bridge 高危操作的"用户确认"可被调用方自签 —— 已亲验

**位置**：`src/flashAuthorization.js:54-79`、`src/services/agentFlashService.js:59`、`src/services/agentRoutes.js:26-28`、`src/peripheralWriteAuthorization.js:58-99`、`src/writeAuthorization.js:115-153`、`src/cubemxAuthorization.js:20-36`

无 `confirmationId` 时，`FlashAuthorization.authorize` **生成** ID 并放进 HTTP 响应**返回给调用方**：

```js
if (!id) {
    const nextId = this.createId();
    this.pending.set(nextId, { expiresAt, fingerprint: fingerprint(plan), identity });
    return { authorized: false, confirmationRequired: true, confirmationId: nextId, ... };
}
```

调用方用同一 ID 再调一次即通过：`flash.authorize` → `flash.execute{confirmationId}`。**整条链路不存在任何 VS Code 弹窗**——对 `src/` 全量检索 `showWarningMessage`/`showInformationMessage`/`showQuickPick` 的 `modal: true` 用法，唯一一处是 `src/services/svdManager.js:320`（SVD 覆盖确认），与 flash / 写寄存器 / 写变量 / CubeMX 全部无关。同样的自签模式存在于 `peripherals.write`、`variables.write`、`cubemx.prepare/execute`。

**影响**：任何持有 Bridge token 的实体——被提示注入的 AI agent、工作区内运行的构建脚本或 npm postinstall、同用户其他进程——都能在**零用户交互**下擦写 Flash、改写外设寄存器、改写 RAM、执行 CubeMX 生成并覆盖工程文件。

**公平说明**：这是**有意的设计选择**。`skills/mcu-flash/references/programming.md:12` 明确要求 agent"展示计划并询问用户"，但该要求只是散文约定，扩展侧无强制手段，agent 可在一次 HTTP 往返内自我满足。代码注释声称该机制用于防止"持 token 的进程在用户无感知下静默写入"，该目标并未达成。

**更优实现**：
1. 在 `FlashAuthorization.authorize` / `WriteAuthorization._request` / `SvdPeripheralService._write` / `CubemxAuthorization.request` 中先 `await` 模态确认再签发 ID；对话框经构造函数注入，测试注入 fake，不破坏现有测试结构。
2. 至少为 `flash.execute` 提供**默认开启**的强制确认设置；`remember` 必须由对话框而非请求参数决定（当前 `src/mainViewProvider.js:2357` 直接透传 `params.remember`，agent 可在一次调用内给自己授予 24 小时免确认 RAM 写权限）。
3. 或把确认移到 agent 无法触达的 UI 面（侧边栏"待批准操作"列表）。

---

## 三、P1 高危

### P1-1 `finally` 中抛错导致 `agentRead` 租约永久泄漏，扩展整体卡死 —— 已亲验

**位置**：`src/mainViewProvider.js:2124-2146`

```js
} finally {
    if (temporary) {
        await this._confirmAgentExit(session);      // ← 抛错则下面全部跳过
        if (this._agentReadSession === session) this._agentReadSession = null;
        operationLease?.release();
        ...
    }
}
async _confirmAgentExit(session) {
    if ((await session.stop()) === false)
        throw Object.assign(new Error("OpenOCD exit has not been confirmed"), { code: "PROBE_EXIT_UNCONFIRMED" });
}
```

当 OpenOCD 未在超时内确认退出（USB 卡死 / 进程僵死——恰恰是系统已在出问题的时刻），`_confirmAgentExit` 抛出，其后清理全部跳过：租约不释放、`_agentReadSession` 不复位、`_agentReadCancelled` 不复位、状态不广播。于是 `_agentReadRunning` 永远为真（`src/mainViewProvider.js:410-412`），下载 / F5 调试 / 实时采样 / 芯片信息全部以 `PROBE_BUSY`、`agentReadBusy` 失败。

额外验证两点以确认**无法自愈**：`ProbeCoordinator.reset()`（`src/probeCoordinator.js:102`）在生产代码中**零调用点**（仅测试引用）；`finally` 中抛错会**覆盖** `try` 的返回值/异常——即使 handler 成功，调用方也拿到 `PROBE_EXIT_UNCONFIRMED` 而非结果。该路径**无测试覆盖**（`PROBE_EXIT_UNCONFIRMED` 仅出现在 `test/cpu-load-safety.test.js:294` 的另一条 stop 路径）。

**更优实现**：把释放逻辑放进内层 `finally`：

```js
if (temporary) {
    try { await this._confirmAgentExit(session); }
    finally {
        if (this._agentReadSession === session) this._agentReadSession = null;
        operationLease?.release();
        /* 其余状态复位与广播 */
    }
}
```

并为"退出未确认"的子进程保留重试句柄，而不是跳过释放。

### P1-2 `flash.execute` 接受任意路径 ELF，且 target/probe/transport 可被调用方覆盖 —— 已亲验

**位置**：`src/services/agentFlashService.js:28-47,92-96`、`skills/_emberprobe/elf-file.js:13-14`

`inspectElf` 只做格式与摘要校验（ELF32-LE、常规文件、≤64 MiB、sha256、读取前后 size/mtime 一致性），**不做工作区容器化**（`canonicalFile` 仅做规范化）。因此 `flash.execute { elf: "C:\\Users\\x\\Downloads\\evil.elf" }` 会把磁盘上**任意 ELF32 文件**烧进目标；`request()` 还允许覆盖 `target/probe/transport/probeSerial/adapterSpeedKhz`，仅 `openocd` 可执行文件被钉住（`OPENOCD_EXECUTABLE_MISMATCH`）。

**对比证据（说明这是不一致而非有意例外）**：其他所有接受文件的入口都做了容器化——`config.set` → `src/services/configurationStore.js:84-106` 的 realpath + inside-workspace 检查；`elf.analyze`、断点路径、CSV 导出同样如此。

**更优实现**：在 `AgentFlashService.request()` 中对 `params.elf` 复用 `ConfigurationStore.workspacePath` 的检查；对与 `getConfig()` 不一致的 `target/probe/transport` 覆盖要么拒绝，要么强制在确认摘要中列出。

### P1-3 Agent Bridge 由工作区内容自动启动 —— 审计报告

**位置**：`src/mainViewProvider.js:2501-2506`、`src/services/skillStatusService.js:3-6`、`package.json:44`

`workspaceContains:.agents/skills/mcu-variables/SKILL.md` 是激活事件；激活后 `_syncAgentBridgeWithSkills` 依据 `hasWorkspaceSkills(status)`（= `workspace.state !== "notInstalled"`，部分或被篡改的技能树同样为真）直接启动 HTTP Bridge 并写出 token 描述文件。**无需任何用户点击**即暴露硬件控制 RPC 面。

**边界**：`package.json` 的 `capabilities.untrustedWorkspaces.supported = false` 正确要求受信任工作区，这是真正的防线；与 P0-1、P1-2 组合则构成"恶意仓库 → 自动起 Bridge → 读 token → 自签确认 → 烧写任意固件"的完整链路。

**更优实现**：Bridge 仅在用户显式操作（"管理 Agent Skills"或新设置项）后启动，并在 `startAgentBridge` 内断言 `vscode.workspace.isTrusted`。

### P1-4 外设写白名单完全来自可被 agent 替换的 SVD 文件 —— 审计报告

**位置**：`src/services/svdPeripheralService.js:218-220,886`、`src/services/configurationStore.js:146`

`config.set {svd: "x.svd"}` 无需确认即可换绑 SVD（仅做工作区包含检查），而寄存器写地址完全由该 SVD 声明。仓库内置、设备名与探测芯片匹配（`wildcardMatches`）的 SVD 可声明 `0x00000000–0xFFFFFFFF` 内任意 baseAddress + `access="read-write"`，`assertWritable`（`src/services/svdPeripheralService.js:430-458`）会接受——包括 `0x40023C00`、`0xE000ED00` 等敏感位置。

**更优实现**：为 SVD 声明的寄存器写增加地址策略（仅接受官方库来源的 SVD，或限定 `0x40000000–0x5FFFFFFF` + 内核 PPB）；`config.set {svd}` 纳入确认。

### P1-5 OpenOCD Tcl 端口无认证，存在固定 6666 回退与技能直连通道 —— 审计报告

**位置**：`src/mainViewProvider.js:1427-1434`、`src/liveWatch.js:561-564`、`package.json:132-136`、`skills/mcu-variables/scripts/read.js:573`

`bindto 127.0.0.1` 已正确限制回环，`_waitForTclListening` 也要求 OpenOCD 自报监听行才连接。但：`findFreePort()` 先关监听再交给 OpenOCD，存在本机抢占竞态；失败时回退固定 6666；`emberprobe.tclPort` 一旦显式配置就固定使用（`package.json` 自身描述已在警告）；技能脚本仍保留默认 6666 的直连 Tcl 模式。该通道上的 `halt` / `write_memory` / `program` **不受 token 与任何确认约束**。

**更优实现**：改用 `tcl_port 0` 由 OpenOCD 自选端口并从其 stdout 解析；删除 6666 回退（失败即报错）；移除技能脚本的直连 Tcl 路径。

---

## 四、P2 中危

| # | 位置 | 问题与影响 | 验证 |
| --- | --- | --- | --- |
| M1 | `src/mainViewProvider.js:860-893` | UI 下载路径**完全不校验 ELF**：`elfPath` 直接取自 `workspaceState`，无 `inspectElf`、无摘要、无格式校验。切换工程后残留的 `elfPath` 会被静默烧写。建议 UI 路径也绑定 ELF 摘要并在侧边栏显示 | 亲验 |
| M2 | `src/services/svdLibraryService.js:38-58,250` | `validateSvdBuffer` 在扩展宿主主线程同步执行 `XMLValidator.validate` **+** 完整 `parser.parse`（两次全量遍历，上限 32 MiB）；`list()` 对库中每个 SVD 无缓存重复该过程。导入数个 10–30 MB 厂商 SVD 后打开选择器会冻结 UI 数秒至数十秒。建议按 sha256 缓存、复用 `SvdModelService` Worker、主线程只留尺寸 + DTD 门禁 | 亲验 |
| M3 | `src/dwarf/parser.js:110,221,392-401` | `totalDies` 只在 DIE 循环**内部**自增，而"每 CU 推一条诊断"发生在 DIE 循环之外。构造大量"头部合法但首个属性 form 未知"的 CU 可让 `MAX_DIES_TOTAL` 永不触发，`diagnostics` 无上限增长（64 MiB 段 → 数百万对象）并回传宿主。建议在 CU 循环顶部也计入预算，并加 `MAX_DIAGNOSTICS` | 亲验 |
| M4 | `src/services/configurationStore.js:34` vs `package.json:155`、`src/liveWatchView.js:73`、`src/webview/liveWatch/renderer.js:7` | `maxSamples` 存在**三套区间**（`[100,100000]` / schema `100..360001` / view `100..360001`）；settings.json 填 200000 会让含该键的 `config.set` 事务整体回滚。该设置实际**已死**：唯一宿主侧读者的结果被恒为 true 的 `autoMaxSamples` 短路。建议统一区间并删除该死设置或接通 UI | 亲验 |
| M5 | `src/services/configurationStore.js:63-82` vs `:153-172` | `snapshot()` 不做归一化/校验，而它是 **agent 面向的配置视图**（`config.get`）与失败事务的 `details.actual`。工作区写 `"rtos":"Bogus"`、`"tclPort":0` 会被当作合法配置上报。另 `configuredFrequencyHz(cfg)` 被调用两次，重复 `inspect()` | 亲验 |
| M6 | `src/services/cpuLoadSampler.js:42-55,419` | CPU 采样器**从不读取** `emberprobe.sampleFrequencyHz`：硬编码 `requestedHz:200`、起始周期 5 ms，速率下界为 `effectiveIntervalMs/20`（即配置频率的 20 倍）。`requestedHz/adaptiveTargetHz/effectivePeriodMs/rateMode` 等字段经 grep 确认零消费者 | 审计报告 |
| M7 | `src/services/cubemxRunner.js:39-54` | `stop()` 只发 SIGTERM，无 SIGKILL 升级，且 `cleanup()` 解除看门狗与 abort 监听。CubeMX JVM 忽略 SIGTERM 时 `close` 永不触发、Promise 永不 settle、`jobs` 槽位永久占用 → 该工程后续所有生成/检查报 `CUBEMX_BUSY` 直到重载窗口 | 审计报告 |
| M8 | `src/services/openocdExec.js:126-147` + `src/services/agentFlashService.js:134-135` | `waitForCloseOnTimeout:true` 时 Promise 只在 `close` 事件 settle。若 kill 与 500 ms 后的 SIGKILL 都失败，Promise 永不结束 → `finally` 不执行 → `download` 租约永不释放，探针整个会话不可用。同族的 `openocdRunner.js`/`liveWatch.js` 都做了升级，**只有这里不一致** | 审计报告 |
| M9 | `src/debug/mi.js:158-168` | `fail()` 只 SIGTERM 且不确认退出（`waitForExit()` 存在却未使用），`stop()` 紧接着调用它。GDB 卡在 Python printer 时成为孤儿进程并占住探针 | 审计报告 |
| M10 | `src/services/svdPeripheralService.js:600-616,871-887` | 写事务的 `_guard` 只检测 `agentStatus().epoch` **是否变化**，从不与确认时依据的 `stopEpoch` 比对。"继续运行→再次暂停"会得到相同 session id 与自洽的新 epoch，guard 通过，于是基于**旧暂停上下文**读-改-写的值被写入，可覆盖固件在此期间改动的位域，且回读校验无法发现 | 审计报告 |
| M11 | `src/services/svdPeripheralService.js:211-220,886` | 校验了尺寸与 32 位边界，**未校验对齐**（读路径在 `:655` 却校验了）。非对齐地址的 32 位寄存器写可能被拒绝、向下取整（污染相邻寄存器）或被忽略；后两者在硬件已被触碰后才以回读失败报错 | 审计报告 |
| M12 | `src/elfSymbols.js:284-316` | `count = floor(symtab.size/entsize)` 无上限，64 MiB ELF 可携带约 400 万条符号，每条生成对象 + Map 项并全量保留。Worker 路径有 512 MiB 上限兜底，但 `ElfService.read()` 内联路径跑在宿主线程 | 审计报告 |
| M13 | `src/services/skillStatusService.js:64-71`、`src/mainViewProvider.js:393` | 技能被篡改的告警是**事后、非阻塞、每会话一次**，且由 Bridge 的 `onCall` 触发——即篡改后的脚本**已发出第一次调用**才告警；若上次状态计算时技能树尚匹配则完全静默。而 agent 被文档要求直接执行工作区内的 `node .agents/skills/.../scripts/*.js` | 审计报告 |
| M14 | `src/agentBridge.js:65-73` | 工作区内的指针文件公布 globalStorage 中 token 描述文件的绝对路径；token 文件仅靠 `mode:0o600` 保护，**Windows 上这不是 ACL**，同用户进程可读。指针设计确实避免了 token 随 git/云同步外泄（其声明目标已达成），但不构成权限边界 | 审计报告 |
| M15 | `src/agentBridge.js:59-63` | 未设置 `requestTimeout`/`headersTimeout`、无并发上限与限流。硬件类 handler 内部有超时，但 CPU 密集类（`peripherals.list`、`elf.analyze`，SVD ≤32 MiB / ELF ≤64 MiB + DWARF）直接跑在宿主事件循环上，可被反复调用拖死 UI | 审计报告 |
| M16 | `src/mainViewProvider.js:4296,4257` | 两个调试启动守卫只检查 `_liveWatchRunning || _liveSession`，而 `liveStart` 租约跨越 `prepare()` 交互式 QuickPick 等长操作；此窗口内按 F5 会跳过停止，随后以未翻译的 `PROBE_BUSY (liveStart)` 失败。`_cpuLoadBlocked` 与 download 路径都检查了 `_liveStartPromise`，**只有这两处遗漏** | 审计报告 |
| M17 | `src/services/openocdStatusService.js:80-85` | `resolve()`/`refresh()` 共用 `this.operation` 计数器，而 `await this.probe(target)` 可长达 5 s。并发的状态刷新会让合法的 `_resolveOpenOcdPath` 返回 `null`，所有调用方都解释为"OpenOCD 缺失"，产生虚假报错 | 审计报告 |
| M18 | `src/services/chartHistoryService.js:43-50` | `fail()` 不终止 Worker：失败后 Worker 仍持有最多 512 MiB（默认 `chartHistoryMaxMiB`）图表块与每 scope 的 80 ms 定时器，只有下次启动采样或关窗才回收 | 亲验 |
| M19 | `src/webviewAssets.js:69-100` | **"内容盲"脚本外置让注入脚本也能拿到页面 nonce**：正则把任意良构 `<script>…</script>` 重写为带 nonce 的外置文件并自增 `scriptCount`，而守卫 `scriptOpens !== scriptCount`（`:91`）恒被满足——每次替换恰好消耗一个 `<script` 并自增一次。它能拦住的只有*畸形*标记（标签不配对、脚本体含字面 `</script>`、`<style>`、内联 `on*=`、内联 `style=`）。当前**不可利用**（两模板插值已全部转义或静态化），但函数注释自称 fail-closed，实际是 fail-open 边界 | 亲验 |

---

## 五、P3 低 / Nit

### 加固纵深（安全）

1. `.cmd/.bat` 白名单绕过：`skills/_emberprobe/openocd-launch.js:171-182` 对 realpath 结果未复核，Windows 下符号链接可绕过。
2. `OPENOCD_SCRIPTS` 环境变量优先级高于可执行文件推导目录（`skills/_emberprobe/openocd-launch.js:214-227`）。
3. 解析 → spawn 的 TOCTOU（`skills/_emberprobe/openocd-launch.js:171-182`）。
4. CubeMX 阶段目录内固定文件名（`src/services/cubemxRunner.js:14-26`；父目录为 `mkdtemp`，实际风险低）。
5. `src/skillInstaller.js:235` 的 staging 目录用 `recursive:true` + 可预测名。
6. `src/services/samplingArchive.js:296-311` 导出未做根容器化。
7. `.dwo` 伴随文件的 size+mtime TOCTOU（`src/dwarf/files.js:26-60`）。
8. `flash.verify` 完全跳过确认，会 halt 运行中的 MCU（`src/services/agentFlashService.js:89,101`）。
9. `cubemx.candidate` 无确认地创建文件（`src/services/cubemxCandidate.js:208`）。
10. 24 小时 workspace 信任仅绑定 ELF 摘要 + 连接，**不绑定具体变量集**：一次批准即覆盖该 ELF 内任意地址写 24 小时（`src/writeAuthorization.js:75-92`）。
11. `src/webviewAssets.js:126-136`：CSP 注入是"尽力而为且不校验"，若 `<head>` 带属性或被省略则静默失效，文档退回模板里的 `unsafe-inline` 占位策略（`src/modernView.js:20`、`src/liveWatchView.js:84`）。建议注入后断言策略存在，否则抛错；改用 `/<head[^>]*>/i`；删除模板中的宽松占位 CSP。
12. `src/webview/messages.js:6-14`：无 `event.source`/origin 校验、无逐类型字段校验。CSP + 转义使其当前不可利用。**动手前须先确认 VS Code 的投递机制**，错误的 source 断言会打断全部消息。
13. `ProbeCoordinator.reset()` 在生产代码中无调用点（`src/probeCoordinator.js:102`）——租约泄漏后无恢复手段（与 P1-1 相关）。

### 正确性

14. `src/liveWatch.js:429-437` 用 `Date.now()` 维护周期时间戳环形数组（其他路径均为单调 `hrtime`），时钟回拨会清空速率历史。
15. `src/services/chartHistoryStore.js:64-67` 裁剪时未删除 `block.text` 条目，预算计数低估实际保留量。
16. `src/services/seriesStyleStore.js:7-26` 样式表无淘汰，随符号名无限增长。
17. `src/services/multiRatePlan.js:35-60` 每 tick 分配新 `Set` 与数组。
18. `src/services/cpuLoadModel.js:154,158` `summary()` 内 `shift()` → O(n²)；同类模式见 `src/liveWatch.js:1014,610`。
19. `src/services/deviceIdentityService.js:66-101` 同步递归遍历工作区（`statSync`+`readFileSync`，最多 80×2 MiB）阻塞宿主。
20. `src/webview/sidebar/memoryView.js:17-30,106-107` 假定 payload 字段齐全，缺字段会在消息监听器内抛错（转义本身完整）。
21. `src/mainViewProvider.js:151,4375` `_terminatedDebugSessionIds` 只增不减。
22. `src/services/samplingArchive.js:96,133` `generations` 只增不减。
23. `src/debug/mi.js:119-143` 每行 `slice` 重组缓冲，上限 8 MiB 才失败。
24. `src/dwarf/binary.js:161-199` `.zdebug_*` ZLIB 分支是**死代码**（`REQUIRED_DWARF_SECTIONS` 只含 `.debug_*`）。
25. `src/services/agentFlashService.js:99` 传给 `prepare()` 的第二个参数 `{resolveLaunch}` 被 `src/mainViewProvider.js:384` 的单参包装器**静默丢弃**。
26. `src/mainViewProvider.js:1029` `_authorizeAgentFlash` 为死代码。
27. `src/webview/liveWatch/renderer.js:2651` 的 `$("export").onclick` 被 `:2696` 覆盖（死代码）；因 `CFG.backendHistory` 恒为 true（`src/mainViewProvider.js:2601`），`showLocalExport` 中逐点 `{...p}` 深拷贝不可达——若将来关闭该开关，会在 UI 线程复制最多 360001 个点对象/序列。

### 性能

28. `src/webview/liveWatch/chartControls.js:208-216`：每帧 `写 style.left → 读 offsetWidth → 写 style.top → 读 offsetHeight`（两次强制同步布局）+ 全文档 `querySelectorAll`。
29. `src/webview/liveWatch/renderer.js:1105-1118`：导入对话框每次按键对每个复合符号遍历完整成员布局（大 ELF 下每字符数百万次操作，无防抖）。
30. `src/webview/sidebar/peripherals.js:316-364`：每个读取批次 `tree.textContent=""` 整树重建并重建所有 `<input>`，再靠查询恢复焦点。
31. `src/webview/liveWatch/chart.js:151-357`：`paint()` 任何 dirty 都清空整幅 canvas 并重描所有序列 + 网格 + 10 个刻度标签；仅移动十字线也以 60 fps 全量重绘。
32. `src/webview/liveWatch/renderer.js:909-931`：导入浮层打开时，每个复合样本两次递归 `JSON.stringify` 整棵树（`runtimeTreeShape`）+ `runtimeSelection` 遍历。
33. `src/webview/sidebar/renderer.js:1470-1481`：每 100 ms 全文档 `querySelectorAll("[data-value-name]")`（liveWatch 已有 `valueCells` Map 方案可借鉴）。

### 可维护性

34. `src/services/configurationStore.js:143` 的 `assertAgentSettable({ cubemxPath: value })` 是恒真断言；真正的 `openocdPath` 守卫在上一层 `src/mainViewProvider.js:1037`——**当前安全**，但若将来复用 `ConfigurationStore.update` 就会静默失守。建议改为 `assertAgentSettable(values)` 或在 `commit` 顶部统一调用。
35. `src/mainViewProvider.js:4588` 用 `this.commandHandlers[cmd]`（普通对象字面量，`:120`）做原型链查找，应改 `Object.hasOwn`。
36. 四处确认存储重复实现（`ConfirmationStore.prune` 用 `>= 32`，`WriteAuthorization._prune` 用 `> 32`，容量语义不一致）。
37. 硬编码中文：`src/chipInfo.js:11,27,42`、`src/chip/parser.js:329,331`、`src/openocdInstaller.js:148` 等（英文 UI 下显示中文，而 `chip.reading/timeout/done` 等键在两张表里都存在却未使用）。
38. `.c8rc.json:7` 把 `src/mainViewProvider.js` **排除在覆盖率门禁之外**——全项目最大的文件（5071 行）恰好没有任何覆盖率要求，而 P1-1 这类缺陷正出在这里。
39. `jsconfig.quality.json:14` 把 `src/webview/**` 排除在 `checkJs` 之外，约 5000 行（含 2880 行 liveWatch renderer 与全部 DOM/转义逻辑）不受类型检查。

---

## 六、优化项（按收益排序）

### 性能

1. **`src/services/chartHistoryService.js:53`**（已亲验）：`Buffer.byteLength(JSON.stringify(args))` 在**每个采样 tick** 对整批样本做完整 JSON 序列化，仅为统计积压；紧接着 `postMessage` 又对同一数据做结构化克隆。这是宿主热路径上最贵的操作之一（最高 100 Hz × 面板数）。→ 改用 `src/samplingWorker.js:34-43` 已有的增量估算。
2. **`src/services/svdLibraryService.js:250`**：`list()` 对每个 SVD 做两次全量 XML 遍历且无缓存。→ 按 sha256 缓存 + 移入 Worker。
3. **`src/mainViewProvider.js`**：**5071 行 / 76 个 require / 155 个方法 / 202 个私有字段**的上帝对象，承担路由分发、烧写编排、生命周期、UI 状态。按领域拆分（flash / debug / sampling / peripheral / bridge-routes），并去掉 `.c8rc.json:7` 的覆盖率豁免。
4. **`jsconfig.quality.json:14`**：把 `src/webview/**` 纳入 `checkJs`（可先不开 `strict`）。
5. **`src/webview/liveWatch/chartControls.js:208-216`**：在 ResizeObserver 中缓存度量、读写在序、用 `Map` 索引系列元素；十字线画到叠加 canvas。
6. **`src/webview/liveWatch/renderer.js:1105-1118`**：预建小写成员索引 + 150 ms 防抖。
7. **`src/webview/sidebar/peripherals.js:316-364`**：按寄存器路径复用行/输入框，原地更新值。
8. **`src/services/cpuLoadModel.js:154,158`**：`shift()` → 环形缓冲/头指针（同 `src/liveWatch.js:1014,610`）。
9. **`src/mainViewProvider.js:1898-1910`**：每次暂停态 DAP 读取都无条件 `setSamplingEnabled(false)` + `waitForIdle(2000)`（含每次 `_poll`、`writeAndVerify` 两次）→ 在 `server.samplingEnabled === false` 时短路。
10. **`src/mainViewProvider.js:3614-3627`**：每 tick 每面板重建 `"name [type]"` 字符串与新对象，而 `historyItems` 只在签名变化时改变 → 在 `_configureChartHistory` 预建映射。

### 更优实现（结构）

11. 统一四处确认存储为**一个** `ConfirmationStore` 实现（单次消费 + TTL + 容量上限 + 指纹绑定），消除语义漂移；`FlashAuthorization` 目前把"签发"与"消费"合并在同一方法，正是 P0-1 的结构性成因——拆成 `request()` / `consume()` 后，"签发点必须经过用户确认"才有唯一落点。
12. `snapshot()` 与 `commit()` 共用归一化器（M5），消除"agent 看到的配置"与"校验后的配置"之间的漂移。
13. 统一子进程收尾工具 `terminateWithEscalation(child)`（SIGTERM → 定时 SIGKILL → 无条件 settle），M7/M8/M9 三处属同一模式缺失。

---

## 七、误报澄清与严重度修正

审查中**否决**了 3 条看似严重但经执行/追链证伪的结论，以免误导修复优先级：

| 原始结论 | 结论 | 证据 |
| --- | --- | --- |
| Critical：`cubemxAuthorization.authorize` 在 `remember:true` 且无 ID 时**完全跳过**授权 | **误报** | 实际 `require` 该模块执行：`authorize(plan, undefined, true)` → **抛 `CUBEMX_CONFIRMATION_INVALID`**。早退条件 `!id && !remember && trusted` 要求三者同时成立；`remember=true` 会落到 `confirmations.consume()` 而失败 |
| High：`requestFile` 的重定向目标未做 `ensureSafeUrl` 校验，可降级到明文 HTTP | **误报** | `src/services/officialSvdService.js:169-171`：递归入口第一行就重新校验，每个跳转目标都会被检查（与 `requestBuffer` 等价，仅错误上报方式不同） |
| Critical/High：`AGENT_FORBIDDEN_KEYS` 未拦截 `openocdPath`，agent 可重定向到任意可执行文件 | **误报（Lead 自身假设，已自我否决）** | `ConfigurationStore.commit({openocdPath})` 确实**被接受**，但唯一生产调用点 `src/mainViewProvider.js:1037` 在 `update()` **之前**已调用 `assertAgentSettable(values)`，Bridge 路径实际被拦截。降级为可维护性建议（第五节第 34 条） |

**严重度下调 2 处**：

- "UI 烧写无确认" → **M1（中）**：用户点击"下载"按钮本身即授权，不是漏洞；成立的部分只是**烧写镜像未做身份绑定**。
- "UI 写外设寄存器无确认" → 不计入漏洞：用户直接输入并回车/失焦提交属直接操作，仅建议改为回车提交、失焦回滚（`src/webview/sidebar/peripherals.js:215-217`）。

---

## 八、项目优点（已亲验，值得保留）

- **Webview 加固比多数扩展更彻底**：`src/webviewAssets.js:119-136` 用**权威策略替换**模板内 CSP 并删除重复 `<meta>`（防止注入 `unsafe-inline` 存活），脚本外置为随机 nonce 文件，提取失败即 fail-closed；`default-src 'none'` + 无远程来源。全量扫描 `src/webview` 仅 4 处 `innerHTML`，其中 2 处为静态 SVG，另 2 处（`src/webview/sidebar/memoryView.js:173`、`src/webview/sidebar/renderer.js:1657`）对**每个插值**都调用了 `esc`/`chipEsc`，包括 ELF/DWARF 符号名、SVD 名称与诊断消息。
- **无命令注入面**：全部进程启动使用 `spawn`/`execFile` + argv 数组 + `shell:false`；进入 Tcl 的值经 `quoteTclWord` / `JSON.stringify` / 严格白名单归一化（`adapterSpeedKhz`、`probeSerial`、`rtos`、`targetName`、端口）。
- **Bridge 传输层加固正确**：`randomBytes(24)` token + 长度校验的 `timingSafeEqual` + Host 头白名单（防 DNS rebinding）+ 64 KiB 请求体上限（含流式累加）+ 方法正则白名单 + 仅 `POST /v1/call` + 随机端口 + 回环绑定。
- **一次性确认的指纹绑定严谨**：Flash 绑定 ELF 路径+sha256/transport/probe serial/adapter speed/target/openocd；外设写绑定 SVD sha256 + session id + stop epoch + 每项 address/bytes/previous/written；消费即失效、TTL、容量上限、时钟回拨 fail-closed。
- **ELF 烧写防 TOCTOU 到位**：`skills/_emberprobe/elf-file.js:13-50` 单句柄有界读取、`mkdtemp` + `wx`/0600 私有快照、读取前后 size/mtime 复核、摘要授权前后各校验一次。
- **SVD 写约束严密**：拒绝非 `read-write`、任何 `readAction`、任何 `modifiedWriteValues`，字段位宽/枚举/约束逐项复核，禁止整寄存器与字段写混用，重复目标拒绝。
- **ELF/DWARF/压缩预算体系完整**：`fzstd` 分块计数 + `windowSize`/`contentSize` 预检；`zlib` 均带 `maxOutputLength`；tar 逐条容器化；`yauzl` 用 `validateEntrySizes` + 字节计数流封顶。
- **生命周期绑定整体可靠**：`stopEpoch` 在会话切换/停止/继续/终止时递增，抽查的全部消费点（读写内存、items 读、写快照、控制、轮询、agent 检查、RTOS 快照）都做了校验；Worker 代际握手与 `ProbeCoordinator` 租约内部自洽。
- **工程卫生**：i18n 双语键**完全对齐**（652/652，0 单侧键、0 占位符漂移）；ESLint + tsc 全绿；约 180 个测试文件 + 分组清单强制分类 + 安全模块独立覆盖率门禁。

---

## 九、建议修复顺序

1. **P0-1**：把确认落到扩展侧（模态对话框），并让 `remember` 只能由对话框授予。
2. **P1-1**：内层 `finally` 释放租约（一行级改动，收益最大），并补一条 `PROBE_EXIT_UNCONFIRMED` 路径的测试。
3. **P1-2**：`params.elf` 工作区容器化 + 拒绝不一致的 target/probe/transport 覆盖。
4. **P1-3 / P1-5**：Bridge 启动需显式授权；Tcl 端口去固定化（`tcl_port 0`）。
5. **M2 / M3 / M4**：主线程阻塞（SVD 解析、`list()`）与死设置。
6. **优化项 1 / 2 / 3**：图表历史序列化、SVD 缓存、`mainViewProvider` 拆分并纳入覆盖率。

---

*本报告由只读审查产出：未修改、创建或删除任何源码文件。硬件相关结论未经真实板验证；标注"审计报告"的条目已核对位置与代码片段，但未逐条独立复现。*
