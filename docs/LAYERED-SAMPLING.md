# 分层采样与静默历史

| 消费者                               | 目标频率            | 原始历史                            | 绘图                       |
| ------------------------------------ | ------------------- | ----------------------------------- | -------------------------- |
| 波形窗口观察变量（含已选择标量成员） | 用户设置 0.1–200 Hz | 最近 30 分钟内存历史 + 完整磁盘归档 | 仅计算可见曲线             |
| 波形窗口静默变量                     | 同上                | 同上                                | 重新开启时读取当前视口历史 |
| 仅侧栏观察或写入卡片                 | 固定 20 Hz          | 无                                  | 当前值                     |

全局启停保持原操作。改变波形目标频率不会改变侧栏独有变量的目标；两者同轮到期时合并读取，同名侧栏变量复用不足 50 ms 的原始结果。样本携带消费者归属和原始采集时间，侧栏额外读取不计入波形归档。探针负载高时两组受现有自适应降速限制。暂停调试目标后的 DAP 快照仍遵守至少 250 ms 间隔。实验性不限速采样见 [UNLIMITED-SAMPLING.md](UNLIMITED-SAMPLING.md)。

## 历史与导出

隐藏仅控制绘图，继续采样、记录及更新当前值（最多 20 Hz）。重新显示保持已有缩放与时间窗口；“全部”使用当前窗口全部观察变量的最近 30 分钟边界。移除变量停止采样，已记录数据仍能从完整归档导出。改观察类型重置该曲线的实时历史，完整归档按类型分别保留。

静态复合变量（例如 `app::g_pid`）加入波形窗口后，整块读取中的可观察标量成员立即作为静默通道记录，无需先点击成员绘图。稍后开启成员可恢复从父变量开始采样以来的保留历史，冻结及 CSV 同样包含这些成员。父变量与单独选择的同一成员每批只记录一次，不增加静默成员的硬件读取；移除父变量释放其隐式历史，单独保留的成员继续记录。运行时对象仍遵守现有成员选择、寻址及读取预算规则。

历史 Worker 每块最多保存 4096 点，尾块从 64 点开始按需倍增：Float64 时间、Float64 数值、Uint8 缺失标记，非 Number 等价的精确文本另存。按最新采集时间保留 30 分钟，每通道上限 360,001 点；降低采样率不删除窗口内的旧高频点。暂停期间不进行时间淘汰。`emberprobe.maxSamples` 已弃用且不覆盖用户配置值。

`emberprobe.chartHistoryMaxMiB` 默认 512 MiB，范围 64–4096 MiB。预算按实际分配容量计算，包含被冻结或导出引用保留的缓冲块。先释放过期块，再通过增量堆索引优先淘汰近 5 秒采集时间内未被实时视口请求的通道块，同类按最旧块优先；触及预算时尽量释放 5% 余量，缩短内存保留范围；仍不足时整批跳过内存写入。历史 Worker 队列背压也整批丢弃内存批次并标记断点，均不停止或暂停采样与磁盘归档。UI 每次采样启动或清空后仅提示一次内存历史受限或不完整，并使用实际保留时间边界；冻结快照保持完整。释放快照、减少观察变量或调整预算后可继续保留新样本；新开启且内存历史已淘汰的曲线会通过归档恢复路径重建。历史 Worker 真正故障时自动重启并从磁盘归档重建当前窗口、会话及清空代次的最近 30 分钟；每次采样启动或清空后最多重试 3 次，单次最多 30 秒，只有恢复失败才报告本地化错误。重建同样遵守内存预算；恢复期间归档继续写入，暂停内存追加以避免恢复被并发修改取消，随后做一次增量追赶，尚未追上的样本保留断点提示。磁盘归档容量及扩展退出清理策略保持原有配置；磁盘故障或容量耗尽也会暂停采样。

冻结通过引用固定后台历史范围，包含已有静默变量。采样与当前值继续更新，冻结后开启静默曲线查看冻结历史，新变量恢复实时后显示。清空取消待发当前值、视口请求和冻结快照，重置当前窗口/会话的归档代次；其他窗口不受影响。

导出统一使用完整采样归档，默认导出用户勾选变量从开始采样或上次清空历史以来的全部原始采样点，包含超过内存保留范围的历史和已移除变量的数据。冻结只影响图表查看，不改变导出来源；仍可选最近一段时间或自定义时间范围。用户无需区分磁盘归档、内存保留数据和冻结快照，像素绘图数据不用于导出。保存对话框打开期间发生清空历史或切换会话会取消旧导出，避免导出另一代历史。Agent 的归档 CSV 请求接口保持原有方式；侧栏独有变量不再产生归档记录。

## 数据流与竞态

运行时写入：批次中每项地址均按 4 字节对齐且恰好 4 字节时，只执行写前读取、直接 32 位字写入和回读，不查询或改变目标运行状态。其他写入在独立模式下暂停目标，先按自然对齐的 8/16/32 位访问只写变量自身的字节，避免暂停期间 DMA/外设更新的相邻字节被旧值覆盖；回读发现窄写入被丢弃（部分 Cortex-M7/AHB-AP 的 byte-lane）时才退回对齐 32 位读-改-写，随后校验并恢复运行状态。暂停 DAP 会话的写入采用相同策略；托管调试运行态拒绝这些写入，暂停后通过 DAP 执行。`liveStatus` 的 `canWrite/haltWrite` 在独立采样或暂停 DAP 就绪时为 `true/true`，托管调试运行期采样可用时为 `true/false`，禁止写入时为 `false/false`。事务及成功结果带 `halted`；未暂停时回读不一致仍报 `WRITE_VERIFY_FAILED`，并标记 `targetHaltedDuringWrite: false`，因为固件可能紧接着修改该值；写入后回读失败报 `WRITE_READBACK_FAILED`。托管调试运行态的写入和一次性读取只在目标执行状态、调试会话或连接变化时中止，采样频率、观察列表、存储背压或停止采样不会取消事务；中止的写入报 `DEBUG_STATE_CHANGED`，`details.written/verified` 说明值是否已写入及校验。

Runtime writes keep execution running when every item is exactly four bytes at a four-byte-aligned address: read before, write each 32-bit word directly, and read back. Other standalone writes retain halt/RMW/verify/resume; running managed debug sessions reject them until paused for DAP writes. `canWrite/haltWrite` is `true/true` for standalone sampling or ready paused DAP, `true/false` for usable managed runtime sampling, and `false/false` when writes are disabled. Transactions and successful results include `halted`; an unhalted mismatch remains `WRITE_VERIFY_FAILED` with `targetHaltedDuringWrite: false`, since firmware may modify the value immediately after writing; a failed read-back after writing is `WRITE_READBACK_FAILED`. Running managed debug writes and one-shot reads are aborted only by target execution, debug session or connection changes, not by sampling-rate, watch-list, storage backpressure or sampling stops; an aborted write reports `DEBUG_STATE_CHANGED` with `details.written/verified` stating whether the value was written and verified.

采样 Worker 保持唯一连接与原有读取预算、写入互斥及会话代次。扩展宿主解码后分别写入磁盘归档和历史 Worker。Webview 只持有当前值、历史边界和当前视口的缩减分段；原始历史不会随采样时长累积到页面。

视口请求携带面板、会话 scope、清空代次、冻结编号、可见变量、时间范围、宽度及请求编号。正常请求间隔至少 80 ms，每窗口一个在途及一个最新待处理请求。显隐、拖动、缩放或清空后的旧回复不得覆盖新视图。按像素列保留首尾、数值极值及精确整数极值，缺失点分段，并保留视口两端相邻点。异常断点过多使回复超过 262,144 点时明确提示缩小范围，不隐式连接缺失采样。

## 软件验证

专项测试：`layered-sampling.test.js`、`chart-history-worker.test.js`、`chart-history-capacity.test.js`、`chart-history-recording.test.js`、`chart-remote-history.test.js`、`composite-history.test.js`，另保留此前清空及绘图预算回归。

复现基准（无硬件）：

```powershell
node test/perf/layered-history-bench.js
node mockup/build.js
node test/perf/layered-history-bench.js --browser-html
node mockup/serve.js 4175
# 浏览器打开 http://localhost:4175/layered-bench.html
```

Windows 11 / Chrome 154 的真实 Canvas，200 Hz 预填历史，12 次测量（4 次预热）。下表为中位毫秒，极值扫描与 Canvas 绘制分开测量；Worker 消息传输未计入，不能据此声称实板吞吐。

| 通道 / 历史  | 全曲线极值扫描 | 全曲线 Canvas | 仅 1 曲线扫描 / Canvas | 列式缓冲 |
| ------------ | -------------: | ------------: | ---------------------: | -------: |
| 3 / 20 分钟  |           15.2 |           2.5 |              5.3 / 2.1 | 11.8 MiB |
| 3 / 30 分钟  |           18.7 |           1.8 |              6.0 / 1.3 | 17.5 MiB |
| 10 / 20 分钟 |           42.6 |           3.7 |              4.2 / 1.4 | 39.2 MiB |
| 10 / 30 分钟 |           61.4 |           3.7 |              6.1 / 1.2 | 58.4 MiB |

10 通道、30 分钟全历史扫描 P95 为 73.7 ms，Canvas P95 为 7.6 ms；只绘制 1 通道分别为 6.5 / 2.0 ms。Canvas 中保留的几何点约 24,356 / 2,435 个。短视口、少量可见曲线会进一步降低计算成本，历史原始缓冲仍保存全部通道。完整检查、质量门槛、构建和 Extension Host 验证的执行结果见任务报告。未进行实板、HIL、固件写入、驱动切换或发布。
