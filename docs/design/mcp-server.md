# MCP 服务器设计

用户配置见 [MCP 服务器](../guide/agent/mcp.md)，确认与信任边界见 [Agent 信任边界](agent-trust-boundaries.md)。

EmberProbe 随扩展提供一个 MCP（Model Context Protocol）stdio 服务器 `dist/mcp-server.js`，让支持 MCP 的客户端以结构化工具调用 EmberProbe。它与 Agent Skills 的脚本地位对等，都是本地 Agent Bridge 的客户端：鉴权、确认 ID 校验、输入校验与探针互斥全部留在扩展进程内，MCP 服务器只做 schema 校验、确认交互映射和结果/诊断转换，不包含硬件逻辑，也不绕过确认。

```
MCP 客户端 ──stdio──> dist/mcp-server.js ──HTTP 127.0.0.1 (Bearer token)──> Agent Bridge ──> services ──> ProbeCoordinator
skill 脚本 ──shell──> skills/*/scripts ─────┘（共用 bridge-locator 与诊断表）
```

## 注册

扩展在支持 `vscode.lm.registerMcpServerDefinitionProvider` 的版本上注册 MCP server definition provider（id `emberprobe`），旧版本安静跳过（`engines.vscode` 仍为 `^1.85.0`）。服务器以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动，并注入 `EMBERPROBE_BRIDGE_INSTANCE`，直接连接本窗口的 Bridge，不做路径匹配。显式停用 Agent 访问、工作区不受信任或未打开文件夹时，不提供服务器定义。

EmberProbe 运行在 Cursor 中时，通过 Cursor 的扩展 API `vscode.cursor.mcp.registerServer` 自动注册服务器（名称 `emberprobe`），优先于 VS Code provider，无需手动配置。Cursor 没有 VS Code 那样的 MCP 信任提示和解析回调，因此只有本工作区的 Agent 访问已启用（显式启用，或兼容旧版的工作区 skills）时才注册，停用后注销；注册本身不会启动 Bridge。注册是 Cursor 全局的，不绑定窗口实例：服务器按 MCP roots / 工作目录定位 Bridge（见“工作区定位”），多个窗口注册的内容相同。远程窗口中不注册，因为 Cursor 在本地启动 MCP 服务器，而服务器路径属于远端。

## 外部客户端配置写入

默认自动合并原生配置，不要求客户端 CLI 存在。侧边栏总是合并文件；Claude/Codex/Gemini 检测到 CLI 时，命令的对话框可选
“使用客户端 CLI”，任何客户端也可在对话框中选择“复制配置”。配置写入不在扩展激活时执行，也不会自动启用 Agent 访问。
“移除”先显示目标文件，确认后只删除 `emberprobe` 条目，保留其他服务器、设置和注释；不存在的文件不会被创建，已被改动的文件会拒绝写入。

扩展只写用户级配置，不写任何项目级配置文件，也不写入 `EMBERPROBE_WORKSPACE`。用户级条目由所有工程共用，工程由 Agent 自身的
MCP roots 或工作目录决定，所以多个工作区可以同时使用 Agent，互不干扰，切换工程也不需要重新安装。旧版写入的绑定在升级时移除。

OpenCode 优先使用 `OPENCODE_CONFIG` 指定的绝对路径；未指定时查找
`$XDG_CONFIG_HOME/opencode`（默认 `~/.config/opencode`），同目录优先 `opencode.jsonc`，没有文件时创建用户配置
`opencode.json`。工程内的 `opencode.json` 由用户自行维护，其中的同名服务器可能覆盖用户配置。环境变量路径覆盖必须为绝对路径。未被当前 VS Code 进程继承的环境设置不会被探测到，请核对安装对话框中的目标路径。

自动合并保留其他服务器、设置、注释以及 EmberProbe 条目中的自定义选项和额外环境变量；更新启动命令、参数、
支持的超时字段。JSONC 和 TOML 使用语法树定位编辑，DSH 只替换匹配的 MCP 条目，不重新序列化
其他 YAML 插件或执行 `!!js`。损坏/歧义配置、管理条目使用 YAML 标签/锚点、非 UTF-8 或超过 2 MiB 的文件会拒绝写入，
改为复制配置并说明失败原因。不会删除同名服务器再重试。

写入前复核预览时的原文件，使用锁和同目录临时文件原子替换，保留已有文件权限，新建文件使用 `0o600`。
DSH 多 profile 先全部校验再写入，中途失败回滚已写文件；若回滚时文件已被其他程序再次修改，会保留较新的内容并报告未完全回滚。
符号链接/Windows junction 指向同一文件时只写一次，预览后被改指向的路径会拒绝写入。已有 DSH 原生 `.lock` 不会被强制删除。

实现参考 [cc-switch 的 MCP 模块](https://github.com/farion1231/cc-switch/tree/main/src-tauri/src/mcp)：
`mcpClientConfig.js` 生成各 harness 的原生格式，`mcpConfigEdits.js` 合并配置，`mcpConfigFiles.js` 负责路径、预览与文件事务；
注册和安装 UI 留在 `mcpRegistration.js`。

### 启动命令

启动命令全部是绝对路径，不依赖 PATH 中的 `node`：

- Windows：`command` 为编辑器自带的 Electron（安装根目录的 `Code.exe` / `Cursor.exe`，升级后路径不变），`env` 带 `ELECTRON_RUN_AS_NODE=1`，`args` 为稳定路径的启动器 `<globalStorage>/mcp/emberprobe-mcp.js`；
- macOS / Linux / 远程：`command` 为包装脚本 `<globalStorage>/mcp/emberprobe-mcp`，它以 `ELECTRON_RUN_AS_NODE=1` 用编辑器运行时执行启动器；运行时已不存在时（例如远程服务端升级后尚未重新打开窗口）才回退到 PATH 中的 `node`。

启动器和包装脚本在每次激活时重写为当前安装的扩展与运行时路径，因此扩展或编辑器升级后无需修改客户端配置。远程窗口（Remote-SSH、WSL）中路径属于远端，只适用于同样运行在远端的客户端。

Bridge 的端口和 token 每次启动都会变化，并且只保存在 globalStorage 中，所以只提供 stdio，不提供 HTTP 传输：stdio 服务器在每次调用时重新定位当前的 Bridge，客户端配置中没有 token。

### 客户端超时

Codex 的原生配置包含 `tool_timeout_sec = 1800`，目标文件为 `$CODEX_HOME/config.toml`，未设置
`CODEX_HOME` 时为 `~/.codex/config.toml`。Gemini 的 JSON 和 CLI 包含 1800000 毫秒超时，OpenCode
的本地配置包含 `timeout: 1800000`。Claude/Codex 的 CLI 添加保持客户端默认超时；较长的人工确认或
CubeMX 调用应检查客户端超时，Codex 可选原生导出。自动配置不设置 Gemini 的 `trust: true` 或绕过任何硬件确认。

### DeepSeek Harness

SDK 和自定义 profile 保持原状。条目使用 `@deepseek-ai/dsh-mcp-client`、`serverName: emberprobe`、
`transport: stdio`、稳定绝对启动路径和 `toolCallTimeoutMs: 1800000`。按服务器名称查找并更新已有条目，
保留原插件 ID、自定义配置和其他插件；没有条目时添加 `mcp-emberprobe`。已有同名但冲突的插件不覆盖。

`$DSH_HOME/cordis.patch.yml` 若覆盖 EmberProbe，会拒绝 profile 自动写入，避免显示成功但被全局覆盖；请先处理该覆盖项。

## 工作区定位

每个 EmberProbe 窗口在 `<globalStorage>/agent-bridges/<instanceId>.json`（权限 `0o600`）登记一条记录：Bridge 运行时包含端口和 token，未运行时只保留不含 token 的“未启用”标记。客户端（skill 脚本与 MCP 服务器共用 `skills/_emberprobe/bridge-locator.js`）按以下顺序定位：

1. `EMBERPROBE_BRIDGE_INSTANCE`：直接使用该实例；
2. 目标路径：`EMBERPROBE_WORKSPACE` > MCP 客户端的第一个 `file:` root（收到 `roots/list_changed` 后重新读取）> 当前目录。skill 脚本的 `--workspace` 优先于 `EMBERPROBE_WORKSPACE`；
3. 在已知宿主（VS Code、Insiders、Cursor、VSCodium、各类远程服务端）的 globalStorage 中查找工作区文件夹包含目标路径的实例，取最长匹配；匹配到非主根目录时照常连接，结果中给出 `bridge.workspace` 与 `BRIDGE_SECONDARY_ROOT` 提示（skill 脚本），因为配置与 ELF 解析仍以主根为准；
4. 回退到旧版工作区指针 `.agents/skills/_emberprobe/agent-bridge.json`，从目标路径逐级向上查找。

两个窗口（例如 VS Code 与 Cursor）打开同一文件夹时返回 `BRIDGE_AMBIGUOUS`，`details.instances` 列出 `hostApp`、`pid`、`startedAt`；用 `EMBERPROBE_BRIDGE_INSTANCE=<instanceId>` 指定实例，EmberProbe 不会自动挑选。找不到时返回 `BRIDGE_UNAVAILABLE`，`details` 中包含 `searchedFrom`、注册表条目数，以及命中了但未启用 Agent 访问的工作区 `bridgeDisabledFor`。协议范围（`protocol` / `minClientProtocol`）与端口、token 同源写入登记，不兼容时返回 `BRIDGE_PROTOCOL_MISMATCH`。

`EMBERPROBE_BRIDGE_REGISTRY`（`path.delimiter` 分隔）设置后只搜索这些目录，测试与受控环境用它隔离。

## 工具

MCP 固定暴露全部工具和工作流提示，不支持更改暴露范围；旧的 `emberprobe.mcp.toolsets` 和 `EMBERPROBE_MCP_TOOLSETS` 不再生效。

- 注解：`readOnlyHint` 由 `agent-client.js` 的 `READ_ONLY_METHODS`（可重试的只读方法）与 `OBSERVATION_METHODS`（不改变状态但可能访问硬件的方法）派生；`flash_program`、写入、CubeMX 生成与 `debug_control` 标记为 `destructiveHint`；所有工具 `openWorldHint: false`。
- schema 手写在 `src/mcp/tools.js`，全部 `additionalProperties: false`；`probeSerial` 保持字符串原样传递。最终校验仍由 Bridge 完成。
- 漂移测试（`test/mcp-tools.test.js`）要求每个工具对应现有的 Bridge 路由，每个路由要么被映射，要么列入显式排除清单。
- `flash_program` / `flash_verify` 先在服务器进程内运行与 skill 相同的预检（`flash-common.preflight`）；`ready === false` 时直接返回 `diagnostics` 与 `notes`，不进入确认。已有 24 小时工作区授权时直接执行，并在结果的 `authorization.trustedExpiresAt` 中报告到期时间。
- `debug_inspect` 的 `frame` 与 `reference` 是 Bridge 在上一次列表中返回的字符串句柄（`stackFrames[].frame`、`scopes[].reference`、`variables[].reference`），不是 DAP 整数；整数在 schema 校验时即被拒绝。句柄在恢复运行、写入、控制台命令或切换会话后失效，需要重新列出。

## 确认

敏感工具（`flash_program`、`flash_verify`、`variables_write`、`peripherals_write`、`cubemx_start`、`cubemx_execute`）收到 Bridge 的确认响应后：

- 侧栏“Agent 配置”中开启“完全允许 Agent 操作”后，Bridge 对适用操作返回 `mode: "full"`，MCP 直接执行烧录、Flash 校验、写入和 CubeMX 生成，不再发起操作确认。关闭后恢复原有授权流程；探针、目标、数据与工作区校验仍保留，匿名探针和 ELF 不匹配等限制仍生效。见 [Agent 权限](../guide/agent/permissions.md)。
- 客户端声明了 elicitation 能力时，服务器发起 `elicitation/create`：消息包含问题与按 Bridge 实际响应渲染的计划摘要——烧录的 ELF 路径与 SHA-256、target、probe 与 serial、transport、速度；变量写入的 ELF 路径与 SHA-256、连接（target、probe、serial 或调试会话）及每个写入项的名称、地址、类型与新值；外设写入的 SVD 路径与 SHA-256、寄存器地址、新旧寄存器值与所请求的字段；CubeMX 的 `.ioc`、候选文件、CubeMX 版本与配置变更（最多 16 项，其余给出数量与完整 diff 路径）。表单只提供 Bridge 给出的 `choices` 加 `deny`，默认值为 `deny`。`once` 以确认 ID 重调；`workspace` 同时带 `remember: true`；拒绝、关闭、取消或弹窗失败都返回 `CONFIRMATION_DENIED`，操作结束。确认 ID 只在服务器内部使用，不出现在返回给 agent 的内容中。
- 客户端不支持 elicitation 时，返回计划、确认 ID 与 `nextStep` 说明：agent 必须把计划展示给用户、等待明确回答，再带 `confirmationId`（以及用户明确选择的 `remember`）重调，与 skill 流程一致。
- 确认 ID 过期或已使用时透传 `*_CONFIRMATION_INVALID`，服务器不会自动重新申请。
- CubeMX 生成方法 `cubemx.start` / `cubemx.execute` 只消费确认，计划由 `cubemx.prepare` 签发。因此 `cubemx_start` / `cubemx_execute` 未带确认 ID 时，服务器先以相同候选文件及其内容哈希调用 `cubemx.prepare`，再按上述方式确认；已有 24 小时项目授权时直接执行。`cubemx_prepare` 只返回计划与 `nextStep`，不返回确认 ID，agent 无法用它绕过 `cubemx_execute` / `cubemx_start` 的确认。

MCP 服务器不会因为用户的初始请求就选择 `remember`，也不会自动接受确认。elicitation 由客户端渲染，比聊天文本更接近人的操作证据，但 Bridge 仍不对此做认证（客户端可以被配置为自动应答），确认 ID 的计划绑定与一次性校验保持不变，见 [Agent 信任边界](agent-trust-boundaries.md)。

## 长任务、超时与取消

- Bridge 是请求/响应模式。请求带 `progressToken` 时，服务器在等待期间每 5 秒发送一次只含已耗时的 `notifications/progress`，避免客户端判定无响应；阶段性进度要等 Bridge 支持流式输出。
- 超时预算复用 `agent-client.js` 的方法表。状态变更类调用超时后结果未知（`details.resultUnknown: true`），按诊断建议先查询状态，不自动重发。
- 收到 `notifications/cancelled` 时，`cubemx_execute` 转发 `cubemx.cancel`；烧录与写入不中断，结果按未知处理。`variables_sample` 不转发取消，因为唯一的取消方法 `sampling.stop` 也会停止常驻采样。

## 结果与诊断

成功时 `structuredContent` 是 Bridge 的原始结果（数组或标量包在 `result` 中），`content` 是紧凑的 JSON 文本。失败时 `isError: true`，`structuredContent` 与 skill 写到 stderr 的 `diagnostic` 同形（`{ ok: false, type: "diagnostic", operation, error: { code, category, likelyCause, retryable, suggestedActions, actions, details } }`），由同一个 `diagnosticForError` 生成。诊断表中与通道相关的片段写成占位符：skill 脚本渲染成原有的 CLI 写法（如 `mcu-debug-control --start`，输出不变），MCP 渲染成工具名（如 `debug_start`）；`actions: [{ method: "debug.start" }]` 是与通道无关的机器可读版本。

## Prompts

服务器提供 `flash`、`fault_triage`、`variable_debug`、`rtos_inspect`（`core` / `debug`）与 `cubemx_generate`（`cubemx`）五个 prompt，可选参数 `goal`。内容在调用时直接读取随扩展分发的 `skills/<name>/SKILL.md` 与 `agent-workflow.md` 的 “Failure handling” 段落，并附上脚本到 MCP 工具的对照表，唯一来源仍是 `skills/`；`test/mcp-prompts.test.js` 检查对照表中的脚本与工具都真实存在。各 `SKILL.md` 也注明：会话提供 EmberProbe MCP 工具时优先使用，脚本是回退方式。

每次 Bridge 调用都会在输出面板 “EmberProbe Agent Bridge” 中记录通道（`skill` / `mcp` / `legacy`）、客户端、方法与结果码，不记录参数值。

## 客户端实测状态

以下行为需要在各客户端中实测后记录；本表不预设结果：

| 客户端 | 连接 | 工具列表与注解 | elicitation | roots | 实测记录 |
|---|---|---|---|---|---|
| VS Code Copilot | provider | — | — | — | 待实测 |
| Claude Code | 原生 JSON / 可选 CLI | — | — | — | 待实测 |
| Codex | 原生 TOML / 可选 CLI | — | — | — | 待实测 |
| Gemini CLI | 原生 JSON / 可选 CLI | — | 按客户端能力选择 | — | 配置与 stdio 回归由自动测试覆盖；客户端交互待实测 |
| OpenCode | 原生 local JSON/JSONC 写入 | — | 按客户端能力选择 | — | 配置与 stdio 回归由自动测试覆盖；客户端交互待实测 |
| Cursor | 扩展 API / 安装链接 | — | — | — | 待实测 |
| Antigravity | 原生 JSON 写入 | — | 按客户端能力选择 | — | 配置合并、文件事务及 stdio 回归由自动测试覆盖；客户端交互待实测 |
| DeepSeek Harness (DSH) | 原生 profile YAML 写入 | — | 未声明时使用聊天确认 | — | 配置合并、文件事务及 stdio 回归由自动测试覆盖；客户端交互待实测，MCP prompts 不支持 |
