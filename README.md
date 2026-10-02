# EmberProbe

EmberProbe 是一款面向 Cortex-M 开发的 VS Code 扩展。它基于 OpenOCD，提供固件烧录、目标自动识别与实时变量观测。

> [English documentation](README_EN.md)

![实时图表面板：采样波形、当前数值与写入列表](docs/images/live-watch-waveform.png)

## 功能特性

- 自动检测工作区中最新的 ELF 文件与 MCU 目标。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态。
- ELF文件烧录：一键烧录ELF文件并运行。
- 实时变量观测：在目标运行时非侵入式读取 Cortex-M 内存；侧边栏提供独立数值列表，可同时打开多个拥有独立观察列表和历史缓冲的实时图表面板。
- 实时变量写入：在目标运行时实时更改内存，提供滑条、输入框、鼠标滚轮多种值更改方式，更改后自动回读。
- 内置断点调试：无需 Cortex-Debug，支持断点、单步、调用栈、Locals／Globals／文件 Statics／Registers、表达式赋值及内存读写；可选 RTOS 感知（FreeRTOS 等，详见 [docs/RTOS-AWARENESS.md](docs/RTOS-AWARENESS.md)），调用栈直接显示任务并按任务单步。实验性 FreeRTOS 侧栏只读取暂停任务快照，运行时标记历史结果；详见 [补齐计划及验证边界](docs/RTOS-CPP-PARITY-PLAN.md)。
- 可选安装九个 Agent Skills，覆盖固件编程与校验、实时变量读写、SVD 外设调试、调试会话/断点控制、芯片和故障信息读取、ELF 分析，以及配置同步。

## 环境要求

原生调试的 `servertype` 当前为 `openocd`，`serverpath` 可覆盖其可执行文件。实验性目标核选择使用 `numberOfProcessors`、从零开始的 `targetProcessor` 和可选 `targetName`：核数必须与 OpenOCD 的 `target names` 一致，名称必须匹配索引，选择发生在 RTOS 配置之前。每个 target 使用独立 GDB 端口，当前一次只启动一个核的调试会话；共享 server group 尚未实现。多核配置下运行期 Tcl 采样暂停，需暂停选中核后通过 DAP 读取，不能据此推断其他核的状态或一致快照。该能力目前仅通过无硬件回归，实板验收待完成。

- Visual Studio Code 1.85 或更高版本
- OpenOCD
- ARM GDB 工具链（断点调试必需）

## 实时变量观测

侧边栏列出当前 ELF 的所有全局/静态变量；点击变量可将其加入独立数值列表。

- 类型支持：标量优先使用 DWARF 类型信息，支持 `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`；结构体、联合体和数组可展开并选择标量叶子成员。
- 64 位精度：`u64/i64` 图表在 ±2^53 外使用 Number 近似值；侧边栏、CSV 和 Agent 结果优先使用精确十进制 `valueText`。
- CSV 导出：采样开始后可随时按变量和时间范围流式导出采样数据。
- 实时写入：侧边栏可把具有可靠 DWARF 类型且位于 ELF 可写段的标量加入写入列表；写入只在采样会话运行时启用，并在每次写入后回读校验。

- 曲线识别：颜色和线型按完整变量名保存到工作区，多面板共享；点击色块仅隐藏/显示（结构体成员同样保留采样和历史）。右键变量卡片设置数据类型、改色、改线型、仅看此项或移除监视；“恢复显示组合”回到聚焦前的选择。
- 曲线读数：悬停仅显示颜色竖条和实际值；点击曲线与顶部“冻结图表”使用同一快照逻辑，冻结后移动鼠标仍可读取其他位置和曲线。
- 显示与坐标：左侧“当前数值”下可显示全部/隐藏全部；顶部“自动 Y 轴”控制自动缩放，手动缩放后保持范围。左侧全高色条切换显隐，隐藏为灰色；右侧 × 移除变量。
- 冻结：后台采样和当前值继续更新，顶部“恢复实时”释放快照并回到最新。新添加变量在恢复实时后显示，清空历史同时清除快照。
- 导出来源：保留“完整采样归档”，另可选择“实时保留数据”或“冻结快照”；冻结时默认导出快照。默认实时缓冲按目标频率保留至少 60 秒，显式设置 `emberprobe.maxSamples` 时遵循该上限；数值对照不跨采样断点取值，64 位整数读数保留精确文本。

- 采样隔离：OpenOCD 连接和采样时钟运行在独立工作线程，避免构建或同步 ELF 解析阻塞扩展宿主时中断采集；显示 Hz 使用采集时间而非消息到达时间。目标复位、调试暂停、探针占用和系统资源耗尽仍可能影响实际读取。

## 暂停调试中的 C++ 对象

实验性多核共享 OpenOCD：在 `launch.json` 中设置相同的 `serverGroup` 和 `numberOfProcessors`，为每核设置不同的 `targetProcessor`。先启动首核，初始化完成后通过 `attach` 加入其他核；加入不会自动下载或复位。RTOS 面板可选择调试会话，Agent 使用 `debug.select`。组内关闭重启与运行期 Tcl 采样；最后一个会话退出并确认服务器停止后释放探针。侧栏变量所选 ELF 必须与当前核一致。配置示例和验证边界见 [多核共享指南](docs/SHARED-DEBUG-GROUPS.md)。

内置调试器使用 JavaScript STL 展示器，直接读取普通 GDB 提供的类型、字段和内存，作用于 VS Code 的变量、监视和悬停。无需 Python、额外工具链或修改固件；明确配置的 GDB 不会被替换。GDB 自动加载脚本与目标函数调用在此会话中禁用。

- `emberprobe.prettyPrintingMode` 支持 `builtin`（默认）、`gdb`、`raw`，launch/attach 优先于工作区。未显式配置新模式时，旧 `enablePrettyPrinting=false` 映射为 `raw`。
- `gdb` 模式使用 Python，且只加载 `prettyPrinterFiles` 明确列出的脚本（相对 debug cwd 解析）。Python 缺失或脚本初始化失败回退 builtin；单对象 printer 失败禁用其 visualizer 并回退原始字段。脚本在 GDB 中执行，Python 内部读取不受 JS 字节预算完整约束。
- `prettyPrinterPath` 已废弃并忽略；已有配置不会阻止调试，控制台提示迁移。
- 默认每页 100 个元素，点击 `More…` 继续；显式 `count` 最大 1000。内置布局读取有 64 KiB、4096 个链式节点及 15 秒预算；大型容器的远端跳页超出预算时应顺序加载前面的页面。
- map 按 `[序号] → key/value` 展示，键、容器摘要及合成节点只读。值经 GDB 确认可编辑后允许修改；恢复运行、单步、重启，以及内置容器元素赋值后，受影响的旧子句柄失效。
- 普通类保留 public／protected／private 分组和基类层级，权限组不可整体赋值；匿名组按位置命名，成员沿可靠路径修改。暂停 GDB 解析动态类型及虚基类，基类引用路径保留实际成员地址。
- launch.json 可配置 `symbolFiles`（首项为主符号镜像，支持 offset／textaddress／sections）和 `loadFiles`（ELF／HEX 的 offset、BIN 的显式 address）。未配置时使用 executable，空数组不加载对应内容；内置 attach 流程不下载。多镜像作用域需要匹配工具链的 nm；同名变量无法确认镜像身份时不可赋值。离线 ELF 分析与侧栏运行采样仍使用主选中 ELF。
- `preLaunchCommands`／`postLaunchCommands`、`preAttachCommands`／`postAttachCommands`、`preResetCommands`／`postResetCommands` 接受显式单行 GDB console 命令；launch／attach hooks 在连接后的默认操作前后执行，reset hooks 在复位前后执行。启动 hook 失败会清理会话；自定义命令按用户配置执行。

目标矩阵是 GCC 14/15、libstdc++、C++17/20、DWARF 4/5 的小端 ARM32 和主机64位布局。内置展示支持短/长及嵌入 NUL 的 `string`、`vector`、`array`、`pair/tuple`、`list/forward_list/deque`、`map/multimap/set/multiset` 及对应 unordered 变体、`unique_ptr/shared_ptr/weak_ptr`、`optional/variant`，包括空对象、嵌套对象与分页；set 键、`vector<bool>` 位元素仅可读，expired weak_ptr 不访问已释放对象。字符串摘要最多读取 256 字节，完整字符可分页访问。运行采样也支持这些常见 libstdc++ 布局、引用／指针链、虚成员地址和已验证的 Itanium 动态类型；每个对象每周期最多 4096 字节、32 次读取、1 秒和 256 个节点。未知布局、旧字符串 ABI、libc++、`_GLIBCXX_DEBUG`、fancy pointer、异常 vtable 或不完整类型信息会保留原始字段或给出明确不可用诊断。

新增普通类展示已通过 Windows GCC 14.2／GDB 16.2 的 C++17／20 × DWARF 4／5 验证。`node test/gdb/debug-images.test.js` 使用 `IMAGE_CXX`、`IMAGE_GDB`、`IMAGE_NM`、`IMAGE_OBJCOPY` 指定 ARM 工具链，在内存 RSP 服务中验证 ELF／HEX／BIN 与主镜像 RTOS 布局；本机 ARM 14.3.1 通过，未连接板卡。新下载流程和 FreeRTOS 任务表仍待实板验收，详细预算及差异见 [补齐计划](docs/RTOS-CPP-PARITY-PLAN.md)。

本机 GCC 14.2/libstdc++ 与 GDB 16.2 已通过无 Python printer 的原生回归；ARM32 协议测试验证字段与地址处理。H750_RTOS_CPP_Test 使用 STM32 GCC 14.3.1 普通 GDB，已通过 `string/vector<float>/unique_ptr<Sensor>` 的真实 DAP 摘要与展开验收，包括 FreeRTOS 模式（8 个任务）；测试工程未修改。其他类型与大型分页放在仓库夹具中验证，实板结果不代表完整类型矩阵已在 ARM 真机验证。Linux CI 配置 GCC 14/15、C++17/20、DWARF 4/5 矩阵，本地尚未执行该 Linux 矩阵。原生测试通过 `CPP_GDB`、`CPP_CXX` 指定工具，`CPP_STANDARD=17/20`、`CPP_DWARF=4/5` 指定模式，运行 `node test/gdb/cpp-paused.test.js`；普通测试无需工具链。只读实板验收入口及前提见 [test/hil/README.md](test/hil/README.md)。

## Agent Skills

EmberProbe提供以下skills。

- `mcu-flash`：检测并烧录最新 ELF，或独立校验片上 Flash。
- `mcu-variables`：单次读取、分析趋势、导出图表历史 CSV。
- `mcu-chip-info`：按 `identity`、`debug`、`runtime` 分组或指定字段读取芯片信息。
- `mcu-config`：读取或修改 ELF、调试器、MCU、SVD、OpenOCD 和采样参数。
- `mcu-fault-analyzer`：读取并解码 Cortex-M 故障寄存器，并使用当前 ELF 对 PC/LR 进行符号化。
- `mcu-elf-analyze`：离线分析当前 ELF 的 Flash/RAM 占用、各内存区域容量百分比、段布局和大符号；优先读取对应 `.map`，也支持 linker script。
- `mcu-peripheral-debug`：解析工作区 SVD，查询、读取和解码外设寄存器/位域。
- `mcu-debug-control`：启动、停止和控制 调试会话，支持暂停/继续/单步/重启以及源码行和函数断点管理。
- `mcu-debug-control` 的 `inspect.js`：读取暂停原生会话的任务调用栈、作用域及 C++ 类/STL 对象，支持分页展开与失效句柄保护。
- `mcu-rtos`：读取暂停 FreeRTOS 任务状态、优先级与栈填充估算，并检查指定任务的调用栈及 C/C++ 局部变量；结构化快照暂限单核小端 Cortex-M ARM32。
- `mcu-cubemx`：在 Windows / Linux 上经两阶段授权修改已有 `.ioc` 并通过 CubeMX CLI 重新生成初始化代码，包含基线检查、用户代码保护与恢复副本。

## 开发与构建

```sh
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

准备新版本时运行 `npm run release:prepare -- <version> --date YYYY-MM-DD`，脚本会同步版本元数据、README 和 Changelog。推送匹配版本的 `vX.Y.Z` 标签后，Release 工作流会自动创建 GitHub Release 并上传 VSIX；发布及重试方式见 [docs/RELEASING.md](docs/RELEASING.md)。真机测试接入方式见 [test/hil/README.md](test/hil/README.md)。当前扩展版本为 `0.7.14`。

## 项目结构

```text
src/       扩展实现
resources/ Windows x64 OpenOCD 包及其自带的许可证
media/     商城与活动栏图标
skills/    自带的 Agent Skills
test/      单元测试与 OpenOCD Tcl-RPC 集成测试
esbuild.js 单文件 VSIX 打包构建配置
```

## 许可证与归属

扩展代码采用 MIT 许可证。npm 运行时依赖与自带 xPack OpenOCD 的许可证及来源信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
