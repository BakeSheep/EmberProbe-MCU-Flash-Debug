# CubeMX 代码生成设计

用户操作见 [CubeMX 代码生成](../guide/agent.md#cubemx-代码生成)。生成器由所选工程文件决定，`.ioc` 使用 STM32CubeMX，`.ioc2` 使用 STM32CubeMX2。两者共用安全流程：准备候选、在 Agent 会话中确认、分别生成基线和候选、检查工作区漂移、备份后写回，并记录结果供 `--check` 使用。

## 工具发现与工程识别

侧栏工程选择器和自动配置均识别 `.ioc` 与 `.ioc2`。后台检测保留有效选择，只自动接受唯一候选。用户显式发起检测且存在多个候选时，由用户选择。所选工程决定工具状态和固件包检查方式。两种工程格式都参与目标识别，CubeMX2 的 `mcuUID` 指定器件，工程目录限定 ELF 排序范围。扩展与随包 Skills 共用识别规则。

`emberprobe.cubemx2Path` 指向 CubeMX2 启动器，如 `stm32cubemx2-1.1.2.exe`。发现顺序如下。

1. 读取 ST 的外部包登记 `$CUBE_BUNDLE_PATH/.config/external_bundles.json`。默认根目录为 Windows 上的 `%LOCALAPPDATA%/stm32cube/bundles`，或 Linux 上的 `$XDG_DATA_HOME/stm32cube/bundles`（未设置时为 `~/.local/share/stm32cube/bundles`）。核对 `stm32cubemx-application` 清单及匹配的独立启动器，多个有效版本取最新。
2. 无有效登记时，调用 `cube --resolve --json mx`。优先使用 STM32Cube Core 随包 CLI，否则使用 PATH 中的 `cube`。该命令只解析官方应用包。
3. CLI 不可用或记录无效时，回退到常见安装目录、版本目录和 PATH，在 Windows 上还检查桌面与开始菜单快捷方式及卸载注册项。

登记与清单 JSON 读取上限为 2 MiB。Linux 接受可执行的 `stm32cubemx2` 或 `stm32cubemx2-<version>`，macOS 暂无自动检测。

## 固件包与版本匹配

传统 CubeMX 从 `.ioc` 读取所需固件版本，校验更新仓库中的 `package.xml`、CMSIS 和 HAL 目录，并要求版本精确匹配。安装请求采用 `ask`，由 CubeMX 处理账户和许可。

CubeMX2 从所选 `.ioc2` 中读取解决方案、项目和层的包声明。包名来自工程元数据，未选择工程时可从目标系列推断 DFP 和 HAL 包。校验已安装 PDSC 的厂商、名称和最新发布版本是否与安装目录一致。支持精确版本、缺省版本、稳定版 `>=`、`^` 和 `~`。本地路径、上下文筛选及其他表达式返回未知。元数据只确认安装身份，生成仍需验证包内容及传递依赖。

包根目录按 `CMSIS_PACK_ROOT`、平台 `stm32cube/CubeUserConfig.json` 的 `cmsis_pack_root`、平台数据目录下的 `stm32cube/packs` 依次解析。检查只读本地文件。CubeMX2 的管理操作不带工程或安装参数地打开启动器，用户安装后刷新状态。

侧栏同一行并列展示所需和已安装版本。缺包提供安装，低于已知要求提供升级，精确版本不匹配时仍指向所需版本安装。版本要求未知时提供管理。详细仓库与诊断信息在悬停中提供。传统生成校验 `MxCube.Version`，候选验证保留 `ProjectManager.FirmwarePackage`，固件包或迁移错误优先于 CLI 的成功信息。CubeMX2 用 `mx2Version` 选择匹配的应用包，工程迁移和包版本修改由相应 CubeMX 应用完成。侧栏状态供预检参考，完整校验由生成器完成。

版本匹配参考 [CMSIS 项目包格式](https://open-cmsis-pack.github.io/cmsis-toolbox/YML-Input-Format/)，仓库配置参考 [ST Cube CLI 文档](https://dev.st.com/stm32cube-docs/stm32cubecli/latest/en/docs/markup/STM32CubeCLI_Command_Reference.html)。

## 生成与写回

### 暂存、基线与漂移

在工作区以外的系统临时目录（`emberprobe-cubemx-stage-*`）分别生成基线和候选。短路径可缓解 Windows 上 `Drivers`、`Middlewares` 的深层路径问题。只有确认 CubeMX 退出后才删除暂存目录，下次建立目录时清理崩溃遗留且超过 24 小时的目录。`ProjectManager.UnderRoot=false` 时，将现有源码放入 CubeMX 使用的同名项目子目录，供原生 Keep User Code 读取。

两次生成均须产出预期的 `main.c`。暂存目录中的原始副本和通用 `OK` 不能证明生成发生。内容未变化时，CubeMX 可能保留文件时间戳，此时接受明确指向该暂存文件的生成记录。

基线对比保留文本换行，并识别等价的 `.mxproject` 节与键顺序及已知路径分隔符。一般源码空白和有意义的元数据变化仍参与对比，工作区并发检查仍逐字节核对。写回前校验 C/C++ 的 USER CODE 块。真实漂移返回 `CUBEMX_BASELINE_DRIFT`，`details.changes` 和 `details.baselineOutput` 提供证据，人工编辑保留。

快照跳过版本控制、编辑器和 Agent 工具目录。CubeMX 输入与输出中的链接一律拒绝，包括 `Core`、`Drivers`、`Middlewares`、`cmake`、工程文件、链接脚本、启动文件和根级生成构建文件，防止重定向写入或将外部源码交给 Keep User Code。其他链接跳过，生成结果命中或位于这些链接下时返回 `linked_output_path`。

### 日志、备份与退出

宿主在读取 stdout/stderr 时跟踪完成和错误状态。生成失败提供最近 100 行（最多 16 Ki 个字符）和可获得的首个失败行，异常长的单行会被拒绝。对 `project generate` 的 `KO` 判为失败，其他脚本命令的 `KO` 不等同于生成失败。匹配 `WebUtils`、`HomeAdPanel`、`*Updater*` 或 `*Advert*` 的联网错误及其后续堆栈降为警告。固件包、迁移或生成错误始终阻止写回，其他来源的错误与异常也保持失败。

诊断目录由 `diagnosticsPath` 返回。生成日志写入 `baseline.log`、`generating.log` 或 `deepCheck.log`，漂移证据放入 `baseline-drift/`。首次写入工作区文件前，`backup/` 保存全部被修改或删除文件的原始字节，用于 `recoveryRequired` 恢复。每项目保留最近 20 个诊断目录，保留记录引用的备份以及源状态为 `recoveryRequired` 或 `unknown` 的目录不清理。操作记录保留最近 50 条。

逐文件写入同目录的 `.emberprobe-cubemx-write-<hex>` 临时文件，完成后重命名替换。下次生成或深度检查持有项目任务槽时，只清理超过 10 分钟的遗留临时文件，以免影响另一窗口的在途写入。清理结果附在 `warnings`。

启动前取消时，已取消的任务不创建脚本，取消期间已创建的脚本在返回前删除。进程启动后的取消或超时先请求退出，再强制终止。无法确认退出时返回 `CUBEMX_EXIT_UNCONFIRMED`，并保留项目占用和暂存文件，禁止新生成或深度检查。`cubemx.cancel` 可重试终止，只有确认退出才释放占用并完成清理。

### 确认边界

Agent 展示工程和变更计划，等待用户明确答复后提交绑定计划的确认 ID。最长 24 小时的项目授权要求用户在会话中明确选择并提交 `remember`。执行会重新计算工程身份，拒绝变化的计划。扩展不会再为同一操作弹出第二个确认框。通用授权见 [Agent 信任边界](agent-trust-boundaries.md)。

## CubeMX2 后端与文件所有权

### 应用包与后端隔离

应用包位于启动器的 `resources/stm32cubemx-application/<version>/`，包含 `CubeBundle.json`、`dist/bin.js`、后端和配套 Node。按 `mx2Version` 选择匹配包，后端环境从清单的导出变量展开（例如 `CUBE_MX2_INTERNAL_BUNDLES`、`CUBE_DCM`、`COOP_API_COMPATIBILITY`）。

同一用户数据目录下的 Electron 后端可能交接给已运行的实例，CLI 省略 `--port` 也可能选择现有 GUI。因此每个操作使用私有用户数据目录启动后端，只用该后端报告的端口通信，结束时执行 `shutdown --port`，必要时清理进程树。CLI 结果是 JSON，错误可能出现在 stdout 或 stderr，解析时保留可能先出现的诊断。无法确认 CubeMX2 后端退出时，结果附 `CUBEMX2_EXIT_UNCONFIRMED` 并保留暂存目录。

`.ioc2` 是 TOML 容器，`"File: <relative path>"` 条目内嵌 JSON 或 YAML，`["Project Description"]` 保存包括 `workingAreaId` 和 `mx2Version` 的元数据。后端操作先修改模型，显式保存后才更新项目文件。暂存副本使用新的工作区标识，语义变更按设置主题归类，避免将保存重排序当成配置变更。

### 生成与所有权规则

生成总是在空的基线和候选目录执行，使用本机包。生成结果的 `.settings/exported-files.json` 记录文件摘要和 `fileGroup`，对比时忽略其中的导出时间戳。

- `generated`、`project_file` 和 `pack` 由 CubeMX2 管理，工作区文件须仍与基线一致才能写回。旧工程生成而候选不再生成的文件，仅在确认未修改后删除。
- `user_code` 和 `RTE` 只在文件缺失时写入。已有人工修改保留并出现在 `warnings`，深度检查通过 `userCodeChanges` 与 `user_modified` 标明。
- 写回用候选 `.ioc2` 更新工程文件，生成流程只使用本地包。

## Agent 接口

| 操作 | MCP 工具 | `mcu-cubemx` 脚本 |
| --- | --- | --- |
| 查看芯片、外设、引脚与导出设置 | `cubemx_inspect` | `--inspect`，可用 `--prefix` 过滤内部文件 |
| 运行只读 CubeMX2 查询 | `cubemx_query` | `--query --operations '<json>'` 或 `--operations-file` |
| 在暂存副本准备配置变更 | `cubemx_prepare`（`operations`） | `--prepare --operations-file ops.json` |
| 按确认计划生成 | `cubemx_start` / `cubemx_execute`（`candidateHash`） | `--start --candidate-hash <hash> --confirm <id>` |
| 检查一致性 | `cubemx_check` | `--check [--deep]` |

操作示例为 `{ "command": "peripherals enable", "args": { "peripheral": "USART1", "mode": "Async" } }`。选项名不带短横线，标志以 `true` 表示。宿主负责提供工程路径与端口，拒绝调用方传入 `project-path`、`port` 和 `host`。`src/services/cubemx2Commands.js` 定义允许的外设、引脚、时钟、NVIC、DMA、EXTI、中间件、软件配置和构建目标操作，也允许相关的只读实用查询。创建或删除项目、安装包、启用中间件组件、`generate` 和 `save` 由宿主管理或留给应用界面。

准备阶段在新的暂存工作区依次执行操作、保存并查询 `clock get-clock-status`。结果包含各操作输出、时钟状态、`candidateHash` 和按主题归类的语义变更。扩展存储保留最近 20 个候选，不写工作区。任一操作失败使整个准备失败，结果不存为候选。

CubeMX2 的诊断区分缺少工具或应用包（`CUBEMX2_MISSING`、`CUBEMX2_BUNDLE_MISSING`）、版本或工程不符（`CUBEMX2_VERSION_MISMATCH`、`CUBEMX2_PROJECT_INVALID`、`CUBEMX2_PROJECT_REQUIRED`）、无效操作和命令失败（`CUBEMX2_OPERATION_INVALID`、`CUBEMX2_COMMAND_FAILED`）、缺包（`CUBEMX2_PACK_MISSING`）以及后端、超时或生成结果错误（`CUBEMX2_BACKEND_FAILED`、`CUBEMX2_TIMEOUT`、`CUBEMX2_OUTPUT_TOO_LARGE`、`CUBEMX2_BUILD_TARGET_MISSING`、`CUBEMX2_OUTPUT_INVALID`）。

## 验证边界

生成安全、工作区隔离和回归测试见 `test/cubemx-generation-safety.test.js`、`test/cubemx-workspace-isolation.test.js` 和 `test/cubemx.test.js`，无需安装 CubeMX 或连接实板。CubeMX2 原型的后端生命周期与代码生成在 Windows 上用 1.2.0 和 STM32C593RET6 工程验证，细节见本地 `docs/records/validation/cubemx2.md`。该记录不覆盖 Linux 后端、生成工程编译或实板烧录。
