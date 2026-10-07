# Change Log

All notable changes to the EmberProbe extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- CPU 负载采样改为严格独占探针，在连接前校验 FreeRTOS ELF/DWARF；修复失败后残留意图和提前释放探针的问题，退出未确认时允许重试停止。
- Make CPU load sampling exclusive across hardware operations, validate FreeRTOS ELF/DWARF before connecting, clear failed startup intent and retain probe ownership until confirmed shutdown, with Stop retries.

- 修复内置调试器在继续／单步／运行到入口时的状态竞争，安全处理调用栈末尾分页，并在退出时取消旧请求，避免预期的状态变化弹出错误；保留真实调试故障提示与读取预算。
- Fix built-in debugger execution-state races during continue, stepping and run-to-entry; handle end-of-stack pages safely and cancel pending requests on shutdown, while preserving genuine errors and bounded reads.

- 从 ELF/DWARF 直接解析 C/C++ 枚举成员，在侧栏和 Live Watch 显示名称与数值，支持别名、复合成员、数组和运行时对象；修复旧 DWARF 负值解码和枚举指针宽度，保留精确 64 位数值与未知编码的只读保护。
- Decode C/C++ enum members directly from ELF/DWARF and display names with values in the sidebar and Live Watch, including aliases, composite members, arrays and runtime objects. Fix legacy DWARF signed reads and enum pointer widths while preserving exact 64-bit values and read-only protection for inferred encodings.

## [0.8.1] - 2026-10-06

- 精简中文 README，聚焦重点功能，并要求 Agent 仅在用户明确要求时修改 README。
- Simplify the Chinese README around key capabilities and require an explicit user request for Agent edits to it.

- 移除 ELF 变量列表中的 `CPP_TYPE_UNRESOLVED` 汇总提示，并移除波形导入中的整个 ELF 解析提示区域；保留内部诊断和未知 C++ 类型不可观测的处理。
- Remove `CPP_TYPE_UNRESOLVED` notices from ELF variable lists and the entire ELF parsing-notice area from waveform imports, while retaining internal diagnostics and unavailable-type restrictions.

- 静态复合波形变量从开始采样时记录全部可观察标量成员，后开启成员曲线可恢复完整保留历史；冻结与导出包含未绘图成员，同批父变量与成员采样不重复归档，并保留位域身份。
- Record observable scalar members of fixed composite waveform variables from the first acquisition. Later curve activation restores retained history; frozen snapshots and exports include unplotted members, with duplicate parent/member records removed and bitfield identity preserved.

- 波形变量导入搜索同步侧边栏的子成员匹配与父项自动展开，支持嵌套成员、数组及已采样运行时成员；分批解析懒加载布局，清除搜索后恢复手动展开状态。
- Match child members and automatically expand their parents in waveform variable imports, following sidebar search behavior. Support nested, array and sampled runtime members, resolve lazy layouts in bounded batches, and restore manual expansion after clearing the search.

- 修复未选择任何绘图曲线时空图提示与历史加载提示闪烁；仅采样复合变量时同步实测频率，避免采样正常却持续显示 0.0 Hz。
- Fix flickering between empty-chart and history-loading messages when no curves are selected. Forward the measured frequency for composite-only sampling so active sampling does not remain at 0.0 Hz.

- 修复持续采样时波形视口响应被反复丢弃、清空历史后重载面板无法恢复历史，以及提高波形采样频率后仍等待旧周期的问题；保留手动视口变化和历史清空的旧响应隔离。
- Fix repeated viewport-response rejection during continuous sampling, restore retained history after reloading a cleared chart, and apply waveform frequency increases without waiting for the old period. Preserve stale-response isolation for manual viewport changes and history clears.

- 新增默认关闭的实验性外部 GDB server attach，通过 VS Code 原生设置和显式 F5 配置启用；保留会话与写入边界，退出后须停止外部服务器并关闭实验开关再恢复硬件操作。现有 OpenOCD 调试入口不变。
- Add opt-in experimental external GDB server attach through native VS Code settings and an explicit F5 configuration. Preserve session/write boundaries and retain the probe hold until the external server is stopped and the setting disabled; existing OpenOCD debug entry points stay unchanged.

- 波形导入变量窗口与变量搜索结果顶部增加采样提醒，说明此波形图所选变量均以选定频率采样。
- Add a sampling reminder above waveform variable imports and search results: all selected variables use the selected sampling frequency.

- 波形侧栏与树状成员统一使用留有边距的圆角长条色块；显隐按钮覆盖色块和变量名，移除树状成员绘图提示；数值列按内容分配宽度，避免留空时提前省略变量名。
- Use inset rounded color bars for waveform sidebar variables and tree members; extend visibility buttons through the variable name and remove the tree plotting hint. Size value columns to their content so spare space remains available to variable names.

- 实时采样严格校验内存响应的每个数值与元素数量，异常时清除旧标量／对象值并报告不可用；拒绝闲置／睡眠后超时回调执行前到达的过期响应，隔离旧 socket 事件，避免影响新连接。
- Validate every memory response element and its exact count; clear stale scalar/object values on malformed reads. Reject overdue responses even before delayed timeout callbacks run after idle/sleep, and isolate old socket events from replacement connections.

- 分离波形目标频率与侧栏固定 20 Hz 消费者；隐藏曲线继续归档，后台历史 Worker 保留最近 30 分钟。按需生成视口数据，冻结与保留数据 CSV 使用原始样本；内存预算或历史 Worker 故障暂停采样，并支持从当前清空代次的磁盘归档恢复。
- Separate waveform-target sampling from fixed 20 Hz sidebar consumers; archive silent curves and retain 30 minutes in a history worker. Generate viewport data on demand, export original retained/frozen samples, pause on memory or history-worker failures, and rebuild the current clear generation from disk archives.

- 修复波形“清空历史”后默认 CSV 导出仍包含旧归档数据的问题，按窗口与调试会话隔离清空，并丢弃过期采样批次和归档回复。优化长时间高频采样绘图：二分定位可见区间，在创建绘图对象前按像素保留首尾与极值，保留断点、精确整数和原始 CSV 数据。
- Fix stale archive data in default CSV exports after Clear History, isolate clears by panel and debug session, and discard pending sample batches and stale archive replies. Optimize long high-rate captures by locating the visible interval with binary search and retaining per-pixel endpoints and extrema before allocating drawing geometry, while preserving gaps, exact integers and raw CSV samples.

## [0.8.0] - 2026-10-03

- 无前缀的侧栏观测变量字号从 13px 调整为 14px，变量名与类型标签垂直居中；精简中英文 README 并清理过期开发文档。
- Increase unqualified sidebar watch names from 13px to 14px and vertically center names with type badges; simplify both READMEs and remove outdated development documents.

- 修复未选择侧栏 ELF 时空观察列表中断调试会话注册、暂停状态无法同步的问题；补齐 ARM 容器布局 CI 测试的标准库头文件依赖。
- Fix debug session registration and paused-state tracking with an empty watch list and no sidebar ELF; install standard-library headers required by ARM container-layout CI tests.

- 修正侧栏与图表选择器的运行时成员提示：已列出的成员可单独观察，固定数组无需先添加整个变量；动态容器尚无元素时才提示先采样。
- Clarify individual runtime member selection in sidebar and chart pickers: fixed array elements need no whole-variable watch; request container sampling only when no elements are listed yet.

- ELF 全部变量与图表导入列表的顶层显示上限从 100 提升至 500，展开成员后的总行数限制为 1000，并修复成员预算耗尽时的负数截取与计数问题。
- Raise the sidebar ELF and chart import lists from 100 to 500 top-level variables, cap expanded rows at 1000, and prevent negative member budgets from breaking truncation and counts.

- 保留普通数组成员的切片／全选路径；支持结构体、继承类和 C 数组中的嵌套 STL 语义展开及采样，容器旁的普通指针仅显示地址，不自动追踪。
- Preserve slice/all paths for ordinary array members; support semantic STL selection and sampling inside structs, inherited classes and C arrays while keeping unrelated raw pointers as address values.

- 侧栏与图表导入按容器语义展开 STL 成员，智能指针显示 `value`，动态容器在采样后显示当前元素；修复按需加载丢失运行时布局、内部存储路径回退为标量观察及只读成员误显示可写，成员变化时保留图表导入勾选。
- Show semantic STL members in sidebar and chart import, including smart-pointer `value` and sampled dynamic elements; preserve lazy runtime layouts and import selections, reject raw storage fallback paths, and disable writes to runtime members.

- 增加 DWARF4/5 type unit、split DWARF、DWARF64、外部地址表及 64 位引用的安全解析；缺失或不匹配 `.dwo` 时不再把 C++ 对象猜成整数，并按 companion 文件身份刷新缓存。实时采样新增受预算限制的 libstdc++ 容器、引用／指针链、虚成员地址与已验证 RTTI 动态类型读取；动态对象只读，失败清除旧值并报告诊断。
- Add bounded DWARF4/5 type-unit, split-DWARF, DWARF64, external-address-table and 64-bit-reference parsing; missing or mismatched `.dwo` companions no longer turn C++ objects into guessed integers, and companion identity invalidates caches. Live sampling now resolves bounded libstdc++ containers, references/pointer chains, virtual-member addresses and verified RTTI dynamic types; dynamic objects are read-only and failed samples clear stale values with diagnostics.

- 调试 skills 新增暂停 C/C++ 线程、调用栈、作用域与对象分页读取，使用绑定会话和暂停代次的句柄；新增 `mcu-rtos`，复用只读 FreeRTOS 任务快照与栈填充估算，补充 C++ 实时读取和 RTOS 支持边界。
- Add paused C/C++ thread, stack, scope and paged object inspection with session/stop-scoped handles; add `mcu-rtos` using read-only FreeRTOS snapshots and stack fill estimates, and document C++ live-read and RTOS support limits.

- 优化调试暂停与单步响应：暂停中断绕过只读请求排队，执行控制取消过时刷新；延后变量对象清理，复用帧上下文和标量悬停结果，跳过无变化断点更新。合并安全连续外设读取及相邻对齐内存写入；自动 RTOS/外设刷新延后，RTOS 面板展开时每次暂停自动扫描栈填充。支持通过 launch/attach 的 performanceTrace 查看请求耗时与 MI 命令数。
- Improve pause and stepping responsiveness with urgent interrupts, cancellable stale reads, deferred varobj cleanup, frame/scalar-hover reuse and no-op breakpoint updates. Batch safe contiguous peripheral reads and adjacent aligned memory writes; defer automatic panels and scan RTOS stack fill at every stop while the panel is expanded. Add optional launch/attach performanceTrace diagnostics.

- 修复 Globals 被同名局部变量遮蔽导致读取或赋值错误、切换栈帧后成员地址指向其他对象，以及写内存后调试视图未刷新而继续使用失效引用。
- Fix globals resolving to shadowing locals, member addresses using the wrong stack frame, and stale debug views after memory writes.

- 实时值与成员值支持点击复制，复制失败会明确提示而不再静默忽略；修复写入一个变量后自调度采样链断裂、查看列表永久停更；清空写入框后点击加减按钮从上一个值继续步进而不是从 0 开始。
- Click a live or member value to copy it, with clipboard failures now reported instead of silently ignored; fix the self-rescheduling sampling chain breaking after a write, which froze the watch list until sampling restarted; step from the last value instead of zero when the write field has been emptied.

- 紧凑布局在窄侧栏下保持高度稳定：成员行不再在 260px 断点处变矮，实时值不再撑出横向滚动条，实时面板复合变量头的字节数标签回到与名称同一行。
- Keep compact layouts stable at narrow sidebar widths: member rows no longer shrink at the 260px breakpoint, live values no longer force a horizontal scrollbar, and the composite byte-size badge returns to the name's row in the live panel.

- 修复共享调试组中某个核启动失败且适配器无响应时成员未被释放，导致探针租约被永久占用、后续操作一律 `PROBE_BUSY` 只能重载窗口；OpenOCD 服务启动失败时确保已派生的子进程被停止，不再遗留占用探针的孤儿进程。
- Release a shared-group member even when stopping a wedged core session throws, so a failed core no longer strands the probe lease and forces a window reload; stop an already-spawned OpenOCD when server startup fails instead of orphaning a process that holds the probe.

- FreeRTOS 任务视图支持 Cortex-M55/M85（armv8.1-m）；当 `pxCurrentTCB` 为空且 `xSchedulerRunning` 与 `uxCurrentNumberOfTasks` 均被优化掉时，直接说明无法判定调度器状态，不再遍历全零链表并报出假的损坏诊断。
- Support Cortex-M55/M85 (armv8.1-m) in the FreeRTOS task view; when `pxCurrentTCB` is null and both `xSchedulerRunning` and `uxCurrentNumberOfTasks` are optimized out, report the scheduler state as undeterminable instead of walking zero-initialized lists and emitting spurious corruption diagnostics.

- 暂停的托管调试会话执行 Agent 写入时不再多余地申请一个独立探针会话。
- Stop acquiring a redundant standalone probe session when an Agent write runs on a paused managed debug session.

- 修复首次停在 main、FreeRTOS 尚未创建任务时将未初始化链表误报为损坏；任务视图显示调度器未启动或尚无任务，可选 TCB 字段缺失不再触发部分结果。
- Recognize pre-scheduler stops with no created tasks instead of reporting zero-initialized lists as corrupt; show startup state and omit unavailable optional TCB fields without marking the snapshot partial.

- 抽出 OpenOCD 调试 controller，新增实验性共享 `serverGroup`、独立核端口和会话路由；新核通过 attach 加入，同组仅持有一个探针租约，最后一个会话退出且服务器停止确认后释放。侧栏与 Agent 可明确选会话，切换使旧读取失效；多核关闭运行期 Tcl 采样与组内重启，实板验收仍待完成。
- Extract the OpenOCD controller with experimental shared server groups, per-core ports and explicit sidebar/Agent routing. Joining cores attach to one probe lease; final-member cleanup waits for confirmed server exit. Session changes invalidate stale reads; groups disable restart and running Tcl sampling. Board acceptance remains pending.

- 原生调试新增 Globals、文件 Statics、Registers 作用域、表达式赋值及可靠变量路径／地址；新增实验性 FreeRTOS 暂停任务表，支持筛选、排序、手动刷新和旧快照标记。栈填充估算仅在边界可验证时提供，真实板卡任务表验收仍待完成。
- Add native globals, file statics, registers, expression assignment and reliable variable metadata; add an experimental paused FreeRTOS task table with filtering, sorting, manual refresh and stale-snapshot labels. Stack fill estimates require verified bounds; real-board task-table acceptance remains pending.

- 新增 RTOS 感知调试：`emberprobe.rtos` 设置与 launch.json 的 `rtos` 键让 OpenOCD 在 `init` 之前为当前 target 配置 RTOS，调用栈显示 FreeRTOS 等任务，栈帧、局部变量与表达式求值绑定到所属任务，继续与单步显式指定任务；默认留空，非 RTOS 工程行为不变。会话内“重启”复用同一 OpenOCD 服务，改动需停止后重新启动才生效，详见 docs/RTOS-AWARENESS.md。
- Add RTOS-aware debugging: the `emberprobe.rtos` setting and the launch.json `rtos` key make OpenOCD configure the current target's RTOS before `init`, so the call stack lists FreeRTOS-style tasks, stack frames, locals and expression evaluation bind to the owning task, and continue and stepping carry an explicit task ID; empty by default, leaving non-RTOS projects unchanged. Restart reuses the same OpenOCD server, so a change needs a full stop and start; see docs/RTOS-AWARENESS.md.
- 暂停调试改为内置 JavaScript STL 展示器，复用普通 GDB，无需 Python 或额外运行包；支持有界分页、只读键、容器元素赋值和原始字段回退，废弃 prettyPrinterPath。
- Default to built-in JavaScript STL display using ordinary GDB, bounded paging, read-only keys, element assignment and raw-field fallback; deprecate prettyPrinterPath.
- 新增 builtin／gdb／raw 展示模式与显式 prettyPrinterFiles；GDB Python 初始化及单对象异常都有降级路径。内置展示补 list、forward_list、deque、set／multiset、multimap、unordered 变体与 weak_ptr，并增加时间预算。
- Add builtin/gdb/raw display modes and explicit prettyPrinterFiles, with initialization and per-object Python failure fallback; extend built-in list, forward_list, deque, set/multiset, multimap, unordered variants and weak_ptr displays with a time budget.
- 新增多符号镜像、ELF／HEX／BIN 下载配置与 launch／attach／reset GDB hooks；校验镜像地址、同名符号和主 RTOS 类型身份，attach 默认流程不下载，无法消歧的对象禁止赋值。新增下载流程通过内存 RSP 原生 GDB 测试，实板验收待完成。
- Add multiple symbol images, ELF/HEX/BIN load configuration and launch/attach/reset GDB hooks; validate addresses, duplicate symbols and primary RTOS type identity. Managed attach does not download; ambiguous objects cannot be assigned. Native GDB tests use an in-memory RSP target; board acceptance remains pending.
- 改进普通 C++ 类的权限组与匿名成员展示，启用暂停动态类型解析；修复基类值转换路径缺少地址及虚基类展开失败，重名成员按实际存储修改。
- Improve C++ visibility and anonymous groups, enable paused RTTI resolution, and retain base-subobject reference paths for addresses, virtual-base expansion and isolated member assignment.
- ELF 变量列表过滤 C++ RTTI、虚表等内部对象；修复带编号后缀的 C 静态变量与 DWARF 的匹配及成员观察路径，缺少类型信息时显示具体原因。
- Filter C++ RTTI and vtable metadata from ELF variable lists; bind numbered C statics to DWARF, preserve their member watch paths, and explain unavailable types.
- 修复 const 指针错误限制可写对象的调试赋值，以及 C++ 成员加入查看列表后显示原始符号名；名称分行展示前缀与成员名，类型小标签放在数值左侧，读写卡片保持紧凑并居中显示数值。
- Fix editing mutable pointees through const pointers and readable C++ member names in watch lists; split prefixes and member names, place compact type badges beside values, and keep read/write cards compact with vertically centered values.
- 修复调用栈读取忽略分页造成的 GDB 超时，以及 RTOS 启动命令没有调用实际 target 的错误；H750 的 string/vector/unique_ptr 已通过普通 ARM GDB 和 FreeRTOS 实板验证。
- Bound stack frame reads to the requested page and invoke the resolved RTOS target correctly; validate H750 string/vector/unique_ptr display using ordinary ARM GDB with FreeRTOS.
- 修复 200 Hz 下默认波形历史不足 60 秒、Agent CSV 静默截短，以及失败采样和导出行数的 CSV 表示；高频缓冲改为分批裁剪。
- Fix the default chart's 60-second retention at 200 Hz, Agent CSV history truncation, failed-sample cells, and exported row counts; trim high-rate buffers in batches.
- 留存改按真实采样周期而非标称频率计算，修复周期取整后实际速率高于标称的 731 档频率留存不足 60 秒；修复嵌套容器内赋值后中间层变量引用失效。
- Size chart retention from the real sample period instead of the nominal rate, fixing the 731 frequencies whose rounded period ran faster and retained under 60 seconds; keep the intermediate variable reference alive after an assignment inside a nested container.
- 修复普通结构体容器元素赋值后引用失效，以及已缓存 RTOS 任务退出误使其他任务请求过期；降低采样频率时按时间戳保护最近 60 秒历史，显式点数上限继续优先。
- Preserve references after writes to ordinary struct elements, isolate RTOS task-exit invalidation to the owning task, and keep the preceding 60 seconds of timestamped history when reducing the sample rate; explicit point limits still take precedence.
- CSV 数据格补齐公式注入防护且保留负数读数；Agent 读取不再因用户正在导出而失败；归档达上限时向 Agent 回传 `historyTruncated`，并在导出对话框提示。
- Extend CSV formula guarding to data cells while leaving negative readings intact; stop Agent reads from failing while the user is exporting; report `historyTruncated` to the Agent and warn in the export dialog once the archive hits its size cap.
- `_Z` 开头的合法 C 全局符号不再被当作未解析的 C++ 对象；C++ 绑定诊断设上限并汇报省略条数，避免大型固件刷爆诊断通道。
- Stop treating legal C globals that begin with `_Z` as unresolved C++ objects; cap C++ binding diagnostics and report how many were suppressed so a large firmware cannot flood the channel.

## [0.7.14] - 2026-09-29

- 优化高频采样时侧栏与波形图变量数值的稳定显示；波形图可从主侧栏追加观察变量并跳过重复项。
- 侧栏显示带正式版或 beta 标识的版本号；清理过期文档及失效引用。
- 修复 Windows 采样计时器约 15.6 ms 粒度导致的目标与实测频率差距；仅采样期间申请高精度计时，并在改频后重置实测速率窗口。
- 实时查看改用采样频率（Hz）设置，默认 30 Hz 并保存到工作区；调整频率后根据探针读耗时快速采用安全间隔。
- 修复 Agent 烧录可执行文件覆盖路径，统一 ELF 64 MiB 有界读取与授权快照。
- 修复 SVD 跨作用域继承和写入约束校验；通过 Worker 与展开预算限制解析资源。
- 修复 ELF 并发加载误报，合并外设批量读取，拆分 Agent 路由并增加安全模块覆盖率门禁。

## [0.7.13] - 2026-09-26

- 修复 DWARF 结构体、联合体及 typedef 复合变量的识别与按需展开，恢复侧栏和实时监视中的成员浏览及已选变量。
- Fix DWARF struct, union, and typedef recognition and lazy expansion, restoring member browsing and selected variables in the sidebar and live watch.
- 修复无符号枚举和多维数组的类型及成员偏移解析；布尔变量仅允许写入 0 或 1，类型信息不可靠时拒绝写入。
- Fix unsigned enum and multidimensional array types and offsets; restrict boolean writes to 0 or 1 and reject writes without reliable type information.

## [0.7.12] - 2026-09-26

- 新增侧栏“外设寄存器”外设树，与 MCU 配置、芯片信息和实时读写并列；在其他配置中绑定 SVD 后自动可用，支持寄存器/位域读取、格式切换及侧栏内直接写入（Agent Skill 写入保留许可）。
- Add a native XPERIPHERALS sidebar tree beside the main tools, available automatically after binding an SVD under Other Configuration, with register/field reads, value formats, and direct inline UI writes (Agent Skill permission remains required).
- 大型 ELF 变量列表改为分批加载，结构体成员按需解析；重复类型共用布局缓存，单个过大类型不再影响其他变量。
- Load large ELF variable lists in batches and resolve composite members on demand; shared layout caching keeps one oversized type from hiding other variables.
- 芯片信息中新增目标暂停、继续和重置运行操作；外设寄存器可写行直接显示输入框和 ±1 按钮，并在提交前校验数值格式与位宽。
- Add pause, continue, and reset controls to Chip Info; writable peripheral rows now show inline inputs and ±1 buttons with value and bit-width validation before submission.

## [0.7.11] - 2026-09-26

- 修复 Ubuntu 等环境中 OpenOCD 0.12.0 编号式适配器列表的解析，避免连接预检误报无法识别适配器列表；保留其他列表格式的兼容性。
- Fix parsing of OpenOCD 0.12.0 numbered adapter lists on Ubuntu and other environments, preventing unrecognized adapter-list errors during connection preflight while preserving compatibility with other list formats.

## [0.7.10] - 2026-09-25

- Windows x64 下选择 J-Link 的 WinUSB 驱动时备份旧 SEGGER 驱动；SEGGER 驱动下的硬件操作会直接报错，调试器卡片可恢复原驱动。发布包对未签名的 helper 与 libwdi 执行 SHA-256 内容校验。
- On Windows x64, selecting WinUSB for J-Link backs up the SEGGER driver; hardware operations reject the SEGGER driver, and the debugger card can restore it. Release artifacts verify SHA-256 hashes of the unsigned helper and libwdi.
- 优化 J-Link 驱动切换速度；切换期间显示加载状态并阻止探针操作，按设备实际驱动校验结果更新下拉栏。
- Speed up J-Link driver switching, show progress and block probe operations during the change, and update the selector only after verifying the device driver.
- Windows J-Link 枚举改用原生只读接口，重复切换时复用已准备的 WinUSB 包；切换完成前验证 OpenOCD 能打开接口，并修复调试失败后侧栏一直显示“正在执行”。
- Use native read-only J-Link inventory on Windows, reuse the prepared WinUSB package, verify OpenOCD interface readiness before completing a switch, and end the sidebar's pending state when debug startup fails.
- 修复打包扩展中原生探针枚举程序的路径，使芯片读取、采样和烧录启动时不再因错误回退到慢速 PowerShell 枚举。
- Fix the bundled native probe inventory path so chip reads, sampling, and flashing no longer fall back to slow PowerShell enumeration during startup.

- J-Link 默认自动选择唯一探针和协议，成功后记住工作区连接；高级覆盖保留，失败不自动切换协议或降速。
- J-Link now selects a unique probe and transport automatically and remembers successful workspace connections; advanced overrides remain, with no protocol or speed retries.

- 新增 J-Link 序列号选择、显式 SWD/JTAG 与调试速度配置、连接预检和可复制诊断；写入授权绑定连接身份，配置变更后阻止旧会话写入。
- Added J-Link serial selection, explicit transport and adapter speed, connection preflight and copyable diagnostics; write authorization binds the connection and rejects writes from sessions with changed settings.
- 修复 J-Link 原生日志、VTarget 和 Worker 错误详情处理；HIL 复用正式连接参数并要求明确校验成功标记。
- Fixed native J-Link log, VTarget and worker error handling; HIL uses production connection arguments and requires an explicit verification success marker.

## [0.7.9] - 2026-09-18

- 新增 Linux CubeMX 自动发现、配置、固件包检测与安装、隔离生成和深度检查；工具链检测支持重新读取用户 shell 的 PATH。
- Added Linux CubeMX discovery, configuration, firmware package detection/installation, isolated generation and deep checks, plus refreshed shell PATH lookup for debug tools.

- 修复 GDB 下载进度消息导致调试中断；抑制持续目标轮询失败时采样状态闪烁，并避免 H7 芯片信息读取扫描其他系列寄存器。
- Fixed GDB download progress parsing, repeated polling-error flicker, and cross-family register probing during H7 chip inspection.

- 新增独立 EmberProbe 断点调试器，支持基础 GDB 调试、launch/attach 与现有采样协作，无需安装 Cortex-Debug。
- Added the independent EmberProbe debugger with GDB debugging, launch/attach, and sampling integration; Cortex-Debug is no longer required.

## [0.7.8] - 2026-09-17

- 修复 Windows ELF 路径盘符大小写导致烧录授权失效，以及正常目标电压被误报为未供电。
- 新增统一 SWD/JTAG 传输配置、J-Link USB 驱动/占用诊断、完整脚本预检与多型号探针选择。
- Fixed Windows ELF path identity during flash authorization and false low-voltage diagnostics.
- Added shared SWD/JTAG transport settings, USB driver/ownership diagnostics, script preflight, and explicit selection for multiple probe types.

- 新增 Agent Skills 采样启停与状态查询，与侧边栏和图表共享采样状态。
- Added Agent Skills sampling start, stop, and status commands synchronized with the sidebar and charts.

## [0.7.7] - 2026-09-14

- 新增工作区共享的变量固定配色与线型、曲线悬停读数、聚焦查看和独立冻结快照导出；隐藏成员保留采样与历史。
- 精简波形工具栏与悬停提示，变量卡片改为右键设置类型和样式、左侧全高色条、右侧实时值和 ×；优化结构体布局，ELF 全部变量列表仅保留名称与类型。
- OpenOCD 传输与采样时钟移入工作线程，降低扩展宿主繁忙造成的采样停顿；Hz 按采集时间计算。
- 修复窗口重新聚焦时 Skill 开关与 OpenOCD 状态闪烁；冻结后仍可悬停读取其他位置与曲线。
- Added workspace-shared series styles, hover readings, focus view, and frozen snapshot export; hidden members retain sampling and history.
- Simplified chart controls and variable cards with context-menu type/style settings, full-height color strips, right-aligned values, and clearer composite layouts; removed addresses from the ELF variable list.
- Isolated OpenOCD transport and sampling timing in a worker thread and calculate Hz from acquisition timestamps.
- Fixed sidebar status flicker on window refocus and kept hover inspection responsive while charts are frozen.

## [0.7.6] - 2026-09-12

- 修复 CubeMX 警告掩盖错误、已完成请求误去重、清单保存失败状态丢失和完整日志截断；快检仅跟踪可识别的生成文件，深检支持取消通知，并增加显式真实 CubeMX 检查入口。

- CubeMX 生成与诊断全流程升级（P0/P1）：
    - **日志判定与布局诊断**：在 `cubemxLog` 中按语义与严重级别分类日志，移除任意 `not found` 即失败的规则；`ERROR/FATAL`、异常堆栈、缺失依赖及迁移要求仍阻断执行；普通警告作为 WARN 记录；成功判定仍严格要求零退出码、生成命令完成与产物新鲜度检查；布局错误返回预期根目录、候选目录及失败原因；stdout/stderr 流式写入磁盘并在失败时保留。
    - **操作记录与写回状态**：新增 `cubemx.start` 与 `cubemx.status` 异步操作记录，支持按 ID 或当前工程查询；源工程状态固定为 `unchanged / committed / rolledBack / recoveryRequired / unknown`，写入前的工程变化按 `unchanged` 报告而非回滚；写回与读回校验完成后标记 `committed`，失败诊断（首个关键信息、警告摘要、日志路径）随记录持久化；扩展重启后未完成记录标记为中断并使用专用中断错误码；CLI 在发起请求前把请求 ID 持久化到工作区 `.emberprobe-cubemx-audit/`，未确认请求重跑自动去重，已完成请求重新执行时创建新操作；新增按操作 ID 取消。
    - **快速一致性检查与深检**：新增 `cubemx.check`，支持 `quick` 和 `deep` 模式；成功生成后保存生成清单；快检对比当前 IOC 与清单，不要求 CubeMX 可用，对包含完整唯一 `USER CODE` 的源码分别比较生成区与用户区并报告改动的块名，用户区修改不作为初始化漂移；深检作为可查询的后台操作执行（CLI 内部轮询，超时可按操作 ID 查询），在隔离副本中生成并对比当前工程，列出不再再生成的遗留文件（`staleCandidates`，仅提示），失败时保留 CubeMX 日志；不修改源工程且不覆盖历史清单。
    - **最小候选变更**：支持 `--changes-file` 与显式键删除 `--deletions`；校验已声明 IP/Pin 集合的计数、连续索引与重复项；差异摘要按 IP、引脚、时钟、元数据分类。
    - **精简输出与兼容接口**：`cubemx.inspect` 支持摘要、属性前缀过滤（`--prefix`）与全量模式（`--full`）；`cubemx.prepare` 默认返回精简变更摘要与验证层级，全量差异保存为本地 JSON；Bridge capabilities 增加新方法，CLI 遇到不支持的方法时提示升级。
    - **Skills 规则优化**：`mcu-cubemx` 采用 start → status 异步轮询与超时查询流程；共享工作流增加症状诊断顺序与“观察事实／假设／下一项验证”规范；修正 `mcu-fault-analyzer` 中 Thread 状态与功能正常的表述，明确重生成后的重新构建与烧录要求。

- 根据 STM32 target 和可选 `.ioc` 检查 CubeMX 固件包，缺包时提供原生交互安装入口；其他配置统一显示“可选”。

### Added

- CubeMX 新增候选 `.ioc` 派生命令，支持指定键值变更并保留其他文本；权限查询与生成校验解耦，返回授权记录及当前适用性。

- 新增 Windows `mcu-cubemx` Skill：检测 CubeMX、选择工作区 `.ioc`，经单次或 24 小时授权执行隔离代码生成，并检查原有代码与保留恢复副本。
- MCU 配置的“其他配置”新增全局 CubeMX 路径和工作区 `.ioc` 路径。

### Fixed

- 插件启动或切换工作区时，自动检查并更新已开启的工作区 Skills（含同版本内容差异和缺失文件）；关闭状态不自动安装。

- CubeMX 在实际输出目录预置旧工程以保留 USER CODE，验证本次生成产物；基线检查区分换行符及已知元数据路径差异，同时继续拦截真实手改冲突。日志流独立记录完成与错误状态，避免截断漏报、FATAL 漏判及零错误计数误报，并覆盖 C++ 用户代码保护。

- 修复 `.ioc` 合法转义键名被拒绝的问题，支持 Properties 转义、续行与分隔符，语法诊断包含行号；允许工程内工具链子目录布局（`UnderRoot=false`），保留版本与外部路径检查。

- CubeMX 检测读取官方 updater.ini 的安装路径与软件版本，并兼容 ST 官方 VS Code 扩展的用户级路径设置，支持非默认目录安装。

- RAM 写入的工作区信任绑定 ELF SHA-256，固件变化和旧版授权均要求重新确认。
- Agent Bridge 校验本地 Host 与端口、使用恒定时间令牌比较，超限请求返回完整 413 响应，并处理上传中断。
- DWARF 缩写属性和复合布局展开增加预算限制，避免异常 ELF 导致内存与 CPU 消耗失控。

### Changed

- Skills 安装改为当前工作区开关，移除全局安装入口与数量标签；其他配置统一图标对齐并使用不同图标，`.ioc` 改为工作区文件列表选择。

- Webview 资产写入与清理改用异步 I/O，缓存相同内容，并防止异步刷新覆盖新视图或恢复已关闭面板。

## [0.7.5] - 2026-09-09

### Fixed

- 测试运行器统一使用独立且规范化的临时目录，避免 macOS 路径别名导致断言反复失败；补充跨平台目录别名与残留清理回归测试。

### Added

- 修复 ELF 更新后波形图导入列表未刷新的问题，保留仍有效的勾选；补充结构体成员绘图提示。
- 波形 CSV 按面板独立归档并标注观察类型，避免侧栏或其他面板的类型覆盖导出值；64 位整数曲线使用精确差值计算，保留相邻大整数的变化。
- Agent Skills 诊断新增请求上下文：`error.details` 携带方法名、实际超时预算与耗时；状态变更请求在传输超时时标记 `resultUnknown`，提示用对应查询方法核对实际状态，而非在客户端自动重发。
- `mcu-flash` 预检新增每个字段（ELF、target、probe、OpenOCD）的来源标记 `sources`（explicit/config/auto/default/none），并在 Agent Bridge 配置获取失败时保留原始 `diagnostics`，不再静默吞掉异常。
- 新增八个 Agent Skills 共享的操作与证据契约文档 `_emberprobe/agent-workflow.md`，覆盖失败处理、重试上限、跨 skill 调用与结果范围表达；每份 `SKILL.md` 在命令示例前说明适用任务、依赖、前置状态、副作用与成功证据。

### Changed

- Cortex-Debug 启动前检查 GDB、objdump 和 nm，缺失时引导选择工具链根目录或 bin 目录并按工作区记忆；将解析出的路径直接传入调试配置，在工具链检查通过后才启动 OpenOCD。
- Windows 工具链查找在进程 PATH 失效时补查系统当前保存的 PATH，支持安装工具链后未重启 VS Code 的情况。

- 将 `mcu-download` 与 `mcu-flash-verify` 整合为 `mcu-flash`，将 `mcu-live-watch` 与 `mcu-var-write` 整合为 `mcu-variables`；读取、写入、编程与校验仍保持独立脚本和原有授权边界，安装器仅自动清理未修改的旧 Skill 目录。
- Agent Bridge 超时不再默认暗示“采样占用”：连接失败、请求超时与服务错误分别描述，缺少服务端结果时明确原因未知；只读请求可在前置不变时最多重试一次，状态变更请求超时不自动重发。
- 安装完整性检查改为按 `manifest.shared` 显式清单比对，共享 Markdown（如 `agent-workflow.md`）缺失或变更也会使相关 Skills 显示需修复或更新；已安装用户需通过现有安装流程更新 Skills。

## [0.7.4] - 2026-08-31

### Fixed

- 重建 ELF 后刷新变量列表时，侧栏与所有实时图表中已选变量会按名称重新绑定当前 ELF 的地址、类型和复合布局，移除已不存在的变量、清除旧值并立即刷新采样计划，不再继续读取旧地址。
- Cortex-Debug 启动增加有界恢复：即使 VS Code 的 `startDebugging` 一直未返回或调试适配器提前退出，也会结束侧栏“执行中”状态、停止残留会话、释放托管 OpenOCD 并恢复采样；Windows Cortex-Debug 1.12.1 使用针对其固定 GDB 启动超时的诊断与 15 秒恢复边界，其他环境保留 60 秒安全上限。

## [0.7.3] - 2026-08-30

### Added

- 采样归档与 CSV 导出：采样开始后自动把完整历史写入临时归档，无需单独开启录制；可随时按变量和时间范围流式导出 CSV，扩展退出时自动删除内部数据。新增 `emberprobe.samplingArchiveMaxMiB` 限制当前扩展会话的归档磁盘占用（默认 1024 MiB）。

### Fixed

- OpenOCD 测试假件的连接增加 error 处理，避免拆除连接时的 `ECONNRESET` 在 macOS/Windows 上崩溃测试进程。

## [0.7.2] - 2026-08-28

### Added

- 实时变量观测支持在 EmberProbe 托管的 Cortex-Debug 运行态下共享 OpenOCD 只读采样：调试运行中即可观察 ELF 可写 RAM 段内的变量，无需停止调试；侧边栏显示共享连接与运行态采样状态，共享 Tcl 读取不可用时自动降级为暂停后经 DAP 读取。

### Changed

- Cortex-Debug 运行态共享读取增加安全边界：仅允许完全位于 ELF 可写 RAM 段内的变量，超出每周期安全预算（4096 字节 / 32 次读取）时明确报错；`mcu-var-write` 在运行态下拒绝写入，运行时共享保持只读。

### Fixed

- Cortex 工具链测试统一比较规范化真实路径，兼容 macOS 将 `/var` 映射为 `/private/var`，修复 CI 在 macos-latest 上的失败。

## [0.7.1] - 2026-08-27

### Added

- 新增 `mcu-peripheral-debug` Agent Skill：解析 CMSIS-SVD 外设/寄存器/位域与枚举，在 Cortex-Debug 暂停态下读取解码，并使用绑定 SVD、会话、停止代次和寄存器旧值的一次性确认安全写入。
- 新增 `mcu-debug-control` Agent Skill：通过 VS Code/DAP 启动和控制 Cortex-Debug 会话，支持暂停、继续、单步、重启、停止以及源码行/函数断点管理。

### Changed

- `mcu-live-watch` 升级至 1.7.0：Cortex-Debug 暂停时通过 DAP 读取标量与复合变量，不再启动临时 OpenOCD 争抢探针；运行态仍拒绝隐式暂停。

### Fixed

- 调试控制改为并发观察 DAP 响应与状态事件，已经由 epoch/最终状态确认成功的 restart/continue/pause 不再因适配器 Promise 迟到而误报 `BRIDGE_TIMEOUT`；重叠控制请求返回 `DEBUG_CONTROL_BUSY`。
- DWARF 解析支持 ELF `SHF_COMPRESSED` 和 GNU `.zdebug_*` 压缩调试节，`volatile -> typedef -> struct/union/array` 复合变量可正常展开。

## [0.7.0] - 2026-08-25

### Added

- Cortex-Debug 接入：安装 Cortex-Debug 后可从 EmberProbe 快速启动断点调试（[#12](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/issues/12)）。
- 波形图支持伸缩、移动坐标轴和时间范围选择，改善波形观察交互。
- 增加 OpenOCD 版本检测与不兼容提醒，要求 OpenOCD 0.12.0 或更高版本。
- 增加 SVD 文件选择、官方 CMSIS-Pack 下载、校验、全局去重库与工作区绑定，并为后续 Skills 预留接口。

### Fixed

- 修复 STM32H7 系列读取芯片信息后采样值不再更新的问题：运行态芯片信息读取不再主动 halt/resume。
- 调试器与 MCU 配置列表改为从当前 OpenOCD scripts 动态发现，支持 WCH 等第三方 OpenOCD 分支并避免展示当前版本未包含的配置（[#13](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/issues/13)）。
- OpenOCD 环境检查新增最低版本门禁（`>= 0.12.0`）：0.11.x、0.12.0 RC 或无法识别版本的构建不再进入下载、调试、实时读写和 Agent Flash Skills；Windows x64 会引导一键切换到插件内置 xPack OpenOCD 0.12.0-7，其他平台显示升级与重新选择路径提示。
- Flash Skills 跨平台测试在 macOS 上统一比较规范化真实路径，兼容系统将 `/var` 映射为 `/private/var`；常规 CI 仅在分支推送和 Pull Request 上运行，发布标签由 Release 工作流独立验证，避免同一标签重复执行整套门禁。
- OpenOCD 0.12 的 `verify_image` 在 STM32H7/F4 等 target 上会使用 `backup=0` 的 RAM work-area，可覆盖与之重叠的 `.data/.bss`；独立校验现在禁用 target work-area 并回退为主机侧比对，下载与 Cortex-Debug 则对所有 target 开启 work-area 备份恢复。
- Cortex-M7 等目标的小字节变量写入改为对齐 32 位读-改-写，并在短暂 halt 期间执行写前/写后回读、严格 Tcl 错误判定和原运行状态恢复，避免 byte-lane 写入被丢弃后误报通信成功。
- 已知运行时无法通过调试器访问内存的 GD32VF103 现在会在启动非侵入实时采样前明确拒绝，不再循环报“读取内存失败”。

### Security

- 所有插件和 Agent Skill 的 OpenOCD 启动入口现在都解析可执行文件及 scripts/cfg 的规范真实路径，使用绝对 `-f`/`-s` 并从可信 scripts 目录启动，防止工作区中的同名 `target/`/`interface/`/Tcl 文件被 OpenOCD 优先加载执行。
- 一次性下载/校验和 Agent Skill 增加有界超时，避免 OpenOCD 或探针异常时任务无限挂起。

## [0.6.3] - 2026-08-24

### Added

- 实时变量全链路支持 `u64`/`i64`/`f64`：64 位整数通过 `valueText` 提供精确十进制值，图表仍使用 Number 近似值绘制；Agent 读写、复合成员、侧边栏和 CSV 导出均保留精度。
- CSV 导出对话框支持选择曲线和全部/最近 10/30/60 秒/自定义时间范围，保存成功后显示导出系列数和数据行数。
- 实时图表支持同时打开多个面板；每个面板保留独立观察列表、类型解码和历史缓冲，共享底层 OpenOCD 会话、启停状态和采样间隔。
- `mcu-live-watch` 1.6.1 新增图表历史 CSV 读取/导出：Agent 可按面板、曲线与绝对/最近时间区间选取数据，返回 CSV 内容或写入指定文件。

### Changed

- `mcu-live-watch` 升级至 1.6.1，`mcu-var-write` 升级至 1.2.0；直接 Tcl fallback 可读取 8 字节标量，写入 Skill 保留原始十进制文本避免 JavaScript Number 精度丢失。
- CSV 双端时间轴改为常显的剪辑轨道样式；非自定义模式时置灰并禁止拖动，自定义模式默认全选且以打开导出对话框的时刻为右端。

### Fixed

- `mcu-live-watch --add-to` 在无显式类型后缀时改由扩展使用 DWARF 类型，避免 4/8 字节浮点变量被误存为 `u32/u64`。
- Agent CSV 导出的时间说明优先使用 `--last` 或以 `Z` 结尾的 ISO 8601 UTC 时间；失败诊断现在同时返回裸 `HH:MM:SS` 实际解析的 UTC 区间、本机时区与偏移。

### Security

- Agent Bridge 描述文件（含访问令牌）改存扩展全局存储目录，工作区只保留不含令牌的指针文件，避免令牌随 git 提交或云盘同步泄露；Bridge 停止时一并清理描述文件与指针。已安装的旧版技能脚本仍可读取旧格式描述文件，升级本版本后请在侧边栏重新安装 Agent Skills。
- Agent Bridge 的 `config.set` 拒绝修改 `openocdPath`（返回 `CONFIG_KEY_FORBIDDEN`）：该键可把后续探针调用指向任意可执行文件；如需更改请在 VS Code 设置或 EmberProbe 侧边栏中由用户完成。
- 用户未显式配置 `emberprobe.tclPort` 时，实时采样与 Agent 临时读取自动选用随机临时端口；OpenOCD 的 Tcl 端口无认证，固定默认端口会让采样期间的任意本机进程都能下发 halt/write_memory。显式配置后仍使用配置端口。
- 变量写入的 workspace 信任增加 24 小时有效期，到期后需重新走两阶段确认；旧版本存储的永久信任在升级后视为已过期。
- Agent Bridge 收到请求时若检测到已安装的 Agent Skills 被本地篡改，会弹出警告并引导重新安装（每会话一次，不阻断）。
- Webview 内嵌的 i18n JSON 序列化时转义 `<`，防止文案中出现 `</script>` 提前闭合脚本标签。
- OpenOCD 预置包解压新增显式路径断言，拒绝解析后落在暂存目录之外的条目（Zip Slip 纵深防御）。
- 重新生成 Webview 资产时清理同 scope 下不再引用的旧哈希资产，避免 `globalStorage/webview-assets` 无限膨胀。

## [0.6.1] - 2026-08-22

### Added

- Agent Skills 升级提示：插件激活与侧边栏刷新时检查已安装 skills 与内置版本的差异（可更新/被修改/不完整），首次发现差异时通知用户并可一键进入管理界面重新安装（每会话最多提示一次）。

### Changed

- mcu-download 与 mcu-flash-verify 两个 Agent Skill 由 PowerShell 重写为 Node.js（v2.0.0）：原先在 Linux/macOS 上因缺少 `powershell`/`pwsh` 而完全不可用，现在三平台统一通过 `node scripts/download.js` / `node scripts/verify.js` 调用；共享逻辑抽取到 `skills/_emberprobe/flash-common.js`，EmberProbe 配置复用不再依赖跨脚本相对路径。
- Linux/macOS 无预置 OpenOCD 包时，侧边栏改为直接给出包管理器安装指引（apt/dnf/pacman/brew）而非仅打开官网。
- `PROBE_PERMISSION_DENIED` 诊断与 OpenOCD 错误提示补充 Linux udev 规则/用户组指引。
- `emberprobe.openocdPath` 配置描述改为跨平台表述。

### Fixed

- mcu-live-watch 结构体成员/数组元素路径（`sensor.x`、`buf[0]`）在 DWARF 布局缺失时错误地报 `VARIABLE_NOT_FOUND`：现在明确报 `COMPOSITE_LAYOUT_MISSING` 并建议用 Debug 构建重新编译；基名解析补充大小写不敏感唯一匹配回退。
- DWARF 解析遇到 GNU 扩展 form（split-dwarf 场景）时不再中止整个编译单元，避免同 CU 后续变量全部丢失复合布局。
- mcu-chip-info `--fields` 不过滤：单独传 `--fields` 时脚本错误回落到 `identity` 组，导致扩展端把整组字段并回结果；现在此时传空 sections。
- mcu-fault-analyzer 与 mcu-chip-info（runtime 段）的 PC/SP/LR/xPSR 恒为空：OpenOCD 的 `catch` 会吞掉命令输出，寄存器读取改为 `echo [reg …]` 形式后才能真正到达解析器。
- PowerShell 版预检脚本中 `Join-Path '..\..\mcu-config\...'` 的反斜杠相对路径在 Linux 上失效导致配置复用静默退化为自动检测（随 Node.js 重写一并消除）。
- ELF 自动发现改为扩展名大小写不敏感，Linux 上不再漏掉 `FIRMWARE.ELF`。
- `lsusb`（usbutils）未安装时探针自动检测静默失败，现在会在预检 JSON 的 `notes` 中给出安装提示。
- verify 的 `EP_VERIFY OK/FAIL` 结果标记改为行首锚定匹配，避免把回显参数或日志中携带的 Tcl 文本误判为校验失败。
- skill 共享运行时（`_emberprobe`）变更检测覆盖目录下全部脚本，此前仅校验 `agent-client.js`。
- 烧录/校验 skill 的测试改为跨平台执行（原先仅在 Windows 上运行且在 Linux CI 上静默跳过）；其余 skill 的 SKILL.md 中 `node` 命令不再标注为 PowerShell 代码块。

## [0.5.3] - 2026-08-22

### Added

- Agent Skills 安装支持选择范围：当前项目或用户主目录（全局，所有项目可用），并可在确认后按范围整体卸载。
- 实时变量图表面板新增"导出 CSV"：按采样时间戳对齐的 RFC 4180 宽表，带 UTF-8 BOM，经原生保存对话框写出。

### Removed

- 侧边栏移除"选择 SVD 文件"与"调试"按钮；调试仍可通过资源管理器右键菜单启动。

## [0.5.2] - 2026-08-05

### Changed

- 变量写入滑条支持连续调节，拖动期间以最高 10 Hz 节流写入，并在松开时立即提交最终值。
- 输入框提交超出当前滑条范围的值时，自动平移左右端点，同时保持区间跨度和滑块相对位置不变。

### Fixed

- 写入成功或失败的圆点提示移至变量名前，避免提示状态与变量名称错位。

## [0.5.1] - 2026-08-02

### Fixed

- 修复 Windows 上 Webview 内容寻址 CSS/JavaScript 因资源 URI 与授权根不一致而返回 401，导致侧边栏退化为无样式 HTML 的问题。
- Webview 资源现在直接从 `globalStorageUri` 派生，并使用同一个 URI 作为 `localResourceRoots`，同时新增路径一致性回归测试。

## [0.5.0] - 2026-08-02

### Fixed

- 修复 GitHub Release 发布 job 未提供仓库上下文，导致 `gh release` 无法创建草稿的问题。
- 修复 Windows CI checkout 将文件转换为 CRLF，导致 Prettier 将全部受检文件误判为格式不符的问题。
- 修复 macOS CI 中 `/var` 与 `/private/var` 指向同一临时目录却被测试判为不同路径的问题。

### Added

- 新增 `release:prepare` 发布准备脚本，同步 package、lock、README 和 Changelog 版本。
- 新增稳定版本标签触发的自动发布工作流，自动创建 GitHub Release、上传 VSIX，并支持草稿事务与安全重试。
- 新增 VS Code Extension Host 冒烟测试，以及 STM32F1/F4、nRF52、RP2040 的 self-hosted HIL 工作流。
- 新增 ESLint、Prettier、checkJs 与 c8 覆盖率门禁。

### Changed

- 探针操作改由 `ProbeCoordinator` 独占租约协调，并支持实时采样启动到运行态的原子转换。
- 从主控制器拆出配置、烧录、故障和 Agent Bridge 服务。
- 侧边栏与实时图表的内联 CSS/JavaScript 在渲染时转换为内容寻址资源，CSP 不再允许 `unsafe-inline`。

## [0.4.9] - 2026-07-30

### Added

- 侧边栏新增实时变量写入列表，可通过数值输入、步进按钮和范围滑块修改变量。
- 写入沿用 DWARF 类型、ELF 可写段校验，并在每次写入后回读确认结果。

### Changed

- 结构体、联合体和数组可在侧边栏及图表中展开并选择标量叶子成员。
- 写入请求串行执行，过期响应不会覆盖较新的界面状态。

## [0.4.8] - 2026-07-29

### Changed

- MCU 变量写入改为聊天栏两阶段授权：首次展示精确写入计划，用户可选择仅本次允许或信任当前工作区。
- 工作区写入授权在首次成功写入后持久化，后续不再提醒，并可通过 `mcu-var-write --reset-permission` 撤销。
- 一次性确认 ID 与 ELF 指纹、变量地址、类型和值绑定，过期、复用或内容变化时拒绝写入。

### Fixed

- 下载与 Flash 校验 Skill 自动复用 EmberProbe 保存的 OpenOCD、探针、目标和 ELF 配置。
- 修复 Flash 校验 Tcl 命令的 PowerShell 字符串格式化异常。

## [0.4.6] - 2026-07-27

### Added

- 芯片信息新增 CoreSight ROM Table JEP106 厂商指纹，可识别已知的 STM32 兼容芯片厂商与品牌。
- 身份信息读取会扫描已知 STM32 家族寄存器，在 target 配置选错时仍可根据 DEV_ID 修正芯片系列。

### Fixed

- ROM 指纹无法确认厂商时保持未知，不再仅根据 STM32 target 误报为 STMicroelectronics。
- 未收录的 DEV_ID 仅从目标家族寄存器回退，避免将其他候选地址的数据误识别为芯片 ID。

## [0.4.5] - 2026-07-24

### Fixed

- Agent `watch.add` 现在会正确添加结构体成员、数组元素或数组范围，而不是退化为整个复合变量。
- 拒绝负数、越界或格式错误的数组路径，避免读取变量范围之外的目标内存。

## [0.4.4] - 2026-07-24

### Changed

- Repackaged the extension for Marketplace validation after the 0.4.3 Repository Signing service returned a transient retry error; no runtime behavior changed.

## [0.4.3] - 2026-07-23

### Added

- Agent Bridge 错误响应新增结构化诊断字段：错误码、分类、失败阶段、可能原因、可重试性、建议动作和 OpenOCD 日志摘要。
- 实时变量与趋势采样可区分探针未找到、目标 MCU 未连接、目标未供电、USB 权限、Tcl 端口冲突、通信超时和 OpenOCD 配置错误。
- `mcu-live-watch`、`mcu-chip-info` 与 `mcu-config` 失败时统一向 stderr 输出机器可读的 `diagnostic` JSON。

### Changed

- `mcu-live-watch` 明确要求 Agent 依据诊断结果推理，禁止把任意读取失败表述为“active Tcl service 未启动”或要求用户手动开启采样。

## [0.4.2] - 2026-07-23

### Changed

- Agent 趋势读取现在可在用户未开启采样时自主启动临时采样，完成后自动关闭并释放探针。
- Agent 临时采样的启动、进度、完成与取消状态会同步到侧边栏和图表；用户可从任一界面提前停止。
- 趋势 Skill 直接通过最新 ELF/DWARF 推断变量类型，并只输出紧凑的趋势汇总，避免源码搜索与冗余逐点输出。
- 用户已开启采样时仍复用现有会话，不会在趋势读取结束后关闭用户的采样。

## [0.4.1] - 2026-07-23

### Changed

- Agent 单次读取全局变量现在只需提供变量名；扩展从最新 ELF/DWARF 自动推断类型，并支持唯一的大小写无关名称匹配。
- 已开启实时采样时复用现有 Tcl 连接；未开启时自动临时启动调试探针，读取一次后立即关闭，不再要求用户手动开始采样。
- `mcu-live-watch` 指令明确禁止在正常单次读取前搜索源码声明，从而减少 Agent 工具调用与 token 消耗。
- 工作区安装 `mcu-live-watch` 后会自动激活 EmberProbe Agent Bridge，无需先打开侧边栏。

## [0.4.0] - 2026-07-23

### Added

- Agent Skills 安装状态现在可区分未安装、部分安装、可更新、本地修改和完整安装，并逐项校验四个 Skill 的必需文件。
- 新增 `mcu-chip-info`，支持按字段或 identity/debug/runtime 分组读取芯片信息。
- 新增 `mcu-config`，允许 Agent 在白名单范围内修改 EmberProbe 配置并立即同步侧边栏。
- `mcu-live-watch` 新增侧边栏/图表变量添加、ELF SHA-256 指纹和上升/下降/稳定/波动趋势分析。
- 新增仅监听本机、按工作区令牌鉴权的 Agent Bridge。

### Fixed

- 修复 Windows 下 `Get-PnpDevice` 权限失败后自动检测直接返回空结果的问题；现在降级使用 `pnputil`。
- 扩充 CMSIS-DAP、DAPLink、MCU-Link、Picoprobe、ST-Link、J-Link、XDS110 和 Nu-Link 的名称匹配与回归测试。
- ELF 符号缓存改用内容指纹；ELF 重建后重新解析变量地址，采样期间文件变化会立即停止。

## [0.3.1] - 2026-07-22

### Added

- 侧边栏「ELF 全部变量」栏目新增刷新按钮：重建 elf 后手动刷新即可看到新增变量，无需重载窗口。符号缓存键加入文件大小，配合 mtime 双重判定，避免仅改内容而 mtime 未变时的脏命中。
- ELF 全部变量数徽标紧贴刷新按钮显示，与标题分离不再拥挤。

### Fixed

- 下载前自动停止实时采样并短暂等待 OpenOCD 进程退出、USB 句柄释放；调试会话（cortex-debug）启动或断开时同样自动停止读取，避免探针争抢。
- 修复图表面板「当前数值」栏宽过窄时地址与实时数值重叠的问题：移除地址可见显示，仅保留为悬停提示。

## [0.3.0] - 2026-07-21

### Added

- 界面双语支持（简体中文 / English）：侧边栏右上角新增语言切换按钮，可在中英文之间即时来回切换，无需重载；实时变量图表面板同样内置切换按钮，并与侧栏语言保持同步，语言选择持久化保存。
- 新增统一多语言词典模块（`src/i18n.js`），主进程与 Webview 共用同一份中英文案，覆盖侧栏 UI、芯片信息、OpenOCD 环境状态卡、下载进度日志、实时采样状态、命令错误与原生通知等。主进程向 Webview 发送结构化的 key + 参数，由 Webview 按当前语言即时渲染。
- 首次使用时按 VS Code 显示语言自动选择界面语言（`zh-*` → 中文，其余 → 英文）；用户手动切换后以手动选择为准并持久化保存。

### Note

- `EmberProbe OpenOCD` 伪终端的日志汇总，以及极少数底层运行时错误细节仍保留中文；常见状态与失败原因均已双语化。

## [0.2.1] - 2026-07-20

### Fixed

- 修复 Windows 上 OpenOCD 探测缓存永不命中的问题（where.exe 解析后的绝对路径与配置原始值比较不等）。
- 修复探针互斥守卫的 TOCTOU 竞态：标志位在首个 await 之后才置位，并发操作可绕过守卫导致探针争抢。
- Windows 上裸命令名通过 where.exe 解析完整路径，修复 PATH 中 OpenOCD 探测失败。

## [0.2.0] - 2026-07-20

### Added

- 新增侧栏「芯片信息」区：通过 OpenOCD 非侵入读取芯片信息，按优先级分层展示——顶部状态（未连接/正在读取/读取完成/读取失败）、芯片系列与内核摘要卡、以及适配器时钟/内核修订/目标状态/调试探针的 2×2 核心网格；次要内容收入默认折叠的「详细信息」，分为芯片信息（Device ID/Revision ID/Flash 容量/字节序/UID 可复制）、调试连接（调试器/传输协议/适配器时钟/目标电压/Target）与运行信息（目标状态/PC/SP/LR，仅在芯片已暂停时读取寄存器，绝不主动暂停运行中的程序）。

## [0.1.2] - 2026-07-20

### Added

- 新增 OpenOCD 侧边栏状态卡，集中展示检测、安装、验证和错误状态，并提供一键安装、选择路径与重新检测操作。
- Windows x64 版本内置 OpenOCD 离线预置包，安装前验证可执行文件，失败时保留原安装。
- 新增侧栏独立实时数值列表：展示当前 ELF 的全部全局/静态变量，点击后加入数字查看，不与图表变量列表互相影响。
- 新增 `mcu-live-watch` Agent Skill，可通过 OpenOCD Tcl-RPC 读取当前实时变量值。

### Changed

- 图表面板自适应 Webview 可用空间，当前数值栏支持折叠与左右拖拽调整宽度，折叠按钮会通过分栏方向和高亮状态区分展开/折叠。
- ELF 变量浏览区支持折叠及从底部分界线拖拽调整高度；变量类型与地址使用对齐列展示。
- 自动检测配置收纳到 MCU 配置区并与手动配置做视觉区分，移除冗余的“推荐”标记与“关键操作”区。
- 图表导入窗口将变量类型、地址和大小拆分为对齐列，并使用跟随 VS Code 明暗主题的遮罩。
- 扩展运行时代码改为单文件 bundle，确保 npm 依赖完整进入 VSIX；最低 VS Code 版本调整为 1.85。

### Fixed

- 修复嵌套的“ELF 全部变量”面板折叠后箭头仍保持向下的问题。
- 修复浅色主题下采样间隔输入框出现白色原生微调按钮的问题。
- 修复侧栏与图表的开始/停止采样状态不同步，以及部分 ELF 全局变量无法出现在列表中的问题。
- 结构体和数组现在会被识别为不支持直接采样的复合类型，避免按标量错误读取。
- 修复首次安装或选择 OpenOCD 后当前操作仍使用旧路径，以及工作区配置遮蔽全局配置的问题。
- OpenOCD 缺失提示和安装进度改在侧边栏展示，不再从右下角弹出通知。

## [0.1.1] - 2026-07-17

### Added

- 实时变量查看：解析 DWARF 调试信息，在“从 ELF 导入变量”列表中显示各变量的 C 类型（如 float / uint16_t），并据此设定默认观察类型（float→f32）
- 导入列表提升显示上限并显示变量总数，避免变量被静默截断

### Changed

- 无 DWARF（未用 -g 构建）时类型按大小推测，并在导入列表给出提示

## [0.1.0] - 2026-07-17

### Added

- 新增「实时变量查看」：以 OpenOCD 服务模式 + Tcl-RPC 在 Cortex-M 运行中非侵入读取 RAM，按 ELF 符号显示变量数值并绘制实时曲线
- 独立面板支持从 ELF 导入变量、按名添加、选择类型（u8/i8/u16/i16/u32/i32/f32）、可调采样间隔
- 新增纯 JS 的 ELF32 符号解析与 OpenOCD Tcl-RPC 内存读取（受 MCUViewer 启发的独立实现，未使用其代码）
- 新增配置项 emberprobe.tclPort / emberprobe.sampleIntervalMs / emberprobe.maxSamples
- 实时查看与烧录互斥，避免探针占用冲突

## [0.0.4] - 2026-07-17

### Changed

- OpenOCD 终端不再镜像原始输出，改为逐行解析关键事件
- 成功时汇总展示固件名、芯片/器件 ID、Flash 容量、探针、适配器时钟、写入与校验字节数及耗时
- 失败时解析并列出错误原因，并按错误类型给出排查建议（配置脚本缺失、端口占用、连接失败、供电异常、JTAG/SWD 链路、USB 驱动、超时、读保护、Flash 写入/擦除、校验、未停机等）

## [0.0.3] - 2026-07-17

### Fixed

- 修复 ELF 路径含空格时 OpenOCD program 命令解析失败的问题
- 修复 Nu-Link 调试探针无法自动识别（设备名含连字符）
- OpenOCD 终端日志按行解析着色，正常输出不再全部标红
- 调试会话复用 emberprobe.openocdPath 配置，启动前检测 Cortex-Debug 扩展
- 移除 MCU 列表中的 OpenOCD 自测配置项（faux、test_syntax_error 等）
- 修复 QuickPick 取消时资源泄漏、下载可并发执行、进度消息丢失等问题
- Agent Skill 脚本补充 gd32e23 识别规则，配置名校验兼容非 ASCII 名称
- 资源管理器右键菜单仅在文件夹上显示

## [0.0.2]

- Initial release
