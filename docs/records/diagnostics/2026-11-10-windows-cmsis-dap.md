# Windows CMSIS-DAP 偶发通信失败（2026-11-10）

## 用户报告，尚未真机复现

- EmberProbe 0.9.1，Windows；另一台电脑也出现过类似问题，触发条件未知。
- OpenOCD `0.12.0+dev-02228-ge5888bda3-dirty (2026-10-29)`。
- `CMSIS-DAP_JX`，VID/PID `C251:F001`，`cmsis-dap.cfg`、`stm32c5x.cfg`，transport `auto`。
- Windows 仍可枚举探针；只执行 `chip.read`、没有烧录时也会失败。
- 已确认重新插拔探针 USB 后恢复；仅停止会话、重启 VS Code 或其他工具能否恢复尚未验证。

```text
Error: error writing data: hid_write/WaitForSingleObject: (0x000003E5)
Error: CMSIS-DAP command CMD_INFO failed.
```

原诊断为 `FLASH_WRITE_FAILED`、category `flash`、stage `openocd_start`、retryable `false`。
这由共享诊断中的通用 `error writing` 匹配造成，不证明发生了 Flash 写入或写保护。

## 源码检查结果

`src/composition.js` 为同一 provider 构造一个 `ProbeCoordinator`。芯片读取、下载、独立采样、
Agent 临时读取、调试启动/服务器和目标扫描均使用其租约；共享调试组复用同一个 OpenOCD。
扫描可能并行打开不同候选探针，但扫描期间持有独占租约，不与本实例的其他操作并行。
USB 元数据枚举不启动 OpenOCD。

`chipInfo`、`faultInfo` 和目标身份读取使用 `runOpenOcdOnce`，启用 `waitForCloseOnTimeout`：
超时先终止子进程、500 ms 后仍运行则尝试 SIGKILL，等待 close 后返回，因此调用者不会因超时提前释放租约。
这也意味着进程始终不关闭时请求可能持续等待，不能视为已经释放。

`ManagedOpenOcdSession.stop()` 停止采样、废弃旧请求并尝试 Tcl shutdown；
`OpenOcdProcess.terminate()` 在等待后逐级终止进程，通过 exit 或 close 确认退出并关闭 Tcl 连接。
采样和 Agent 在退出未确认时保留会话/租约；调试 controller 将未确认退出转为
`DEBUG_SERVER_STOP_FAILED`，宿主和共享组保留服务器/租约，禁止再启动竞争操作。
正常扩展 shutdown 先关闭 Agent 和新探针访问，再清理已有会话。

本轮检查与模拟测试没有证明正常路径存在同一探针重复打开或提前释放租约。
这些保护只约束当前扩展实例；其他 VS Code 窗口、外部工具、强制终止扩展宿主后的残留进程仍需现场排查。
Windows 是否完成 HID I/O 取消、USB 端点是否恢复、探针固件是否恢复，不能由 JavaScript 租约或进程退出测试证明。

## 上游线索与证据边界

仓库的 `native/openocd/build-lock.json` 固定 OpenOCD e5888bda3 和 HIDAPI 0.15.0。
仅凭用户版本字符串不能确认其可执行文件与锁定构建及依赖完全相同。

[HIDAPI 0.15.0 Windows 源码](https://github.com/libusb/hidapi/blob/hidapi-0.15.0/windows/hid.c)
在 overlapped WriteFile 后等待写事件，等待结果不是 WAIT_OBJECT_0 时生成
`hid_write/WaitForSingleObject` 错误；显示的系统错误不能单独证明存在第二个访问者。
[上游 #686](https://github.com/libusb/hidapi/issues/686) 报告过相同字符串，涉及其他设备和固件，
只能作为后端/固件排查线索，不能直接认定本报告是同一个缺陷。

[OpenOCD HID 后端](https://github.com/openocd-org/openocd/blob/master/src/jtag/drivers/cmsis_dap_usb_hid.c)
将 hid_write 的失败打印为 `error writing data`，关闭时调用 hid_close/hid_exit。
这里的 write 是向探针发送命令；CMD_INFO 失败不能据此归因为目标 SWD 接线或 Flash 写保护。

## 本次修正与软件验证范围

- 添加 `PROBE_COMMUNICATION_FAILED`，保留明确的占用、权限、断开、原生崩溃优先级，
  优先于 init/timeout/Flash 错误；保留阶段、原始日志和连接参数。
- `failed to write` / `error writing` 需要同一行明确 Flash 上下文才匹配 Flash 写入失败。
- 提示停止相关会话、确认 OpenOCD 已退出，必要时重新插拔 USB 后手动重试；不自动重试或更改驱动。
- `openocd-parser.test.js` 覆盖原始日志、单独 CMD_INFO、读写错误、诊断优先级、Flash 阶段和真实 Flash 失败。
- `openocd-entrypoints.test.js` 覆盖下载、芯片读取、故障读取、独立采样及调试启动的诊断传播，
  并通过实际 ChipInfoService + 模拟子进程确认失败后 close 前仍阻止其他操作、close 后才释放。
- 既有退出清理、共享调试组及取消竞争测试用于检查相关不变量；软件测试不证明本报告的真机恢复。

本轮在 Windows x64、Node 24.13.1 完成 `npm run check`（529 项，0 失败）、
`npm run quality`（含覆盖率与安全模块门槛）、`npm run bundle` 和 `npm run test:e2e`
（VS Code 1.136.1，模拟调试/无硬件测试），均通过。首次沙箱检查受缺少依赖、回环访问及符号链接权限限制，
补齐锁定依赖并在允许本机测试的环境重新运行后通过。

## 下次故障时保留现场

1. 拔 USB 之前记录故障前最后一个操作、是否有调试/采样、其他 VS Code 窗口及调试工具。
2. 保存完整诊断与 OpenOCD 原始输出。只读检查进程，例如在 PowerShell 执行：
   `Get-CimInstance Win32_Process -Filter "Name = 'openocd.exe'" | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine`。
3. 停止相关会话并再次检查进程。若进程退出未确认，先完成停止清理，不并发启动其他工具。
4. 分别记录正常停止、关闭全部相关 VS Code 窗口后再打开、重新插拔 USB 是否恢复。
   比较其他工具前先关闭原工具，避免引入新的竞争；重启已恢复后不能再据此测试同一次故障的插拔恢复。
5. 若进程已退出仍失败，保留探针固件版本、实际 OpenOCD 路径及依赖版本，供独立比较后端和固件。
   重插恢复只说明重新建立 USB 连接能解除状态，不能单独定位哪一层出错。

本轮未操作真实探针、切换驱动、烧录或复位目标，也未发布更新。
