---
name: mcu-config
description: Read or change EmberProbe workspace configuration and synchronize it to the sidebar, including selecting a workspace .ioc. Use for ELF, probe, MCU, SVD and sampling settings, or to inspect CubeMX/OpenOCD paths and route firmware package setup to the extension UI.
---

# MCU Configuration

Use `scripts/config.js` from this skill directory. Never edit VS Code storage or EmberProbe files directly.

## Before you run

- **Applies to**: reading or changing EmberProbe workspace configuration (ELF, debugger, MCU target, SVD, selected `.ioc`, sampling interval, Tcl port, sample history limit), and identifying the supported route for CubeMX and firmware package setup.
- **Requires**: the EmberProbe Agent Bridge. No probe or hardware is needed.
- **Preconditions**: read the current configuration before changing it; change only the fields the user explicitly requested; `openocdPath` and `cubemxPath` are read-only through the Bridge.
- **Side effects**: `--get` is read-only and never mutates configuration, bindings, or hardware; `--set` changes workspace configuration and immediately synchronizes the sidebar.
- **Success evidence**: the normalized configuration returned by EmberProbe. A config read does not verify hardware, and a config write success does not prove a later debug or flash will start.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

1. Read the current configuration before changing it:

   ```bash
   node <skill-dir>/scripts/config.js --workspace <workspace> --get
   ```

2. Change only values explicitly requested by the user:

   ```bash
   node <skill-dir>/scripts/config.js --workspace <workspace> --set debugger=cmsis-dap.cfg,mcu=stm32f4x.cfg
   ```

3. Supported keys are `elf`, `debugger`, `mcu`, `svd`, `iocPath`, `sampleIntervalMs`, `tclPort`, and `maxSamples`. `iocPath` selects an existing workspace `.ioc`; it does not edit its contents. Use `mcu-cubemx` for initialization configuration and code generation. `openocdPath` and `cubemxPath` are read-only through the Agent Bridge; instruct the user to change executable paths in VS Code settings or the EmberProbe sidebar instead.
4. Report the normalized configuration returned by EmberProbe. The extension validates paths, configuration names, numeric ranges, and synchronizes the sidebar immediately.
5. On failure, parse the stderr JSON diagnostic and report its `error.code`, `likelyCause`, and `suggestedActions`. Do not guess a hardware or service cause for configuration-validation errors.

## CubeMX, IOC and firmware packages

Select or clear the project file using `--set "iocPath=path/to/project.ioc"` or `--set "iocPath="`. Selection validates an existing file inside the workspace; it neither edits the IOC nor proves its CubeMX version or firmware package is installed. Quote the whole assignment for paths with spaces. The comma-separated `--set` format cannot represent a path containing a comma.

`--get` returns `cubemxPath` and `iocPath`, but does not return firmware installation status. CubeMX is a global executable setting, not a writable workspace setting through this Skill. Use the sidebar or VS Code user setting `emberprobe.cubemxPath` to change it. Do not bypass `CONFIG_KEY_FORBIDDEN` by editing storage.

There is no writable `firmwarePackage`, `firmwareVersion`, or `repository` configuration key. The sidebar derives the STM32 family from `mcu` and, when an IOC is selected, reads the required version from `ProjectManager.FirmwarePackage`. It checks CubeMX's configured repository after configuration refresh. With no IOC selected it checks installed packages for the MCU family; this does not establish a particular project's required version.

For a missing package, direct the user to the CubeMX firmware package install action in the sidebar, which opens the native interactive installer. The user handles license/download prompts. The Bridge has no package-install command; `mcu-cubemx --inspect` is not an installation check. Changing an IOC's package version is not supported by the current generation workflow. Use `mcu-cubemx` for pin/peripheral changes and authorized code generation after setup.
