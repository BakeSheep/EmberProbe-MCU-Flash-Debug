---
name: mcu-config
description: Read or change EmberProbe workspace configuration and immediately synchronize it to the sidebar. Use when the user asks an agent to select or change the ELF, debugger probe, MCU target, SVD, OpenOCD path, sampling interval, Tcl port, or sample history limit.
---

# MCU Configuration

Use `scripts/config.js` from this skill directory. Never edit VS Code storage or EmberProbe files directly.

## Before you run

- **Applies to**: reading or changing EmberProbe workspace configuration (ELF, debugger, MCU target, SVD, sampling interval, Tcl port, sample history limit).
- **Requires**: the EmberProbe Agent Bridge. No probe or hardware is needed.
- **Preconditions**: read the current configuration before changing it; change only the fields the user explicitly requested; `openocdPath` is read-only through the Bridge.
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

3. Supported keys are `elf`, `debugger`, `mcu`, `svd`, `sampleIntervalMs`, `tclPort`, and `maxSamples`. `openocdPath` is read-only through the Agent Bridge (changing it can point probe calls at an arbitrary executable); instruct the user to change it in VS Code settings or the EmberProbe sidebar instead.
4. Report the normalized configuration returned by EmberProbe. The extension validates paths, configuration names, numeric ranges, and synchronizes the sidebar immediately.
5. On failure, parse the stderr JSON diagnostic and report its `error.code`, `likelyCause`, and `suggestedActions`. Do not guess a hardware or service cause for configuration-validation errors.
