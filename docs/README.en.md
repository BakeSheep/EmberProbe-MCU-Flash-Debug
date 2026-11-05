# EmberProbe Documentation

[中文](README.md)

## I want to...

### Get started

- [Install the debug toolchain](guide/getting-started/toolchain.en.md)
- [Connect and choose a probe](guide/getting-started/probe-connections.en.md)
- [Use a J-Link](guide/getting-started/jlink.en.md)
- [Configure OpenOCD targets](guide/getting-started/openocd-targets.en.md)

### Flash and debug

- [Flash firmware and tune download speed](guide/flash-debug/flash.en.md)
- [Enter GDB commands in the debug console](guide/flash-debug/gdb-console.en.md)
- [Inspect RTOS tasks and stacks](guide/flash-debug/rtos.en.md)
- [Debug multicore chips](guide/flash-debug/multicore.en.md)
- [Attach to an external GDB server](guide/flash-debug/external-gdb-server.en.md)

### Watch variables and waveforms

- [Sample variables live](guide/variables/sampling.en.md)
- [Use waveform panels](guide/variables/waveform.en.md)
- [Set a waveform background icon](guide/variables/chart-background.en.md)
- [Read pointers and C++ objects](guide/variables/pointers.en.md)
- [Read enum variables](guide/variables/enums.en.md)
- [Tell same-named variables apart](guide/variables/variable-names.en.md)
- [Show only your own variables](guide/variables/origin-filter.en.md)

### Read and write peripheral registers

- [Peripheral registers](guide/peripherals.en.md)

### Work with Agents

- [Turn on Agent access and learn the confirmation rules](guide/agent/permissions.en.md)
- [Use the Agent Configuration card](guide/agent/agent-controls.en.md)
- [Connect MCP clients](guide/agent/mcp.en.md)
- [Generate CubeMX code](guide/agent/cubemx.en.md)

### Adjust the UI and settings

- [See all settings](guide/settings.en.md)
- [Zoom the UI](guide/webview-zoom.en.md)

## Developing EmberProbe

Project conventions are in `AGENTS.md` at the repository root. See also the [release guide](development/releasing.md).

Design notes in `design/` explain why things work the way they do, and are listed in the [Chinese index](README.md#设计说明). Many are in Chinese only. `records/` holds dated audits, plans, diagnostics and board validation; these are frozen and do not describe current behavior.
