# Linux CMSIS-DAP 芯片读取崩溃诊断

日期：2026-10-08。扩展版本：0.8.2。测试工程：`H750_RTOS_CPP_Test`，IOC 标识
`STM32H750VBT6`，目标配置 `stm32h7x.cfg`。

## 已观察到的证据

- VS Code 芯片信息日志在 21:22 至 21:27 多次出现
  `*** buffer overflow detected ***: terminated`，没有输出 CMSIS-DAP 固件信息、DP IDR 或芯片身份。
- 另一个工程的 J-Link / `stm32f4x.cfg` 读取成功。两者都打印 OpenOCD 0.12.0。
- 本机系统可执行文件为 `/usr/bin/openocd`，Ubuntu 包版本 `0.12.0-3build3`，
  动态链接 `libhidapi-hidraw.so.0`。配置阶段的 `noinit` 检查通过，不触发探针初始化。
- 用户接回探针后，Linux sysfs 返回唯一 CMSIS-DAP：`CMSIS-DAP_JX`，
  VID:PID `c251:f001`，序列号 `0001A0000000`，包含 CDC、DCI 和 HID 接口。

## 无硬件对照复现

在临时目录编译 HIDAPI 测试替身，以 `LD_PRELOAD` 仅注入被测进程。
替身返回一台虚拟 CMSIS-DAP 和序列号 `0001234`，替换 `hid_init`、`hid_enumerate`、
`hid_free_enumeration` 和 `hid_open_path`；打开函数始终返回失败，并打印证明已完成序列号匹配的标记。
显式选择 HID 后端，不加载 target；因此不接触真实 USB 接口、不读取 MCU、不复位或烧录。

| 可执行文件 | 指定序列号 | 结果 |
| --- | --- | --- |
| 系统 `/usr/bin/openocd` | `0001234` | `SIGABRT`，相同 buffer overflow 日志，未进入替身打开函数 |
| 系统 `/usr/bin/openocd` | 不指定 | 到达替身打开函数，再正常报告无法打开设备 |
| 系统 `/usr/bin/openocd` | 不匹配的 `0009999` | 同样 `SIGABRT`，说明崩溃发生于比较前的转换 |
| xPack OpenOCD 0.12.0-7 | `0001234` | 到达替身打开函数，再正常报告无法打开设备，无原生崩溃 |

该对照确认本机系统二进制存在 HID 序列号转换缺陷，能解释现有日志。
原始失败日志没有调用栈，因此不把日志单独视为函数级定位证据。

OpenOCD 0.12.0 的 `cmsis_dap_hid_open` 用 `(strlen(serial) + 1) * sizeof(wchar_t)`
分配字节数，随后错误地把这个字节数作为 `mbstowcs` 的宽字符个数。带 glibc 强化检查的构建会终止进程。
上游 [e01e180f](https://github.com/openocd-org/openocd/commit/e01e180f6248590348bad5c354c6b4e0cf1a956a)
改为计算宽字符数，再按 `sizeof(wchar_t)` 分配。

## 修复路径与范围

核对 `v0.8.1..HEAD` 的启动路径后，确认 0.8.1 在 `prepareProbeConnection` 中会清空所有
非 J-Link 探针的序列号；0.8.2 移除该清空逻辑，为 CMSIS-DAP 枚举、选定并传入精确序列号。
因此旧插件可以避开系统 OpenOCD 的缺陷，而 0.8.2 会触发它。这是新增物理身份选择与旧系统
OpenOCD 之间的兼容性回归；用户“之前正常”的反馈与该因果链一致，不能据此推断 OpenOCD
最近被系统更新过。模拟对照已验证相同系统二进制在有/无序列号时的差异。

使用包含上游修复的 OpenOCD，并保留精确序列号选择及配套 scripts；不清空序列号、不固定选择第一台探针。
已准备 [xPack OpenOCD 0.12.0-7](https://github.com/xpack-dev-tools/openocd-xpack/releases/tag/v0.12.0-7)
Linux x64，下载包 SHA-256 与官方 `.sha` 文件一致：

```text
94b3790983beaf8ed57e646c0620dd66d705fddae03d290823a6ed3b439468d6
```

本地修复包位于仓库忽略的 `.emberprobe-tools/xpack-openocd-0.12.0-7/`，不是发布产物。
需在 VS Code 侧栏配置其中的 `bin/openocd`。本机 H750 工程缺少 Bridge 描述文件，
无法通过 Agent Bridge 修改或验证该工作区；OpenOCD 路径也属于 Bridge 的只读配置项。

扩展增加 `OPENOCD_NATIVE_CRASH`，原生崩溃优先于普通连接/权限提示，
Linux CMSIS-DAP 且指定序列号时提示上游修复，并禁止在前置条件不变时自动重试。
单次 OpenOCD 执行保留真实可执行路径和终止信号。

正常测试使用模拟子进程，覆盖日志/信号崩溃、诊断优先级、Linux CMSIS-DAP 专用提示范围，
并继续验证精确序列号传递；不要求已连接探针。
软件检查环境为 Linux x64 / Node 22.22.3：

- `npm run check`：366 项检查通过，0 失败。
- `npm run quality`：ESLint、Prettier、类型检查及覆盖率门禁通过；
  行/语句 86.31%、函数 91.51%、分支 83.64%。
- `npm run bundle`：通过（由 `test:e2e` 执行）。
- `npm run test:e2e`：VS Code 1.136.1 Extension Host 通过。
  首次被沙箱内只读的 `/run/user/1000` 阻断；改用权限 0700 的临时 `XDG_RUNTIME_DIR`，
  同时通过绝对 `WAYLAND_DISPLAY` 连接原显示服务后通过。没有修改测试源文件或关闭安全检查。
- `git diff --check`：通过。

已请用户在 H750 工程侧栏切换到修复包并点击读取；实板结果尚待确认。
上述模拟和软件检查不证明本板烧录、调试或长期采样稳定性，未执行这些硬件操作。
