# PR #25 修复与 F407_car 实机验证

验证日期：2026-10-09。PR 基线：`96687df7cf4a3d2eb2af6a3bcb473c1564ce43e8`，叠加当前工作区修复。

## 修复行为

- 侧栏和 Agent 变量读取、写前读取与写入执行均检查选定 ELF 是否对应 probe-rs 会话的 `coreConfigs[0].programBinary`。Agent 多次采样保留构建地址计划时的 ELF 与会话身份，拒绝等待期间发生的身份变更。
- DAP Bridge 的公共读取入口统一执行运行中 RAM 段和读取预算检查，覆盖轮询、Agent `readOnce` 和写前读取。外围寄存器及芯片身份读取继续使用各自的专用接口。
- Native F5、侧栏与自动 LiveWatch 统一检查 CPU 监测、驱动切换、其他调试器和探针占用。适配器在产生子进程前取得 `debugStart` 租约，成功 attach/launch 后转为 `debugServer`，只在进程退出确认后释放。
- 切换选定会话恢复该会话的 `probeRsReady` 与 DAP 能力，重新安排快照，并废弃上一会话的结果。
- 活跃会话的芯片信息使用该会话实际的 chip、probe、wire protocol、speed 和 cwd；与现有 DAP 连接共享租约，拒绝并发芯片读取及会话变化后的结果。独立 CLI 读取使用工作区设置。
- 自动 attach 不再等待其自身的 LiveWatch 启动 Promise。正常 disconnect 给 probe-rs 完成 USB 清理的机会；超时才终止进程，退出未确认时保留租约。

## 实机环境与镜像身份

| 项目              | 实际值                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| 项目              | `C:\Users\28951\Desktop\STM32Project\F407_car`                         |
| 项目配置的芯片    | Geehy APM32F407ZG                                                      |
| probe-rs 连接模型 | `STM32F407ZG`，SWD，2000 kHz                                           |
| 探针              | J-Link，`1366:0101:000020781318`，已有 WinUSB 驱动                     |
| 系统              | Windows，内核版本 `10.0.26300`，x64                                    |
| 软件              | Node.js `24.13.1`；VS Code `1.141.0`；probe-rs `0.32.0`，git `48f5e4d` |
| 验收 ELF          | `build/Release/F407_car.elf`                                           |
| ELF SHA-256       | `e0146385cd74fbae3826dc0b211e6bed63d8a1e32bf5c5649b0ca666ec48c5eb`     |
| 芯片读值          | Cortex-M4 r0p1，CPUID `0x410FC241`                                     |
| 比对范围          | ELF 全部非空 PT_LOAD Flash 段，累计 23,972 字节，逐字节一致            |

用户确认电池和编码器断电。使用隔离的 VS Code 配置目录打开原项目；没有修改项目的 settings.json、launch.json、openocd.cfg 或 ELF。上述三个配置文件验证前后 SHA-256 一致。验收只执行 attach、读取、拒绝路径及 disconnect，没有烧录、复位、写入 PID/使能变量或切换驱动。

先检查 Debug/Release 镜像身份，并读取备份后，确认当前板上镜像对应 Release ELF，再进行按符号地址的 RAM 读取。1 MiB Flash 备份保存在 `test-results/f407-original-flash-2026-10-09.bin`，SHA-256 为 `61bc0b812117553cfef413bf1583d826d9264b79c53cb1a534d55bab04804228`。

## 实机结果

最终验收在 21:18（Asia/Taipei）完成，Extension Host 返回 0；生成 `test-results/probe-rs-f407.json`。

- Native F5 attach 成功。工作区 `probeRsChip` 为空，chip 仅在调试配置提供时，芯片信息读取成功。
- 运行中侧栏与 Agent 均读到七个 RAM 全局量；FreeRTOS `xTickCount` 持续增加。记录样本包含 `g_pid_balance_kp=0`、`g_pid_balance_kd=0`、`g_balance_debug_enable=0`、`g_imu_init_attempts=1`、`g_imu_init_stage=6`、`g_imu_init_status=0` 和 `xTickCount=878339`。
- 运行中 MMIO 读取返回 `LIVE_ADDRESS_NOT_RAM`；选定 ELF 不匹配时读取与 UI 写入返回 `DEBUG_ELF_SESSION_MISMATCH`。负面测试封装了传输入口，确认拒绝发生在任何 DAP 内存请求之前；没有向板卡发送测试写入。
- 占用中的调试连接拒绝新的独占操作。会话结束后确认进程退出与租约释放，随后成功自动 attach，并将自动采样会话替换为手动调试会话。
- 最终 Bridge 状态为 `none`，会话列表为空，全部 coordinator 租约为 false。

首次快速重连出现 J-Link bulk write timeout。将正常 disconnect 改为先等待 probe-rs 退出、完成 USB 清理后，重新执行整个验收，自动 attach 和采样转调试均成功。此前还通过验收发现并修复了自动 attach 的自等待。

本次短采样窗口设置 100 ms，观测约 2.26 Hz、p95 读取耗时 331 ms。该记录用于正确性验收，不能据此承诺 10 Hz 或项目设置中的 200 Hz。APM32 使用 STM32 的连接模型仅在当前板卡、固件、探针组合上验证了 attach 和读取；没有验证该模型的 Flash 算法、Rust RTT 或双探针/双核实机切换。两个 probe-rs 会话的就绪状态切换、成功写回与失败路径由无硬件测试覆盖。

## 复现与软件检查

先运行 `npm run bundle`。保持电机电源隔离，确保没有其他探针使用者，设置以下环境变量后运行 `node test/hil/vscode-probe-rs-f407/run.js`：

```powershell
$env:EMBERPROBE_HIL_CONFIRM = "YES"
$env:EMBERPROBE_HIL_MOTORS_ISOLATED = "YES"
$env:EMBERPROBE_HIL_PROJECT = "C:/Users/28951/Desktop/STM32Project/F407_car"
$env:EMBERPROBE_HIL_ELF = "$env:EMBERPROBE_HIL_PROJECT/build/Release/F407_car.elf"
$env:EMBERPROBE_HIL_CHIP = "STM32F407ZG"
$env:EMBERPROBE_HIL_PROBE = "1366:0101:000020781318"
$env:EMBERPROBE_HIL_PROBE_RS = "C:/Users/28951/.cargo/bin/probe-rs.exe"
$env:EMBERPROBE_E2E_VSCODE_PATH = "D:/software/VSCode/Microsoft VS Code/Code.exe"
node test/hil/vscode-probe-rs-f407/run.js
```

`EMBERPROBE_HIL_BACKUP` 可指定新的本地文件路径：镜像不匹配时先只读备份 1 MiB Flash，再结束验收。备份文件使用独占创建，不覆盖已有备份。

软件验证执行 `npm run check`、`npm run quality`、`npm run bundle`、`npm run test:e2e`。新增回归覆盖 ELF 身份、运行中 RAM 限制、会话切换、芯片读取、启动争用、正常/异常退出、退出未确认的租约保留、DAP 分帧预算与自动 attach。新增 Extension Host 测试通过真实模拟适配器子进程验证 F5、写回、自动采样和调试替换，不需要连接探针。

最终检查结果：`check` 为 376 项、0 失败；`quality` 包含 177 个测试文件、0 失败，覆盖率为行/语句 86.17%、函数 91.60%、分支 83.51%，包括新增适配器服务在内的独立安全门禁通过；bundle 与 Extension Host 测试均通过。最终系统进程检查未发现遗留 probe-rs 或本次 F407 验收主机。

probe-rs 配置字段及 attach 范围参照其 [官方调试器文档](https://probe.rs/docs/tools/debugger/)。实机记录是本次观察，不构成对其他芯片型号或 Flash 支持的推断。
