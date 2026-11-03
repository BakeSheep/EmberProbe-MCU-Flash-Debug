# Peripheral register access / 外设寄存器访问

The sidebar, Agent skill and MCP tools use the same SVD-bound service. Reads and ordinary register/field writes
work without a debug session, during managed single-core OpenOCD debugging, and while debugging is paused.
Access itself never sends halt, reset or resume. Variable sampling need not be enabled; no ELF is required.

侧栏、Agent skill 与 MCP 共用 SVD 服务，可在非调试、托管单核调试运行及调试暂停时读取和修改普通寄存器与位域。
访问本身不发送 halt、reset 或 resume，不要求开启变量采样，也不需要 ELF。自定义 OpenOCD 脚本的初始化行为
由脚本决定；不承诺所有目标或低功耗状态都支持运行中访问。

## Connection and widths / 连接与宽度

Reuse an active sampling connection or the selected debug session's managed OpenOCD connection. Without either,
obtain an exclusive lease, initialize a temporary connection and confirm exit before releasing ownership.
Paused access retains the selected session's DAP path. Multicore groups and external GDB servers remain paused-only.
Without debugging, the sidebar reads only after a click (register, peripheral expansion or refresh), because each
read starts a temporary OpenOCD that holds the probe; flash and debug start are refused while it runs.

Running Tcl access uses aligned 8/16/32-bit transfers at the SVD width, never widened RAM reads or write fallbacks.
64-bit access remains paused DAP only. Read-side-effect, write-only, write-once and special modified-write
restrictions remain in place. Missing SVD side-effect annotations cannot guarantee a harmless read.

已有连接会被复用；否则申请独占租约并临时连接，确认退出后释放，不抢占其他任务。
非调试时侧栏只在点击寄存器、展开外设或刷新后读取：每次读取都会临时启动 OpenOCD 并占用探针，期间烧录与调试启动会被拒绝。
运行中按 SVD 的 8/16/32 位自然宽度访问，不扩大范围；64 位、多核共享组及外部服务器仍要求暂停。
保留读清零等副作用和特殊写入语义限制。SVD 没有标注副作用，不等于硬件一定没有副作用。

## Approval and readback / 确认与回读

Agent/MCP writes require single-use approval bound to the workspace, SVD, physical connection, selected debug
session/stop (when present), original values and requested writes. Reconnecting a temporary process alone does
not invalidate approval; a changed probe/attachment/target or original value does. Check original values again
immediately before writing; cancel when they changed. Bitfield updates are not atomic against firmware, DMA or
peripheral hardware, even when the CPU is halted.

Agent/MCP 写入仍需逐次确认，绑定工作区、SVD、物理连接、调试会话/停止代次、原值及请求。
只重建临时进程不使确认失效，更换探针、USB 附着、目标或原值则失效。写前再次检查原值，变化则取消。
位域读改写无法与固件、DMA 或外设硬件更新保持原子性，暂停 CPU 也不能消除所有竞争。

Responses add access mode and generation. Write results retain previous/written/readBack/verified and add
verification: matched, different or unavailable. While running (including standalone), a completed write with
different/unavailable readback reports verified: false; this does not prove the write did not happen. Paused DAP
retains strict checking. Write timeouts/target changes report completed/attempted work and unknown outcomes.
Never automatically resend a failed or unverified write.

运行中回读不同或不可用时，写命令完成与校验结果分开报告，verified 为 false；不能据此认定没有写入。
暂停 DAP 保留严格回读检查。写入超时或目标变化报告已完成项、尝试项及结果是否未知，不自动重试。

## Verification / 验证

Software tests use fake OpenOCD/DAP endpoints and the real Worker RPC, covering all three states, widths,
approval invalidation, readback differences, partial failures and stale generations. They do not establish board
support. Hardware acceptance requires separate authorization and dedicated hardware; record the OS, probe,
target script, firmware and SVD.

软件测试使用模拟端点，不证明实板兼容。实板写入验收需另行授权并使用专用硬件，单独记录环境与结果。

2026-11-01: APM32F407 + J-Link/WinUSB passed all three read modes, running reads alongside sampling, and six
explicitly approved same-value whole-register/field writes. This covers 32-bit transfers on that setup only.
See the [board acceptance record](validation/peripheral-board-2026-11-01.md) for versions, evidence and limits.

2026-11-01：APM32F407 + J-Link/WinUSB 已通过三态读取、运行中采样连接复用，以及另行授权的 6 次整寄存器/
位域同值写入。仅验证该组合的 32 位访问，未测试实际改值。详见上述实板记录。
