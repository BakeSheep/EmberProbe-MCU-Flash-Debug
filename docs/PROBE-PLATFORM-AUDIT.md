# 调试器识别与 Linux 预检审计

日期：2026-10-08。基线为 0.8.2 加本地 CMSIS-DAP 枚举/读取启动修复，保留所有已有未提交修改。
范围：CMSIS-DAP、ST-Link、J-Link 的 OS 枚举、自动识别、物理身份选择、只读 OpenOCD 能力预检；补查 XDS110/Nu-Link 自动识别边界。

## 已确认并修复的问题

| 优先级 | 问题 | 影响与修复 |
| --- | --- | --- |
| P1 | ST-Link 已知 ID 清单不完整 | 漏掉 `0483:3744/374d/3755/3757`；通用 USB 名称时三类系统都可能找不到单台探针。补齐清单；Windows PowerShell 候选过滤、原生枚举分类、Linux 和 macOS 使用相同识别规则。识别 ID 不保证该固件/模式能进行调试。 |
| P1 | Linux 只检查产品名称 | 未知 VID/PID 的 CMSIS-DAP v2 可以只在接口名称中标识自己。读取 sysfs 接口 `interface` 属性，归属到物理父设备，并继续使用父设备 serial；接口不单独计为探针。 |
| P1 | Windows 通用复合父设备掩盖 Flasher/J-Trace | 父节点先按 SEGGER VID 分类后，子接口排除判断没有消除该分类，可能误计为 J-Link。按整组接口排除；自动识别也不再把单独的 SEGGER 厂商名当作 J-Link。 |
| P2 | Linux 旧 ST-Link/V2 原始 UID 被过滤 | 旧固件可返回 12 个字节值组成的 Unicode 字符，而自动选择只接受安全 ASCII。对 ST-Link 的 OS 元数据按 OpenOCD 替代序列号规则转成 24 位大写十六进制；保留 UID 内的空白字节，用户配置输入验证保持严格。长度不符、超出单字节范围或无法完整读取时保持未知。 |
| P2 | Linux 读取错误被吞掉 | `idVendor` 错误被直接跳过，其他属性错误变成空字符串；权限/I/O 故障可能被报告为“在线清单为空”。现在仅允许缺失/拔出 (`ENOENT/ENODEV`)；其他错误返回清单不可用，诊断保留属性和错误码。 |
| P2 | Linux 枚举无整体时间预算 | 串行属性读取没有整体超时，无法保证读取启动及时返回。增加默认 2 秒预算、最多四个设备并发、设备数及属性字节预算，实际文件读取使用 AbortSignal。超时后返回清单不可用，不自动重试硬件操作。 |
| P2 | 自动选择仍依赖慢速外部枚举 | Windows 自动选择此前总启动 PowerShell，即使结构化枚举已加速。名称查询优先使用现有只读原生 API；Linux 名称取自 sysfs 产品/接口属性，自动识别复用结构化查询结果，避免再次枚举或依赖 lsusb。保留工具不可用时的有界回退。 |

证据来源：[OpenOCD ST-Link 当前接口及 VID/PID](https://github.com/openocd-org/openocd/blob/master/tcl/interface/stlink.cfg)、[0.12.0 ST-Link 替代序列号实现](https://github.com/openocd-org/openocd/blob/v0.12.0/src/jtag/drivers/stlink_usb.c)、[CMSIS-DAP v2 接口字符串识别](https://github.com/openocd-org/openocd/blob/v0.12.0/src/jtag/drivers/cmsis_dap_usb_bulk.c)、[Linux sysfs 产品、接口和序列号实现](https://github.com/torvalds/linux/blob/master/drivers/usb/core/sysfs.c)。

## 没有发现相同故障的路径与边界

- Linux 原路径已经只枚举 USB 物理设备目录，忽略 `:1.0` 等接口节点；未发现 Windows 那种把一台探针的多个接口重复计数的问题。本次仍保持一台物理设备一个记录。
- Linux 不执行 Windows PowerShell PnP 查询，也不需要 Windows WinUSB 驱动修复。sysfs 读取成功仅证明能读设备元数据，不证明能打开 USB 调试接口；已有 `LIBUSB_ERROR_ACCESS` 诊断仍提示 udev/用户权限，未更改系统规则或权限。
- 三种主要探针继续保持唯一序列号选择、重复序列号拒绝、记忆设备在线核验、不切换到其他设备，以及探针租约和写入授权。J-Link 十进制序列号归一化与 DAP/ST-Link 大小写、前导零规则保留。
- J-Link Windows 原生辅助工具优先，缺失时使用共享原生枚举；Linux 不触发 WinUSB 要求。未发现平台分支错误导致 Linux 被要求切换 Windows 驱动。
- XDS110/Nu-Link 仍可按名称自动识别，但没有本次三种主要探针的 OS 清单唯一身份预检。没有在无型号、序列号协议与硬件证据时扩展该保证；需要按各自协议另行实现和验收。
- 非 ASCII、超过当前安全字符集或无完整序列号的其他 CMSIS-DAP 固件，仍可能无法自动选择。不会为了绕过身份验证而默认打开第一台设备。
- macOS 未做真机验证；共享 ST-Link ID 清单修复使用软件夹具覆盖。

## 回归与硬件验证边界

新增 `test/probe-platform-audit.test.js`，覆盖 11 个 ST-Link ID 的三平台一致性、复合接口、跨系列同时在线、J-Link 序列号碰撞、Linux CMSIS-DAP 接口识别、旧 ST-Link UID、属性错误、设备拔出、无序列号、查询预算、自动识别回退和 Linux 权限诊断。普通测试不要求 OpenOCD 或已连接探针。

本次验证：

- Windows / Node 24.13.1：`npm run check` 共 366 项检查，零失败；`npm run quality`、`npm run bundle`、VS Code 1.136.1 的 `npm run test:e2e` 全部通过。总体行/语句覆盖率 86.10%、函数 91.67%、分支 83.59%。
- Ubuntu 26.04 WSL / Linux Node 24.13.1：`probe-platform-audit`、`probe-connection`、`probe-automatic`、`probe-connection-service`、`daplink-flash`、`windows-probe-inventory`、`openocd-entrypoints`、`openocd-compatibility` 八个软件回归全部通过。另从最终源码重复执行平台回归，验证实际 Linux 路径、含冒号接口目录、UTF-8 旧 UID 文件及带 AbortSignal 的文件读取。没有安装系统 Node，使用工作区内官方 SHA-256 校验后的便携运行库。
- 当前 Windows USB 元数据自动识别：首次约 53 毫秒，后续约 33 毫秒；正确返回唯一 `cmsis-dap.cfg` 候选。没有可用于同条件计时的真实 ST-Link/J-Link 或 Linux USB 探针，不能推断其实际下载/采样速度。
- 保留 [此前 DAPLink 审计及读取启动验证](DAPLINK-FLASH-AUDIT.md)；本次补充平台覆盖，不替代实际板级失败日志或 HIL。

本次没有初始化/复位/烧录真实 MCU，没有切换驱动、安装 udev 规则、修改 H750 测试工程或发布版本。真实 Linux USB、驱动/固件兼容性与烧录稳定性需专用板 HIL 补证。
