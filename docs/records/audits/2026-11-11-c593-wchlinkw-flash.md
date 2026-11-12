# STM32C593 使用 WCH LinkW 烧录失败审计

2026 年 11 月 11 日。工程为 `C:\Users\ASUS\Desktop\STM32Project\mc01_rc_all_cmake`。
用户日志与离线复现共同确认：内置 `stm32c5x.cfg` 的 `examine-end` 回调依赖未声明的全局变量，
在过程作用域中执行时无法设置 Flash loader，随后烧录以 `auto_probe failed` 结束。
本次失败可由脚本缺陷解释；不能据此认定 WCH LinkW 不支持该芯片或无线链路异常。

## 现场配置和镜像

通过目标工程 Agent Bridge 只读取得配置和 USB 枚举：

- 探针为用户选中的 `D861FE88D88E`，VID/PID `1A86:8012`，产品 `WCH-Link`。
- 接口为 `cmsis-dap.cfg`，调试接口 `MI_00` 使用 WinUSB；目标为 `stm32c5x.cfg`。
- `transport=auto`，`adapterSpeedKhz=0`；现有芯片读取日志确认实际为 CMSIS-DAPv2 和 SWD。
- 21:36:53 的芯片读取日志成功读到 Cortex-M33、DEV_ID `0x45A`、Flash 大小 `512 KiB`，链路时钟为 500 kHz。
- ELF 为 `build/debug_GCC_STM32C593RGT6/mc01_rc_all.elf`，修改时间为 2026-11-10 16:49:57，
  文件大小 3011840 字节，SHA-256 为 `7bd4337843695d8b0eb03b86ff7c5822656a3e4b4ff2dd9bf64f8e31d408b711`。
- ELF 的非空 PT_LOAD 段物理地址覆盖 `[0x08000000, 0x08025360)`，合计 152416 字节，约 149 KiB。
  文件本身包含调试信息，3 MB 的文件大小不代表需要写入 3 MB Flash。

用户失败输出中，首次 `examine-end` 已出现 `can't read "_CHIPNAME": no such variable`。
之后请求 10000 kHz，回退原时钟再次执行时仍出现相同错误，最后为 loader 未配置、
`auto_probe failed`、`Programming Failed` 和 `shutdown error`。

## 回调作用域缺陷

`native/openocd/0003-stm32c5x-target.patch` 中的回调只声明 `global EXAMINED`，
但读取了全局 `_CHIPNAME` 和 `dev_id_loader`。`0004-emberprobe-c5-local-loaders.patch`
将 loader 改为随包文件，仍保留这两个隐含依赖。

`skills/_emberprobe/openocd-flash.js` 在 `_ep_flash_program` 过程中调用 OpenOCD 的 `program`。
OpenOCD 事件通过 `Jim_EvalObj` 计算回调体，不能假设事件总在 Tcl 全局作用域执行。
相应实现可见 [OpenOCD target_handle_event](https://openocd.org/doc-release/doxygen/target_8c_source.html)。
这解释了顶层 `init` 的芯片读取可以成功，而过程内初始化或重新检查目标时 loader 初始化失败。

离线复现使用现场已安装的 OpenOCD，其二进制 SHA-256 与仓库 manifest 相符。
进程首先执行 `noinit`，禁用各服务器端口，读取已注册的回调体后直接计算；
寄存器操作、Flash 大小读取和 `stldr` 调用均被替换为桩。
未调用 `init` 或连接真实探针。`invoke-event` 本身要求初始化，因此复现使用回调体直接计算，
而不宣称执行了真实硬件事件。

| 回调执行方式 | 结果 |
| --- | --- |
| 顶层执行原回调 | 调用 C59x loader 的 `set_loader` 和 `set_size` |
| 过程内执行原回调 | 重现 `_CHIPNAME` 不存在，`EXAMINED=0` |
| 过程内仅补 `_CHIPNAME` 全局声明 | `dev_id_loader` 不可见，误报 loader 不存在，却设置 `EXAMINED=1` |
| 过程内同时补齐两个全局声明 | 调用正确 loader，设置大小 524288，`EXAMINED=1` |

复现脚本保存在本机忽略的生成目录 `test-results/diagnostics/c5-event-scope-repro.js`，运行命令为：

```powershell
node test-results/diagnostics/c5-event-scope-repro.js
```

四种情况的断言通过。这里的成功只证明回调作用域修正，真实 loader 的擦写和校验尚未验证。

最小修正是将回调声明改为 `global EXAMINED _CHIPNAME dev_id_loader`；更完整的修正应从
事件当前目标派生芯片名，并将 loader 初始化移入有明确变量作用域的过程。
初始化失败时不应继续标记 `EXAMINED=1`。上游来源补丁应保留原样，修正应进入 EmberProbe 补丁，
同步更新 Windows 和 Linux 运行时、对应源码包、构建身份及校验摘要。
直接修改全局缓存脚本不能形成可交付修复。

## 诊断和测试缺口

`skills/_emberprobe/openocd-diagnostics.js` 对这类 Tcl 回调错误没有专门分类，
通用分支从最后八行倒序取错误，使 `shutdown error` 成为原因。
用户返回的结构化诊断因此为 `OPENOCD_START_FAILED`、`retryable=true`，
提示检查供电和接线，且原始日志尾部已不包含变量错误。
应保留首个回调异常的有界上下文，并将脚本配置错误与目标连接失败区分，避免引导无效硬件重试。

`test/openocd-installer.test.js` 当前的 C5 检查只验证 target/bank 声明和三份 loader 文件存在，
然后在初始化前退出，没有在过程内执行 `examine-end`。
后续回归应覆盖原回调作用域、全部 DEV_ID 的 loader 选择和 loader 初始化失败状态。

## 另需核对的容量信息

工程选择 `STM32C593RGT6`，链接脚本允许 1 MiB ROM；现有芯片日志报告 512 KiB。
[ST 的 STM32C593RG 产品页](https://www.st.com/en/microcontrollers-microprocessors/stm32c593rg.html)
标称 1 MB Flash。应另行核对板上型号和容量寄存器含义，不能仅据该读数确定实际完整料号。
当前镜像未超过 512 KiB，此差异不能解释本次 Tcl 变量错误。

## 本轮边界

本轮完成配置读取、USB 元数据枚举、现有日志与 ELF 检查及无硬件离线复现。
没有修改工程配置、扩展实现或已安装运行时，没有擦写、复位、切换驱动或启动调试。
修复尚未落地，真机烧录成功与 WCH LinkW 的可靠速度范围仍需修复后单独验证。
