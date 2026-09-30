# EmberProbe

EmberProbe is a VS Code extension for Cortex-M development. Built on OpenOCD, it provides firmware flashing, automatic target detection, and live variable watching.

> [中文文档](README.md)

![Live watch chart panel with sampled waveforms, current values, and the write list](docs/images/live-watch-waveform.png)

## Features

- Automatically detects the newest ELF file and MCU target in the workspace.
- Chip info readout: non-intrusively reads the chip core, Device ID, Flash size, UID, debug link, and run state via OpenOCD.
- ELF flashing: flash the ELF file and run it in one click.
- Live variable watch: non-intrusively reads Cortex-M RAM while the target runs; the sidebar offers a standalone value list, and multiple chart panels can keep independent watch lists and history buffers.
- Live variable write: changes memory in real time while the target runs, offering slider, input box, and mouse wheel for value changes, with automatic read-back after each change.
- Built-in debugging: breakpoints, stepping, stack frames, variables, and memory access without Cortex-Debug; optional RTOS awareness (FreeRTOS and others) lists tasks in the call stack and steps a chosen task.
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
- CSV sources: keep using the full sampling archive, or select live retained samples or the frozen snapshot (the default when frozen). By default, the live buffer retains at least 60 seconds at the target frequency; an explicit `emberprobe.maxSamples` setting takes precedence. Readings do not bridge data gaps; 64-bit integer readouts preserve exact decimal text.

- Sampling isolation: OpenOCD transport and the sampling clock run in a worker thread so extension-host stalls from builds or synchronous ELF parsing do not stop acquisition. Hz uses acquisition timestamps. Target resets, debugger pauses, probe contention and resource exhaustion can still affect reads.

## C++ Objects While Paused

The built-in JavaScript STL display reads ordinary GDB types, fields and memory for VS Code variables, watches and hovers. No Python, additional toolchain or firmware changes are required. An explicitly selected GDB is retained. Automatic script loading and inferior function calls are disabled for the session.

- `emberprobe.enablePrettyPrinting` defaults to `true`; launch/attach overrides the setting, including explicit `false` for raw fields.
- `prettyPrinterPath` is deprecated and ignored, with a migration diagnosis for existing nonempty settings.
- Pages default to 100 elements plus `More…`; explicit `count` is limited to 1000. Each request reads at most 64 KiB and traverses 4096 linked nodes. Load preceding map pages sequentially when a distant jump exceeds the traversal budget.
- Maps expose `[index] → key/value`. Keys, container summaries and synthetic nodes are read-only. Values require GDB editability checks. Execution changes invalidate handles; container element assignments invalidate affected child handles.

The target matrix is GCC 14/15, libstdc++, C++17/20 and DWARF 4/5 on little-endian ARM32 and 64-bit hosts. Supported types are short/long/embedded-NUL `string`, `vector`, `array`, `pair/tuple`, `map/unordered_map`, `unique_ptr/shared_ptr`, and `optional/variant`, including empty and nested objects. `vector<bool>` bit elements are read-only. String summaries read up to 256 bytes; characters are paged. Unknown layouts, the old string ABI, libc++, `_GLIBCXX_DEBUG` and fancy pointers fall back to raw fields with a diagnosis. Live STL sampling, virtual bases and arbitrary pointer chains are outside this iteration.

Local GCC 14.2/libstdc++ and GDB 16.2 pass native regressions without Python printers. ARM32 protocol fixtures validate fields and addresses. H750_RTOS_CPP_Test with the STM32 GCC 14.3.1 ordinary GDB passes real DAP summaries and expansion for `string/vector<float>/unique_ptr<Sensor>`, including FreeRTOS mode with eight tasks; the user project was not modified. Repository fixtures cover other types and large pages; the board run does not establish the entire type matrix on ARM hardware. Linux CI defines GCC 14/15 × C++17/20 × DWARF 4/5; that Linux matrix has not been run locally. Set `CPP_GDB`, `CPP_CXX`, optional `CPP_STANDARD=17/20` and `CPP_DWARF=4/5`, then run `node test/gdb/cpp-paused.test.js`. Normal tests require no compiler or hardware. See [test/hil/README.md](test/hil/README.md) for the read-only board acceptance runner and prerequisites.

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

Run `npm run release:prepare -- <version> --date YYYY-MM-DD` when preparing a new version; the script synchronizes version metadata, the README, and the Changelog. Pushing the matching `vX.Y.Z` tag automatically creates a GitHub Release and uploads the VSIX; see [docs/RELEASING.md](docs/RELEASING.md) for publishing and retry instructions. See [test/hil/README.md](test/hil/README.md) for hardware-runner setup. The current extension version is `0.7.14`.

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
