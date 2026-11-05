# 烧录与调试启动设计

用户行为见[烧录与下载](../guide/flash-debug/flash.md)。

## 烧录命令

侧边栏下载与 Agent `flash.execute` 共用 `skills/_emberprobe/openocd-flash.js` 生成的 OpenOCD 命令。整体仍由 OpenOCD 自带的 `program <elf> verify reset exit` 执行，target 复位事件、work-area 备份、最终校验与复位运行保持不变，在其 `flash write_image erase` 前后控制烧录时钟。

每次下载都正常执行擦除、写入、校验和复位运行，即使镜像与目标 Flash 完全一致也会重新烧录。烧录前不再通过 CRC 比较跳过擦写，Agent 结果为 `programming.unchanged: false`。

## 烧录时钟

target 脚本的速度偏保守（例如 STM32F1 为 1 MHz，STM32H7 在 reset-init 后为 4 MHz）。`reset init` 完成目标时钟配置后，EmberProbe 为写入提高 SWD 时钟：

| 探针 | 请求 | 实际 |
| --- | --- | --- |
| ST-Link（`hla`、`st-link`） | 24000 kHz | V2/V2-1 钳制为 4 MHz，V3 为 24 MHz |
| J-Link | 15000 kHz | 驱动按型号上限降低 |
| CMSIS-DAP | 10000 kHz | 固件取其最快可用分频 |
| 其他 | — | 脚本时钟 |

非零的 `emberprobe.adapterSpeedKhz` 替代表中数值。仅在 Cortex-M 且使用 SWD（`swd`、`hla_swd`、`dapdirect_swd`）时提速，并且新时钟下读取的 CPUID 必须与原时钟一致。提速后写入或 OpenOCD 最终 `verify_image` 失败时，恢复原时钟、重新 `reset init` 并重写、重新校验一次，只报告第二次的错误；高速写入成功时仍只校验一次。JTAG、RISC-V 等目标保持脚本时钟。

此前 APM32F407 + J-Link V9（钳制为 12 MHz；F4 脚本在 reset-init 后已是 8 MHz）的测量中，完整擦写耗时基本不变。脚本时钟较低的目标（STM32F1 1 MHz、STM32H7 4 MHz）提速收益更大。擦除时间由 Flash 本身决定，不受探针时钟影响。连线较长或无屏蔽时可能每次都触发降速重烧，此时请设置较低的 `adapterSpeedKhz`。

## 调试启动下载

托管 `launch` 经 GDB 下载。第一次 `monitor reset halt` 后，默认可执行文件总是通过 `-target-download` 下载，随后再次复位再启动；固件相同也会重新下载。满足上文的提速条件（Cortex-M 且使用 SWD、CPUID 读回一致）时，通过 OpenOCD（`monitor`）提高 SWD 时钟，下载后用 GDB `compare-sections` 校验一次写入的各段，并在第二次复位前恢复脚本时钟。这是使用服务器 CRC（`qCRC`）的写后校验，不再进行下载前比较。提速下载失败、校验不一致或无法识别校验输出时，恢复脚本时钟、执行 `monitor reset halt` 并重新下载一次。OpenOCD 拒绝提速时沿用脚本时钟。显式 `loadFiles` 按顺序下载；`loadFiles: []` 仍按明确配置跳过下载，attach 从不写入。

## GDB 预热

Windows 上 GDB 冷启动可能需要数秒。隔离的 VS Code 扩展宿主连接内存 ARM 模拟目标时，首次 MI 响应用时 5.45 秒，第二次 46 毫秒；先完成版本预热后，下一次 MI 启动为 48 毫秒。这是宿主侧测量，不代表实板验收。EmberProbe 在激活、选择 ELF、授予工作区信任及修改工具链设置后立即调度隐藏的 `<gdb> --version` 预热，仅在已信任且已选择 ELF 的工作区执行。同一可执行文件的成功预热复用十分钟。查找顺序与正式启动一致：设置、记住的目录、进程 PATH、刷新的 Windows 系统／用户 PATH、ST 安装；不弹出提示，也不运行登录 shell。托管调试将预热与 OpenOCD／SVD 解析并行，然后在停止采样、取得探针前等候预热完成。打开工程后立刻调试仍可能等待首次冷启动；提前预热才会将这部分耗时移出调试启动。预热失败后继续正常启动 GDB；30 秒预算到期即结束等待，即使子进程退出未确认也不会无限等待或重复启动预热进程，原进程仍保留用于清理。

## 启动耗时记录

在 launch 配置中设置 `"performanceTrace": true`，调试控制台会输出 launch 各阶段耗时（`gdbStart`、`gdbSetup`、`symbols`、`connect`、`preHooks`、`reset` 或 `halt`、`download`、`postDownloadReset`、`postHooks`、`threads`）、固件是否已烧录（`programmed`）或未请求下载（`none`）、提速下载时的实际时钟 `downloadClockKhz` 及是否回退（`speedFallback`），以及从 `launch` 开始到入口断点的 `entryStop.sinceLaunchMs`。托管 launch 还会以 `startup` 输出适配器启动前扩展侧的耗时（`tools`：工具链查找，`openocd`：OpenOCD 与 SVD 解析，`prepare`：停止采样，`preflight`：探针预检，`server`：OpenOCD 启动至 GDB 端口就绪）及其总和 `startupMs`，并以 `entryStop.sinceStartMs` 给出从调试命令开始到入口断点的墙钟时间。记录只含耗时，不含路径、表达式或目标数据。

托管调试新增 `startup.warmup`，表示启动时尚需等候的预热时间；`gdbWarmup` 记录预热状态及包含后台工作的完整耗时。因此，已完成且耗时数秒的预热可以对应零毫秒的启动等待。转交适配器前仅保留已知状态名与非负整数耗时，不包含可执行文件路径。

`gdbWarmup.state: "ready"` 仅确认独立的 `--version` 进程成功退出，正式 MI 进程仍会重新创建。后续完整扩展配置下的 F407 实测中，预热就绪后 `gdbStart` 仍用时 5.50 秒。计时从配置处理函数内部开始，不包含此前的 F5／扩展激活排队时间，因此隔离测试不能证明用户从点击到入口断点的完整耗时。

## 内置 OpenOCD 运行时

Windows 与 Linux x64 上默认 `openocdPath` 使用内置运行时，只解压一次到扩展全局存储中以压缩包 SHA-256 命名的目录，因此扩展更新后只有内置压缩包变化时才会重新解压。其 `openocd --version` 校验在每个扩展宿主中只执行一次，可执行文件大小与修改时间不变时直接复用，之后的烧录、调试与实时查看不再额外启动 OpenOCD 进程。
