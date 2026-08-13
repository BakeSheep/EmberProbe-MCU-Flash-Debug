# EmberProbe

EmberProbe is a VS Code extension for Cortex-M development. Built on OpenOCD, it provides firmware flashing, automatic target detection, and live variable watching.

> [中文文档](README.md)

## Features

- Automatically detects the newest ELF file in the workspace.
- Infers the MCU target from `.ioc`, CMake, and linker files.
- Detects the OpenOCD environment in the sidebar and shows its status; Windows x64 supports one-click offline installation, or you can point to an existing OpenOCD executable.
- Chip info readout: non-intrusively reads the chip core, Device ID, Flash size, UID, debug link, and run state via OpenOCD.
- Starts a Cortex-Debug session from the selected ELF, probe, target, and optional SVD.
- Live variable watch: non-intrusively reads Cortex-M RAM while the target runs; the sidebar offers a standalone value list, and the chart panel provides a collapsible, draggable current-value column plus real-time curves.
- Optionally installs eight Agent Skills covering firmware download and verification, live variable reads and writes, chip and fault inspection, ELF analysis, and configuration synchronization.

## Requirements

- Visual Studio Code 1.85 or later
- OpenOCD

## Live Variable Watch

The sidebar lists all global/static variables of the current ELF; click a variable to add it to a standalone value list.

- Type support: scalars prefer DWARF type info; structs, unions, and arrays can be expanded to select scalar leaves, and the chart can also import by array element or range; 64-bit scalars are not supported yet.
- Live writes: the sidebar can add scalars with reliable DWARF types in ELF writable sections to a write list; writes are enabled only while sampling is active and are verified by reading the value back after each write.
- Limits: supports only Cortex-M and global/static variables at fixed addresses; sampling bandwidth is limited (~10–50 Hz).
- Related settings: `emberprobe.tclPort`, `emberprobe.sampleIntervalMs`, `emberprobe.maxSamples`.

## Agent Skills

- `mcu-download`: detects and downloads the newest ELF, reporting an ELF SHA-256 fingerprint during preflight and execution.
- `mcu-live-watch`: reads once or analyzes trends. The startup, progress, and shutdown of temporary trend sampling are synchronized to the sidebar and chart. Workspaces with this Skill installed auto-activate the Agent Bridge. It can also add variables to the sidebar, chart, or both.
- `mcu-chip-info`: reads chip info by the `identity`, `debug`, and `runtime` groups, or by specific fields.
- `mcu-config`: reads or changes ELF, debugger, MCU, SVD, OpenOCD, and sampling parameters.
- `mcu-var-write`: safely writes scalars or composite leaves by name with two-stage confirmation, ELF fingerprint binding, and read-back verification.
- `mcu-fault-analyzer`: reads and decodes Cortex-M fault registers and symbolizes PC/LR with the current ELF.
- `mcu-elf-analyze`: analyzes Flash/RAM usage, section layout, and large symbols offline without occupying the debug probe.
- `mcu-flash-verify`: reads target Flash and compares it with the loadable contents of the current ELF.

The extension handles configuration and UI synchronization through a loopback-only Agent Bridge while continuing to manage probe mutual exclusion. Every ELF read recomputes the content fingerprint and resolves symbols; sampling aborts when the ELF changes during a session to avoid reusing stale variable addresses.

## Development & Build

```powershell
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

Run `npm run release:prepare -- <version> --date YYYY-MM-DD` when preparing a new version; the script synchronizes version metadata, the README, and the Changelog. Pushing the matching `vX.Y.Z` tag automatically creates a GitHub Release and uploads the VSIX; see [docs/RELEASING.md](docs/RELEASING.md) for publishing and retry instructions. See [test/hil/README.md](test/hil/README.md) for hardware-runner setup.

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
