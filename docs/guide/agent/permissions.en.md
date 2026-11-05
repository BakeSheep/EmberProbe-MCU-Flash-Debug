# Agent Permissions

[中文](permissions.md)

Agents can read chip information, variables and peripherals without confirming each time. Flashing, writes and code generation are confirmed by you in the Agent conversation by default; VS Code shows no second dialog.

## Turning on Agent access

Agent access is per workspace, and the workspace must be trusted. Click **Enable** under Agent Configuration in the sidebar, or run the command `EmberProbe: 为此工作区启用 Agent 访问`. Once disabled, Agents cannot connect to this workspace, whatever else is set.

A workspace with skills installed and no explicit choice counts as enabled.

## What needs confirmation

| Operation | How | Can be remembered for 24 hours |
| --- | --- | --- |
| Program firmware | In the conversation | Yes |
| Write variables | In the conversation | Yes |
| CubeMX generation | In the conversation | Yes |
| Flash verification | In the conversation | No |
| Write peripheral registers | In the conversation | No |

The Agent shows a specific plan, such as the firmware path and hash, the probe, and the names and new values. It runs only after you answer.

**A choice is remembered for 24 hours only if you explicitly ask for that when confirming.** Asking the Agent to flash is not agreeing to remember.

What remembering covers:

- **Flashing**: the same ELF path, target, probe, transport, speed and OpenOCD. Rebuilding the same path needs no new confirmation, and results still report the hash actually written.
- **Variable writes**: the same ELF contents and connection. It does not apply while the ELF differs from the target firmware.
- **CubeMX**: the same project and tool.

Probes without a reliable serial always ask.

To clear remembered permissions, have the Agent call `permission_reset`.

## Allow all Agent operations

With **Allow all Agent operations** on, under Agent Configuration in the sidebar, flashing, Flash verification, writes and CubeMX generation no longer ask each time. It is off by default. See [Agent controls](agent-controls.en.md).

- Only the sidebar can turn it on. An Agent cannot do this itself.
- It applies to the current workspace only.
- Turning it off affects later operations and does not cancel one already running.
- Probe, target and file checks stay in place. Probes without a reliable serial still ask.

## Firmware consistency

When an Agent reads, samples or writes, results report whether target firmware matches the configured ELF: `match`, `mismatch` or `unknown`. Programming by other tools is not observed, so `unknown` and older records are only evidence.

## Modified skills

If installed skills change, you must approve the current content again. The MCP server ships with the extension and skips this.

## What this protects against

Confirmation ensures the Agent runs the plan it showed, and any change to the plan voids the confirmation. It has limits:

- EmberProbe cannot prove that an answer came from a person. An Agent or client can be set to answer automatically.
- Programs under the same OS account are not isolated. This is not a sandbox.

## Related documents

- [Agent trust boundaries](../../design/agent-trust-boundaries.md)
- [MCP server](mcp.en.md)
