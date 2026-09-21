# J-Link 兼容性审计

日期：2026-09-20。审计版本：EmberProbe 0.7.9，提交 `5f968b206ed2be99a0ebfda9f68aa11d3152ce7a`。

后续状态：本报告保留修复前的发现与证据。2026-09-21 的实现与软件验收结果见[优化验收记录](JLINK-IMPLEMENTATION-2026-09-21.md)；真实 J-Link OB V9 等硬件项目仍明确列为未验证。

## 结论与证据边界

当前项目支持通过 OpenOCD 的 `jlink` 适配器使用 J-Link；这不等于对全部 J-Link/OB 硬件、固件、Windows 驱动组合提供了兼容保证。旧 SEGGER 驱动与 OpenOCD 的 USB 访问方式不兼容，是有官方依据的真实问题；但没有用户设备的完整日志、USB 身份和驱动绑定，不能认定其“V9 JLinkOB”已经命中此问题，更不能直接要求替换 `MI_02`。

本次确认了 6 项需要处理的问题：1 项较高风险的多探针身份限制，1 项默认传输配置陷阱，3 项运行时诊断缺陷，以及 1 项硬件验收入口缺陷。严重性用于安排修复顺序，不代表这位用户遭遇了所有问题。

本次进行了代码审阅、内置 OpenOCD 的纯配置执行、诊断函数重放、真实 MessageChannel 序列化实验和模拟 HIL 子进程实验。没有打开物理探针，没有运行 OpenOCD `init` 连接硬件，没有烧录、复位、替换驱动或更新探针固件，也没有实测 Ozone。生产代码保持不变。

## 审计范围

| 环节 | 审阅内容 |
| --- | --- |
| 自动检测 | 扩展与 Flash Skill 的 Windows/macOS/Linux 枚举、名称匹配、多探针候选 |
| 配置与预检 | 可执行路径、版本门槛、scripts 解析、SWD/JTAG、缺少的硬件身份参数 |
| 操作入口 | UI 烧录、Agent 烧录/校验、芯片/故障信息、独立采样、内置调试 |
| 诊断与呈现 | libusb/J-Link 日志、供电、占用、worker 消息、硬件版本信息 |
| 共存与退出 | 插件内部探针互斥、Cortex-Debug 会话交接、外部 Ozone 边界、采样清理 |
| 验证 | 普通测试、质量门槛、内置 OpenOCD 驱动能力、HIL 入口与验收证据 |

## 发现

### JLINK-01 — P1：多只 J-Link 无法绑定具体物理设备，烧录存在选错板风险

类型：已知设计限制，具有写入目标不确定性的风险；不是已复现的误烧录事件。

位置：`skills/_emberprobe/probe-detection.js:3`、`src/flashAuthorization.js:9`、`skills/_emberprobe/openocd-launch.js:15`。

检测返回的是探针类型集合，而非物理设备集合。同一类型的多只设备被折叠成 `jlink.cfg`；当前设置和标准启动参数没有传入 `adapter serial`。Agent 授权指纹中的 `probe` 也是配置文件名，不是物理序列号。

本地复现：

```js
probeCandidates("SEGGER J-Link OB\nSEGGER J-Link OB");
// ["jlink.cfg"]
```

内置 `interface/jlink.cfg` 只启用 `adapter driver jlink`，其中的 `adapter serial` 是注释。上游 OpenOCD 在未指定序列号时不检查序列号，J-Link 驱动按发现结果尝试打开设备。因此，两只可访问探针连接同型号目标时，当前插件不能保证操作落到用户想要的那块板；单探针场景不因此必然出错。

建议：按物理设备枚举和选择，持久化序列号并贯穿预检、所有启动入口和授权指纹；多个候选且未选择时阻止写操作。序列号缺失或重复时应报告歧义，不能把接口文件名当作唯一设备身份。若暂不支持多探针，应在写入前明确检测并拒绝歧义场景。

### JLINK-02 — P2：默认 auto 实际选择 JTAG，SWD 接线需要显式设置

类型：已复现配置陷阱；`auto` 保留脚本默认值本身符合已有设置说明。

位置：`package.json:160`、`skills/_emberprobe/openocd-launch.js:15`。

项目默认 `transport=auto`，意味着不添加 `transport select`。内置 J-Link 接口脚本没有选择 SWD。使用仓库中的 OpenOCD 二进制，并以 `noinit` 禁止硬件初始化，实际得到：

| 配置 | 输出 |
| --- | --- |
| `jlink.cfg` + `transport select` | `jtag` |
| `jlink.cfg` + `stm32f1x.cfg` + `transport select` | `jtag` |
| `jlink.cfg` + 显式 `transport select swd` + `stm32f1x.cfg` | `swd` |

因此，USB 驱动正常但仅接 SWDIO/SWCLK 的用户，也可能无法连接目标。它与 WinUSB 冲突是两类问题。当前设置说明已经提醒 J-Link 的 SWD 接线应选 `swd`，但自动检测和侧边栏选择探针的流程没有对应的协议确认入口。

建议：选择 J-Link 后显示当前协议和接线提示，要求用户明确选择 SWD/JTAG，或让板级配置提供有依据的默认值。保留用户显式选择，不通过失败后自动换协议、暂停或复位目标来猜测接线。

### JLINK-03 — P2：J-Link 原生日志漏分类，且占用错误附带不适用的驱动建议

类型：已复现诊断缺陷。

位置：`skills/_emberprobe/openocd-diagnostics.js:16`、`:52`、`:127`。

当前规则能够识别 `LIBUSB_ERROR_NOT_SUPPORTED`、`LIBUSB_ERROR_NOT_FOUND`、`LIBUSB_ERROR_BUSY` 等符号，但不能覆盖所有 J-Link 日志。

| 重放输入 | 当前分类 | 应如何处理 |
| --- | --- | --- |
| `Error: No J-Link device found` | `OPENOCD_START_FAILED` | 识别为未发现/无法访问探针；不能仅据此断言驱动损坏 |
| `Error: Failed to open device: unspecified error` | `OPENOCD_START_FAILED` | 至少识别为设备打开失败并保留原因，结合其他日志归因 |
| `Error: LIBUSB_ERROR_NOT_SUPPORTED` | `PROBE_DRIVER_UNSUPPORTED` | 当前分类正确 |
| `Error: LIBUSB_ERROR_BUSY` | `PROBE_BUSY` | 分类正确，但建议列表同时包含旧 SEGGER 驱动冲突说明 |

`No J-Link device found` 和 `Failed to open device: %s` 均存在于内置 `openocd.exe` 的字符串中，并与上游 J-Link 驱动源代码一致。通用打开失败本身不应被提升为“必须换驱动”。

占用、权限、断开、不支持目前复用 `usbActions`。对已明确的 `BUSY` 继续展示驱动冲突提示，会模糊“另一个程序占用”和“驱动不兼容”的区别。

建议：使用来自 J-Link/libjaylink 的真实日志样本补全分类，并按错误类型提供建议；BUSY 优先让用户释放设备，NOT_SUPPORTED 才重点核查驱动，NOT_FOUND 保留设备选择、接口、断开和驱动等多个可能原因。未知错误保留原文，不猜测具体 USB 接口。

### JLINK-04 — P2：J-Link 电压日志没有被解析，硬件版本信息也未结构化保留

类型：已复现日志兼容缺陷；不是对用户目标板供电状态的判定。

位置：`src/openocdRunner.js:42`、`skills/_emberprobe/openocd-diagnostics.js:100`、`src/chip/parser.js:189`。

当前电压解析主要接受 `Target voltage: ...`，而 J-Link 驱动实际使用 `VTarget = %u.%03u V`。该格式已在内置二进制和上游源代码中核对。

本地结果：

```text
parseLine("Info : VTarget = 3.300 V") -> null
parseLine("Info : VTarget = 0.000 V") -> null
diagnose(["Info : VTarget = 0.000 V", "Error: init failed"])
  -> TARGET_NOT_CONNECTED
```

芯片信息解析器接收 J-Link 固件行、`Hardware version: 9.00`、`VTarget = 3.300 V` 后，能保留探针名称/固件原文，但 `probeVersion` 与 `voltage` 仍为空。用户因此难以通过插件区分硬件版本和查看参考电压。

建议：统一支持两种电压格式，分别保存硬件版本、固件描述、型号和序列号；缺失值仍应保持未知。对于 OB，要结合该实现是否具备有效电压测量能力解释数值；报告低参考电压不等于已经证明目标芯片断电。

### JLINK-05 — P2：采样 worker 边界丢失诊断字段

类型：已通过真实 MessageChannel 复现，影响所有探针，J-Link 驱动排障尤其依赖这些字段。

位置：`src/samplingWorker.js:18`、`:36`、`:75`；接收端 `src/samplingSession.js`。

两条错误路径行为不同：

- 请求失败只复制 `message`、`code`、`details`，丢失 `category`、`likelyCause`、`suggestedActions`、`retryable`、`i18nKey` 和 `i18nParams`。
- `onDisconnect`/`onDegraded` 事件直接发送 `Error`。经过结构化克隆后，自定义的 `code`、`details`、建议和国际化字段没有保留；标准错误消息仍保留。

本地注入一个 `PROBE_DRIVER_UNSUPPORTED` 错误：启动失败接收端仍有错误码和原始日志，但没有操作建议；断开事件接收端只剩标准 Error 信息，没有错误码和日志详情。仅直接测试 `ManagedOpenOcdSession` 不能覆盖实际隔离线程路径。

建议：为请求和事件使用统一的普通对象错误序列化协议，接收端按同一协议还原；回归测试必须跨真实 worker/MessageChannel 检查诊断字段。除线程协议外，侧边栏和 Agent 的呈现也应显式保留可展开的诊断详情。

### JLINK-06 — P2：HIL 入口不能直接验证 J-Link SWD 配置，校验标记也过宽

类型：已复现验收缺陷；不代表曾经发生实际误报的硬件运行。

位置：`test/hil/run-hil.js:74`、`:87`、`.github/workflows/hil.yml`。

HIL 直接拼装相对 `interface/...` 和 `target/...` 参数，没有使用共享启动解析，也没有传输协议、序列号或速度参数。对于内置 `jlink.cfg` 和仅 SWD 接线，不能复现扩展中的显式 SWD 配置；相对脚本来源也与生产入口的绝对路径、固定 cwd 策略不一致。

另外，HIL 的校验标记正则接受 `shutdown command invoked`。本次完全替换其子进程为模拟进程，仅输出这行文字并以 0 退出，HIL 即返回 `ok:true`。这说明额外的“校验标记”检查不能证明程序确实执行了校验；正常 OpenOCD 的退出码仍是另一层保障。

建议：复用生产启动构造并明确协议、设备身份；只接受真实成功校验标记或专门的结果协议，覆盖非零退出、仅 shutdown 和缺少校验标记的情况。增加 J-Link/OB 的硬件与驱动维度，不能只按 MCU 型号划分 HIL。

## 确认存在的边界与待优化能力

以下不全部属于实现错误，但对支持承诺和故障处理有直接影响。

1. **OB 的驱动支持取决于具体实现。** SEGGER 明确写明 J-Link-OB-K22-NordicSemi 在 Windows 下不支持官方 WinUSB/driverless 模式；LPC-Link2 的 OB 固件则在 2023-05-02 的记录中加入了 WinUSB 支持。因此不能把 BASE/PLUS 的 V12 门槛套到全部 OB，更不能按网购标题“V9”决定驱动方案。这两种例子均不能据此认定为用户手里的设备。
2. **官方 WinUSB 模式与强制更换驱动有区别。** 旧设备通过第三方工具绑定 WinUSB 后能否用于 OpenOCD，以及 SEGGER 软件能否继续访问，要按实际设备验证。官方不支持 driverless 模式不自动等价于“强制绑定 WinUSB 后 OpenOCD 永远不能工作”。
3. **没有 USB 驱动身份预检。** Windows 主检测路径只读取 FriendlyName；没有 VID/PID、接口号、服务/驱动、硬件版本和物理设备数量信息。`MI_02` 不在代码中写死，也没有证据证明它适用于用户的 OB。名称检测与连接验证应分开呈现。
4. **版本预检不是能力预检。** `probeOpenOcd()` 主要运行 `--version`。本次内置二进制的 `adapter list` 确认含 `jlink { jtag swd }`，排除了内置包完全未编译 J-Link 驱动的猜测；但其他厂商构建即使版本达标，也仍可能缺少该驱动或相应能力。
5. **缺少标准的 adapter speed 参数。** 当前诊断建议降速，但设置、Agent 配置和共享启动构造没有统一的速度选项。用户只能依赖脚本默认值或自行维护受支持 scripts 目录中的配置；采样间隔不是 SWD 时钟，调低采样频率不能替代降低链路时钟。
6. **外部 Ozone 没有协调协议。** ProbeCoordinator 管理插件内部操作，VS Code 的 EmberProbe/Cortex-Debug 会话也有交接逻辑；独立 Ozone 进程不在这个状态机里。启动两个程序不是必然失败，两个进程实际争用同一探针才涉及所有权问题。当前不能承诺它们同时控制同一探针进行采样。
7. **Cortex-Debug 的兼容桥不等于 Ozone 集成。** 现有桥按 DAP 能力在暂停状态读写内存；运行中共享采样依赖插件管理的 OpenOCD 服务。不能把外部 SEGGER GDB Server 的暂停读取宣传成非侵入实时采样，也没有证据证明所有适配器都提供所需 DAP 请求。
8. **跨平台边界不同。** Windows 驱动替换建议不能用于 Linux/macOS。项目已有平台分支：Linux 提示 udev/权限，macOS 提示识别与占用；本次只在 Windows 执行，没有在其他系统实测。
9. **不应混用“无需修改固件”和“任何情况下都不影响目标”。** 采样启动代码没有主动发出 `halt`/`reset`，但具体 OpenOCD target 脚本、目标低功耗、安全保护、缓存和运行中内存可访问性仍影响行为。J-Link 能烧录成功不证明全部运行中读取场景都可用。

## 已检查且没有发现对应缺陷的部分

- `J-Link OB`、`JLink OB V9`、`SEGGER J-Link OB` 都可匹配 `jlink.cfg`，没有按 V9 或 OB 名称拒绝连接的逻辑。
- 内置 OpenOCD 可执行，包含 `jlink` 驱动以及 JTAG/SWD 能力。
- 生产启动入口共享绝对 scripts 解析；显式 `swd` 放在 interface 之后、target 之前，入口回归测试通过。
- USB 错误在普通短期进程中先分类再裁剪展示，已有碎片日志覆盖；不能因此推导 worker 的所有字段也被保留。
- UI 烧录和 Agent 烧录走 OpenOCD；Agent 烧录的 ELF 哈希、一次性授权和文件快照机制存在，传输协议变化会使授权失效。物理探针身份仍是 JLINK-01 所述缺口。
- 插件内部有探针租约和调试交接；停止会话会尝试关闭自身 OpenOCD。没有发现自动替换 USB 驱动或自动更新 J-Link 固件的逻辑。
- 混合探针类型不会在没有显式配置时静默按优先级选一个；同类型多设备仍存在 JLINK-01。

## 本地验证结果

环境：Windows x64，Node.js 24.13.1。内置二进制报告：

```text
xPack Open On-Chip Debugger 0.12.0+dev-02228-ge5888bda3-dirty
(2025-10-04-22:44)
```

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 203 files checked；0 failed |
| `npm run quality` | ESLint、Prettier、类型检查、覆盖率门槛及 coordinator 门槛通过 |
| 覆盖率 | 行/语句 85.15%，函数 89.04%，分支 76.71% |
| 内置 OpenOCD `--version` / `adapter list` | 通过，确认 J-Link 支持 |
| `noinit` 下 auto 与 swd 对照 | 分别选择 JTAG 与 SWD |
| 诊断重放 | 复现 J-Link 缺失日志漏分类、BUSY 附带驱动建议、VTarget 漏解析 |
| 真实 MessageChannel | 复现请求/事件两条路径的诊断字段损失 |
| 模拟 HIL 子进程 | 复现缺少协议参数与仅 shutdown 标记也通过的行为 |
| 真机、Ozone、驱动切换、HIL | 未运行 |
| 新的 bundle / Extension Host E2E | 未运行；本次只新增审计文档，没有生产代码改动 |

以上通过项不意味着新发现的问题已修复。现有测试主要证明既有合约，缺少真实 J-Link 日志样本、worker 错误字段和实际设备组合覆盖。

纯软件协议检查可在解压后的内置 OpenOCD 目录执行；每条都显式使用 `noinit`，不接触物理探针：

```powershell
& .\bin\openocd.exe -c noinit -c "adapter list" -c shutdown
& .\bin\openocd.exe -s .\openocd\scripts -c noinit -f interface/jlink.cfg -f target/stm32f1x.cfg -c "transport select" -c shutdown
& .\bin\openocd.exe -s .\openocd\scripts -c noinit -f interface/jlink.cfg -c "transport select swd" -f target/stm32f1x.cfg -c "transport select" -c shutdown
```

诊断复现可在仓库根目录执行：

```js
const { diagnoseOpenOcdFailure } = require("./skills/_emberprobe/openocd-diagnostics");
const { parseLine } = require("./src/openocdRunner");
const details = { platform: "win32", probe: "jlink.cfg" };
console.log(diagnoseOpenOcdFailure(["Error: No J-Link device found"], details));
console.log(diagnoseOpenOcdFailure(["Error: LIBUSB_ERROR_BUSY"], details));
console.log(parseLine("Info : VTarget = 3.300 V"));
console.log(diagnoseOpenOcdFailure(["Info : VTarget = 0.000 V", "Error: init failed"], details));
```

## 建议修复顺序与真机验收

1. 先处理物理设备歧义，尤其是烧录/实时写入；初期可以采用明确的单探针限制。
2. 补齐真实 J-Link 日志解析、按原因提供建议、worker 诊断传递和探针版本/电压信息；这些改动不需要引入第二套调试后端。
3. 改善传输协议选择，并统一速度配置；明确区分 USB 访问失败与 SWD/JTAG 目标连接失败。
4. 修正 HIL 启动和成功判据，再建立硬件验收矩阵。
5. 基于真实用户设备的数据，再决定是否值得引入 SEGGER 原生后端。当前证据不足以据此要求架构迁移。

待验收至少包含：旧 SEGGER 驱动 J-Link、官方 WinUSB 模式设备、准确型号的 J-Link OB、用户的“V9 JLinkOB”、同类型双探针、Ozone 释放/占用两种状态、SWD/JTAG 显式配置、正常与低参考电压、拔插和调试/采样切换。每次记录 OS、扩展版本、OpenOCD 构建、OB 完整固件字符串、硬件版本、VID/PID/接口号、驱动绑定、序列号和目标 MCU。

先做经授权的连接与读取验证；只有指定测试板与明确写入授权后再做烧录/写内存。不得通过修改用户现有驱动或复位目标来代替缺失的故障证据。

## 官方与上游依据

- [SEGGER OpenOCD 说明](https://kb.segger.com/OpenOCD)：旧驱动切换及对 SEGGER 软件的影响；新款默认 WinUSB 的例外。
- [SEGGER WinUSB driver selection](https://kb.segger.com/WinUSB_driver_selection)：官方模式、历史驱动和 Windows/Linux/macOS 区别。
- [SEGGER J-Link OB](https://kb.segger.com/J-Link_OB)：OB 包含多种硬件实现。
- [J-Link-OB-K22-NordicSemi](https://kb.segger.com/J-Link-OB-K22-NordicSemi)：此实现不支持官方 Windows driverless/WinUSB 模式。
- [LPCXpresso on-board 固件记录](https://www.segger.com/products/debug-probes/j-link/models/other-j-links/lpcxpresso-on-board/)：特定 OB 在固件更新中增加 WinUSB 模式。
- [OpenOCD 适配器配置](https://openocd.org/doc/html/Debug-Adapter-Configuration.html)：驱动编译能力、adapter serial 和协议/时钟配置。
- [OpenOCD J-Link 驱动源码](https://raw.githubusercontent.com/openocd-org/openocd/master/src/jtag/drivers/jlink.c)：libjaylink 连接、设备选择、日志与 VTarget 格式。master 只作为机制与字符串交叉核对，不等同于内置二进制的精确源码版本。
- [OpenOCD 发布版文档中的 libjaylink USB 发现源码](https://openocd.org/doc-release/doxygen/discovery__usb_8c_source.html)：USB 身份与 libusb 打开机制；不把该版本 PID 表当作当前内置包的完整支持列表。

证据纠正：此前讨论中的 BASE/PLUS 版本表只适用于相应产品；本报告不把它用于判断用户的 OB。截图中的操作建议被视为待核实材料，没有当作执行换驱动的授权或技术事实。
