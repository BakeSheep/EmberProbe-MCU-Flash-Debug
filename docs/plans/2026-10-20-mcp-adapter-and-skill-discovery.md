# MCP 适配层与 Agent Bridge 发现修复技术方案

**目标：** 在现有 Agent Bridge 之上增加一个薄的 MCP 服务器，让支持 MCP 的客户端以结构化工具调用 EmberProbe；同时修复 Bridge 发现、全局 Skills 遗留副本和完整性检查中的已知问题，使 skills 与 MCP 两条通道共用同一套发现、鉴权和确认语义。

**架构：** Bridge（`src/agentBridge.js` + `src/services/agentService.js` + `src/services/agentRoutes.js`）仍是唯一执行入口与信任边界。新增共享的 Bridge 定位模块和 globalStorage 实例注册表；MCP 服务器是 stdio 进程，只做 schema 校验、确认交互映射和结果/诊断转换，不包含硬件逻辑。Skills 保留，降级为流程知识层加脚本回退。

**技术栈：** CommonJS、esbuild 新入口、MCP stdio 协议（SDK 选型见第 10 节）、VS Code MCP server definition provider（特性检测）、Node assert 测试。

---

## 1. 现状与已确认问题

### 1.1 当前调用链

```
Agent ──shell──> node skills/<name>/scripts/*.js
                   └─ skills/_emberprobe/agent-client.js
                        descriptor(workspace = --workspace || cwd)
                        ├─ <ws>/.agents/skills/_emberprobe/agent-bridge.json   (指针，无 token)
                        └─ <globalStorage>/agent-bridge-<sha256(ws)[0:16]>.json (port + token)
                   ──HTTP POST /v1/call (Bearer token)──> AgentBridge
                        └─ AgentService.call → onCall(_warnIfSkillsModified) → routes
```

敏感操作返回统一形状的确认响应（`src/writeAuthorization.js` 的 `_request`，flash/peripheral/cubemx 同构）：
`{ confirmationRequired: true, confirmationId, expiresAt, question, choices: ["once"] | ["once","workspace"], ...plan }`。

### 1.2 问题清单

| 编号 | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | 全局安装已在 `4353141`（2026-09-12）禁用，但遗留的 `~/.agents/skills` 副本仍会被读取，且不会自动更新 | `src/skillInstaller.js:255` 对非 workspace 范围直接抛错；`inspectSkills` 仍检查 global（`:235`）；`SkillStatusService.updateEnabledSkills` 只更新 workspace；`msg.skillsInstalledGlobal` 已无调用方 | 旧版本用户手上的全局副本永久停在旧版本，协议或脚本变更后会静默失效 |
| P2 | Bridge 启动绑定在“工作区装了 skills”上 | `src/mainViewProvider.js:2904-2910` `_syncAgentBridgeWithSkills` → `hasWorkspaceSkills` | 只有全局副本时 Bridge 不启动、不写指针，agent 拿到 `BRIDGE_UNAVAILABLE`；MCP 通道也会被这个条件挡住 |
| P3 | 完整性检查的对象与实际执行的副本可能不一致 | `inspectSkills` 按 skill 合并状态时 workspace 优先（`src/skillInstaller.js:240-241`）；实际执行哪份副本由 agent 的 skill 解析顺序决定 | workspace 副本干净、全局副本已被修改或过期时，检查通过，但执行的可能是全局那份。这是同一 OS 用户信任边界内的一致性缺口，不是提权，但它让“已安装 skill 哈希审批”失去意义 |
| P4 | 发现只看 `--workspace` 或 `cwd`，不向上查找；多根工作区只绑定第一个根 | `agent-client.js:6-11`；`mainViewProvider.js:481` `workspaceFolders?.[0]` | 在子目录或第二个根目录里启动 agent 时找不到 Bridge |
| P5 | 同一文件夹被两个宿主实例（如 VS Code 与 Cursor，或 Remote 与本地）同时打开时，描述文件按路径哈希命名，后启动者覆盖前者；后者停止时按自己的 token 删除描述文件和指针 | `src/agentBridge.js:38`、`stop()` | 先启动的实例仍在监听，但再也无法被发现，直到它重启 |
| P6 | 客户端不校验 `protocol`；诊断建议写死成 CLI 形式 | `agent-client.js:33` 只校验 host/port/token；`diagnosticForError` 中如“使用 mcu-debug-control --start 启动后重试” | 版本错配时报错含糊；MCP 通道复用诊断时会把 agent 引向不存在的 shell 命令 |

---

## 2. 目标与非目标

**目标**

1. 新增 MCP stdio 服务器，覆盖现有 Bridge 方法，带读写注解，以及确认与 elicitation 映射。
2. 引入 Bridge 实例注册表和共享定位模块，修复 P2、P4、P5、P6。
3. 修复 P3：完整性检查针对实际发起调用的那份 skill。
4. 处理 P1：明确全局副本的去留，提供迁移和清理路径。
5. skills 与 MCP 共用同一套诊断，诊断里的建议动作与具体通道无关。

**非目标**

- 不改变确认语义：`remember` 规则、24 小时绑定字段、无可靠 serial 只允许 `once`、校验必须一次性，全部保持原样（见 `docs/AGENT-TRUST-BOUNDARIES.md`）。
- 不对网络暴露 Bridge 或 MCP；本期不做 Streamable HTTP 传输。
- 不删除 skills，不修改 `README.md`，不做 HIL。

---

## 3. 总体架构

```
             ┌──────────────────────── Agent 客户端 ───────────────────────┐
             │ Claude Code / Codex (skills + MCP)   VS Code Copilot / Cursor (MCP) │
             └──────┬──────────────────────────────────────┬──────────────┘
         shell      │                                stdio │ (MCP)
   skills/*/scripts │                       dist/mcp-server.js
                    ▼                                      ▼
            skills/_emberprobe/bridge-locator.js  (共享：注册表 → 指针回退 → 协议协商)
                    │  X-EmberProbe-Channel: skill | mcp
                    │  X-EmberProbe-Skill-Root: <实际执行的 skill 根目录>
                    ▼
        AgentBridge  POST /v1/call  (Bearer token, 127.0.0.1)
                    ▼
        AgentService.call → 完整性检查(按通道/根目录) → routes → services → ProbeCoordinator
```

关键原则：MCP 服务器和 skill 脚本都是 Bridge 的客户端，地位对等。所有授权、确认 ID 校验、输入校验（`src/validation.js`）和硬件互斥都留在扩展进程内。

---

## 4. Bridge 发现：实例注册表与定位算法（修复 P2/P4/P5/P6）

### 4.1 实例注册表

- 位置：`<globalStorage>/agent-bridges/<instanceId>.json`，`instanceId` 为每次启动随机生成的 128 位十六进制串，文件权限 `0o600`。
- 内容：

  ```json
  {
    "protocol": 2,
    "minClientProtocol": 1,
    "instanceId": "…",
    "host": "127.0.0.1",
    "port": 51234,
    "token": "…",
    "pid": 12345,
    "hostApp": "vscode | cursor | …",
    "extensionVersion": "0.8.8",
    "primaryWorkspace": "C:\\proj",
    "workspaceFolders": ["C:\\proj", "C:\\libs\\hal"],
    "startedAt": "…"
  }
  ```

- 生命周期：启动时写入；工作区文件夹变化时（`onDidChangeWorkspaceFolders`）原子重写；停止时只删除自己的 `instanceId` 文件。定位方读到 pid 不存在或连接被拒的条目时，视为陈旧条目并忽略；清理工作交给扩展启动时统一做，定位方不删文件。
- 兼容：旧的 `agent-bridge-<key>.json` 描述文件和工作区指针在过渡期继续写入，供旧版脚本使用，写入条件保持不变（工作区装了 skills）。新客户端优先读注册表，所以 P5 只会在旧客户端上残留。

### 4.2 共享定位模块 `skills/_emberprobe/bridge-locator.js`

skill 脚本和 MCP 服务器共用这个模块（打包时 MCP 入口直接 `require` 它）。它从 `agent-client.js` 的 `descriptor()` 抽出来，并在此基础上扩展。

输入：目标路径。按优先级取 `--workspace` 参数、`EMBERPROBE_WORKSPACE` 环境变量、MCP `roots`，最后才是 `cwd`。另有一个可选的 `EMBERPROBE_BRIDGE_INSTANCE` 环境变量。

算法：

1. 设置了 `EMBERPROBE_BRIDGE_INSTANCE`（VS Code 自行启动 MCP 时会注入）：直接读取对应的注册表条目，不做路径匹配。
2. 遍历注册表：路径先做 `realpath` 规范化，win32 下忽略大小写。选出 `workspaceFolders` 中有任一项是目标路径本身或其祖先的条目，取匹配最长的那个。
   - 多个实例的匹配长度相同（P5 场景）：返回 `BRIDGE_AMBIGUOUS`，在 `details.instances` 里列出 `hostApp`、`pid`、`startedAt`，并建议用 `--bridge-instance` 或 `EMBERPROBE_BRIDGE_INSTANCE` 指定实例。不自动挑选，这与“不猜测”原则一致。
   - 命中的是非主根目录：照常连接，但在结果的 `bridge.workspace` 中报告主根目录，并给出 `BRIDGE_SECONDARY_ROOT` 提示。因为 Bridge 的配置和 ELF 解析仍以主根为准。
3. 回退到旧方式：从目标路径逐级向上查找 `.agents/skills/_emberprobe/agent-bridge.json` 指针，到文件系统根为止，然后按原有逻辑读取描述文件。
4. 都没找到时返回 `BRIDGE_UNAVAILABLE`。`details` 中包含 `searchedFrom`、注册表条目数，以及 `bridgeDisabledFor`（命中了工作区但该工作区未启用 Agent 访问时填写，见 4.3），让 agent 能准确告诉用户该点哪里。

协议协商：连接后先调用已有的 `capabilities` 方法（2 秒预算），再检查 `minClientProtocol <= 客户端协议 <= protocol`；不满足时返回新的 `BRIDGE_PROTOCOL_MISMATCH` 诊断，建议更新 skills 或扩展。同一进程内对 `capabilities` 结果做缓存。

### 4.3 Bridge 启动条件（修复 P2）

把“工作区装了 skills”换成一个明确的、按工作区生效的开关。这样既保留现有的按项目选择开启语义，又不再依赖 skill 文件是否存在：

- 新增 workspaceState 键 `emberprobe.agentAccess`，取值 `enabled | disabled | unset`。
- 启动条件：工作区受信任，并且满足以下任一项：`agentAccess === enabled`；工作区装了 skills（兼容现有行为，为 `unset` 时视为 `enabled`）；VS Code MCP provider 在本窗口解析了服务器定义，并且用户在 VS Code 的 MCP 信任提示中同意了。
- 侧边栏 Agent 区域：
  - 检测到全局副本或外部 MCP 配置、但当前工作区未启用时，显示“此工作区未启用 Agent 访问”和“启用”按钮。
  - 启用和停用都只写 workspaceState，不写工作区文件。
- `_syncAgentBridgeWithSkills` 重命名为 `_syncAgentBridge`，只根据上述条件决定启停。卸载 workspace skills 不再隐式关闭 MCP 通道。

---

## 5. 全局 Skills 处理（修复 P1/P3）

### 5.1 去留决策

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| A. 恢复全局安装 | `~/.agents/skills` 装完整的 skills（含脚本），扩展负责自动更新 | 一次安装，所有项目可用 | 多个宿主、多个扩展版本共享一份脚本，版本错配常态化；全局目录不受工作区信任约束；完整性检查必须覆盖任意项目里的调用 |
| **B. 保持仅工作区安装，全局只放知识层（推荐）** | 工作区装完整 skills；全局可选装“只含 SKILL.md 和 references、没有脚本”的知识包，执行全部走 MCP；遗留的全局脚本副本提示清理 | 跨项目可用的需求由用户级 MCP 配置满足；全局目录里没有可执行文件，版本错配只影响文档；与现有 workspace-only 决策一致 | 不支持 MCP 的客户端在没装 workspace skills 的项目里不可用（这与现状相同） |

采用 B。实施要点：

1. **遗留检测与清理**：`inspectSkills` 的 global 状态为 `outdated | modified | partial` 且含脚本时，侧边栏提示“检测到旧版全局 EmberProbe skills（版本 x），已不再维护”，提供“清理”按钮。清理复用现有的 `uninstallSkill(..., "global")`，它已经只删除 manifest 内的条目并做了符号链接消毒。
2. **全局知识包（可选，阶段 4）**：manifest 新增 `knowledgeOnly` 构建产物，由 `installSkill(..., "global")` 只在这一形态下放行。每个 SKILL.md 开头声明“需要 EmberProbe MCP 工具；未连接时指引用户启用 MCP 或安装工作区 skills”。知识包同样计算哈希，修改后在 MCP 通道首次调用时提示，因为被改过的文档可能含提示注入。
3. 删除无调用方的 i18n 键 `msg.skillsInstalledGlobal`，或在第 2 步里重新启用它。

### 5.2 按实际执行副本做完整性检查（P3）

- `agent-client.js` 在每次请求中附带 `X-EmberProbe-Channel: skill` 和 `X-EmberProbe-Skill-Root: <path.resolve(__dirname, "..")>`。
- `AgentBridge._receive` 把这两个头作为 `meta` 传给 handler；`AgentService.call(method, params, meta)` 再把 `meta` 传给 `onCall`。
- `SkillStatusService.checkForCall(meta)`：
  - `channel === "skill"`：用 `realpath` 对比 `skillRoot` 与已知的两个根目录（workspace、global）。命中哪个就检查哪个，不再看合并视图。不属于任何已知根时视为自定义副本，走现有的模态审批，`detail` 中给出实际路径。
  - `channel === "mcp"`：服务器代码位于扩展安装目录，不检查 skill 哈希。如果全局知识包已安装且被修改，只提示，不阻断，因为知识包不执行任何代码。
  - 没有 `meta`（旧脚本）：保持现有行为。
- 审批缓存键改为“根目录加该根目录的指纹”，避免批准过 workspace 副本后连带放行了全局副本。
- 文档写明：这两个头只用于定位和审计，不构成鉴权。同一用户下的恶意进程可以伪造它们，这与 `AGENT-TRUST-BOUNDARIES.md` 中已有的“不隔离同用户恶意进程”的边界一致。

---

## 6. MCP 服务器设计

### 6.1 形态

- 源码：`src/mcp/server.js`（协议与生命周期）、`src/mcp/tools.js`（工具表）、`src/mcp/confirm.js`（确认映射）、`src/mcp/results.js`（结果与诊断转换）。
- 打包：在 `esbuild.js` 新增 `platform: "node"`、`format: "cjs"` 的入口，输出 `dist/mcp-server.js`，打包时内联 `skills/_emberprobe/bridge-locator.js` 和 `agent-client.js` 中的诊断表。
- 传输：stdio。不用 HTTP 的原因：Bridge 端口和 token 每次启动都会变化，HTTP 方案要么把 token 写进客户端配置文件（违背“token 只放 globalStorage”的设计），要么每次重启都得更新配置。stdio 代理在每次调用时通过定位模块读取当前描述，Bridge 重启也不受影响。

### 6.2 注册与启动

**VS Code（及兼容宿主）**

- `package.json` 新增 `contributes.mcpServerDefinitionProviders: [{ id: "emberprobe", label: "EmberProbe" }]`。
- 激活时做特性检测：仅当 `vscode.lm?.registerMcpServerDefinitionProvider` 存在时才注册，`engines.vscode` 保持 `^1.85.0`。实施时需要验证旧版本 VS Code 对未知 contribution point 的处理（预期是忽略，最多给出警告），并在 e2e 中覆盖。
- provider 只为 4.3 判定为可启用的窗口返回 `McpStdioServerDefinition`：
  - `command: process.execPath`
  - `args: [<extensionPath>/dist/mcp-server.js]`
  - `env: { ELECTRON_RUN_AS_NODE: "1", EMBERPROBE_BRIDGE_INSTANCE: <instanceId> }`
  - `version: <extensionVersion>`
- Bridge 重启（instanceId 变化）后触发 `onDidChangeMcpServerDefinitions`。

**外部客户端（Claude Code、Codex、Cursor 等）**

- 激活时在 `<globalStorage>/mcp/emberprobe-mcp.js` 写一个稳定路径的启动器，内容只有一行 `require(<当前 extensionPath>/dist/mcp-server.js)`。扩展升级后安装路径会变，启动器每次激活都会重写，所以客户端配置不需要跟着改。
- 新增命令“复制 MCP 配置”，按客户端生成配置片段，供用户自己粘贴；扩展不代写任何客户端的配置文件：
  - Claude Code：`claude mcp add --scope user emberprobe -- node <launcher>`
  - Codex：`config.toml` 中的 `[mcp_servers.emberprobe]`
  - Cursor 和其他客户端：通用的 `mcpServers` JSON
- 外部客户端需要 PATH 中有 Node.js（≥ 18）；没有时，命令给出提示和检测结果。
- 工作区绑定：初始化时，如果客户端声明了 `roots` 能力，就用 `roots/list` 的结果；收到 `notifications/roots/list_changed` 时重新定位。客户端没有 roots 时用 `cwd`。

### 6.3 工具目录

命名规则为 `snake_case`，与 Bridge 方法一一对应或做少量合并。注解列中：R 表示 `readOnlyHint: true`；D 表示 `destructiveHint: true`；C 表示返回确认，走 6.4 的流程；H 表示会占用 probe 或访问硬件。

| 工具 | Bridge 方法 | 注解 | 工具集 |
|---|---|---|---|
| `config_get` | `config.get` | R | core |
| `config_set` | `config.set` | — | core |
| `probe_list` | `probe.list` | R | core |
| `chip_read` | `chip.read` | R H | core |
| `fault_read` | `fault.read` | R H | core |
| `elf_analyze` | `elf.analyze` | R | core |
| `flash_program` | `flash.authorize` → `flash.execute` | D C H | core |
| `flash_verify` | `flash.authorize` → `flash.verify` | C H | core |
| `permission_get` / `permission_reset` | `flash.permission` / `variables.write.permission` / `cubemx.permission`（`action: status \| reset`；后两者的参数实施时逐一对照） | R / — | core |
| `variables_read` / `variables_sample` | 同名方法 | R H | core |
| `variables_write` | `variables.write` | D C H | core |
| `variables_export_csv` | `variables.exportCsv` | — | core |
| `watch_add` | `watch.add` | — | core |
| `sampling_status` | `sampling.status` | R | core |
| `sampling_control` | `sampling.start` / `sampling.stop`（`action` 枚举） | H | core |
| `peripherals_list` / `peripherals_read` | 同名方法 | R / R H | core |
| `peripherals_write` | `peripherals.write` | D C H | core |
| `debug_status` / `debug_inspect` / `debug_breakpoints_list` | 同名方法 | R | debug |
| `debug_start` / `debug_select` / `debug_control` / `debug_breakpoints_update` | 同名方法 | H（`control` 含 stop、reset 时为 D） | debug |
| `rtos_status` / `rtos_snapshot` | 同名方法 | R | debug |
| `cubemx_detect` / `cubemx_inspect` / `cubemx_status` | 同名方法 | R | cubemx |
| `cubemx_prepare` / `cubemx_candidate` / `cubemx_start` / `cubemx_check` / `cubemx_cancel` | 同名方法 | — | cubemx |
| `cubemx_execute` | `cubemx.execute` | D C | cubemx |

- **工具集**：环境变量 `EMBERPROBE_MCP_TOOLSETS` 控制暴露哪些工具，默认 `core,debug`，`cubemx` 需要显式开启，用来控制工具定义常驻上下文的体积。在 VS Code 中由扩展设置项注入这个变量。
- **schema**：在 `src/mcp/tools.js` 中手写 JSON Schema，与 `src/validation.js` 的规则保持一致。`additionalProperties: false`；`transport` 等参数用枚举；`probeSerial` 保持字符串，原样传递，不做大小写或前导零处理。最终校验仍由 Bridge 完成，schema 只负责提前拦截。
- **漂移测试**：每个工具都必须对应 `createAgentRoutes` 中存在的方法；每个路由方法要么被映射，要么出现在显式排除清单里。思路同 `ci-test-topology.test.js`。
- **只读判定的单一来源**：R 注解从 `agent-client.js` 的 `READ_ONLY_METHODS` 派生，同一个集合也驱动 `BRIDGE_TIMEOUT` 的重试策略，避免两处定义不一致。

### 6.4 确认流程映射

MCP 服务器统一识别 Bridge 结果中的 `confirmationRequired: true`：

```
tool call (无 confirmationId)
  └─ Bridge 返回 { confirmationRequired, confirmationId, question, choices, plan… }
       ├─ 客户端声明了 elicitation 能力
       │    └─ elicitation/create:
       │         message = question + 计划摘要（ELF 路径/SHA-256、target、probe+serial、transport、速度 / 写入项地址与值 / CubeMX 项目）
       │         schema  = { decision: enum(choices ∪ ["deny"]) }    // 只提供 Bridge 给出的 choices
       │       accept + once      → 以 confirmationId 重调
       │       accept + workspace → 以 confirmationId + remember:true 重调
       │       deny / decline / cancel → isError, code CONFIRMATION_DENIED，操作结束
       │       期间 ID 过期        → isError，透传 *_CONFIRMATION_INVALID，不自动重新申请
       │    （confirmationId 不出现在返回给 agent 的内容里）
       └─ 客户端不支持 elicitation
            └─ 返回计划和 confirmationId（与现在 skill 流程一致）；
               工具描述要求 agent 把计划展示给用户并等待回答，再带 confirmationId（和用户明确选择的 remember）重调
```

- `flash_program` 和 `flash_verify` 先调用 `flash.authorize`。preflight 的 `ready === false` 时直接返回 `diagnostics` 和 `notes`，不进入确认；已有 24 小时授权（`authorized: true, mode: "workspace"`）时直接执行，并在结果中报告 `trustedExpiresAt`。
- MCP 服务器不会因为用户的初始请求就选择 `remember`，也不会自动接受确认。elicitation 表单的默认值是 `deny`。
- `docs/AGENT-TRUST-BOUNDARIES.md` 需要补充一段：elicitation 由客户端渲染，比聊天文本更接近人的操作证据，但 Bridge 仍然不对此做认证（客户端可以被配置为自动应答），所以确认 ID 的计划绑定和一次性校验保持不变。

### 6.5 长任务、超时与取消

- Bridge 目前是请求/响应模式，不推送进度。MCP 服务器等待期间，每 5 秒发送一次只含已耗时的 `notifications/progress`（仅当请求带有 `progressToken` 时），避免客户端把长时间无响应判为超时。真正的阶段性进度要等 Bridge 支持流式输出后再做，不在本期范围。
- 各方法的超时预算复用 `agent-client.js` 现有的表，抽到共享模块中。超时的处理与 `BRIDGE_TIMEOUT` 相同：状态变更类调用的结果视为未知，返回对应的状态查询建议（`STATUS_QUERY_FOR`），不自动重发。
- 收到 MCP 的 `notifications/cancelled` 时：
  - 有对应取消方法的（`cubemx.cancel`、`sampling.stop`），转发取消。
  - flash 和写操作不中断，结果按未知处理，提示先用查询方法核对状态。这与现有“超时不自动重复写入”的规则一致。

### 6.6 结果与诊断

- 成功：`structuredContent` 放 Bridge 的原始结果；`content` 放一段精简文本，用于不读结构化内容的客户端。
- 失败：`isError: true`，`structuredContent.error` 的形状与 skill 的 stderr `diagnostic` 完全一致，由同一个 `diagnosticForError` 生成。
- 让建议与通道无关（P6）：诊断表新增机器可读字段 `actions: [{ method: "debug.start" }, …]`，`suggestedActions` 的文本里不再出现 CLI 参数。skill 脚本把 `actions` 渲染成 `mcu-debug-control --start`，MCP 渲染成 `debug_start`。i18n 文本迁到 `src/i18n/` 或保留在共享表中，实施时按现有组织方式决定。

### 6.7 通道标识与审计

- MCP 服务器发出的请求附带 `X-EmberProbe-Channel: mcp`、`X-EmberProbe-Client: <clientInfo.name>/<version>`（来自 MCP 初始化）。
- Bridge 在输出面板的调用日志中记录 channel、client、method、结果码，不记录参数值，方便定位“是谁执行了这次写入”。

### 6.8 Server instructions 与 prompts

- 初始化时返回的 `instructions` 控制在 1.5 KB 以内，只写跨工具的硬规则：不猜测 probe 或 target；确认必须来自用户；超时或结果未知时先查询状态；不绕过 Bridge 直接调用 OpenOCD；同一时间 probe 只有一个所有者。
- `prompts`：`flash`、`fault_triage`、`variable_debug`、`rtos_inspect`、`cubemx_generate`。内容在构建时从对应的 `SKILL.md` 和 `agent-workflow.md` 段落生成，唯一来源仍是 `skills/`，并用漂移测试保证一致。

---

## 7. Skills 调整

1. `agent-client.js`：改用 `bridge-locator.js`；新增协议协商；发送 channel 和 skill-root 头；保留 `descriptor()` 导出作为兼容入口。
2. 各 `SKILL.md` 的“Before you run”增加一行：“如果当前会话提供了 EmberProbe MCP 工具（`flash_program` 等），优先使用；脚本是回退方式”。授权、硬件约束等原有段落不变。
3. 诊断文本去掉 CLI 形式（见 6.6），脚本侧的渲染保持原输出不变，现有测试应继续通过。
4. `skills/manifest.json` 的 `shared` 清单加入 `bridge-locator.js`，它会被 drift 测试自动覆盖。

---

## 8. 安全与信任边界变化汇总

| 方面 | 变化 | 结论 |
|---|---|---|
| token 存放 | 注册表与旧描述文件同在 globalStorage，`0o600` | 与现状等价；客户端配置文件中没有 token |
| Bridge 暴露面 | 启动条件从“装了 skills”改为“工作区受信任 + 按工作区显式启用（或已装 skills）” | 仍然按项目选择开启，不会在所有受信任工作区自动开放 |
| 完整性检查 | 从检查合并视图改为检查实际发起调用的根目录 | 修复 P3；请求头不构成鉴权，边界不变 |
| 确认 | elicitation 为可选增强，聊天确认为回退 | ID 绑定、一次性、`remember` 规则不变 |
| 新进程 | MCP 服务器以用户身份运行，只连 127.0.0.1 | 不新增网络监听 |
| 需要更新的文档 | `AGENT-TRUST-BOUNDARIES.md`、新增 `docs/MCP.md` | — |

---

## 9. 分阶段实施

每个阶段都可以独立合入；阶段 1 不依赖 MCP，可以先修复现有问题。

**阶段 1：发现与完整性修复（P2–P6）**

1. 先写失败用例：
   - 新建 `test/bridge-locator.test.js`：注册表匹配、最长前缀、win32 大小写、歧义、陈旧条目、向上查找指针、协议错配。
   - 扩展 `test/agent-lifecycle.test.js`：两个实例共享同一文件夹时的启停顺序（P5）。
   - 扩展 `test/skill-status-service.test.js`：workspace 干净、global 已修改时，按 skill-root 发起的调用必须触发审批（P3）。
   - 扩展 `test/bridge-security.test.js`：meta 头不影响鉴权。
2. 实现 `bridge-locator.js`、注册表的写入与清理、`agentAccess` 开关、`_syncAgentBridge`、meta 透传、`checkForCall(meta)`。
3. 侧边栏增加“未启用”和“遗留全局副本”提示，补齐 i18n 中英文。
4. 在 `scripts/test-groups.js` 注册新测试，更新 `AGENT-TRUST-BOUNDARIES.md`。

**阶段 2：MCP 服务器核心**

1. 确定 SDK 选型（第 10 节）。如引入依赖，同步更新 `THIRD_PARTY_NOTICES.md`。
2. 实现 `src/mcp/*` 和 esbuild 入口。
3. 新增测试：
   - `test/mcp-tools.test.js`：工具与路由漂移、只读集合一致性、schema 拒绝多余字段。
   - `test/mcp-server.test.js`：进程内连接假 Bridge；覆盖确认的接受、拒绝、过期以及不支持 elicitation 的回退；`confirmationId` 不泄露给 agent；超时按未知处理；取消转发；roots 变化后重新定位。
   - 两个文件都注册到 `scripts/test-groups.js`。

**阶段 3：注册与用户体验**

1. 实现 VS Code provider（带特性检测）、稳定启动器、“复制 MCP 配置”命令、工具集设置项。
2. e2e：provider 在支持的 VS Code 版本上完成注册，在不支持的版本上安静跳过。
3. 新增 `docs/MCP.md`，在 `CHANGELOG.md` 的 Unreleased 段落写中英双语说明。

**阶段 4：Skills 瘦身与知识层**

1. 修改 SKILL.md 的指引；诊断改为 `actions` 字段；从 skills 生成 MCP prompts。
2. 可选：全局知识包的构建与安装（5.1 B-2）。

**每个阶段的验证**：`npm run check`、`npm run quality`、`npm run bundle`、`npm run test:e2e`。不运行 HIL。以下属于人工验证，在 PR 中单独记录：Claude Code、Codex、VS Code Copilot、Cursor 各连一次假 Bridge 或真实工作区，确认工具列表、权限提示和 elicitation 的实际表现。

---

## 10. 待决问题

1. **MCP 实现方式**：
   - 用官方 `@modelcontextprotocol/sdk`（锁定版本、esbuild 打包、需要评估体积和许可证）。
   - 或手写最小的 JSON-RPC stdio 实现（无依赖，但要自己跟进协议版本）。
   - 倾向用 SDK，elicitation、roots、progress 等能力都有现成实现。
2. **elicitation 的客户端支持情况**：各目标客户端的实际支持程度需要在阶段 2 实测并记录到 `docs/MCP.md`，不预设。
3. **默认工具集**：`core,debug` 是否合适，`cubemx` 是否默认开启。
4. **`agentAccess` 的默认值**：已装 skills 的工作区是否自动视为 `enabled`（本方案为保持兼容选择“是”）。
5. **全局知识包**（5.1 B-2）是否值得做，还是只做遗留副本清理。

## 11. 风险

- **工具定义占用上下文**：通过工具集开关和合并相近工具来控制；在实测中记录 token 体积。
- **VS Code MCP API 的版本差异**：依赖特性检测和 e2e 覆盖；API 不可用时退回外部配置方式。
- **双通道并存期的行为差异**：用同一个诊断表、同一个定位模块和漂移测试约束两边一致。
- **用户误以为 MCP 绕过了确认**：在文档和工具描述中明确写出，确认在 Bridge 端强制执行，与通道无关。
