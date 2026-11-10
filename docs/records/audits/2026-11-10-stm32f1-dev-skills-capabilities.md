# STM32F1DevSkills 与 EmberProbe 能力对照审计

审计日期：2026-11-10。

## 范围与判定方法

- 外部仓库：[keysking/STM32F1DevSkills](https://github.com/keysking/STM32F1DevSkills)，提交 `2586bb50c0a7f58fef923ca99f6880164e53d892`，插件清单版本 `0.1.1`。
- 对照对象：EmberProbe 当前工作区，`package.json` 版本 `0.9.1`，基准提交 `33f761a816c19a1c2a0ffca725c9e375b4f38fba`，包含审计时已有的未提交修改。结论不代表已发布 VSIX 的状态。
- 已盘点外部全部七项 SKILL 和 35 份 reference 的目录/主题，并阅读各 SKILL 及与差异相关的关键参考；对照本地技能、Agent 路由、MCP 目录和相关实现。
- 这是静态能力对照，不是全部命令/API 的正确性验证。没有安装技能、运行外部命令示例、调用硬件、编译目标固件或验证三平台行为。
- “缺少”指插件没有专门交付的工具接口或技能参考。通用编码 Agent 可以自行写 C/CMake 或执行本机命令，不等于 EmberProbe 已提供相应能力。

## 结论

存在可补足的能力，但要区分开发知识、工作流和工具后端。

STM32F1DevSkills 是指令和参考资料包，不包含工具、SDK、固件二进制或运行包装脚本。它通过 Agent 调用已安装的 CubeMX、CubeCLI、CMake、GCC、CubeProgrammer 和 ST-Link server。EmberProbe 则提供实际执行的 Bridge/MCP、VS Code 调试器及硬件会话管理。

最值得吸收的是新建工程、构建、F1 配置知识和固件实现指导。串口 ROM Bootloader、CubeProgrammer 和 ST-Link server 是额外的工具路线，若要成为插件能力，需要另行实现集成。

## 七项技能对照

| 外部技能 | 对方交付的内容 | EmberProbe 当前覆盖 | 判定 |
| --- | --- | --- | --- |
| `stm32f1-env` | CubeCLI/Java/CubeMX/CubeF1/GCC/CMake/Ninja 的发现、版本检查、依赖恢复 | 有 OpenOCD 检测/安装、CubeMX 与固件包检查/交互安装入口，以及调试工具链发现；没有统一的 CMake/Ninja/GCC 构建环境工作流 | 部分覆盖，缺构建环境与 Bundle 管理指导 |
| `stm32f1-project` | 准确选型、从零创建 F1 CMake 工程、接手工程/例程、无 IOC/SPL 工程的维护边界 | CubeMX 集成以已存在的 `.ioc/.ioc2` 为前提；没有创建工程入口 | 缺少专门的创建和接手工程技能 |
| `stm32f1-configure` | 传统 CubeMX 查询模式、候选参数、引脚/DMA/IRQ，附 F1 外设配置参考 | 已有 IOC 读取、候选修改、隔离生成和检查；`cubemx.query` 只接受 `.ioc2`，没有传统 CubeMX 的同类动态能力查询接口 | 配置修改已覆盖；传统查询接口和 F1 专题知识不足 |
| `stm32f1-firmware` | HAL/LL 应用、异步缓冲区、驱动移植、FreeRTOS/CMSIS v1/v2、Flash 参数存储和启动布局 | 技能侧重配置、烧录和观测，没有对应的应用开发参考包 | 缺少专门的固件开发知识层 |
| `stm32f1-build` | CMake 预设、Ninja/GCC、添加应用目标、链接诊断、BIN/HEX 生成、ELF/map 核对 | 已有 ELF/map/linker script 内存分析；无专门的固件构建 Bridge/MCP 方法或构建技能 | 构建流程缺少；产物分析已覆盖 |
| `stm32f1-flash` | CubeProgrammer SWD 烧录/校验和系统串口 Bootloader 流程 | 已有 OpenOCD 烧录/校验、探针选择与授权；无 CubeProgrammer/UART 下载后端 | 常规功能重叠，工具和传输路线有增量 |
| `stm32f1-debug` | ST-Link GDB server 使用及 F1 启动、DMA、外设、RTOS 故障排查清单 | 已有原生 GDB/MI 调试、保留现场 attach、异常分析、SVD、变量和 FreeRTOS 检查；实验性支持外部 GDB attach | 调试基础覆盖；F1 排障参考与 ST server 生命周期集成不足 |

本地执行入口的完整目录见 [agentRoutes.js](../../../src/services/agentRoutes.js) 和 [MCP tools](../../../src/mcp/tools.js)。没有独立的 `project.create`、固件 `build`、Programmer 或 UART Bootloader 方法。

## 具体增量

### 1. 从准确料号创建工程

对方明确区分商业料号 CPN、CubeMX RefName 和共享数据库模型。例如 C8T6 的选择、64 KiB Flash/20 KiB RAM、SWD 保留、保存后独立重载再生成均有操作参考。

EmberProbe 当前 [mcu-cubemx](../../../skills/mcu-cubemx/SKILL.md) 要求已有项目；[项目解析](../../../src/services/cubemxService.js) 缺少 IOC 时返回 `CUBEMX_IOC_MISSING`。因此，从零创建并不是现有再生成接口已经具备的能力。

外部依据：[创建工程](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-project/references/create.md)、[接手工程](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-project/references/existing.md)。

### 2. 固件构建与工具依赖工作流

对方指导 Agent 读取现有 presets/toolchain、配置和构建、管理当前进程 PATH、增加应用目标、处理链接与 ABI 问题、生成 BIN/HEX，并核对实际产物。另有 CubeCLI Bundle 的按版本/按项目安装恢复参考。

EmberProbe 的 [工具链发现](../../../src/services/stToolchainDiscovery.js) 服务于调试，不等于构建系统。[mcu-cubemx](../../../skills/mcu-cubemx/SKILL.md) 只要求在已有构建命令可用时执行它；生成结果明确标记 `build: "notRun"`。插件没有专门交付完整构建方法。

外部依据：[构建参考](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-build/references/cmake.md)、[编译链接诊断](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-build/references/errors.md)、[安装恢复](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-env/references/install.md)。

### 3. 传统 CubeMX 的动态能力查询

对方提供 `get mode_param_possvalue`、`get functions`、`possible_value`、DMA 请求和 NVIC 查询，并说明在查询不足时如何只读检查安装数据库。价值是先取得合法模式/参数和目标条件，再修改配置。

EmberProbe 的传统 IOC inspect 读取已有 Properties；候选生成校验语法及 IP/Pin 索引结构，不能由此证明引脚冲突、时钟有效性或外设兼容性。[cubemx.query](../../../src/services/cubemxService.js) 对传统 IOC 明确返回 `CUBEMX2_PROJECT_REQUIRED`。这与 `.ioc2` 已有的 CLI 查询能力是不同边界。

外部依据：[配置操作基础](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-configure/references/operations.md)。本地依据：[候选生成](../../../src/services/cubemxCandidate.js)、[技能的验证范围说明](../../../skills/mcu-cubemx/SKILL.md)。

### 4. F1 固件与外设知识

具体包括 AFIO/SWJ 重映射、固定 DMA 通道、UART ReceiveToIdle 的 HT/TC/IDLE 与环回处理、LL 的 SR/DR 读取所有权，以及时钟、ADC、CAN/USB、RTC、低功耗等配置/应用约束。

这不是插件“不能访问这些外设”，而是缺少针对这些任务的开发参考。插件现有 SVD 和寄存器工具能取证、修改寄存器，并不自动替代驱动设计与代码实现。

外部依据：[配置技能索引](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-configure/SKILL.md)、[固件技能索引](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-firmware/SKILL.md)。本地依据：[mcu-peripheral-debug](../../../skills/mcu-peripheral-debug/SKILL.md)。

### 5. FreeRTOS 开发、CMSIS 适配层与持久化存储

对方提供任务、队列、同步、ISR 交接、栈和时间单位的开发参考，并记录特定 CubeF1 CMSIS v1/v2 适配层行为。这些版本相关描述仍需按项目实际 SDK 源码复核，本审计没有独立验证其正确性。

EmberProbe 的 [mcu-rtos](../../../skills/mcu-rtos/SKILL.md) 已覆盖暂停态任务、调用栈、优先级和栈填充估计，缺的是开发指导。对方另有片内 Flash 参数存储、掉电恢复和 bootloader/VTOR 布局参考；主机端烧录功能不能替代固件内的存储设计。

外部依据：[FreeRTOS 开发](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-firmware/references/freertos.md)、[CMSIS v1](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-firmware/references/freertos-cmsis-v1.md)、[存储与启动布局](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-firmware/references/storage.md)。

### 6. CubeProgrammer 与 UART ROM Bootloader

对方给出 CubeProgrammer 的 ST-Link SWD 及 UART 系统 Bootloader 下载参考，包括串口枚举、BOOT 状态、器件识别、写入校验和恢复启动状态。这是明确不同于 OpenOCD 探针下载的路线。

EmberProbe [mcu-flash](../../../skills/mcu-flash/SKILL.md) 和 Agent 烧录接口围绕 OpenOCD 与 ELF，没有 UART Bootloader 后端。对方关于读保护、选项字节和擦除的内容主要是边界与恢复指导，不应额外算成已经实现的完整保护管理工具。

外部依据：[下载与校验](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-flash/references/program.md)、[连接恢复](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-flash/references/recovery.md)。

### 7. ST-Link server 与 macOS CubeMX 路线

对方说明发现、启动、选择探针、附加和清理 ST-LINK_gdbserver。EmberProbe [debugConfiguration](../../../src/services/debugConfiguration.js) 的托管后端是 OpenOCD；[externalDebugService](../../../src/services/externalDebugService.js) 已支持实验性外部 GDB attach，因此缺少的是 ST server 专门托管，不是完全不能使用外部服务器。

对方也有 macOS CubeMX 启动参考；本地 [cubemxEnvironment](../../../src/services/cubemxEnvironment.js) 的传统 CubeMX 平台门禁仅接受 Windows/Linux。不过，对方 README 明确 Linux/macOS 仅做文档与命令形式核对，不能据此宣称其 macOS 功能已实测。

外部依据：[GDB/ST-Link](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-debug/references/gdb.md)、[CubeMX 三平台启动](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/skills/stm32f1-env/references/mx-cli.md)、[适用边界](https://github.com/keysking/STM32F1DevSkills/blob/2586bb50c0a7f58fef923ca99f6880164e53d892/README.md)。

## 不应误报为缺失的功能

- **ELF/map 内存占用分析**：已有 [mcu-elf-analyze](../../../skills/mcu-elf-analyze/SKILL.md)，支持 `.map/.ld` 区域容量、使用量和最大符号。
- **HEX/BIN 下载与偏移布局**：独立 Agent flash 接口限定 ELF，但原生调试器的 [debugImages](../../../src/services/debugImages.js) 已支持 `loadFiles` 的 ELF/HEX/BIN、BIN 地址、ELF/HEX 偏移，以及多符号文件。不能概括成插件完全不支持 BIN/HEX。
- **FreeRTOS 诊断**：已有任务快照、调用栈和变量检查；对方增量主要在实现任务及 API 使用参考。
- **HardFault、外设寄存器、保留现场 attach**：已有 [异常分析](../../../skills/mcu-fault-analyzer/SKILL.md)、[外设检查](../../../skills/mcu-peripheral-debug/SKILL.md) 和 [调试控制](../../../skills/mcu-debug-control/SKILL.md)。
- **CubeMX 配置修改及用户代码保护**：已有隔离 baseline/candidate、漂移检查、并发检查、备份和确认流程，详见 [生成管线](../../design/cubemx-pipeline.md)。对方的操作清单不等于新增了一套同级执行保护。
- **独立于 VS Code 执行**：外部技能可直接使用本机工具，这是部署方式差异；不能当作新增的 MCU 功能，也不能在 Bridge 拒绝操作时作为绕过路径。

## 建议的吸收顺序

1. **先补技能参考**：工程创建/接手、CMake 构建、HAL/LL 应用与 FreeRTOS/CMSIS 开发。通用流程与 F1 专题分开，避免把插件整体锁定到 F1。
2. **补传统 CubeMX 只读查询**：优先提供受限模式/引脚/候选值/DMA/IRQ 查询，给现有候选修改流程提供依据；不开放任意脚本执行。
3. **再评估专门执行接口**：创建工程和固件构建需要明确目录、工具链、产物及取消/清理语义；UART Bootloader 需要独立设备识别、串口所有权和写入授权设计。
4. **按实际需求决定其他后端**：CubeProgrammer SWD 和 ST-Link server 与现有 OpenOCD 路线重叠较多；macOS CubeMX 需要目标平台验证后再宣称支持。

如复用外部文字或代码，应保留其 MIT 版权和许可声明；不建议原样合并整套技能。尤其要调整对方直接调用烧录/调试工具的路径，接入 EmberProbe 的授权和探针会话所有权，避免两套流程争抢设备。

## 验证记录

本次仅新增审计记录，未修改产品源码、技能或 README，未改动审计开始前已有的工作。核对了审计记录中的本地引用和固定提交下的外部文件路径，并运行针对本记录的差异格式检查。没有运行单元测试或 HIL；本次没有可由这些测试验证的实现变更。
