# DAPLink 烧录问题审计

审计日期：2026-10-08。基线：`43259ae`，工作区 `package.json` 版本为 `0.8.1`。
用户实际安装的插件版本、MCU 型号、探针固件和 OpenOCD 版本尚未提供，不能假定与此基线相同。
聊天中的 `image` 是文字占位符，未获得截图中的错误原文。

初次审计只增加本文。随后按用户要求实施以下修复；没有连接探针、复位真实目标、烧录、切换驱动或执行 HIL。

## 已实施修复

- 非零 `adapterSpeedKhz` 对 target 原有复位事件中的提速请求施加上限，保留原初始化和更低速度；`0` 保留脚本默认行为。
- CMSIS-DAP/ST-Link 与 J-Link 共用物理选择、成功绑定和授权身份链路。DAP/ST-Link 保留精确序列号（含大小写与前导零）；Windows USB/HID 复合接口按物理设备合并。
- 下载超时或输出超限后等待 OpenOCD `close` 才返回，调用方在此之前保留探针租约；不自动重发烧录。
- UI 和 Agent 烧录共用阶段标记，区分初始化、复位初始化、编程、校验与最终运行复位；错误详情保留有界日志和超时结果未知状态。
- 新增 `test/daplink-flash.test.js` 软件回归；生成的 Tcl 已使用本机 OpenOCD `noinit` 和模拟命令验证，未访问目标硬件。

以下章节保留基线问题及证据。修复不等于已经确认用户设备的超时根因；仍需使用实际日志、探针及目标板复测。

## 结论

发现三个可由代码和软件复现确认的问题，以及一个诊断缺口：

| 优先级 | 发现 | 与用户现象的关系 |
| --- | --- | --- |
| P1 | 复位事件覆盖显式 `adapterSpeedKhz`，STM32F4 烧录初始化可升至 8 MHz | 慢速或无线 DAP 超时的候选因素；并非独立烧录专有，未证明是本次根因 |
| P1 | CMSIS-DAP/ST-Link 不绑定实际探针，预检清空序列号 | 多台同时在线时可能选错设备；不能用它解释只插一台时的所有失败 |
| P2 | 烧录超时/输出超限在进程退出前返回，调用方释放探针租约 | 超时后的立即重试或其他操作存在占用窗口；不是普通 OpenOCD 自行报错退出的必经问题 |
| P2 | 诊断未记录完整烧录阶段，插件计时器超时缺少原始日志详情 | 无法凭“探针超时”区分 USB、复位、擦写、校验和最终启动失败 |

**目前不能断言是“电脑插过两个 DAPLink 留下两个 ID”，也不能断言已经锁定 reset 根因。**
CMSIS-DAP 的 OpenOCD USB 后端枚举当前 USB 设备，并按指定序列号筛选；历史插拔记录本身不足以证明设备选择冲突。
参见 [OpenOCD 0.12.0 CMSIS-DAP USB 后端](https://github.com/openocd-org/openocd/blob/v0.12.0/src/jtag/drivers/cmsis_dap_usb_bulk.c)。

## 1. 显式降速在复位期间失效

证据：

- `skills/_emberprobe/openocd-launch.js:118` 的 `buildOpenOcdConfigArgs` 在加载 target 后追加一次 `adapter speed`。
- `src/openocdRunner.js:179` 固定执行 `program <ELF> verify reset exit`，没有对后续复位事件中的速度变更施加约束。
- 仓库内置 `resources/openocd-win32-x64.tar.gz` 的 `openocd/scripts/target/stm32f4x.cfg`：
  第 69 行默认 2000 kHz，第 145 行 `reset-init` 设置 8000 kHz，第 150 行 `reset-start` 设置 2000 kHz。
- 同一归档的 `stm32h7x.cfg`：第 129 行默认 1800 kHz，第 203 行 `reset-init` 设置 4000 kHz。
- 内置 F4 脚本的 `reset-init` 同时修改 PLL/Flash 等初始化寄存器，不能只把它视为“拉一下 NRST”。

例如配置 100 kHz 后，F4 的实际事件顺序仍可成为：配置 100 → reset-start 2000 → reset-init 8000。
若完成独立烧录后的 `reset run`，F4 的 reset-start 又会回到 2000。
因此设置中显示的 100 kHz 不代表整个操作始终使用该速度，单纯建议用户在设置里降速可能无效。
这是配置覆盖行为的确定性问题；探针是否接受、限制或能稳定运行这些速度仍需实测。

必须纠正一个容易出现的推断：调试器虽显式调用 `monitor reset halt`，GDB 下载仍可能通过
`gdb-flash-erase-start` 的默认事件执行 `reset init`。不能据此声称调试始终是 2 MHz、只有独立烧录才是 8 MHz。
参见 [OpenOCD target 启动及默认事件](https://github.com/openocd-org/openocd/blob/v0.12.0/src/target/startup.tcl)
和 [STM32F4 target 脚本](https://github.com/openocd-org/openocd/blob/v0.12.0/tcl/target/stm32f4x.cfg)。

修复建议：明确显式速度覆盖在复位全过程的语义，保留原 target 初始化逻辑，对事件中的提速实施约束。
覆盖测试需实际执行模拟 reset-start/reset-init/reset-end 事件，不能只断言命令行上出现 `adapter speed 100`。
不要全局替换 reset-init 为 reset-halt，也不要清空 target 的原事件处理器；这会跳过芯片需要的初始化。

## 2. DAPLink 与 ST-Link 的物理选择缺失

证据：

- `skills/_emberprobe/probe-preflight.js:129` 只为 `jlink` 调用设备清单；其他适配器没有物理身份预检。
- 同文件第 145 行明确将非 J-Link 的 `connection.probeSerial` 清空。
- `skills/_emberprobe/probe-connection.js:7` 的序列号校验只接受 1..4294967295 的十进制数字，并去除前导零。
- `src/services/probeConnectionService.js` 的选择界面和成功绑定也仅处理 J-Link。
- `package.json` 的 `emberprobe.probeSerial` 描述确实只承诺 J-Link；当前配置项不能作为 DAPLink 指定 ID 的办法。
- 内置 `interface/cmsis-dap.cfg` 只有 `adapter driver cmsis-dap`；示例 `adapter serial` 是注释。

软件复现注入两台设备清单和显式序列号 `1234`，结果如下：

```text
cmsis-dap: requestedSerial=1234, preparedSerial="", inventoryCalls=0
hla:       requestedSerial=1234, preparedSerial="", inventoryCalls=0
st-link:   requestedSerial=1234, preparedSerial="", inventoryCalls=0
normalizeProbeSerial("02200201E6661E601B98E3B9") -> PROBE_SERIAL_INVALID
normalizeProbeSerial("0001234") -> "1234"
```

双 DAP/双 ST-Link 同时在线时，插件没有阻止歧义选择，烧录连接身份也未绑定到其中一台物理探针。
这是潜在误烧录风险。只插一台时，仍需检查 cfg 内是否存在手工硬编码序列号、设备是否重复暴露接口、
其他进程占用等实际证据；不能把“曾插过另一台”直接当成原因。

OpenOCD 本身支持 CMSIS-DAP、HLA/ST-Link 和原生 ST-Link 的字符串序列号选择，
见 [Debug Adapter Configuration](https://openocd.org/doc/html/Debug-Adapter-Configuration.html)。
直接在用户自有 interface cfg 中配置精确字符串与通过插件设置不是同一条路径，前者没有经过上述清空逻辑。

修复建议：按适配器家族校验序列号，CMSIS-DAP/ST-Link 保留完整字符串及前导零，安全转义 Tcl 参数；
扩展当前在线设备枚举、歧义阻断和授权身份绑定。只删除清空语句不够，仍会被十进制校验和缺失物理选择阻挡。
回归覆盖单台、双台、指定设备离线、重复序列号、未知序列号及复合 USB 接口。

## 3. 超时后提前释放所有权

`src/openocdRunner.js:227` 的计时器调用 `child.kill()` 后立即 `reject(timeoutError)`，
500 ms 后才可能补发强制终止；第 280 行附近的输出超限分支也立即拒绝。
`src/mainViewProvider.js:914` 随后在 finally 中释放 download 租约，没有确认进程退出。

使用真实 runner 模块、只替换 spawn 和路径解析，令假子进程收到 kill 后尚未发出 close：

```text
timeoutCode=OPENOCD_TIMEOUT
processClosedWhenRejected=false
hasDiagnosticDetails=false
立即重复下载 -> PROBE_BUSY
```

`sharedChild` 暂时挡住重复下载，但调试、读取等其他入口依靠 coordinator，不能被这个模块内状态一并阻断。
因此可能在旧进程仍占用 USB 时启动另一个 OpenOCD。
默认插件计时器为 120 秒；若用户错误几秒内出现，应先排查 OpenOCD 自身超时，不要误归因到此分支。

修复建议：只有确认进程退出才结束操作并释放租约；退出无法确认时保留占用状态，允许再次清理。
覆盖延迟 close、kill 未确认、输出超限以及超时后启动其他操作的交叉测试。

## 4. 烧录阶段和原始错误证据不足

`src/openocdRunner.js:26` 的解析器未将 `Verify Started`、`Resetting Target` 等标记完整纳入进度状态；
`skills/_emberprobe/openocd-diagnostics.js:48` 把各类错误的 stage 固定为 `openocd_start`。
插件计时器超时分支只生成 `OPENOCD_TIMEOUT`，没有附加已经收集的原始输出与阶段。
OpenOCD 非零退出分支会保留诊断尾部，因此并非所有失败都丢失日志。

修复建议：至少区分 init、reset-init、erase/write、verify、reset-run、shutdown；
超时也保留有界原始尾部、请求速度、实际速度变更、物理序列号和最后完成阶段。
初始化失败后附带的通用错误不能遮蔽先前 USB/目标超时的证据。

## 调试正常为什么仍不足以证明烧录链路正常

| 项目 | 独立下载 | 内置调试 launch |
| --- | --- | --- |
| 插件命令 | `program <ELF> verify reset exit` | `monitor reset halt` → GDB 下载 → `monitor reset halt` |
| 写前初始化 | program 自身调用 init、reset init | GDB 默认擦除事件也可能执行 reset init |
| 校验 | 显式 verify_image | 当前 debugImages 没有显式全镜像 verify_image |
| 下载完成后的行为 | reset run、shutdown | reset halt，随后由调试器继续或停在入口 |
| 连接时序 | 新建独立进程，直接调用 program | 等服务就绪、GDB 连接、预先 halt，再执行下载 |

来源：`src/openocdRunner.js:179`、`src/debug/session.js:541`、`src/services/debugImages.js:234`，以及
[OpenOCD program 实现](https://github.com/openocd-org/openocd/blob/v0.12.0/src/flash/startup.tcl)。
MCU 信息能读出只说明某次连接完成了识别，不证明后续复位、Flash 算法执行、长时间读回和最终启动都成功。
最终 reset run 失败时，也不能直接向用户宣称“固件完全没有写进去”；需记录已完成的写入和校验阶段。

## 其余反馈

### 补充核查：work-area-backup 是否破坏 reset

后续提供的分析截图把 `-work-area-backup 1` 认定为主因，声称它在复位前备份 RAM、
等待 halt 后恢复，从而干扰 reset。核对 OpenOCD 0.12.0 及本机二进制对应的 `e5888bda3` 源码后，
该机制描述不成立：

- 配置该选项设置的是备份开关，不是立即备份 RAM，也没有注册截图所称的复位恢复事件。
- RAM 备份发生于 `target_alloc_working_area_try` 实际分配算法工作区时；普通释放时可以恢复。
- 复位路径明确调用 `target_free_all_working_areas_restore(target, 0)`，其中 `0` 禁止恢复旧工作区内容。
- 正常新进程的 program 初始 reset-init 发生在 Flash 写入算法分配工作区之前，
  不能用后续工作区备份解释这一阶段的 halt 超时。
- 内置调试路径 `src/liveWatch.js:573` 同样在 init 前配置 backup=1；独立下载的 program 也在内部先 init。
  因而截图用“调试没有这段逻辑”排除调试路径，缺乏依据。

可核对 [对应提交的工作区分配、恢复与复位实现](https://github.com/openocd-org/openocd/blob/e5888bda3/src/target/target.c)
（分配第 1913 行附近、普通恢复第 1947 行附近、复位第 5069 行）。
backup=1 的额外 RAM 读写仍可能增加编程阶段的通信开销，但这与“复位后恢复导致无法 halt”是不同假设。
在没有明确失败阶段或真机对照证据前，不应据此删除 RAM 保护或把相关测试改成要求 backup=0。

### RTOS、采样与退出行为

- RTOS 任务面板暂停后刷新符合当前实现：`src/services/rtosViewService.js:30` 明确要求暂停。
  任务调用频率、任务运行时间和 CPU 工作负载是不同指标，启用运行时间统计不自动产生调用频率。
  现有 CPU 负载功能是采样估计，不能替代任务执行次数、周期抖动或精确运行时长的固件统计。
- 调试期间实时变量帧率低有代码层面的原因：`src/liveWatch.js:345,461` 调试模式采样占用阈值 0.4，
  独立模式为 0.7；第 1042 行开始的调试静默响应路径每次请求还写入临时文件并由主机读回。
  这些机制和 GDB 共享链路竞争可能增加耗时；不能由代码静态审计断言它们恰好解释 30/90 或 20/60。
  当前运行期内存读取没有固定 20 Hz 上限。
- 结束调试后目标 halted：当前 disconnect/terminate 主要停止 GDB 和受管服务器，没有显式保证 MCU 继续运行。
  这是退出行为的配置/设计问题，不能直接归因于主控业务逻辑；修改前应确定停止调试后希望继续还是保持暂停。

## 已完成验证与建议补证

修复后在 Windows 11 / Node 24.13.1 上完成：

- `npm run check`：359 项检查通过，零失败。
- `npm run quality`：ESLint、Prettier、类型检查与覆盖率门禁通过；行/语句 86.05%，函数 91.76%，分支 83.54%。
- `npm run bundle`：通过。
- `npm run test:e2e`：VS Code 1.136.1 Extension Host 通过。首次运行受系统临时目录权限影响，改用工作区 `test-results/e2e-temp` 后通过。
- `node test/gdb/debug-images.test.js`：本机 ARM 工具链及内存 RSP 模拟目标回归通过，无硬件访问。
- 本机 xPack OpenOCD `noinit`：执行 F4 原 `reset-start`/`reset-init` 脚本，寄存器访问和等待替换为模拟过程。显式 100 kHz 限制成功约束原 2000/8000 kHz 请求；原 5 次寄存器操作全部保留；50 kHz 请求保留。烧录包装命令的阶段标记与带空格文件参数通过模拟 program/reset 验证。

完整软件检查需在获准的沙箱外运行，Windows 沙箱会阻止测试夹具的 `realpath` 和符号链接；未放宽产品路径检查。测试不认证真实 USB 行为、驱动、探针固件或烧录稳定性。

初次审计时执行并通过以下 7 个无硬件测试：

```text
node test/probe-connection.test.js
node test/probe-automatic.test.js
node test/probe-connection-service.test.js
node test/openocd-entrypoints.test.js
node test/openocd-parser.test.js
node test/flash-refresh.test.js
node test/flash-process.test.js
```

额外完成上述序列号清空、格式拒绝、超时返回早于 close 的模拟复现；通过 tar 只读检查内置 F4/H7/CMSIS-DAP 脚本。
本机已安装的 xPack OpenOCD `0.12.0+dev-02228-ge5888bda3-dirty` 还通过无 interface/target 的
`noinit` 模式打印 `init_target_events` 过程，确认其 GDB 默认擦除事件同样为 `reset init`；未初始化任何硬件。
这些初次审计验证检查参数顺序、模拟退出和错误分类，没有执行真实复位或认证多探针 USB 行为。

要锁定本次根因，应取得同一 ELF/同一目标下失败独立烧录和成功调试下载的完整 OpenOCD 日志，
以及插件版本、MCU/target cfg、OpenOCD 版本与实际路径、DAP 固件、有线/无线、当前在线数量和 NRST 接线信息。
优先查看 timeout 前最近一个阶段和速度变化；特别区分 reset-init 之前失败、升速后写入/校验失败和 reset-run 失败。

后续经明确授权在专用板上验证时，使用相同条件比较单台/双台与真正贯穿复位事件的低速设置。
只有确认 NRST 已接且板级 reset 策略适配时，才试验 connect-under-reset；不能无条件强制硬件复位。
相关约束见 [OpenOCD Reset Configuration](https://openocd.org/doc/html/Reset-Configuration.html)
和仓库 [HIL 指南](../test/hil/README.md)。
