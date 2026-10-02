# RTOS 与 C++ 调试功能补齐计划

本计划以 EmberProbe 原生调试器对齐当前工作区的 Cortex-Debug 为目标，分四阶段交付。每项功能必须同时完成实现、回归测试和适用平台验收；配置项存在或模拟测试通过不等于硬件兼容已经得到验证。

2026 年 10 月 1 日范围调整：按用户要求取消新增 SEGGER／J-Link 原生后端。继续 P3 的 OpenOCD controller、多核与路由，以及 P4 的其他内核和非 SEGGER 后端；现有 OpenOCD J-Link interface 支持保留。

比较基线为 EmberProbe `4b3b218` 和本地 Cortex-Debug `d8b7f6c`。这是本地源码比较，不代表其后上游版本的最新能力。实施中的改动位于工作区，尚未发布。

## 当前差异及实现边界

| 能力 | 实施前 EmberProbe | Cortex-Debug 本地源码 | 补齐方向 |
| --- | --- | --- | --- |
| RTOS 调用栈 | OpenOCD RTOS 后端上报任务，适配器校验任务生命周期并绑定变量帧 | 多种 GDB server 的 RTOS 配置及任务线程 | 保留现有线程安全；增加独立暂停任务快照 |
| RTOS 任务表 | 无独立任务状态、优先级和栈统计面板 | RTOS 视图主要由独立 RTOS Views 扩展提供 | EmberProbe 自有侧栏，以只读自定义 DAP 请求读取 |
| 变量作用域 | Locals 与 Arguments | locals、globals、文件 statics、registers | 四作用域、懒加载、分页及准确的文件身份 |
| 表达式修改及悬浮 | 有 evaluate 和 setVariable；未声明完整对应能力 | setExpression、hover、变量元数据 | 增加 setExpression、hover 能力、可靠路径和地址 |
| STL 展示 | JS 内置解码常用 libstdc++ 类型 | GDB Python printers 与 varobj 的动态孩子 | builtin、gdb、raw 三模式，显式加载和降级 |
| 普通 C++ 类 | 暂停时依赖 GDB 原始孩子；运行采样依赖 DWARF | 暂停时依赖 GDB 的类型、继承和动态对象解析 | 改进分组、匿名及重名成员；运行采样只接受已验证的动态布局 |
| 多镜像 | 单一 executable | symbolFiles、loadFiles、重定位及段地址 | 镜像身份、符号目录及下载生命周期一致管理 |
| server 与多核 | 扩展启动 OpenOCD，适配器只拥有 GDB；单目标 | 多 server controller、多核和 chained session | 抽象生命周期、OpenOCD 多核分组与其他后端；原生 SEGGER 已取消 |

主要实现入口为 `src/debug/session.js`、`src/debug/variables.js`、`src/debug/stl.js`、`src/services/prettyPrinting.js`、`src/services/debugSessionBridge.js` 和 `src/mainViewProvider.js`。Cortex-Debug 对照入口为其 `src/gdb.ts`、`src/backend/mi2/mi2.ts` 及 `src/openocd.ts` 等 controller 文件。服务器识别出的 DAP thread ID 与内核 TCB 地址属于不同身份，不能按数值或任务名猜测关联。

## P1 作用域与 FreeRTOS 任务视图

先交付原生调试基础和 FreeRTOS 暂停快照。依赖现有 GDB MI 队列、暂停状态以及任务生命周期保护。

- 四作用域采用懒加载。globals 和 statics 优先使用 GDB 符号目录；仅在 MI 命令不受支持时使用匹配工具链的 nm。静态变量以源文件限定表达式定位，同名且无法消歧的符号禁止赋值。
- 默认每页 100 项，上限 1000 项。生成 varobj、读写寄存器、展开孩子均绑定有效任务和帧；恢复运行或任务消失后废弃旧句柄。显式赋值后通知客户端刷新。
- 声明 setExpression 和 hover；仅在可验证时返回 evaluateName、memoryReference。地址不可取得、优化掉或存在歧义时正常降级。
- 增加 `emberprobe.rtosSnapshot` 只读 DAP 请求，返回 kernel、tasks、partial、diagnostics。每项包含 taskKey、name、state、priority、tcbAddress，按可用性增加 basePriority、stack、runtime 和经过确认的 threadId。
- 扩展附加 sessionId、stopEpoch，并丢弃旧会话或旧暂停结果。侧栏默认折叠，支持过滤、排序、手动刷新；展开时每次暂停自动刷新一次。运行时保留历史快照并显示过期状态。
- 首批目标为单核、little-endian、ARM32 Cortex-M 上的 FreeRTOS 10／11，先验收 10.6.2。通过 GDB 类型探测字段、大小和偏移，不固定 TCB ABI，不调用目标 API，不要求修改固件。
- 遍历 ready、delayed、overflow delayed、suspended、pending-ready 和 waiting deletion 列表。损坏、裁剪、缺字段、预算超限均给出部分结果及原因。
- 默认预算：256 个任务、4096 个链表节点、每请求 256 KiB 内存读取、每任务 64 KiB 栈填充扫描。只有边界、增长方向与布局已确认时展示栈总量及填充估算；保存 SP 不宣称为当前任务的实时 SP。

验收包括同名 statics、分页、优化变量、只读表达式、寄存器写入失败、任务退出和恢复运行竞态。FreeRTOS 包括布局变化、列表损坏、可选配置字段缺失、预算中止以及真实板卡快照。

## P2 C++ 展示与多镜像

完成 P1 的变量身份后扩展展示方式和 ELF 生命周期。

- 增加 prettyPrintingMode：builtin、gdb、raw，默认 builtin。配置优先级为 launch、workspace、默认；未设置新字段时，旧 enablePrettyPrinting=false 映射 raw。弃用的 prettyPrinterPath 继续忽略。
- prettyPrinterFiles 只执行用户明确配置的脚本。gdb 模式检查 Python 能力，显式加载并启用 printers；初始化失败诊断后回退 builtin；单对象迭代失败回退 raw。所有模式关闭自动加载和 inferior function calls。
- 内置展示补 list、forward_list、deque、set、multiset、multimap、unordered_set、unordered_multiset、unordered_multimap 和 weak_ptr。保留分页、节点、字段、深度、字节及时间预算。Python 内部读内存无法完全由 JS 预算控制，需明确记录这一边界。
- 普通类保留可靠的成员路径，改进可见性组、匿名成员和重名成员。暂停 GDB 解析完整动态对象及虚基类；运行中的 DWARF 采样仅解析带验证 vtable、成员表达式和内存范围的动态对象，超出预算或无法验证时返回诊断。libc++、旧 ABI、debug STL 和 fancy pointer 优先通过可选 GDB printers 支持。
- 增加 symbolFiles、loadFiles，支持镜像偏移、text 地址及段地址。ELF／HEX／BIN 下载要求对应格式所需地址；未设置 loadFiles 使用默认 executable，空数组表示不下载；attach 永不下载。
- 符号目录保留镜像身份；RTOS 明确主符号镜像并校验。离线分析和侧栏采样仍围绕主选中 ELF，其边界写入文档。
- 增加显式 pre／post launch、attach、reset GDB hooks；校验和日志区分阶段，错误进入既有清理流程。

验收包括三模式切换、Python 缺失、脚本失败、容器扩容／空容器／悬空指针／const，以及两个镜像含同名符号和 attach 无下载。新增类型须有真实 GCC／GDB 验证。

GDB mode 的单对象降级使用 `-var-set-visualizer <name> None`。MI pretty-printing 一旦启用便不能全局关闭，因此只在显式脚本全部加载成功之后启用；详见 [GDB 变量对象官方文档](https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Variable-Objects.html)。原生测试也覆盖了 Python 异常仅写入输出流、MI 仍返回成功的情况。

多镜像实现按配置顺序加载符号，第一项作为主镜像。GDB 的 MI 目录没有镜像身份，使用匹配工具链的 nm 目录补充；目录最多 100000 项，nm 输出每镜像最多 8 MiB，目录请求预算 15 秒。同名变量的表达式必须与 nm 地址及重定位结果一致。实测 ARM GDB 会把不同文件限定的同名 global 解析到同一对象：只有 GDB 内建标量／指针类型且大小确认一致时，允许改用地址表达式；复杂对象无法确认身份时显示不可用，不赋值。相同源文件名跨镜像的对象保留镜像标签并禁止猜测。

`symbolFiles` 的 offset、textaddress 和 sections 对应 [GDB 文件与符号命令](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Files.html)。显式段地址优先于统一 offset。下载完成后恢复符号配置，再设置断点。BIN 使用显式地址；ELF 检查 ARM32 头、加载段范围，HEX 检查记录、校验和、结束记录和重定位范围；HEX 校验文件上限 64 MiB。内置 attach 流程不执行下载；用户显式 hooks 属于其指定的 GDB 命令。launch／attach hooks 在连接之后、默认操作前后执行，reset hooks 在复位前后执行。

多镜像 FreeRTOS 在连接前及启动 hooks 之后校验主镜像的 `pxCurrentTCB` 与 GDB 未限定查询地址一致；auto 模式识别到该符号时同样校验。快照再次确认主镜像，TCB、List 和 ListItem 布局来自主镜像变量的实际类型，避免使用另一个固件的同名 typedef。该校验不把任务快照绑定到未经确认的 DAP 线程，也不代替服务器 RTOS 与实板验收。

## P3 OpenOCD controller 与多核

将 server 归属从 OpenOCD 专用代码中抽出，保留探针独占与失败清理边界。

- Controller 接口覆盖 preflight、start、ready、connection、stop、capabilities。先迁移 OpenOCD；原生 SEGGER 已取消，不新增其进程启动、插件或驱动切换路径。
- servertype 默认 openocd；serverpath、目标选择、RTOS 等在申请探针租约前做后端专属配置校验。新增其他后端时，内置 RTOS 名称采用允许列表，自定义路径必须是已验证的绝对路径。
- OpenOCD 增加 numberOfProcessors、targetProcessor、targetName；明确目标选择发生在 RTOS 配置之前。
- 同一 server group 持有一个物理探针租约。每个 core 独立 GDB、端口、句柄、RTOS 快照；最后一个会话关闭时回收 server。启动半失败、提前退出、重启和终止均覆盖。
- 多会话路由必须带 workspace、group、core 或 session 的明确身份；发生歧义时提示选择，不任取一个任务。初期不承诺 SMP 一致快照或跨核同步单步。

验收至少含 OpenOCD 回归、两核分别暂停／终止，以及同组最后会话关闭后的租约释放。

目标选择的基础实现为独立分配每个 target 的 GDB 端口，再设置 `-gdb-port` 和当前 target，最后配置 RTOS。启动时核数和可选 targetName 必须匹配；未配置新字段时保留原有 target 行为。端口分配期间保留所有 socket，全部分配后再释放，启动仍保留绑定冲突重试；详见 [OpenOCD target 官方配置](https://openocd.org/doc/html/CPU-Configuration.html)。共享 `serverGroup` 已接入：首核成功初始化后，其他核以 attach 加入，复用一个物理 controller／租约并独立管理启动超时和失败。侧栏与 Agent 按所选 DAP session 路由，切换使旧快照失效并按会话隔离 CSV 历史；变量 ELF 必须匹配所选核。最后成员退出且 server 停止确认后才释放探针。多核运行期 Tcl 采样和组内 restart 关闭，支持边界与配置见 [共享组指南](SHARED-DEBUG-GROUPS.md)。

## P4 其他内核与 server

在稳定的快照接口和 Controller 上逐个扩展，避免把不同后端能力混成共同承诺。

- ThreadX、Zephyr 使用与 FreeRTOS 相同的 typed decoder、只读请求、预算和 partial 语义；无法证明的字段显示未知。
- 后端顺序为 external、pyOCD、ST-Link GDB Server、st-util、BMP、PE。每个后端显式声明能力，不支持的配置在启动前拒绝。
- external 模式不启动／停止外部 server，并阻止独立探针操作争用它。保留 cortex-debug 会话集成作为过渡路径。
- 每个内核／server 的支持等级由实际验收提升；只有 mock 或配置验证的能力标为实验性，不列入已验证硬件兼容表。

## 公共交付条件

每阶段运行 `npm run check`、`npm run quality`、`npm run bundle` 和相关 Extension Host e2e。质量检查覆盖 ESLint、格式、JS 类型和覆盖率门禁。侧栏变更补 DOM 行为测试及截图。

原生 C++ 验证矩阵为 GCC 14／15、C++17／20、DWARF 4／5；Python 模式另行验证。Windows、Linux、macOS 分别记录编译器、GDB、server、固件、板卡和结果，不能用单平台结果替代其他平台。已有 H750 用于只读观察；修改、下载、复位及写入使用专用测试固件／硬件，并遵循 HIL 指南。

README、README_EN、CHANGELOG 和兼容矩阵同步说明配置、退化行为和验证边界。阶段交付不自动发布、不创建版本标签。全部功能完成但硬件未验收时，仍保持实验性标记和未完成验收项。

## 实施进度

2026 年 10 月 1 日工作区状态：

- P1 四作用域、表达式修改、可靠路径和地址已实现，新增模拟回归测试通过。Windows GCC 14.2／GDB 16.2 的 C++17、DWARF 5 集成测试通过，包括同名 statics 和寄存器写回。
- P1 FreeRTOS typed decoder、自定义 DAP 请求及侧栏已实现；布局变化、列表损坏、栈估算、预算和旧快照测试通过。任务名称、TCB、状态、优先级与可选栈估算的侧栏截图已检查，使用模拟快照。没有真实板卡验收证据，保持实验性。
- 软件门禁通过：`check` 共 278 项，`quality` 总行覆盖率 84.4%，`bundle` 和 Extension Host e2e 通过。e2e 使用工作区临时目录规避系统 Temp 权限限制。
- P2 三种展示模式、显式 printer 脚本与初始化／单对象异常降级已实现；新增计划中的 STL 容器及 weak_ptr。Windows GCC 14.2／GDB 16.2 的 C++17／20 × DWARF 4／5 四组合和三模式原生测试通过，包括真实 Python 初始化失败及迭代异常回退；ARM32／64 布局模拟测试补充链表、deque 跨块和关联容器覆盖。CI 已加入 printer 原生测试，尚未运行远端矩阵。P2 当前软件门禁 280 项检查及质量、构建、e2e 均通过。
- P2 普通类展示已实现：访问权限组不可整体赋值但成员仍按实际 const 属性编辑；匿名组具有稳定分页名称；暂停 GDB 开启动态类型解析；基类路径改为引用转换，保留真实成员地址。Windows GCC 14.2／GDB 16.2 的四组合测试覆盖多继承重名字段、匿名 union／struct、private／protected、动态对象、虚基类、const 和修改单个基类成员；表达式赋值另在 C++17／DWARF 5 验证。
- P2 多镜像和 hooks 已实现；配置校验、空数组、attach 无下载、各阶段顺序和启动失败清理的普通回归通过。ARM GCC／GDB 14.3.1 对内存 RSP 目标的原生测试通过 ELF／HEX／BIN、重定位、显式段地址、同名镜像变量读写及不兼容 TCB typedef 的主镜像布局。它不连接硬件、不构成多镜像实板验收。Linux CI 已配置独立 ARM image 测试，尚未运行远端。
- P2 本轮最终门禁：`check` 284 项、零失败；`quality` 131 项普通测试、零失败，行覆盖率 84.75%，分支 80.78%，函数 90.92%；lint、格式、类型、协调器安全覆盖率、bundle、Extension Host e2e 和 `git diff --check` 通过。正常套件在系统 Temp 出现一次目录清理权限错误，较长工作区 Temp 又出现内置 OpenOCD 只读版本检测的 DLL 初始化错误；最终使用较短工作区临时目录并在沙箱外完整复验通过，没有跳过测试。
- P2 软件功能已补齐，完整门禁与平台证据单独记录；P1／P2 实板及完整跨平台矩阵仍未验收。完整目标仍覆盖经用户调整后的四阶段，以上进度不表示整个计划完成。
- P3 OpenOCD controller、目标核配置校验、独立端口、选择先于 RTOS、核身份写入授权和退出失败保留租约已实现；定向无硬件回归通过。当前只支持单个选中核会话；共享 server group、明确多会话路由及双核实板验收仍待完成。原生 SEGGER 后端已取消。完整门禁结果另行记录。
- P3 共享组交付后的验证：`node scripts/run-tests.js --tests` 检查 134 个测试文件、零失败；`lint`、Prettier、类型检查、`quality` 覆盖率门禁、协调器安全覆盖率和 `git diff --check` 通过。新增回归覆盖共享租约、attach 加入、目标／GDB 身份、启动失败隔离、提前退出、未确认退出保留租约、每核状态／RTOS 快照／写入路由、CLI 选择、ELF 匹配和侧栏 320／420 像素预览。当前沙箱执行 bundle／Extension Host e2e 时 esbuild 被父目录访问权限拦截；审批额度不足，未能复验沙箱外构建，因此不把本轮构建标为通过。无硬件测试仍不能代替双核实板验证。
- P1 启动暂停误报修复：任务数为零且当前 TCB 为空、调度器未启动时，不遍历仍为零值的链表；侧栏显示启动提示。可选 TCB 成员缺失正常省略，错误布局和内存失败仍报告 partial。已创建但调度器未启动的任务不再标成 running。模拟回归及 ARM GCC／GDB 14.3.1 内存 RSP 验证首次暂停和启动后恢复；320／420 像素侧栏预览检查通过，无实板操作。完整检查 286 项、普通测试 132 项零失败，质量门禁行覆盖率 84.89%，bundle、Extension Host e2e 和 diff 检查通过。

### 当前验证矩阵

| 平台／工具 | 配置 | 验证范围 | 状态 |
| --- | --- | --- | --- |
| Windows GCC 14.2／GDB 16.2 | C++17／20 × DWARF 4／5，builtin | scopes、STL、普通类、const、分页、写入、恢复失效 | 四组合通过 |
| Windows GCC 14.2／GDB 16.2 | builtin／raw／gdb，显式 Python 脚本 | 模式隔离、脚本初始化失败、单对象 Python 异常 | 通过 |
| Windows ARM GCC／GDB 14.3.1 | ARM32 Cortex-M，内存 RSP | ELF／HEX／BIN、偏移和段地址、镜像身份、主 FreeRTOS 类型、连接前校验 | 通过，无硬件 |
| VS Code Extension Host | 工作区临时目录 | 打包后 DAP、分页、赋值、旧句柄 | 通过 |
| Linux CI GCC 14／15 | C++17／20 × DWARF 4／5；另有 ARM image job | 原生 C++ 与内存 RSP | 配置已加入，远端运行待验收 |
| macOS 原生 GDB | 目标矩阵 | C++、Python modes、多镜像 | 待验收 |
| 专用 FreeRTOS／多镜像板卡 | 已定义固件和 server 版本 | 任务表、主镜像、下载后启动 | 待验收，保持实验性 |

P3 共享组的软件实现已交付，完整门禁证据见实施进度；双核实板验收保持未完成。下一步推进 P4 的 ThreadX／Zephyr typed 快照与其他非 SEGGER server。P1／P2 的待验收项保持记录，不能用阶段软件完成代替整个目标完成。

## English delivery summary

P1 adds lazy locals, globals, file statics and registers; expression assignment; reliable variable metadata; and a bounded, read-only FreeRTOS task snapshot panel. P2 adds explicit builtin/GDB/raw display modes, more STL containers, class presentation improvements and multiple symbol/load images. P3 introduces OpenOCD controllers and per-core session groups sharing one probe lease. Native SEGGER was explicitly removed from scope by the user. P4 adds typed ThreadX/Zephyr snapshots and other servers with explicit capability checks.

Every stage requires normal checks, quality gates, a bundle, relevant extension-host tests and truthful platform/hardware evidence. Windows GCC 14.2/GDB 16.2 pass C++17/20 × DWARF 4/5 and explicit Python-printer tests. P2 class presentation, multiple images and phased hooks are now implemented. ARM GCC/GDB 14.3.1 verify image transfers and primary-image layouts against an in-memory RSP target, without hardware. P3 implements the OpenOCD controller, experimental shared per-core session groups and explicit sidebar/Agent routing with confirmed final-member lease cleanup. P4, dual-core board acceptance and the complete platform matrix remain pending.
