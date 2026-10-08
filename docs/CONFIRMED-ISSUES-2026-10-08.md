# 已确认问题汇总（2026-10-08）

范围：EmberProbe 当前 HEAD 6a969c2 的未发布更改，以及 CODE-REVIEW-c4e4230 的独立复核。
本清单合并前两轮审计和本次用户反馈，去除误报，并保留真实问题中的条件与限制。
状态：I01–I14 的代码整改已实施，T01–T04 已采用下文所述批准和本机信任策略。初始触发条件保留用于追溯；当前实施及验证见第七节。未连接硬件或执行硬件操作。

证据标签：
- **用户实机反馈**：用户观察到的现象；不代表本轮已经独立完成实板复现。
- **模拟复现**：调用实际生产模块，替换 VS Code、子进程或硬件接口；没有操作真实设备。
- **代码确认**：实现中缺口可直接定位；具体硬件影响或性能规模仍需验证。
- **设计边界**：行为属实，但需要明确权限/可信度策略，不能直接套用原报告严重度。

## 一、需要整改的问题

| ID | 问题 | 触发、影响与证据 | 建议处理 |
| --- | --- | --- | --- |
| I01 | 调试器断开提示与实际状态不一致（新增） | 用户反馈：采样过程中断开调试器后，出现“检测到……实时采样已自动断开/停止”，实际却未断开。代码中断开回调先异步发起停止，再立即上报 live.probeDisconnected；此时退出确认可能尚未完成。模拟复现：提示已经发出，但 source=openocd、liveWatch 租约仍在、停止 Promise 尚未结束；stop=false 后保留会话和租约。模拟中新的采样已关闭，不能据此断言用户实机上仍在发起读取。 | 首先复现并区分持续轮询、进程未退出、界面残留三种情况。分开显示“采样已停”“正在关闭连接”“退出未确认/可重试”“已断开”。物理失联后关闭读取与写入入口、丢弃迟到数据；确认退出后再清除连接状态，退出未确认时保留互斥。 |
| I02 | 取消采样启动后，等待 ELF 的旧启动流程重新启用采样意图 | 模拟复现：启动等待 elf.ready，用户停止，ELF 就绪后旧启动仍写入 _samplingIntent=true；随后 generation 检查退出，没有会话或租约，但 CPU 监控被误判为 liveWatch 占用。 | 在 ELF 等待后、任何意图/计划/界面状态修改之前检查启动代次和取消状态；停止后的旧流程不得重新启用意图。 |
| I03 | Agent 在准备连接期间被停止，旧流程仍创建并启动硬件会话 | 模拟复现：_withAgentProbe 在 prepare/端口等待期间停止，stopAgentReadIfRunning 因会话尚未建立返回；后续只检查 lease.released，遗漏取消标志，因此仍 constructed → hardware-start → hardware-stop，最终返回 AGENT_READ_CANCELLED。 | 每个准备 await 之后、构造会话之前以及 start 之前检查取消/操作身份。保留租约直到启动取消或已有进程安全退出。 |
| I04 | 并发状态刷新把有效 OpenOCD 路径解析成 null（原 M17） | 模拟复现：resolve 与 refresh 共享 operation，后启动的刷新使有效的 resolve 返回 null；得到 [null, "/valid/openocd"]，可能误报未安装/未就绪。 | 状态发布的代次与调用方的解析结果分离；刷新只能抑制过时 UI 更新，不能丢弃有效解析结果。 |
| I05 | CubeMX 忽略终止信号时，任务 Promise 一直等待（原 M7） | 模拟复现：仅发送一次 SIGTERM；子进程不发 close 时 Promise 仍 pending。Linux/JVM 忽略信号时可能长期占用生成任务。未用真实 CubeMX 验证，不能直接断言当前 Windows 同样发生。 | 增加终止升级、退出确认和可重试清理状态。未确认退出时不能允许同工程另一个生成任务并发覆盖文件。 |
| I06 | 图表服务失败后不终止 Worker（原 M18） | 模拟复现：fail 后 Worker threadId 仍有效；缓存可能留到重启/关闭。80 ms 更新计时器是一次性的，不是永久循环计时器。 | 定义失败时的 Worker/缓存回收策略，并让失败恢复、导出和重新启动行为明确。 |
| I07 | DWARF CU 头错误可放大诊断数量，缺 CU/诊断总预算（原 M3 修正版） | 模拟复现：120256 字节 ELF 生成 20000 条诊断。进入 DIE 循环前失败的 CU 不计入 DIE 预算；原报告的未知首属性 form 示例实际上会计数。DWARF 解码总预算为 32 MiB。 | 同时限制 CU 数量和诊断数量；超限时保留摘要并中止/安全降级，避免大量诊断回传宿主。 |
| I08 | 非对齐 SVD 寄存器地址可到达写接口（原 M11） | 模拟复现：32 位寄存器地址 0x40000001 通过确认并进入模拟写入。硬件是否拒绝、拆分或误写尚未验证。 | 在计划阶段校验访问宽度和地址对齐，确认前拒绝不支持的地址；读写使用一致的合法性校验。 |
| I09 | maxSamples 范围不一致，现有自动历史模式使设置失效（原 M4） | 代码确认：Bridge 上限为 100000，schema/view 为 360001；正常自动历史路径不采用用户设定的传统上限。 | 统一范围；接通设置或明确废弃/迁移，避免 UI、Bridge 和实际行为互相矛盾。 |
| I10 | UI 下载缺少已选镜像的摘要绑定/私有快照（原 M1 成立部分） | 代码确认：UI 将 workspaceState 中路径直接交给下载；Agent 路径有摘要及私有快照。镜像在准备过程中被替换的影响尚未复现。没有证据支持原报告“切换工程后必然静默烧错”。 | 对实际消费的镜像建立稳定身份或快照；显示路径/镜像身份。用户点击下载是授权，不应重新包装成“UI 无确认漏洞”。 |
| I11 | ELF 符号数量缺少独立预算（原 M12 成立部分） | 代码确认：符号循环无条目总上限。正常扩展配置 Worker，已有 64 MiB 文件限制和 512 MiB Worker 堆限制；不是所有解析都直接运行在宿主。 | 增加条目、字符串遍历和处理时间预算；超限报告明确诊断，保留 Worker 隔离。 |
| I12 | 调试接管未统一等待 liveStart 取消（原 M16） | 代码确认：外部/第三方调试接管主要检查已运行会话，可能遗漏仍在准备中的 liveStart，最终由协调器报 PROBE_BUSY。互斥保护仍然有效。 | 通过统一停止流程等待启动取消完成，再申请调试租约；错误应可理解且可重试。 |
| I13 | GDB 异常收尾缺少 SIGKILL 升级（原 M9 成立部分） | 代码确认：MiClient.fail 只调用 kill。外部模式实际调用 waitForExit 并在未确认时保留占用，原报告“从未调用”是误报。尚未实测忽略终止的真实 GDB。 | 增加有界终止升级，并保留现有外部服务器保护及退出确认。 |
| I14 | SVD 库同步校验/重复解析阻塞宿主（原 M2） | 代码及合成基准确认：4224160 字节 SVD 同步校验+解析约 219.8 ms；list/findCompatible 重复处理。resolveBound 已有小缓存。未证实原报告“数秒至数十秒”的真实厂商文件规模。 | 缓存可复用校验结果，将大 XML 工作移入 Worker；用真实厂商 SVD 测量选择器延迟。 |

建议先处理 I01–I04，修正采样状态与取消竞态；同时保留故障下的硬件所有权。I05–I08 属于故障收尾和输入预算/地址校验，随后处理设置一致性与性能。

## 二、已确认的权限与信任边界

这些是需要明确产品策略的事实，并非已证明的远程利用链。建议与功能缺陷分别跟踪。

| ID | 已确认事实 | 需要明确的策略 |
| --- | --- | --- |
| T01 | Flash、变量/外设写入、CubeMX 的确认 ID 由扩展发给客户端，同一客户端回传即可消费；没有独立的人类批准凭据。模拟授权成功。flash.verify 还会临时 halt，但没有同级批准步骤。 | 若要抵御失控/被注入的 Agent，应由客户端不能自行完成的 UI 批准操作；批准绑定现有摘要、目标、连接、会话/代次和具体计划。记住权限也应由实际批准渠道决定。 |
| T02 | 本机 OpenOCD Tcl 无认证，存在固定端口/6666 回退；随机端口不构成认证。同用户进程还可能读取 Bridge token，0600/ACL 本身不能隔离同用户客户端。 | 明确本机可信进程边界；避免端口固定回退和抢占错误，不把随机端口或文件模式当作完整认证。 |
| T03 | 可编辑 SVD 决定寄存器地址和访问语义；设备名/厂商匹配不能证明文件来源。现有确认绑定 SVD 摘要、会话代次和原值。 | 明确自定义 SVD 的批准/可信度政策；保持自定义设备能力，避免未经讨论只允许官方库或用固定地址区间排除合法设备。 |
| T04 | 技能修改告警非阻塞、每会话一次、依赖上次检查结果；Bridge 可随受信任工作区技能状态自动启动。 | 明确是否允许自定义工作区技能；如果要求防篡改，应在执行/调用前重新检查并采用相应批准策略。自动启动本身不能直接等同于恶意仓库利用链。 |

工作区外 ELF 和显式连接参数覆盖是已记录的功能；执行仍要求匹配摘要与计划确认，参数已包含在批准摘要中。是否限制这项能力属于策略选择，本清单不将其单独列为已确认缺陷。

## 三、其他已确认事实与改进项

这些条目主要是低影响健壮性、代码清理和未量化的性能候选，不作为高危漏洞计数。

| ID | 项目 | 证据和限制 |
| --- | --- | --- |
| E01 | 同步项目元数据扫描 | 文件/条目/大小预算存在，但宿主仍同步扫描；真实工作区延迟待测。 |
| E02 | 长会话容量管理 | 终止会话 ID、归档 scope 代次和序列样式会保留；清理必须保留迟到事件和旧代次隔离语义。 |
| E03 | 消息与渲染健壮性 | 消息仅做基础类型检查，部分渲染假定完整字段；commandHandlers 可改自有属性查找。未证实来源注入或任意命令执行。 |
| E04 | 参数与死代码清理 | AgentFlash prepare 包装器丢弃第二参数；未用授权辅助方法和被覆盖的 export onclick 可清理。当前主要路径仍正常。 |
| E05 | 确认存储实现统一 | 多处单次消费/TTL/容量实现重复且边界略有不同；现有指纹校验有效。统一实现不等于实现独立的人类批准。 |
| E06 | 本地化 | 英文 UI 仍可能显示硬编码中文错误。 |
| E07 | 质量门禁范围 | mainViewProvider 无 c8 门槛、webview 无 checkJs；已有大量生产方法测试，不能解读成“没有测试”。 |
| E08 | 图表、搜索与 DOM 性能 | Set/数组分配、shift、树形 JSON 遍历、全文档查询、外设整树重建和 canvas 全量重绘可优化；应先测量实际帧耗时和大工程输入，不能直接采用报告中的固定耗时/百万次规模。 |
| E09 | 图表消息序列化 | 每批 JSON 字节统计后再 postMessage 克隆属实；成本排序与“最贵热路径”尚未实测。 |
| E10 | 文件/工具启动加固 | realpath 后扩展名复核、环境脚本根覆盖、staging 独占创建和读用之间的时间窗口可进一步处理；尚未证实这些单项形成越权执行或路径穿越。 |

## 四、从整改清单排除的误报

- 原 P1-1 / P3-13：“退出未确认必然永久泄漏且无恢复”不成立，保留会话后可以重试停止。
- M6：CPU 使用独立默认 200 Hz 和自适应策略，是既定设计。
- M8：“这里没有终止升级”不成立，已有 500 ms 后 SIGKILL；两个终止方式都失败时仍不能解除互斥。
- M10：再次暂停后旧外设确认会被 epoch/原值指纹拒绝，模拟写入次数为 0。
- M15：“没有 HTTP 超时、ELF 全在宿主解析”不成立；Node 实测有默认超时，生产 ELF 路径使用 Worker。额外背压仍可评估。
- M19：可信模板脚本外置不是通用 HTML 消毒器，未证明现有可利用注入。
- P3-6：UI 导出路径由保存对话框选择；Agent 使用内部随机临时文件，不是任意输出路径。
- P3-9：候选 IOC 是工作区内使用 wx 创建的新文件，不覆盖原工程。
- P3-11：已有 CSP meta 会被替换，带属性/缺失 head 不会使现有宽松 CSP 原样保留。
- P3-15：被裁剪文本仍按共享块计入 bytes，预算没有漏计。
- P3-24：GNU .zdebug_* 先归一化名称再校验，实际解压成功。
- P3-34：cubemxPath 局部断言始终拒绝，openocdPath 的 Bridge 上游禁止修改断言存在。

## 五、修复时必须保留的约束

1. 采样是否启用、Tcl 是否连接、OpenOCD 是否退出、探针租约是否仍持有，应分别表示；提示必须与对应状态一致。
2. 退出未确认时保留进程句柄和互斥，提供停止重试；禁止采用原报告的“finally 无条件释放租约”。
3. 启动取消、断开与会话切换都要使旧结果失效，不能重新开启采样意图或提交迟到数据。
4. 权限修复保留现有摘要、目标、探针、会话、暂停代次、原值及一次性消费校验。
5. 普通软件/模拟测试可以验证逻辑；USB 拔插、实际进程退出、真实寄存器访问和采样精度须单独记录实板验证，不能由测试通过推断。

## 六、定位与验证记录

- I01：[断开日志识别](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/liveWatch.js:610)、[断开回调和退出后通知](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4215)、[等待退出及保留会话](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4313)、[当前提示文案](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/i18n/zh.js:644)。
- I02：[ELF 等待及意图修改](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4081)、[启动代次校验](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4157)。
- I03：[准备期间的取消检查](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:2079)、[会话构造前检查](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:2107)、[停止入口](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4642)。
- I04：[OpenOcdStatusService.resolve](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/services/openocdStatusService.js:64)。
- I05：[CubeMX 子进程停止](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/services/cubemxRunner.js:39)。
- I06：[ChartHistoryService.fail](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/services/chartHistoryService.js:43)。
- I07：[CU 头解析及诊断](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/dwarf/parser.js:123)。
- I08：[外设计划与写入](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/services/svdPeripheralService.js:799)。
- I09：[Bridge 设置范围](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/services/configurationStore.js:34)。
- I10：[UI 下载路径](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:872)。
- I11：[符号循环](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/elfSymbols.js:284)。
- I12：[外部调试接管](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4353)、[第三方调试接管](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/mainViewProvider.js:4435)。
- I13：[MI 异常收尾](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/debug/mi.js:158)。
- I14：[SVD 库校验](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/services/svdLibraryService.js:38)。
- T01：[Flash 授权凭据](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/src/flashAuthorization.js:54)。
- 原报告：[CODE-REVIEW-c4e4230](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/docs/CODE-REVIEW-c4e4230.md)。
- 完整逐项复核及模拟记录保存在本机：[复核记录](C:/Users/28951/Desktop/EmberProbe-MCU-Flash-Debug/test-results/CODE-REVIEW-c4e4230-verification.md)。该文件位于忽略的 test-results，本汇总已保留核心结论，不依赖它才能理解问题。

审计基线 HEAD 此前已通过 check、quality、bundle、Extension Host E2E 和相关 GDB/枚举软件检查；这不反证故障路径及竞态复现。
本轮补充了 I01 的“提示早于退出确认”模拟检查，没有独立完成用户 USB 断开现象的实板复现。

## 七、修复实施与验证

| 范围 | 当前处理 |
| --- | --- |
| I01 | 立即禁用采样/CPU 采样和写入口，丢弃待发及迟到样本；显示关闭中，确认退出后才发布断开完成；未确认时保留租约、报告错误并可重试。致命 USB 错误不再进入调试 Tcl 自动重连。 |
| I02、I03、I12 | ELF/准备/端口等待后及创建会话前检查取消代次；Agent 停止等待准备收尾；外部和第三方调试接管等待 pending liveStart/liveStop。 |
| I04 | OpenOCD 状态发布代次与调用返回值解耦，并发刷新不再丢弃有效解析结果。 |
| I05、I13 | CubeMX/GDB 增加终止升级；CubeMX 退出未确认时有界返回错误但保留工程/子进程/暂存目录，可重试 cancel；外部 GDB 保留占用并允许再次收尾。 |
| I06 | 历史 Worker 失败立即终止，restart/dispose 等待同一终止流程。 |
| I07、I11 | DWARF 加入 20,000 CU / 1,024 诊断预算；ELF 加入 200,000 符号、16 KiB 单名称、16 MiB 累计名称扫描和 10 秒预算。预算错误中止解析。 |
| I08 | 读写计划统一校验 8/16/32/64 位寄存器的自然对齐，在任何目标读取/写入前拒绝无效地址。 |
| I09 | Bridge maxSamples 上限统一为 360,001；保留已弃用配置，修正文档中的显式点数限制描述，迁移说明指向 30 分钟历史和 chartHistoryMaxMiB。 |
| I10 | UI 在连接准备前生成有摘要的私有 ELF 快照，实际下载仅消费该快照；完成后清理。模拟替换源镜像不会改变被消费的内容。 |
| I14 | SVD 库校验及选择器 XML 校验移到 Worker；按摘要/设备身份去重和缓存，findCompatible 复用元数据。打包入口显式传入 Worker 路径。 |
| T01、T03 | Agent Flash/verify、变量/外设写入及 CubeMX 使用独立 VS Code 弹窗批准，实际计划在批准后再次核对。记住许可只来自 UI，重置同步撤销 UI 许可。自定义 SVD 保留，批准显示实际来源摘要及地址。 |
| T02、T04 | 自动端口分配失败明确报错，取消 6666 回退；Bridge 拒绝非受信任工作区。每次调用前检查技能实际摘要，自定义版本需 UI 批准且后续修改使其失效。本机同用户进程和无认证 Tcl 的边界见 [AGENT-TRUST-BOUNDARIES](AGENT-TRUST-BOUNDARIES.md)。 |

E 类已落实：项目身份/SVD 搜索采用有预算的异步文件扫描；序列样式容量限制；消息基础检查及自有命令属性查找；prepare 第二参数正确转发；清理被覆盖的 export 点击处理；Flash/变量/外设/CubeMX 共用确认存储的容量/TTL 基础实现；采样错误使用英文回退及稳定超时代码；人工批准服务纳入独立覆盖率门槛；本机可执行文件 realpath 后复核扩展名、CubeMX 脚本独占创建。

E02 中的终止会话 ID 和归档代次仍保留隔离语义；E07 的完整 provider 覆盖率与 webview checkJs、E08/E09 的未量化热路径重构仍属于后续工程改进，不计为本次已修复缺陷。没有为了缩小集合而丢弃迟到事件保护，也没有将性能候选宣称为已证实问题。

回归测试：[confirmed-issues.test.js](../test/confirmed-issues.test.js)，并扩展 Flash、SVD、连接准备和外部 GDB 测试。所有测试使用模拟硬件接口；真实 GDB 连接内存中的 RSP 模拟服务器。

完成门禁：npm run check（363 项文件检查，0 失败）、npm run quality（lint/格式/类型/覆盖率及各服务门槛）、npm run bundle、npm run test:e2e 均通过。test/gdb/enum-variables.test.js 的 ARM C/C++、DWARF 2/4/5、短/正常枚举组合，以及 test/gdb/external-debug.test.js 的真实 ARM GDB 对模拟 RSP 服务器检查均通过。环境为 Windows、Node 24.13.1；日志在本机 test-results/fix-*.log。

尚待单独实板验收：采样期间 USB 拔插是否彻底停止读取、实际 OpenOCD/JVM/GDB 进程退出、真实寄存器和目标支持。软件测试通过不替代这些结果。
