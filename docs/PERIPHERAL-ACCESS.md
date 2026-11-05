# Peripheral register access / 外设寄存器访问

The sidebar, Agent skill and MCP tools use the same SVD-bound service. Reads and ordinary register/field writes
work through an active sampling connection, during managed single-core OpenOCD debugging, and while debugging
is paused. Without debugging, sampling must already be enabled and connected. Access itself never sends halt,
reset or resume and never starts a temporary probe connection. Debug access does not require variable sampling.

侧栏、Agent skill 与 MCP 共用 SVD 服务，可在仅采样、托管单核调试运行及调试暂停时读取和修改普通寄存器与位域。
未调试时必须先开启采样并成功连接；未采样、正在连接或正在断开时不允许访问，不会临时启动探针连接。
访问本身不发送 halt、reset 或 resume。调试中的外设访问不要求开启变量采样；不承诺所有目标或低功耗状态都支持运行中访问。

## Connection and widths / 连接与宽度

Reuse an active sampling connection or the selected debug session's managed OpenOCD connection. Without either,
reject register reads and writes with `PERIPHERAL_SAMPLING_REQUIRED`; SVD browsing remains available.
Paused access retains the selected session's DAP path. Multicore groups and external GDB servers remain paused-only.
The sidebar disables hardware controls until a supported connection is available and refreshes expanded registers
when sampling connects. Stopping or replacing the sampling connection invalidates pending requests and cached values.

Running Tcl access uses aligned 8/16/32-bit transfers at the SVD width, never widened RAM reads or write fallbacks.
64-bit access remains paused DAP only. Read-side-effect, write-only, write-once and special modified-write
restrictions remain in place. Missing SVD side-effect annotations cannot guarantee a harmless read.

只复用已有采样或调试连接；无可用连接时返回 `PERIPHERAL_SAMPLING_REQUIRED`，仍可浏览 SVD 定义。
侧栏在连接可用前禁用硬件读写控件；采样连接成功后刷新已展开的寄存器，停止或更换采样连接会使待处理请求与缓存值失效。
运行中按 SVD 的 8/16/32 位自然宽度访问，不扩大范围；64 位、多核共享组及外部服务器仍要求暂停。
保留读清零等副作用和特殊写入语义限制。SVD 没有标注副作用，不等于硬件一定没有副作用。

## Approval and readback / 确认与回读

Agent/MCP writes require single-use approval bound to the workspace, SVD, physical connection, selected debug
session/stop (when present), sampling connection generation, original values and requested writes. Stopping or
replacing the sampling connection invalidates approval, as does a changed probe/attachment/target or original value. Check original values again
immediately before writing; cancel when they changed. Bitfield updates are not atomic against firmware, DMA or
peripheral hardware, even when the CPU is halted.

Agent/MCP 写入仍需逐次确认，绑定工作区、SVD、物理连接、调试会话/停止代次、原值及请求。
停止或更换采样连接、更换探针、USB 附着、目标或原值均使确认失效。写前再次检查原值，变化则取消。
位域读改写无法与固件、DMA 或外设硬件更新保持原子性，暂停 CPU 也不能消除所有竞争。

Responses add access mode and generation. Write results retain previous/written/readBack/verified and add
verification: matched, different or unavailable. While running (including standalone), a completed write with
different/unavailable readback reports verified: false; this does not prove the write did not happen. Paused DAP
retains strict checking. Write timeouts/target changes report completed/attempted work and unknown outcomes.
Never automatically resend a failed or unverified write. When the debug state or SVD changes only after every
write and its readback finished, the result stays successful and adds stateChangedAfterWrite. Each running
transaction has a 5 s budget checked between OpenOCD commands; each command is bounded by the Tcl RPC timeout.

运行中回读不同或不可用时，写命令完成与校验结果分开报告，verified 为 false；不能据此认定没有写入。
暂停 DAP 保留严格回读检查。写入超时或目标变化报告已完成项、尝试项及结果是否未知，不自动重试。
写入与回读全部完成后才发生的调试状态或 SVD 变化不算失败，结果附带 stateChangedAfterWrite。运行中单个事务
预算 5 秒，在 OpenOCD 命令之间检查；单条命令受 Tcl RPC 超时限制。

## Verification / 验证

Software tests use fake OpenOCD/DAP endpoints and the real Worker RPC, covering all three states, widths,
approval invalidation, readback differences, partial failures and stale generations. They do not establish board
support. Hardware acceptance requires separate authorization and dedicated hardware; record the OS, probe,
target script, firmware and SVD.

软件测试使用模拟端点，不证明实板兼容。实板写入验收需另行授权并使用专用硬件，单独记录环境与结果。

2026-11-01: APM32F407 + J-Link/WinUSB passed all three read modes, running reads alongside sampling, and six
explicitly approved same-value whole-register/field writes. This covers 32-bit transfers on that setup only.
See the [board acceptance record](validation/peripheral-board-2026-11-01.md) for versions, evidence and limits.
2026-11-03: the same setup passed again after the sidebar and write-outcome fixes, including running reads while
sampling stayed active; see the [re-check record](validation/peripheral-board-2026-11-03.md).

2026-11-01：APM32F407 + J-Link/WinUSB 已通过三态读取、运行中采样连接复用，以及另行授权的 6 次整寄存器/
位域同值写入。仅验证该组合的 32 位访问，未测试实际改值。详见上述实板记录。
