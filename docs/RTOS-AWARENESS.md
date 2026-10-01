# RTOS-aware debugging / RTOS 感知调试

EmberProbe's built-in debugger can show RTOS tasks in the VS Code call stack. This is opt-in and off by default: with no `rtos` value the session behaves exactly as before, GDB reports one thread, and the OpenOCD command line is unchanged.

EmberProbe 的内置调试器可以在 VS Code 调用栈中显示 RTOS 任务。该能力默认关闭：不填 `rtos` 时会话行为与之前完全一致，GDB 只报告一个线程，OpenOCD 命令行也不变。

## Configuration / 配置

| Setting | Meaning / 含义 |
| --- | --- |
| `emberprobe.rtos` | Workspace default; empty (the default) means off / 工作区默认值，留空（默认）表示关闭 |
| `launch.json` → `rtos` | Per-session value; also accepted under `attach` / 单次会话取值，`attach` 同样支持 |

Precedence: a `launch.json` value wins whenever the key is present, **including an explicit empty string**, which turns awareness off for that session. Only a missing, `undefined` or `null` key falls back to `emberprobe.rtos`. `null` therefore cannot disable awareness — write `""`.

优先级：只要 `launch.json` 里存在 `rtos` 键就以它为准，**包括显式空字符串**（用于在该会话关闭感知）。只有键缺失、`undefined` 或 `null` 才回退到 `emberprobe.rtos`。因此 `null` 不能用来关闭，请写 `""`。

Accepted values are `auto`, `none`, `FreeRTOS`, `ThreadX`, `chibios`, `Chromium-EC`, `eCos`, `embKernel`, `linux`, `mqx`, `nuttx`, `RIOT`, `uCOS-III` and `Zephyr`. OpenOCD compares these case-sensitively, so `freertos` and `FreeRTOs` are rejected with `OPENOCD_RTOS_INVALID` before any hardware is touched. This is the list Cortex-Debug documents for OpenOCD, plus `none`; `hwthread` and `rtkernel` are compiled into the bundled OpenOCD but deliberately not offered, because `hwthread` reports a single unnamed thread and `rtkernel` is RTEMS-only.

可接受取值为 `auto`、`none`、`FreeRTOS`、`ThreadX`、`chibios`、`Chromium-EC`、`eCos`、`embKernel`、`linux`、`mqx`、`nuttx`、`RIOT`、`uCOS-III`、`Zephyr`。OpenOCD 区分大小写，因此 `freertos`、`FreeRTOs` 会在接触任何硬件之前以 `OPENOCD_RTOS_INVALID` 被拒绝。该列表取自 Cortex-Debug 为 OpenOCD 记录的名称，另加 `none`；内置 OpenOCD 虽也编译了 `hwthread` 与 `rtkernel`，但刻意不开放——`hwthread` 只报告一个无名线程，`rtkernel` 仅用于 RTEMS。

`none` differs from an empty value: empty means EmberProbe never emits `-rtos`, while `none` tells OpenOCD explicitly, overriding a `-rtos` that a target `.cfg` may already set.

`none` 与留空不同：留空表示 EmberProbe 完全不发 `-rtos`；`none` 则是显式告知 OpenOCD，可覆盖 target `.cfg` 中已有的 `-rtos` 设置。

## Where it is applied / 生效位置

Debug mode only. EmberProbe inserts one `-c` command after the interface and target configuration files and **before `init`**, which configures the RTOS on the current target:

仅调试模式。EmberProbe 在接口与 target 配置文件之后、**`init` 之前**插入一条 `-c` 命令，为当前 target 配置 RTOS：

```tcl
set _ep_rtos_target ""; catch { set _ep_rtos_target [target current] };
if { $_ep_rtos_target eq "" } { error "EmberProbe: no current target to configure for RTOS <name>" };
_ep_rtos_target configure -rtos <name>
```

If there is no current target, or OpenOCD rejects the name, this raises a Tcl error, OpenOCD exits non-zero **before opening the probe**, and the normal startup-cleanup path reports `OPENOCD_RTOS_INVALID` with suggested actions. On a dual-core part only the current target is configured, so select the core that actually runs the RTOS. Standalone live sampling never configures an RTOS: walking kernel structures would change non-intrusive polling behaviour. The value is read at OpenOCD startup, so a change takes effect at the next debug session. The adapter's `restart` request deliberately reuses the running OpenOCD server — the extension, not the adapter, owns it — so Restart keeps the previously configured RTOS; stop and start again to apply a change.

若不存在当前 target，或 OpenOCD 拒绝该名称，这里会抛出 Tcl 错误，OpenOCD **在打开探针之前**非零退出，随后由既有的启动清理流程报出带建议动作的 `OPENOCD_RTOS_INVALID`。双核器件只配置当前 target，因此请选择真正运行 RTOS 的那个核。独立实时采样永不配置 RTOS：遍历内核数据结构会改变非侵入轮询行为。该取值在 OpenOCD 启动时读取，因此改动在下次启动调试时生效。适配器的 `restart` 刻意复用正在运行的 OpenOCD 服务（服务由扩展而非适配器持有），因此“重启”仍保持先前配置的 RTOS；需停止后重新启动才会应用改动。

## What changes in the debugger / 调试器行为变化

With awareness on, the adapter keeps a set of task IDs that GDB has actually confirmed, seeded from `-thread-info` after attach and maintained from `=thread-created` / `=thread-exited`. It never reports an unconfirmed ID: a `stopped` event with no confirmed task simply omits `threadId`, and VS Code refreshes the call stack from the task list instead. Before the scheduler has created tasks, or right after a reset, that means one confirmed thread rather than an invented set.

开启感知后，适配器维护一个"GDB 真正确认过"的任务 ID 集合：attach 后由 `-thread-info` 播种，之后由 `=thread-created` / `=thread-exited` 维护。它绝不上报未确认的 ID——没有已确认任务时，`stopped` 事件直接不带 `threadId`，由 VS Code 依据任务列表刷新调用栈。因此在调度器建立任务之前、或刚复位之后，看到的是一个已确认线程，而不是一组臆造的 ID。

Stack frames, locals and expression evaluation are bound to the owning task and frame (`-var-create --thread N --frame M`), and `continue` / `next` / `stepIn` / `stepOut` pin the requested task (`-exec-next --thread N`). Browsing another task's stack therefore cannot make a subsequent step act on the task you were looking at. Requesting a task that has exited returns `DEBUG_TASK_EXITED` rather than stepping something else; `DEBUG_THREAD_INVALID` covers a malformed ID. An expression evaluated without a frame — the DEBUG CONSOLE and session-level WATCH — intentionally uses the task you last selected.

栈帧、局部变量与表达式求值都绑定到所属任务与栈帧（`-var-create --thread N --frame M`），`continue` / `next` / `stepIn` / `stepOut` 则钉住被请求的任务（`-exec-next --thread N`）。因此浏览另一个任务的栈不会导致随后的单步作用在你正在看的那个任务上。请求一个已退出的任务会返回 `DEBUG_TASK_EXITED`，而不是去单步别的任务；ID 非法则返回 `DEBUG_THREAD_INVALID`。不带栈帧的求值——调试控制台与会话级 WATCH——刻意使用你最后选中的任务。

The sidebar and Agent debug controls reconcile their cached task ID against the live list before acting on a paused RTOS session, preferring the task that actually stopped. Non-RTOS sessions keep the previous zero-round-trip path.

侧栏与 Agent 的调试控制在操作已暂停的 RTOS 会话前，会用实时任务列表校准缓存的任务 ID，并优先选择真正停下的那个任务。非 RTOS 会话保持原有的零往返路径。

## Firmware prerequisites / 固件前提

OpenOCD resolves kernel structures through GDB symbol lookup against the loaded ELF, so the image must not have been stripped of them. The most common silent failure is `uxTopUsedPriority` being optimized out by the linker, which leaves `-rtos auto` finding no tasks. Prefer an explicit RTOS name over `auto`: `auto` probes every backend against the ELF and can mis-detect on a stripped or heavily optimized image. Whether the call stack shows a task name or `Thread N` depends on what OpenOCD's backend can read from the image — record what you actually observe rather than assuming names will appear.

OpenOCD 通过 GDB 对已加载 ELF 的符号查询来解析内核结构，因此镜像不能把这些符号裁剪掉。最常见的静默失败是 `uxTopUsedPriority` 被链接器优化掉，导致 `-rtos auto` 找不到任何任务。建议显式指定 RTOS 名称而非 `auto`：`auto` 会拿每个后端去试探 ELF，在裁剪或高度优化的镜像上可能误判。调用栈显示任务名还是 `Thread N`，取决于 OpenOCD 后端能从镜像里读到什么——请记录实际观察到的结果，不要假定一定会出现任务名。

## Task snapshots and boundaries / 任务快照与边界

The workspace implementation adds an experimental FreeRTOS task panel with paused, bounded reads, filtering, sorting and stale labels after resume. Optional stack fill estimates require verified bounds and layout; they are not a measurement of current live SP. The panel does not yet have board acceptance. A task deleted while you are browsing its stack surfaces as `DEBUG_TASK_EXITED` on the next control action. Crashed-task analysis remains outside the implementation; see [the parity plan](RTOS-CPP-PARITY-PLAN.md) for budgets and evidence.

工作区实现已增加实验性 FreeRTOS 任务面板，仅做有界暂停读取，支持过滤、排序和运行后旧快照标记。可选栈填充估算必须先确认边界与布局，不代表实时 SP；任务面板尚无实板验收。浏览某任务栈时它被删除，会在下一次控制操作时以 `DEBUG_TASK_EXITED` 显现。崩溃任务分析仍未实现；预算与证据详见[补齐计划](RTOS-CPP-PARITY-PLAN.md)。

The initial stop at `main` commonly precedes task creation and scheduler startup. When task count and current TCB confirm an empty pre-start state, the panel shows a startup hint rather than traversing zero-initialized lists. Continue past startup and pause again to inspect tasks. Optional `pxEndOfStack` and `ulRunTimeCounter` depend on firmware configuration; absent members omit the corresponding statistics. Initialized-list corruption and failed reads still produce partial diagnostics. This follows [FreeRTOS task-list initialization](https://github.com/FreeRTOS/FreeRTOS-Kernel/blob/V10.6.2/tasks.c).

首次自动停在 `main` 通常早于任务创建和调度器启动。任务数与当前 TCB 确认尚无任务时，面板显示启动提示，不遍历仍为零值的链表；继续运行过初始化，再暂停查看任务。`pxEndOfStack`、`ulRunTimeCounter` 是否存在取决于固件配置，缺失时省略对应统计；已经初始化的链表损坏或内存读取失败仍显示部分结果。

Experimental OpenOCD groups use `serverGroup`, `numberOfProcessors`, `targetProcessor` and optional `targetName`. Targets receive distinct GDB ports; selection and all-target RTOS configuration precede initialization. Start one member first, then attach other cores after successful initialization. Groups share one physical lease and require explicit session selection; restart and running Tcl sampling are disabled. OpenOCD reset behavior follows target scripts and may affect the whole device. See [configuration and verification limits](SHARED-DEBUG-GROUPS.md); dual-core board acceptance remains pending.

实验性 OpenOCD 共享组使用 `serverGroup`、`numberOfProcessors`、`targetProcessor` 和可选 `targetName`。每核独立 GDB 端口，初始化前选核并向全部目标配置相同 RTOS。先启动一个成员，初始化成功后通过 attach 加入其他核。组内共用一个探针租约，明确选择会话后路由；禁用组内重启和运行期 Tcl 采样。目标脚本的复位可能影响整个芯片。详见 [配置和验证边界](SHARED-DEBUG-GROUPS.md)，双核实板验收仍待完成。

## Verification boundary / 验证边界

Configuration handling, OpenOCD argument ordering, multi-task GDB/MI events and DAP control are covered by hardware-independent tests (`test/ember-debug.test.js`, `test/openocd-entrypoints.test.js`, `test/openocd-compatibility.test.js`, `test/debug-control.test.js`). Real task discovery depends on the board, the kernel build and the linker script, so it is verified by the manual FreeRTOS procedure in `test/hil/README.md` on dedicated hardware. Those results are not established by the automated suite.

配置处理、OpenOCD 参数顺序、多任务 GDB/MI 事件与 DAP 控制由不依赖硬件的测试覆盖（`test/ember-debug.test.js`、`test/openocd-entrypoints.test.js`、`test/openocd-compatibility.test.js`、`test/debug-control.test.js`）。真正的任务发现取决于板子、内核构建与链接脚本，因此按 `test/hil/README.md` 中的 FreeRTOS 手工流程在专用硬件上验证。自动化测试套件不能证明这部分结果。
