# Agent Controls

[中文](agent-controls.md)

The **Agent Configuration** card in the sidebar gathers Agent-related switches. It sits beside MCU Configuration, and each remembers its collapsed state.

## What's in the card

- **Agent Skills**: installs skills into the workspace.
- **MCP servers**: install, upgrade or remove per client. See [MCP server](mcp.en.md).
- **Allow all Agent operations**: skips operation confirmation.

## Allow all Agent operations

Off by default and saved only for the current workspace. Turning it on also enables Agent access. Turning it off restores per-operation confirmation; the Agent connection and existing permissions stay, and running operations are not cancelled.

It needs a trusted workspace. An Agent cannot turn it on by itself.

With it on, these no longer ask each time:

- Flashing and Flash verification
- Writing variables and peripheral registers
- CubeMX and CubeMX2 generation

These checks remain:

- Probe ownership, target and connection identity, file paths and debug session state.
- Peripheral side-effect restrictions and read-back after writes.
- Probes without a reliable serial still ask for flashing and variable writes.
- Variable writes still ask when the ELF differs from the programmed firmware.
- MCP clients' own tool approval and approval of modified skills are separate.

## Related documents

- [Agent permissions](permissions.en.md)
- [Agent trust boundaries](../../design/agent-trust-boundaries.md)
