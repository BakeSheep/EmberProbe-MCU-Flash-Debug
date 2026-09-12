# EmberProbe

EmberProbe is a VS Code extension for Cortex-M development. Built on OpenOCD, it provides firmware flashing, automatic target detection, and live variable watching.

> [中文文档](README.md)

## Features

- Automatically detects the newest ELF file and MCU target in the workspace.
- Chip info readout: non-intrusively reads the chip core, Device ID, Flash size, UID, debug link, and run state via OpenOCD.
- ELF flashing: flash the ELF file and run it in one click.
- Live variable watch: non-intrusively reads Cortex-M RAM while the target runs; the sidebar offers a standalone value list, and multiple chart panels can keep independent watch lists and history buffers.
- Live variable write: changes memory in real time while the target runs, offering slider, input box, and mouse wheel for value changes, with automatic read-back after each change.
- Cortex-Debug integration: starts breakpoint debugging.
- Optionally installs nine Agent Skills covering firmware programming and verification, live variable reads and writes, SVD peripheral debugging, Cortex-Debug session/breakpoint control, chip and fault inspection, ELF analysis, and configuration synchronization.

## Requirements

- Visual Studio Code 1.85 or later
- OpenOCD
- Cortex-Debug plugin (optional)

## Live Variable Watch

The sidebar lists all global/static variables of the current ELF; click a variable to add it to a standalone value list.

- Type support: scalars prefer DWARF type info and support `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`; structs, unions, and arrays can be expanded to select scalar leaves.
- 64-bit precision: `u64/i64` charts use approximate Number values outside ±2^53; the sidebar, CSV, and Agent results prefer the exact decimal `valueText`.
- CSV export: sampling automatically writes the complete history to a temporary archive, with no separate recording step. Export selected variables and time ranges at any time; internal data is deleted when the extension exits.
- Live writes: the sidebar can add scalars with reliable DWARF types in ELF writable sections to a write list; writes are enabled only while sampling is active and are verified by reading the value back after each write.
- Limits: supports only Cortex-M and global/static variables at fixed addresses; sampling bandwidth is limited (~10–50 Hz). Multiple panels share sampling start/stop and interval state; memory use grows linearly with panel count, with `maxSamples` applied per panel.
- Related settings: `emberprobe.tclPort`, `emberprobe.sampleIntervalMs`, `emberprobe.maxSamples`, `emberprobe.samplingArchiveMaxMiB`.


## Agent Skills

The sidebar switch installs EmberProbe Skills in the current workspace. Turning it off removes those skills and their shared runtime while preserving user-created skills. Global installation is no longer offered. The `.ioc` picker lists matching files in the current workspace.

- `mcu-flash`: detects and programs the newest ELF or independently verifies on-chip Flash, reporting the ELF SHA-256 during preflight and execution.
- `mcu-variables`: reads live values, analyzes trends, exports chart history CSV, or safely writes scalar and composite-leaf variables through two-stage confirmation.
- `mcu-chip-info`: reads chip info by the `identity`, `debug`, and `runtime` groups, or by specific fields.
- `mcu-config`: reads or changes ELF, debugger, MCU, SVD, OpenOCD, and sampling parameters.
- `mcu-cubemx`: updates an existing `.ioc` on Windows and regenerates initialization code through CubeMX CLI after two-stage authorization, with baseline checks, user-code preservation, and recovery copies. It supports asynchronous generation (`--start`, then `--status`, cancel via `--cancel --operation-id`), workspace JSON change files (`--changes-file`) with explicit key deletions (`--deletions`), and consistency checks (`--check` quick mode, `--check --deep` isolated regeneration).

CubeMX and `.ioc` paths appear under MCU Configuration → Other Configuration. Startup detects CubeMX and saves its path as a machine-wide user setting. The `.ioc` selection starts empty and is filled only by clicking Auto-detect Configuration or selecting a file manually. Use the standalone CubeMX version recorded in `.ioc`, its bundled Java, and installed firmware packages. Generation supports the project root and toolchain subdirectories, and rejects external paths, links, and generation hooks. Authorization can be granted once or for the current project for 24 hours; revoke it with the Skill's `--reset-permission`. Keep initialization settings in `.ioc` and application logic in separate sources or `USER CODE` regions. Validate with the project's existing build command after generation. Recovery copies remain in `.emberprobe-cubemx-*` directories; remove them after reviewing the result and keep them out of version control. Operation records live in the extension global storage and expose `unchanged / committed / rolledBack / recoveryRequired / unknown` states across extension restarts; logs of failed deep checks are kept in the storage directory. The quick check only compares the last committed manifest against current files and does not require a working CubeMX; quick check proves changes relative to the recorded manifest, deep check proves regenerability under the current tools, and neither proves build or hardware behavior. Unresolved requests retain their IDs without expiry; the CLI queries their status before retrying. Completed requests start a new operation on the next invocation, and candidate identity includes its content hash. Older ownership manifests yield an unknown quick-check result until a confirmed generation creates a new manifest.

Once a STM32 target and CubeMX are configured, the sidebar checks the matching firmware family in CubeMX’s repository, including a custom repository. A selected `.ioc` makes the check version-specific. For missing packages, Install in CubeMX starts the native interactive flow for sign-in, license acceptance, and installation. With only a target, select a version first; choices come from CubeMX’s local catalog and are not a project compatibility guarantee. Returning to VS Code refreshes the check. SVD, CubeMX, and `.ioc` are all labeled optional.
- `mcu-fault-analyzer`: reads and decodes Cortex-M fault registers and symbolizes PC/LR with the current ELF.
- `mcu-elf-analyze`: analyzes Flash/RAM usage, section layout, and large symbols offline without occupying the debug probe.
- `mcu-peripheral-debug`: parses the workspace SVD, reads and decodes paused peripheral registers/fields, and performs safe writes after a fresh one-time confirmation for every request.
- `mcu-debug-control`: starts, stops, and controls Cortex-Debug sessions, including pause/continue/stepping/restart plus source-line and function breakpoints.

## Development & Build

```powershell
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

Run `npm run release:prepare -- <version> --date YYYY-MM-DD` when preparing a new version; the script synchronizes version metadata, the README, and the Changelog. Pushing the matching `vX.Y.Z` tag automatically creates a GitHub Release and uploads the VSIX; see [docs/RELEASING.md](docs/RELEASING.md) for publishing and retry instructions. See [test/hil/README.md](test/hil/README.md) for hardware-runner setup. The current extension version is `0.7.5`.

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

### Real CubeMX integration check

On Windows, explicitly run `node scripts/check-cubemx-integration.js <project.ioc> <STM32CubeMX.exe>` with the matching installed tool and firmware package. It checks root and nested generation layouts in retained temporary copies without building, flashing, or modifying the source project. Differences produce a nonzero exit code; output includes the artifact directory. Normal tests do not run this check.
