# MCP server / MCP 服务器

EmberProbe 随扩展提供一个 MCP（Model Context Protocol）stdio 服务器 `dist/mcp-server.js`，让支持 MCP 的客户端以结构化工具调用 EmberProbe。它与 Agent Skills 的脚本地位对等，都是本地 Agent Bridge 的客户端：鉴权、确认 ID 校验、输入校验与探针互斥全部留在扩展进程内，MCP 服务器只做 schema 校验、确认交互映射和结果/诊断转换，不包含硬件逻辑，也不绕过确认。

```
MCP 客户端 ──stdio──> dist/mcp-server.js ──HTTP 127.0.0.1 (Bearer token)──> Agent Bridge ──> services ──> ProbeCoordinator
skill 脚本 ──shell──> skills/*/scripts ─────┘（共用 bridge-locator 与诊断表）
```

## 启用 / Enabling

Agent 访问按工作区开启，开关保存在 VS Code 的 workspace state 中，不写工作区文件：

- 工作区装了 Agent Skills 且未显式设置时，沿用旧行为视为已启用；
- 命令 `EmberProbe: 为此工作区启用 Agent 访问` / `停用`，或侧边栏 Agent 区域的“启用 / 停用”按钮；
- 在 VS Code 中启动 EmberProbe MCP 服务器（同意 VS Code 的 MCP 信任提示后）也会为当前窗口启动 Bridge。

显式停用优先于以上所有条件。工作区必须受信任。

### VS Code（及兼容宿主）

扩展在支持 `vscode.lm.registerMcpServerDefinitionProvider` 的版本上注册 MCP server definition provider（id `emberprobe`），旧版本安静跳过（`engines.vscode` 仍为 `^1.85.0`）。服务器以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动，并注入 `EMBERPROBE_BRIDGE_INSTANCE`，直接连接本窗口的 Bridge，不做路径匹配。显式停用 Agent 访问、工作区不受信任或未打开文件夹时，不提供服务器定义。

### Cursor

EmberProbe 运行在 Cursor 中时，通过 Cursor 的扩展 API `vscode.cursor.mcp.registerServer` 自动注册服务器（名称 `emberprobe`），优先于 VS Code provider，无需手动配置。Cursor 没有 VS Code 那样的 MCP 信任提示和解析回调，因此只有本工作区的 Agent 访问已启用（显式启用，或兼容旧版的工作区 skills）时才注册，停用后注销；注册本身不会启动 Bridge。注册是 Cursor 全局的，不绑定窗口实例：服务器按 MCP roots / 工作目录定位 Bridge（见下文），多个窗口注册的内容相同。远程窗口中不注册，因为 Cursor 在本地启动 MCP 服务器，而服务器路径属于远端。

### 外部客户端 / External clients

运行命令 `EmberProbe: 安装 MCP 服务器到客户端`，选择客户端：

| 客户端 | 方式 |
|---|---|
| Claude Code | 显示并确认后运行 `claude mcp add --scope user emberprobe -e … -- <command> <args>` |
| Codex | 显示并确认后运行 `codex mcp add emberprobe --env … -- <command> <args>` |
| Cursor | 打开安装链接 `cursor://anysphere.cursor-deeplink/mcp/install?name=emberprobe&config=<base64>`，由 Cursor 弹出确认（EmberProbe 本身运行在 Cursor 中或处于远程窗口时不提供此项） |
| Antigravity | 复制专用 `mcpServers` JSON，包含当前主工作区和长任务超时；在客户端 raw config 中合并 |
| DeepSeek Harness (DSH) | 复制 `@deepseek-ai/dsh-mcp-client` 的 YAML `insert` patch，包含当前主工作区和长任务超时 |
| 其他客户端 | 把 `{ "mcpServers": { "emberprobe": { … } } }` 复制到剪贴板 |

配置由客户端自己的 CLI 或安装链接写入，扩展不直接修改任何客户端的配置文件。CLI 从 PATH 中查找（Windows 接受 `.exe`、`.cmd`、`.bat`；npm 安装的 `.cmd` 包装经 `cmd.exe` 调用，参数逐个加引号，含 `"`、`%`、`!` 的参数不执行）。添加失败时（例如已存在同名配置）先移除 `emberprobe` 再添加一次；找不到 CLI 或仍然失败时，安装命令复制到剪贴板，可在终端中手动运行。

启动命令全部是绝对路径，不依赖 PATH 中的 `node`：

- Windows：`command` 为编辑器自带的 Electron（安装根目录的 `Code.exe` / `Cursor.exe`，升级后路径不变），`env` 带 `ELECTRON_RUN_AS_NODE=1`，`args` 为稳定路径的启动器 `<globalStorage>/mcp/emberprobe-mcp.js`；
- macOS / Linux / 远程：`command` 为包装脚本 `<globalStorage>/mcp/emberprobe-mcp`，它以 `ELECTRON_RUN_AS_NODE=1` 用编辑器运行时执行启动器；运行时已不存在时（例如远程服务端升级后尚未重新打开窗口）才回退到 PATH 中的 `node`。

启动器和包装脚本在每次激活时重写为当前安装的扩展与运行时路径，因此扩展或编辑器升级后无需修改客户端配置。远程窗口（Remote-SSH、WSL）中路径属于远端，只适用于同样运行在远端的客户端。

Bridge 的端口和 token 每次启动都会变化，并且只保存在 globalStorage 中，所以只提供 stdio，不提供 HTTP 传输：stdio 服务器在每次调用时重新定位当前的 Bridge，客户端配置中没有 token。

### Antigravity

在 EmberProbe 命令中选择 **Antigravity**，把剪贴板 JSON 中的 `mcpServers.emberprobe` 合并到客户端已有配置，保留其他服务器。Antigravity IDE 中入口为 **MCP Servers → Manage MCP Servers → View raw config**；修改后刷新 MCP 服务器。当前官方配置位置为 `~/.gemini/config/mcp_config.json` 或工作区 `.agents/mcp_config.json`，不同版本以客户端打开的 raw config 为准。见 [Antigravity 官方 MCP 文档](https://antigravity.google/docs/mcp)。

生成配置使用绝对路径启动器，并在有工作区时设置 `env.EMBERPROBE_WORKSPACE` 为当前主根目录，避免客户端未提供 roots 或从安装目录启动时连错工程。`timeoutSeconds: 1800` 为用户确认、烧录及 CubeMX 等长调用提供有限的等待预算。切换到其他工程时重新导出，或更新 `EMBERPROBE_WORKSPACE`；多根工作区的配置仍以主根为准。

### DeepSeek Harness (DSH)

在 EmberProbe 命令中选择 **DeepSeek Harness (DSH)**，将剪贴板内容保存为 `emberprobe.cordis.yml`。这是可通过 `--patch` 加载的 YAML patch，不是 `mcpServers` JSON，也不是要覆盖现有 profile 的完整配置：

```sh
dsh web --patch "/absolute/path/emberprobe.cordis.yml"
```

Windows 同样使用文件的绝对路径，例如 `dsh web --patch "C:\projects\board\emberprobe.cordis.yml"`。patch 通过 `insert` 添加一个 `id: mcp-emberprobe`、`name: "@deepseek-ai/dsh-mcp-client"` 的插件条目；其 `config` 使用 `serverName: emberprobe`、`transport: stdio`、绝对启动路径与环境变量，并设置 `toolCallTimeoutMs: 1800000`。重复配置时更新已有条目，不重复插入同名服务器。有工作区时显式设置 `env.EMBERPROBE_WORKSPACE`，因此不依赖 DSH 的工作目录或 roots。见 [DSH 官方 MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) 和 [官方 patch 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/examples/mcp-memory/mcp-reference-memory.cordis.yml)。

DSH 加载后工具名形如 `mcp__emberprobe__config_get`。当前 DSH 不消费 MCP prompt 模板，因此本页的五个工作流 prompt 不会在 DSH 中出现；直接使用对应工具。未声明 elicitation 能力的客户端沿用下文的聊天确认流程。

两类配置都需要保持运行中的 EmberProbe 窗口，并在该工作区启用 Agent 访问。配置导出本身不会启动 Bridge 或授予硬件操作权限。远程窗口的配置仅供同一远端的客户端使用。30 分钟是客户端单次调用上限，不改变 Bridge 自身的操作预算；主动请求更长的采样时需自行调整客户端上限。

## 工作区定位 / Locating the Bridge

每个 EmberProbe 窗口在 `<globalStorage>/agent-bridges/<instanceId>.json`（权限 `0o600`）登记一条记录：Bridge 运行时包含端口和 token，未运行时只保留不含 token 的“未启用”标记。客户端（skill 脚本与 MCP 服务器共用 `skills/_emberprobe/bridge-locator.js`）按以下顺序定位：

1. `EMBERPROBE_BRIDGE_INSTANCE`：直接使用该实例；
2. 目标路径：`EMBERPROBE_WORKSPACE` > MCP 客户端的第一个 `file:` root（收到 `roots/list_changed` 后重新读取）> 当前目录。skill 脚本的 `--workspace` 优先于 `EMBERPROBE_WORKSPACE`；
3. 在已知宿主（VS Code、Insiders、Cursor、VSCodium、各类远程服务端）的 globalStorage 中查找工作区文件夹包含目标路径的实例，取最长匹配；匹配到非主根目录时照常连接，结果中给出 `bridge.workspace` 与 `BRIDGE_SECONDARY_ROOT` 提示（skill 脚本），因为配置与 ELF 解析仍以主根为准；
4. 回退到旧版工作区指针 `.agents/skills/_emberprobe/agent-bridge.json`，从目标路径逐级向上查找。

两个窗口（例如 VS Code 与 Cursor）打开同一文件夹时返回 `BRIDGE_AMBIGUOUS`，`details.instances` 列出 `hostApp`、`pid`、`startedAt`；用 `EMBERPROBE_BRIDGE_INSTANCE=<instanceId>` 指定实例，EmberProbe 不会自动挑选。找不到时返回 `BRIDGE_UNAVAILABLE`，`details` 中包含 `searchedFrom`、注册表条目数，以及命中了但未启用 Agent 访问的工作区 `bridgeDisabledFor`。协议范围（`protocol` / `minClientProtocol`）与端口、token 同源写入登记，不兼容时返回 `BRIDGE_PROTOCOL_MISMATCH`。

`EMBERPROBE_BRIDGE_REGISTRY`（`path.delimiter` 分隔）设置后只搜索这些目录，测试与受控环境用它隔离。

## 工具 / Tools

工具按工具集暴露，工具定义会常驻 Agent 上下文，只开启需要的部分。VS Code 中由设置 `emberprobe.mcp.toolsets` 控制，外部客户端用环境变量 `EMBERPROBE_MCP_TOOLSETS`（逗号分隔，`all` 表示全部），默认 `core,debug`：

| 工具集 | 工具 |
|---|---|
| `core` | `config_get` `config_set` `probe_list` `chip_read` `fault_read` `elf_analyze` `flash_program` `flash_verify` `permission_get` `permission_reset` `variables_read` `variables_sample` `variables_write` `variables_export_csv` `watch_add` `sampling_status` `sampling_control` `peripherals_list` `peripherals_read` `peripherals_write` |
| `debug` | `debug_status` `debug_inspect` `debug_breakpoints_list` `debug_start` `debug_select` `debug_control` `debug_breakpoints_update` `rtos_status` `rtos_snapshot` |
| `cubemx` | `cubemx_detect` `cubemx_inspect` `cubemx_status` `cubemx_prepare` `cubemx_candidate` `cubemx_check` `cubemx_start` `cubemx_execute` `cubemx_cancel` |

- 注解：`readOnlyHint` 由 `agent-client.js` 的 `READ_ONLY_METHODS`（可重试的只读方法）与 `OBSERVATION_METHODS`（不改变状态但可能访问硬件的方法）派生；`flash_program`、写入、CubeMX 生成与 `debug_control` 标记为 `destructiveHint`；所有工具 `openWorldHint: false`。
- schema 手写在 `src/mcp/tools.js`，全部 `additionalProperties: false`；`probeSerial` 保持字符串原样传递。最终校验仍由 Bridge 完成。
- 漂移测试（`test/mcp-tools.test.js`）要求每个工具对应现有的 Bridge 路由，每个路由要么被映射，要么列入显式排除清单。
- `flash_program` / `flash_verify` 先在服务器进程内运行与 skill 相同的预检（`flash-common.preflight`）；`ready === false` 时直接返回 `diagnostics` 与 `notes`，不进入确认。已有 24 小时工作区授权时直接执行，并在结果的 `authorization.trustedExpiresAt` 中报告到期时间。
- `debug_inspect` 的 `frame` 与 `reference` 是 Bridge 在上一次列表中返回的字符串句柄（`stackFrames[].frame`、`scopes[].reference`、`variables[].reference`），不是 DAP 整数；整数在 schema 校验时即被拒绝。句柄在恢复运行、写入、控制台命令或切换会话后失效，需要重新列出。

## 确认 / Confirmation

敏感工具（`flash_program`、`flash_verify`、`variables_write`、`peripherals_write`、`cubemx_start`、`cubemx_execute`）收到 Bridge 的确认响应后：

- 客户端声明了 elicitation 能力时，服务器发起 `elicitation/create`：消息包含问题与按 Bridge 实际响应渲染的计划摘要——烧录的 ELF 路径与 SHA-256、target、probe 与 serial、transport、速度；变量写入的 ELF 路径与 SHA-256、连接（target、probe、serial 或调试会话）及每个写入项的名称、地址、类型与新值；外设写入的 SVD 路径与 SHA-256、寄存器地址、新旧寄存器值与所请求的字段；CubeMX 的 `.ioc`、候选文件、CubeMX 版本与配置变更（最多 16 项，其余给出数量与完整 diff 路径）。表单只提供 Bridge 给出的 `choices` 加 `deny`，默认值为 `deny`。`once` 以确认 ID 重调；`workspace` 同时带 `remember: true`；拒绝、关闭、取消或弹窗失败都返回 `CONFIRMATION_DENIED`，操作结束。确认 ID 只在服务器内部使用，不出现在返回给 agent 的内容中。
- 客户端不支持 elicitation 时，返回计划、确认 ID 与 `nextStep` 说明：agent 必须把计划展示给用户、等待明确回答，再带 `confirmationId`（以及用户明确选择的 `remember`）重调，与 skill 流程一致。
- 确认 ID 过期或已使用时透传 `*_CONFIRMATION_INVALID`，服务器不会自动重新申请。
- CubeMX 生成方法 `cubemx.start` / `cubemx.execute` 只消费确认，计划由 `cubemx.prepare` 签发。因此 `cubemx_start` / `cubemx_execute` 未带确认 ID 时，服务器先以相同候选文件及其内容哈希调用 `cubemx.prepare`，再按上述方式确认；已有 24 小时项目授权时直接执行。`cubemx_prepare` 只返回计划与 `nextStep`，不返回确认 ID，agent 无法用它绕过 `cubemx_execute` / `cubemx_start` 的确认。

MCP 服务器不会因为用户的初始请求就选择 `remember`，也不会自动接受确认。elicitation 由客户端渲染，比聊天文本更接近人的操作证据，但 Bridge 仍不对此做认证（客户端可以被配置为自动应答），确认 ID 的计划绑定与一次性校验保持不变，见 [AGENT-TRUST-BOUNDARIES.md](AGENT-TRUST-BOUNDARIES.md)。

## 长任务、超时与取消 / Long calls

- Bridge 是请求/响应模式。请求带 `progressToken` 时，服务器在等待期间每 5 秒发送一次只含已耗时的 `notifications/progress`，避免客户端判定无响应；阶段性进度要等 Bridge 支持流式输出。
- 超时预算复用 `agent-client.js` 的方法表。状态变更类调用超时后结果未知（`details.resultUnknown: true`），按诊断建议先查询状态，不自动重发。
- 收到 `notifications/cancelled` 时，`cubemx_execute` 转发 `cubemx.cancel`；烧录与写入不中断，结果按未知处理。`variables_sample` 不转发取消，因为唯一的取消方法 `sampling.stop` 也会停止常驻采样。

## 结果与诊断 / Results

成功时 `structuredContent` 是 Bridge 的原始结果（数组或标量包在 `result` 中），`content` 是紧凑的 JSON 文本。失败时 `isError: true`，`structuredContent` 与 skill 写到 stderr 的 `diagnostic` 同形（`{ ok: false, type: "diagnostic", operation, error: { code, category, likelyCause, retryable, suggestedActions, actions, details } }`），由同一个 `diagnosticForError` 生成。诊断表中与通道相关的片段写成占位符：skill 脚本渲染成原有的 CLI 写法（如 `mcu-debug-control --start`，输出不变），MCP 渲染成工具名（如 `debug_start`）；`actions: [{ method: "debug.start" }]` 是与通道无关的机器可读版本。

## Prompts

服务器提供 `flash`、`fault_triage`、`variable_debug`、`rtos_inspect`（`core` / `debug`）与 `cubemx_generate`（`cubemx`）五个 prompt，可选参数 `goal`。内容在调用时直接读取随扩展分发的 `skills/<name>/SKILL.md` 与 `agent-workflow.md` 的 “Failure handling” 段落，并附上脚本到 MCP 工具的对照表，唯一来源仍是 `skills/`；`test/mcp-prompts.test.js` 检查对照表中的脚本与工具都真实存在。各 `SKILL.md` 也注明：会话提供 EmberProbe MCP 工具时优先使用，脚本是回退方式。

每次 Bridge 调用都会在输出面板 “EmberProbe Agent Bridge” 中记录通道（`skill` / `mcp` / `legacy`）、客户端、方法与结果码，不记录参数值。

## 客户端支持 / Client support

以下行为需要在各客户端中实测后记录；本表不预设结果：

| 客户端 | 连接 | 工具列表与注解 | elicitation | roots | 实测记录 |
|---|---|---|---|---|---|
| VS Code Copilot | provider | — | — | — | 待实测 |
| Claude Code | `claude mcp add` | — | — | — | 待实测 |
| Codex | `codex mcp add` | — | — | — | 待实测 |
| Cursor | 扩展 API / 安装链接 | — | — | — | 待实测 |
| Antigravity | 专用 stdio JSON 导出 | — | 按客户端能力选择 | 显式工作区，不依赖 roots | 配置生成、解析及 stdio 回归由自动测试覆盖；客户端交互待实测 |
| DeepSeek Harness (DSH) | 专用 stdio YAML patch 导出 | — | 未声明时使用聊天确认 | 显式工作区，不依赖 roots | 配置生成、解析及 stdio 回归由自动测试覆盖；客户端交互待实测，MCP prompts 不支持 |

## 排错 / Troubleshooting

- `BRIDGE_UNAVAILABLE` 且 `details.bridgeDisabledFor` 非空：该工作区未启用 Agent 访问，在侧边栏或命令面板中启用。
- `BRIDGE_UNAVAILABLE` 且 `registryEntries` 为 0：没有运行中的 EmberProbe 窗口，或客户端的工作目录 / roots 不在任何打开的文件夹内；设置 `EMBERPROBE_WORKSPACE`。
- `BRIDGE_AMBIGUOUS`：关闭多余窗口，或设置 `EMBERPROBE_BRIDGE_INSTANCE`。
- 外部客户端无法启动服务器：打开一次 EmberProbe 窗口以重写启动器与包装脚本；编辑器安装位置变化后重新运行 `EmberProbe: 安装 MCP 服务器到客户端`。
- Cursor 中看不到 EmberProbe 服务器：确认工作区受信任且已启用 Agent 访问。
- Antigravity / DSH 能列出工具但返回 `BRIDGE_UNAVAILABLE`：确认 EmberProbe 窗口仍在运行、Agent 访问已启用，且生成配置中的 `EMBERPROBE_WORKSPACE` 与该窗口主工作区一致；自定义宿主数据目录未被扫描到时，可设置 `EMBERPROBE_BRIDGE_REGISTRY` 指向实际 globalStorage 下的 `agent-bridges` 目录。
- DSH 没有出现 `mcp__emberprobe__*`：检查 patch 是否由目标 profile 加载、`@deepseek-ai/dsh-mcp-client` 是否可用，并查看启动日志；不要把 YAML patch 粘贴进 `mcpServers` JSON 配置。
