# 用户界面文案与错误入口清单

审计日期：2026-10-07。静态扫描 `src/`；源码基线：`b50dd8b`。

本清单保留修复前的扫描快照，行号和原始表达式用于理解审计证据。修复后的行为见 [修复记录](UI-MESSAGES-AUDIT.md#修复记录2026-10-07)。修复新增 `common.diagnostics`、`sb.commandCancelled`、`oc.probeFailed`、`oc.errPermission` 四组中英文文案，并修正 `run.voltageLow`；当前源码为最新文案来源。

此清单区分“文案定义”和“运行时实际展示”。本地化字典包含按钮、状态、成功提示、错误与警告，不能把条目总数当作错误数量。原始错误表达式也可能只供内部服务或 Agent 使用；可达性与准确性结论见 [审计报告](UI-MESSAGES-AUDIT.md)。GDB、OpenOCD、文件系统与网络可产生动态文本，无法静态穷举所有最终字符串。

## 直接 VS Code 通知调用

共 46 处调用：Error 11，Warning 21，Information 14。Warning 包含许可确认；多个入口可能共用文案。

| 级别 | 来源（行号） | 调用表达式 |
| --- | --- | --- |
| Information | [src/mainViewProvider.js:429](../src/mainViewProvider.js) | `vscode.window.showInformationMessage(this._t("common.copied"))` |
| Error | [src/mainViewProvider.js:431](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("common.copyFailed", { message: error.message }))` |
| Warning | [src/mainViewProvider.js:532](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.noElfFound"))` |
| Information | [src/mainViewProvider.js:552](../src/mainViewProvider.js) | `vscode.window.showInformationMessage( this._t("msg.elfSelected", { name: path.basename(finalPath) }) )` |
| Error | [src/mainViewProvider.js:565](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.selectElfFailed", { error: errorMsg }))` |
| Warning | [src/mainViewProvider.js:590](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(error.message)` |
| Information | [src/mainViewProvider.js:594](../src/mainViewProvider.js) | `vscode.window.showInformationMessage(this._t("msg.debuggerSelected", { name: debuggerCfg }))` |
| Warning | [src/mainViewProvider.js:624](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(error.message)` |
| Information | [src/mainViewProvider.js:628](../src/mainViewProvider.js) | `vscode.window.showInformationMessage(this._t("msg.mcuSelected", { name: mcuCore }))` |
| Warning | [src/mainViewProvider.js:650](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.agentReadBusy"))` |
| Warning | [src/mainViewProvider.js:654](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.debugBusy"))` |
| Error | [src/mainViewProvider.js:669](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.configIncomplete"))` |
| Error | [src/mainViewProvider.js:682](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.openWorkspaceForDebug"))` |
| Error | [src/mainViewProvider.js:829](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.debugFailed", { error: errorMsg }))` |
| Warning | [src/mainViewProvider.js:847](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.downloadBusy"))` |
| Warning | [src/mainViewProvider.js:855](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.debugBusyForDownload"))` |
| Warning | [src/mainViewProvider.js:859](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.agentReadBusy"))` |
| Warning | [src/mainViewProvider.js:863](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.chipBusyForDownload"))` |
| Warning | [src/mainViewProvider.js:867](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.liveBusyForDownload"))` |
| Error | [src/mainViewProvider.js:892](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.configIncomplete"))` |
| Information | [src/mainViewProvider.js:922](../src/mainViewProvider.js) | `vscode.window.showInformationMessage(this._t("msg.downloadSuccess"))` |
| Error | [src/mainViewProvider.js:927](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.downloadFailed", { error: errorMsg }))` |
| Warning | [src/mainViewProvider.js:938](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("msg.downloadRefreshFailed", { error: error.message }))` |
| Warning | [src/mainViewProvider.js:946](../src/mainViewProvider.js) | `vscode.window.showWarningMessage( this._t("msg.downloadSamplingFailed", { error: error.message }) )` |
| Error | [src/mainViewProvider.js:1900](../src/mainViewProvider.js) | `vscode.window?.showErrorMessage?.(timeoutMessage)` |
| Information | [src/mainViewProvider.js:2899](../src/mainViewProvider.js) | `vscode.window.showInformationMessage( this._t("msg.csvExported", { file: path.basename(target.fsPath) }) )` |
| Error | [src/mainViewProvider.js:2909](../src/mainViewProvider.js) | `vscode.window.showErrorMessage(this._t("msg.csvExportFailed", { msg: error.message }))` |
| Information | [src/mainViewProvider.js:4903](../src/mainViewProvider.js) | `vscode.window.showInformationMessage(message)` |
| Warning | [src/mainViewProvider.js:4903](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(message)` |
| Warning | [src/mainViewProvider.js:4927](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("probe.winusbRequired"))` |
| Warning | [src/mainViewProvider.js:4976](../src/mainViewProvider.js) | `vscode.window.showWarningMessage(this._t("probe.winusbRequired"))` |
| Warning | [src/services/cortexDebugPreflight.js:129](../src/services/cortexDebugPreflight.js) | `vscode.window.showWarningMessage(t("msg.debugToolchainMissing"), select)` |
| Error | [src/services/cortexDebugPreflight.js:147](../src/services/cortexDebugPreflight.js) | `vscode.window.showErrorMessage(t("msg.debugToolchainInvalid"), select)` |
| Warning | [src/services/cubemxFirmware.js:174](../src/services/cubemxFirmware.js) | `this.vscode.window.showWarningMessage(this.t("cubemx.firmwareUnknown") + ": " + this.error)` |
| Information | [src/services/cubemxFirmware.js:197](../src/services/cubemxFirmware.js) | `this.vscode.window.showInformationMessage(this.t("cubemx.firmwareOpened"))` |
| Warning | [src/services/skillStatusService.js:68](../src/services/skillStatusService.js) | `this.vscode.window.showWarningMessage(this.t("msg.skillsModifiedBridgeWarn"), manage)` |
| Information | [src/services/skillStatusService.js:69](../src/services/skillStatusService.js) | `this.vscode.window.showInformationMessage(this.t("msg.skillsDiffers"))` |
| Information | [src/services/skillStatusService.js:77](../src/services/skillStatusService.js) | `this.vscode.window.showInformationMessage(this.t("msg.skillsDiffers"), manage)` |
| Information | [src/services/skillStatusService.js:110](../src/services/skillStatusService.js) | `this.vscode.window.showInformationMessage(this.t("msg.openWorkspaceFirst"))` |
| Warning | [src/services/svdManager.js:155](../src/services/svdManager.js) | `this.vscode.window.showWarningMessage(this.t("svd.legacyMissing"))` |
| Warning | [src/services/svdManager.js:307](../src/services/svdManager.js) | `this.vscode.window.showWarningMessage( this.t("svd.noOfficial", { device: identity.device \|\| identity.family \|\| "?" }) )` |
| Warning | [src/services/svdManager.js:320](../src/services/svdManager.js) | `this.vscode.window.showWarningMessage( this.t("svd.acceptLicense", { source: license.source, license: names \|\| "CMSIS-Pack license" }), { modal: true }, this.t("svd.accept") )` |
| Information | [src/services/svdManager.js:347](../src/services/svdManager.js) | `this.vscode.window.showInformationMessage( this.t("svd.configuredNextDebug", { device: imported.svd.device }) )` |
| Error | [src/services/svdManager.js:364](../src/services/svdManager.js) | `this.vscode.window.showErrorMessage(this.t("svd.failedWith", { error: error.message }))` |
| Information | [src/skillInstaller.js:287](../src/skillInstaller.js) | `vscode.window.showInformationMessage(i18n.t(lang, "msg.skillsInstalled"))` |
| Information | [src/skillInstaller.js:336](../src/skillInstaller.js) | `vscode.window.showInformationMessage( i18n.t(lang, scope === "global" ? "msg.skillsUninstalledGlobal" : "msg.skillsUninstalled") )` |

## 本地化文案定义

中文和英文各 648 条；键集合及占位符集合一致。来源仅记录直接出现的完整字符串键（最多四处），不包括动态拼接，空白不代表不可达。

| 键 | 中文 | English | 直接引用来源 |
| --- | --- | --- | --- |
| `cpu.title` | CPU负载 | CPU load | [src/cpuLoadView.js:17](../src/cpuLoadView.js)，[src/webview/sidebar/cpuLoad.js:52](../src/webview/sidebar/cpuLoad.js) |
| `cpu.busy` | CPU 负载采样正在占用探针，请先停止采样。 | CPU load sampling owns the probe. Stop it before another hardware operation. | [src/mainViewProvider.js:3833](../src/mainViewProvider.js)，[src/mainViewProvider.js:3834](../src/mainViewProvider.js) |
| `cpu.probeBusy` | 其他硬件操作正在进行，请先结束该操作。 | Another hardware operation is active. Finish it before CPU sampling. | [src/mainViewProvider.js:3846](../src/mainViewProvider.js) |
| `cpu.checkingSupport` | 正在检查当前 ELF 的 CPU 采样支持性。 | Checking CPU sampling support in the selected ELF. | [src/services/cpuLoadService.js:13](../src/services/cpuLoadService.js)，[src/services/cpuLoadService.js:29](../src/services/cpuLoadService.js) |
| `cpu.unsupportedProject` | 当前 ELF 不具备受支持的单核 FreeRTOS 内核符号或 DWARF。 | The ELF lacks supported single-core FreeRTOS kernel symbols or DWARF. | [src/services/cpuLoadService.js:36](../src/services/cpuLoadService.js) |
| `cpu.exitUnconfirmed` | 尚未确认 OpenOCD 退出，探针仍被占用；请重试停止。 | OpenOCD exit is unconfirmed. The probe remains reserved; retry Stop. | [src/mainViewProvider.js:4152](../src/mainViewProvider.js)，[src/services/cpuLoadService.js:131](../src/services/cpuLoadService.js) |
| `cpu.state.stopping` | 正在停止 | Stopping |  |
| `cpu.startHint` | 开始 CPU 负载采样 | Start CPU load sampling | [src/cpuLoadView.js:13](../src/cpuLoadView.js)，[src/webview/sidebar/cpuLoad.js:27](../src/webview/sidebar/cpuLoad.js) |
| `cpu.stopHint` | 暂停 CPU 负载采样 | Pause CPU load sampling | [src/webview/sidebar/cpuLoad.js:27](../src/webview/sidebar/cpuLoad.js) |
| `cpu.experimentalFeatures` | 实验性功能 | Experimental features | [src/cpuLoadView.js:11](../src/cpuLoadView.js) |
| `cpu.experimental` | 实验性 | Experimental |  |
| `cpu.workload` | CPU 工作负载估计 | CPU workload estimate |  |
| `cpu.exception` | 异常驻留 | Exceptions |  |
| `cpu.idle` | Idle | Idle |  |
| `cpu.unknown` | 未知 | Unknown |  |
| `cpu.coverage` | 计算覆盖率 | Calculation coverage | [src/cpuLoadView.js:18](../src/cpuLoadView.js)，[src/webview/sidebar/cpuLoad.js:52](../src/webview/sidebar/cpuLoad.js) |
| `cpu.rate` | 实际频率／请求上限 | Actual rate / requested limit |  |
| `cpu.adaptiveTarget` | 自适应目标频率 | Adaptive target rate |  |
| `cpu.readCost` | 读取耗时估计 | Estimated read cost |  |
| `cpu.knownWork` | 已知工作占比 | Known work fraction |  |
| `cpu.lowCoverageNote` | 覆盖率不足，无法给出完整负载估计；已知工作占比不代表整个窗口的负载。 | Insufficient coverage for a full workload estimate; known work is only the observed part of the window. | [src/webview/sidebar/cpuLoad.js:47](../src/webview/sidebar/cpuLoad.js) |
| `cpu.sparseSampling` | 采样较稀疏，短任务或中断可能未命中。 | Sparse sampling may miss short tasks or interrupts. |  |
| `cpu.adaptation.read-cost` | 已按读取耗时自动降频。 | Rate reduced automatically for read cost. |  |
| `cpu.adaptation.variable-pressure` | 已为变量采样或其他事务自动降频。 | Rate reduced automatically for variable reads or transactions. |  |
| `cpu.adaptation.cpu-budget` | 已按 CPU 采集预算自动降频。 | Rate reduced automatically for the CPU collection budget. |  |
| `cpu.unknownReasons` | 未知时间原因 | Unknown time causes |  |
| `cpu.unknown.missed-slot` | 采样调度延迟 | Sampling scheduling delay |  |
| `cpu.unknown.unobserved` | 未观测时间 | Unobserved time |  |
| `cpu.unknown.read-span` | 读取跨度过长 | Read span too long |  |
| `cpu.unknown.read-failed` | 读取失败或超时 | Read failure or timeout |  |
| `cpu.unknown.transition` | 任务或异常切换 | Task or exception transition |  |
| `cpu.unknown.task-unverified` | 任务身份未确认 | Unverified task identity |  |
| `cpu.unknown.transaction-or-variable` | 变量读取或事务占用 | Variable reads or transaction occupied |  |
| `cpu.unknown.cpu-budget` | CPU 采集预算不足 | CPU collection budget exhausted |  |
| `cpu.unknown.shared-budget` | 共享 Tcl 预算不足 | Shared Tcl budget exhausted |  |
| `cpu.unknown.backpressure` | 传输或事件背压 | Transport or event backpressure |  |
| `cpu.unknown.disconnected` | 连接不可用 | Connection unavailable |  |
| `cpu.unknown.scheduler-not-running` | 调度器未运行 | Scheduler not running |  |
| `cpu.unknown.target-state` | 目标不在运行状态 | Target not running |  |
| `cpu.window` | 窗口 | Window |  |
| `cpu.tasks` | 任务驻留 | Task residency |  |
| `cpu.hotspots` | 函数热点 | Function hotspots |  |
| `cpu.other` | 其他 | Other |  |
| `cpu.selectIdle` | 设为 Idle | Use as Idle |  |
| `cpu.addressOnly` | 生命周期未确认 | lifetime unconfirmed |  |
| `cpu.idleUnconfirmed` | 尚未确认内核 Idle 任务，无法计算工作负载估计。 | The kernel Idle task is unconfirmed; the workload estimate is unavailable. | [src/webview/sidebar/cpuLoad.js:48](../src/webview/sidebar/cpuLoad.js) |
| `cpu.pcUnavailable` | PC 采样不可用；基础指标仍可用。 | PC sampling unavailable; base metrics remain available. |  |
| `cpu.scope` | 非 Idle 任务＋活动异常；睡眠比例不可用。实板验收前不保证测量精度。 | Non-Idle tasks + active exceptions. Sleeping time unavailable. No accuracy guarantee before board validation. |  |
| `cpu.state.stopped` | 已停止 | Stopped |  |
| `cpu.state.checking` | 检查能力中… | Checking capabilities… |  |
| `cpu.state.waiting` | 等待调度器运行… | Waiting for scheduler… |  |
| `cpu.state.collecting` | 采集中，正在形成首个 10 秒窗口… | Collecting the first 10-second window… |  |
| `cpu.state.running` | 采样中 | Sampling |  |
| `cpu.state.low-coverage` | 低覆盖率（低于 80%） | Low coverage (<80%) |  |
| `cpu.state.unavailable` | 不可用 | Unavailable |  |
| `cpu.state.paused` | 已暂停 | Paused |  |
| `lw.samplingSelectionHint` | 此波形图所选变量都将以选定频率采样 | All variables selected for this waveform will be sampled at the selected frequency. | [src/liveWatchView.js:81](../src/liveWatchView.js) |
| `lw.historyLoading` | 正在加载已记录的历史… | Loading recorded history… | [src/webview/liveWatch/renderer.js:2145](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:2166](../src/webview/liveWatch/renderer.js) |
| `lw.targetFrequency` | 波形目标频率 | Waveform target frequency | [src/liveWatchView.js:88](../src/liveWatchView.js) |
| `sb.samplingRate` | 侧栏目标 20 Hz；实际 {hz} Hz | Sidebar target 20 Hz; actual {hz} Hz | [src/webview/sidebar/renderer.js:1522](../src/webview/sidebar/renderer.js) |
| `memory.title` | 内存占用 | Memory usage | [src/modernView.js:25](../src/modernView.js) |
| `memory.refresh` | 刷新 | Refresh | [src/modernView.js:25](../src/modernView.js) |
| `memory.chooseSource` | 选择 .map / .ld | Choose .map / .ld | [src/modernView.js:25](../src/modernView.js) |
| `memory.selectElf` | 选择 ELF 后即可查看内存区域。 | Select an ELF to view memory regions. | [src/modernView.js:25](../src/modernView.js)，[src/services/memoryAnalysisController.js:52](../src/services/memoryAnalysisController.js)，[src/webview/sidebar/memoryView.js:166](../src/webview/sidebar/memoryView.js) |
| `memory.loading` | 正在加载内存区域… | Loading memory regions… | [src/webview/sidebar/memoryView.js:166](../src/webview/sidebar/memoryView.js)，[src/webview/sidebar/memoryView.js:190](../src/webview/sidebar/memoryView.js) |
| `memory.failed` | 内存区域加载失败 | Memory region load failed | [src/mainViewProvider.js:4603](../src/mainViewProvider.js)，[src/services/memoryAnalysisController.js:52](../src/services/memoryAnalysisController.js) |
| `memory.estimated` | 估算 | estimated | [src/webview/sidebar/memoryView.js:25](../src/webview/sidebar/memoryView.js) |
| `memory.sections` | 节明细 | Section details | [src/webview/sidebar/memoryView.js:70](../src/webview/sidebar/memoryView.js) |
| `memory.section` | 节 | Section | [src/webview/sidebar/memoryView.js:75](../src/webview/sidebar/memoryView.js)，[src/webview/sidebar/memoryView.js:138](../src/webview/sidebar/memoryView.js) |
| `memory.address` | 地址 | Address |  |
| `memory.runtimeAddress` | 运行地址 | VMA | [src/webview/sidebar/memoryView.js:77](../src/webview/sidebar/memoryView.js) |
| `memory.loadAddress` | 装载地址 | LMA | [src/webview/sidebar/memoryView.js:79](../src/webview/sidebar/memoryView.js) |
| `memory.bytes` | 大小 | Size | [src/webview/sidebar/memoryView.js:81](../src/webview/sidebar/memoryView.js)，[src/webview/sidebar/memoryView.js:140](../src/webview/sidebar/memoryView.js) |
| `memory.role` | 用途 | Placement | [src/webview/sidebar/memoryView.js:83](../src/webview/sidebar/memoryView.js) |
| `memory.runtime` | 运行占用 | Runtime |  |
| `memory.load` | 装载映像 | Load image |  |
| `memory.symbols` | 最大符号 | Largest symbols | [src/webview/sidebar/memoryView.js:134](../src/webview/sidebar/memoryView.js) |
| `memory.symbol` | 符号 | Symbol | [src/webview/sidebar/memoryView.js:136](../src/webview/sidebar/memoryView.js) |
| `memory.basis` | 区域占用包含布局间隙和链接时预留空间。FLASH/RAM 汇总为节字节数，不测量运行时堆栈峰值。 | Region usage includes layout gaps and linker reservations. FLASH/RAM totals count section bytes; runtime heap/stack peaks are not measured. | [src/webview/sidebar/memoryView.js:129](../src/webview/sidebar/memoryView.js) |
| `memory.layoutMissing` | 选择匹配的 .map 或 .ld 后显示内存区域。 | Select a matching .map or .ld to show memory regions. | [src/webview/sidebar/memoryView.js:91](../src/webview/sidebar/memoryView.js) |
| `memory.ambiguous` | 存在多个布局文件，请选择当前 ELF 使用的文件。 | Multiple layout files found. Choose the file used by this ELF. | [src/webview/sidebar/memoryView.js:92](../src/webview/sidebar/memoryView.js) |
| `memory.mapMismatch` | .map 与当前 ELF 不匹配，请重新构建项目或选择其链接脚本。 | The .map does not match this ELF. Rebuild the project or choose its linker script. | [src/webview/sidebar/memoryView.js:93](../src/webview/sidebar/memoryView.js) |
| `memory.unknownKind` | 自定义区域可通过 emberprobe.memory.regionKinds 指定类型。 | A custom region needs a type in emberprobe.memory.regionKinds. | [src/webview/sidebar/memoryView.js:94](../src/webview/sidebar/memoryView.js) |
| `rtos.title` | RTOS 任务 | RTOS tasks | [src/modernView.js:25](../src/modernView.js) |
| `rtos.chooseSession` | 选择调试会话／核 | Choose a debug session / core | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/rtos.js:52](../src/webview/sidebar/rtos.js) |
| `rtos.core` | 核 | Core | [src/webview/sidebar/rtos.js:57](../src/webview/sidebar/rtos.js) |
| `rtos.filter` | 筛选任务 | Filter tasks | [src/modernView.js:25](../src/modernView.js) |
| `rtos.refresh` | 刷新暂停快照 | Refresh paused snapshot | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/rtos.js:64](../src/webview/sidebar/rtos.js) |
| `rtos.resizeHint` | 拖动调整任务视图高度 | Drag to resize the task view | [src/modernView.js:25](../src/modernView.js) |
| `rtos.name` | 任务 | Task | [src/modernView.js:25](../src/modernView.js) |
| `rtos.state` | 状态 | State | [src/modernView.js:25](../src/modernView.js) |
| `rtos.priority` | 优先级 | Priority | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/rtos.js:133](../src/webview/sidebar/rtos.js) |
| `rtos.stack` | 栈使用 | Stack used | [src/modernView.js:25](../src/modernView.js) |
| `rtos.reading` | 正在读取暂停任务… | Reading paused tasks… |  |
| `rtos.stale` | 历史快照 · 目标已运行或发生变化 | Previous snapshot · target resumed or changed |  |
| `rtos.pause` | 暂停原生 EmberProbe 会话后读取任务 | Pause a native EmberProbe session to read tasks |  |
| `rtos.partial` | 部分结果 · 详见诊断 | Partial snapshot · see diagnostics | [src/webview/sidebar/rtos.js:140](../src/webview/sidebar/rtos.js) |
| `rtos.ready` | 暂停任务快照 | Paused task snapshot |  |
| `rtos.notStarted` | FreeRTOS 调度器尚未启动 · 继续运行后再次暂停查看任务 | FreeRTOS scheduler has not started · continue, then pause again to inspect tasks |  |
| `rtos.noTasks` | FreeRTOS 尚未创建任务 · 继续运行后再次暂停查看任务 | FreeRTOS has no created tasks · continue, then pause again to inspect tasks |  |
| `rtos.estimate` | 填充估算 | fill estimate |  |
| `rtos.savedSp` | 保存的 SP（非实时） | Saved SP (not live) | [src/webview/sidebar/rtos.js:108](../src/webview/sidebar/rtos.js)，[src/webview/sidebar/rtos.js:134](../src/webview/sidebar/rtos.js) |
| `rtos.basePriority` | 基础优先级 | Base priority | [src/webview/sidebar/rtos.js:108](../src/webview/sidebar/rtos.js)，[src/webview/sidebar/rtos.js:132](../src/webview/sidebar/rtos.js) |
| `rtos.runtime` | 运行计数器 | Runtime counter | [src/webview/sidebar/rtos.js:108](../src/webview/sidebar/rtos.js)，[src/webview/sidebar/rtos.js:139](../src/webview/sidebar/rtos.js) |
| `rtos.detailsToggle` | 展开或收起任务详情 | Toggle task details | [src/webview/sidebar/rtos.js:89](../src/webview/sidebar/rtos.js) |
| `rtos.unavailable` | 不可用 | Unavailable | [src/webview/sidebar/rtos.js:122](../src/webview/sidebar/rtos.js) |
| `rtos.taskId` | 任务标识 | Task ID | [src/webview/sidebar/rtos.js:129](../src/webview/sidebar/rtos.js) |
| `rtos.tcb` | TCB 地址 | TCB address | [src/webview/sidebar/rtos.js:130](../src/webview/sidebar/rtos.js) |
| `rtos.threadId` | 线程 ID | Thread ID | [src/webview/sidebar/rtos.js:131](../src/webview/sidebar/rtos.js) |
| `rtos.stackBase` | 栈基址 | Stack base | [src/webview/sidebar/rtos.js:135](../src/webview/sidebar/rtos.js) |
| `rtos.stackSize` | 栈大小 | Stack size | [src/webview/sidebar/rtos.js:136](../src/webview/sidebar/rtos.js) |
| `rtos.stackUsed` | 已用栈空间 | Stack used | [src/webview/sidebar/rtos.js:137](../src/webview/sidebar/rtos.js) |
| `rtos.stackRemaining` | 剩余栈空间 | Stack remaining | [src/webview/sidebar/rtos.js:138](../src/webview/sidebar/rtos.js) |
| `rtos.snapshot` | 快照 | Snapshot | [src/services/agentRoutes.js:53](../src/services/agentRoutes.js)，[src/webview/sidebar/rtos.js:140](../src/webview/sidebar/rtos.js) |
| `rtos.diagnostics` | 诊断 | Diagnostics | [src/webview/sidebar/rtos.js:142](../src/webview/sidebar/rtos.js) |
| `probe.configure` | 探针高级设置 | Advanced probe settings |  |
| `probe.usbDriver` | J-Link USB 驱动 | J-Link USB driver | [src/modernView.js:16](../src/modernView.js) |
| `probe.winusbRequired` | 当前 J-Link 使用 SEGGER 驱动；EmberProbe 需要 WinUSB。请在“选择调试器”右侧选择 WinUSB。 | This J-Link is using the SEGGER driver. EmberProbe needs WinUSB; select WinUSB beside Select Debugger. | [src/mainViewProvider.js:4927](../src/mainViewProvider.js)，[src/mainViewProvider.js:4976](../src/mainViewProvider.js) |
| `probe.driverUnsupported` | 当前 J-Link 使用 SEGGER USB 驱动，EmberProbe 不支持该驱动。请更换为 WinUSB 后重试。 | This J-Link uses the SEGGER USB driver, which EmberProbe does not support. Change it to WinUSB and try again. |  |
| `probe.restoreDriver` | 恢复 J-Link 原始 USB 驱动 | Restore the original J-Link USB driver |  |
| `probe.driverInstalling` | 正在为 J-Link 配置 WinUSB，请完成 Windows 授权… | Configuring WinUSB for J-Link; complete the Windows authorization… | [src/modernView.js:16](../src/modernView.js)，[src/webview/sidebar/renderer.js:1822](../src/webview/sidebar/renderer.js) |
| `probe.driverReady` | J-Link USB 驱动已配置 | J-Link USB driver is configured | [src/webview/sidebar/renderer.js:1823](../src/webview/sidebar/renderer.js) |
| `probe.driverRestoring` | 正在恢复 J-Link 原始 USB 驱动… | Restoring the original J-Link USB driver… | [src/webview/sidebar/renderer.js:1824](../src/webview/sidebar/renderer.js) |
| `probe.driverRestored` | J-Link 原始 USB 驱动已恢复 | The original J-Link USB driver is restored | [src/webview/sidebar/renderer.js:1825](../src/webview/sidebar/renderer.js) |
| `probe.automatic` | 自动识别 | Automatic |  |
| `probe.resetAutomatic` | 恢复自动连接并忘记原设备 | Restore automatic connection and forget previous device |  |
| `probe.source.explicit` | 手动覆盖 | Override |  |
| `probe.source.remembered` | 成功记录 | Last success |  |
| `probe.source.unique-device` | 唯一设备 | Only device |  |
| `probe.source.cortex-m` | Cortex-M 默认 | Cortex-M default |  |
| `probe.source.script-default` | 脚本默认 | Script default |  |
| `probe.serial` | J-Link 序列号 | J-Link serial number |  |
| `probe.transport` | SWD / JTAG 协议 | SWD / JTAG transport |  |
| `probe.speed` | 调试速度（kHz） | Adapter speed (kHz) |  |
| `probe.speedDefault` | 0 使用接口/目标脚本的默认速度 | 0 uses the interface/target script default |  |
| `probe.manualSerial` | 手动输入序列号 | Enter serial number |  |
| `probe.serialRequired` | 选择 J-Link 序列号 | Select J-Link serial |  |
| `probe.diagnostic` | 连接诊断 | Connection diagnostic | [src/modernView.js:26](../src/modernView.js) |
| `probe.activeConnection` | 当前连接 | Active connection |  |
| `probe.staleConnection` | 配置已变更，重新连接后才能写入 | Settings changed — restart before writing |  |
| `msg.selectDetectedProbe` | 检测到多种探针，请选择要使用的型号 | Multiple probe types detected. Select the probe to use. | [src/mainViewProvider.js:4877](../src/mainViewProvider.js) |
| `lw.hideAll` | 隐藏全部 | Hide all | [src/webview/liveWatch/chartControls.js:26](../src/webview/liveWatch/chartControls.js) |
| `lw.chooseMembers` | 请选择要绘制的标量成员 | Select scalar members to plot | [src/webview/liveWatch/renderer.js:1764](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1780](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1790](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1793](../src/webview/liveWatch/renderer.js) |
| `lw.expandMembers` | 展开成员 | Expand members | [src/webview/liveWatch/renderer.js:1781](../src/webview/liveWatch/renderer.js) |
| `lw.viewFrozenRunning` | 已冻结 · 采样继续 | Frozen · sampling continues | [src/webview/liveWatch/chartControls.js:183](../src/webview/liveWatch/chartControls.js) |
| `lw.afterResume` | 恢复实时后显示 | Visible after resume | [src/webview/liveWatch/chartControls.js:155](../src/webview/liveWatch/chartControls.js) |
| `lw.showAll` | 显示全部 | Show all | [src/webview/liveWatch/chartControls.js:24](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:1783](../src/webview/liveWatch/renderer.js) |
| `lw.importSidebar` | 从侧边导入 | Import from sidebar | [src/webview/liveWatch/chartControls.js:27](../src/webview/liveWatch/chartControls.js) |
| `lw.sidebarImported` | 已从侧边栏导入 {n} 个变量 | Imported {n} variables from the sidebar | [src/webview/liveWatch/renderer.js:2370](../src/webview/liveWatch/renderer.js) |
| `lw.sidebarAlreadyImported` | 侧边栏变量均已导入 | Sidebar variables are already imported | [src/webview/liveWatch/renderer.js:2370](../src/webview/liveWatch/renderer.js) |
| `lw.sidebarEmpty` | 侧边栏暂无观察变量 | No watched variables in the sidebar | [src/webview/liveWatch/renderer.js:2370](../src/webview/liveWatch/renderer.js) |
| `lw.restoreCurves` | 恢复显示组合 | Restore visibility | [src/webview/liveWatch/chartControls.js:25](../src/webview/liveWatch/chartControls.js) |
| `lw.autoY` | 自动 Y 轴 | Auto Y | [src/webview/liveWatch/chartControls.js:28](../src/webview/liveWatch/chartControls.js) |
| `lw.fitY` | 适应当前曲线 | Fit Y once |  |
| `lw.followLatest` | 回到最新 | Back to latest |  |
| `lw.endNames` | 末端名称 | End labels |  |
| `lw.compareValues` | 同刻对照 | Compare values |  |
| `lw.measureCurves` | 双游标测量 | Measure A/B |  |
| `lw.viewFrozen` | 已冻结 | Frozen | [src/webview/liveWatch/chartControls.js:184](../src/webview/liveWatch/chartControls.js) |
| `lw.viewFollowing` | 跟随最新 | Following latest | [src/webview/liveWatch/chartControls.js:186](../src/webview/liveWatch/chartControls.js) |
| `lw.viewHistory` | 查看历史 | Viewing history | [src/webview/liveWatch/chartControls.js:187](../src/webview/liveWatch/chartControls.js) |
| `lw.seriesOptions` | 曲线设置 | Curve options | [src/webview/liveWatch/chartControls.js:40](../src/webview/liveWatch/chartControls.js) |
| `lw.onlyThis` | 仅看此项 | Show only this | [src/webview/liveWatch/chartControls.js:58](../src/webview/liveWatch/chartControls.js) |
| `lw.curveColor` | 曲线颜色 | Curve color | [src/webview/liveWatch/chartControls.js:87](../src/webview/liveWatch/chartControls.js) |
| `lw.curveLine` | 曲线线型 | Line style | [src/webview/liveWatch/chartControls.js:89](../src/webview/liveWatch/chartControls.js) |
| `lw.line.solid` | 实线 | Solid |  |
| `lw.line.dashed` | 虚线 | Dashed |  |
| `lw.line.dotted` | 点线 | Dotted |  |
| `lw.removeWatch` | 移除监视 | Remove watch | [src/webview/liveWatch/chartControls.js:106](../src/webview/liveWatch/chartControls.js) |
| `lw.closeInspection` | 关闭 | Close | [src/webview/liveWatch/chartControls.js:115](../src/webview/liveWatch/chartControls.js) |
| `lw.noReading` | 无数据 | No data | [src/webview/liveWatch/chartControls.js:171](../src/webview/liveWatch/chartControls.js) |
| `lw.sampleReading` | 实际采样值 | Sample value |  |
| `lw.sampleTime` | 采样时间 | Sample time |  |
| `lw.pinHint` | 点击固定读数；重合曲线可逐项选择 | Click to pin; select overlapping curves individually |  |
| `lw.cursorA` | A | A |  |
| `lw.cursorB` | B | B |  |
| `lw.allHidden` | 曲线已全部隐藏，采样与历史仍保留 | All curves are hidden; sampling and history are retained | [src/webview/liveWatch/renderer.js:1768](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1782](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1790](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1801](../src/webview/liveWatch/renderer.js) |
| `lw.waitSamples` | 等待采样数据 | Waiting for samples | [src/webview/liveWatch/renderer.js:771](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1772](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:1344](../src/webview/sidebar/renderer.js) |
| `lw.runtimeMembersHint` | 请先添加此容器并启动采样，再选择当前元素单独观察；暂不支持直接写入。 | Add this container and start sampling, then select current elements individually. Direct writes are unavailable. | [src/webview/liveWatch/renderer.js:1176](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:571](../src/webview/sidebar/renderer.js) |
| `lw.runtimeMembersSelectable` | 可单独添加下方成员观察，暂不支持直接写入。 | Add individual members below to watch them. Direct writes are unavailable. | [src/webview/liveWatch/renderer.js:1175](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:570](../src/webview/sidebar/renderer.js) |
| `lw.runtimeMembersReadOnly` | 可单独添加下方成员观察；元素来自最近一次采样，暂不支持直接写入。 | Add individual members below to watch them; elements reflect the latest sample. Direct writes are unavailable. | [src/webview/liveWatch/renderer.js:1173](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:568](../src/webview/sidebar/renderer.js) |
| `lw.compositeType` | 对象 | object | [src/webview/liveWatch/renderer.js:1196](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:611](../src/webview/sidebar/renderer.js) |
| `lw.rangeEmpty` | 当前时间范围无数据 | No samples in this time range | [src/webview/liveWatch/renderer.js:1773](../src/webview/liveWatch/renderer.js) |
| `lw.fitTime` | 查看保留数据 | View retained samples | [src/webview/liveWatch/renderer.js:1787](../src/webview/liveWatch/renderer.js) |
| `lw.frozenNew` | 冻结快照中没有该变量，恢复实时后显示 | Variable absent from snapshot; resume live to display | [src/webview/liveWatch/chartControls.js:156](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:1771](../src/webview/liveWatch/renderer.js) |
| `lw.exportSource` | 数据来源 | Data source | [src/webview/liveWatch/renderer.js:1497](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1498](../src/webview/liveWatch/renderer.js) |
| `lw.source.archive` | 完整采样归档 | Full sampling archive |  |
| `lw.source.retained` | 实时保留数据 | Live retained samples |  |
| `lw.source.snapshot` | 冻结快照 | Frozen snapshot |  |
| `cubemx.firmwareUnknown` | 无法确认固件包，请检查路径和 .ioc | Unable to verify firmware; check paths and .ioc | [src/modernView.js:18](../src/modernView.js)，[src/services/cubemxFirmware.js:174](../src/services/cubemxFirmware.js) |
| `cubemx.firmwareInstalled` | 固件包已安装 | Firmware installed | [src/modernView.js:18](../src/modernView.js) |
| `cubemx.firmwareMissing` | 未安装所需固件包 | Required firmware missing | [src/modernView.js:18](../src/modernView.js) |
| `cubemx.installFirmware` | 在 CubeMX 中安装 | Install in CubeMX | [src/modernView.js:18](../src/modernView.js) |
| `cubemx.chooseFirmware` | 选择要在 CubeMX 中安装的固件版本 | Select the firmware version to install in CubeMX | [src/services/cubemxFirmware.js:184](../src/services/cubemxFirmware.js) |
| `cubemx.firmwareVersion` | 请输入固件版本（数字.数字.数字） | Enter a firmware version (number.number.number) | [src/services/cubemxFirmware.js:189](../src/services/cubemxFirmware.js)，[src/services/cubemxFirmware.js:191](../src/services/cubemxFirmware.js) |
| `cubemx.firmwareOpened` | 已启动 CubeMX 原生安装流程。请在 CubeMX 中完成登录和许可确认；若未显示安装窗口，请从 Help → Manage embedded software packages 安装所选系列和版本。返回后自动重新检查。 | CubeMX interactive installation started. Complete sign-in and license acceptance in CubeMX. If no installer appears, use Help → Manage embedded software packages for the selected series and version. Returning here refreshes the check. | [src/services/cubemxFirmware.js:197](../src/services/cubemxFirmware.js) |
| `cubemx.baseline` | 正在检查已有生成代码 | Checking existing generated code |  |
| `cubemx.writing` | 正在写回生成文件并保存恢复副本 | Applying generated files and saving recovery copies |  |
| `cubemx.path` | CubeMX 路径 | CubeMX path | [src/modernView.js:25](../src/modernView.js) |
| `cubemx.ioc` | .ioc 路径 | .ioc path | [src/modernView.js:25](../src/modernView.js) |
| `cubemx.platformUnsupported` | CubeMX 生成支持 Windows 和 Linux | CubeMX generation supports Windows and Linux | [src/services/cubemxConfiguration.js:17](../src/services/cubemxConfiguration.js) |
| `cubemx.invalid` | CubeMX 路径无效，请重新选择 | Invalid CubeMX path; select it again | [src/services/cubemxConfiguration.js:32](../src/services/cubemxConfiguration.js) |
| `cubemx.ready` | CubeMX 已就绪 | CubeMX is ready | [src/services/cubemxConfiguration.js:39](../src/services/cubemxConfiguration.js) |
| `cubemx.missing` | 未找到 CubeMX，请选择安装路径 | CubeMX not found; select its installation | [src/services/cubemxConfiguration.js:39](../src/services/cubemxConfiguration.js) |
| `cubemx.select` | 选择文件 | Select file | [src/services/cubemxConfiguration.js:61](../src/services/cubemxConfiguration.js) |
| `cubemx.clear` | 清空路径 | Clear path | [src/services/cubemxConfiguration.js:50](../src/services/cubemxConfiguration.js)，[src/services/cubemxConfiguration.js:62](../src/services/cubemxConfiguration.js) |
| `cubemx.chooseIoc` | 选择当前工作区的 .ioc 工程 | Select a workspace .ioc project | [src/services/cubemxConfiguration.js:52](../src/services/cubemxConfiguration.js)，[src/services/cubemxConfiguration.js:99](../src/services/cubemxConfiguration.js) |
| `cubemx.generating` | CubeMX：验证并生成初始化代码 | CubeMX: validate and generate initialization code | [src/mainViewProvider.js:1037](../src/mainViewProvider.js)，[src/mainViewProvider.js:1043](../src/mainViewProvider.js)，[src/mainViewProvider.js:2558](../src/mainViewProvider.js)，[src/mainViewProvider.js:2562](../src/mainViewProvider.js) |
| `msg.selectDebugToolchain` | 选择工具链目录 | Select toolchain directory | [src/services/cortexDebugPreflight.js:128](../src/services/cortexDebugPreflight.js) |
| `msg.debugToolchainMissing` | 未找到完整的 ARM 调试工具链（GDB、objdump、nm）。请选择已安装的工具链目录；若尚未安装，请先安装包含 GDB 的 Arm GNU Toolchain。 | A complete ARM debug toolchain (GDB, objdump, nm) was not found. Select an installed toolchain directory, or install Arm GNU Toolchain with GDB first. | [src/services/cortexDebugPreflight.js:129](../src/services/cortexDebugPreflight.js) |
| `msg.debugToolchainDirectory` | 选择 ARM 工具链根目录或 bin 目录 | Select the ARM toolchain root or bin directory | [src/services/cortexDebugPreflight.js:136](../src/services/cortexDebugPreflight.js) |
| `msg.debugToolchainInvalid` | 所选目录及其 bin 子目录中缺少所需的 GDB、objdump 或 nm。请检查工具链是否完整，以及调试器的工具链前缀设置。 | The selected directory and its bin subdirectory are missing GDB, objdump, or nm. Check the toolchain installation and debugger toolchain prefix setting. | [src/services/cortexDebugPreflight.js:147](../src/services/cortexDebugPreflight.js) |
| `common.notSelected` | 未选择 | Not selected | [src/modernView.js:13](../src/modernView.js)，[src/webview/sidebar/renderer.js:147](../src/webview/sidebar/renderer.js) |
| `common.copy` | 复制 | Copy | [src/modernView.js:26](../src/modernView.js)，[src/webview/liveWatch/renderer.js:522](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:662](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/chipView.js:33](../src/webview/sidebar/chipView.js) |
| `common.type` | 类型 | Type | [src/modernView.js:25](../src/modernView.js)，[src/webview/liveWatch/chartControls.js:70](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/chartControls.js:73](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:187](../src/webview/liveWatch/renderer.js) |
| `common.address` | 地址 | Address | [src/webview/liveWatch/renderer.js:187](../src/webview/liveWatch/renderer.js) |
| `common.variable` | 变量 | Variable | [src/modernView.js:25](../src/modernView.js)，[src/webview/liveWatch/renderer.js:187](../src/webview/liveWatch/renderer.js) |
| `common.size` | 大小 | Size | [src/webview/liveWatch/renderer.js:187](../src/webview/liveWatch/renderer.js) |
| `common.optional` | 可选 | Optional | [src/modernView.js:19](../src/modernView.js)，[src/modernView.js:25](../src/modernView.js) |
| `common.langTitle` | 语言 / Language | 语言 / Language | [src/liveWatchView.js:91](../src/liveWatchView.js)，[src/modernView.js:22](../src/modernView.js)，[src/webview/liveWatch/renderer.js:304](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:305](../src/webview/liveWatch/renderer.js) |
| `common.copied` | 已复制到剪贴板 | Copied to clipboard | [src/mainViewProvider.js:429](../src/mainViewProvider.js) |
| `common.copyFailed` | 复制失败：{message} | Copy failed: {message} | [src/mainViewProvider.js:431](../src/mainViewProvider.js) |
| `sb.connecting` | 正在连接 | Connecting | [src/modernView.js:22](../src/modernView.js) |
| `sb.installSkillTitle` | 安装 Agent Skills | Install Agent Skills | [src/modernView.js:17](../src/modernView.js) |
| `sb.installSkillDesc` | 下载、变量读写、芯片/故障诊断、ELF 分析与固件校验 | Download, variable read/write, chip/fault diagnosis, ELF analysis and flash verify | [src/modernView.js:17](../src/modernView.js) |
| `skill.checking` | 检测中 | Checking |  |
| `skill.installed` | 已安装 {installed}/{total} | Installed {installed}/{total} | [src/services/skillStatusService.js:86](../src/services/skillStatusService.js) |
| `skill.statusInstalled` | 已安装 | Installed |  |
| `skill.statusPartial` | 部分安装 | Partial |  |
| `skill.partial` | 部分安装 {installed}/{total} | Partial {installed}/{total} | [src/services/skillStatusService.js:89](../src/services/skillStatusService.js) |
| `skill.outdated` | 可更新 | Update available | [src/services/skillStatusService.js:92](../src/services/skillStatusService.js) |
| `skill.modified` | 已修改 | Modified | [src/services/skillStatusService.js:93](../src/services/skillStatusService.js) |
| `skill.notInstalled` | 未安装 | Not installed | [src/services/skillStatusService.js:94](../src/services/skillStatusService.js)，[src/services/skillStatusService.js:96](../src/services/skillStatusService.js) |
| `skill.noWorkspace` | 无工作区 | No workspace | [src/services/skillStatusService.js:83](../src/services/skillStatusService.js) |
| `skill.menuPlaceholder` | 管理 Agent Skills | Manage Agent Skills |  |
| `skill.menuInstallWorkspace` | 安装到当前项目 | Install into Current Project |  |
| `skill.menuInstallGlobal` | 全局安装（所有项目可用） | Install Globally (all projects) |  |
| `skill.menuUninstall` | 卸载… | Uninstall… |  |
| `skill.uninstallPlaceholder` | 选择要卸载的范围 | Choose the scope to uninstall |  |
| `skill.menuUninstallWorkspace` | 卸载当前项目中的 Skills | Uninstall Project Skills |  |
| `skill.menuUninstallGlobal` | 卸载全局 Skills | Uninstall Global Skills |  |
| `skill.uninstallConfirm` | 卸载 | Uninstall |  |
| `skill.confirmUninstall` | 将删除 {path} 下的 EmberProbe Agent Skills，用户自建的其它内容不受影响。 | This removes EmberProbe Agent Skills under {path}. Other content is untouched. |  |
| `skill.scopeWorkspace` | 项目 | Project |  |
| `skill.scopeGlobal` | 全局 | Global |  |
| `sb.openocdEnv` | OpenOCD 环境 | OpenOCD Environment | [src/modernView.js:24](../src/modernView.js) |
| `sb.install` | 一键安装 | Install | [src/modernView.js:24](../src/modernView.js) |
| `sb.selectPath` | 选择路径 | Select Path | [src/modernView.js:24](../src/modernView.js) |
| `sb.recheck` | 重新检测 | Recheck | [src/modernView.js:24](../src/modernView.js) |
| `sb.mcuConfig` | MCU 配置 | MCU Configuration | [src/modernView.js:25](../src/modernView.js) |
| `sb.memoryRegions` | 其他 | Other | [src/modernView.js:25](../src/modernView.js) |
| `sb.autoDetectTitle` | 自动检测配置 | Auto-detect Configuration | [src/modernView.js:25](../src/modernView.js) |
| `sb.autoDetectDesc` | 扫描工作区并填充下方配置 | Scan the workspace and fill in the settings below | [src/modernView.js:25](../src/modernView.js) |
| `sb.manualConfig` | 手动配置 | Manual Setup | [src/modernView.js:25](../src/modernView.js) |
| `sb.selectElf` | 选择 ELF 固件 | Select ELF Firmware | [src/modernView.js:25](../src/modernView.js) |
| `sb.selectDebugger` | 选择调试器 | Select Debugger | [src/modernView.js:16](../src/modernView.js) |
| `sb.selectMcu` | 选择 MCU 目标 | Select MCU Target | [src/modernView.js:25](../src/modernView.js) |
| `sb.otherConfig` | 其他配置 | Other Configuration | [src/modernView.js:25](../src/modernView.js) |
| `sb.debug` | 调试 | Debug | [src/modernView.js:25](../src/modernView.js) |
| `svd.selectConfig` | 选择 SVD 文件 | Select SVD File | [src/modernView.js:19](../src/modernView.js) |
| `svd.notConfigured` | SVD 未配置 | SVD not configured | [src/modernView.js:19](../src/modernView.js)，[src/services/svdManager.js:213](../src/services/svdManager.js)，[src/services/svdManager.js:310](../src/services/svdManager.js)，[src/services/svdManager.js:380](../src/services/svdManager.js) |
| `svd.configured` | SVD 已配置 | SVD configured | [src/services/svdManager.js:78](../src/services/svdManager.js)，[src/services/svdManager.js:220](../src/services/svdManager.js)，[src/services/svdManager.js:390](../src/services/svdManager.js)，[src/webview/sidebar/renderer.js:1628](../src/webview/sidebar/renderer.js) |
| `svd.updateAvailable` | SVD 有更新：{currentVersion} → {version} | SVD update available: {currentVersion} → {version} | [src/services/svdManager.js:409](../src/services/svdManager.js) |
| `svd.selectExisting` | 选择已有 | Choose existing | [src/services/svdManager.js:179](../src/services/svdManager.js) |
| `svd.downloadOfficial` | 下载官方 SVD | Download official SVD | [src/modernView.js:19](../src/modernView.js)，[src/webview/sidebar/renderer.js:1640](../src/webview/sidebar/renderer.js) |
| `svd.downloading` | 下载中…（点击取消） | Downloading… (click to cancel) | [src/services/svdManager.js:280](../src/services/svdManager.js) |
| `svd.downloadingPercent` | 下载中 {percent}%（点击取消） | Downloading {percent}% (click to cancel) |  |
| `svd.validating` | 校验中…（点击取消） | Validating… (click to cancel) | [src/services/svdManager.js:275](../src/services/svdManager.js) |
| `svd.cancelDownload` | 取消下载 | Cancel download | [src/webview/sidebar/renderer.js:1635](../src/webview/sidebar/renderer.js) |
| `svd.cancelling` | 正在取消… | Cancelling… | [src/services/svdManager.js:373](../src/services/svdManager.js)，[src/webview/sidebar/renderer.js:1637](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1702](../src/webview/sidebar/renderer.js) |
| `svd.retry` | 重试 | Retry | [src/webview/sidebar/renderer.js:1639](../src/webview/sidebar/renderer.js) |
| `svd.catalog` | 正在查询官方 CMSIS-Pack 目录… | Querying the official CMSIS-Pack catalog… | [src/services/svdManager.js:259](../src/services/svdManager.js)，[src/services/svdManager.js:279](../src/services/svdManager.js) |
| `svd.catalogProgress` | 正在核对候选 SVD 包（{current}/{total}）… | Checking SVD package metadata ({current}/{total})… | [src/services/svdManager.js:278](../src/services/svdManager.js) |
| `svd.downloadTitle` | EmberProbe：下载官方 SVD | EmberProbe: Download official SVD | [src/services/svdManager.js:264](../src/services/svdManager.js) |
| `svd.selectAnother` | 选择其他 SVD 文件… | Choose another SVD file… | [src/services/svdManager.js:202](../src/services/svdManager.js) |
| `svd.clearBinding` | 清除当前工作区绑定 | Clear this workspace binding | [src/services/svdManager.js:203](../src/services/svdManager.js) |
| `svd.switchPlaceholder` | 选择当前工作区使用的 SVD | Select the SVD for this workspace | [src/services/svdManager.js:206](../src/services/svdManager.js) |
| `svd.chooseDevice` | 请选择芯片型号 / 内核对应的官方 SVD | Select the official SVD matching the device/core | [src/services/svdManager.js:247](../src/services/svdManager.js) |
| `svd.downloadBusy` | 已有 SVD 下载任务正在进行 | An SVD download is already running | [src/services/svdManager.js:255](../src/services/svdManager.js) |
| `svd.noOfficial` | 官方 CMSIS-Pack 中未找到 {device} 的 SVD | No official CMSIS-Pack SVD was found for {device} | [src/services/svdManager.js:308](../src/services/svdManager.js) |
| `svd.acceptLicense` | 下载前需接受来源 {source} 的许可：{license} | Accept the license from {source} before downloading: {license} | [src/services/svdManager.js:321](../src/services/svdManager.js) |
| `svd.accept` | 接受并下载 | Accept and download | [src/services/svdManager.js:326](../src/services/svdManager.js)，[src/services/svdManager.js:328](../src/services/svdManager.js) |
| `svd.configuredNextDebug` | {device} 的 SVD 已配置，下次调试生效 | SVD for {device} is configured and will apply to the next debug session | [src/services/svdManager.js:348](../src/services/svdManager.js) |
| `svd.cancelled` | SVD 下载已取消 | SVD download cancelled | [src/services/svdManager.js:360](../src/services/svdManager.js) |
| `svd.failed` | SVD 下载失败 | SVD download failed | [src/services/svdManager.js:360](../src/services/svdManager.js) |
| `svd.failedWith` | SVD 下载/配置失败：{error} | SVD download/configuration failed: {error} | [src/services/svdManager.js:364](../src/services/svdManager.js) |
| `svd.legacyMissing` | 旧的 mcu.svdPath 已失效，已清理，请重新选择 SVD | The old mcu.svdPath is no longer valid and was cleared; choose an SVD again | [src/services/svdManager.js:155](../src/services/svdManager.js) |
| `peripheral.title` | 外设寄存器 | XPERIPHERALS | [src/modernView.js:25](../src/modernView.js) |
| `peripheral.filter` | 筛选外设或寄存器… | Filter peripherals or registers… | [src/modernView.js:25](../src/modernView.js) |
| `peripheral.refresh` | 刷新已展开的寄存器 | Refresh expanded registers | [src/modernView.js:25](../src/modernView.js) |
| `peripheral.format` | 切换数值格式 | Change value format | [src/modernView.js:25](../src/modernView.js) |
| `peripheral.expand` | 展开或折叠 | Expand or collapse | [src/webview/sidebar/peripherals.js:255](../src/webview/sidebar/peripherals.js)，[src/webview/sidebar/peripherals.js:287](../src/webview/sidebar/peripherals.js) |
| `peripheral.loading` | 正在加载 SVD 外设… | Loading SVD peripherals… | [src/webview/sidebar/peripherals.js:311](../src/webview/sidebar/peripherals.js)，[src/webview/sidebar/peripherals.js:331](../src/webview/sidebar/peripherals.js) |
| `peripheral.enableHint` | 请先在“其他配置”中选择 SVD 文件。 | Choose an SVD under Other Configuration to browse registers. | [src/webview/sidebar/peripherals.js:327](../src/webview/sidebar/peripherals.js) |
| `peripheral.noSession` | 启动调试会话后可读取数值 | Start a debug session to read values | [src/webview/sidebar/peripherals.js:334](../src/webview/sidebar/peripherals.js) |
| `peripheral.running` | 目标运行中 · 显示上次暂停时的数值 | Target running · values are from the last pause | [src/webview/sidebar/peripherals.js:332](../src/webview/sidebar/peripherals.js) |
| `peripheral.paused` | 目标已暂停 · 点击寄存器可读取 | Target paused · select a register to read it | [src/webview/sidebar/peripherals.js:333](../src/webview/sidebar/peripherals.js) |
| `peripheral.noMatches` | 没有匹配的外设 | No matching peripherals | [src/webview/sidebar/peripherals.js:349](../src/webview/sidebar/peripherals.js) |
| `peripheral.readRegister` | 读取寄存器 | Read register | [src/webview/sidebar/peripherals.js:267](../src/webview/sidebar/peripherals.js) |
| `peripheral.readSideEffect` | SVD 标记此寄存器读取有副作用 | SVD marks this register as unsafe to read | [src/webview/sidebar/peripherals.js:273](../src/webview/sidebar/peripherals.js) |
| `peripheral.editValue` | 修改数值 | Update value | [src/webview/sidebar/peripherals.js:160](../src/webview/sidebar/peripherals.js) |
| `peripheral.increase` | 加 1 并写入 | Increase by 1 and write | [src/webview/sidebar/peripherals.js:162](../src/webview/sidebar/peripherals.js) |
| `peripheral.decrease` | 减 1 并写入 | Decrease by 1 and write | [src/webview/sidebar/peripherals.js:161](../src/webview/sidebar/peripherals.js) |
| `peripheral.invalidValue` | 请输入有效的寄存器数值 | Enter a valid register value | [src/webview/sidebar/peripherals.js:25](../src/webview/sidebar/peripherals.js)，[src/webview/sidebar/peripherals.js:28](../src/webview/sidebar/peripherals.js)，[src/webview/sidebar/peripherals.js:34](../src/webview/sidebar/peripherals.js) |
| `peripheral.valueRange` | 数值超出 {bits} 位范围 | Value is outside the {bits}-bit range | [src/webview/sidebar/peripherals.js:37](../src/webview/sidebar/peripherals.js) |
| `peripheral.failed` | 外设视图操作失败 | Peripheral view failed | [src/webview/sidebar/peripherals.js:440](../src/webview/sidebar/peripherals.js) |
| `peripheral.configureSvdFirst` | 请先在“其他配置”中选择 SVD 文件 | Choose an SVD under Other Configuration first | [src/mainViewProvider.js:476](../src/mainViewProvider.js) |
| `sb.chipInfo` | 芯片信息 | Chip Info | [src/modernView.js:25](../src/modernView.js) |
| `sb.notConnected` | 未连接 | Not connected | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:166](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:167](../src/webview/sidebar/renderer.js) |
| `sb.read` | 读取 | Read | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:1588](../src/webview/sidebar/renderer.js) |
| `sb.readingEllipsis` | 读取中… | Reading… | [src/webview/sidebar/renderer.js:1588](../src/webview/sidebar/renderer.js) |
| `sb.reread` | 重新读取 | Re-read | [src/webview/sidebar/renderer.js:1588](../src/webview/sidebar/renderer.js) |
| `sb.chipEmpty` | 点击“读取”获取芯片系列、内核、调试链路与运行状态 | Click "Read" to get the chip family, core, debug link and run state | [src/modernView.js:25](../src/modernView.js) |
| `sb.liveValues` | 实时读写 | Live Read/Write | [src/modernView.js:25](../src/modernView.js) |
| `sb.waiting` | 等待状态 | Waiting | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:81](../src/webview/sidebar/renderer.js) |
| `sb.start` | 开始 | Start | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:1517](../src/webview/sidebar/renderer.js) |
| `sb.stop` | 停止 | Stop | [src/webview/sidebar/renderer.js:1517](../src/webview/sidebar/renderer.js) |
| `sb.chart` | 图表 | Chart | [src/modernView.js:25](../src/modernView.js) |
| `sb.watchList` | 查看列表 | Watch List | [src/modernView.js:25](../src/modernView.js) |
| `sb.watchEmpty` | 从下方变量列表点击添加 | Click an item in the list below to add it | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:376](../src/webview/sidebar/renderer.js) |
| `sb.allVars` | ELF 全部变量 | All ELF Variables | [src/modernView.js:25](../src/modernView.js) |
| `sb.varSearch` | 筛选变量及子成员名… | Filter variable and member names… | [src/modernView.js:25](../src/modernView.js) |
| `sb.refreshVars` | 刷新变量列表 | Refresh variable list | [src/modernView.js:25](../src/modernView.js) |
| `sb.varsLoading` | 正在读取 ELF 变量… | Reading ELF variables… | [src/modernView.js:25](../src/modernView.js) |
| `sb.noMatch` | 没有匹配变量 | No matching variables | [src/webview/liveWatch/renderer.js:1275](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:483](../src/webview/sidebar/renderer.js) |
| `sb.searchingMembers` | 正在搜索变量及子成员… | Searching variables and members… | [src/webview/liveWatch/renderer.js:1273](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:481](../src/webview/sidebar/renderer.js) |
| `sb.noImportable` | 当前 ELF 没有可导入变量 | This ELF has no importable variables | [src/webview/liveWatch/renderer.js:1276](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:484](../src/webview/sidebar/renderer.js) |
| `sb.resizeHint` | 上下拖动调整变量列表高度 | Drag up/down to resize the variable list | [src/modernView.js:25](../src/modernView.js) |
| `sb.resizePeripheralHint` | 上下拖动调整外设列表高度 | Drag up/down to resize the peripheral list | [src/modernView.js:25](../src/modernView.js) |
| `sb.githubRepo` | 打开 GitHub 仓库 | Open GitHub repository | [src/modernView.js:22](../src/modernView.js)，[src/webview/sidebar/renderer.js:214](../src/webview/sidebar/renderer.js) |
| `sb.download` | 烧录 | Flash | [src/modernView.js:25](../src/modernView.js) |
| `sb.footConnecting` | 正在连接扩展服务… | Connecting to the extension service… | [src/modernView.js:25](../src/modernView.js) |
| `sb.extNotConnected` | 扩展服务未连接 | Extension service not connected | [src/webview/sidebar/renderer.js:1672](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1681](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1690](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1710](../src/webview/sidebar/renderer.js) |
| `sb.executing` | 正在执行… | Running… | [src/webview/sidebar/renderer.js:1716](../src/webview/sidebar/renderer.js) |
| `sb.ready` | 扩展服务已就绪 | Extension service ready | [src/webview/sidebar/renderer.js:1807](../src/webview/sidebar/renderer.js) |
| `sb.commandDone` | 操作已完成 | Operation completed | [src/webview/sidebar/renderer.js:1845](../src/webview/sidebar/renderer.js) |
| `sb.commandFailed` | 操作失败 | Operation failed | [src/mainViewProvider.js:4563](../src/mainViewProvider.js)，[src/webview/sidebar/renderer.js:1212](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1849](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:2019](../src/webview/sidebar/renderer.js) |
| `sb.removeFromWatch` | 从查看列表移除 | Remove from watch list | [src/webview/sidebar/renderer.js:404](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:502](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:675](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:829](../src/webview/sidebar/renderer.js) |
| `sb.writeList` | 写入列表 | Write List | [src/modernView.js:25](../src/modernView.js) |
| `sb.writeEmpty` | 点击 ELF 变量前的 ✎ 添加 | Click ✎ in the ELF list to add | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:1175](../src/webview/sidebar/renderer.js) |
| `sb.addToWrite` | 加入写入列表 | Add to write list | [src/webview/sidebar/renderer.js:818](../src/webview/sidebar/renderer.js) |
| `sb.removeFromWrite` | 从写入列表移除 | Remove from write list | [src/webview/sidebar/renderer.js:818](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1020](../src/webview/sidebar/renderer.js) |
| `sb.writeFail` | 写入失败：{msg} | Write failed: {msg} | [src/webview/sidebar/renderer.js:1212](../src/webview/sidebar/renderer.js) |
| `sb.writeUnsupported` | 该变量不支持直接写入 | This variable cannot be written directly | [src/webview/sidebar/renderer.js:691](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:818](../src/webview/sidebar/renderer.js) |
| `sb.writeNeedSampling` | 开始采样后才能写入 | Start sampling before writing | [src/mainViewProvider.js:2419](../src/mainViewProvider.js)，[src/webview/sidebar/renderer.js:893](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1160](../src/webview/sidebar/renderer.js) |
| `sb.invalidWriteValue` | 请输入类型范围内的十进制整数 | Enter an in-range decimal integer | [src/webview/sidebar/renderer.js:1043](../src/webview/sidebar/renderer.js) |
| `sb.foldList` | 收起 | Collapse | [src/modernView.js:25](../src/modernView.js)，[src/webview/sidebar/renderer.js:1227](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1231](../src/webview/sidebar/renderer.js) |
| `sb.unfoldList` | 展开 | Expand | [src/webview/sidebar/renderer.js:1227](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1231](../src/webview/sidebar/renderer.js) |
| `sb.compositeUnsupported` | 复合类型暂不支持 | Composite types are not supported yet | [src/webview/sidebar/renderer.js:673](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:691](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:698](../src/webview/sidebar/renderer.js) |
| `sb.composite` | 复合 | Composite | [src/webview/sidebar/renderer.js:708](../src/webview/sidebar/renderer.js) |
| `sb.compositeAddWhole` | 添加整个复合变量 | Add whole composite | [src/webview/sidebar/renderer.js:502](../src/webview/sidebar/renderer.js) |
| `sb.sampling` | 采样中 | Sampling | [src/liveWatch.js:1474](../src/liveWatch.js)，[src/mainViewProvider.js:4023](../src/mainViewProvider.js)，[src/mainViewProvider.js:4101](../src/mainViewProvider.js)，[src/services/debugSessionBridge.js:205](../src/services/debugSessionBridge.js) |
| `sb.stopped` | 已停止 | Stopped | [src/mainViewProvider.js:4101](../src/mainViewProvider.js)，[src/mainViewProvider.js:4138](../src/mainViewProvider.js)，[src/mainViewProvider.js:4391](../src/mainViewProvider.js)，[src/services/debugSessionBridge.js:205](../src/services/debugSessionBridge.js) |
| `sb.apiUnavailable` | 无法连接 VS Code API | Cannot reach the VS Code API | [src/webview/sidebar/renderer.js:2031](../src/webview/sidebar/renderer.js) |
| `chip.unknownCore` | 未知内核 | Unknown core | [src/webview/sidebar/chipView.js:49](../src/webview/sidebar/chipView.js) |
| `chip.adapterClock` | 适配器时钟 | Adapter Clock | [src/webview/sidebar/chipView.js:97](../src/webview/sidebar/chipView.js)，[src/webview/sidebar/chipView.js:129](../src/webview/sidebar/chipView.js) |
| `chip.coreRev` | 内核修订 | Core Revision | [src/webview/sidebar/chipView.js:114](../src/webview/sidebar/chipView.js) |
| `chip.targetState` | 读取时状态 | State when read | [src/webview/sidebar/chipView.js:87](../src/webview/sidebar/chipView.js)，[src/webview/sidebar/chipView.js:139](../src/webview/sidebar/chipView.js)，[src/webview/sidebar/chipView.js:147](../src/webview/sidebar/chipView.js) |
| `chip.pause` | 暂停 | Pause | [src/webview/sidebar/chipView.js:81](../src/webview/sidebar/chipView.js) |
| `chip.continue` | 继续 | Continue | [src/webview/sidebar/chipView.js:83](../src/webview/sidebar/chipView.js) |
| `chip.reset` | 重置并运行 | Reset and run | [src/webview/sidebar/chipView.js:94](../src/webview/sidebar/chipView.js) |
| `chip.controlling` | 正在控制芯片… | Controlling target… | [src/services/chipInfoService.js:163](../src/services/chipInfoService.js)，[src/webview/sidebar/renderer.js:1673](../src/webview/sidebar/renderer.js) |
| `chip.readAgain` | 调试器或目标已更改，请重新读取芯片信息 | Probe or target changed; read chip info again | [src/services/chipInfoService.js:159](../src/services/chipInfoService.js) |
| `chip.readAt` | 读取时间（重置后请重新读取） | Read at (read again after reset) | [src/webview/sidebar/chipView.js:151](../src/webview/sidebar/chipView.js) |
| `chip.stateError` | 状态读取失败 | State read failed | [src/webview/sidebar/chipView.js:152](../src/webview/sidebar/chipView.js) |
| `live.targetPollingFailed` | 目标持续轮询失败，已停止采样。请检查目标配置、供电和调试连接后重新启动。 | Target polling keeps failing; sampling stopped. Check the target configuration, power, and debug connection before restarting. | [src/liveWatch.js:524](../src/liveWatch.js) |
| `chip.debugProbe` | 调试探针 | Debug Probe | [src/webview/sidebar/chipView.js:100](../src/webview/sidebar/chipView.js) |
| `chip.endianLE` | 小端 LE | Little-endian LE | [src/webview/sidebar/chipView.js:104](../src/webview/sidebar/chipView.js) |
| `chip.endianBE` | 大端 BE | Big-endian BE | [src/webview/sidebar/chipView.js:106](../src/webview/sidebar/chipView.js) |
| `chip.deviceId` | Device ID | Device ID | [src/webview/sidebar/chipView.js:115](../src/webview/sidebar/chipView.js) |
| `chip.revId` | Revision ID | Revision ID | [src/webview/sidebar/chipView.js:116](../src/webview/sidebar/chipView.js) |
| `chip.designer` | 设计厂商 | Designer | [src/webview/sidebar/chipView.js:98](../src/webview/sidebar/chipView.js)，[src/webview/sidebar/chipView.js:117](../src/webview/sidebar/chipView.js) |
| `chip.romPart` | ROM 表器件号 | ROM Table Part | [src/webview/sidebar/chipView.js:120](../src/webview/sidebar/chipView.js) |
| `chip.authenticity` | 原厂校验 | Authenticity | [src/webview/sidebar/chipView.js:119](../src/webview/sidebar/chipView.js) |
| `chip.authGenuine` | ST 原厂 | Genuine ST | [src/webview/sidebar/chipView.js:54](../src/webview/sidebar/chipView.js) |
| `chip.authCompat` | 兼容芯片（{vendor}） | Compatible chip ({vendor}) | [src/webview/sidebar/chipView.js:52](../src/webview/sidebar/chipView.js) |
| `chip.compatTag` | 兼容芯片 | compatible chip | [src/webview/sidebar/chipView.js:58](../src/webview/sidebar/chipView.js) |
| `chip.vendorUnmarked` | 厂商未标识 | unmarked vendor | [src/webview/sidebar/chipView.js:52](../src/webview/sidebar/chipView.js) |
| `chip.flashSize` | Flash 容量 | Flash Size | [src/webview/sidebar/chipView.js:121](../src/webview/sidebar/chipView.js) |
| `chip.endian` | 字节序 | Endianness | [src/webview/sidebar/chipView.js:122](../src/webview/sidebar/chipView.js) |
| `chip.uid` | UID | UID | [src/webview/sidebar/chipView.js:123](../src/webview/sidebar/chipView.js) |
| `chip.info` | 信息 | Info | [src/webview/sidebar/chipView.js:124](../src/webview/sidebar/chipView.js) |
| `chip.openocdNoData` | OpenOCD 未提供 | Not provided by OpenOCD | [src/webview/sidebar/chipView.js:124](../src/webview/sidebar/chipView.js) |
| `chip.debugger` | 调试器 | Debugger | [src/webview/sidebar/chipView.js:127](../src/webview/sidebar/chipView.js) |
| `chip.transport` | 传输协议 | Transport | [src/webview/sidebar/chipView.js:128](../src/webview/sidebar/chipView.js) |
| `chip.targetVoltage` | 目标电压 | Target Voltage | [src/webview/sidebar/chipView.js:130](../src/webview/sidebar/chipView.js) |
| `chip.voltageUnsupported` | 不支持读取 | Not readable | [src/webview/sidebar/chipView.js:130](../src/webview/sidebar/chipView.js) |
| `chip.target` | Target | Target | [src/webview/sidebar/chipView.js:134](../src/webview/sidebar/chipView.js) |
| `chip.haltReason` | 停止原因 | Halt Reason | [src/webview/sidebar/chipView.js:140](../src/webview/sidebar/chipView.js) |
| `chip.regInfo` | 寄存器信息 | Register Info | [src/webview/sidebar/chipView.js:148](../src/webview/sidebar/chipView.js) |
| `chip.regHint` | 暂停芯片后可读取 | Available after halting the chip | [src/webview/sidebar/chipView.js:148](../src/webview/sidebar/chipView.js) |
| `chip.groupChip` | 芯片信息 | Chip Info | [src/webview/sidebar/chipView.js:155](../src/webview/sidebar/chipView.js) |
| `chip.groupDebug` | 调试连接 | Debug Connection | [src/webview/sidebar/chipView.js:159](../src/webview/sidebar/chipView.js) |
| `chip.groupRun` | 运行信息 | Run Info | [src/webview/sidebar/chipView.js:163](../src/webview/sidebar/chipView.js) |
| `chip.details` | 详细信息 | Details | [src/webview/sidebar/chipView.js:181](../src/webview/sidebar/chipView.js) |
| `chip.reading` | 正在读取芯片信息… | Reading chip info… | [src/mainViewProvider.js:2459](../src/mainViewProvider.js)，[src/services/chipInfoService.js:36](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:49](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:91](../src/services/chipInfoService.js) |
| `chip.done` | 读取完成 | Done | [src/services/chipInfoService.js:36](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:126](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:197](../src/services/chipInfoService.js)，[src/webview/sidebar/renderer.js:166](../src/webview/sidebar/renderer.js) |
| `chip.notRead` | 尚未读取 | Not read yet | [src/services/chipInfoService.js:36](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:148](../src/services/chipInfoService.js) |
| `chip.busyDownload` | 下载进行中，请稍后再读取芯片信息 | A download is in progress; try reading chip info later | [src/mainViewProvider.js:2460](../src/mainViewProvider.js)，[src/services/chipInfoService.js:50](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:150](../src/services/chipInfoService.js) |
| `chip.busyLive` | 实时变量查看运行中，请先停止后再读取 | Live watch is running; stop it before reading | [src/mainViewProvider.js:2461](../src/mainViewProvider.js)，[src/services/chipInfoService.js:51](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:151](../src/services/chipInfoService.js) |
| `chip.busyAgent` | Agent 正在单次读取变量，请稍候 | The Agent is reading variables; try again shortly | [src/mainViewProvider.js:2462](../src/mainViewProvider.js)，[src/services/chipInfoService.js:52](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:152](../src/services/chipInfoService.js) |
| `chip.busyDebug` | 检测到调试会话，探针已被占用；请先停止调试 | A debug session is active and the probe is busy; stop debugging first | [src/mainViewProvider.js:2463](../src/mainViewProvider.js)，[src/services/chipInfoService.js:54](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:154](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:172](../src/services/chipInfoService.js) |
| `chip.needConfig` | 请先选择调试器与 MCU 目标 | Select a debugger and MCU target first | [src/mainViewProvider.js:2469](../src/mainViewProvider.js)，[src/services/chipInfoService.js:58](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:157](../src/services/chipInfoService.js) |
| `chip.notReady` | OpenOCD 未就绪：请先在侧边栏完成安装或路径配置 | OpenOCD not ready: install it or set the path in the sidebar first | [src/mainViewProvider.js:2475](../src/mainViewProvider.js)，[src/services/chipInfoService.js:79](../src/services/chipInfoService.js)，[src/services/chipInfoService.js:166](../src/services/chipInfoService.js) |
| `chip.timeout` | 读取芯片信息超时（15s）：请检查接线、供电与探针占用情况 | Reading chip info timed out (15s): check wiring, power and probe availability | [src/chipInfo.js:28](../src/chipInfo.js)，[src/faultInfo.js:172](../src/faultInfo.js) |
| `chip.noInfo` | 未获取到芯片信息 | No chip info obtained | [src/chip/parser.js:329](../src/chip/parser.js) |
| `chip.stReading` | 正在读取 | Reading | [src/webview/sidebar/renderer.js:166](../src/webview/sidebar/renderer.js) |
| `chip.stError` | 读取失败 | Read failed | [src/webview/sidebar/renderer.js:166](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1599](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1606](../src/webview/sidebar/renderer.js) |
| `chip.exitCode` | OpenOCD 退出码 {code} | OpenOCD exit code {code} | [src/chip/parser.js:332](../src/chip/parser.js) |
| `lw.title` | 波形图 | Waveform | [src/liveWatchView.js:85](../src/liveWatchView.js) |
| `lw.panelTitle` | 波形图 #{n} | Waveform #{n} | [src/mainViewProvider.js:438](../src/mainViewProvider.js)，[src/mainViewProvider.js:2600](../src/mainViewProvider.js) |
| `lw.ready` | 就绪 | Ready | [src/liveWatchView.js:87](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:126](../src/webview/liveWatch/renderer.js) |
| `lw.hint` | 运行中非侵入读取 RAM | Non-intrusive RAM reads while running |  |
| `lw.splitterHint` | 左右拖动调整当前数值栏宽度 | Drag left/right to resize the current-value panel | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.valuePane` | 数值栏 | Values | [src/liveWatchView.js:88](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:2803](../src/webview/liveWatch/renderer.js) |
| `lw.collapsePane` | 折叠当前数值栏 | Collapse the current-value panel | [src/liveWatchView.js:88](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:2802](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:2804](../src/webview/liveWatch/renderer.js) |
| `lw.expandPane` | 展开当前数值栏 | Expand the current-value panel | [src/webview/liveWatch/renderer.js:2802](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:2804](../src/webview/liveWatch/renderer.js) |
| `lw.startSampling` | 开始采样 | Start Sampling | [src/liveWatchView.js:88](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:328](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1788](../src/webview/liveWatch/renderer.js) |
| `lw.stopSampling` | 停止采样 | Stop Sampling | [src/webview/liveWatch/renderer.js:328](../src/webview/liveWatch/renderer.js) |
| `lw.starting` | 正在启动… | Starting… | [src/webview/liveWatch/renderer.js:328](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1019](../src/webview/liveWatch/renderer.js) |
| `lw.stopping` | 正在停止… | Stopping… | [src/webview/liveWatch/renderer.js:1026](../src/webview/liveWatch/renderer.js) |
| `lw.frequency` | 采样频率 | Sampling frequency |  |
| `lw.importVars` | 导入变量 | Import Variables | [src/liveWatchView.js:89](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:1779](../src/webview/liveWatch/renderer.js) |
| `lw.addByName` | 按名称添加… | Add by name… | [src/liveWatchView.js:89](../src/liveWatchView.js) |
| `lw.add` | 添加 | Add | [src/liveWatchView.js:89](../src/liveWatchView.js) |
| `lw.window` | 窗口 | Window | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.sec10` | 10 秒 | 10 s | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.sec30` | 30 秒 | 30 s | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.sec60` | 60 秒 | 60 s | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.all` | 全部 | All | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.windowCustom` | 自定义 | Custom | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.freeze` | 冻结图表 | Freeze Chart | [src/liveWatchView.js:90](../src/liveWatchView.js)，[src/webview/liveWatch/chartControls.js:189](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:314](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1045](../src/webview/liveWatch/renderer.js) |
| `lw.resume` | 恢复实时 | Resume live | [src/webview/liveWatch/chartControls.js:189](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:314](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1785](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:2757](../src/webview/liveWatch/renderer.js) |
| `lw.normalize` | 归一化 | Normalize | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.normalized` | 各曲线独立缩放 | Each curve scaled independently | [src/liveWatchView.js:90](../src/liveWatchView.js)，[src/webview/liveWatch/chart.js:360](../src/webview/liveWatch/chart.js) |
| `lw.clear` | 清空历史 | Clear History | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.exportCsv` | 导出 CSV | Export CSV | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.exportCsvTitle` | 将采样历史导出为 CSV 文件 | Export the sampled history to a CSV file | [src/liveWatchView.js:90](../src/liveWatchView.js) |
| `lw.noDataToExport` | 暂无采样数据可导出 | No sampled data to export | [src/webview/liveWatch/renderer.js:1584](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1586](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:2643](../src/webview/liveWatch/renderer.js) |
| `lw.archiveTruncated` | 采样历史已达大小上限，此后的样本未再归档 | Sampling history reached its size limit; later samples were not archived | [src/webview/liveWatch/renderer.js:1618](../src/webview/liveWatch/renderer.js) |
| `lw.exportTitle` | 导出 CSV | Export CSV | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportSeries` | 曲线 | Series | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportRange` | 时间范围 | Time range | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportAll` | 全部数据 | All data | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportRecent10` | 最近 10 秒 | Last 10 s | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportRecent30` | 最近 30 秒 | Last 30 s | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportRecent60` | 最近 60 秒 | Last 60 s | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportCustom` | 自定义 | Custom | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportTimeline` | 拖动两端选择时间区间 | Drag both ends to select a time range | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportFrom` | 导出起点 | Export start | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportTo` | 导出终点 | Export end | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportSelectedRange` | 已选 {from} – {to} | Selected {from} – {to} | [src/webview/liveWatch/renderer.js:1451](../src/webview/liveWatch/renderer.js) |
| `lw.exportSave` | 保存 CSV | Save CSV | [src/liveWatchView.js:93](../src/liveWatchView.js) |
| `lw.exportNoSeries` | 请至少选择一条曲线 | Select at least one series | [src/webview/liveWatch/renderer.js:1624](../src/webview/liveWatch/renderer.js) |
| `lw.exportInvalidRange` | 请输入有效的时间范围 | Enter a valid time range | [src/webview/liveWatch/renderer.js:1629](../src/webview/liveWatch/renderer.js) |
| `lw.exportEmptyRange` | 所选时间范围内没有采样数据 | The selected range has no samples |  |
| `lw.exportSuccess` | 已导出 {series} 条曲线 / {rows} 行 | Exported {series} series / {rows} rows | [src/webview/liveWatch/renderer.js:2785](../src/webview/liveWatch/renderer.js) |
| `lw.currentValues` | 当前数值 | Current Values | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.varListEmpty` | 导入或按名称添加变量 | Import or add variables by name | [src/liveWatchView.js:91](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:497](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1762](../src/webview/liveWatch/renderer.js) |
| `lw.history` | 历史曲线 | History | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.points` | {n} 个采样点 | {n} samples | [src/liveWatchView.js:91](../src/liveWatchView.js)，[src/webview/liveWatch/chart.js:166](../src/webview/liveWatch/chart.js)，[src/webview/liveWatch/chart.js:227](../src/webview/liveWatch/chart.js)，[src/webview/liveWatch/chart.js:358](../src/webview/liveWatch/chart.js) |
| `lw.chartEmpty` | 开始采样后将在此显示曲线 | Curves will appear here after sampling starts | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.chartTimeline` | 显示时间范围 | Visible time range |  |
| `lw.chartTimelineHint` | 拖动高亮区域或两端调整波形显示时间范围 | Drag the highlighted range or either end to change the visible time range | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.chartFrom` | 波形显示起点 | Chart range start | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.chartTo` | 波形显示终点 | Chart range end | [src/liveWatchView.js:91](../src/liveWatchView.js) |
| `lw.chartSelectedRange` | {from} – {to} | {from} – {to} | [src/webview/liveWatch/renderer.js:2109](../src/webview/liveWatch/renderer.js) |
| `lw.importTitle` | 从 ELF 导入变量 | Import Variables from ELF | [src/liveWatchView.js:92](../src/liveWatchView.js) |
| `lw.filterVars` | 过滤变量名… | Filter variable names… | [src/liveWatchView.js:92](../src/liveWatchView.js) |
| `lw.cancel` | 取消 | Cancel | [src/liveWatchView.js:92](../src/liveWatchView.js)，[src/liveWatchView.js:93](../src/liveWatchView.js)，[src/webview/liveWatch/renderer.js:977](../src/webview/liveWatch/renderer.js) |
| `lw.importSelected` | 导入选中 | Import Selected | [src/liveWatchView.js:92](../src/liveWatchView.js) |
| `lw.showCurve` | 显示曲线 | Show curve | [src/webview/liveWatch/chartControls.js:164](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:512](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:652](../src/webview/liveWatch/renderer.js) |
| `lw.hideCurve` | 隐藏曲线 | Hide curve | [src/webview/liveWatch/chartControls.js:164](../src/webview/liveWatch/chartControls.js)，[src/webview/liveWatch/renderer.js:512](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:652](../src/webview/liveWatch/renderer.js) |
| `lw.removeVar` | 移除变量 | Remove variable | [src/webview/liveWatch/renderer.js:533](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:785](../src/webview/liveWatch/renderer.js) |
| `lw.removeVarName` | 移除 {name} | Remove {name} | [src/webview/liveWatch/renderer.js:534](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:786](../src/webview/liveWatch/renderer.js) |
| `lw.needVar` | 请先添加要观察的变量 | Add a variable to watch first | [src/webview/liveWatch/renderer.js:1011](../src/webview/liveWatch/renderer.js) |
| `lw.error` | 发生错误 | An error occurred | [src/webview/liveWatch/renderer.js:2564](../src/webview/liveWatch/renderer.js) |
| `lw.compositeUnsupported` | 结构体与数组暂不支持整体采样 | Structs and arrays can't be sampled as a whole |  |
| `lw.compositeNoLayout` | 缺少 DWARF 布局信息，无法展开成员 | Missing DWARF layout info; cannot expand members | [src/services/elfService.js:122](../src/services/elfService.js)，[src/webview/liveWatch/renderer.js:369](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:711](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:724](../src/webview/liveWatch/renderer.js) |
| `lw.unknownType` | 未知类型 | Unknown type | [src/webview/liveWatch/renderer.js:1142](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:541](../src/webview/sidebar/renderer.js) |
| `lw.cppUnknownType` | C++ 符号缺少 DWARF 类型信息，不按大小猜测标量类型 | C++ symbol has no DWARF type info; refusing to guess a scalar type from its size | [src/services/elfService.js:121](../src/services/elfService.js) |
| `lw.cppSymbolAmbiguous` | C++ 符号在 DWARF 中无法唯一匹配，已停用类型绑定 | C++ symbol could not be uniquely matched in DWARF; type binding disabled | [src/services/elfService.js:119](../src/services/elfService.js) |
| `lw.compositeExpand` | 展开 | Expand |  |
| `lw.compositeCollapse` | 折叠 | Collapse |  |
| `lw.structMember` | 成员 | Member |  |
| `lw.arrayElement` | 元素 | Element |  |
| `lw.arraySelectTitle` | 数组元素选取 | Array Element Selection | [src/webview/liveWatch/renderer.js:937](../src/webview/liveWatch/renderer.js) |
| `lw.arrayAll` | 全部元素 | All elements | [src/webview/liveWatch/renderer.js:954](../src/webview/liveWatch/renderer.js) |
| `lw.arrayRange` | 指定范围 | Range | [src/webview/liveWatch/renderer.js:965](../src/webview/liveWatch/renderer.js) |
| `lw.arraySingle` | 单个元素 | Single element | [src/webview/liveWatch/renderer.js:972](../src/webview/liveWatch/renderer.js) |
| `lw.arrayStart` | 起始 | Start | [src/webview/liveWatch/renderer.js:964](../src/webview/liveWatch/renderer.js) |
| `lw.arrayEnd` | 结束 | End | [src/webview/liveWatch/renderer.js:964](../src/webview/liveWatch/renderer.js) |
| `lw.arrayIndex` | 索引 | Index | [src/webview/liveWatch/renderer.js:971](../src/webview/liveWatch/renderer.js) |
| `lw.arrayApply` | 确定 | Apply | [src/webview/liveWatch/renderer.js:979](../src/webview/liveWatch/renderer.js) |
| `lw.arrayMore` | … 其余 {n} 个元素未显示 | … {n} more element(s) not shown | [src/webview/liveWatch/renderer.js:734](../src/webview/liveWatch/renderer.js)，[src/webview/liveWatch/renderer.js:1209](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:621](../src/webview/sidebar/renderer.js)，[src/webview/sidebar/renderer.js:1309](../src/webview/sidebar/renderer.js) |
| `lw.addToChart` | 加入图表 | Add to chart | [src/webview/liveWatch/renderer.js:652](../src/webview/liveWatch/renderer.js) |
| `lw.removeFromChart` | 从图表移除 | Remove from chart |  |
| `lw.clearFilter` | 清除筛选 | Clear filter | [src/liveWatchView.js:92](../src/liveWatchView.js)，[src/modernView.js:25](../src/modernView.js) |
| `lw.compositeExpandable` | 可展开的复合类型（勾选后加入观察列表） | Expandable composite (check to add to the watch list) | [src/webview/liveWatch/renderer.js:1128](../src/webview/liveWatch/renderer.js) |
| `lw.plotMembersHint` | 点击成员旁的颜色按钮即可加入绘图。结构体整体为数值视图。 | Click the color button beside a member to plot it. The whole structure is a value view. |  |
| `lw.totalVars` | 共 {n} 个变量 | {n} variables total | [src/webview/liveWatch/renderer.js:1280](../src/webview/liveWatch/renderer.js) |
| `lw.showingFirst` | ，仅显示前 {n} 个 |  (showing first {n}) | [src/webview/liveWatch/renderer.js:1281](../src/webview/liveWatch/renderer.js)，[src/webview/sidebar/renderer.js:717](../src/webview/sidebar/renderer.js) |
| `lw.compositeTitle` | 复合类型暂不支持 | Composite types are not supported yet |  |
| `lw.connecting` | 正在启动 OpenOCD 服务… | Starting OpenOCD service… | [src/liveWatch.js:578](../src/liveWatch.js) |
| `lw.connected` | 已连接 OpenOCD，开始采样 | Connected to OpenOCD, sampling started | [src/liveWatch.js:712](../src/liveWatch.js) |
| `oc.checking` | 正在检测 OpenOCD… | Checking OpenOCD… | [src/modernView.js:24](../src/modernView.js)，[src/services/openocdStatusService.js:10](../src/services/openocdStatusService.js)，[src/services/openocdStatusService.js:41](../src/services/openocdStatusService.js)，[src/webview/sidebar/renderer.js:1537](../src/webview/sidebar/renderer.js) |
| `oc.readyVer` | OpenOCD v{version} 已就绪 | OpenOCD v{version} ready | [src/openocdChecker.js:198](../src/openocdChecker.js)，[src/openocdChecker.js:343](../src/openocdChecker.js)，[src/services/openocdStatusService.js:74](../src/services/openocdStatusService.js) |
| `oc.ready` | OpenOCD 已就绪 | OpenOCD ready | [src/openocdChecker.js:198](../src/openocdChecker.js)，[src/openocdChecker.js:343](../src/openocdChecker.js)，[src/services/openocdStatusService.js:74](../src/services/openocdStatusService.js) |
| `oc.incompatibleBundled` | OpenOCD v{version} 不兼容（需要 >= {minimum}）。请升级，或点击“安装”使用插件内置 xPack OpenOCD 0.12.0-7 | OpenOCD v{version} is incompatible (requires >= {minimum}). Upgrade it, or click Install to use the bundled xPack OpenOCD 0.12.0-7 | [src/openocdChecker.js:320](../src/openocdChecker.js) |
| `oc.incompatibleUpgrade` | OpenOCD v{version} 不兼容（需要 >= {minimum}）。请升级 OpenOCD，然后重新选择可执行文件 | OpenOCD v{version} is incompatible (requires >= {minimum}). Upgrade OpenOCD, then select the new executable | [src/openocdChecker.js:321](../src/openocdChecker.js) |
| `oc.versionUnknownBundled` | 无法识别 OpenOCD 版本（需要 >= {minimum}）。请点击“安装”使用插件内置 xPack OpenOCD 0.12.0-7，或选择兼容版本 | The OpenOCD version could not be identified (requires >= {minimum}). Click Install to use the bundled xPack OpenOCD 0.12.0-7, or select a compatible version | [src/openocdChecker.js:323](../src/openocdChecker.js) |
| `oc.versionUnknownUpgrade` | 无法识别 OpenOCD 版本（需要 >= {minimum}）。请升级后重新选择可执行文件 | The OpenOCD version could not be identified (requires >= {minimum}). Upgrade OpenOCD, then select the new executable | [src/openocdChecker.js:324](../src/openocdChecker.js) |
| `oc.installedReadyVer` | OpenOCD v{version} 已安装并就绪 | OpenOCD v{version} installed and ready | [src/openocdChecker.js:288](../src/openocdChecker.js) |
| `oc.installedReady` | OpenOCD 已安装并就绪 | OpenOCD installed and ready | [src/openocdChecker.js:288](../src/openocdChecker.js) |
| `oc.missing` | 未检测到 OpenOCD | OpenOCD not found | [src/openocdChecker.js:356](../src/openocdChecker.js) |
| `oc.preparing` | 正在准备安装 OpenOCD… | Preparing OpenOCD installation… | [src/openocdChecker.js:250](../src/openocdChecker.js) |
| `oc.extracting` | 正在解压 OpenOCD… | Extracting OpenOCD… | [src/openocdInstaller.js:123](../src/openocdInstaller.js) |
| `oc.extractingPct` | 正在解压 OpenOCD… {pct}% | Extracting OpenOCD… {pct}% | [src/openocdInstaller.js:136](../src/openocdInstaller.js) |
| `oc.verifying` | 正在验证 OpenOCD… | Verifying OpenOCD… | [src/openocdChecker.js:259](../src/openocdChecker.js) |
| `oc.validatingSelected` | 正在验证所选 OpenOCD… | Verifying the selected OpenOCD… | [src/openocdChecker.js:190](../src/openocdChecker.js) |
| `oc.installFailed` | OpenOCD 安装失败：{error} | OpenOCD installation failed: {error} | [src/openocdChecker.js:274](../src/openocdChecker.js)，[src/openocdChecker.js:305](../src/openocdChecker.js) |
| `oc.verifyFailed` | OpenOCD 验证未通过：{error}；原配置未更改 | OpenOCD verification failed: {error}; the previous setting was kept | [src/openocdChecker.js:297](../src/openocdChecker.js) |
| `oc.selectedUnusable` | 所选文件不可用：{error} | The selected file is unusable: {error} | [src/openocdChecker.js:211](../src/openocdChecker.js) |
| `oc.noBundle` | 当前平台（{platform}）暂无预置包；已打开下载页，安装后请选择 OpenOCD 路径 | No bundled package for this platform ({platform}); the download page was opened — select the OpenOCD path after installing | [src/openocdChecker.js:243](../src/openocdChecker.js) |
| `oc.noBundleLinux` | 当前平台（{platform}）暂无预置包。请用系统包管理器安装 OpenOCD（Debian/Ubuntu：sudo apt install openocd；Fedora：sudo dnf install openocd；Arch：sudo pacman -S openocd），安装后通过"选择 OpenOCD"指定 /usr/bin/openocd；访问 USB 探针还需 udev 规则或相应用户组权限 | No bundled package for this platform ({platform}). Install OpenOCD with your system package manager (Debian/Ubuntu: sudo apt install openocd; Fedora: sudo dnf install openocd; Arch: sudo pacman -S openocd), then use "Select OpenOCD" to point at /usr/bin/openocd. USB probes also require udev rules or group membership. | [src/openocdChecker.js:234](../src/openocdChecker.js) |
| `oc.noBundleDarwin` | 当前平台（{platform}）暂无预置包。可通过 brew install openocd 安装，或在 openocd.org 下载后通过"选择 OpenOCD"指定可执行文件路径 | No bundled package for this platform ({platform}). Install with brew install openocd, or download from openocd.org and use "Select OpenOCD" to point at the executable. | [src/openocdChecker.js:234](../src/openocdChecker.js) |
| `oc.pickLabel` | 选择 OpenOCD | Select OpenOCD | [src/openocdChecker.js:185](../src/openocdChecker.js) |
| `oc.pickExe` | OpenOCD 可执行文件 | OpenOCD executables | [src/openocdChecker.js:181](../src/openocdChecker.js) |
| `oc.allFiles` | 所有文件 | All files | [src/openocdChecker.js:182](../src/openocdChecker.js) |
| `oc.errNoPath` | 未配置 OpenOCD 路径 | OpenOCD path not configured | [src/openocdChecker.js:44](../src/openocdChecker.js) |
| `oc.errNotFound` | 找不到该可执行文件 | Executable not found | [src/openocdChecker.js:60](../src/openocdChecker.js) |
| `oc.errNotFoundPath` | 找不到该可执行文件（请确认路径或将其加入 PATH） | Executable not found (check the path or add it to PATH) | [src/openocdChecker.js:103](../src/openocdChecker.js) |
| `oc.errTimeout` | 探测超时 | Probe timed out | [src/openocdChecker.js:85](../src/openocdChecker.js) |
| `oc.errExit` | 退出码 {code}，且输出无法识别为 OpenOCD | Exit code {code}, and the output was not recognized as OpenOCD | [src/openocdChecker.js:120](../src/openocdChecker.js) |
| `oc.errNotOpenocd` | 所选文件不是有效的 OpenOCD | The selected file is not a valid OpenOCD | [src/openocdChecker.js:120](../src/openocdChecker.js) |
| `oc.reselect` | 请重新选择 | please reselect | [src/openocdChecker.js:215](../src/openocdChecker.js) |
| `oc.unknownError` | 未知错误 | unknown error | [src/openocdChecker.js:275](../src/openocdChecker.js) |
| `oc.confirmManually` | 请手动确认 | please verify manually | [src/openocdChecker.js:298](../src/openocdChecker.js) |
| `run.starting` | 正在启动 OpenOCD | Starting OpenOCD | [src/openocdRunner.js:206](../src/openocdRunner.js) |
| `run.adapterClock` | 适配器时钟 {clock} | Adapter clock {clock} | [src/openocdRunner.js:37](../src/openocdRunner.js) |
| `run.voltage` | 目标电压 {volts} V | Target voltage {volts} V | [src/openocdRunner.js:51](../src/openocdRunner.js) |
| `run.voltageLow` | 目标电压异常（{volts} V），目标板可能未供电 | Abnormal target voltage ({volts} V); the board may be unpowered | [src/openocdRunner.js:51](../src/openocdRunner.js) |
| `run.deviceId` | 器件 ID {id} | Device ID {id} | [src/openocdRunner.js:62](../src/openocdRunner.js) |
| `run.chip` | 识别芯片 {chip} | Detected chip {chip} | [src/openocdRunner.js:71](../src/openocdRunner.js) |
| `run.flash` | Flash 容量 {size} | Flash size {size} | [src/openocdRunner.js:81](../src/openocdRunner.js) |
| `run.programStart` | 开始写入固件 | Writing firmware | [src/openocdRunner.js:88](../src/openocdRunner.js) |
| `run.wrote` | 已写入 {bytes} bytes（{seconds}s，{speed}） | Wrote {bytes} bytes ({seconds}s, {speed}) | [src/openocdRunner.js:94](../src/openocdRunner.js) |
| `run.wroteNoSpeed` | 已写入 {bytes} bytes（{seconds}s） | Wrote {bytes} bytes ({seconds}s) | [src/openocdRunner.js:94](../src/openocdRunner.js) |
| `run.verifyOk` | 固件校验通过 | Firmware verified | [src/openocdRunner.js:101](../src/openocdRunner.js) |
| `run.verified` | 已校验 {bytes} bytes（{seconds}s，{speed}） | Verified {bytes} bytes ({seconds}s, {speed}) | [src/openocdRunner.js:107](../src/openocdRunner.js) |
| `run.verifiedNoSpeed` | 已校验 {bytes} bytes（{seconds}s） | Verified {bytes} bytes ({seconds}s) | [src/openocdRunner.js:107](../src/openocdRunner.js) |
| `run.downloadSuccess` | 下载成功 | Download complete | [src/openocdRunner.js:339](../src/openocdRunner.js) |
| `run.notFound` | 找不到 OpenOCD：{path} | OpenOCD not found: {path} | [src/liveWatch.js:585](../src/liveWatch.js)，[src/liveWatch.js:595](../src/liveWatch.js)，[src/openocdRunner.js:306](../src/openocdRunner.js)，[src/services/openocdExec.js:12](../src/services/openocdExec.js) |
| `msg.openWorkspaceFirst` | 请先打开工作区 | Open a workspace first | [src/services/skillStatusService.js:110](../src/services/skillStatusService.js)，[src/services/svdManager.js:172](../src/services/svdManager.js)，[src/services/svdManager.js:189](../src/services/svdManager.js)，[src/services/svdManager.js:253](../src/services/svdManager.js) |
| `msg.skillsInstalled` | EmberProbe Agent Skills 已安装到当前工作区 | EmberProbe Agent Skills installed into the current workspace | [src/skillInstaller.js:287](../src/skillInstaller.js) |
| `msg.skillsInstalledGlobal` | EmberProbe Agent Skills 已安装到用户主目录 ~/.agents/skills | EmberProbe Agent Skills installed to ~/.agents/skills for all projects |  |
| `msg.skillsDiffers` | 已安装的 Agent Skills 与插件内置版本存在差异，可重新安装进行升级 | Installed Agent Skills differ from the bundled version; reinstall to upgrade | [src/services/skillStatusService.js:69](../src/services/skillStatusService.js)，[src/services/skillStatusService.js:77](../src/services/skillStatusService.js) |
| `msg.skillsModifiedBridgeWarn` | 检测到已安装的 Agent Skills 被本地修改，经其发起的请求可能执行被篡改的脚本，建议重新安装 | Installed Agent Skills have local modifications; requests routed through them may run tampered scripts. Reinstalling is recommended | [src/services/skillStatusService.js:68](../src/services/skillStatusService.js) |
| `msg.skillsManage` | 管理 | Manage | [src/services/skillStatusService.js:67](../src/services/skillStatusService.js)，[src/services/skillStatusService.js:76](../src/services/skillStatusService.js) |
| `msg.skillsUninstalled` | EmberProbe Agent Skills 已从当前项目移除 | EmberProbe Agent Skills removed from the current project | [src/skillInstaller.js:337](../src/skillInstaller.js) |
| `msg.skillsUninstalledGlobal` | EmberProbe Agent Skills 已从全局目录移除 | EmberProbe Agent Skills removed from the global directory | [src/skillInstaller.js:337](../src/skillInstaller.js) |
| `msg.csvExported` | CSV 已导出：{file} | CSV exported: {file} | [src/mainViewProvider.js:2900](../src/mainViewProvider.js) |
| `msg.csvExportFailed` | CSV 导出失败：{msg} | CSV export failed: {msg} | [src/mainViewProvider.js:2909](../src/mainViewProvider.js) |
| `msg.noElfFound` | 未找到任何 .elf 文件！ | No .elf files found! | [src/mainViewProvider.js:532](../src/mainViewProvider.js) |
| `msg.searchElf` | 搜索 ELF 文件... | Search ELF files... | [src/mainViewProvider.js:543](../src/mainViewProvider.js) |
| `msg.searchDebugger` | 搜索调试器配置文件... | Search debugger configuration files... | [src/mainViewProvider.js:581](../src/mainViewProvider.js) |
| `msg.searchMcu` | 搜索 MCU 核心配置文件... | Search MCU core configuration files... | [src/mainViewProvider.js:615](../src/mainViewProvider.js) |
| `msg.elfSelected` | 已选择 ELF 文件：{name} | ELF file selected: {name} | [src/mainViewProvider.js:553](../src/mainViewProvider.js) |
| `msg.debuggerSelected` | 已选择调试器：{name} | Debugger selected: {name} | [src/mainViewProvider.js:594](../src/mainViewProvider.js) |
| `msg.mcuSelected` | 已选择 MCU 核心：{name} | MCU core selected: {name} | [src/mainViewProvider.js:628](../src/mainViewProvider.js) |
| `msg.selectElfFailed` | 选择 ELF 文件失败：{error} | Failed to select ELF file: {error} | [src/mainViewProvider.js:565](../src/mainViewProvider.js) |
| `msg.configIncomplete` | 请先完整配置 ELF 文件、调试器和 MCU 核心！ | Please fully configure the ELF file, debugger and MCU core first! | [src/mainViewProvider.js:669](../src/mainViewProvider.js)，[src/mainViewProvider.js:892](../src/mainViewProvider.js) |
| `msg.openWorkspaceForDebug` | 请先打开一个工作空间！ | Open a workspace first! | [src/mainViewProvider.js:682](../src/mainViewProvider.js) |
| `msg.debugConfigName` | MCU 调试（OpenOCD） | MCU Debug (OpenOCD) | [src/mainViewProvider.js:766](../src/mainViewProvider.js) |
| `msg.debugStartFailed` | 调试会话启动失败，请检查调试器与 OpenOCD 配置。 | Failed to start the debug session. Check the debugger and OpenOCD configuration. | [src/mainViewProvider.js:799](../src/mainViewProvider.js)，[src/mainViewProvider.js:808](../src/mainViewProvider.js)，[src/mainViewProvider.js:819](../src/mainViewProvider.js)，[src/mainViewProvider.js:1877](../src/mainViewProvider.js) |
| `msg.debugFailed` | 调试启动失败：{error} | Failed to start debugging: {error} | [src/mainViewProvider.js:829](../src/mainViewProvider.js) |
| `msg.debugStartTimeout` | 调试器在 {seconds} 秒内未完成启动，已自动结束会话并释放 OpenOCD。请检查 GDB 是否能从终端正常启动。 | The debugger did not finish starting within {seconds} seconds. The session was stopped and OpenOCD was released. Check that GDB starts normally from a terminal. | [src/services/debugLifecycle.js:9](../src/services/debugLifecycle.js) |
| `msg.debugStartTimeoutWin` | Cortex-Debug 在 {seconds} 秒内未完成启动，已自动结束会话并释放 OpenOCD。Windows 上的 Cortex-Debug {version} 可能受固定 5 秒 GDB 启动超时影响；可改用启动较快的 GDB（如 13.x），或升级到包含修复的稳定版，无需安装预览版。 | Cortex-Debug did not finish starting within {seconds} seconds. The session was stopped and OpenOCD was released. Cortex-Debug {version} on Windows may be affected by its fixed five-second GDB startup timeout; use a faster-starting GDB such as 13.x, or upgrade to a stable release containing the fix. A pre-release is not required. | [src/services/debugLifecycle.js:9](../src/services/debugLifecycle.js) |
| `msg.downloadBusy` | 下载正在进行中，请等待当前任务完成 | A download is already running; please wait for it to finish | [src/mainViewProvider.js:847](../src/mainViewProvider.js) |
| `msg.agentReadBusy` | Agent 正在单次读取变量，请稍候 | The Agent is reading variables; try again shortly | [src/mainViewProvider.js:650](../src/mainViewProvider.js)，[src/mainViewProvider.js:859](../src/mainViewProvider.js) |
| `msg.debugBusy` | 调试会话正在启动，请稍候 | A debug session is starting; try again shortly | [src/mainViewProvider.js:654](../src/mainViewProvider.js) |
| `msg.liveBusyForDownload` | 实时变量查看正在运行，请先停止后再下载（探针同一时刻只能被一个 OpenOCD 占用） | Live watch is running; stop it before downloading (the probe can only be used by one OpenOCD at a time) | [src/mainViewProvider.js:867](../src/mainViewProvider.js) |
| `msg.chipBusyForDownload` | 正在读取芯片信息，请稍后再下载 | Reading chip info; please download later | [src/mainViewProvider.js:863](../src/mainViewProvider.js) |
| `msg.debugBusyForDownload` | 调试会话正在使用探针，请先结束调试再下载 | The debugger is using the probe; end debugging before downloading | [src/mainViewProvider.js:855](../src/mainViewProvider.js) |
| `msg.downloadSuccess` | 固件下载并校验成功 | Firmware downloaded and verified | [src/mainViewProvider.js:922](../src/mainViewProvider.js) |
| `msg.downloadRefreshFailed` | 烧录成功，但 ELF 变量与内存信息刷新失败：{error} | Firmware flashed, but ELF variables and memory information could not refresh: {error} | [src/mainViewProvider.js:938](../src/mainViewProvider.js) |
| `msg.downloadSamplingFailed` | 烧录成功，但自动恢复采样失败：{error} | Firmware flashed, but sampling could not restart automatically: {error} | [src/mainViewProvider.js:947](../src/mainViewProvider.js) |
| `msg.downloadFailed` | 固件下载失败：{error} | Firmware download failed: {error} | [src/mainViewProvider.js:927](../src/mainViewProvider.js) |
| `msg.commandNotRegistered` | 命令 {cmd} 未注册 | Command {cmd} is not registered | [src/mainViewProvider.js:4573](../src/mainViewProvider.js)，[src/mainViewProvider.js:4574](../src/mainViewProvider.js) |
| `msg.unknownError` | 未知错误 | Unknown error | [src/mainViewProvider.js:4579](../src/mainViewProvider.js) |
| `msg.autoDoneWith` | 自动检测完成 — {found} | Auto-detection complete — {found} | [src/mainViewProvider.js:4901](../src/mainViewProvider.js) |
| `msg.autoNone` | 未能自动识别配置，请手动选择 | Could not auto-detect the configuration; please choose manually | [src/mainViewProvider.js:4902](../src/mainViewProvider.js) |
| `msg.foundElf` | ELF: {name} | ELF: {name} | [src/mainViewProvider.js:4895](../src/mainViewProvider.js) |
| `msg.foundMcu` | MCU: {name} | MCU: {name} | [src/mainViewProvider.js:4896](../src/mainViewProvider.js) |
| `msg.foundDebugger` | 调试器: {name} | Debugger: {name} | [src/mainViewProvider.js:4897](../src/mainViewProvider.js) |
| `live.downloadRunning` | 下载进行中，无法同时启动实时查看 | A download is running; live watch cannot start at the same time | [src/mainViewProvider.js:3942](../src/mainViewProvider.js) |
| `live.chipReading` | 正在读取芯片信息，请稍后再启动实时查看 | Reading chip info; start live watch later | [src/mainViewProvider.js:3944](../src/mainViewProvider.js) |
| `live.agentReading` | Agent 正在单次读取变量，请稍候 | The Agent is reading variables; try again shortly | [src/mainViewProvider.js:3946](../src/mainViewProvider.js) |
| `live.agentStarting` | Agent 正在启动临时采样… | The Agent is starting temporary sampling… | [src/mainViewProvider.js:2138](../src/mainViewProvider.js) |
| `live.agentSampling` | Agent 临时采样中 {current}/{total} | Agent temporary sampling {current}/{total} | [src/mainViewProvider.js:1424](../src/mainViewProvider.js)，[src/mainViewProvider.js:1440](../src/mainViewProvider.js) |
| `live.agentDone` | Agent 采样完成，探针已释放 | Agent sampling completed; the probe was released | [src/mainViewProvider.js:2163](../src/mainViewProvider.js) |
| `live.agentStopped` | Agent 临时采样已停止，探针已释放 | Agent temporary sampling stopped; the probe was released | [src/mainViewProvider.js:2161](../src/mainViewProvider.js)，[src/mainViewProvider.js:4471](../src/mainViewProvider.js) |
| `live.agentFailed` | Agent 临时采样失败，探针已释放 | Agent temporary sampling failed; the probe was released | [src/mainViewProvider.js:2164](../src/mainViewProvider.js) |
| `live.starting` | 实时查看正在启动中，请稍候 | Live watch is starting; please wait | [src/mainViewProvider.js:3902](../src/mainViewProvider.js)，[src/mainViewProvider.js:3947](../src/mainViewProvider.js) |
| `live.debugActive` | 检测到正在进行的调试会话，探针已被占用；请先停止调试再启动实时查看 | A debug session is active and the probe is busy; stop debugging before starting live watch |  |
| `live.debugWaiting` | 调试运行中 | Debugging | [src/mainViewProvider.js:4002](../src/mainViewProvider.js)，[src/mainViewProvider.js:4266](../src/mainViewProvider.js)，[src/mainViewProvider.js:4275](../src/mainViewProvider.js)，[src/services/debugSessionBridge.js:215](../src/services/debugSessionBridge.js) |
| `live.debugStartTimeout` | 调试启动超时，已释放 OpenOCD | Debug startup timed out; OpenOCD was released | [src/mainViewProvider.js:1888](../src/mainViewProvider.js) |
| `live.debugSharedConnecting` | 正在连接共享 OpenOCD… | Connecting to the shared OpenOCD service… | [src/mainViewProvider.js:3985](../src/mainViewProvider.js) |
| `live.debugRuntimeSampling` | 采样中 | Sampling | [src/liveWatch.js:885](../src/liveWatch.js)，[src/mainViewProvider.js:1541](../src/mainViewProvider.js)，[src/mainViewProvider.js:1544](../src/mainViewProvider.js)，[src/mainViewProvider.js:1549](../src/mainViewProvider.js) |
| `live.debugTclDegraded` | 共享 OpenOCD 的 Tcl 读取不可用；等待暂停后通过 DAP 读取 | Shared OpenOCD Tcl reads are unavailable; waiting for a DAP pause | [src/liveWatch.js:927](../src/liveWatch.js)，[src/mainViewProvider.js:1541](../src/mainViewProvider.js)，[src/mainViewProvider.js:1567](../src/mainViewProvider.js)，[src/mainViewProvider.js:1975](../src/mainViewProvider.js) |
| `live.runtimeAddressRejected` | 运行时读取仅允许 ELF 可写 RAM 段 | Runtime reads are restricted to writable ELF RAM sections | [src/mainViewProvider.js:1991](../src/mainViewProvider.js)，[src/mainViewProvider.js:3784](../src/mainViewProvider.js) |
| `live.runtimeAddressRejectedNames` | 运行时读取已拒绝非 ELF 可写 RAM 变量：{names} | Runtime reads rejected outside writable ELF RAM: {names} | [src/mainViewProvider.js:1499](../src/mainViewProvider.js) |
| `live.runtimeBudgetExceeded` | 运行时读取超过每周期安全预算（4096 字节 / 32 次读取） | Runtime read exceeds the per-cycle safety budget (4096 bytes / 32 reads) | [src/mainViewProvider.js:1990](../src/mainViewProvider.js)，[src/mainViewProvider.js:3783](../src/mainViewProvider.js) |
| `live.dapSampling` | 芯片已暂停，正通过调试器采样 | Target paused; sampling through debugger |  |
| `live.dapReading` | 芯片已暂停，正在读取当前值… | Target paused; reading the current values… | [src/services/debugSessionBridge.js:224](../src/services/debugSessionBridge.js) |
| `live.dapReady` | 芯片已暂停，当前值已读取 | Target paused; current values have been read | [src/services/debugSessionBridge.js:227](../src/services/debugSessionBridge.js) |
| `live.dapRetrying` | 芯片已暂停，DAP 忙，正在重试读取… | Target paused; DAP is busy, retrying the read… | [src/services/debugSessionBridge.js:583](../src/services/debugSessionBridge.js) |
| `live.dapWriting` | 芯片已暂停，正通过调试器写入并回读校验 | Target paused; writing and verifying through debugger | [src/mainViewProvider.js:2426](../src/mainViewProvider.js) |
| `live.dapReadUnsupported` | 调试器不支持内存读取，已安全停止采样 | The debugger does not support memory reads; sampling stopped safely | [src/services/debugSessionBridge.js:221](../src/services/debugSessionBridge.js) |
| `live.dapFailed` | DAP 读取失败，未更新暂停快照 | DAP read failed; the paused snapshot was not updated | [src/services/debugSessionBridge.js:580](../src/services/debugSessionBridge.js) |
| `live.debugConflict` | 存在多个调试会话，无法确定目标工作区 | Multiple debugger sessions match; the workspace target is ambiguous | [src/mainViewProvider.js:4003](../src/mainViewProvider.js)，[src/services/debugSessionBridge.js:209](../src/services/debugSessionBridge.js) |
| `live.restoring` | 调试已结束，正在等待探针释放并恢复采样… | Debugging ended; waiting for the probe and restoring sampling… | [src/mainViewProvider.js:4138](../src/mainViewProvider.js)，[src/mainViewProvider.js:4396](../src/mainViewProvider.js)，[src/services/debugSessionBridge.js:489](../src/services/debugSessionBridge.js) |
| `live.needConfig` | 请先选择调试器与 MCU 目标 | Select a debugger and MCU target first | [src/mainViewProvider.js:2080](../src/mainViewProvider.js)，[src/mainViewProvider.js:2082](../src/mainViewProvider.js)，[src/mainViewProvider.js:3877](../src/mainViewProvider.js)，[src/mainViewProvider.js:3953](../src/mainViewProvider.js) |
| `live.needVar` | 请先添加要观察的变量 | Add a variable to watch first | [src/mainViewProvider.js:1960](../src/mainViewProvider.js)，[src/mainViewProvider.js:3768](../src/mainViewProvider.js)，[src/mainViewProvider.js:3802](../src/mainViewProvider.js)，[src/mainViewProvider.js:3809](../src/mainViewProvider.js) |
| `live.notReady` | OpenOCD 未就绪：请在命令面板执行 “EmberProbe：检查 OpenOCD 环境” 完成安装或路径配置 | OpenOCD not ready: run "EmberProbe: Check OpenOCD Environment" from the command palette to install or set the path | [src/mainViewProvider.js:2088](../src/mainViewProvider.js)，[src/mainViewProvider.js:2090](../src/mainViewProvider.js)，[src/mainViewProvider.js:3881](../src/mainViewProvider.js)，[src/mainViewProvider.js:4036](../src/mainViewProvider.js) |
| `live.serviceExited` | OpenOCD 服务已退出（代码 {code}）：可能探针被占用、配置错误或端口 {port} 被占用 | OpenOCD service exited (code {code}): the probe may be busy, the config wrong, or port {port} in use | [src/liveWatch.js:674](../src/liveWatch.js)，[src/mainViewProvider.js:1586](../src/mainViewProvider.js) |
| `live.probeDisconnected` | 检测到调试器已断开，实时采样已自动停止 | Debugger disconnected; live sampling stopped automatically | [src/liveWatch.js:619](../src/liveWatch.js) |
| `live.elfFirst` | 请先在侧栏选择 ELF 固件 | Select an ELF firmware in the sidebar first | [src/services/elfService.js:59](../src/services/elfService.js)，[src/services/elfService.js:61](../src/services/elfService.js)，[src/services/elfService.js:403](../src/services/elfService.js)，[src/services/elfService.js:405](../src/services/elfService.js) |
| `live.elfReadFail` | 无法读取 ELF：{path} | Cannot read ELF: {path} | [src/services/elfService.js:437](../src/services/elfService.js)，[src/services/elfService.js:439](../src/services/elfService.js) |
| `live.elfTooLarge` | ELF 超过 {limit} MiB 安全上限，已拒绝解析：{path} | ELF exceeds the {limit} MiB safety limit and was not parsed: {path} | [src/services/elfService.js:171](../src/services/elfService.js)，[src/services/elfService.js:173](../src/services/elfService.js)，[src/services/elfService.js:415](../src/services/elfService.js)，[src/services/elfService.js:418](../src/services/elfService.js) |
| `live.varNotFound` | ELF 中未找到变量：{name} | Variable not found in the ELF: {name} | [src/mainViewProvider.js:2722](../src/mainViewProvider.js) |
| `warn.noDwarf` | 未读取到 DWARF 类型信息，类型按大小推测（如需精确类型，请用带 -g 的 Debug 构建） | No DWARF type info found; types are inferred from size (build with -g for precise types) | [src/services/elfService.js:476](../src/services/elfService.js) |
| `diag.cppTypeUnresolved` | C++ 符号 {name} 未能从 DWARF 解析类型，已标记为不可观测而非猜测标量 | C++ symbol {name} has no DWARF type; marked unobservable instead of guessing a scalar | [src/services/elfService.js:147](../src/services/elfService.js) |
| `diag.cppSymbolAmbiguous` | C++ 符号 {name} 在 DWARF 中命中多个类型不一致的候选，无法唯一匹配 | C++ symbol {name} matched multiple conflicting DWARF candidates; cannot match uniquely | [src/services/elfService.js:147](../src/services/elfService.js) |
| `diag.cppDiagnosticsTruncated` | 另有 {count} 条 C++ 绑定诊断已省略 | {count} further C++ binding diagnostics were suppressed | [src/services/elfService.js:156](../src/services/elfService.js)，[src/services/elfService.js:160](../src/services/elfService.js) |
| `diag.title` | === EmberProbe 芯片信息读取诊断 === | === EmberProbe chip info read diagnostics === | [src/mainViewProvider.js:4496](../src/mainViewProvider.js) |
| `diag.time` | 时间：{time} | Time: {time} | [src/mainViewProvider.js:4497](../src/mainViewProvider.js) |
| `diag.target` | 目标配置：{target} | Target configuration: {target} | [src/mainViewProvider.js:4498](../src/mainViewProvider.js) |
| `diag.timings` | 耗时：配置 {config} ms，连接预检 {preflight} ms，OpenOCD 读取 {read} ms，保存连接 {save} ms，总计 {total} ms | Time: configuration {config} ms, preflight {preflight} ms, OpenOCD read {read} ms, save connection {save} ms, total {total} ms | [src/mainViewProvider.js:4502](../src/mainViewProvider.js) |
| `diag.parsed` | 解析结果：{content} | Parsed result: {content} | [src/mainViewProvider.js:4522](../src/mainViewProvider.js) |
| `diag.none` | （无） | (none) | [src/mainViewProvider.js:4527](../src/mainViewProvider.js) |
| `diag.commands` | 执行的 OpenOCD 命令： | OpenOCD commands executed: | [src/mainViewProvider.js:4532](../src/mainViewProvider.js) |
| `diag.rawOutput` | OpenOCD 原始输出： | Raw OpenOCD output: | [src/mainViewProvider.js:4535](../src/mainViewProvider.js) |
| `diag.kvCore` | 内核 | Core | [src/mainViewProvider.js:4513](../src/mainViewProvider.js) |
| `diag.kvCoreRev` | 内核修订 | Core Revision | [src/mainViewProvider.js:4514](../src/mainViewProvider.js) |
| `diag.kvFlash` | Flash | Flash | [src/mainViewProvider.js:4517](../src/mainViewProvider.js) |
| `diag.kvState` | 目标状态 | Target State | [src/mainViewProvider.js:4519](../src/mainViewProvider.js) |
| `diag.channelName` | EmberProbe 芯片信息 | EmberProbe Chip Info | [src/mainViewProvider.js:4491](../src/mainViewProvider.js) |

## 原始错误表达式候选

共 888 处 new Error / connectionError / driverError / failure 定义；包含内部错误，不代表每一条都展示。底层日志及其他错误工厂仍可产生动态文本。

| 来源（行号） | 错误表达式 |
| --- | --- |
| [src/agentBridge.js:145](../src/agentBridge.js) | `new Error("Invalid method")` |
| [src/chartHistoryWorker.js:19](../src/chartHistoryWorker.js) | `new Error("A CSV output path is required")` |
| [src/chartHistoryWorker.js:28](../src/chartHistoryWorker.js) | `new Error("No retained samples are available")` |
| [src/chartHistoryWorker.js:31](../src/chartHistoryWorker.js) | `new Error("Invalid CSV range")` |
| [src/chartHistoryWorker.js:39](../src/chartHistoryWorker.js) | `new Error("Chart CSV exceeds 64 MiB; use the archive export")` |
| [src/chartHistoryWorker.js:94](../src/chartHistoryWorker.js) | `new Error("History changed while restoring")` |
| [src/chartHistoryWorker.js:173](../src/chartHistoryWorker.js) | `new Error("Unknown history operation")` |
| [src/chip/parser.js:327](../src/chip/parser.js) | `new Error(errors.slice(-3).join("；"))` |
| [src/chip/parser.js:328](../src/chip/parser.js) | `new Error(rawTail.slice(-3).join("；"))` |
| [src/chip/parser.js:329](../src/chip/parser.js) | `new Error("未获取到芯片信息")` |
| [src/chip/parser.js:331](../src/chip/parser.js) | `new Error(ˋOpenOCD 退出码 ${code}ˋ)` |
| [src/chipInfo.js:7](../src/chipInfo.js) | `new Error("Invalid OpenOCD configuration name")` |
| [src/chipInfo.js:27](../src/chipInfo.js) | `new Error("读取芯片信息超时（15s）：请检查接线、供电与探针占用情况")` |
| [src/chipInfo.js:39](../src/chipInfo.js) | `new Error(execution.diagnostic.message)` |
| [src/chipInfo.js:46](../src/chipInfo.js) | `new Error("Invalid OpenOCD configuration name")` |
| [src/chipInfo.js:54](../src/chipInfo.js) | `new Error(ˋUnsupported target action: ${action}ˋ)` |
| [src/chipInfo.js:80](../src/chipInfo.js) | `new Error( outcome?.ok ? execution.diagnostic?.message \|\| "OpenOCD control failed" : outcome?.value \|\| execution.diagnostic?.message \|\| "OpenOCD control failed" )` |
| [src/compositeValidation.js:7](../src/compositeValidation.js) | `new Error("Composite layout exceeds its size or expansion budget")` |
| [src/cubemxAuthorization.js:32](../src/cubemxAuthorization.js) | `new Error("CubeMX confirmation expired or the project changed; prepare again")` |
| [src/debug/mi.js:40](../src/debug/mi.js) | `new Error("Unterminated MI string")` |
| [src/debug/mi.js:43](../src/debug/mi.js) | `new Error("MI nesting limit exceeded")` |
| [src/debug/mi.js:46](../src/debug/mi.js) | `new Error("Invalid MI value")` |
| [src/debug/mi.js:61](../src/debug/mi.js) | `new Error("Invalid MI separator")` |
| [src/debug/mi.js:70](../src/debug/mi.js) | `new Error("Invalid MI record")` |
| [src/debug/mi.js:81](../src/debug/mi.js) | `new Error("Invalid MI result")` |
| [src/debug/mi.js:86](../src/debug/mi.js) | `new Error("Trailing MI data")` |
| [src/debug/mi.js:116](../src/debug/mi.js) | `new Error("GDB exited")` |
| [src/debug/mi.js:121](../src/debug/mi.js) | `new Error("GDB output limit exceeded")` |
| [src/debug/mi.js:134](../src/debug/mi.js) | `new Error(record.data.msg \|\| "GDB command failed")` |
| [src/debug/mi.js:145](../src/debug/mi.js) | `new Error("GDB is not running")` |
| [src/debug/mi.js:146](../src/debug/mi.js) | `new Error("Invalid MI command")` |
| [src/debug/mi.js:150](../src/debug/mi.js) | `new Error(ˋGDB command timed out: ${command.split(" ")[0]}ˋ)` |
| [src/debug/mi.js:176](../src/debug/mi.js) | `new Error("Debug session ended")` |
| [src/debug/session.js:122](../src/debug/session.js) | `new Error("Local GDB exit could not be confirmed; external probe hold retained")` |
| [src/debug/session.js:159](../src/debug/session.js) | `new Error("Debug read cancelled by execution control; refresh after stopping")` |
| [src/debug/session.js:162](../src/debug/session.js) | `new Error("Debug read cancelled by execution control; refresh after stopping")` |
| [src/debug/session.js:213](../src/debug/session.js) | `new Error("Debug session ended")` |
| [src/debug/session.js:215](../src/debug/session.js) | `new Error("Debug read cancelled by execution control; refresh after stopping")` |
| [src/debug/session.js:372](../src/debug/session.js) | `new Error(ˋA positive integer thread ID is required, got: ${requested}ˋ)` |
| [src/debug/session.js:378](../src/debug/session.js) | `new Error(ˋRTOS task ${thread} no longer exists; refresh the call stack and retryˋ)` |
| [src/debug/session.js:391](../src/debug/session.js) | `new Error("Target must be paused")` |
| [src/debug/session.js:396](../src/debug/session.js) | `new Error("Stale or invalid debug reference")` |
| [src/debug/session.js:406](../src/debug/session.js) | `new Error("Timed out waiting for target to stop")` |
| [src/debug/session.js:510](../src/debug/session.js) | `new Error("Debug session has already started or ended")` |
| [src/debug/session.js:513](../src/debug/session.js) | `new Error("A valid ELF executable is required")` |
| [src/debug/session.js:518](../src/debug/session.js) | `new Error("Invalid external GDB attach connection")` |
| [src/debug/session.js:521](../src/debug/session.js) | `new Error("Missing managed GDB connection")` |
| [src/debug/session.js:558](../src/debug/session.js) | `new Error("External GDB did not confirm the target's thread state")` |
| [src/debug/session.js:564](../src/debug/session.js) | `new Error("External GDB target did not stop")` |
| [src/debug/session.js:577](../src/debug/session.js) | `new Error("Debugger is not initialized")` |
| [src/debug/session.js:579](../src/debug/session.js) | `new Error("A source path is required")` |
| [src/debug/session.js:629](../src/debug/session.js) | `new Error("Hit conditions and logpoints are not supported")` |
| [src/debug/session.js:631](../src/debug/session.js) | `new Error("Invalid breakpoint line")` |
| [src/debug/session.js:633](../src/debug/session.js) | `new Error("A function name is required")` |
| [src/debug/session.js:752](../src/debug/session.js) | `new Error("Provide a nonempty expression of at most 16384 characters")` |
| [src/debug/session.js:800](../src/debug/session.js) | `new Error("Provide an expression value")` |
| [src/debug/session.js:806](../src/debug/session.js) | `new Error("Expression is read only or unavailable")` |
| [src/debug/session.js:810](../src/debug/session.js) | `new Error("GDB expression is not editable")` |
| [src/debug/session.js:870](../src/debug/session.js) | `new Error("Invalid thread")` |
| [src/debug/session.js:881](../src/debug/session.js) | `new Error("Stack paging requires a nonnegative start and levels <= 1000")` |
| [src/debug/session.js:987](../src/debug/session.js) | `new Error("External GDB restart is unsupported")` |
| [src/debug/session.js:989](../src/debug/session.js) | `new Error("Shared serverGroup restart is unsupported; stop all cores before resetting")` |
| [src/debug/session.js:1015](../src/debug/session.js) | `new Error(ˋUnsupported debug request: ${command}ˋ)` |
| [src/debug/session.js:1020](../src/debug/session.js) | `new Error("Invalid memory address")` |
| [src/debug/session.js:1021](../src/debug/session.js) | `new Error("Invalid memory offset")` |
| [src/debug/session.js:1023](../src/debug/session.js) | `new Error("Memory address outside Cortex-M range")` |
| [src/debug/session.js:1027](../src/debug/session.js) | `new Error("Memory read limit is 65536 bytes")` |
| [src/debug/session.js:1028](../src/debug/session.js) | `new Error("Memory range overflow")` |
| [src/debug/session.js:1047](../src/debug/session.js) | `new Error("Invalid base64 memory data")` |
| [src/debug/session.js:1050](../src/debug/session.js) | `new Error("Memory write limit exceeded")` |
| [src/debug/stl.js:41](../src/debug/stl.js) | `new Error("Incomplete C++ template type")` |
| [src/debug/stl.js:48](../src/debug/stl.js) | `new Error(ˋInvalid STL field: ${value}ˋ)` |
| [src/debug/stl.js:53](../src/debug/stl.js) | `new Error("Invalid STL length")` |
| [src/debug/stl.js:58](../src/debug/stl.js) | `new Error("Unsupported C++ type expression")` |
| [src/debug/stl.js:79](../src/debug/stl.js) | `new Error("STL display requires a side-effect-free variable path")` |
| [src/debug/stl.js:174](../src/debug/stl.js) | `new Error("STL time budget exceeded (15 seconds)")` |
| [src/debug/stl.js:217](../src/debug/stl.js) | `new Error("GDB did not resolve the C++ type")` |
| [src/debug/stl.js:238](../src/debug/stl.js) | `new Error("Invalid C++ element size")` |
| [src/debug/stl.js:242](../src/debug/stl.js) | `new Error("Invalid STL member path")` |
| [src/debug/stl.js:253](../src/debug/stl.js) | `new Error("STL element address overflow or null pointer")` |
| [src/debug/stl.js:259](../src/debug/stl.js) | `new Error("STL memory address overflow")` |
| [src/debug/stl.js:261](../src/debug/stl.js) | `new Error("STL memory budget exceeded (64 KiB)")` |
| [src/debug/stl.js:269](../src/debug/stl.js) | `new Error("STL memory is inaccessible or incomplete")` |
| [src/debug/stl.js:275](../src/debug/stl.js) | `new Error("STL memory is inaccessible or incomplete")` |
| [src/debug/stl.js:289](../src/debug/stl.js) | `new Error("Oversized raw STL field page")` |
| [src/debug/stl.js:297](../src/debug/stl.js) | `new Error("STL field depth limit exceeded")` |
| [src/debug/stl.js:300](../src/debug/stl.js) | `new Error("STL field probe budget exceeded")` |
| [src/debug/stl.js:310](../src/debug/stl.js) | `new Error(ˋUnsupported STL layout: missing ${name}ˋ)` |
| [src/debug/stl.js:390](../src/debug/stl.js) | `new Error("Unverified STL namespace or debug ABI")` |
| [src/debug/stl.js:398](../src/debug/stl.js) | `new Error("Only verified little-endian STL layouts are supported")` |
| [src/debug/stl.js:441](../src/debug/stl.js) | `new Error("Only the libstdc++ C++11 char string ABI is supported")` |
| [src/debug/stl.js:445](../src/debug/stl.js) | `new Error("Corrupt string data pointer")` |
| [src/debug/stl.js:470](../src/debug/stl.js) | `new Error("Corrupt vector<bool> bit offset")` |
| [src/debug/stl.js:477](../src/debug/stl.js) | `new Error("Corrupt vector element alignment")` |
| [src/debug/stl.js:482](../src/debug/stl.js) | `new Error("Corrupt vector storage alignment")` |
| [src/debug/stl.js:485](../src/debug/stl.js) | `new Error("Corrupt vector capacity")` |
| [src/debug/stl.js:490](../src/debug/stl.js) | `new Error("Unsupported array extent")` |
| [src/debug/stl.js:494](../src/debug/stl.js) | `new Error("Array layout mismatch")` |
| [src/debug/stl.js:508](../src/debug/stl.js) | `new Error("Unsupported tuple storage layout")` |
| [src/debug/stl.js:525](../src/debug/stl.js) | `new Error("Corrupt weak_ptr owner count")` |
| [src/debug/stl.js:539](../src/debug/stl.js) | `new Error("Unsupported unique_ptr storage layout")` |
| [src/debug/stl.js:544](../src/debug/stl.js) | `new Error("Fancy pointers are not supported")` |
| [src/debug/stl.js:555](../src/debug/stl.js) | `new Error("Corrupt optional discriminator")` |
| [src/debug/stl.js:565](../src/debug/stl.js) | `new Error("Unsupported variant index layout")` |
| [src/debug/stl.js:570](../src/debug/stl.js) | `new Error("Corrupt variant discriminator")` |
| [src/debug/stl.js:587](../src/debug/stl.js) | `new Error("Tuple layout probe budget exceeded")` |
| [src/debug/stl.js:635](../src/debug/stl.js) | `new Error("Cycle in forward_list")` |
| [src/debug/stl.js:645](../src/debug/stl.js) | `new Error("Corrupt linked container head")` |
| [src/debug/stl.js:680](../src/debug/stl.js) | `new Error("Corrupt deque iterator layout")` |
| [src/debug/stl.js:685](../src/debug/stl.js) | `new Error("Deque map does not match its iterators")` |
| [src/debug/stl.js:730](../src/debug/stl.js) | `new Error("Unknown unordered_map hash node policy")` |
| [src/debug/stl.js:740](../src/debug/stl.js) | `new Error("Corrupt map head")` |
| [src/debug/stl.js:746](../src/debug/stl.js) | `new Error("STL traversal budget exceeded; load preceding pages sequentially")` |
| [src/debug/stl.js:758](../src/debug/stl.js) | `new Error("Cycle in map tree")` |
| [src/debug/stl.js:770](../src/debug/stl.js) | `new Error("Cycle or invalid parent in map tree")` |
| [src/debug/stl.js:784](../src/debug/stl.js) | `new Error("Map iterator ended before declared length")` |
| [src/debug/stl.js:786](../src/debug/stl.js) | `new Error("Cycle in map node chain")` |
| [src/debug/stl.js:871](../src/debug/stl.js) | `new Error("Deque element exceeds its map")` |
| [src/debug/stl.js:906](../src/debug/stl.js) | `new Error("Unsupported map payload layout")` |
| [src/debug/symbolDirectory.js:37](../src/debug/symbolDirectory.js) | `new Error("Debug symbol directory limit exceeded")` |
| [src/debug/symbolDirectory.js:61](../src/debug/symbolDirectory.js) | `new Error("Debug symbol directory limit exceeded")` |
| [src/debug/symbolDirectory.js:71](../src/debug/symbolDirectory.js) | `new Error("Symbol image section budget exceeded")` |
| [src/debug/symbolDirectory.js:128](../src/debug/symbolDirectory.js) | `new Error("Symbol image identity requires the matching nm/objdump toolchain")` |
| [src/debug/symbolDirectory.js:130](../src/debug/symbolDirectory.js) | `new Error("nmPath must name an nm executable")` |
| [src/debug/symbolDirectory.js:135](../src/debug/symbolDirectory.js) | `new Error("Symbol image directory time budget exceeded")` |
| [src/debug/symbolDirectory.js:151](../src/debug/symbolDirectory.js) | `new Error("Debug symbol directory limit exceeded")` |
| [src/debug/symbolDirectory.js:176](../src/debug/symbolDirectory.js) | `new Error("Symbol image directory time budget exceeded")` |
| [src/debug/variables.js:16](../src/debug/variables.js) | `new Error("Variable paging requires a nonnegative start and count <= 1000")` |
| [src/debug/variables.js:18](../src/debug/variables.js) | `new Error("Invalid variable filter")` |
| [src/debug/variables.js:21](../src/debug/variables.js) | `new Error("Variable paging range overflow")` |
| [src/debug/variables.js:55](../src/debug/variables.js) | `new Error(output.trim().slice(0, 1024))` |
| [src/debug/variables.js:96](../src/debug/variables.js) | `new Error("Stale debug variable operation; refresh after stopping")` |
| [src/debug/variables.js:270](../src/debug/variables.js) | `new Error("Symbol image/source identity is ambiguous; no safe expression is available")` |
| [src/debug/variables.js:296](../src/debug/variables.js) | `new Error(ˋVariable unavailable: ${node.unavailable}ˋ)` |
| [src/debug/variables.js:334](../src/debug/variables.js) | `new Error("GDB returned an invalid or oversized variable page")` |
| [src/debug/variables.js:340](../src/debug/variables.js) | `new Error("GDB variable iterator made no progress")` |
| [src/debug/variables.js:390](../src/debug/variables.js) | `new Error("Invalid variable reference")` |
| [src/debug/variables.js:442](../src/debug/variables.js) | `new Error("Variable is read only")` |
| [src/debug/variables.js:444](../src/debug/variables.js) | `new Error("Variable is unavailable, ambiguous, or has not been expanded")` |
| [src/debug/variables.js:456](../src/debug/variables.js) | `new Error("Variable is read only")` |
| [src/debug/variables.js:460](../src/debug/variables.js) | `new Error("GDB variable is not editable")` |
| [src/debug/variables.js:550](../src/debug/variables.js) | `new Error("Register is unavailable or has not been expanded")` |
| [src/debug/variables.js:551](../src/debug/variables.js) | `new Error("Provide a register value")` |
| [src/debug/variables.js:558](../src/debug/variables.js) | `new Error("Register value must evaluate to an integer")` |
| [src/dwarf/binary.js:21](../src/dwarf/binary.js) | `new Error("Truncated or oversized LEB128 value")` |
| [src/dwarf/binary.js:33](../src/dwarf/binary.js) | `new Error("Truncated or oversized LEB128 value")` |
| [src/dwarf/binary.js:51](../src/dwarf/binary.js) | `new Error(ˋELF32 DWARF address size must be 4, got ${s}ˋ)` |
| [src/dwarf/binary.js:92](../src/dwarf/binary.js) | `new Error("Truncated zstd block header")` |
| [src/dwarf/binary.js:95](../src/dwarf/binary.js) | `new Error("Invalid zstd block type")` |
| [src/dwarf/binary.js:98](../src/dwarf/binary.js) | `new Error("Truncated zstd block")` |
| [src/dwarf/binary.js:101](../src/dwarf/binary.js) | `new Error("Truncated zstd checksum")` |
| [src/dwarf/binary.js:112](../src/dwarf/binary.js) | `new Error("Truncated zstd frame magic")` |
| [src/dwarf/binary.js:115](../src/dwarf/binary.js) | `new Error("Truncated zstd skippable header")` |
| [src/dwarf/binary.js:117](../src/dwarf/binary.js) | `new Error("Truncated zstd skippable frame")` |
| [src/dwarf/binary.js:121](../src/dwarf/binary.js) | `new Error("Invalid or truncated zstd frame header")` |
| [src/dwarf/binary.js:140](../src/dwarf/binary.js) | `new Error(ˋDWARF section is outside the ELF: ${name}ˋ)` |
| [src/dwarf/binary.js:147](../src/dwarf/binary.js) | `new Error(ˋCompressed DWARF section header is truncated: ${name}ˋ)` |
| [src/dwarf/binary.js:150](../src/dwarf/binary.js) | `new Error(ˋCompressed DWARF section is too large: ${name}ˋ)` |
| [src/dwarf/binary.js:157](../src/dwarf/binary.js) | `new Error(ˋUnsupported DWARF compression type ${compressionType}: ${name}ˋ)` |
| [src/dwarf/binary.js:159](../src/dwarf/binary.js) | `new Error(ˋCompressed DWARF section size mismatch: ${name}ˋ)` |
| [src/dwarf/binary.js:163](../src/dwarf/binary.js) | `new Error(ˋLegacy compressed DWARF section is truncated: ${name}ˋ)` |
| [src/dwarf/binary.js:166](../src/dwarf/binary.js) | `new Error(ˋCompressed DWARF section is too large: ${name}ˋ)` |
| [src/dwarf/binary.js:168](../src/dwarf/binary.js) | `new Error(ˋLegacy compressed DWARF section size mismatch: ${name}ˋ)` |
| [src/dwarf/binary.js:224](../src/dwarf/binary.js) | `new Error(ˋDWARF ${what} budget exceededˋ)` |
| [src/dwarf/files.js:10](../src/dwarf/files.js) | `new Error("Invalid split DWARF companion filename")` |
| [src/dwarf/files.js:22](../src/dwarf/files.js) | `new Error("Split DWARF companion path escapes the ELF directory")` |
| [src/dwarf/files.js:27](../src/dwarf/files.js) | `new Error("Split DWARF companion path escapes the ELF directory")` |
| [src/dwarf/files.js:29](../src/dwarf/files.js) | `new Error("Split DWARF companion exceeds its shared file budget")` |
| [src/dwarf/files.js:35](../src/dwarf/files.js) | `new Error("Split DWARF companion changed while reading")` |
| [src/dwarf/files.js:47](../src/dwarf/files.js) | `new Error("Matching split DWARF companion is missing: " + name)` |
| [src/dwarf/forms.js:9](../src/dwarf/forms.js) | `new Error("Truncated DWARF integer")` |
| [src/dwarf/forms.js:15](../src/dwarf/forms.js) | `new Error("DWARF integer exceeds 64 bits")` |
| [src/dwarf/forms.js:21](../src/dwarf/forms.js) | `new Error("DWARF integer exceeds 64 bits")` |
| [src/dwarf/forms.js:26](../src/dwarf/forms.js) | `new Error("DWARF offset exceeds the safe integer range")` |
| [src/dwarf/forms.js:32](../src/dwarf/forms.js) | `new Error("DWARF indirect form nesting exceeded")` |
| [src/dwarf/forms.js:36](../src/dwarf/forms.js) | `new Error("Invalid DWARF cursor")` |
| [src/dwarf/forms.js:38](../src/dwarf/forms.js) | `new Error("Truncated DWARF attribute")` |
| [src/dwarf/forms.js:78](../src/dwarf/forms.js) | `new Error("Unterminated DWARF string")` |
| [src/dwarf/forms.js:251](../src/dwarf/forms.js) | `new Error("unknown DWARF form 0x" + form.toString(16))` |
| [src/dwarf/parser.js:143](../src/dwarf/parser.js) | `new Error("Oversized DWARF64 unit")` |
| [src/dwarf/parser.js:163](../src/dwarf/parser.js) | `new Error("Unsupported DWARF version " + version)` |
| [src/dwarf/parser.js:167](../src/dwarf/parser.js) | `new Error("Oversized DWARF offset")` |
| [src/dwarf/parser.js:204](../src/dwarf/parser.js) | `new Error("Unsupported DWARF unit type " + unitType)` |
| [src/dwarf/parser.js:206](../src/dwarf/parser.js) | `new Error("Truncated DWARF unit")` |
| [src/dwarf/parser.js:222](../src/dwarf/parser.js) | `new Error("DWARF DIE budget exceeded")` |
| [src/dwarf/parser.js:233](../src/dwarf/parser.js) | `new Error("unknown abbrev code")` |
| [src/dwarf/parser.js:420](../src/dwarf/parser.js) | `new Error("Split DWARF companion count exceeds 32")` |
| [src/dwarf/runtimeTypes.js:33](../src/dwarf/runtimeTypes.js) | `new Error("Runtime type graph nesting exceeds 128")` |
| [src/dwarf/runtimeTypes.js:37](../src/dwarf/runtimeTypes.js) | `new Error("Runtime type graph exceeds 4096 types")` |
| [src/dwarf/types.js:69](../src/dwarf/types.js) | `new Error("DWARF enum member budget exceeded")` |
| [src/dwarf/types.js:490](../src/dwarf/types.js) | `new Error("DWARF array expansion budget exceeded")` |
| [src/dwarf/types.js:542](../src/dwarf/types.js) | `new Error("DWARF composite nesting budget exceeded")` |
| [src/dwarf/types.js:639](../src/dwarf/types.js) | `new Error("DWARF composite expansion budget exceeded")` |
| [src/elfFormat.js:8](../src/elfFormat.js) | `new Error("文件过小，不是有效的 ELF")` |
| [src/elfFormat.js:10](../src/elfFormat.js) | `new Error("不是有效的 ELF 文件（魔数不匹配）")` |
| [src/elfFormat.js:12](../src/elfFormat.js) | `new Error("仅支持 32 位 ELF（Cortex-M）")` |
| [src/elfFormat.js:13](../src/elfFormat.js) | `new Error("仅支持小端 ELF（Cortex-M）")` |
| [src/elfFormat.js:29](../src/elfFormat.js) | `new Error("缺少节头表，可能已被 strip（请用 Debug 构建）")` |
| [src/elfFormat.js:31](../src/elfFormat.js) | `new Error("ELF 节头表越界或条目大小无效")` |
| [src/elfSymbols.js:45](../src/elfSymbols.js) | `new Error("Variable name is required")` |
| [src/elfSymbols.js:52](../src/elfSymbols.js) | `new Error(ˋVariable name is ambiguous: ${requestedName}ˋ)` |
| [src/elfSymbols.js:57](../src/elfSymbols.js) | `new Error(ˋVariable not found in current ELF: ${requestedName}ˋ)` |
| [src/elfSymbols.js:61](../src/elfSymbols.js) | `new Error(ˋVariable requested more than once: ${symbol.name}ˋ)` |
| [src/elfSymbols.js:67](../src/elfSymbols.js) | `new Error(ˋUnsupported type for ${symbol.name}: ${type}ˋ)` |
| [src/elfSymbols.js:72](../src/elfSymbols.js) | `new Error(ˋVariable is not a supported scalar: ${symbol.name}ˋ)` |
| [src/elfSymbols.js:89](../src/elfSymbols.js) | `new Error(ˋUnsupported type: ${type}ˋ)` |
| [src/elfSymbols.js:91](../src/elfSymbols.js) | `new Error(message)` |
| [src/elfSymbols.js:260](../src/elfSymbols.js) | `new Error("未找到符号表（.symtab）：请使用 Debug 构建且不要 strip")` |
| [src/elfSymbols.js:262](../src/elfSymbols.js) | `new Error("符号字符串表（.strtab）缺失")` |
| [src/elfSymbols.js:265](../src/elfSymbols.js) | `new Error("ELF 符号表或字符串表越界")` |
| [src/elfSymbols.js:283](../src/elfSymbols.js) | `new Error("ELF 符号表条目大小无效")` |
| [src/elfWorker.js:50](../src/elfWorker.js) | `new Error("DWARF layout response budget exceeded")` |
| [src/elfWorker.js:67](../src/elfWorker.js) | `new Error("ELF exceeds the 64 MiB limit")` |
| [src/elfWorker.js:72](../src/elfWorker.js) | `new Error("ELF changed while it was being read")` |
| [src/extension.js:67](../src/extension.js) | `new Error("Debugging requires a trusted workspace")` |
| [src/faultInfo.js:110](../src/faultInfo.js) | `new Error(ˋ非法的 OpenOCD 配置名：${options.probe} / ${options.target}ˋ)` |
| [src/faultInfo.js:171](../src/faultInfo.js) | `new Error("读取故障寄存器超时（15s）：请检查接线、供电与探针占用情况")` |
| [src/faultInfo.js:180](../src/faultInfo.js) | `new Error(diagnostic.message)` |
| [src/flashAuthorization.js:33](../src/flashAuthorization.js) | `new Error(message)` |
| [src/liveWatch.js:114](../src/liveWatch.js) | `new Error("Runtime read range overflows the 32-bit target address space")` |
| [src/liveWatch.js:133](../src/liveWatch.js) | `new Error(ˋRuntime read plan exceeds the per-cycle budget (${maxBytes} bytes / ${maxCommands} commands)ˋ)` |
| [src/liveWatch.js:522](../src/liveWatch.js) | `new Error(message)` |
| [src/liveWatch.js:541](../src/liveWatch.js) | `new Error(ˋ非法的 OpenOCD 配置名：${this.options.probe} / ${this.options.target}ˋ)` |
| [src/liveWatch.js:547](../src/liveWatch.js) | `new Error("Managed debug OpenOCD requires a GDB port")` |
| [src/liveWatch.js:549](../src/liveWatch.js) | `new Error("GD32VF103 在 CPU 运行时不支持调试器内存访问，无法启用非侵入实时变量")` |
| [src/liveWatch.js:584](../src/liveWatch.js) | `new Error(ˋ找不到 OpenOCD：${this.options.executable}ˋ)` |
| [src/liveWatch.js:588](../src/liveWatch.js) | `new Error(spawnError.message)` |
| [src/liveWatch.js:594](../src/liveWatch.js) | `new Error(ˋ找不到 OpenOCD：${this.options.executable}ˋ)` |
| [src/liveWatch.js:598](../src/liveWatch.js) | `new Error(childError.message)` |
| [src/liveWatch.js:616](../src/liveWatch.js) | `new Error("Debugger disconnected; live sampling stopped")` |
| [src/liveWatch.js:673](../src/liveWatch.js) | `new Error(diagnostic.message)` |
| [src/liveWatch.js:695](../src/liveWatch.js) | `new Error("OpenOCD 服务在连接过程中已退出")` |
| [src/liveWatch.js:707](../src/liveWatch.js) | `new Error("OpenOCD 服务在连接过程中已退出")` |
| [src/liveWatch.js:735](../src/liveWatch.js) | `new Error("OpenOCD did not return the configured shared target names")` |
| [src/liveWatch.js:769](../src/liveWatch.js) | `new Error("OpenOCD service exited before Tcl was ready")` |
| [src/liveWatch.js:775](../src/liveWatch.js) | `new Error(diagnostic.message)` |
| [src/liveWatch.js:785](../src/liveWatch.js) | `new Error("已停止")` |
| [src/liveWatch.js:797](../src/liveWatch.js) | `new Error("已停止")` |
| [src/liveWatch.js:810](../src/liveWatch.js) | `new Error("已停止")` |
| [src/liveWatch.js:816](../src/liveWatch.js) | `new Error(diagnostic.message)` |
| [src/liveWatch.js:843](../src/liveWatch.js) | `new Error("OpenOCD 响应流异常：未收到分帧符")` |
| [src/liveWatch.js:850](../src/liveWatch.js) | `new Error("Tcl 连接已关闭")` |
| [src/liveWatch.js:901](../src/liveWatch.js) | `new Error(String(error \|\| "连接已断开"))` |
| [src/liveWatch.js:973](../src/liveWatch.js) | `new Error("socket 未连接")` |
| [src/liveWatch.js:977](../src/liveWatch.js) | `new Error("OpenOCD 响应超时，采样连接已重置")` |
| [src/liveWatch.js:983](../src/liveWatch.js) | `new Error("OpenOCD 响应超时，采样连接已重置")` |
| [src/liveWatch.js:1024](../src/liveWatch.js) | `new Error(response.slice(7).trim() \|\| ˋOpenOCD 命令失败：${cmd}ˋ)` |
| [src/liveWatch.js:1028](../src/liveWatch.js) | `new Error(ˋOpenOCD 返回了无法识别的 Tcl 响应：${response.slice(0, 200)}ˋ)` |
| [src/liveWatch.js:1047](../src/liveWatch.js) | `new Error(ˋOpenOCD 返回了非预期的 Tcl 响应：${rpcResponse.slice(0, 200)}ˋ)` |
| [src/liveWatch.js:1055](../src/liveWatch.js) | `new Error(ˋ无法读取 OpenOCD Tcl 响应：${error.message}ˋ)` |
| [src/liveWatch.js:1062](../src/liveWatch.js) | `new Error("OpenOCD 返回了无法识别的静默 Tcl 响应")` |
| [src/liveWatch.js:1068](../src/liveWatch.js) | `new Error(response.trim() \|\| ˋOpenOCD 命令失败：${cmd}ˋ)` |
| [src/liveWatch.js:1104](../src/liveWatch.js) | `new Error("Runtime read was cancelled by a target state change")` |
| [src/liveWatch.js:1109](../src/liveWatch.js) | `new Error(ˋRuntime read exceeded the ${MAX_DEBUG_CYCLE_MS} ms per-cycle budgetˋ)` |
| [src/liveWatch.js:1151](../src/liveWatch.js) | `new Error("Batch memory read response has an unexpected number of groups")` |
| [src/liveWatch.js:1278](../src/liveWatch.js) | `new Error("OpenOCD Tcl 服务未连接")` |
| [src/liveWatch.js:1282](../src/liveWatch.js) | `new Error("等待实时采样连接空闲超时")` |
| [src/liveWatch.js:1305](../src/liveWatch.js) | `new Error("Runtime writes are disabled for managed debug sessions")` |
| [src/liveWatch.js:1317](../src/liveWatch.js) | `new Error("写入内存失败：无法读取相邻字节以执行 32 位对齐写入")` |
| [src/liveWatch.js:1335](../src/liveWatch.js) | `new Error("写入内存失败：" + fallbackError.message)` |
| [src/liveWatch.js:1338](../src/liveWatch.js) | `new Error("写入内存失败：" + error.message)` |
| [src/liveWatch.js:1347](../src/liveWatch.js) | `new Error("等待实时采样连接空闲超时")` |
| [src/liveWatch.js:1364](../src/liveWatch.js) | `new Error("Runtime writes are disabled for managed debug sessions")` |
| [src/liveWatch.js:1369](../src/liveWatch.js) | `new Error("OpenOCD Tcl 服务未连接")` |
| [src/liveWatch.js:1372](../src/liveWatch.js) | `new Error("等待实时采样连接空闲超时")` |
| [src/liveWatch.js:1376](../src/liveWatch.js) | `new Error("OpenOCD Tcl 服务未连接")` |
| [src/liveWatch.js:1414](../src/liveWatch.js) | `new Error("Runtime writes are disabled for managed debug sessions")` |
| [src/liveWatch.js:1419](../src/liveWatch.js) | `new Error("OpenOCD Tcl 服务未连接")` |
| [src/liveWatch.js:1422](../src/liveWatch.js) | `new Error("等待实时采样连接空闲超时")` |
| [src/liveWatch.js:1512](../src/liveWatch.js) | `new Error("采样已停止")` |
| [src/mainViewProvider.js:264](../src/mainViewProvider.js) | `new Error("OpenOCD is required to verify that J-Link is ready")` |
| [src/mainViewProvider.js:476](../src/mainViewProvider.js) | `new Error(this._t("peripheral.configureSvdFirst"))` |
| [src/mainViewProvider.js:485](../src/mainViewProvider.js) | `new Error("Invalid peripheral target")` |
| [src/mainViewProvider.js:487](../src/mainViewProvider.js) | `new Error("Invalid peripheral value")` |
| [src/mainViewProvider.js:647](../src/mainViewProvider.js) | `new Error("Use an explicit F5 external attach configuration")` |
| [src/mainViewProvider.js:969](../src/mainViewProvider.js) | `new Error("Stop the active probe session before changing connection settings")` |
| [src/mainViewProvider.js:976](../src/mainViewProvider.js) | `new Error("J-Link USB driver change is still in progress")` |
| [src/mainViewProvider.js:996](../src/mainViewProvider.js) | `new Error("No active write session")` |
| [src/mainViewProvider.js:1084](../src/mainViewProvider.js) | `new Error("Open a Live Watch chart panel before exporting its history")` |
| [src/mainViewProvider.js:1098](../src/mainViewProvider.js) | `new Error("CSV export time range is invalid")` |
| [src/mainViewProvider.js:1103](../src/mainViewProvider.js) | `new Error("The selected chart has no sampled series")` |
| [src/mainViewProvider.js:1114](../src/mainViewProvider.js) | `new Error(ˋChart series not found: ${missing.join(", ")}ˋ)` |
| [src/mainViewProvider.js:1140](../src/mainViewProvider.js) | `new Error("No variables supplied")` |
| [src/mainViewProvider.js:1143](../src/mainViewProvider.js) | `new Error("destination must be sidebar, chart, or both")` |
| [src/mainViewProvider.js:1163](../src/mainViewProvider.js) | `new Error(ˋVariable not found in current ELF: ${rawName}ˋ)` |
| [src/mainViewProvider.js:1176](../src/mainViewProvider.js) | `new Error(ˋInvalid runtime member path: ${rawName}ˋ)` |
| [src/mainViewProvider.js:1181](../src/mainViewProvider.js) | `new Error(ˋComposite variable has no DWARF layout: ${rawName}ˋ)` |
| [src/mainViewProvider.js:1187](../src/mainViewProvider.js) | `new Error(ˋInvalid composite member path: ${rawName}ˋ)` |
| [src/mainViewProvider.js:1213](../src/mainViewProvider.js) | `new Error(ˋVariable is not a supported scalar: ${rawName}ˋ)` |
| [src/mainViewProvider.js:1251](../src/mainViewProvider.js) | `new Error("No variables supplied")` |
| [src/mainViewProvider.js:1271](../src/mainViewProvider.js) | `new Error(ˋVariable name is ambiguous: ${req.name}ˋ)` |
| [src/mainViewProvider.js:1276](../src/mainViewProvider.js) | `new Error(ˋVariable not found in current ELF: ${req.name}ˋ)` |
| [src/mainViewProvider.js:1289](../src/mainViewProvider.js) | `new Error(ˋInvalid runtime member path: ${req.name}ˋ)` |
| [src/mainViewProvider.js:1295](../src/mainViewProvider.js) | `new Error(ˋComposite variable has no DWARF layout: ${req.name}ˋ)` |
| [src/mainViewProvider.js:1305](../src/mainViewProvider.js) | `new Error(ˋInvalid composite member path: ${req.name}ˋ)` |
| [src/mainViewProvider.js:1322](../src/mainViewProvider.js) | `new Error(ˋ${req.name} is not a composite variable; member paths are not applicableˋ)` |
| [src/mainViewProvider.js:1429](../src/mainViewProvider.js) | `new Error("Agent sampling was cancelled by the user")` |
| [src/mainViewProvider.js:1470](../src/mainViewProvider.js) | `new Error("Runtime reads are restricted to writable allocated ELF RAM sections")` |
| [src/mainViewProvider.js:1611](../src/mainViewProvider.js) | `new Error("Unable to start managed OpenOCD")` |
| [src/mainViewProvider.js:1769](../src/mainViewProvider.js) | `new Error("Wait for the current debug control action before selecting a session")` |
| [src/mainViewProvider.js:1918](../src/mainViewProvider.js) | `new Error("Select the active core's ELF before reading or writing sidebar variables")` |
| [src/mainViewProvider.js:1929](../src/mainViewProvider.js) | `new Error("Timed out waiting for the managed OpenOCD runtime read to finish")` |
| [src/mainViewProvider.js:2029](../src/mainViewProvider.js) | `new Error("Pause the selected core before reading multicore memory")` |
| [src/mainViewProvider.js:2041](../src/mainViewProvider.js) | `new Error("Debug target state changed during the runtime read")` |
| [src/mainViewProvider.js:2054](../src/mainViewProvider.js) | `new Error("Another Agent variable read is in progress")` |
| [src/mainViewProvider.js:2063](../src/mainViewProvider.js) | `new Error("The debug probe is busy with another operation")` |
| [src/mainViewProvider.js:2080](../src/mainViewProvider.js) | `new Error(this._t("live.needConfig"))` |
| [src/mainViewProvider.js:2088](../src/mainViewProvider.js) | `new Error(this._t("live.notReady"))` |
| [src/mainViewProvider.js:2094](../src/mainViewProvider.js) | `new Error("Agent variable read was cancelled")` |
| [src/mainViewProvider.js:2123](../src/mainViewProvider.js) | `new Error("Agent variable read was cancelled")` |
| [src/mainViewProvider.js:2141](../src/mainViewProvider.js) | `new Error("Agent variable read was cancelled")` |
| [src/mainViewProvider.js:2187](../src/mainViewProvider.js) | `new Error("No variables supplied")` |
| [src/mainViewProvider.js:2208](../src/mainViewProvider.js) | `new Error("Variable name is required")` |
| [src/mainViewProvider.js:2216](../src/mainViewProvider.js) | `new Error(ˋWriting C++ runtime container or dynamic member is not supported: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2222](../src/mainViewProvider.js) | `new Error(ˋComposite variable has no DWARF layout: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2226](../src/mainViewProvider.js) | `new Error(ˋWriting a whole composite variable is not supported: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2232](../src/mainViewProvider.js) | `new Error(ˋWrite target must resolve to exactly one scalar member: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2236](../src/mainViewProvider.js) | `new Error(ˋBitfield writes are not supported: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2250](../src/mainViewProvider.js) | `new Error(ˋEnum write encoding is unavailable: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2257](../src/mainViewProvider.js) | `new Error(ˋWriting to const / read-only storage is not allowed: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2262](../src/mainViewProvider.js) | `new Error( ˋVariable type is not available from DWARF; refusing to guess a write encoding: ${req.name}ˋ )` |
| [src/mainViewProvider.js:2282](../src/mainViewProvider.js) | `new Error(ˋWriting C++ reference or member pointer storage is not supported: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2288](../src/mainViewProvider.js) | `new Error(ˋWriting to const / read-only variable is not allowed: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2294](../src/mainViewProvider.js) | `new Error(ˋVariable requested more than once: ${target.name}ˋ)` |
| [src/mainViewProvider.js:2299](../src/mainViewProvider.js) | `new Error(ˋBoolean variables accept only 0 or 1: ${req.name}ˋ)` |
| [src/mainViewProvider.js:2305](../src/mainViewProvider.js) | `new Error(ˋTarget address is outside writable RAM sections (.data/.bss): ${req.name}ˋ)` |
| [src/mainViewProvider.js:2329](../src/mainViewProvider.js) | `new Error("The active connection changed after write confirmation")` |
| [src/mainViewProvider.js:2360](../src/mainViewProvider.js) | `new Error( "Write verification failed while the target was halted: the value read back does not match (check RAM accessibility, MPU/cache configuration, and debug transport)" )` |
| [src/mainViewProvider.js:2419](../src/mainViewProvider.js) | `new Error(this._t("sb.writeNeedSampling"))` |
| [src/mainViewProvider.js:2449](../src/mainViewProvider.js) | `new Error(ˋUnsupported write permission action: ${action}ˋ)` |
| [src/mainViewProvider.js:2457](../src/mainViewProvider.js) | `new Error(this._t(key))` |
| [src/mainViewProvider.js:2647](../src/mainViewProvider.js) | `new Error("Live panel identity mismatch")` |
| [src/mainViewProvider.js:2870](../src/mainViewProvider.js) | `new Error("History changed before export")` |
| [src/mainViewProvider.js:2884](../src/mainViewProvider.js) | `new Error("Invalid chart CSV")` |
| [src/mainViewProvider.js:3097](../src/mainViewProvider.js) | `new Error("ELF changed while resolving layout")` |
| [src/mainViewProvider.js:3413](../src/mainViewProvider.js) | `new Error("Sampling frequency must be 0.1 to 200 Hz in 0.1 Hz steps")` |
| [src/mainViewProvider.js:3682](../src/mainViewProvider.js) | `new Error("Sampling accepts only an integer intervalMs from 5 to 10000 on start")` |
| [src/mainViewProvider.js:3833](../src/mainViewProvider.js) | `new Error(this._t("cpu.busy"))` |
| [src/mainViewProvider.js:3850](../src/mainViewProvider.js) | `new Error(this._t(blocked.i18nKey))` |
| [src/mainViewProvider.js:3854](../src/mainViewProvider.js) | `new Error("Debug startup is pending")` |
| [src/mainViewProvider.js:3877](../src/mainViewProvider.js) | `new Error(this._t("live.needConfig"))` |
| [src/mainViewProvider.js:3881](../src/mainViewProvider.js) | `new Error(this._t("live.notReady"))` |
| [src/mainViewProvider.js:3902](../src/mainViewProvider.js) | `new Error(this._t("live.starting"))` |
| [src/mainViewProvider.js:3942](../src/mainViewProvider.js) | `new Error(this._t("live.downloadRunning"))` |
| [src/mainViewProvider.js:3944](../src/mainViewProvider.js) | `new Error(this._t("live.chipReading"))` |
| [src/mainViewProvider.js:3946](../src/mainViewProvider.js) | `new Error(this._t("live.agentReading"))` |
| [src/mainViewProvider.js:3947](../src/mainViewProvider.js) | `new Error(this._t("live.starting"))` |
| [src/mainViewProvider.js:3953](../src/mainViewProvider.js) | `new Error(this._t("live.needConfig"))` |
| [src/mainViewProvider.js:4036](../src/mainViewProvider.js) | `new Error(this._t("live.notReady"))` |
| [src/mainViewProvider.js:4151](../src/mainViewProvider.js) | `new Error("OpenOCD exit has not been confirmed")` |
| [src/mainViewProvider.js:4171](../src/mainViewProvider.js) | `new Error("Debugging requires a trusted workspace")` |
| [src/mainViewProvider.js:4179](../src/mainViewProvider.js) | `new Error("Stop the active debug session before external attach")` |
| [src/mainViewProvider.js:4183](../src/mainViewProvider.js) | `new Error("Wait for the driver operation before external attach")` |
| [src/mainViewProvider.js:4197](../src/mainViewProvider.js) | `new Error("A valid ELF executable is required")` |
| [src/mainViewProvider.js:4220](../src/mainViewProvider.js) | `new Error("External GDB was disabled during startup")` |
| [src/mainViewProvider.js:4255](../src/mainViewProvider.js) | `new Error("The debug probe is owned by an EmberProbe managed debug session")` |
| [src/mainViewProvider.js:4573](../src/mainViewProvider.js) | `new Error(this._t("msg.commandNotRegistered", { cmd }))` |
| [src/mainViewProvider.js:4933](../src/mainViewProvider.js) | `new Error("Invalid J-Link USB driver choice")` |
| [src/mainViewProvider.js:4938](../src/mainViewProvider.js) | `new Error("Wait for the current probe operation to finish before changing drivers")` |
| [src/mainViewProvider.js:4952](../src/mainViewProvider.js) | `new Error("No uniquely selected supported J-Link is connected")` |
| [src/mainViewProvider.js:4969](../src/mainViewProvider.js) | `new Error("The selected J-Link driver could not be verified after switching")` |
| [src/memoryRegions.js:15](../src/memoryRegions.js) | `new Error(ˋUnknown constant: ${name}ˋ)` |
| [src/memoryRegions.js:24](../src/memoryRegions.js) | `new Error(ˋUnsupported expression: ${expression}ˋ)` |
| [src/memoryRegions.js:27](../src/memoryRegions.js) | `new Error("Expression is too complex")` |
| [src/memoryRegions.js:32](../src/memoryRegions.js) | `new Error(ˋExpected ${token} in ${expression}ˋ)` |
| [src/memoryRegions.js:58](../src/memoryRegions.js) | `new Error(ˋInvalid expression: ${expression}ˋ)` |
| [src/memoryRegions.js:65](../src/memoryRegions.js) | `new Error("Invalid shift")` |
| [src/memoryRegions.js:98](../src/memoryRegions.js) | `new Error("Expression overflow")` |
| [src/memoryRegions.js:104](../src/memoryRegions.js) | `new Error(ˋInvalid address or size: ${expression}ˋ)` |
| [src/memoryRegions.js:160](../src/memoryRegions.js) | `new Error(ˋAlias cycle: ${region}ˋ)` |
| [src/memoryRegions.js:167](../src/memoryRegions.js) | `new Error(ˋConstant cycle: ${name}ˋ)` |
| [src/memoryRegions.js:168](../src/memoryRegions.js) | `new Error(ˋUnknown constant: ${name}ˋ)` |
| [src/memoryRegions.js:182](../src/memoryRegions.js) | `new Error(ˋInvalid region range: ${name}ˋ)` |
| [src/openocdInstaller.js:90](../src/openocdInstaller.js) | `new Error(ˋRefusing unsafe archive entry: ${entryPath}ˋ)` |
| [src/openocdRunner.js:157](../src/openocdRunner.js) | `new Error("OpenOCD download is already running")` |
| [src/openocdRunner.js:166](../src/openocdRunner.js) | `new Error(ˋ非法的 OpenOCD 配置名：${options.probe} / ${options.target}ˋ)` |
| [src/openocdRunner.js:243](../src/openocdRunner.js) | `new Error(ˋOpenOCD 下载超时（${timeoutMs}ms）ˋ)` |
| [src/openocdRunner.js:285](../src/openocdRunner.js) | `new Error("OpenOCD output limit exceeded")` |
| [src/openocdRunner.js:354](../src/openocdRunner.js) | `new Error(lastError \|\| failureText)` |
| [src/peripheralWriteAuthorization.js:36](../src/peripheralWriteAuthorization.js) | `new Error(message)` |
| [src/probeCoordinator.js:23](../src/probeCoordinator.js) | `new Error(ˋUnknown probe operation: ${name}ˋ)` |
| [src/probeCoordinator.js:33](../src/probeCoordinator.js) | `new Error(ˋThe debug probe is busy with ${activeOperation}; cannot start ${requestedOperation}ˋ)` |
| [src/probeCoordinator.js:55](../src/probeCoordinator.js) | `new Error(ˋProbe lease for ${lease.operation} is no longer activeˋ)` |
| [src/samplingSession.js:57](../src/samplingSession.js) | `new Error(ˋSampling worker exited (${code})ˋ)` |
| [src/samplingSession.js:75](../src/samplingSession.js) | `new Error("Sampling session stopped")` |
| [src/samplingSession.js:76](../src/samplingSession.js) | `new Error("Sampling worker exited")` |
| [src/samplingWorker.js:118](../src/samplingWorker.js) | `new Error("Unknown sampling operation")` |
| [src/services/agentDebugInspection.js:7](../src/services/agentDebugInspection.js) | `new Error(message)` |
| [src/services/agentFlashService.js:30](../src/services/agentFlashService.js) | `new Error("Configure OpenOCD before flashing")` |
| [src/services/agentFlashService.js:33](../src/services/agentFlashService.js) | `new Error("Agent OpenOCD must match the configured executable")` |
| [src/services/agentFlashService.js:62](../src/services/agentFlashService.js) | `new Error("ELF changed before execution")` |
| [src/services/agentFlashService.js:80](../src/services/agentFlashService.js) | `new Error("The debug probe is busy")` |
| [src/services/agentFlashService.js:84](../src/services/agentFlashService.js) | `new Error("Flash confirmation is required")` |
| [src/services/agentFlashService.js:93](../src/services/agentFlashService.js) | `new Error(ˋIncompatible OpenOCD ${compatible.version}ˋ)` |
| [src/services/agentFlashService.js:95](../src/services/agentFlashService.js) | `new Error("The debug probe is busy")` |
| [src/services/agentFlashService.js:116](../src/services/agentFlashService.js) | `new Error("The debug probe is busy")` |
| [src/services/agentRoutes.js:55](../src/services/agentRoutes.js) | `new Error("includeStackUsage must be boolean")` |
| [src/services/agentService.js:64](../src/services/agentService.js) | `new Error(ˋUnsupported Agent Bridge method: ${method}ˋ)` |
| [src/services/chartHistoryService.js:40](../src/services/chartHistoryService.js) | `new Error(ˋHistory worker exited (${code})ˋ)` |
| [src/services/chartHistoryService.js:52](../src/services/chartHistoryService.js) | `new Error("History service disposed")` |
| [src/services/chartHistoryService.js:55](../src/services/chartHistoryService.js) | `new Error("History worker backlog reached its limit; sampling paused")` |
| [src/services/chartHistoryService.js:77](../src/services/chartHistoryService.js) | `new Error("History worker restarted")` |
| [src/services/chartHistoryService.js:83](../src/services/chartHistoryService.js) | `new Error("History service disposed")` |
| [src/services/chartHistoryStore.js:7](../src/services/chartHistoryStore.js) | `new Error(message)` |
| [src/services/chipInfoService.js:41](../src/services/chipInfoService.js) | `new Error(this.t(key))` |
| [src/services/chipInfoService.js:147](../src/services/chipInfoService.js) | `new Error(ˋUnsupported target action: ${action}ˋ)` |
| [src/services/chipInfoService.js:166](../src/services/chipInfoService.js) | `new Error(this.t("chip.notReady"))` |
| [src/services/chipInfoService.js:172](../src/services/chipInfoService.js) | `new Error(this.t("chip.busyDebug"))` |
| [src/services/configurationStore.js:40](../src/services/configurationStore.js) | `new Error(ˋConfiguration key cannot be modified through the Agent Bridge: ${key}ˋ)` |
| [src/services/configurationStore.js:84](../src/services/configurationStore.js) | `new Error("Open a workspace first")` |
| [src/services/configurationStore.js:88](../src/services/configurationStore.js) | `new Error(ˋFile does not exist: ${resolved}ˋ)` |
| [src/services/configurationStore.js:94](../src/services/configurationStore.js) | `new Error("Path must be inside the current workspace")` |
| [src/services/configurationStore.js:99](../src/services/configurationStore.js) | `new Error(ˋExpected a ${extension} fileˋ)` |
| [src/services/configurationStore.js:113](../src/services/configurationStore.js) | `new Error("Configuration values must be an object")` |
| [src/services/configurationStore.js:137](../src/services/configurationStore.js) | `new Error("Unsupported configuration key: " + key)` |
| [src/services/configurationStore.js:144](../src/services/configurationStore.js) | `new Error("Invalid " + key + " configuration name")` |
| [src/services/configurationStore.js:164](../src/services/configurationStore.js) | `new Error(key + " must be a value from " + min + " to " + max)` |
| [src/services/configurationStore.js:172](../src/services/configurationStore.js) | `new Error("Invalid OpenOCD path")` |
| [src/services/configurationStore.js:196](../src/services/configurationStore.js) | `new Error("Configuration update failed: " + cause.message)` |
| [src/services/cpuLoadModel.js:8](../src/services/cpuLoadModel.js) | `new Error(message)` |
| [src/services/cpuLoadModel.js:24](../src/services/cpuLoadModel.js) | `failure("CPU monitoring requires a little-endian ARM32 ELF")` |
| [src/services/cpuLoadModel.js:25](../src/services/cpuLoadModel.js) | `failure("FreeRTOS SMP is unsupported")` |
| [src/services/cpuLoadModel.js:42](../src/services/cpuLoadModel.js) | `failure(ˋ${name} is missing, ambiguous or outside verified RAMˋ)` |
| [src/services/cpuLoadModel.js:50](../src/services/cpuLoadModel.js) | `failure("Cyclic TCB type")` |
| [src/services/cpuLoadModel.js:55](../src/services/cpuLoadModel.js) | `failure("FreeRTOS kernel DWARF is unavailable")` |
| [src/services/cpuLoadModel.js:59](../src/services/cpuLoadModel.js) | `failure("Expected an ARM32 TCB pointer")` |
| [src/services/cpuLoadModel.js:62](../src/services/cpuLoadModel.js) | `failure("Unsupported TCB layout")` |
| [src/services/cpuLoadModel.js:67](../src/services/cpuLoadModel.js) | `failure(ˋMissing or ambiguous TCB.${name}ˋ)` |
| [src/services/cpuLoadModel.js:79](../src/services/cpuLoadModel.js) | `failure(ˋInvalid TCB.${name} boundsˋ)` |
| [src/services/cpuLoadModel.js:82](../src/services/cpuLoadModel.js) | `failure("Invalid task name layout")` |
| [src/services/cpuLoadModel.js:84](../src/services/cpuLoadModel.js) | `failure(ˋUnsupported TCB.${name} typeˋ)` |
| [src/services/cpuLoadSampler.js:26](../src/services/cpuLoadSampler.js) | `new Error("Invalid CPU memory response")` |
| [src/services/cpuLoadSampler.js:28](../src/services/cpuLoadSampler.js) | `new Error("Invalid CPU word")` |
| [src/services/cpuLoadSampler.js:93](../src/services/cpuLoadSampler.js) | `new Error("Invalid CPU read plan")` |
| [src/services/cpuLoadSampler.js:140](../src/services/cpuLoadSampler.js) | `new Error("Idle selection requires a fresh verified task")` |
| [src/services/cpuLoadSampler.js:162](../src/services/cpuLoadSampler.js) | `new Error("CPU read outside the dedicated whitelist")` |
| [src/services/cpuLoadSampler.js:163](../src/services/cpuLoadSampler.js) | `new Error("CPU target has not been validated")` |
| [src/services/cpuLoadSampler.js:169](../src/services/cpuLoadSampler.js) | `new Error("Stale CPU response")` |
| [src/services/cpuLoadSampler.js:177](../src/services/cpuLoadSampler.js) | `new Error("Incomplete CPU response")` |
| [src/services/cpuLoadSampler.js:188](../src/services/cpuLoadSampler.js) | `new Error("Invalid CPU target inventory")` |
| [src/services/cpuLoadSampler.js:193](../src/services/cpuLoadSampler.js) | `new Error("Invalid CPU target identity")` |
| [src/services/cpuLoadSampler.js:198](../src/services/cpuLoadSampler.js) | `new Error("CPU monitoring requires exactly one Cortex-M core; only mem_ap auxiliaries are supported")` |
| [src/services/cpuLoadSampler.js:199](../src/services/cpuLoadSampler.js) | `new Error("CPU monitoring requires a little-endian Cortex-M target")` |
| [src/services/cpuLoadSampler.js:200](../src/services/cpuLoadSampler.js) | `new Error("The selected OpenOCD target is not the Cortex-M core")` |
| [src/services/cpuLoadSampler.js:204](../src/services/cpuLoadSampler.js) | `new Error("Unsupported CPU: requires Cortex-M0/M0+/M3/M4/M7")` |
| [src/services/cpuLoadSampler.js:321](../src/services/cpuLoadSampler.js) | `new Error("Incomplete CPU bracket")` |
| [src/services/cpuLoadService.js:42](../src/services/cpuLoadService.js) | `new Error("CPU connection is still closing")` |
| [src/services/cpuLoadService.js:66](../src/services/cpuLoadService.js) | `new Error("ELF identity changed")` |
| [src/services/cpuLoadService.js:73](../src/services/cpuLoadService.js) | `new Error("CPU connection was cancelled")` |
| [src/services/cpuLoadService.js:76](../src/services/cpuLoadService.js) | `new Error("ELF identity changed")` |
| [src/services/cpuLoadService.js:83](../src/services/cpuLoadService.js) | `new Error("ELF identity changed")` |
| [src/services/cpuLoadService.js:130](../src/services/cpuLoadService.js) | `new Error("OpenOCD exit has not been confirmed")` |
| [src/services/cpuLoadService.js:157](../src/services/cpuLoadService.js) | `new Error("No active CPU measurement")` |
| [src/services/cubemxCandidate.js:39](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", "Mcu.IPNb must be a non-negative integer", { value: values["Mcu.IPNb"] })` |
| [src/services/cubemxCandidate.js:47](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", ˋMissing contiguous IP definition ${key} (IPNb=${n})ˋ, { key })` |
| [src/services/cubemxCandidate.js:49](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", ˋDuplicate IP definition in ${key}: ${val}ˋ, { key, ip: val })` |
| [src/services/cubemxCandidate.js:55](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", ˋOrphaned IP definition ${key} exceeds declared Mcu.IPNb=${n}ˋ, { key })` |
| [src/services/cubemxCandidate.js:67](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", ˋ${pinNbKey} must be a non-negative integerˋ, { value: rawValue })` |
| [src/services/cubemxCandidate.js:75](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", ˋMissing contiguous Pin definition ${key} (${pinNbKey}=${n})ˋ, { key })` |
| [src/services/cubemxCandidate.js:79](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", ˋDuplicate Pin definition in ${key}: ${val}ˋ, { key, pin: val })` |
| [src/services/cubemxCandidate.js:85](../src/services/cubemxCandidate.js) | `failure( "CUBEMX_IOC_INVALID", ˋOrphaned Pin definition ${key} exceeds declared ${pinNbKey}=${n}ˋ, { key } )` |
| [src/services/cubemxCandidate.js:99](../src/services/cubemxCandidate.js) | `new Error("Changes must be a JSON object")` |
| [src/services/cubemxCandidate.js:100](../src/services/cubemxCandidate.js) | `new Error("Deletions must be an array of string keys")` |
| [src/services/cubemxCandidate.js:105](../src/services/cubemxCandidate.js) | `new Error("Deletion keys must be non-empty strings without NUL")` |
| [src/services/cubemxCandidate.js:107](../src/services/cubemxCandidate.js) | `failure("INVALID_ARGUMENT", "Cannot both update and delete the same property: " + key)` |
| [src/services/cubemxCandidate.js:138](../src/services/cubemxCandidate.js) | `new Error("Keys must be nonempty and values must be strings without NUL")` |
| [src/services/cubemxCandidate.js:173](../src/services/cubemxCandidate.js) | `failure("PATH_OUTSIDE_WORKSPACE", "Select a workspace .ioc first")` |
| [src/services/cubemxCandidate.js:174](../src/services/cubemxCandidate.js) | `failure("INVALID_ARGUMENT", "Specify a new candidate output path")` |
| [src/services/cubemxCandidate.js:178](../src/services/cubemxCandidate.js) | `failure("PATH_OUTSIDE_WORKSPACE", "Candidate must be a separate workspace file")` |
| [src/services/cubemxCandidate.js:179](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", "Source exceeds 1 MiB")` |
| [src/services/cubemxCandidate.js:186](../src/services/cubemxCandidate.js) | `failure("INVALID_ARGUMENT", "Provide changes or changesFile, not both")` |
| [src/services/cubemxCandidate.js:189](../src/services/cubemxCandidate.js) | `failure("PATH_OUTSIDE_WORKSPACE", "Changes file must be inside workspace")` |
| [src/services/cubemxCandidate.js:191](../src/services/cubemxCandidate.js) | `failure("INVALID_ARGUMENT", "Changes file does not exist or is not a file")` |
| [src/services/cubemxCandidate.js:192](../src/services/cubemxCandidate.js) | `failure("INVALID_ARGUMENT", "Changes file exceeds 1 MiB")` |
| [src/services/cubemxCandidate.js:202](../src/services/cubemxCandidate.js) | `failure("INVALID_ARGUMENT", "Changes file must contain a JSON object")` |
| [src/services/cubemxCandidate.js:207](../src/services/cubemxCandidate.js) | `failure("CUBEMX_IOC_INVALID", "Candidate exceeds 1 MiB")` |
| [src/services/cubemxEnvironment.js:10](../src/services/cubemxEnvironment.js) | `new Error(message)` |
| [src/services/cubemxEnvironment.js:68](../src/services/cubemxEnvironment.js) | `failure("CUBEMX_PLATFORM_UNSUPPORTED", "CubeMX supports Windows and Linux")` |
| [src/services/cubemxEnvironment.js:70](../src/services/cubemxEnvironment.js) | `failure("CUBEMX_PATH_INVALID", "Select an absolute CubeMX executable path")` |
| [src/services/cubemxEnvironment.js:77](../src/services/cubemxEnvironment.js) | `failure("CUBEMX_PATH_INVALID", ˋExpected ${executableName(platform)}ˋ)` |
| [src/services/cubemxEnvironment.js:82](../src/services/cubemxEnvironment.js) | `new Error("Not a file")` |
| [src/services/cubemxEnvironment.js:85](../src/services/cubemxEnvironment.js) | `failure("CUBEMX_JAVA_MISSING", "CubeMX bundled Java is missing or not executable")` |
| [src/services/cubemxEnvironment.js:174](../src/services/cubemxEnvironment.js) | `failure("PATH_OUTSIDE_WORKSPACE", ".ioc must be inside a workspace")` |
| [src/services/cubemxEnvironment.js:176](../src/services/cubemxEnvironment.js) | `failure("INVALID_FILE_TYPE", "Select an existing .ioc file")` |
| [src/services/cubemxFirmware.js:31](../src/services/cubemxFirmware.js) | `new Error("Invalid CubeMX RepositoryPath")` |
| [src/services/cubemxFirmware.js:75](../src/services/cubemxFirmware.js) | `new Error(".ioc exceeds 1 MiB")` |
| [src/services/cubemxFirmware.js:79](../src/services/cubemxFirmware.js) | `new Error("Target and .ioc firmware family do not match")` |
| [src/services/cubemxFirmware.js:81](../src/services/cubemxFirmware.js) | `new Error("The .ioc uses a custom firmware location; check it in CubeMX")` |
| [src/services/cubemxFirmware.js:98](../src/services/cubemxFirmware.js) | `new Error("Invalid firmware package")` |
| [src/services/cubemxOperations.js:225](../src/services/cubemxOperations.js) | `failure("INVALID_ARGUMENT", "Operation not found: " + operationId)` |
| [src/services/cubemxProject.js:14](../src/services/cubemxProject.js) | `failure("CUBEMX_IOC_INVALID", ".ioc must be UTF-8 text under 1 MiB")` |
| [src/services/cubemxProject.js:21](../src/services/cubemxProject.js) | `failure("CUBEMX_IOC_INVALID", "Missing STM32 identity, CubeMX version or toolchain")` |
| [src/services/cubemxProject.js:23](../src/services/cubemxProject.js) | `failure("CUBEMX_USER_CODE_DISABLED", "Enable Keep User Code before generating")` |
| [src/services/cubemxProject.js:32](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Custom generation hooks and templates are unsupported", { key })` |
| [src/services/cubemxProject.js:36](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "External project paths are unsupported", { key })` |
| [src/services/cubemxProject.js:39](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "UnderRoot must be true or false")` |
| [src/services/cubemxProject.js:54](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Linked project files are unsupported", { file: name })` |
| [src/services/cubemxProject.js:59](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Unsupported project entry", { file: name })` |
| [src/services/cubemxProject.js:79](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Expected nested CubeMX output directory was not produced", { expectedRoot, candidateDirectory, condition: "missing_nested_output" })` |
| [src/services/cubemxProject.js:89](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Generated project directory conflicts with existing files", { expectedRoot, candidateDirectory, condition: "directory_conflict" })` |
| [src/services/cubemxProject.js:111](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Cannot identify nested CubeMX output safely", { expectedRoot, candidateDirectory, condition })` |
| [src/services/cubemxProject.js:121](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "CubeMX generated both root and nested outputs", { expectedRoot, candidateDirectory, condition: "dual_root_and_nested_output", file: target })` |
| [src/services/cubemxProject.js:145](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Generated project directory conflicts with existing files", { expectedRoot: projectName, candidateDirectory: projectName, condition: "directory_conflict" })` |
| [src/services/cubemxProject.js:161](../src/services/cubemxProject.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Invalid main output path", { expectedRoot: output, candidateDirectory: target, condition: "path_outside_root" })` |
| [src/services/cubemxProject.js:185](../src/services/cubemxProject.js) | `failure("CUBEMX_OUTPUT_MISSING", "CubeMX did not regenerate the expected main.c", { file, expectedRoot: output, candidateDirectory: output, condition: "main_not_regenerated" })` |
| [src/services/cubemxProject.js:271](../src/services/cubemxProject.js) | `failure("CUBEMX_USER_CODE_CHANGED", "Generation would remove or change user code", { file: name, block: match[1].trim() })` |
| [src/services/cubemxProject.js:282](../src/services/cubemxProject.js) | `failure("CUBEMX_PROJECT_CHANGED", "Project changed during generation; prepare again", { // Nothing has been written yet, so callers must not treat this as a rollback. condition: "pre_write_change" })` |
| [src/services/cubemxProject.js:292](../src/services/cubemxProject.js) | `failure("CUBEMX_PROJECT_CHANGED", "File changed during writeback", item)` |
| [src/services/cubemxProject.js:295](../src/services/cubemxProject.js) | `failure("CUBEMX_PROJECT_CHANGED", "Output directory changed during generation")` |
| [src/services/cubemxProject.js:304](../src/services/cubemxProject.js) | `failure("CUBEMX_PROJECT_CHANGED", "File changed during writeback", item)` |
| [src/services/cubemxProject.js:334](../src/services/cubemxProject.js) | `failure("CUBEMX_WRITE_FAILED", error.message, { backup, conflicts })` |
| [src/services/cubemxRunner.js:11](../src/services/cubemxRunner.js) | `failure("CUBEMX_PATH_INVALID", "Invalid CLI path")` |
| [src/services/cubemxRunner.js:25](../src/services/cubemxRunner.js) | `failure("CUBEMX_CANCELLED", "Generation cancelled")` |
| [src/services/cubemxRunner.js:62](../src/services/cubemxRunner.js) | `failure("CUBEMX_START_FAILED", error.message, { stage, logPath })` |
| [src/services/cubemxRunner.js:77](../src/services/cubemxRunner.js) | `failure(stopped, "CubeMX stopped", details)` |
| [src/services/cubemxRunner.js:79](../src/services/cubemxRunner.js) | `failure("CUBEMX_GENERATION_FAILED", "CubeMX did not complete cleanly", { code, ...details })` |
| [src/services/cubemxRunner.js:81](../src/services/cubemxRunner.js) | `failure("CUBEMX_OUTPUT_UNCONFIRMED", "CubeMX did not report successful generation", details)` |
| [src/services/cubemxService.js:86](../src/services/cubemxService.js) | `failure("CUBEMX_IOC_MISSING", "Select an .ioc file in MCU configuration")` |
| [src/services/cubemxService.js:91](../src/services/cubemxService.js) | `failure("PATH_OUTSIDE_WORKSPACE", "Select an .ioc inside this workspace")` |
| [src/services/cubemxService.js:98](../src/services/cubemxService.js) | `failure("CUBEMX_PLATFORM_UNSUPPORTED", "CubeMX generation supports Windows and Linux")` |
| [src/services/cubemxService.js:107](../src/services/cubemxService.js) | `failure( "CUBEMX_VERSION_MISMATCH", "Use the CubeMX version recorded in .ioc; automatic migration is disabled", { installed: tool.version, required: values["MxCube.Version"] } )` |
| [src/services/cubemxService.js:113](../src/services/cubemxService.js) | `failure("CUBEMX_LAYOUT_UNSUPPORTED", "Project name must match the .ioc filename", { expectedRoot: path.basename(ioc, path.extname(ioc)), candidateDirectory: root, condition: "project_name_mismatch" })` |
| [src/services/cubemxService.js:155](../src/services/cubemxService.js) | `failure("INVALID_ARGUMENT", "Provide content or candidatePath, not both")` |
| [src/services/cubemxService.js:158](../src/services/cubemxService.js) | `failure( "PATH_OUTSIDE_WORKSPACE", "Candidate must be a separate file inside the selected project workspace" )` |
| [src/services/cubemxService.js:163](../src/services/cubemxService.js) | `failure("CUBEMX_IOC_INVALID", "Candidate exceeds 1 MiB")` |
| [src/services/cubemxService.js:167](../src/services/cubemxService.js) | `failure("CUBEMX_PROJECT_CHANGED", "Candidate changed before execution")` |
| [src/services/cubemxService.js:179](../src/services/cubemxService.js) | `failure( "CUBEMX_LAYOUT_UNSUPPORTED", "Changing chip, toolchain, name or package version is unsupported", { key } )` |
| [src/services/cubemxService.js:262](../src/services/cubemxService.js) | `failure("INVALID_ARGUMENT", "Unknown permission action")` |
| [src/services/cubemxService.js:269](../src/services/cubemxService.js) | `new Error("Selected .ioc is not inside the workspace")` |
| [src/services/cubemxService.js:271](../src/services/cubemxService.js) | `failure("CUBEMX_IOC_INVALID", ".ioc must be UTF-8 text under 1 MiB")` |
| [src/services/cubemxService.js:273](../src/services/cubemxService.js) | `new Error("Chip identity is unavailable")` |
| [src/services/cubemxService.js:320](../src/services/cubemxService.js) | `failure("CUBEMX_REQUEST_CONFLICT", "Request ID already used with different parameters", { requestId: params.requestId })` |
| [src/services/cubemxService.js:333](../src/services/cubemxService.js) | `failure("CUBEMX_BUSY", "This project is already generating or checking")` |
| [src/services/cubemxService.js:374](../src/services/cubemxService.js) | `failure("INVALID_ARGUMENT", "Operation not found: " + params.operationId)` |
| [src/services/cubemxService.js:396](../src/services/cubemxService.js) | `failure("CUBEMX_REQUEST_CONFLICT", "Request ID already used with different parameters", { requestId: params.requestId })` |
| [src/services/cubemxService.js:413](../src/services/cubemxService.js) | `failure( fresh.error?.code \|\| "CUBEMX_GENERATION_FAILED", fresh.error?.message \|\| fresh.diagnostic \|\| "Previous generation attempt failed", fresh.error?.details )` |
| [src/services/cubemxService.js:422](../src/services/cubemxService.js) | `failure( existing.error?.code \|\| "CUBEMX_OPERATION_INTERRUPTED", "Previous operation was interrupted by an extension restart; query its record with cubemx.status and review recovery material before retrying", existing.error?.details )` |
| [src/services/cubemxService.js:429](../src/services/cubemxService.js) | `failure( existing.error?.code \|\| "CUBEMX_GENERATION_FAILED", existing.error?.message \|\| existing.diagnostic \|\| "Previous generation attempt failed", existing.error?.details )` |
| [src/services/cubemxService.js:435](../src/services/cubemxService.js) | `failure("CUBEMX_BUSY", ˋOperation ${existing.operationId} is currently ${existing.status}ˋ)` |
| [src/services/cubemxService.js:439](../src/services/cubemxService.js) | `failure("CUBEMX_BUSY", "This project is already generating or checking")` |
| [src/services/cubemxService.js:483](../src/services/cubemxService.js) | `failure("CUBEMX_PROJECT_CHANGED", ".ioc changed after confirmation")` |
| [src/services/cubemxService.js:496](../src/services/cubemxService.js) | `failure("CUBEMX_CANCELLED", "Generation cancelled")` |
| [src/services/cubemxService.js:499](../src/services/cubemxService.js) | `failure("CUBEMX_TIMEOUT", "Generation exceeded five minutes")` |
| [src/services/cubemxService.js:530](../src/services/cubemxService.js) | `failure( "CUBEMX_BASELINE_DRIFT", "Existing files cannot be reproduced; review hand edits before generating", { changes: drift, stage } )` |
| [src/services/cubemxService.js:554](../src/services/cubemxService.js) | `failure("CUBEMX_CANCELLED", "Generation cancelled")` |
| [src/services/cubemxService.js:557](../src/services/cubemxService.js) | `failure("CUBEMX_PROJECT_CHANGED", "Configuration changed during generation")` |
| [src/services/cubemxService.js:610](../src/services/cubemxService.js) | `failure("CUBEMX_WRITE_FAILED", ˋReadback verification failed for ${fileName}ˋ, { file: fileName })` |
| [src/services/cubemxService.js:706](../src/services/cubemxService.js) | `failure( "CUBEMX_RECORD_SAVE_FAILED", "Source files committed, but operation record could not be saved", { committed: true, sourceProjectStatus: "committed", backup, stage } )` |
| [src/services/cubemxService.js:839](../src/services/cubemxService.js) | `failure("CUBEMX_BUSY", "This project is already generating or checking")` |
| [src/services/cubemxService.js:870](../src/services/cubemxService.js) | `failure("INVALID_ARGUMENT", "Unknown check mode: " + mode)` |
| [src/services/debugConfiguration.js:27](../src/services/debugConfiguration.js) | `new Error(ˋUnsupported EmberProbe server: ${servertype}ˋ)` |
| [src/services/debugConfiguration.js:34](../src/services/debugConfiguration.js) | `new Error("serverpath must name an OpenOCD executable")` |
| [src/services/debugConfiguration.js:46](../src/services/debugConfiguration.js) | `new Error("serverGroup requires an identifier and an explicit multi-target processor count")` |
| [src/services/debugConfiguration.js:60](../src/services/debugConfiguration.js) | `new Error("Open a workspace folder before debugging")` |
| [src/services/debugConfiguration.js:61](../src/services/debugConfiguration.js) | `new Error("Use launch or attach for EmberProbe")` |
| [src/services/debugConfiguration.js:73](../src/services/debugConfiguration.js) | `new Error("Debug executable must be an ELF file")` |
| [src/services/debugConfiguration.js:77](../src/services/debugConfiguration.js) | `new Error("Debug cwd must be a directory")` |
| [src/services/debugConfiguration.js:83](../src/services/debugConfiguration.js) | `new Error("runToEntryPoint must be a string")` |
| [src/services/debugConfiguration.js:93](../src/services/debugConfiguration.js) | `new Error("sourceFileMap must map source prefixes to local paths")` |
| [src/services/debugControlService.js:47](../src/services/debugControlService.js) | `new Error(message)` |
| [src/services/debugImages.js:24](../src/services/debugImages.js) | `new Error("Image addresses must be integer or hexadecimal literals")` |
| [src/services/debugImages.js:28](../src/services/debugImages.js) | `new Error("Image address is outside ARM32 range")` |
| [src/services/debugImages.js:33](../src/services/debugImages.js) | `new Error("Provide a valid image file path")` |
| [src/services/debugImages.js:35](../src/services/debugImages.js) | `new Error(ˋImage is not a file: ${file}ˋ)` |
| [src/services/debugImages.js:42](../src/services/debugImages.js) | `new Error("Load image relocation exceeds the ARM32 address range")` |
| [src/services/debugImages.js:51](../src/services/debugImages.js) | `new Error("Truncated ELF load image")` |
| [src/services/debugImages.js:53](../src/services/debugImages.js) | `new Error("ELF load image must target ARM")` |
| [src/services/debugImages.js:55](../src/services/debugImages.js) | `new Error("Invalid ELF load segment table")` |
| [src/services/debugImages.js:59](../src/services/debugImages.js) | `new Error("Truncated ELF load segment")` |
| [src/services/debugImages.js:62](../src/services/debugImages.js) | `new Error("ELF load segment exceeds the file")` |
| [src/services/debugImages.js:70](../src/services/debugImages.js) | `new Error("HEX validation file budget exceeded (64 MiB)")` |
| [src/services/debugImages.js:77](../src/services/debugImages.js) | `new Error("Invalid Intel HEX record")` |
| [src/services/debugImages.js:79](../src/services/debugImages.js) | `new Error("Truncated Intel HEX record")` |
| [src/services/debugImages.js:84](../src/services/debugImages.js) | `new Error("Invalid Intel HEX length or checksum")` |
| [src/services/debugImages.js:92](../src/services/debugImages.js) | `new Error("Unsupported Intel HEX record type or length")` |
| [src/services/debugImages.js:94](../src/services/debugImages.js) | `new Error("Intel HEX end-of-file record is missing")` |
| [src/services/debugImages.js:112](../src/services/debugImages.js) | `new Error(ˋ${key} must contain at most 64 single-line GDB commandsˋ)` |
| [src/services/debugImages.js:118](../src/services/debugImages.js) | `new Error(ˋ${key} must contain at most 32 imagesˋ)` |
| [src/services/debugImages.js:121](../src/services/debugImages.js) | `new Error(ˋInvalid ${key} entryˋ)` |
| [src/services/debugImages.js:127](../src/services/debugImages.js) | `new Error(ˋUnknown ${key} image propertyˋ)` |
| [src/services/debugImages.js:134](../src/services/debugImages.js) | `new Error("Image sections must be an array with at most 128 entries")` |
| [src/services/debugImages.js:143](../src/services/debugImages.js) | `new Error("Invalid or duplicate image section name")` |
| [src/services/debugImages.js:151](../src/services/debugImages.js) | `new Error("Load images must be ELF, HEX or BIN")` |
| [src/services/debugImages.js:154](../src/services/debugImages.js) | `new Error("BIN load images require an explicit address")` |
| [src/services/debugImages.js:156](../src/services/debugImages.js) | `new Error("Use address, not offset, for BIN images")` |
| [src/services/debugImages.js:158](../src/services/debugImages.js) | `new Error("Use offset for ELF/HEX; their base addresses come from the file")` |
| [src/services/debugImages.js:160](../src/services/debugImages.js) | `new Error("BIN load image exceeds the ARM32 address range")` |
| [src/services/debugImages.js:168](../src/services/debugImages.js) | `new Error("Each symbol image must have a distinct file identity")` |
| [src/services/debugImages.js:190](../src/services/debugImages.js) | `new Error(ˋ${key} failed (${command.slice(0, 100)}): ${error.message}ˋ)` |
| [src/services/debugImages.js:228](../src/services/debugImages.js) | `new Error("FreeRTOS primary symbol image is missing an unambiguous pxCurrentTCB")` |
| [src/services/debugImages.js:232](../src/services/debugImages.js) | `new Error("GDB RTOS symbol lookup does not select the primary image")` |
| [src/services/debugServerController.js:11](../src/services/debugServerController.js) | `new Error("Debug port allocation requires 1..33 ports")` |
| [src/services/debugServerController.js:27](../src/services/debugServerController.js) | `new Error("Unable to allocate distinct debug ports")` |
| [src/services/debugServerController.js:37](../src/services/debugServerController.js) | `new Error("OpenOCD controller cannot manage an external GDB server")` |
| [src/services/debugServerController.js:62](../src/services/debugServerController.js) | `new Error("Debug controller has already been started or stopped")` |
| [src/services/debugServerController.js:70](../src/services/debugServerController.js) | `new Error("OpenOCD Tcl and GDB ports must be distinct valid ports")` |
| [src/services/debugServerController.js:74](../src/services/debugServerController.js) | `new Error("Selected GDB port does not match targetProcessor")` |
| [src/services/debugServerController.js:92](../src/services/debugServerController.js) | `new Error("Debug controller stopped during startup")` |
| [src/services/debugServerController.js:121](../src/services/debugServerController.js) | `new Error("Multicore runtime sampling requires explicit target routing")` |
| [src/services/debugServerController.js:131](../src/services/debugServerController.js) | `new Error("Multicore runtime sampling requires explicit target routing")` |
| [src/services/debugServerController.js:141](../src/services/debugServerController.js) | `new Error("CPU monitoring requires a ready single-core managed OpenOCD session")` |
| [src/services/debugServerController.js:162](../src/services/debugServerController.js) | `new Error("Multicore runtime reads require explicit target routing")` |
| [src/services/debugServerController.js:166](../src/services/debugServerController.js) | `new Error("Debug controller is not ready")` |
| [src/services/debugServerController.js:176](../src/services/debugServerController.js) | `new Error("OpenOCD process exit could not be confirmed")` |
| [src/services/debugSessionBridge.js:142](../src/services/debugSessionBridge.js) | `new Error("Wait for the current debug operation before selecting another session")` |
| [src/services/debugSessionBridge.js:152](../src/services/debugSessionBridge.js) | `new Error("Select a sessionId or a serverGroup with an unambiguous core")` |
| [src/services/debugSessionBridge.js:162](../src/services/debugSessionBridge.js) | `new Error("The debugger selection does not identify one session in this workspace")` |
| [src/services/debugSessionBridge.js:173](../src/services/debugSessionBridge.js) | `new Error("More than one debugger session matches this workspace")` |
| [src/services/debugSessionBridge.js:177](../src/services/debugSessionBridge.js) | `new Error("No debugger session is active for this workspace")` |
| [src/services/debugSessionBridge.js:186](../src/services/debugSessionBridge.js) | `new Error("The debugger target must be paused")` |
| [src/services/debugSessionBridge.js:188](../src/services/debugSessionBridge.js) | `new Error("The debugger execution control is in progress")` |
| [src/services/debugSessionBridge.js:193](../src/services/debugSessionBridge.js) | `new Error("The debugger does not support DAP readMemory")` |
| [src/services/debugSessionBridge.js:197](../src/services/debugSessionBridge.js) | `new Error("The debugger does not support DAP writeMemory")` |
| [src/services/debugSessionBridge.js:513](../src/services/debugSessionBridge.js) | `new Error("Debug state wait was cancelled")` |
| [src/services/debugSessionBridge.js:519](../src/services/debugSessionBridge.js) | `new Error("Timed out waiting for debugger state change")` |
| [src/services/debugSessionBridge.js:601](../src/services/debugSessionBridge.js) | `new Error("Invalid DAP memory read range")` |
| [src/services/debugSessionBridge.js:615](../src/services/debugSessionBridge.js) | `new Error("DAP readMemory returned invalid or incomplete data")` |
| [src/services/debugSessionBridge.js:617](../src/services/debugSessionBridge.js) | `new Error("DAP readMemory returned a partial block")` |
| [src/services/debugSessionBridge.js:626](../src/services/debugSessionBridge.js) | `new Error("Target changed during memory read")` |
| [src/services/debugSessionBridge.js:633](../src/services/debugSessionBridge.js) | `new Error("Another debug operation is in progress")` |
| [src/services/debugSessionBridge.js:642](../src/services/debugSessionBridge.js) | `new Error("Invalid DAP memory write range")` |
| [src/services/debugSessionBridge.js:654](../src/services/debugSessionBridge.js) | `new Error("The debugger changed during memory write")` |
| [src/services/debugSessionBridge.js:658](../src/services/debugSessionBridge.js) | `new Error("DAP performed a partial peripheral register write")` |
| [src/services/debugSessionBridge.js:689](../src/services/debugSessionBridge.js) | `new Error(ˋRTOS task ${requestedThreadId} no longer existsˋ)` |
| [src/services/debugSessionBridge.js:693](../src/services/debugSessionBridge.js) | `new Error("The debugger returned no thread for execution control")` |
| [src/services/debugSessionBridge.js:712](../src/services/debugSessionBridge.js) | `new Error("Another debug control action is still in progress")` |
| [src/services/debugSessionBridge.js:730](../src/services/debugSessionBridge.js) | `new Error("The selected debugger changed during thread discovery")` |
| [src/services/debugSessionBridge.js:743](../src/services/debugSessionBridge.js) | `new Error(ˋUnsupported debug control action: ${action}ˋ)` |
| [src/services/debugSessionBridge.js:747](../src/services/debugSessionBridge.js) | `new Error("The debugger does not advertise restart support")` |
| [src/services/debugSessionBridge.js:752](../src/services/debugSessionBridge.js) | `new Error(ˋ${action} requires a paused targetˋ)` |
| [src/services/debugSessionBridge.js:754](../src/services/debugSessionBridge.js) | `new Error(ˋ${action} requires a running targetˋ)` |
| [src/services/debugSessionBridge.js:782](../src/services/debugSessionBridge.js) | `new Error("The debugger rejected the control request")` |
| [src/services/debugSessionBridge.js:786](../src/services/debugSessionBridge.js) | `new Error("The debugger state wait failed")` |
| [src/services/debugSessionBridge.js:792](../src/services/debugSessionBridge.js) | `new Error("Multiple debugger sessions match this workspace")` |
| [src/services/debugSessionBridge.js:797](../src/services/debugSessionBridge.js) | `new Error("The debugger session ended during execution control")` |
| [src/services/debugSessionBridge.js:805](../src/services/debugSessionBridge.js) | `new Error("No unique debugger session is available")` |
| [src/services/debugSessionBridge.js:806](../src/services/debugSessionBridge.js) | `new Error("The debugger does not support DAP readMemory")` |
| [src/services/debugSessionBridge.js:809](../src/services/debugSessionBridge.js) | `new Error("Target changed before the paused read")` |
| [src/services/debugSessionBridge.js:818](../src/services/debugSessionBridge.js) | `new Error("DAP memory read was cancelled by a target state change")` |
| [src/services/debugSessionBridge.js:851](../src/services/debugSessionBridge.js) | `new Error("DAP memory read was cancelled by a target state change")` |
| [src/services/debugSessionBridge.js:856](../src/services/debugSessionBridge.js) | `new Error("DAP memory read was cancelled by a target state change")` |
| [src/services/debugSessionBridge.js:862](../src/services/debugSessionBridge.js) | `new Error(ˋDAP partially read ${item.name}ˋ)` |
| [src/services/debugSessionBridge.js:875](../src/services/debugSessionBridge.js) | `new Error("Target state changed during paused DAP memory read")` |
| [src/services/debugSessionBridge.js:890](../src/services/debugSessionBridge.js) | `new Error("Target state changed during paused DAP memory read")` |
| [src/services/debugSessionBridge.js:903](../src/services/debugSessionBridge.js) | `new Error("Another debug operation is in progress")` |
| [src/services/debugSessionBridge.js:906](../src/services/debugSessionBridge.js) | `new Error("The debugger target must be paused and support DAP writeMemory")` |
| [src/services/debugSessionBridge.js:911](../src/services/debugSessionBridge.js) | `new Error("A DAP memory read is still in progress; write was not started")` |
| [src/services/debugSessionBridge.js:913](../src/services/debugSessionBridge.js) | `new Error("Target continued before the DAP write could start")` |
| [src/services/debugSessionBridge.js:937](../src/services/debugSessionBridge.js) | `new Error("Target continued while a DAP write was in progress")` |
| [src/services/debugSessionBridge.js:946](../src/services/debugSessionBridge.js) | `new Error("Target state changed before the DAP write could start")` |
| [src/services/debugSessionBridge.js:948](../src/services/debugSessionBridge.js) | `new Error(ˋDAP could not read adjacent bytes before writing ${item.name}ˋ)` |
| [src/services/debugSessionBridge.js:959](../src/services/debugSessionBridge.js) | `new Error(ˋDAP partially wrote ${item.name}ˋ)` |
| [src/services/debugSessionBridge.js:963](../src/services/debugSessionBridge.js) | `new Error("Target continued before DAP write verification")` |
| [src/services/debugSessionBridge.js:983](../src/services/debugSessionBridge.js) | `new Error("Debug session bridge was disposed")` |
| [src/services/elfService.js:43](../src/services/elfService.js) | `new Error("ELF changed")` |
| [src/services/elfService.js:47](../src/services/elfService.js) | `new Error("ELF changed")` |
| [src/services/elfService.js:48](../src/services/elfService.js) | `new Error("ELF changed")` |
| [src/services/elfService.js:59](../src/services/elfService.js) | `new Error(this.t("live.elfFirst"))` |
| [src/services/elfService.js:171](../src/services/elfService.js) | `new Error(this.t("live.elfTooLarge", { path: elfPath, limit: 64 }))` |
| [src/services/elfService.js:225](../src/services/elfService.js) | `new Error(error.message \|\| String(error))` |
| [src/services/elfService.js:321](../src/services/elfService.js) | `new Error(message.error.message)` |
| [src/services/elfService.js:332](../src/services/elfService.js) | `new Error(ˋELF worker exited (${code})ˋ)` |
| [src/services/elfService.js:341](../src/services/elfService.js) | `new Error("DWARF type information is unavailable")` |
| [src/services/elfService.js:352](../src/services/elfService.js) | `new Error(previousError.message)` |
| [src/services/elfService.js:358](../src/services/elfService.js) | `new Error("ELF changed")` |
| [src/services/elfService.js:378](../src/services/elfService.js) | `new Error("ELF changed during CPU metadata resolution")` |
| [src/services/elfService.js:396](../src/services/elfService.js) | `new Error("ELF changed; waiting for refreshed symbols")` |
| [src/services/elfService.js:399](../src/services/elfService.js) | `new Error("ELF is still loading")` |
| [src/services/elfService.js:403](../src/services/elfService.js) | `new Error(this.t("live.elfFirst"))` |
| [src/services/elfService.js:415](../src/services/elfService.js) | `new Error(this.t("live.elfTooLarge", { path: elfPath, limit: MAX_ELF_BYTES / (1024 * 1024) }))` |
| [src/services/elfService.js:432](../src/services/elfService.js) | `new Error("ELF changed while it was being read; retry after the build finishes")` |
| [src/services/elfService.js:437](../src/services/elfService.js) | `new Error(this.t("live.elfReadFail", { path: elfPath }))` |
| [src/services/errorEnvelope.js:49](../src/services/errorEnvelope.js) | `new Error(value?.message \|\| "Unknown error")` |
| [src/services/externalDebugService.js:9](../src/services/externalDebugService.js) | `new Error(message)` |
| [src/services/freeRtosSnapshot.js:10](../src/services/freeRtosSnapshot.js) | `new Error("Invalid ARM32 RTOS value")` |
| [src/services/freeRtosSnapshot.js:31](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS requires a primary symbol image")` |
| [src/services/freeRtosSnapshot.js:35](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS SMP snapshots are not supported")` |
| [src/services/freeRtosSnapshot.js:37](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS pxCurrentTCB is missing or ambiguous in the primary image")` |
| [src/services/freeRtosSnapshot.js:43](../src/services/freeRtosSnapshot.js) | `new Error(ˋFreeRTOS ${name} is missing or ambiguousˋ)` |
| [src/services/freeRtosSnapshot.js:54](../src/services/freeRtosSnapshot.js) | `new Error("GDB RTOS symbol lookup does not select the primary image")` |
| [src/services/freeRtosSnapshot.js:64](../src/services/freeRtosSnapshot.js) | `new Error( "FreeRTOS snapshots currently require a little-endian single-core Cortex-M ARM32 target" )` |
| [src/services/freeRtosSnapshot.js:138](../src/services/freeRtosSnapshot.js) | `new Error(ˋUnsupported ${type.name}.${field} widthˋ)` |
| [src/services/freeRtosSnapshot.js:139](../src/services/freeRtosSnapshot.js) | `new Error("Unsupported FreeRTOS task name capacity")` |
| [src/services/freeRtosSnapshot.js:150](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS task budget exceeded")` |
| [src/services/freeRtosSnapshot.js:203](../src/services/freeRtosSnapshot.js) | `new Error("Invalid FreeRTOS list length")` |
| [src/services/freeRtosSnapshot.js:208](../src/services/freeRtosSnapshot.js) | `new Error("Corrupt FreeRTOS list cycle or length")` |
| [src/services/freeRtosSnapshot.js:209](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS list node budget exceeded")` |
| [src/services/freeRtosSnapshot.js:215](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS list ended before its declared length")` |
| [src/services/freeRtosSnapshot.js:235](../src/services/freeRtosSnapshot.js) | `new Error("Unsupported FreeRTOS ready priority count")` |
| [src/services/freeRtosSnapshot.js:268](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS snapshot time budget exceeded")` |
| [src/services/freeRtosSnapshot.js:282](../src/services/freeRtosSnapshot.js) | `new Error(ˋUnsupported ${name} sizeˋ)` |
| [src/services/freeRtosSnapshot.js:294](../src/services/freeRtosSnapshot.js) | `new Error(ˋInvalid ${layout.name}.${field} layoutˋ)` |
| [src/services/freeRtosSnapshot.js:302](../src/services/freeRtosSnapshot.js) | `new Error(ˋUnsupported optional field width: ${size}ˋ)` |
| [src/services/freeRtosSnapshot.js:315](../src/services/freeRtosSnapshot.js) | `new Error(ˋUnsupported ${layout.name}.${name} widthˋ)` |
| [src/services/freeRtosSnapshot.js:321](../src/services/freeRtosSnapshot.js) | `new Error("Invalid FreeRTOS memory address")` |
| [src/services/freeRtosSnapshot.js:328](../src/services/freeRtosSnapshot.js) | `new Error("FreeRTOS memory budget exceeded")` |
| [src/services/freeRtosSnapshot.js:339](../src/services/freeRtosSnapshot.js) | `new Error("Incomplete FreeRTOS memory read")` |
| [src/services/javaProperties.js:26](../src/services/javaProperties.js) | `failure("CUBEMX_IOC_INVALID", "Malformed Unicode escape", { line, content: lines[line - 1] })` |
| [src/services/javaProperties.js:56](../src/services/javaProperties.js) | `failure("CUBEMX_IOC_INVALID", "Empty or duplicate .ioc property", { line, content: lines[line - 1], key })` |
| [src/services/jlinkProbeReady.js:20](../src/services/jlinkProbeReady.js) | `new Error( String(stderr \|\| stdout \|\| error.message) .trim() .slice(-500) )` |
| [src/services/jlinkProbeReady.js:36](../src/services/jlinkProbeReady.js) | `new Error("OpenOCD scripts directory is unavailable")` |
| [src/services/jlinkProbeReady.js:73](../src/services/jlinkProbeReady.js) | `new Error(ˋWinUSB is bound, but OpenOCD cannot open the J-Link yet: ${lastError.message}ˋ)` |
| [src/services/memoryAnalysisService.js:29](../src/services/memoryAnalysisService.js) | `new Error("Invalid memory layout path")` |
| [src/services/memoryAnalysisService.js:35](../src/services/memoryAnalysisService.js) | `new Error(ˋExpected a ${extension} fileˋ)` |
| [src/services/memoryAnalysisService.js:38](../src/services/memoryAnalysisService.js) | `new Error("Memory layout must be inside the workspace")` |
| [src/services/memoryAnalysisService.js:54](../src/services/memoryAnalysisService.js) | `new Error("Memory layout exceeds the 64 MiB limit")` |
| [src/services/memoryAnalysisService.js:60](../src/services/memoryAnalysisService.js) | `new Error("Layout changed while reading")` |
| [src/services/memoryAnalysisService.js:66](../src/services/memoryAnalysisService.js) | `new Error(ˋINCLUDE cycle: ${file}ˋ)` |
| [src/services/memoryAnalysisService.js:67](../src/services/memoryAnalysisService.js) | `new Error("Too many linker INCLUDE files")` |
| [src/services/memoryAnalysisService.js:77](../src/services/memoryAnalysisService.js) | `new Error("INCLUDE is outside the workspace")` |
| [src/services/memoryAnalysisService.js:89](../src/services/memoryAnalysisService.js) | `new Error("ELF section metadata unavailable")` |
| [src/services/memoryAnalysisService.js:150](../src/services/memoryAnalysisService.js) | `new Error("Invalid memory.regionKinds")` |
| [src/services/memoryAnalysisService.js:153](../src/services/memoryAnalysisService.js) | `new Error("Memory analysis changed")` |
| [src/services/officialSvdService.js:41](../src/services/officialSvdService.js) | `new Error("Download cancelled")` |
| [src/services/officialSvdService.js:47](../src/services/officialSvdService.js) | `new Error(ˋ${source \|\| "XML"} contains a forbidden DTD/entityˋ)` |
| [src/services/officialSvdService.js:50](../src/services/officialSvdService.js) | `new Error(ˋInvalid ${source \|\| "XML"}: ${valid.err?.msg \|\| "parse error"}ˋ)` |
| [src/services/officialSvdService.js:60](../src/services/officialSvdService.js) | `new Error(ˋOnly HTTPS CMSIS-Pack sources are allowed: ${url.href}ˋ)` |
| [src/services/officialSvdService.js:65](../src/services/officialSvdService.js) | `new Error("Credential-bearing download URLs are not allowed")` |
| [src/services/officialSvdService.js:73](../src/services/officialSvdService.js) | `new Error("Too many download redirects")` |
| [src/services/officialSvdService.js:110](../src/services/officialSvdService.js) | `new Error(ˋDownload failed with HTTP ${status}: ${url.href}ˋ)` |
| [src/services/officialSvdService.js:120](../src/services/officialSvdService.js) | `new Error("Download exceeds the size limit")` |
| [src/services/officialSvdService.js:129](../src/services/officialSvdService.js) | `new Error("Download exceeds the size limit")` |
| [src/services/officialSvdService.js:152](../src/services/officialSvdService.js) | `new Error("Download timed out")` |
| [src/services/officialSvdService.js:157](../src/services/officialSvdService.js) | `new Error("Download cancelled")` |
| [src/services/officialSvdService.js:162](../src/services/officialSvdService.js) | `new Error("Download cancelled")` |
| [src/services/officialSvdService.js:173](../src/services/officialSvdService.js) | `new Error("Too many download redirects")` |
| [src/services/officialSvdService.js:177](../src/services/officialSvdService.js) | `new Error("Download cancelled")` |
| [src/services/officialSvdService.js:190](../src/services/officialSvdService.js) | `new Error("Download timed out")` |
| [src/services/officialSvdService.js:201](../src/services/officialSvdService.js) | `new Error("Download failed with HTTP " + status)` |
| [src/services/officialSvdService.js:206](../src/services/officialSvdService.js) | `new Error("Download exceeds the size limit")` |
| [src/services/officialSvdService.js:215](../src/services/officialSvdService.js) | `new Error("Download exceeds the size limit")` |
| [src/services/officialSvdService.js:373](../src/services/officialSvdService.js) | `new Error(ˋUnsafe path in CMSIS-Pack: ${name}ˋ)` |
| [src/services/officialSvdService.js:412](../src/services/officialSvdService.js) | `new Error(ˋSymbolic links are not allowed in CMSIS-Pack: ${name}ˋ)` |
| [src/services/officialSvdService.js:429](../src/services/officialSvdService.js) | `new Error("CMSIS-Pack contains duplicate SVD entries")` |
| [src/services/officialSvdService.js:437](../src/services/officialSvdService.js) | `new Error("SVD entry exceeds the size limit")` |
| [src/services/officialSvdService.js:451](../src/services/officialSvdService.js) | `new Error("SVD entry exceeds the size limit")` |
| [src/services/officialSvdService.js:469](../src/services/officialSvdService.js) | `new Error(ˋSVD ${wantedPath} was not found in the CMSIS-Packˋ)` |
| [src/services/officialSvdService.js:576](../src/services/officialSvdService.js) | `new Error("Select a device/SVD candidate first")` |
| [src/services/officialSvdService.js:584](../src/services/officialSvdService.js) | `new Error("The CMSIS-Pack license was not accepted")` |
| [src/services/officialSvdService.js:610](../src/services/officialSvdService.js) | `new Error("CMSIS-Pack checksum verification failed")` |
| [src/services/openocdExec.js:11](../src/services/openocdExec.js) | `new Error(ˋ找不到 OpenOCD：${executable}ˋ)` |
| [src/services/openocdExec.js:20](../src/services/openocdExec.js) | `new Error(error && error.message ? error.message : String(error))` |
| [src/services/openocdExec.js:100](../src/services/openocdExec.js) | `new Error("OpenOCD output limit exceeded")` |
| [src/services/openocdExec.js:130](../src/services/openocdExec.js) | `new Error(ˋOpenOCD 执行超时（${timeoutMs}ms）ˋ)` |
| [src/services/peripheralViewService.js:26](../src/services/peripheralViewService.js) | `new Error("Peripheral name is required")` |
| [src/services/peripheralViewService.js:30](../src/services/peripheralViewService.js) | `new Error(ˋPeripheral was not found: ${name}ˋ)` |
| [src/services/peripheralViewService.js:64](../src/services/peripheralViewService.js) | `new Error(ˋProvide 1–${MAX_READ_TARGETS} register pathsˋ)` |
| [src/services/prettyPrinting.js:29](../src/services/prettyPrinting.js) | `new Error("enablePrettyPrinting must be a boolean")` |
| [src/services/prettyPrinting.js:30](../src/services/prettyPrinting.js) | `new Error("prettyPrinterPath must be a directory path")` |
| [src/services/prettyPrinting.js:33](../src/services/prettyPrinting.js) | `new Error("prettyPrintingMode must be builtin, gdb or raw")` |
| [src/services/prettyPrinting.js:40](../src/services/prettyPrinting.js) | `new Error("prettyPrinterFiles must contain at most 32 explicit script paths")` |
| [src/services/prettyPrinting.js:44](../src/services/prettyPrinting.js) | `new Error(ˋPretty-printer script is not a file: ${file}ˋ)` |
| [src/services/prettyPrinting.js:73](../src/services/prettyPrinting.js) | `new Error("GDB has no Python support")` |
| [src/services/probeConnectionService.js:50](../src/services/probeConnectionService.js) | `connectionError( "PROBE_SESSION_STALE", "Connection settings changed; stop and restart the session before writing" )` |
| [src/services/probeConnectionService.js:71](../src/services/probeConnectionService.js) | `connectionError( "PROBE_CONFIGURATION_CHANGED", "Connection settings changed during preflight; retry the operation" )` |
| [src/services/probeConnectionService.js:101](../src/services/probeConnectionService.js) | `connectionError("PROBE_SELECTION_CANCELLED", "J-Link connection selection was cancelled")` |
| [src/services/probeConnectionService.js:105](../src/services/probeConnectionService.js) | `connectionError("PROBE_CONFIGURATION_CHANGED", "Probe configuration could not be resolved")` |
| [src/services/probeConnectionService.js:115](../src/services/probeConnectionService.js) | `connectionError("PROBE_SELECTION_REQUIRED", "Cannot determine a unique probe type", { candidates: detected.candidates, notes: detected.notes })` |
| [src/services/probeDriverService.js:11](../src/services/probeDriverService.js) | `connectionError(code, message, details)` |
| [src/services/probeDriverService.js:53](../src/services/probeDriverService.js) | `driverError( cancelled ? "PROBE_DRIVER_AUTH_CANCELLED" : exitCode === 11 ? "PROBE_DRIVER_BUSY" : resultUnknown ? "PROBE_DRIVER_RESULT_UNKNOWN" : rollbackFailed ? "PROBE_DRIVER_ROLLBACK_FAILED" : action === "restore" ? "PROBE_DRIVER_RESTORE_FAILED" : "PROBE_DRIVER_INSTALL_FAILED", cancelled ? "Windows administrator authorization was cancelled" : resultUnknown ? "Driver helper timed out; check the current USB driver before trying again" : ˋ${explanations[exitCode] \|\| "Driver helper failed"}${helperMessage ? ˋ: ${helperMessage}ˋ : ""}ˋ, { action, exitCode: error.code } )` |
| [src/services/probeDriverService.js:126](../src/services/probeDriverService.js) | `driverError("PROBE_DRIVER_HELPER_MISSING", "The signed Windows driver helper is not installed")` |
| [src/services/probeDriverService.js:143](../src/services/probeDriverService.js) | `driverError("PROBE_DRIVER_VERIFY_FAILED", "Windows did not bind the expected USB driver", { instanceId })` |
| [src/services/probeDriverService.js:218](../src/services/probeDriverService.js) | `driverError( "PROBE_DRIVER_ROLLBACK_FAILED", "WinUSB setup failed and the original driver could not be restored", { instanceId, initialError: originalError.message, rollbackError: rollbackError.message } )` |
| [src/services/probeDriverService.js:244](../src/services/probeDriverService.js) | `driverError("PROBE_DRIVER_BUSY", "The original J-Link driver is being restored")` |
| [src/services/probeDriverService.js:298](../src/services/probeDriverService.js) | `driverError( "PROBE_DRIVER_RESTORE_UNAVAILABLE", "Driver restore is available only for Windows x64 J-Link" )` |
| [src/services/probeDriverService.js:304](../src/services/probeDriverService.js) | `driverError("PROBE_DRIVER_RESTORE_UNAVAILABLE", "Select a J-Link currently using WinUSB")` |
| [src/services/probeDriverService.js:306](../src/services/probeDriverService.js) | `driverError("PROBE_DRIVER_BUSY", "A driver change is already running")` |
| [src/services/rtosViewService.js:27](../src/services/rtosViewService.js) | `new Error("RTOS task snapshots require the native EmberProbe debugger")` |
| [src/services/rtosViewService.js:31](../src/services/rtosViewService.js) | `new Error("Pause the debugger to refresh RTOS tasks")` |
| [src/services/rtosViewService.js:35](../src/services/rtosViewService.js) | `new Error("Wait for the memory write before refreshing RTOS tasks")` |
| [src/services/rtosViewService.js:49](../src/services/rtosViewService.js) | `new Error("Stale RTOS snapshot; refresh after stopping")` |
| [src/services/runtimeObjectReader.js:6](../src/services/runtimeObjectReader.js) | `new Error(message)` |
| [src/services/runtimeObjectReader.js:23](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime type is unavailable")` |
| [src/services/runtimeObjectReader.js:27](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime type aliases form a cycle")` |
| [src/services/runtimeObjectReader.js:33](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime object size is unavailable or oversized")` |
| [src/services/runtimeObjectReader.js:39](../src/services/runtimeObjectReader.js) | `failure("LIVE_READ_BUDGET_EXCEEDED", "Runtime object time budget exceeded")` |
| [src/services/runtimeObjectReader.js:48](../src/services/runtimeObjectReader.js) | `failure("LIVE_ADDRESS_NOT_RAM", "Runtime object points outside verified ELF memory ranges")` |
| [src/services/runtimeObjectReader.js:56](../src/services/runtimeObjectReader.js) | `failure("LIVE_READ_BUDGET_EXCEEDED", "Runtime object exceeds 4096 bytes / 32 reads per cycle")` |
| [src/services/runtimeObjectReader.js:60](../src/services/runtimeObjectReader.js) | `failure("LIVE_MEMORY_UNAVAILABLE", "Runtime object memory read was incomplete")` |
| [src/services/runtimeObjectReader.js:87](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Unsupported runtime DWARF member expression")` |
| [src/services/runtimeObjectReader.js:89](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime DWARF expression stack")` |
| [src/services/runtimeObjectReader.js:92](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime DWARF member expression")` |
| [src/services/runtimeObjectReader.js:96](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime member lookup depth exceeded")` |
| [src/services/runtimeObjectReader.js:100](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Ambiguous runtime member " + name)` |
| [src/services/runtimeObjectReader.js:116](../src/services/runtimeObjectReader.js) | `failure( matches.length ? "LIVE_LAYOUT_UNSUPPORTED" : "LIVE_MEMBER_MISSING", "Runtime member unavailable: " + name )` |
| [src/services/runtimeObjectReader.js:132](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime member location is unavailable")` |
| [src/services/runtimeObjectReader.js:147](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime discriminator")` |
| [src/services/runtimeObjectReader.js:179](../src/services/runtimeObjectReader.js) | `failure( "LIVE_LAYOUT_UNSUPPORTED", ˋRuntime STL node type is unavailable or ambiguous: ${pattern} (${candidates.length})ˋ )` |
| [src/services/runtimeObjectReader.js:186](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime tuple layout depth exceeded")` |
| [src/services/runtimeObjectReader.js:201](../src/services/runtimeObjectReader.js) | `failure("LIVE_NULL_POINTER", "Runtime pointer is null")` |
| [src/services/runtimeObjectReader.js:215](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime dynamic type has no verified vtable identity")` |
| [src/services/runtimeObjectReader.js:228](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime string requires the libstdc++ C++11 char ABI")` |
| [src/services/runtimeObjectReader.js:248](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime vector<bool> descriptor")` |
| [src/services/runtimeObjectReader.js:269](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime vector descriptor")` |
| [src/services/runtimeObjectReader.js:290](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Unsupported runtime smart-pointer layout")` |
| [src/services/runtimeObjectReader.js:312](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime optional discriminator")` |
| [src/services/runtimeObjectReader.js:319](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime variant discriminator")` |
| [src/services/runtimeObjectReader.js:327](../src/services/runtimeObjectReader.js) | `failure( "LIVE_LAYOUT_UNSUPPORTED", ˋRuntime tuple layout is incomplete: ${type.typeName} (${fields.length}/${type.args.length})ˋ )` |
| [src/services/runtimeObjectReader.js:363](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime deque descriptor")` |
| [src/services/runtimeObjectReader.js:368](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime deque length")` |
| [src/services/runtimeObjectReader.js:439](../src/services/runtimeObjectReader.js) | `failure("LIVE_POINTER_CYCLE", "Cycle in runtime STL tree")` |
| [src/services/runtimeObjectReader.js:449](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Corrupt runtime STL parent")` |
| [src/services/runtimeObjectReader.js:456](../src/services/runtimeObjectReader.js) | `failure("LIVE_POINTER_CYCLE", "Cycle in runtime STL parent chain")` |
| [src/services/runtimeObjectReader.js:461](../src/services/runtimeObjectReader.js) | `failure("LIVE_POINTER_CYCLE", "Runtime STL chain ended early or contains a cycle")` |
| [src/services/runtimeObjectReader.js:483](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Invalid runtime STL node count")` |
| [src/services/runtimeObjectReader.js:486](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime STL layout is not available: " + kind)` |
| [src/services/runtimeObjectReader.js:496](../src/services/runtimeObjectReader.js) | `failure("LIVE_MEMBER_MISSING", "Runtime path dereferences a non-pointer")` |
| [src/services/runtimeObjectReader.js:507](../src/services/runtimeObjectReader.js) | `failure("LIVE_MEMBER_MISSING", "Runtime container index is out of range")` |
| [src/services/runtimeObjectReader.js:512](../src/services/runtimeObjectReader.js) | `failure("LIVE_MEMBER_MISSING", "Runtime path is not a single typed member")` |
| [src/services/runtimeObjectReader.js:520](../src/services/runtimeObjectReader.js) | `failure("LIVE_READ_BUDGET_EXCEEDED", "Runtime object expansion budget exceeded")` |
| [src/services/runtimeObjectReader.js:522](../src/services/runtimeObjectReader.js) | `failure("LIVE_POINTER_CYCLE", "Runtime pointer graph contains a cycle")` |
| [src/services/runtimeObjectReader.js:636](../src/services/runtimeObjectReader.js) | `failure("LIVE_LAYOUT_UNSUPPORTED", "Runtime scalar type is unavailable")` |
| [src/services/runtimeObjectReader.js:660](../src/services/runtimeObjectReader.js) | `failure("LIVE_OBJECT_CHANGED", "Runtime object storage changed during sampling")` |
| [src/services/samplingArchive.js:14](../src/services/samplingArchive.js) | `new Error(message)` |
| [src/services/seriesStyleStore.js:25](../src/services/seriesStyleStore.js) | `new Error("Invalid series style")` |
| [src/services/sharedDebugGroup.js:7](../src/services/sharedDebugGroup.js) | `new Error(message)` |
| [src/services/svdDerivation.js:5](../src/services/svdDerivation.js) | `new Error(message)` |
| [src/services/svdLibraryService.js:41](../src/services/svdLibraryService.js) | `new Error("SVD file is empty or exceeds the size limit")` |
| [src/services/svdLibraryService.js:44](../src/services/svdLibraryService.js) | `new Error("SVD files with DTD or external entities are not allowed")` |
| [src/services/svdLibraryService.js:49](../src/services/svdLibraryService.js) | `new Error(ˋInvalid SVD XML: ${valid.err?.msg \|\| "parse error"}ˋ)` |
| [src/services/svdLibraryService.js:64](../src/services/svdLibraryService.js) | `new Error("SVD must contain device/name and at least one peripheral")` |
| [src/services/svdLibraryService.js:68](../src/services/svdLibraryService.js) | `new Error(ˋSVD device ${name} does not match ${identity.device}ˋ)` |
| [src/services/svdLibraryService.js:74](../src/services/svdLibraryService.js) | `new Error(ˋSVD vendor ${vendor} does not match ${identity.vendor}ˋ)` |
| [src/services/svdLibraryService.js:121](../src/services/svdLibraryService.js) | `new Error("The shared SVD library is busy")` |
| [src/services/svdLibraryService.js:131](../src/services/svdLibraryService.js) | `new Error("A workspace folder is required for SVD binding")` |
| [src/services/svdLibraryService.js:142](../src/services/svdLibraryService.js) | `new Error("Selected SVD is not a valid file or is too large")` |
| [src/services/svdManager.js:172](../src/services/svdManager.js) | `new Error(this.t("msg.openWorkspaceFirst"))` |
| [src/services/svdManager.js:189](../src/services/svdManager.js) | `new Error(this.t("msg.openWorkspaceFirst"))` |
| [src/services/svdManager.js:253](../src/services/svdManager.js) | `new Error(this.t("msg.openWorkspaceFirst"))` |
| [src/services/svdManager.js:255](../src/services/svdManager.js) | `new Error(this.t("svd.downloadBusy"))` |
| [src/services/svdManager.js:303](../src/services/svdManager.js) | `new Error("Download cancelled")` |
| [src/services/svdManager.js:314](../src/services/svdManager.js) | `new Error("Download cancelled")` |
| [src/services/svdModelService.js:13](../src/services/svdModelService.js) | `new Error("SVD parser disposed")` |
| [src/services/svdModelService.js:17](../src/services/svdModelService.js) | `new Error("SVD parser is busy")` |
| [src/services/svdModelService.js:29](../src/services/svdModelService.js) | `new Error(error.message)` |
| [src/services/svdPeripheralService.js:23](../src/services/svdPeripheralService.js) | `new Error("SVD expansion budget exceeded")` |
| [src/services/svdPeripheralService.js:41](../src/services/svdPeripheralService.js) | `new Error(ˋSVD integer for ${label} exceeds ${MAX_SVD_VALUE_CHARS} charactersˋ)` |
| [src/services/svdPeripheralService.js:49](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid SVD integer for ${label}: ${raw}ˋ)` |
| [src/services/svdPeripheralService.js:51](../src/services/svdPeripheralService.js) | `new Error(ˋSVD integer exceeds the supported address range for ${label}ˋ)` |
| [src/services/svdPeripheralService.js:83](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid SVD dimIndex: ${raw}ˋ)` |
| [src/services/svdPeripheralService.js:90](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid SVD dim count: ${count}ˋ)` |
| [src/services/svdPeripheralService.js:97](../src/services/svdPeripheralService.js) | `new Error("SVD element is missing a name")` |
| [src/services/svdPeripheralService.js:119](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid SVD field bit range for ${text(node?.name)}ˋ)` |
| [src/services/svdPeripheralService.js:135](../src/services/svdPeripheralService.js) | `new Error("Invalid enumeration usage")` |
| [src/services/svdPeripheralService.js:163](../src/services/svdPeripheralService.js) | `new Error(ˋSVD enumerated value exceeds ${MAX_SVD_VALUE_CHARS} bitsˋ)` |
| [src/services/svdPeripheralService.js:189](../src/services/svdPeripheralService.js) | `new Error(ˋSVD field exceeds register width: ${register.path}.${name}ˋ)` |
| [src/services/svdPeripheralService.js:214](../src/services/svdPeripheralService.js) | `new Error(ˋUnsupported SVD register size ${properties.size} for ${name}ˋ)` |
| [src/services/svdPeripheralService.js:220](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid SVD register address for ${path}ˋ)` |
| [src/services/svdPeripheralService.js:242](../src/services/svdPeripheralService.js) | `new Error("SVD nesting budget exceeded")` |
| [src/services/svdPeripheralService.js:282](../src/services/svdPeripheralService.js) | `new Error("SVD size limit exceeded")` |
| [src/services/svdPeripheralService.js:285](../src/services/svdPeripheralService.js) | `new Error("SVD files with DTD or external entities are not allowed")` |
| [src/services/svdPeripheralService.js:290](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid SVD XML: ${valid.err?.msg \|\| "parse error"}ˋ)` |
| [src/services/svdPeripheralService.js:300](../src/services/svdPeripheralService.js) | `new Error("SVD device element is missing")` |
| [src/services/svdPeripheralService.js:303](../src/services/svdPeripheralService.js) | `new Error(ˋUnsupported or ambiguous SVD endian: ${endian}ˋ)` |
| [src/services/svdPeripheralService.js:335](../src/services/svdPeripheralService.js) | `new Error(ˋDuplicate SVD register path: ${register.path}ˋ)` |
| [src/services/svdPeripheralService.js:345](../src/services/svdPeripheralService.js) | `new Error("SVD contains no peripherals")` |
| [src/services/svdPeripheralService.js:410](../src/services/svdPeripheralService.js) | `new Error(ˋSVD target was not found: ${target}ˋ)` |
| [src/services/svdPeripheralService.js:418](../src/services/svdPeripheralService.js) | `new Error(ˋRegister is write-only: ${register.path}ˋ)` |
| [src/services/svdPeripheralService.js:424](../src/services/svdPeripheralService.js) | `new Error(ˋRegister read has side effects (${readAction}): ${register.path}ˋ)` |
| [src/services/svdPeripheralService.js:437](../src/services/svdPeripheralService.js) | `new Error(ˋPeripheral target is not ordinary read-write: ${field?.path \|\| register.path}ˋ)` |
| [src/services/svdPeripheralService.js:449](../src/services/svdPeripheralService.js) | `new Error(ˋPeripheral target has special write semantics: ${field?.path \|\| register.path}ˋ)` |
| [src/services/svdPeripheralService.js:470](../src/services/svdPeripheralService.js) | `new Error(ˋPattern enumeration cannot be used as an exact write value: ${valueText}ˋ)` |
| [src/services/svdPeripheralService.js:483](../src/services/svdPeripheralService.js) | `new Error(ˋInvalid peripheral write value: ${valueText}ˋ)` |
| [src/services/svdPeripheralService.js:501](../src/services/svdPeripheralService.js) | `new Error(ˋPeripheral write value is outside ${bits}-bit rangeˋ)` |
| [src/services/svdPeripheralService.js:527](../src/services/svdPeripheralService.js) | `new Error("No SVD is configured for this workspace")` |
| [src/services/svdPeripheralService.js:531](../src/services/svdPeripheralService.js) | `new Error(ˋCannot read configured SVD: ${bound.path}ˋ)` |
| [src/services/svdPeripheralService.js:612](../src/services/svdPeripheralService.js) | `new Error("Peripheral transaction target changed")` |
| [src/services/svdPeripheralService.js:623](../src/services/svdPeripheralService.js) | `new Error("Incomplete peripheral register read")` |
| [src/services/svdPeripheralService.js:668](../src/services/svdPeripheralService.js) | `new Error("Incomplete peripheral register read")` |
| [src/services/svdPeripheralService.js:720](../src/services/svdPeripheralService.js) | `new Error(ˋField is write-only: ${field.path}ˋ)` |
| [src/services/svdPeripheralService.js:774](../src/services/svdPeripheralService.js) | `new Error(ˋSVD targets were not found: ${invalidTargets.join(", ")}ˋ)` |
| [src/services/svdPeripheralService.js:781](../src/services/svdPeripheralService.js) | `new Error(ˋField is write-only: ${resolved.field.path}ˋ)` |
| [src/services/svdPeripheralService.js:787](../src/services/svdPeripheralService.js) | `new Error("No peripheral targets supplied")` |
| [src/services/svdPeripheralService.js:809](../src/services/svdPeripheralService.js) | `new Error(ˋPeripheral target was requested more than once: ${target}ˋ)` |
| [src/services/svdPeripheralService.js:818](../src/services/svdPeripheralService.js) | `new Error("No peripheral writes supplied")` |
| [src/services/svdPeripheralService.js:828](../src/services/svdPeripheralService.js) | `new Error(ˋA whole-register write cannot be combined with field writes: ${register.path}ˋ)` |
| [src/services/svdPeripheralService.js:891](../src/services/svdPeripheralService.js) | `new Error(ˋPeripheral write read-back mismatch for ${item.register}ˋ)` |
| [src/services/svdWriteConstraints.js:4](../src/services/svdWriteConstraints.js) | `new Error(message)` |
| [src/services/svdWriteConstraints.js:41](../src/services/svdWriteConstraints.js) | `new Error(ˋPeripheral write violates ${constraint.kind}: ${target}ˋ)` |
| [src/skillInstaller.js:12](../src/skillInstaller.js) | `new Error("Invalid Agent Skills manifest")` |
| [src/skillInstaller.js:44](../src/skillInstaller.js) | `new Error(ˋRefusing to operate on a skill path outside the workspace: ${target}ˋ)` |
| [src/skillInstaller.js:226](../src/skillInstaller.js) | `new Error("Agent Skills installation is workspace-only")` |
| [src/skillInstaller.js:229](../src/skillInstaller.js) | `new Error(i18n.t(lang, "msg.openWorkspaceFirst"))` |
| [src/skillInstaller.js:259](../src/skillInstaller.js) | `new Error(ˋSkill ${entry.name} is missing ${required}ˋ)` |
| [src/webviewAssets.js:77](../src/webviewAssets.js) | `new Error(ˋWebview ${scope} did not contain extractable style and script blocksˋ)` |
| [src/webviewAssets.js:96](../src/webviewAssets.js) | `new Error(ˋWebview ${scope} contained markup that failed CSP hardeningˋ)` |
| [src/webviewTemplate.js:17](../src/webviewTemplate.js) | `new Error(ˋMissing webview asset: ${key}ˋ)` |
| [src/writeAuthorization.js:60](../src/writeAuthorization.js) | `new Error(message)` |
