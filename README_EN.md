# EmberProbe

EmberProbe is a VS Code extension for Cortex-M development. Built on OpenOCD, it provides firmware flashing, automatic target detection, and live variable watching.

For J-Link, see [connection configuration and compatibility](docs/JLINK-COMPATIBILITY.md): serial selection, SWD/JTAG, speed, Ozone contention and USB driver diagnostics.

> [中文文档](README.md)

## Features

- Automatically detects the newest ELF file and MCU target in the workspace.
- Chip info readout: non-intrusively reads the chip core, Device ID, Flash size, UID, debug link, and run state via OpenOCD.
- ELF flashing: flash the ELF file and run it in one click.
- Live variable watch: non-intrusively reads Cortex-M RAM while the target runs; the sidebar offers a standalone value list, and multiple chart panels can keep independent watch lists and history buffers.
- Live variable write: changes memory in real time while the target runs, offering slider, input box, and mouse wheel for value changes, with automatic read-back after each change.
- Built-in debugging: breakpoints, stepping, stack frames, variables, and memory access without Cortex-Debug.
- Optionally installs nine Agent Skills covering firmware programming and verification, live variable reads and writes, SVD peripheral debugging, debug session/breakpoint control, chip and fault inspection, ELF analysis, and configuration synchronization.

## Requirements

- Visual Studio Code 1.85 or later
- OpenOCD
- ARM GDB toolchain (required for debugging); existing Cortex-Debug configurations remain supported

## Live Variable Watch

The sidebar lists all global/static variables of the current ELF; click a variable to add it to a standalone value list.

- Type support: scalars prefer DWARF type info and support `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`; structs, unions, and arrays can be expanded to select scalar leaves.
- 64-bit precision: `u64/i64` charts use approximate Number values outside ±2^53; the sidebar, CSV, and Agent results prefer the exact decimal `valueText`.
- CSV export: sampling automatically writes the complete history to a temporary archive, with no separate recording step. Export selected variables and time ranges at any time; internal data is deleted when the extension exits.
- Live writes: the sidebar can add scalars with reliable DWARF types in ELF writable sections to a write list; writes are enabled only while sampling is active and are verified by reading the value back after each write.

- Curve identity: colors and line styles are saved by full variable name in the workspace and shared across chart panels. Clicking a swatch only hides/shows the curve, including struct members, while retaining sampling and history. Right-click a variable card to change its data type or style, show only one variable, or remove its watch; “Restore visibility” restores the previous selection.
- Inspection: hover shows only a color bar and actual value. Clicking a curve uses the same snapshot freeze as the top toolbar; moving the pointer still inspects other positions and curves while frozen.
- Visibility and axes: Show all / Hide all live under Current values; Auto Y lives in the top toolbar. Full-height color strips toggle visibility and turn gray when hidden; × on the right removes a watch.
- Freeze: sampling and current values continue updating. Resume live releases the snapshot and follows new data. New variables appear after resuming; clearing history clears the snapshot.
- CSV sources: keep using the full sampling archive, or select live retained samples or the frozen snapshot (the default when frozen). Snapshots and live buffers respect the per-variable sample limit. Readings do not bridge data gaps; 64-bit integer readouts preserve exact decimal text.

- Sampling isolation: OpenOCD transport and the sampling clock run in a worker thread so extension-host stalls from builds or synchronous ELF parsing do not stop acquisition. Hz uses acquisition timestamps. Target resets, debugger pauses, probe contention and resource exhaustion can still affect reads.

## Agent Skills

- `mcu-flash`: detects and programs the newest ELF or independently verifies on-chip Flash, reporting the ELF SHA-256 during preflight and execution.
- `mcu-variables`: reads live values, analyzes trends, exports chart history CSV, or safely writes scalar and composite-leaf variables through two-stage confirmation.
- `mcu-chip-info`: reads chip info by the `identity`, `debug`, and `runtime` groups, or by specific fields.
- `mcu-config`: reads or changes ELF, debugger, MCU, SVD, OpenOCD, and sampling parameters.
- `mcu-cubemx`: updates an existing `.ioc` on Windows/Linux and regenerates initialization code through CubeMX CLI after two-stage authorization, with baseline checks, user-code preservation, and recovery copies. It supports asynchronous generation (`--start`, then `--status`, cancel via `--cancel --operation-id`), workspace JSON change files (`--changes-file`) with explicit key deletions (`--deletions`), and consistency checks (`--check` quick mode, `--check --deep` isolated regeneration).
- `mcu-fault-analyzer`: reads and decodes Cortex-M fault registers and symbolizes PC/LR with the current ELF.
- `mcu-elf-analyze`: analyzes Flash/RAM usage, section layout, and large symbols offline without occupying the debug probe.
- `mcu-peripheral-debug`: parses the workspace SVD, reads and decodes paused peripheral registers/fields, and performs safe writes after a fresh one-time confirmation for every request.
- `mcu-debug-control`: starts, stops, and controls debug sessions, including pause/continue/stepping/restart plus source-line and function breakpoints.

On Linux, select `STM32CubeMX` (without an extension) in the standalone installation and keep its bundled `jre/bin/java`. Discovery checks CubeMX updater records, PATH, and common installation directories. The installed version must match the `.ioc`; interactive firmware installation requires a graphical desktop. If debug tools are missing, EmberProbe refreshes PATH from the user’s login/interactive shell, with a timeout and manual directory selection as fallback.

## Development & Build

```sh
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

Run `npm run release:prepare -- <version> --date YYYY-MM-DD` when preparing a new version; the script synchronizes version metadata, the README, and the Changelog. Pushing the matching `vX.Y.Z` tag automatically creates a GitHub Release and uploads the VSIX; see [docs/RELEASING.md](docs/RELEASING.md) for publishing and retry instructions. See [test/hil/README.md](test/hil/README.md) for hardware-runner setup. The current extension version is `0.7.9`.

## Project Structure

```text
src/       Extension implementation
resources/ Windows x64 OpenOCD bundle and its bundled licenses
media/     Marketplace and Activity Bar icons
skills/    Bundled Agent Skills
test/      Unit tests and OpenOCD Tcl-RPC integration tests
esbuild.js Single-file VSIX bundle build config
```

## License & Attribution

The extension code is licensed under MIT. License and source information for the npm runtime dependencies and the bundled xPack OpenOCD is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Built-in debugging

The sidebar and F5 use the independent `emberprobe` debugger. Select a workspace ELF, probe, and target first. Launch downloads the ELF and runs to main; an unresolved entry leaves the target halted. Attach halts without downloading or resetting. Restart resets and runs to the entry without downloading again.

Configure tools through `emberprobe.gdbPath`, `emberprobe.armToolchainPath`, `emberprobe.armToolchainPrefix`, and `emberprobe.objdumpPath`. Legacy Cortex-Debug settings and cached directories remain compatible; the extension itself is not required.

Example launch.json configuration (use request attach for attachment):

```json
{
  "type": "emberprobe",
  "request": "launch",
  "name": "EmberProbe",
  "executable": "${workspaceFolder}/build/firmware.elf",
  "runToEntryPoint": "main"
}
```

Set `runToEntryPoint` to an empty string to stay halted; `sourceFileMap` maps build-time source prefixes to local paths. Source, function, and conditional breakpoints are supported. Hit counts, logpoints, data breakpoints, RTOS, SWO/RTT, and disassembly views are not included. Existing Cortex-Debug launch.json entries are unchanged.
