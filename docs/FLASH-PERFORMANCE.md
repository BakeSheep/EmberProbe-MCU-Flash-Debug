# Flash performance / 烧录性能

Sidebar downloads and Agent `flash.execute` share one OpenOCD command built by `skills/_emberprobe/openocd-flash.js`. It still runs OpenOCD's own `program <elf> verify reset exit`, so target reset events, the work-area backup, final verification and reset-run are unchanged. Two steps are added around its `flash write_image erase` call.

侧边栏下载与 Agent `flash.execute` 共用 `skills/_emberprobe/openocd-flash.js` 生成的 OpenOCD 命令。整体仍由 OpenOCD 自带的 `program <elf> verify reset exit` 执行，target 复位事件、work-area 备份、最终校验与复位运行保持不变，只在其 `flash write_image erase` 前后增加两步。

## Unchanged images / 固件未变化

Before erasing, `verify_image_checksum` compares the image with target memory using an on-target CRC. When every section matches, erase and write are skipped; the normal final `verify_image` and reset still run. The terminal reports "固件与目标一致，已跳过擦写" and Agent results report `programming.unchanged: true`. A mismatch only costs the CRC and falls through to a normal erase and write. Bytes in partially used sectors outside the image are not re-erased when the image is skipped.

擦除前先用 `verify_image_checksum`（目标端 CRC）比较镜像与目标存储器。所有段一致时跳过擦写，最终 `verify_image` 与复位照常执行；终端显示“固件与目标一致，已跳过擦写”，Agent 结果为 `programming.unchanged: true`。不一致时只多一次 CRC 计算，随后正常擦写。跳过时，镜像未覆盖的扇区剩余字节不会被重新擦除。

## Programming clock / 烧录时钟

Target scripts choose conservative clocks (for example STM32F1 1 MHz, STM32H7 4 MHz after reset-init). After `reset init` has configured the target clocks, EmberProbe raises the SWD clock for the write:

target 脚本的速度偏保守（例如 STM32F1 为 1 MHz，STM32H7 在 reset-init 后为 4 MHz）。`reset init` 完成目标时钟配置后，EmberProbe 为写入提高 SWD 时钟：

| Probe / 探针 | Requested / 请求 | Effective / 实际 |
| --- | --- | --- |
| ST-Link (`hla`, `st-link`) | 24000 kHz | V2/V2-1 clamp to 4 MHz, V3 runs 24 MHz / V2 钳制为 4 MHz，V3 为 24 MHz |
| J-Link | 15000 kHz | Reduced to the model maximum by the driver / 驱动按型号上限降低 |
| CMSIS-DAP | 10000 kHz | Firmware uses its fastest supported divider / 固件取其最快可用分频 |
| Others / 其他 | — | Script clock / 脚本时钟 |

A nonzero `emberprobe.adapterSpeedKhz` replaces the table value. The clock is raised only for Cortex-M targets over SWD (`swd`, `hla_swd`, `dapdirect_swd`) and only when a CPUID read at the new clock matches the read at the previous clock. If the write or OpenOCD's final `verify_image` fails at the raised clock, EmberProbe restores the previous clock, runs `reset init` again, rewrites and verifies once more; only that second attempt's errors are reported. A successful fast write is verified once, as before. JTAG, RISC-V and other targets keep the script clock.

非零的 `emberprobe.adapterSpeedKhz` 替代表中数值。仅在 Cortex-M 且使用 SWD（`swd`、`hla_swd`、`dapdirect_swd`）时提速，并且新时钟下读取的 CPUID 必须与原时钟一致。提速后写入或 OpenOCD 最终 `verify_image` 失败时，恢复原时钟、重新 `reset init` 并重写、重新校验一次，只报告第二次的错误；高速写入成功时仍只校验一次。JTAG、RISC-V 等目标保持脚本时钟。

Measured on an APM32F407 with J-Link V9 (clamped to 12 MHz; the F4 script already runs at 8 MHz after reset-init), a full erase and write took about the same time, and the CRC pre-check added about 0.13 s; an unchanged image went from 2.1 s to 0.7 s. Targets whose scripts stay at a low clock (STM32F1 1 MHz, STM32H7 4 MHz) gain more from the raised clock. Erase time is set by the Flash itself and is not affected by the probe clock. Long or unshielded wiring may make the fallback run on every download; set an explicit lower `adapterSpeedKhz` in that case.

在 APM32F407 + J-Link V9（钳制为 12 MHz；F4 脚本在 reset-init 后已是 8 MHz）上实测，完整擦写耗时基本不变，CRC 预检约增加 0.13 s；固件未变化时由 2.1 s 降至 0.7 s。脚本时钟较低的目标（STM32F1 1 MHz、STM32H7 4 MHz）提速收益更大。擦除时间由 Flash 本身决定，不受探针时钟影响。连线较长或无屏蔽时可能每次都触发降速重烧，此时请设置较低的 `adapterSpeedKhz`。

## Debug launch / 调试启动

A managed `launch` downloads through GDB rather than the sidebar's OpenOCD `program`. After the first `monitor reset halt` it runs GDB `compare-sections`, which checks every loadable section of the debug executable at its load address, exactly the data `-target-download` writes, using the server's CRC (`qCRC`; OpenOCD computes it on the target). When every section matches, `-target-download` and the second reset are skipped and the Debug Console reports "Firmware matches the target; download skipped". Any mismatch, error or unrecognized output downloads as before, costing only the CRC pass. The check is per section rather than OpenOCD's segment-wide `verify_image_checksum` because a GDB download leaves the alignment gaps between sections at the erased value (for example 8 bytes between `.isr_vector` and `.text` in typical STM32 builds), which never matches the zero fill in the ELF. This applies to the default executable download; explicit `loadFiles` are always downloaded, and attach never writes. Partially used sectors outside the image are not re-erased when the download is skipped, as with sidebar downloads. When the check reports a mismatch, the GDB download uses the raised programming clock described above: through OpenOCD (`monitor`) the adapter raises the SWD clock to the same per-probe value under the same conditions (Cortex-M over SWD, CPUID read back unchanged), downloads, checks the written sections once more with `compare-sections`, and restores the script clock before the second reset. A failed download or a mismatch at the raised clock restores the script clock, runs `monitor reset halt` and downloads once more at the script clock; only that attempt's errors are reported. When the pre-check output is not recognized (for example a localized GDB) or OpenOCD refuses the raise, the download keeps the script clock as before.

托管 `launch` 经 GDB 下载，而不是侧边栏使用的 OpenOCD `program`。第一次 `monitor reset halt` 后执行 GDB `compare-sections`：按加载地址逐一校验调试 ELF 的每个可加载段，即 `-target-download` 实际写入的数据，校验和由服务器计算（`qCRC`，OpenOCD 在目标端计算）。全部一致时跳过 `-target-download` 与第二次复位，调试控制台显示 “Firmware matches the target; download skipped”。任何不一致、错误或无法识别的输出都按原流程下载，只多一次 CRC。之所以按 section 而不是用 OpenOCD 按 segment 计算的 `verify_image_checksum`，是因为 GDB 下载会把 section 之间的对齐空隙留为擦除值（典型 STM32 工程中 `.isr_vector` 与 `.text` 之间有 8 字节），与 ELF 中的零填充永远不一致。该行为只针对默认的可执行文件下载；显式 `loadFiles` 总是下载，attach 从不写入。与侧边栏下载相同，跳过时镜像未覆盖的扇区剩余字节不会被重新擦除。CRC 检查结果为不一致时，GDB 下载使用上文的提速烧录时钟：适配器通过 OpenOCD（`monitor`）按相同条件（Cortex-M 且使用 SWD、CPUID 读回一致）把 SWD 时钟提到各探针相同的数值，下载后再用 `compare-sections` 校验一次写入的各段，并在第二次复位前恢复脚本时钟。提速下载失败或校验不一致时，恢复脚本时钟、执行 `monitor reset halt`，再以脚本时钟下载一次，只报告这一次的错误。预检输出无法识别（例如本地化的 GDB）或 OpenOCD 拒绝提速时，照旧使用脚本时钟下载。

On Windows GDB can take several seconds to start cold. An isolated VS Code Extension Host with an in-memory ARM target reproduced 5.45 s before the first MI response, then 46 ms on the second start; explicitly completing the version warm-up first reduced the next MI start to 48 ms. These are host-side measurements, not board acceptance results. EmberProbe schedules hidden `<gdb> --version` preparation immediately after activation, ELF selection, trust grant or toolchain setting changes, only in a trusted workspace with a selected ELF. Successful preparation is reused for ten minutes per executable. Lookup matches launch: settings, the remembered directory, process PATH, refreshed Windows system/user PATH, then ST installations. It never prompts or runs a login shell. A managed launch overlaps preparation with OpenOCD/SVD resolution, then waits for it before stopping sampling or acquiring the probe. If Debug is clicked before a cold GDB has prepared, that cold-start cost still exists; early preparation moves it out of the user's launch. A failed preparation falls back to normal GDB startup. Its 30-second budget settles even if process exit is unconfirmed, retaining that child for cleanup without starting duplicate warm-ups.

Windows 上 GDB 冷启动可能需要数秒。隔离的 VS Code 扩展宿主连接内存 ARM 模拟目标时，首次 MI 响应用时 5.45 秒，第二次 46 毫秒；先完成版本预热后，下一次 MI 启动为 48 毫秒。这是宿主侧测量，不代表实板验收。EmberProbe 在激活、选择 ELF、授予工作区信任及修改工具链设置后立即调度隐藏的 `<gdb> --version` 预热，仅在已信任且已选择 ELF 的工作区执行。同一可执行文件的成功预热复用十分钟。查找顺序与正式启动一致：设置、记住的目录、进程 PATH、刷新的 Windows 系统／用户 PATH、ST 安装；不弹出提示，也不运行登录 shell。托管调试将预热与 OpenOCD／SVD 解析并行，然后在停止采样、取得探针前等候预热完成。打开工程后立刻调试仍可能等待首次冷启动；提前预热才会将这部分耗时移出调试启动。预热失败后继续正常启动 GDB；30 秒预算到期即结束等待，即使子进程退出未确认也不会无限等待或重复启动预热进程，原进程仍保留用于清理。

Set `"performanceTrace": true` in the launch configuration to log, in the Debug Console, the launch phases (`gdbStart`, `gdbSetup`, `symbols`, `connect`, `preHooks`, `reset` or `halt`, `download`, `postDownloadReset`, `postHooks`, `threads`), whether the firmware was `unchanged` or `programmed`, the CRC time (`checkMs`), for a download at the raised clock its effective `downloadClockKhz` and whether it fell back (`speedFallback`), and `entryStop.sinceLaunchMs`, the time from the start of `launch` to the entry breakpoint. For a managed launch it also logs the extension's work before the adapter starts as `startup` (`tools`: toolchain lookup, `openocd`: OpenOCD and SVD resolution, `prepare`: stopping sampling, `preflight`: probe preflight, `server`: OpenOCD start-up until its GDB port is ready) with their sum `startupMs`, and `entryStop.sinceStartMs`, the wall-clock time from the start of the debug command to the entry breakpoint. The trace carries durations only, never paths, expressions or target data.

The managed `startup.warmup` phase measures the remaining wait for preparation; `gdbWarmup` reports its state and full duration, including work already completed in the background. Thus a ready warm-up lasting several seconds can accompany a zero-millisecond launch wait. Only known state names and non-negative integer durations are forwarded to the adapter; executable paths are omitted.

`gdbWarmup.state: "ready"` confirms only that the separate `--version` process exited successfully. The real MI process is started independently; a later full-profile F407 measurement still took 5.50 s in `gdbStart` despite ready preparation. The trace starts inside configuration handling and excludes any earlier F5/extension-activation queue. Isolated timings therefore do not establish the user's complete click-to-entry latency.

On Windows and Linux x64 the default `openocdPath` uses the bundled runtime, extracted once into the extension's global storage under a directory named after the archive's SHA-256, so an extension update extracts again only when the bundled archive changes. Its `openocd --version` check runs once per extension host and is reused while the executable keeps its size and modification time, so later flash, debug and live starts do not start an extra OpenOCD process.

在 launch 配置中设置 `"performanceTrace": true`，调试控制台会输出 launch 各阶段耗时（`gdbStart`、`gdbSetup`、`symbols`、`connect`、`preHooks`、`reset` 或 `halt`、`download`、`postDownloadReset`、`postHooks`、`threads`）、固件为 `unchanged` 还是 `programmed`、CRC 耗时（`checkMs`）、提速下载时的实际时钟 `downloadClockKhz` 及是否回退（`speedFallback`），以及从 `launch` 开始到入口断点的 `entryStop.sinceLaunchMs`。托管 launch 还会以 `startup` 输出适配器启动前扩展侧的耗时（`tools`：工具链查找，`openocd`：OpenOCD 与 SVD 解析，`prepare`：停止采样，`preflight`：探针预检，`server`：OpenOCD 启动至 GDB 端口就绪）及其总和 `startupMs`，并以 `entryStop.sinceStartMs` 给出从调试命令开始到入口断点的墙钟时间。记录只含耗时，不含路径、表达式或目标数据。

托管调试新增 `startup.warmup`，表示启动时尚需等候的预热时间；`gdbWarmup` 记录预热状态及包含后台工作的完整耗时。因此，已完成且耗时数秒的预热可以对应零毫秒的启动等待。转交适配器前仅保留已知状态名与非负整数耗时，不包含可执行文件路径。

`gdbWarmup.state: "ready"` 仅确认独立的 `--version` 进程成功退出，正式 MI 进程仍会重新创建。后续完整扩展配置下的 F407 实测中，预热就绪后 `gdbStart` 仍用时 5.50 秒。计时从配置处理函数内部开始，不包含此前的 F5／扩展激活排队时间，因此隔离测试不能证明用户从点击到入口断点的完整耗时。

Windows 与 Linux x64 上默认 `openocdPath` 使用内置运行时，只解压一次到扩展全局存储中以压缩包 SHA-256 命名的目录，因此扩展更新后只有内置压缩包变化时才会重新解压。其 `openocd --version` 校验在每个扩展宿主中只执行一次，可执行文件大小与修改时间不变时直接复用，之后的烧录、调试与实时查看不再额外启动 OpenOCD 进程。
