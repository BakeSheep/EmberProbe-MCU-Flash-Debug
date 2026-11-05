# MCP Server

[中文](mcp.md)

EmberProbe ships an MCP server so MCP-capable Agent clients can call its flashing, variable, debug, peripheral and CubeMX tools directly.

Every client needs a running EmberProbe window with [Agent access turned on](permissions.en.md#turning-on-agent-access) for that workspace.

## Installing

GitHub Copilot in VS Code and Cursor get the server from the extension automatically, with no install step.

For other clients, use the **MCP servers** area under Agent Configuration in the sidebar:

| Status | Meaning | Actions |
| --- | --- | --- |
| Not installed | No EmberProbe entry | Install |
| Installed | The entry is up to date | Remove |
| Upgrade available | Launch path or timeout is outdated | Upgrade, Remove |
| Unreadable | The file is corrupted or too large | Copy configuration |
| Manual | Configuration path unknown | Copy configuration |
| Default | VS Code provides it directly | None |

Refresh or restart the client afterwards. Installing writes only user-level configuration, keeps other servers and settings, and serves all projects, so switching projects needs no reinstall. Hover over a status to see the target file.

With several editors, the launch path belongs to whichever installed it last, so another editor showing an upgrade is normal and needs no action.

## Supported clients

| Client | Configuration |
| --- | --- |
| Claude Code | `~/.claude.json`, honoring `CLAUDE_CONFIG_DIR` |
| Codex | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| OpenCode | `opencode.jsonc` or `opencode.json`, honoring `OPENCODE_CONFIG` and `XDG_CONFIG_HOME` |
| Cursor | Automatic registration or an install link |
| Antigravity | `~/.gemini/config/mcp_config.json` |
| DeepSeek Harness (DSH) | `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, default `~/.dsh` |
| Other clients | Copy the generic JSON and merge it yourself |

You can also run the command `EmberProbe: 安装 MCP 服务器到客户端` to preview the configuration in a dialog, use the client's CLI, or copy the configuration.

Client specifics:

- **Antigravity**: refresh MCP servers in the client. Check the result under **MCP Servers → Manage MCP Servers → View raw config**.
- **DSH**: restart the profile, for example `dsh web`. If automatic writing fails, save the copied text as `emberprobe.cordis.yml` and run `dsh web --patch "/absolute/path/emberprobe.cordis.yml"`. This is a YAML patch and cannot go in `mcpServers` JSON. DSH does not support MCP prompts; use the tools directly.

## Choosing the project

EmberProbe finds the project from the root folder or working directory your Agent client reports, so start the client from the project folder. Several projects can be used at once without interfering.

Configuration in a remote window (Remote-SSH, WSL) only works for clients running on that same remote.

## Tools

MCP always offers every tool and workflow prompt, grouped by function:

| Category | Tools |
| --- | --- |
| Core | Configuration, probes, chip info, fault reads, ELF analysis, flashing and verification, permissions, variable access and sampling, peripherals |
| Debug | Debug start and control, breakpoints, stack and variable inspection, RTOS |
| CubeMX | Detect, inspect, prepare, generate, cancel |

There are also five workflow prompts: `flash`, `fault_triage`, `variable_debug`, `rtos_inspect` and `cubemx_generate`.

Flashing, writes and CubeMX generation need confirmation. Clients that support it show a form that defaults to deny; others confirm in the conversation. See [Agent permissions](permissions.en.md).

## Limits

- stdio only; there is no HTTP transport.
- The 30-minute timeout in the configuration covers long calls such as human confirmation, flashing and CubeMX. It does not change EmberProbe's own operation budgets.
- Cancelling doesn't interrupt flashing or writes. Their result is unknown, so check status first.
- Installing the configuration neither enables Agent access nor grants hardware permissions.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `BRIDGE_UNAVAILABLE`, workspace not enabled | Enable Agent access in the sidebar |
| `BRIDGE_UNAVAILABLE`, no window found | Check that an EmberProbe window is running, start the client from the project folder, or set `EMBERPROBE_WORKSPACE` in the client's launch environment |
| `BRIDGE_AMBIGUOUS` | Two windows have the same folder open. Close one, or set `EMBERPROBE_BRIDGE_INSTANCE` |
| Client cannot start the server | Open an EmberProbe window once; if the editor moved, upgrade from the sidebar |
| CLI install fails on an existing server | Edit the existing `emberprobe` entry; do not overwrite the whole file |
| Long operations time out | Check the client timeout: `tool_timeout_sec` (seconds) in Codex, `timeout` (milliseconds) in Gemini and OpenCode |
| Server not visible in Cursor | Check that the workspace is trusted and Agent access is enabled |
| DSH shows no `mcp__emberprobe__*` tools | Check that the profile loads the patch, and read the startup log |

## Related documents

- [MCP server design (Chinese)](../../design/mcp-server.md)
- [Agent permissions](permissions.en.md)
