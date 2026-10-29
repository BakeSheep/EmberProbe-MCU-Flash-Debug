# EmberProbe

EmberProbe is a VS Code extension for Cortex-M development. Built on OpenOCD, it provides firmware flashing, built-in debugging, live variables, and Agent-assisted development.

> [中文文档](README.md)

![Live watch chart panel with sampled waveforms, current values, and the write list](docs/images/live-watch-waveform.png)

## Features

- Automatically detects the newest ELF file and MCU target in the workspace.
- Chip info readout: non-intrusively reads the chip core, Device ID, Flash size, UID, debug link, and run state via OpenOCD.
- ELF flashing: flash the ELF file and run it in one click.
- Live variable watch: non-intrusively reads Cortex-M RAM while the target runs; the sidebar offers a standalone value list, and multiple chart panels can keep independent watch lists and history buffers.
- Live variable write: adjusts writable variables with sliders, inputs, and step buttons, with automatic read-back verification. Aligned 32-bit writes can keep the target running; other widths or unaligned writes need a brief halt. Pause first for these writes during debugging.
- Built-in debugging: breakpoints, stepping, stack frames, locals/globals/file statics/registers, expression assignment and memory access.
- [Experimental external GDB server attach](docs/EXTERNAL-GDB-SERVER.md): opt in through native VS Code settings and an explicit F5 configuration; existing debug entry points keep using OpenOCD.
- Optionally installs Agent Skills covering firmware programming and verification, live variable reads and writes, SVD peripheral debugging, debug session/breakpoint control, chip and fault inspection, ELF analysis, and configuration synchronization.

## Requirements

- Visual Studio Code 1.85 or later
- OpenOCD 0.12.0 or later
- ARM GDB toolchain (required for debugging)

Windows x64 offers bundled offline installation from the sidebar. Linux x64 automatically prepares bundled OpenOCD when using the default path; explicit paths are preserved. Other platforms can select an existing installation. Build with a Debug preset to retain variable and source debugging information.

## Live Variable Watch

The sidebar lists global/static variables of the selected ELF. Search by variable or member name, use + to watch and the pencil button to add a write card, then start sampling. Use an ELF matching the target firmware; refresh the list after rebuilding.

- Type support: structs, unions, arrays, C++ classes, and common STL containers can be expanded. Data pointers support read-only expansion on demand; collapsing stops those reads. Same-named statics from different source files remain separate and accept qualified names such as `main.c::g_cfg`.
- 64-bit precision: `u64/i64` charts use approximate Number values outside ±2^53; the sidebar, CSV, and Agent results prefer the exact decimal `valueText`.
- CSV export: sampling automatically writes the complete history to a temporary archive, with no separate recording step. Export selected variables and time ranges at any time; internal data is deleted when the extension exits.
- Live writes: the sidebar can add scalars with reliable DWARF types in ELF writable sections to a write list; writes are enabled only while sampling is active and are verified by reading the value back after each write.

- Curve identity: colors and line styles are saved by full variable name in the workspace and shared across chart panels. Clicking a swatch only hides/shows the curve, including struct members, while retaining sampling and history. Right-click a variable card for display, style, and watch options.
- Inspection: hover shows only a color bar and actual value. Clicking a curve uses the same snapshot freeze as the top toolbar; moving the pointer still inspects other positions and curves while frozen.
- Visibility and axes: Show all / Hide all live under Current values; Auto Y lives in the top toolbar. Click a variable's color/name area to toggle visibility; × removes its watch.
- Freeze: sampling and current values continue updating. Resume live releases the snapshot and follows new data. New variables appear after resuming; clearing history clears the snapshot.
- CSV export always uses original archived samples, defaulting to the selected variables since sampling began or history was last cleared. Freezing does not change the export range. Clear History affects the current panel and debug session; other panels are unaffected. Archives are deleted when the extension exits, so export data you want to keep.
- Layered sampling: every waveform watch, including hidden curves, follows the waveform target and is archived. Sidebar-only watches and write cards target a fixed 20 Hz without history. Global pause stops both consumers; probe throughput determines the actual rates.
- Background history keeps up to 30 minutes, subject to point and memory limits. Memory pressure can shorten retention or leave gaps while disk archiving continues. A full archive or disk-write failure pauses sampling. Set `emberprobe.chartHistoryMaxMiB` and `emberprobe.samplingArchiveMaxMiB` to adjust capacities; see [live sampling](docs/LAYERED-SAMPLING.md).

- Chart navigation: wheel to zoom, left-drag to pan both axes, middle-drag to pan time only, and click a curve to freeze. Use Auto Y to restore automatic vertical scaling.
- Sampling frequency: enter 0.1–200 Hz or choose a preset. Experimental [max-rate sampling](docs/UNLIMITED-SAMPLING.md) adds a Max rate preset for standalone sampling only.

## Agent Skills

- `mcu-flash`: detects and programs the newest ELF or independently verifies on-chip Flash, reporting the ELF SHA-256 during preflight and execution.
- `mcu-variables`: reads live values, analyzes trends, exports chart history CSV, or safely writes scalar and composite-leaf variables through two-stage confirmation.
- `mcu-chip-info`: reads chip info by the `identity`, `debug`, and `runtime` groups, or by specific fields.
- `mcu-config`: reads or changes ELF, debugger, MCU, SVD, OpenOCD, and sampling parameters.
- `mcu-cubemx`: updates an existing `.ioc` on Windows/Linux and generates code in an isolated copy, comparing changes and preserving user code before writing back; see [CubeMX generation](docs/CUBEMX-GENERATION.md).
- `mcu-fault-analyzer`: reads and decodes Cortex-M fault registers and symbolizes PC/LR with the current ELF.
- `mcu-elf-analyze`: analyzes Flash/RAM usage, per-region capacities and percentages, section layout, and large symbols offline without occupying the debug probe; it prefers the matching `.map` and supports linker scripts.
- `mcu-peripheral-debug`: parses the workspace SVD, reads and decodes paused peripheral registers/fields, and performs safe writes after a fresh one-time confirmation for every request.
- `mcu-debug-control`: starts, stops, and controls debug sessions, including pause/continue/stepping/restart plus source-line and function breakpoints.
- `mcu-debug-control`'s `inspect.js`: reads paused native task stacks, scopes and C++ class/STL objects with paging and stale-handle protection.
- `mcu-rtos`: reads paused FreeRTOS task states, priorities and stack fill estimates, and inspects a selected task's stack and C/C++ locals. Structured snapshots currently require single-core little-endian Cortex-M ARM32.

Sensitive operations require the Agent to present a plan and get confirmation in the conversation. Some operations can remember an explicitly selected permission for up to 24 hours; Flash verification and peripheral writes require confirmation each time. See [Agent trust boundaries](docs/AGENT-TRUST-BOUNDARIES.md).

On Linux, select `STM32CubeMX` (without an extension) in the standalone installation and keep its bundled `jre/bin/java`. Discovery checks CubeMX updater records, PATH, and common installation directories. The installed version must match the `.ioc`; interactive firmware installation requires a graphical desktop. If debug tools are missing, EmberProbe refreshes PATH from the user’s login/interactive shell, with a timeout and manual directory selection as fallback.

## Development & Build

```sh
npm ci
npm run check
npm run quality
npm run bundle
npm run test:e2e
npm run package
```

Normal tests are explicitly grouped in `scripts/test-groups.js`: `npm run test:fast` runs pure logic tests, while `npm run test:integration` runs filesystem, service, and asynchronous integration tests. `npm run test:unit` still runs both groups. The runner uses up to four isolated child processes; use `npm run test:unit -- --jobs 1` for serial debugging and `--keep-logs` to retain passing logs. Summaries are written to `test-results/`. GDB, E2E, HIL, and release consistency tests retain separate entry points.

Run `npm run release:prepare -- <version> --date YYYY-MM-DD` when preparing a new version; the script synchronizes version metadata, the README, and the Changelog. Pushing the matching `vX.Y.Z` tag automatically creates a GitHub Release and uploads the VSIX; see [docs/RELEASING.md](docs/RELEASING.md) for publishing and retry instructions. See [test/hil/README.md](test/hil/README.md) for hardware-runner setup. The current extension version is `0.8.9-beta.1`.

## Project Structure

```text
src/       Extension implementation
resources/ Bundled OpenOCD runtimes and licenses
media/     Marketplace and Activity Bar icons
skills/    Bundled Agent Skills
test/      Unit tests and OpenOCD Tcl-RPC integration tests
esbuild.js Single-file VSIX bundle build config
```

## License & Attribution

The extension code is licensed under MIT. License and source information for the npm runtime dependencies and the bundled xPack OpenOCD is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
