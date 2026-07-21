# EmberProbe

EmberProbe is a VS Code extension for Cortex-M development. Built on OpenOCD, it provides firmware flashing, Cortex-Debug debugging, automatic target detection, and live variable watching — with a fully bilingual (English / 简体中文) interface.

## Features

- Automatically detects the newest ELF file in the workspace.
- Infers the MCU target from `.ioc`, CMake, and linker files.
- Auto-recognizes ST-Link, J-Link, CMSIS-DAP, XDS110, Nu-Link and other debug probes.
- Detects the OpenOCD environment in the sidebar and shows its status; Windows x64 supports one-click offline installation, or you can point to an existing OpenOCD executable.
- Chip info readout: non-intrusively reads the chip core, Device ID, Flash size, UID, debug link, and run state via OpenOCD; it can auto-correct the actual chip family from hardware registers even if the wrong target config is selected.
- The OpenOCD terminal shows only parsed key events: a firmware/chip/Flash/write-verify summary on success, and the cause plus troubleshooting hints on failure.
- Aggregates programming, verification, reset, and error events in the sidebar.
- Starts a Cortex-Debug session from the selected ELF, probe, target, and optional SVD.
- Live variable watch: non-intrusively reads Cortex-M RAM while the target runs; the sidebar offers a standalone value list, and the chart panel provides a collapsible, draggable current-value column plus real-time curves.
- **Bilingual UI (English / 简体中文)** with an instant language toggle — see [Language](#language).
- Optionally installs the `mcu-download` and `mcu-live-watch` Agent Skills into the current workspace, for downloading firmware and reading live variables respectively.

## Requirements

- Visual Studio Code 1.85 or later
- [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug) (required for debugging only)
- OpenOCD: installable with one click from the sidebar on Windows x64; on other platforms, install it and select the executable path

## Quick Start

1. Open a workspace that contains your MCU project and open EmberProbe from the Activity Bar.
2. Confirm the environment is ready in the **OpenOCD Environment** status card; if it is missing, choose "Install" or "Select Path".
3. Click "Auto-detect Configuration", or manually select the ELF firmware, debugger, and MCU target; the SVD file is optional.
4. Click "Download" to flash and verify; after installing Cortex-Debug you can click "Debug" to start a debug session.
5. In the "Chip Info" section, click "Read" to view the chip core, family, Device ID, Flash size, UID, debug link, and run state.
6. To watch running variables, add variables from the ELF variable list in the "Live Values" section and start sampling, or open the chart panel.

## Language

EmberProbe ships a fully bilingual interface (English / 简体中文).

- **Toggle button**: use the language button in the **top-right corner of the EmberProbe sidebar** to switch back and forth between English and Chinese. It is a simple toggle (not a dropdown) that shows `EN` when Chinese is active and `中` when English is active.
- **Instant switch**: the sidebar re-renders immediately without reloading. The standalone live-variable chart panel has its own toggle button and stays in sync with the sidebar; your choice is persisted across sessions.
- **Coverage**: sidebar UI, chip info, the OpenOCD environment status card, download progress log, live sampling status, command errors, and VS Code notifications are all translated.
- **Note**: the `EmberProbe OpenOCD` pseudo-terminal log summary and a few low-level runtime error details remain in Chinese; common statuses and failure reasons are bilingual.

## OpenOCD Environment

OpenOCD detection, absence, installation progress, verification results, and errors are all shown in the EmberProbe sidebar — they never interrupt you with corner notifications.

- **Install**: on Windows x64, uses the xPack OpenOCD package bundled with the extension for an offline install into the VS Code global extension storage.
- **Select Path**: pick an already-installed `openocd.exe` (Windows) or `openocd` (macOS/Linux); the extension verifies the version before saving the configuration.
- **Recheck**: re-checks the program that `emberprobe.openocdPath` currently points to.
- **Safe replacement**: when upgrading the bundled OpenOCD, it extracts to a staging directory and verifies first, so a non-runnable new version never breaks the existing install.

OpenOCD is also checked automatically before downloading, debugging, or live watching; when it is missing, EmberProbe opens the sidebar and shows the entry points to fix it. Once the environment is ready, the status card hides itself to stay out of your way.

## Chip Info

The sidebar "Chip Info" section reads basic chip information non-intrusively via OpenOCD in a single pass:

- **Summary card**: core name (e.g., Cortex-M3), chip family (e.g., STM32F1x), adapter clock, core revision, target state, and debug probe.
- **Details** (collapsed by default): Device ID, Revision ID, Flash size, endianness, UID (one-click copy), debugger model, transport, target voltage, and Target name; when the chip is halted it also reads the PC/SP/LR registers.
- **Smart detection**: identifies the chip family from measured hardware values of the SCB CPUID, DBGMCU_IDCODE, Flash-size register, and UID register, so it shows the correct family even when the wrong MCU target config is selected.
- **Non-intrusive**: only performs a brief halt→read→resume when reading identity info, and never halts a running program just to read registers; the probe is released immediately after reading.
- **Mutual exclusion**: mutually exclusive with download, live watch, and debug sessions to avoid probe contention.

## Live Variable Watch

The sidebar lists all global/static variables of the current ELF; click a variable to add it to a standalone value list. Use the command palette entry `EmberProbe: Live Variable Watch` to open the chart panel:

- How it works: runs OpenOCD in service mode and, via Tcl-RPC, **reads RAM non-intrusively while the target runs**; variable addresses come from the symbol table of the selected ELF.
- Usage: first select the ELF, debugger, and MCU target in the sidebar; the sidebar value list and the chart's variable list are independent. The chart panel can import variables from the ELF or add them by name, and lets you resize/collapse the current-value column and choose the watch type (u8/i8/u16/i16/u32/i32/f32).
- Type support: scalars prefer DWARF type info; structs and arrays are clearly marked as composite types in the variable list and cannot be added to sampling (members are not expanded yet); 64-bit scalars are not supported yet either.
- Limits: supports only Cortex-M and global/static variables at fixed addresses; sampling bandwidth is limited (~10–50 Hz), so use SWO trace for high-frequency signals (planned).
- Mutually exclusive with flashing: the probe can only be used by one OpenOCD at a time, so do not run it alongside a download/debug session.
- Related settings: `emberprobe.tclPort`, `emberprobe.sampleIntervalMs`, `emberprobe.maxSamples`.

> This feature is an independent implementation inspired by [MCUViewer](https://github.com/klonyyy/MCUViewer) (GPLv3); it uses none of its code and has no affiliation with that project.

## Development & Build

```powershell
npm install
npm run check
npm run package
```

`npm run package` first bundles the runtime dependencies into `dist/extension.js` via esbuild, then produces `dist/emberprobe.vsix`. The current extension version is `0.3.0`.

## Project Structure

```text
src/       Extension implementation
resources/ Windows x64 OpenOCD bundle and its bundled licenses
media/     Marketplace and Activity Bar icons
skills/    Bundled Agent Skills
test/      Lightweight parser tests
esbuild.js Single-file VSIX bundle build config
```

## License & Attribution

The extension code is licensed under MIT. This project is derived from `yingwudao.mcu-vscode` 0.0.2 — see [NOTICE.md](NOTICE.md); license and source information for the npm runtime dependencies and the bundled xPack OpenOCD is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
