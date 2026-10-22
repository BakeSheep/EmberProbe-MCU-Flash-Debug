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

视口请求携带面板、会话 scope、清空代次、冻结编号、可见变量、时间范围、宽度及请求编号。正常请求间隔至少 80 ms，每窗口一个在途及一个最新待处理请求。按像素列保留首尾、数值极值及精确整数极值，缺失点分段，并保留视口两端相邻点。异常断点过多使回复超过 262,144 点时明确提示缩小范围，不隐式连接缺失采样；失败的同一请求不会逐帧重发。

回复是否采用只取决于配置（清空代次、冻结编号、可见变量及其类型/地址/位域），与时间范围无关：拖动、滚轮缩放或拖动时间轴期间到达的回复照常采用，按其自身时间范围平移绘制；显隐、类型或地址变化、冻结切换或清空后的旧回复仍被丢弃。新配置的回复到达前，上一份数据中身份未变的曲线继续显示，避免闪空。

- 超采样：未跟随时按可见范围左右各多取一屏（截到保留边界），列数按可见部分保持画布宽度分辨率，上限 8192 列（超出时对称缩小超采样）。可见范围仍在已取范围内且分辨率在 1/3–1.5 倍之间时不发新请求；未跟随时仅数据版本变化的刷新最多每秒一次。
- 粗略底图：另以画布宽度（64–4096 列）请求整个保留范围，配置变化时立即请求，采样中最多每秒刷新；与明细请求共用在途名额，待发超过 1 秒时优先于明细发出。明细范围之外（拖出、缩小）用底图补画；跨过切口的底图段直接连到明细曲线自身的首尾点，底图点不会画进明细范围内，避免跟随时曲线左端随提交左右跳动。
- 跟随原子提交：跟随时状态事件只触发请求，不推进绘图边界；采用的明细回复同时提交其携带的边界与数据，最右端不再出现空白条。1 秒内没有采用的回复时退回事件边界。跟随请求向右多取 min(一屏, 5 s)。
- 传输：Worker 把回复按变量打包为 Float64 时间/数值列、Uint32 分段终点与稀疏精确文本（`src/webview/liveWatch/chartTransport.js`），以可转移 ArrayBuffer 发给扩展宿主；VS Code 对 Webview 消息中的类型化数组不做 JSON 序列化。Webview 解码后与原格式一致。
- 组合后的曲线数组在输入不变时复用同一实例，悬停重绘不重建绘图缓存。
- 平移绘图缓存使用相对坐标的 Float64 数组、原始点引用及 Uint32 包络索引，构建范围左右各多半屏；数据、归一化、画布/DPR、留白和 x/y 跨度不变且视口仍在构建范围内时，仅更新偏移。绘图只发出可见包络及两端相邻点，断点和精确整数标签保持原意。
- 采样中的固定跨度跟随窗口在未冻结、未拖动且未要求减少动态效果时，按本地经过时间平滑推进；显示时钟不倒退、不超过已提交明细的边界，停更后停在该边界。平滑跟随时下方时间轴以显示时钟为终点，选区与右端点保持贴在最右侧；拖动曲线、滚轮缩放、拖动时间轴选区或端点（含键盘）开始前，先把视图平移到已提交数据的边界再判断吸附与跟随，因此右端吸附后拖动左端点不会脱离吸附。“全部”仍按原子提交推进。自动 Y 轴和归一化范围在明细提交之间保持，绘图最小间隔随耗时 EMA 在 16–80 ms 内调整；仅版本变化的跟随明细刷新至少等待 max(80 ms, 可见跨度 / 画布列数)，粗略底图规则不变。实现与软件基准见 [P1 说明](plans/2026-10-22-chart-smooth-render.md)。

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
